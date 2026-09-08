import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import type { RecordedEvent } from "../src/backtest/replay.js";
import { DistributionController } from "../src/distribution/controller.js";
import { DISTRIBUTION_SPEC, DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS,
  type DistributionSample } from "../src/distribution/spec.js";
import { freezeStudy, parseStudyArgs, readStudyManifest, replayStudy, runLiveStudy,
  type StudyManifest, type StudyRunner } from "../src/distribution/study-main.js";

const DAY = 86_400_000, startMs = Date.parse("2026-09-09T00:00:00Z"), nowMs = startMs - 3_600_000;
const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const assets = Object.fromEntries(Object.keys(costs).map(symbol => [symbol, { symbol,
  minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .1, maximumOrderQty: 100, shortable: true }]));
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const eventAt = (atMs: number): RecordedEvent => ({ kind: "BOOK", delta: { symbol: "BTC/USD", sourceId: `book-${atMs}`,
  reset: true, bids: [{ px: 100, qty: 1 }], asks: [{ px: 101, qty: 1 }], exchangeTsMs: atMs, receiveTsMs: atMs } });

function validArtifact(samples: DistributionSample[] = []) {
  const state = new DistributionController(costs, structuredClone(assets)).exportState();
  return { ...state, samples, trainingBackfill: { version: `${DISTRIBUTION_SPEC.version}:training-backfill-v1`,
    cutoffMs: nowMs - 1, trainingOnly: true, prospectiveSelectionsCreated: 0, brokerOrdersSubmitted: 0,
    profitabilityEstablished: false, deploymentReady: false, spec: DISTRIBUTION_SPEC, costs, assets,
    instrumentRulesSha256: sha(JSON.stringify(assets)), inputFiles: [{ path: "historical.jsonl.gz", bytes: 1, sha256: sha("fixture") }],
    quality: { firstMs: 1, lastMs: nowMs - 1 }, retainedSamples: samples.length,
    retainedPanels: samples.length / DISTRIBUTION_ACTIONS.length } };
}
function sample(signalAtMs: number): DistributionSample {
  return { id: `BTC/USD:long-5m:${signalAtMs}`, symbol: "BTC/USD", actionId: "long-5m", signalAtMs,
    completedAtMs: signalAtMs + 1_000, features: Array(12).fill(0), outcomes: DISTRIBUTION_SCENARIOS.map(scenario => ({
      scenario: scenario.id, status: "UNFILLED", netBps: 0, grossBps: 0, filledFraction: 0,
      entryAtMs: null, exitAtMs: signalAtMs + 1_000, reason: "IOC_UNFILLED" })) };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "distribution-study-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = join(directory, "source");
  await mkdir(join(sourceRoot, "src"), { recursive: true });
  await writeFile(join(sourceRoot, "src", "fixture.ts"), "export const unchanged = true;\n");
  await writeFile(join(sourceRoot, "package.json"), "{}\n");
  await writeFile(join(sourceRoot, "package-lock.json"), "{}\n");
  const seed = join(directory, "input-seed.json"); await writeFile(seed, JSON.stringify(validArtifact()));
  return { directory, sourceRoot, seed,
    options: { command: "freeze" as const, out: join(directory, "sealed"), seed, startMs, endMs: startMs + 14 * DAY },
    dependencies: { nowMs, sourceRoot } };
}
const mockRunner = (): StudyRunner & { events: RecordedEvent[]; finished: Array<{ atMs: number; reason: string }> } => {
  const events: RecordedEvent[] = [], finished: Array<{ atMs: number; reason: string }> = [], audit: unknown[] = [];
  return { events, finished,
    onEvent(event) { events.push(event); audit.push({ kind: "OBSERVED", event }); },
    finish(atMs, reason) { finished.push({ atMs, reason }); audit.push({ kind: "FINISH", atMs, reason }); },
    report() { return { events: events.length, finished: [...finished] }; },
    drainAudit() { return audit.splice(0); } };
};

