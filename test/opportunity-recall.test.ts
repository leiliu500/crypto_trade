import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeOpportunityRecall } from "../src/backtest/opportunity-recall.js";
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
