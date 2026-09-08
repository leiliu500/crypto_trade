import assert from "node:assert/strict";
import test from "node:test";
import type { BookState } from "../src/core/market.js";
import { DistributionMarket, DISTRIBUTION_LOOKBACK_MS, DISTRIBUTION_MARKET_HISTORY_VERSION,
  DISTRIBUTION_FLOW_WARM_MS, type DistributionMarketHistory } from "../src/distribution/market.js";

const START = 1_780_000_000_000;
const END = START + DISTRIBUTION_LOOKBACK_MS;
function book(atMs: number, symbol = "BTC/USD", change = 0): BookState {
  const mid = (symbol === "BTC/USD" ? 80_000 : 3_000) + change;
  return { symbol, bids: [{ px: mid - .5, qty: 1 }], asks: [{ px: mid + .5, qty: 1 }],
    receiveTsMs: atMs, exchangeTsMs: atMs, sequence: BigInt(atMs), valid: true, sourceReset: true };
}
function pair(market: DistributionMarket, atMs: number, change = 0): void {
  market.onBook(book(atMs, "BTC/USD", change)); market.onBook(book(atMs, "ETH/USD", change / 10));
}
function warm(market: DistributionMarket, end = END): void {
  for (let atMs = START; atMs <= end; atMs += 1000) pair(market, atMs);
}

test("history restores actual prices immediately but requires fresh books and 30 seconds of live flow", () => {
  const original = new DistributionMarket(); warm(original);
  original.onTrade({ symbol: "BTC/USD", id: "before-restart", px: 80_000, qty: 100, aggressor: 1,
    receiveTsMs: END, exchangeTsMs: END });
  const history = original.exportHistory(), resumed = new DistributionMarket();
  assert.deepEqual(resumed.restoreHistory(JSON.parse(JSON.stringify(history)), END + 1000), {
    restoredSymbols: ["BTC/USD", "ETH/USD"], restoredSamples: 362, rejectedSymbols: [],
  });
  const progress = resumed.historyStats("BTC/USD", END + 1000);
  assert.equal(progress.coverageMs, DISTRIBUTION_LOOKBACK_MS); assert.equal(progress.remainingMs, 0);
  assert.equal(progress.restoredSampleCount, 181); assert.equal(progress.reason, "BOOK_NOT_READY");
  assert.equal(progress.flowCoverageMs, 0); assert.equal(progress.flowRemainingMs, DISTRIBUTION_FLOW_WARM_MS);
  resumed.onBook(book(END + 1000));
  assert.equal(resumed.snapshot("BTC/USD", END + 1000)!.reason, "PEER_NOT_SYNCHRONIZED");
  resumed.onBook(book(END + 1000, "ETH/USD"));
  assert.equal(resumed.snapshot("BTC/USD", END + 1000)!.reason, "WARMING_FLOW_30_SECONDS");
  for (let atMs = END + 2000; atMs <= END + 31_000; atMs += 1000) pair(resumed, atMs);
  const ready = resumed.snapshot("BTC/USD", END + 31_000)!;
  assert.equal(ready.ready, true); assert.equal(ready.features[2], 0, "historical trade flow cannot survive restoration");
  assert.equal(resumed.historyStats("BTC/USD", END + 31_000).flowRemainingMs, 0);
  resumed.onTrade({ symbol: "BTC/USD", id: "before-restart", px: 80_000, qty: 1, aggressor: 1,
    receiveTsMs: END + 31_000, exchangeTsMs: END + 31_000 });
  assert.ok(resumed.snapshot("BTC/USD", END + 31_000)!.features[2]! > 0, "historical deduplication IDs are cleared");
  history.symbols[0]!.samples[0]!.mid = 1;
  assert.equal(resumed.exportHistory().symbols[0]!.samples[0]!.mid, 80_000, "restoration owns immutable copies");
});

test("partial recent history saves elapsed warmup without fabricating older observations", () => {
  const original = new DistributionMarket(); warm(original, START + 600_000);
  const resumed = new DistributionMarket(); resumed.restoreHistory(original.exportHistory(), START + 601_000);
  const progress = resumed.historyStats("BTC/USD", START + 601_000);
  assert.equal(progress.coverageMs, 600_000); assert.equal(progress.remainingMs, 1_200_000);
  for (let atMs = START + 601_000; atMs < END; atMs += 1000) pair(resumed, atMs);
  assert.equal(resumed.snapshot("BTC/USD", END - 1000)!.reason, "WARMING_30_MINUTES");
  pair(resumed, END);
  assert.equal(resumed.snapshot("BTC/USD", END)!.ready, true);
  assert.equal(resumed.historyStats("BTC/USD", END).remainingMs, 0);
});

