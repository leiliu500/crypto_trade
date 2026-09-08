import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { RecordedEvent } from "../src/backtest/replay.js";
import { DistributionMarket } from "../src/distribution/market.js";
import { prepareDistributionHistory, warmDistributionMarketHistory } from "../src/distribution/history-replay.js";

function book(atMs: number, symbol = "BTC/USD", reset = true, id = `${symbol}:${atMs}`): RecordedEvent {
  return { kind: "BOOK", delta: { symbol, receiveTsMs: atMs, exchangeTsMs: atMs, reset,
    sourceId: id, bids: [{ px: 100 + atMs / 10_000_000, qty: 1 }], asks: [{ px: 101 + atMs / 10_000_000, qty: 1 }] } };
}
function* history(end = 1_800_000): Generator<RecordedEvent> {
  for (let at = 0; at <= end; at += 1000) { yield book(at); yield book(at, "ETH/USD"); }
}

test("historical preparation exports bounded actual price endpoints without model labels, quotes or orders", async () => {
  const result = await warmDistributionMarketHistory(history(1_900_000), 1_900_000);
  assert.equal(result.report.acceptedBooks, 3802);
  assert.equal(result.history.symbols.length, 2);
  for (const state of result.history.symbols) {
    assert.equal(state.samples.length, 181);
    assert.equal(state.samples[0]!.atMs, 100_000);
    assert.equal(state.samples.at(-1)!.atMs, 1_900_000);
    assert.deepEqual(Object.keys(state).sort(), ["lastBookAtMs", "samples", "symbol"]);
    assert.equal(state.samples[0]!.mid, 100.51);
  }
  assert.equal(result.report.trainingOutcomesCreated, 0);
  assert.equal(result.report.prospectiveSelectionsCreated, 0);
  assert.equal(result.report.brokerOrdersSubmitted, 0);
  const live = new DistributionMarket(); live.restoreHistory(result.history, 1_900_000);
  assert.equal(live.snapshot("BTC/USD", 1_900_000)!.ready, false, "historical quotes never become executable");
});

test("cutoff excludes future samples while preserving legitimate buffered cross-stream receipt interleaving", async () => {
  const events = [book(10_000, "ETH/USD"), book(9_990), book(20_001), book(20_000, "ETH/USD")];
  const result = await warmDistributionMarketHistory(events, 20_000);
  assert.equal(result.report.futureEventsExcluded, 1);
  assert.equal(result.report.timestampReversals, 0);
  assert.equal(result.report.crossStreamReceiveRegressions, 1);
  assert.equal(result.history.symbols.find(s => s.symbol === "BTC/USD")!.lastBookAtMs, 9_990);
  assert.ok(result.history.symbols.every(s => s.samples.every(p => p.atMs <= 20_000)));
  await assert.rejects(warmDistributionMarketHistory([], NaN), /INVALID_HISTORY_CUTOFF/);
});

test("public reconnect preserves only recent real endpoints; private disconnect does not break public prices", async () => {
  const events: RecordedEvent[] = [...history(),
    { kind: "DISCONNECT", stream: "private", receiveTsMs: 1_805_000 },
    { kind: "DISCONNECT", stream: "public", receiveTsMs: 1_810_000 },
    book(1_820_000), book(1_820_000, "ETH/USD")];
  const recent = await warmDistributionMarketHistory(events, 1_820_000);
  assert.equal(recent.report.publicDisconnects, 1);
  assert.equal(recent.report.ignoredPrivate, 1);
  assert.ok(recent.history.symbols.every(s => s.samples.length > 170));
  const stale = await warmDistributionMarketHistory(history(), 1_890_001);
  assert.equal(stale.history.symbols.length, 0);
  assert.equal(stale.report.rejectedSymbols.length, 2);
});

test("recording gaps, crossed books and true stream reversals discard all joint history", async () => {
  const crossed = book(1_810_000);
  if (crossed.kind === "BOOK") crossed.delta.bids = [{ px: 200, qty: 1 }];
  for (const invalid of [
    { kind: "RECORDER_GAP", receiveTsMs: 1_810_000, droppedEvents: 2, droppedBytes: 100 } as RecordedEvent,
    crossed, book(1_799_999),
  ]) {
    const result = await warmDistributionMarketHistory([...history(), invalid,
      book(1_820_000), book(1_820_000, "ETH/USD")], 1_820_000);
    assert.ok(result.history.symbols.every(s => s.samples.length === 1));
    assert.ok(Object.keys(result.report.invalidReasons).length > 0);
  }
});

test("atomic offline preparation hashes frozen gzip input and emits a compact directly restorable file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "distribution-history-"));
  try {
    const input = join(directory, "events.jsonl.gz"), output = join(directory, "history.json");
    const content = gzipSync([...history()].map(event => JSON.stringify(event)).join("\n") + "\n");
    await writeFile(input, content);
    const result = await prepareDistributionHistory([input], output, 1_800_000);
    assert.equal(result.report.inputFiles[0]!.sha256, createHash("sha256").update(content).digest("hex"));
    const saved = await readFile(output, "utf8");
    assert.deepEqual(JSON.parse(saved), result.history);
    assert.equal(result.report.historySha256, createHash("sha256").update(saved).digest("hex"));
    assert.ok(saved.length < 20_000);
    assert.ok((await readdir(directory)).every(name => !name.endsWith(".tmp")));
    await assert.rejects(prepareDistributionHistory([input], input, 1_800_000), /COLLISION/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("truncated gzip, malformed JSON and missing files cannot replace a prepared history file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "distribution-history-errors-"));
  try {
    const output = join(directory, "history.json"); await writeFile(output, "previous checkpoint");
    const compressed = gzipSync(`${JSON.stringify(book(1000))}\n`);
    const cases = [
      { path: join(directory, "truncated.jsonl.gz"), data: compressed.subarray(0, compressed.length - 5) },
      { path: join(directory, "malformed.jsonl"), data: Buffer.from("{invalid\n") },
      { path: join(directory, "malformed.jsonl.gz"), data: gzipSync("{invalid\n") },
    ];
    for (const item of cases) {
      await writeFile(item.path, item.data);
      await assert.rejects(prepareDistributionHistory([item.path], output, 1000));
      assert.equal(await readFile(output, "utf8"), "previous checkpoint");
    }
    await assert.rejects(prepareDistributionHistory([join(directory, "missing.gz")], output, 1000), /ENOENT/);
    assert.ok((await readdir(directory)).every(name => !name.endsWith(".tmp")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
