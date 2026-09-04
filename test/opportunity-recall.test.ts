import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeOpportunityRecall, calibrationBucketFromReturns, calibrationGroupKey,
  fixedHorizonGrossReturnBps } from "../src/backtest/opportunity-recall.js";
import { readRecordedEvents } from "../src/backtest/replay.js";
import { loadConfig } from "../src/config.js";
import { EventRecorder } from "../src/recorder.js";

test("compressed recorder produces replayable concatenated gzip batches", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crypto-recorder-"));
  const path = join(directory, "events.jsonl.gz");
  try {
    const recorder = new EventRecorder(path);
    recorder.write({ kind: "TRADE", trade: { symbol: "BTC/USD", px: 100, qty: 1, aggressor: 1, exchangeTsMs: 1, receiveTsMs: 2, sourceId: "trade-1" } });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    recorder.write({ kind: "DISCONNECT", receiveTsMs: 3, stream: "public" });
    await recorder.close();
    const events = [];
    for await (const event of readRecordedEvents(path)) events.push(event);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.kind, "TRADE");
    assert.equal(events[1]?.kind, "DISCONNECT");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("continuous recorder rotates the previous session before writing a fresh replayable stream", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crypto-recorder-rotate-"));
  const path = join(directory, "continuous-events.jsonl.gz");
  try {
    const previous = new EventRecorder(path);
    previous.write({ kind: "DISCONNECT", receiveTsMs: 1, stream: "public" });
    await previous.close();

    const current = new EventRecorder(path, { rotateExisting: true });
    const archivedPath = current.stats().archivedPath;
    assert.ok(archivedPath);
    current.write({ kind: "DISCONNECT", receiveTsMs: 2, stream: "private" });
    await current.close();

    assert.equal(readdirSync(directory).filter((file) => file.endsWith(".jsonl.gz")).length, 2);
    const archived = [];
    for await (const event of readRecordedEvents(archivedPath)) archived.push(event);
    const active = [];
    for await (const event of readRecordedEvents(path)) active.push(event);
    assert.equal(archived[0]?.kind, "DISCONNECT");
    assert.equal(active[0]?.kind, "DISCONNECT");
    assert.equal(active.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("recorder rejects overload without retaining it and writes an explicit replay gap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crypto-recorder-bound-"));
  const path = join(directory, "events.jsonl.gz");
  try {
    const recorder = new EventRecorder(path, { maximumQueuedBytes: 512, compressedBatchBytes: 1 });
    assert.equal(recorder.write({ kind: "PRIVATE", event: { payload: "x".repeat(1_000) } }), false);
    assert.equal(recorder.stats().queuedBytes, 0);
    assert.equal(recorder.stats().droppedEvents, 1);
    assert.equal(recorder.write({ kind: "DISCONNECT", receiveTsMs: 3, stream: "public" }), true);
    await recorder.close();

    const events = [];
    for await (const event of readRecordedEvents(path)) events.push(event);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.kind, "RECORDER_GAP");
    assert.equal(events[0]?.kind === "RECORDER_GAP" ? events[0].droppedEvents : 0, 1);
    assert.equal(events[1]?.kind, "DISCONNECT");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("opportunity recall labels executable moves and refuses tuning on a short sample", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crypto-recall-"));
  const path = join(directory, "events.jsonl");
  try {
    const events: string[] = [];
    for (let index = 0; index < 180; index += 1) {
      const atMs = 1_700_000_000_000 + index * 1_000;
      const mid = index < 60 ? 100 : 100 + Math.min(index - 60, 60) * .04;
      events.push(JSON.stringify({ kind: "BOOK", delta: {
        symbol: "BTC/USD", bids: [{ px: mid - .005, qty: 1_000 }], asks: [{ px: mid + .005, qty: 1_000 }],
        reset: true, exchangeTsMs: atMs, receiveTsMs: atMs, sourceId: `book-${index}`,
      } }));
    }
    writeFileSync(path, `${events.join("\n")}\n`);
    const cfg = loadConfig({ TRADING_MODE: "replay" });
    const report = await analyzeOpportunityRecall(path, cfg);
    assert.equal(report.recording.events, 180);
    assert.equal(report.symbols["BTC/USD"]?.nonFiniteEvents, 0);
    assert.ok((report.symbols["BTC/USD"]?.long.opportunityWindows ?? 0) > 0);
    assert.equal(report.tuning.ready, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Kraken Futures recall treats native shorts as venue-eligible", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crypto-recall-short-"));
  const path = join(directory, "events.jsonl");
  try {
    const atMs = 1_700_000_000_000;
    writeFileSync(path, `${JSON.stringify({ kind: "BOOK", delta: {
      symbol: "BTC/USD", bids: [{ px: 99.99, qty: 1_000 }], asks: [{ px: 100.01, qty: 1_000 }],
      reset: true, exchangeTsMs: atMs, receiveTsMs: atMs, sourceId: "book-1",
    } })}\n`);

    const alpaca = await analyzeOpportunityRecall(path, loadConfig({ TRADING_MODE: "replay" }));
    assert.equal(alpaca.symbols["BTC/USD"]?.short.venueEligible, false);
    assert.equal(alpaca.symbols["BTC/USD"]?.shortAuditOnly.venueEligible, false);

    const kraken = await analyzeOpportunityRecall([path, path], loadConfig({
      TRADING_MODE: "replay", TRADING_VENUE: "kraken_futures",
    }));
    assert.equal(kraken.recording.events, 2);
    assert.deepEqual(kraken.recording.paths, [path, path]);
    assert.equal(kraken.symbols["BTC/USD"]?.short.venueEligible, true);
    assert.equal(kraken.symbols["BTC/USD"]?.shortAuditOnly.venueEligible, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("forward calibration separates side and computes symmetric fixed-horizon returns", () => {
  const longKey = calibrationGroupKey(1, "PULLBACK_RECOVERY", "TREND_UP", 7_200_000,
    "MAKER_MAKER_TAKER_FALLBACK");
  const shortKey = calibrationGroupKey(-1, "PULLBACK_RECOVERY", "TREND_UP", 7_200_000,
    "MAKER_MAKER_TAKER_FALLBACK");
  assert.notEqual(longKey, shortKey);
  assert.notEqual(calibrationGroupKey(1, "CONTINUATION", "BREAKOUT_UP", 1_800_000, "TAKER_TAKER"),
    calibrationGroupKey(1, "EARLY_BREAKOUT", "BREAKOUT_UP", 1_800_000, "TAKER_TAKER"));
  assert.ok(fixedHorizonGrossReturnBps(1, 100, 100.1, 101, 101.1) > 0);
  assert.ok(fixedHorizonGrossReturnBps(-1, 100, 100.1, 99, 99.1) > 0);
  assert.ok(fixedHorizonGrossReturnBps(-1, 100, 100.1, 101, 101.1) < 0);
  const shortBucket = calibrationBucketFromReturns("BTC/USD", "PULLBACK_RECOVERY", -1, "TREND_DOWN",
    7_200_000, "MAKER_MAKER_TAKER_FALLBACK", 30, [8, 12]);
  assert.equal(shortBucket?.side, -1);
  assert.equal(shortBucket?.meanGrossReturnBps, 10);
});

test("recall counts covered time and explicit recorder gaps block tuning", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crypto-recall-gap-"));
  const path = join(directory, "events.jsonl");
  try {
    const firstMs = 1_700_000_000_000;
    writeFileSync(path, [
      JSON.stringify({ kind: "BOOK", delta: {
        symbol: "BTC/USD", bids: [{ px: 99.99, qty: 1_000 }], asks: [{ px: 100.01, qty: 1_000 }],
        reset: true, exchangeTsMs: firstMs, receiveTsMs: firstMs, sourceId: "book-gap-1",
      } }),
      JSON.stringify({ kind: "RECORDER_GAP", receiveTsMs: firstMs + 1_000,
        droppedEvents: 1, droppedBytes: 100 }),
      JSON.stringify({ kind: "BOOK", delta: {
        symbol: "BTC/USD", bids: [{ px: 100, qty: 1_000 }], asks: [{ px: 100.02, qty: 1_000 }],
        reset: true, exchangeTsMs: firstMs + 10_000, receiveTsMs: firstMs + 10_000, sourceId: "book-gap-2",
      } }),
    ].join("\n") + "\n");

    const report = await analyzeOpportunityRecall(path, loadConfig({ TRADING_MODE: "replay" }));
    assert.equal(report.recording.durationMs, 10_000);
    assert.equal(report.recording.coveredDurationMs, 1_000);
    assert.equal(report.recording.gaps, 1);
    assert.match(report.tuning.reason ?? "", /recorder gap/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