test("study CLI parses distinct future sealing, development preparation, replay inputs and rejects ambiguous flags", () => {
  const args = ["freeze", "--out", "new-dir", "--seed=seed.json", "--start=2026-09-09T00:00:00Z", "--end=2026-09-23T00:00:00Z"];
  assert.deepEqual(parseStudyArgs(args), { command: "freeze", out: "new-dir", seed: "seed.json", startMs, endMs: startMs + 14 * DAY });
  assert.deepEqual(parseStudyArgs(["replay", "--protocol=p.json", "--input", "one.gz", "--input=two.gz", "--out=r.json"]),
    { command: "replay", protocol: "p.json", inputs: ["one.gz", "two.gz"], out: "r.json" });
  assert.throws(() => parseStudyArgs([...args, "--out=other"]), /INVALID_STUDY_OPTION/);
  assert.throws(() => parseStudyArgs([...args, "--submit-orders"]), /INVALID_STUDY_OPTION/);
  assert.throws(() => parseStudyArgs(["live", "--protocol=p.json"]), /MISSING_STUDY_OPTIONS/);
  assert.throws(() => parseStudyArgs(args.map(value => value.includes("2026-09-09") ? "--start=2026-02-30T00:00:00Z" : value)), /INVALID_STUDY_TIMESTAMP/);
  assert.throws(() => parseStudyArgs(args.map(value => value.includes("2026-09-09") ? "--start=2026-09-09T00:00:00" : value)), /INVALID_STUDY_TIMESTAMP/);
});

test("prospective sealer requires an unobserved fourteen-day UTC interval and verified historical provenance", async t => {
  const f = await fixture(t);
  await assert.rejects(freezeStudy({ ...f.options, startMs: nowMs }, f.dependencies), /START_MUST_BE_FUTURE/);
  await assert.rejects(freezeStudy({ ...f.options, endMs: startMs + 13 * DAY }, f.dependencies), /FOURTEEN_UTC_DAYS/);
  await assert.rejects(freezeStudy({ ...f.options, startMs: startMs + 1, endMs: startMs + 14 * DAY + 1 }, f.dependencies), /FOURTEEN_UTC_DAYS/);
  await writeFile(f.seed, JSON.stringify({ version: "conditional-study-seed-v1", costs, assets, samples: [] }));
  await assert.rejects(freezeStudy(f.options, f.dependencies), /REQUIRES_VERIFIED_TRAINING_ARTIFACT/);
  await assert.rejects(stat(f.options.out), { code: "ENOENT" });
  const bad = validArtifact(); bad.trainingBackfill.instrumentRulesSha256 = "0".repeat(64);
  await writeFile(f.seed, JSON.stringify(bad));
  await assert.rejects(freezeStudy(f.options, f.dependencies), /INVALID_TRAINING_ARTIFACT_PROVENANCE/);
});

test("sealer copies immutable seed, hashes complete source set and never overwrites existing outputs", async t => {
  const f = await fixture(t), frozen = await freezeStudy(f.options, f.dependencies);
  const loaded = await readStudyManifest(frozen.protocolPath, f.dependencies);
  assert.equal(loaded.protocolSha256, frozen.sha256);
  assert.deepEqual(loaded.samples, []);
  assert.deepEqual(Object.keys(loaded.manifest.sourceHashes), ["package-lock.json", "package.json", "src/fixture.ts"]);
  assert.equal((await stat(frozen.protocolPath)).mode & 0o777, 0o400);
  assert.equal((await stat(join(f.options.out, "seed.json"))).mode & 0o777, 0o400);
  assert.equal(loaded.manifest.reproducibility.rawEventsRetained, false);
  await writeFile(f.seed, "changed original");
  assert.equal((await readStudyManifest(frozen.protocolPath, f.dependencies)).samples.length, 0);
  await assert.rejects(freezeStudy({ ...f.options, seed: join(f.options.out, "seed.json") }, f.dependencies), { code: "EEXIST" });
});

test("source edits or newly added source files invalidate a sealed study", async t => {
  for (const added of [false, true]) {
    const f = await fixture(t), frozen = await freezeStudy(f.options, f.dependencies);
    await writeFile(join(f.sourceRoot, "src", added ? "new.ts" : "fixture.ts"), "export const altered = true;\n");
    await assert.rejects(readStudyManifest(frozen.protocolPath, f.dependencies), /SOURCE_HASH_MISMATCH/);
  }
});

