import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadSpotHistoryDataset, loadSpotHistoryDataset, parseSpotOhlcDocument, SPOT_HISTORY_SPEC } from "../src/research/spot-history-data.js";

const T = Date.UTC(2024, 0, 4), DAY = 86400000, NOW = Date.UTC(2026, 8, 9);
const row = (at = T): unknown[] => [at / 1000, "100", "110", "90", "105", "102", "12.5", 20];
const doc = (rows: unknown[][], key = "XXBTZUSD") => ({ error: [], result: { [key]: rows, last: NOW / 1000 } });

test("independent spot bars preserve Thursday weekly boundaries and delayed availability", () => {
  const result = parseSpotOhlcDocument(doc([row()]), "BTC/USD", 10080, NOW);
  assert.equal(result[0]!.openMs, T);
  assert.equal(result[0]!.intervalMinutes, 10080);
  assert.equal(result[0]!.assumedAvailableAtMs, T + 7 * DAY + 60_000);
  assert.equal(result[0]!.trades, 20);
  assert.equal(result[0]!.vwap, 102);
  assert.throws(() => parseSpotOhlcDocument(doc([row(T + DAY)]), "BTC/USD", 10080, NOW), /SPOT_BARS/);
});

test("spot loader discards excluded and uncompleted periods before accessing their prices", () => {
  const future = [Date.UTC(2026, 0, 1) / 1000, "not inspected", null, {}, false, [], 0, 0];
  assert.equal(parseSpotOhlcDocument(doc([row(), future]), "BTC/USD", 1440, NOW).length, 1);
  assert.equal(parseSpotOhlcDocument(doc([row()]), "BTC/USD", 1440, T + DAY + 59_999, T, T + DAY).length, 0);
  assert.equal(parseSpotOhlcDocument(doc([row()]), "BTC/USD", 10080, NOW, T, T + 6 * DAY).length, 0);
});

test("spot validation rejects malformed prices, duplicate time, invented volume and API errors", () => {
  for (const [index, value] of [[1, ""], [1, "NaN"], [2, "95"], [3, "104"], [5, "120"], [6, "-1"], [7, 0], [7, 1.5]] as const) {
    const bad = row(); bad[index] = value;
    assert.throws(() => parseSpotOhlcDocument(doc([bad]), "BTC/USD", 1440, NOW), /SPOT_OHLCVT/);
  }
  assert.throws(() => parseSpotOhlcDocument(doc([row(), row()]), "BTC/USD", 1440, NOW), /SPOT_BARS/);
  assert.throws(() => parseSpotOhlcDocument({ error: ["EGeneral:Rate limit exceeded"], result: {} }, "BTC/USD", 1440, NOW), /SPOT_API_ERROR/);
  const empty = row(); empty[6] = "0"; empty[7] = 0;
  assert.equal(parseSpotOhlcDocument(doc([empty]), "BTC/USD", 1440, NOW)[0]!.volume, 0);
});

test("download seals scoped raw sources, preserves real gaps and reloads by independent source reconstruction", async () => {
  const base = await mkdtemp(join(tmpdir(), "spot-history-")), out = join(base, "sealed");
  try {
    const fetcher: typeof fetch = async input => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.kraken.com");
      const key = url.searchParams.get("pair") === "XBTUSD" ? "XXBTZUSD" : "XETHZUSD";
      const width = Number(url.searchParams.get("interval")) * 60_000;
      return new Response(JSON.stringify(doc([row(), row(T + 2 * width), row(Date.UTC(2026, 0, 1))], key)));
    };
    const dataset = await downloadSpotHistoryDataset(out, { fetcher, nowMs: NOW });
    assert.equal(dataset.bars.length, 8);
    assert.equal(dataset.coverage.every(c => c.missingPeriodsWithinObservedRange === 1), true);
    assert.equal(dataset.sources.every(s => s.originalRows === 3 && s.filteredRows === 2), true);
    assert.equal(dataset.bars.every(b => b.endMsExclusive <= SPOT_HISTORY_SPEC.endMsExclusive), true);
    assert.deepEqual(await loadSpotHistoryDataset(out), dataset);
    const source = join(out, dataset.sources[0]!.file);
    assert.equal((await readFile(source, "utf8")).includes(String(Date.UTC(2026, 0, 1) / 1000)), false);
    await assert.rejects(downloadSpotHistoryDataset(out, { fetcher, nowMs: NOW }), /EEXIST/);
    await writeFile(source, "{}\n");
    await assert.rejects(loadSpotHistoryDataset(out), /SPOT_SOURCE_HASH_MISMATCH/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("oversized or failed HTTP responses cannot publish a successful spot dataset", async () => {
  const base = await mkdtemp(join(tmpdir(), "spot-history-http-"));
  try {
    await assert.rejects(downloadSpotHistoryDataset(join(base, "large"), {
      fetcher: async () => new Response("x".repeat(SPOT_HISTORY_SPEC.maximumResponseBytes + 1)), nowMs: NOW,
    }), /SPOT_RESPONSE_LIMIT/);
    await assert.rejects(downloadSpotHistoryDataset(join(base, "failed"), {
      fetcher: async () => new Response("bad", { status: 429 }), nowMs: NOW,
    }), /SPOT_HTTP_429/);
    await assert.rejects(loadSpotHistoryDataset(join(base, "failed")), /ENOENT/);
  } finally { await rm(base, { recursive: true, force: true }); }
});
