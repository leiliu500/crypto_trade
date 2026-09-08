import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { RecordedEvent } from "../src/backtest/replay.js";
import { DistributionController } from "../src/distribution/controller.js";
import { buildDistributionTraining, distributionTrainingOnlyState, prepareDistributionTraining } from "../src/distribution/training-backfill.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS } from "../src/distribution/spec.js";

const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const assets = Object.fromEntries(Object.keys(costs).map(symbol => [symbol, {
  symbol, minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .01, maximumOrderQty: 1, shortable: true,
}]));
function book(atMs: number, symbol = "BTC/USD"): RecordedEvent {
  return { kind: "BOOK", delta: { symbol, sourceId: `${symbol}:${atMs}`, reset: true,
    exchangeTsMs: atMs, receiveTsMs: atMs,
    bids: [{ px: 100, qty: 1 }], asks: [{ px: 100.01, qty: 1 }] } };
}
function initialState() {
  const state = new DistributionController(costs, { ...assets }).exportState();
  state.samples = DISTRIBUTION_ACTIONS.map(action => ({ id: `BTC/USD:${action.id}:0`, symbol: "BTC/USD",
    actionId: action.id, signalAtMs: 0, completedAtMs: 1000, features: Array(12).fill(0) as number[],
    outcomes: DISTRIBUTION_SCENARIOS.map(s => ({ scenario: s.id, status: "UNFILLED", netBps: 0,
      grossBps: 0, filledFraction: 0, entryAtMs: null, exitAtMs: 1000, reason: "IOC_UNFILLED" })) }));
  return state;
}

test("historical raw paths train matched complete actions before deployment without granting prospective validation", async () => {
  function* events() {
    for (let now = 0; now <= 3_603_000; now += 1000) {
      yield book(now); yield book(now, "ETH/USD");
    }
  }
  const built = await buildDistributionTraining(events(), costs, assets, { cutoffMs: 3_603_000 });
  assert.equal(built.report.rawCompletePanels, 2);
  assert.equal(built.state.samples.length, 12);
  assert.deepEqual(built.report.retainedDays, ["1970-01-01"]);
  assert.ok(built.state.samples.every(s => s.outcomes.length === 3 && s.outcomes.every(o => o.status === "FILLED" && o.netBps! < 0)));
  assert.equal(built.report.brokerOrdersSubmitted, 0);
  assert.equal(built.report.profitabilityEstablished, false);
  assert.equal(built.report.validation.ready, false);
  assert.deepEqual(built.state.validationSelections, []);
  assert.deepEqual(built.state.pendingSelections, []);
  assert.deepEqual(built.state.nextProposals, {});
  assert.equal(built.state.selectedSlotUntilMs, null);
  assert.equal(new DistributionController(costs, { ...assets }).restoreState(built.state, 3_603_000), 12);
});

test("training extraction removes historical selection claims and retains only independently checked complete labels", async () => {
  const input = { ...initialState(), validationSelections: [{ claimedReady: true }],
    pendingSelections: [{ symbol: "BTC/USD", actionId: "long-5m", atMs: 999_999 }], selectedSlotUntilMs: 999_999 };
  const copy = distributionTrainingOnlyState(input);
  assert.deepEqual(copy.validationSelections, []);
  assert.equal(copy.samples.length, 6);
  const built = await buildDistributionTraining([book(2000), book(2000, "ETH/USD")], costs, assets,
    { cutoffMs: 10_000, initialState: input });
  assert.equal(built.report.restoredSamples, 6);
  assert.equal(built.report.validation.selections, 0);
  assert.equal(input.validationSelections.length, 1, "source state must not be mutated");
  const partial = initialState(); partial.samples.pop();
  await assert.rejects(buildDistributionTraining([book(2000)], costs, assets,
    { cutoffMs: 10_000, initialState: partial }), /CHECKPOINT_PANEL/);
});

test("resume rejects labels later than any admitted public event, including a buffered second stream", async () => {
  await assert.rejects(buildDistributionTraining([book(2000), book(500, "ETH/USD")], costs, assets,
    { cutoffMs: 10_000, initialState: initialState() }), /OVERLAPS_REPLAY_HISTORY/);
  await assert.rejects(buildDistributionTraining([book(2000)], { ...costs, "BTC/USD": { feeBps: 6, reserveBps: 3 } }, assets,
    { cutoffMs: 10_000, initialState: initialState() }), /CHECKPOINT/);
});