test("development replay hashes consumed compressed inputs, preserves audit and rejects seed leakage and aliases", async t => {
  const f = await fixture(t);
  const older = sample(5_000);
  await writeFile(f.seed, JSON.stringify({ version: "conditional-study-seed-v1", costs, assets, samples: [older] }));
  const frozen = await freezeStudy({ ...f.options, command: "prepare-development", startMs: 10_000, endMs: 20_000 }, f.dependencies);
  const input = join(f.directory, "events.gz"), raw = gzipSync([eventAt(9_000), eventAt(10_000), eventAt(19_000), eventAt(20_001)]
    .map(event => JSON.stringify(event)).join("\n") + "\n");
  await writeFile(input, raw);
  const runner = mockRunner(), out = join(f.directory, "result.json");
  const result = await replayStudy({ command: "replay", protocol: frozen.protocolPath, inputs: [input], out },
    { ...f.dependencies, engineFactory: () => runner });
  assert.equal(result.report.source.inputFiles[0]!.sha256, sha(raw));
  assert.equal(result.report.source.excludedAfterEnd, 1); assert.equal(runner.events.length, 3);
  assert.deepEqual(runner.finished, [{ atMs: 20_000, reason: "REPLAY_END" }]);
  assert.equal(result.report.audit.records, 4); assert.equal(result.report.profitabilityEstablished, false);
  const audit = gunzipSync(await readFile(result.report.audit.file)).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(audit.length, 4); assert.equal(audit.at(-1).hash, result.report.audit.finalHash);
  await assert.rejects(replayStudy({ command: "replay", protocol: frozen.protocolPath, inputs: [input], out }, f.dependencies), /OUTPUT_EXISTS/);
  const alias = join(f.directory, "alias.gz"); await link(input, alias);
  await assert.rejects(replayStudy({ command: "replay", protocol: frozen.protocolPath, inputs: [input, alias], out: out + "2" },
    { ...f.dependencies, engineFactory: mockRunner }), /DUPLICATE_STUDY_INPUT/);
  await writeFile(input, gzipSync(`${JSON.stringify(eventAt(older.completedAtMs))}\n`));
  await assert.rejects(replayStudy({ command: "replay", protocol: frozen.protocolPath, inputs: [input], out: out + "3" },
    { ...f.dependencies, engineFactory: mockRunner }), /SEED_OVERLAPS_SOURCE_EVENTS/);
  await assert.rejects(stat(out + "3"), { code: "ENOENT" });
});

test("prospective replay requires a closed endpoint and excludes archives inspected before sealing", async t => {
  const f = await fixture(t), frozen = await freezeStudy(f.options, f.dependencies);
  const input = join(f.directory, "events.jsonl"); await writeFile(input, `${JSON.stringify(eventAt(nowMs - 1))}\n`);
  const options = { command: "replay" as const, protocol: frozen.protocolPath, inputs: [input], out: join(f.directory, "report.json") };
  await assert.rejects(replayStudy(options, { ...f.dependencies, engineFactory: mockRunner }), /REQUIRES_CLOSED_ENDPOINT/);
  await assert.rejects(replayStudy(options, { ...f.dependencies, nowMs: f.options.endMs + 1, engineFactory: mockRunner }), /SOURCE_PREDATES_SEAL/);
  await assert.rejects(stat(options.out), { code: "ENOENT" });
});

test("truncated compressed replay input cannot publish a result", async t => {
  const f = await fixture(t);
  await writeFile(f.seed, JSON.stringify({ version: "conditional-study-seed-v1", costs, assets, samples: [] }));
  const frozen = await freezeStudy({ ...f.options, command: "prepare-development", startMs: 10_000, endMs: 20_000 }, f.dependencies);
  const raw = gzipSync(`${JSON.stringify(eventAt(10_000))}\n`), input = join(f.directory, "broken.gz"), out = join(f.directory, "report.json");
  await writeFile(input, raw.subarray(0, raw.length - 8));
  await assert.rejects(replayStudy({ command: "replay", protocol: frozen.protocolPath, inputs: [input], out },
    { ...f.dependencies, engineFactory: mockRunner }));
  await assert.rejects(stat(out), { code: "ENOENT" });
});

class FakePublicStream extends EventEmitter {
  public closed = false;
  constructor(private readonly connected: () => void) { super(); }
  connect() { this.connected(); }
  close() { this.closed = true; }
}
test("public study records durable hash-chained gzip audit, finishes at fixed clock endpoint and rejects silent restart", async t => {
  const f = await fixture(t), frozen = await freezeStudy(f.options, f.dependencies), runner = mockRunner();
  let clock = nowMs, captured: unknown;
  const stream = new FakePublicStream(() => {
    stream.emit("book", (eventAt(nowMs + 1) as Extract<RecordedEvent, { kind: "BOOK" }>).delta);
  });
  // Begin with a valid current-time public event, then advance the wall clock.
  stream.connect = () => {
    stream.emit("book", (eventAt(clock) as Extract<RecordedEvent, { kind: "BOOK" }>).delta);
    clock = f.options.endMs;
  };
  const options = { command: "live" as const, protocol: frozen.protocolPath, out: join(f.directory, "run") };
  const dependencies = { sourceRoot: f.sourceRoot, now: () => clock, tickMs: 5, installSignalHandlers: false,
    engineFactory: () => runner, streamFactory: (config: unknown) => { captured = config; return stream; } };
  const result = await runLiveStudy(options, dependencies);
  assert.equal(result.stopReason, "STUDY_ENDPOINT"); assert.equal(stream.closed, true);
  assert.deepEqual(captured, frozen.manifest.source); assert.equal(runner.events.length, 1);
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(report.state, "FINISHED"); assert.equal(report.brokerOrdersSubmitted, 0);
  const rows = gunzipSync(await readFile(join(options.out, "audit.jsonl.gz"))).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  let previous = "0".repeat(64);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]; assert.equal(row.sequence, i + 1); assert.equal(row.previousHash, previous);
    assert.equal(row.hash, sha(JSON.stringify({ sequence: row.sequence, previousHash: row.previousHash, record: row.record })));
    previous = row.hash;
  }
  assert.equal(report.audit.records, rows.length); assert.equal(report.audit.finalHash, previous);
  assert.equal(report.reproducibility.rawEventsRetained, false);
  clock = nowMs;
  await assert.rejects(runLiveStudy(options, dependencies), { code: "EEXIST" });
});

