import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { BookState } from "../src/core/market.js";
import type { TradingEngine } from "../src/engine/trading-engine.js";
import type { AssetRules } from "../src/execution/planner.js";
import { DistributionCheckpoint } from "../src/distribution/checkpoint.js";
import { DistributionController } from "../src/distribution/controller.js";
import { DistributionMarket } from "../src/distribution/market.js";
import { ConditionalDistributionModel } from "../src/distribution/model.js";
import { DISTRIBUTION_SPEC, type DistributionEstimate } from "../src/distribution/spec.js";

const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const assets: Record<string, AssetRules> = Object.fromEntries(Object.keys(costs).map(symbol => [symbol,
  { symbol, minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .01, maximumOrderQty: 1, shortable: true }]));
const book = (atMs: number, bid = 100, ask = 100.01): BookState => ({ symbol: "BTC/USD", bids: [{ px: bid, qty: 1 }],
  asks: [{ px: ask, qty: 1 }], exchangeTsMs: atMs, receiveTsMs: atMs, sequence: BigInt(atMs + 1), valid: true, sourceReset: true });

function fixture(t: TestContext) {
  t.mock.method(DistributionMarket.prototype, "onBook", (b: BookState) => ({ symbol: b.symbol, atMs: b.receiveTsMs,
    ready: true, reason: "READY", features: Array(12).fill(0) as number[] }));
  t.mock.method(ConditionalDistributionModel.prototype, "estimate", (_symbol: string, actionId: string): DistributionEstimate => ({
    actionId, samples: 60, effectiveSamples: 55, observedDays: 8, meanNetBps: 25,
    lowerMeanNetBps: actionId === "long-5m" ? 20 : 15, scoreBps: actionId === "long-5m" ? 20 : 15,
    tailLossBps: 0, fillProbability: 1, eligible: true, reason: "POSITIVE_DISTRIBUTIONAL_SCORE",
  }));
  const directory = mkdtempSync(join(tmpdir(), "distribution-checkpoint-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json"), controller = new DistributionController(costs, { ...assets });
  const first = controller.onBook(book(0)).decision!;
  controller.onBook(book(1000));
  for (const atMs of [1250, 1500, 2000]) controller.onBook(book(atMs, 110, 110.01));
  assert.equal(controller.stats(2000).learning.acceptedSamples, 6);
  assert.equal(controller.stats(2000).validation.selections, 1);
  return { path, controller, first };
}
function engine(controller: DistributionController, cutoffMs = 2_000_000): TradingEngine {
  return { exportDistributionalState: () => controller.exportState(),
    restoreDistributionalState: (state: unknown) => controller.restoreState(state, cutoffMs),
    invalidateDistributionalValidation: () => controller.invalidateValidation(),
  } as unknown as TradingEngine;
}

test("preparing live state and restoring an in-flight selected panel preserve labels but clear policy validation", t => {
  const { controller } = fixture(t);
  const pending = controller.onBook(book(DISTRIBUTION_SPEC.proposalIntervalMs)).decision!;
  assert.ok(pending.actionId);
  const state = controller.exportState(); assert.equal(state.pendingSelections.length, 1);
  const restored = new DistributionController(costs, { ...assets });
  assert.equal(restored.restoreState(state, 2_000_000), 6);
  assert.equal(restored.stats(2_000_000).validation.selections, 0);
  assert.equal(restored.stats(2_000_000).pendingPanels, 0);
  assert.equal(restored.currentDecision("BTC/USD"), null);
  controller.prepareForLive();
  assert.equal(controller.stats(2_000_000).learning.acceptedSamples, 6);
  assert.equal(controller.stats(2_000_000).validation.selections, 0);
  assert.equal(controller.exportState().pendingSelections.length, 0);
});

test("a synchronous pending journal prevents an old complete checkpoint from hiding a selected crash path", async t => {
  const { path, controller } = fixture(t), errors: unknown[] = [];
  const checkpoint = new DistributionCheckpoint(path, engine(controller), error => errors.push(error));
  checkpoint.save(); await checkpoint.flush();
  const pending = controller.onBook(book(DISTRIBUTION_SPEC.proposalIntervalMs)).decision!;
  checkpoint.markPending(pending);
  assert.ok(existsSync(`${path}.pending`), "the journal exists before any asynchronous full checkpoint save");
  assert.equal(JSON.parse(readFileSync(`${path}.pending`, "utf8")).atMs, pending.atMs);
  const restored = new DistributionController(costs, { ...assets });
  assert.equal(await new DistributionCheckpoint(path, engine(restored), error => errors.push(error)).restore(), 6);
  assert.equal(restored.stats(2_000_000).validation.selections, 0);
  assert.equal(restored.stats(2_000_000).learning.acceptedSamples, 6);
  assert.deepEqual(errors, []);
});

test("a pending marker linked to the completed selected panel preserves validation on restart", async t => {
  const { path, controller, first } = fixture(t), errors: unknown[] = [];
  const checkpoint = new DistributionCheckpoint(path, engine(controller), error => errors.push(error));
  checkpoint.markPending(first); checkpoint.save(); await checkpoint.flush();
  const restored = new DistributionController(costs, { ...assets });
  assert.equal(await new DistributionCheckpoint(path, engine(restored), error => errors.push(error)).restore(), 6);
  assert.equal(restored.stats(2_000_000).validation.selections, 1);
  assert.deepEqual(errors, []);
});

test("an unresolved journal clears validation even if the asynchronous state file never appeared", async t => {
  const { path, controller } = fixture(t), checkpoint = new DistributionCheckpoint(path, engine(controller), () => {});
  const pending = controller.onBook(book(DISTRIBUTION_SPEC.proposalIntervalMs)).decision!;
  checkpoint.markPending(pending); assert.equal(existsSync(path), false);
  assert.equal(await checkpoint.restore(), 0);
  assert.equal(controller.stats(2_000_000).validation.selections, 0);
});

test("malformed or future checkpoint labels cannot partially replace an already learned model", async t => {
  const { path, controller } = fixture(t), before = controller.exportState();
  const future = structuredClone(before); future.samples[0]!.completedAtMs = 3_000_000;
  writeFileSync(path, JSON.stringify(future));
  const checkpoint = new DistributionCheckpoint(path, engine(controller), () => {});
  await assert.rejects(checkpoint.restore(), /CHECKPOINT/);
  assert.deepEqual(controller.exportState(), before);
  writeFileSync(path, "{malformed"); await assert.rejects(checkpoint.restore());
  assert.deepEqual(controller.exportState(), before);
});

test("malformed pending journals are rejected before valid disk state can replace the current model", async t => {
  const { path, controller } = fixture(t), before = controller.exportState();
  writeFileSync(path, JSON.stringify(new DistributionController(costs).exportState()));
  const checkpoint = new DistributionCheckpoint(path, engine(controller), () => {});
  for (const malformed of ["{bad", "null", "false", "0", JSON.stringify({ symbol: "BTC/USD", actionId: "long-5m", atMs: -.5 })]) {
    writeFileSync(`${path}.pending`, malformed); await assert.rejects(checkpoint.restore());
    assert.deepEqual(controller.exportState(), before, "journal validation precedes all model installation");
  }
});

test("slow checkpoint writes coalesce intermediate snapshots and flush the newest state", async t => {
  const directory = mkdtempSync(join(tmpdir(), "distribution-checkpoint-queue-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let revision = 0, release!: () => void;
  const firstWrite = new Promise<void>(resolve => { release = resolve; });
  const writes: number[] = [], errors: unknown[] = [];
  const fakeEngine = { exportDistributionalState: () => ({ revision }) } as unknown as TradingEngine;
  const checkpoint = new DistributionCheckpoint(join(directory, "state.json"), fakeEngine, error => errors.push(error));
  t.mock.method(checkpoint as unknown as { writeState(state: { revision: number }): Promise<void> }, "writeState", async (state: { revision: number }) => {
    writes.push(state.revision);
    if (writes.length === 1) await firstWrite;
  });
  checkpoint.save();
  for (revision = 1; revision <= 100; revision++) checkpoint.save();
  assert.deepEqual(writes, [0], "only one write can run while storage is delayed");
  let flushed = false;
  const flush = checkpoint.flush().then(() => { flushed = true; });
  await Promise.resolve(); assert.equal(flushed, false);
  release(); await flush;
  assert.deepEqual(writes, [0, 100], "all superseded queued snapshots are discarded");
  assert.deepEqual(errors, []);
});

test("a failed checkpoint write reports its error and still persists the latest waiting snapshot", async t => {
  let revision = 0, rejectFirst!: (error: Error) => void;
  const firstWrite = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
  const writes: number[] = [], errors: unknown[] = [];
  const checkpoint = new DistributionCheckpoint("unused.json", { exportDistributionalState: () => ({ revision }) } as unknown as TradingEngine,
    error => errors.push(error));
  t.mock.method(checkpoint as unknown as { writeState(state: { revision: number }): Promise<void> }, "writeState", async (state: { revision: number }) => {
    writes.push(state.revision); if (writes.length === 1) await firstWrite;
  });
  checkpoint.save(); revision = 1; checkpoint.save();
  rejectFirst(new Error("STORAGE_TEMPORARILY_UNAVAILABLE")); await checkpoint.flush();
  assert.deepEqual(writes, [0, 1]); assert.equal(errors.length, 1);
});

test("journal resolves a completed selected outcome even while its training panel remains uncompleted", async t => {
  const { path, controller } = fixture(t);
  // Begin the next selected opportunity while no new 31m training panel is due.
  const decision = controller.onBook(book(3000, 110, 110.01)).decision!;
  assert.equal(decision.actionId, "long-5m");
  controller.onBook(book(3250, 110, 110.01));
  controller.onBook(book(3750, 110, 110.01));
  controller.onBook(book(4000, 120, 120.01));
  controller.onBook(book(4250, 120, 120.01));
  controller.onBook(book(4750, 120, 120.01));
  assert.equal(controller.exportState().samples.some(s => s.id === `BTC/USD:long-5m:3000`), false);
  assert.equal(controller.stats(4750).validation.selections, 2);
  const checkpoint = new DistributionCheckpoint(path, engine(controller), () => {});
  checkpoint.markPending(decision); checkpoint.save(); await checkpoint.flush();
  const restored = new DistributionController(costs, { ...assets });
  await new DistributionCheckpoint(path, engine(restored), () => {}).restore();
  assert.equal(restored.stats(4750).validation.selections, 2);
});

test("an older policy journal cannot authorize new cadence validation", async t => {
  const { path, controller, first } = fixture(t);
  const checkpoint = new DistributionCheckpoint(path, engine(controller), () => {});
  checkpoint.save(); await checkpoint.flush();
  writeFileSync(`${path}.pending`, JSON.stringify({ symbol: first.symbol, actionId: first.actionId, atMs: first.atMs }));
  const restored = new DistributionController(costs, { ...assets });
  await new DistributionCheckpoint(path, engine(restored), () => {}).restore();
  assert.equal(restored.stats(2000).validation.selections, 0);
});