test("corrupt or future history rejects atomically, including errors after a valid first symbol", () => {
  const market = new DistributionMarket(); warm(market);
  const before = market.exportHistory(), beforeSnapshot = market.snapshot("BTC/USD", END);
  const bad: unknown[] = [null, { version: "old", symbols: [] }, { version: DISTRIBUTION_MARKET_HISTORY_VERSION, symbols: [{}] }];
  const mutate = (fn: (history: DistributionMarketHistory) => void): void => {
    const history = structuredClone(before); fn(history); bad.push(history);
  };
  mutate(h => { h.symbols[1]!.lastBookAtMs = END + 1; });
  mutate(h => { h.symbols[1]!.samples[0]!.mid = 0; });
  mutate(h => { h.symbols[1]!.samples[0]!.mid = Number.NaN; });
  mutate(h => { h.symbols[1]!.samples[0]!.atMs += .5; });
  mutate(h => { h.symbols[1]!.samples[1]!.atMs = h.symbols[1]!.samples[0]!.atMs; });
  mutate(h => { h.symbols[1]!.samples.splice(1, 10); });
  mutate(h => { h.symbols[1]!.samples.pop(); });
  mutate(h => { h.symbols[1]!.samples.push(...h.symbols[1]!.samples); });
  mutate(h => { h.symbols[1]!.symbol = "BTC/USD"; });
  for (const invalid of bad) {
    assert.throws(() => market.restoreHistory(invalid, END), /Invalid distribution market history/);
    assert.deepEqual(market.exportHistory(), before); assert.deepEqual(market.snapshot("BTC/USD", END), beforeSnapshot);
  }
  assert.throws(() => market.restoreHistory(before, Number.NaN), /cutoff/);
});

test("stale history does not replace live state and restored endpoints expire after a long startup gap", () => {
  const market = new DistributionMarket(); warm(market);
  const before = market.exportHistory(), beforeSnapshot = market.snapshot("BTC/USD", END);
  assert.deepEqual(market.restoreHistory(before, END + 90_001), { restoredSymbols: [], restoredSamples: 0,
    rejectedSymbols: [{ symbol: "BTC/USD", reason: "HISTORY_STALE" }, { symbol: "ETH/USD", reason: "HISTORY_STALE" }] });
  assert.deepEqual(market.exportHistory(), before); assert.deepEqual(market.snapshot("BTC/USD", END), beforeSnapshot);
  const resumed = new DistributionMarket(); resumed.restoreHistory(before, END + 90_000);
  pair(resumed, END + 90_001);
  assert.equal(resumed.historyStats("BTC/USD", END + 90_001).restoredSampleCount, 0);
  assert.equal(resumed.historyStats("BTC/USD", END + 90_001).coverageMs, 0);
  assert.equal(resumed.snapshot("BTC/USD", END + 90_001)!.reason, "WARMING_30_MINUTES");
});

test("portable history preserves real endpoint spacing across a valid book gap near 90 seconds", () => {
  const original = new DistributionMarket(); warm(original);
  for (let atMs = END + 1000; atMs <= END + 9000; atMs += 1000) pair(original, atMs);
  pair(original, END + 98_000); // 89 seconds since the last book; 98 since the last sampled mid.
  const history = original.exportHistory();
  assert.equal(history.symbols[0]!.samples.at(-1)!.atMs - history.symbols[0]!.samples.at(-2)!.atMs, 98_000);
  const resumed = new DistributionMarket();
  assert.equal(resumed.restoreHistory(history, END + 98_001).restoredSymbols.length, 2);
  assert.deepEqual(resumed.exportHistory(), history);
  for (let atMs = END + 99_000; atMs <= END + 129_000; atMs += 1000) pair(resumed, atMs);
  assert.equal(resumed.snapshot("BTC/USD", END + 129_000)!.ready, true);
});

test("resumed actual price endpoints produce the same complete feature vector as continuous data", () => {
  const continuous = new DistributionMarket(); warm(continuous);
  const resumed = new DistributionMarket(); resumed.restoreHistory(continuous.exportHistory(), END + 1000);
  for (let atMs = END + 1000; atMs <= END + 31_000; atMs += 1000) {
    // First fresh book matches the prior mid; both zero-flow states then observe
    // identical real price changes and trades. No sampled prices are interpolated.
    const change = (atMs - END - 1000) / 500;
    for (const market of [continuous, resumed]) {
      pair(market, atMs, change);
      market.onTrade({ symbol: "BTC/USD", id: String(atMs), px: 80_000 + change, qty: .05,
        aggressor: atMs % 2000 ? -1 : 1, receiveTsMs: atMs, exchangeTsMs: atMs });
    }
  }
  for (const symbol of ["BTC/USD", "ETH/USD"]) {
    assert.equal(resumed.snapshot(symbol, END + 31_000)!.ready, true);
    assert.deepEqual(resumed.snapshot(symbol, END + 31_000), continuous.snapshot(symbol, END + 31_000));
  }
});