test("cutoff excludes future data while private disconnections cannot fabricate public outages", async () => {
  const built = await buildDistributionTraining([book(2000), book(2000, "ETH/USD"), book(5000),
    { kind: "DISCONNECT", stream: "private", receiveTsMs: 2500 }, book(3000)], costs, assets, { cutoffMs: 3000 });
  assert.equal(built.report.futureEventsExcluded, 1);
  assert.equal(built.report.ignoredPrivateEvents, 1);
  assert.equal(built.report.quality.disconnects, 0);
  assert.equal(built.report.quality.lastMs, 3000);
  assert.equal(built.state.samples.length, 0);
  await assert.rejects(buildDistributionTraining([], costs, assets, { cutoffMs: 3000 }), /PUBLIC_HISTORY_REQUIRED/);
  await assert.rejects(buildDistributionTraining([book(1000)], costs, assets, { cutoffMs: NaN }), /INVALID_TRAINING_CUTOFF/);
  await assert.rejects(buildDistributionTraining([book(1000)], costs, { ...assets, "ETH/USD": { ...assets["ETH/USD"]!, priceIncrement: 0 } },
    { cutoffMs: 3000 }), /INVALID_TRAINING_INSTRUMENT/);
});

test("file preparation writes a checkpoint-compatible immutable artifact with hashes of actual compressed inputs", async t => {
  const directory = await mkdtemp(join(tmpdir(), "distribution-train-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "raw.jsonl.gz"), output = join(directory, "new-state.json");
  const bytes = gzipSync(`${JSON.stringify(book(2000))}\n${JSON.stringify(book(2000, "ETH/USD"))}\n`);
  await writeFile(source, bytes);
  const prepared = await prepareDistributionTraining([source], output, costs, assets, { cutoffMs: 3000 });
  const written = JSON.parse(await readFile(output, "utf8"));
  assert.equal(written.trainingBackfill.inputFiles[0].sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(prepared.report.stateSha256, createHash("sha256").update(await readFile(output)).digest("hex"));
  assert.equal(new DistributionController(costs, { ...assets }).restoreState(written, 3000), 0);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(prepareDistributionTraining([source], output, costs, assets, { cutoffMs: 3000 }), /OUTPUT_EXISTS/);
  await assert.rejects(prepareDistributionTraining([source], source, costs, assets, { cutoffMs: 3000 }), /COLLISION/);
  assert.equal((await readFile(source)).equals(bytes), true);
});

test("truncated gzip and malformed JSON cannot publish partial training or leave temporary outputs", async t => {
  const directory = await mkdtemp(join(tmpdir(), "distribution-train-bad-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const compressed = gzipSync(`${JSON.stringify(book(2000))}\n`);
  for (const [name, bytes] of [["truncated.gz", compressed.subarray(0, compressed.length - 8)],
    ["invalid.jsonl", Buffer.from(`${JSON.stringify(book(2000))}\n{invalid}\n`)]] as const) {
    const source = join(directory, name), output = join(directory, `${name}.state`);
    await writeFile(source, bytes);
    await assert.rejects(prepareDistributionTraining([source], output, costs, assets, { cutoffMs: 3000 }));
    await assert.rejects(stat(output), { code: "ENOENT" });
  }
  assert.ok((await readdir(directory)).every(name => !name.endsWith(".tmp")));
});

test("recordings mutated during preparation fail before artifact publication", async t => {
  const directory = await mkdtemp(join(tmpdir(), "distribution-train-change-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "raw.jsonl"), output = join(directory, "state.json");
  await writeFile(source, `${JSON.stringify(book(2000))}\n`);
  await assert.rejects(prepareDistributionTraining([source], output, costs, assets, {
    cutoffMs: 3000, onProgress: () => { writeFileSync(source, "changed"); },
  }), /INPUT_CHANGED/);
  await assert.rejects(stat(output), { code: "ENOENT" });
});