test("interruption yields an incomplete forward report and late startup is refused", async t => {
  const f = await fixture(t), frozen = await freezeStudy(f.options, f.dependencies), runner = mockRunner(), abort = new AbortController();
  const stream = new FakePublicStream(() => { abort.abort(); });
  const options = { command: "live" as const, protocol: frozen.protocolPath, out: join(f.directory, "run") };
  const result = await runLiveStudy(options, { sourceRoot: f.sourceRoot, now: () => nowMs, tickMs: 5,
    installSignalHandlers: false, abortSignal: abort.signal, engineFactory: () => runner, streamFactory: () => stream });
  const report = JSON.parse(await readFile(result.reportPath, "utf8"));
  assert.equal(report.state, "INTERRUPTED"); assert.equal(report.stopReason, "PROCESS_INTERRUPTED");
  assert.deepEqual(runner.finished, [{ atMs: nowMs, reason: "PROCESS_INTERRUPTED" }]);
  await assert.rejects(runLiveStudy({ ...options, out: join(f.directory, "late") }, { sourceRoot: f.sourceRoot,
    now: () => startMs, engineFactory: () => runner, streamFactory: () => stream }), /START_MUST_PRECEDE/);
});

test("live refuses a development protocol without opening a stream or writing a run marker", async t => {
  const f = await fixture(t);
  await writeFile(f.seed, JSON.stringify({ version: "conditional-study-seed-v1", costs, assets, samples: [] }));
  const frozen = await freezeStudy({ ...f.options, command: "prepare-development", startMs: 10_000, endMs: 20_000 }, f.dependencies);
  const out = join(f.directory, "run"); let connected = false;
  await assert.rejects(runLiveStudy({ command: "live", protocol: frozen.protocolPath, out }, { sourceRoot: f.sourceRoot,
    now: () => nowMs, streamFactory: () => { connected = true; return new FakePublicStream(() => {}); } }), /LIVE_REQUIRES_PROSPECTIVE/);
  assert.equal(connected, false); await assert.rejects(stat(out), { code: "ENOENT" });
});

test("a future source timestamp ends forward collection with a failed report", async t => {
  const f = await fixture(t), frozen = await freezeStudy(f.options, f.dependencies), runner = mockRunner();
  const out = join(f.directory, "run");
  const stream = new FakePublicStream(() => {
    stream.emit("book", (eventAt(nowMs + 1) as Extract<RecordedEvent, { kind: "BOOK" }>).delta);
  });
  await assert.rejects(runLiveStudy({ command: "live", protocol: frozen.protocolPath, out }, {
    sourceRoot: f.sourceRoot, now: () => nowMs, installSignalHandlers: false,
    engineFactory: () => runner, streamFactory: () => stream }), /FUTURE_SOURCE_EVENT/);
  assert.equal(stream.closed, true); assert.equal(runner.events.length, 0);
  const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
  assert.equal(report.state, "FAILED"); assert.equal(report.stopReason, "SOURCE_OR_ENGINE_ERROR");
});

test("a report persistence error stops the stream and fails the run instead of silently dropping evidence", async t => {
  const f = await fixture(t), frozen = await freezeStudy(f.options, f.dependencies), runner = mockRunner();
  const out = join(f.directory, "run"), stream = new FakePublicStream(() => {});
  await assert.rejects(runLiveStudy({ command: "live", protocol: frozen.protocolPath, out }, {
    sourceRoot: f.sourceRoot, now: () => nowMs, installSignalHandlers: false,
    engineFactory: () => runner, streamFactory: () => { mkdirSync(join(out, "report.json")); return stream; } }), /EISDIR|ENOTDIR/);
  assert.equal(stream.closed, true);
  assert.equal(runner.finished.length, 1); assert.equal(runner.finished[0]!.reason, "AUDIT_OR_REPORT_WRITE_FAILED");
  assert.equal(JSON.parse(await readFile(join(out, "run.started.json"), "utf8")).automaticResumePermitted, false);
});
