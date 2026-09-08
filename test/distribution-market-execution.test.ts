import assert from "node:assert/strict";
import test from "node:test";
import type { BookState, MarketTrade } from "../src/core/market.js";
import { DistributionMarket, DISTRIBUTION_FEATURES, distributionBookReason } from "../src/distribution/market.js";
import { DistributionExecutionCase, distributionExit } from "../src/distribution/execution.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS, type DistributionAction } from "../src/distribution/spec.js";

function book(atMs: number, bid = 99.99, ask = 100.01, qty = 1, symbol = "BTC/USD"): BookState {
  return { symbol, bids: [{ px: bid, qty }], asks: [{ px: ask, qty }], exchangeTsMs: atMs,
    receiveTsMs: atMs, sequence: BigInt(atMs + 1), valid: true, sourceReset: false };
}
const action: DistributionAction = { ...DISTRIBUTION_ACTIONS[0]! };
const costs = { feeBps: 5, reserveBps: 3 }, scenario = DISTRIBUTION_SCENARIOS[0];
const trade = (atMs: number, id = String(atMs)): MarketTrade => ({ id, symbol: "BTC/USD", px: 100, qty: 2,
  aggressor: 1, exchangeTsMs: atMs, receiveTsMs: atMs });

test("batch observation preserves every independent scenario on fills and invalid paths", () => {
  const paths = [
    [book(100), book(250), book(750), book(1000, 99, 99.02), book(1250, 98.95, 98.97), book(1750, 98.95, 98.97)],
    [book(250, 100.02, 100.04), book(750, 100.02, 100.04)],
    [book(250), book(750), book(700)],
    [book(250), book(750), book(6000)],
    [book(250), { ...book(750), valid: false }],
    [book(250), { ...book(400), sequence: 251n }, book(750), book(1001, 99.99, 100.01, .001)],
    [book(250, 49.99, 50.01, 1, "ETH/USD"), book(1100)],
  ];
  for (const path of paths) {
    const create = () => DISTRIBUTION_ACTIONS.flatMap(a => DISTRIBUTION_SCENARIOS.map(s =>
      new DistributionExecutionCase(a, s, book(0, 99.99, 100.01, .05), .1, costs)));
    const independent = create(), batched = create();
    for (const quote of path) {
      independent.forEach(execution => execution.observe(quote));
      DistributionExecutionCase.observeAll(batched, quote);
      assert.deepEqual(batched.map(e => e.snapshot()), independent.map(e => e.snapshot()));
    }
  }
});

test("deferring feature calculation retains identical causal market state", () => {
  const eager = new DistributionMarket(), deferred = new DistributionMarket();
  for (let at = 0; at <= 1_840_000; at += 1000) {
    for (const symbol of ["BTC/USD", "ETH/USD"]) {
      const quote = book(at, 100 + Math.sin(at / 10_000), 100.02 + Math.sin(at / 10_000), 1, symbol);
      const flow = { ...trade(at), symbol };
      eager.onTrade(flow); deferred.onTrade(flow);
      eager.onBook(quote); deferred.onBook(quote, false);
    }
    if (at % 30_000 === 0) {
      for (const symbol of ["BTC/USD", "ETH/USD"]) assert.deepEqual(deferred.snapshot(symbol, at), eager.snapshot(symbol, at));
      assert.deepEqual(deferred.exportHistory(), eager.exportHistory());
    }
  }
});

test("top-five feature storage preserves deep-book features, caller isolation and validation of trailing depth", () => {
  const full = new DistributionMarket(), top = new DistributionMarket(); warm(full); warm(top);
  const deep = (atMs: number, symbol = "BTC/USD"): BookState => ({ ...book(atMs, 99.99, 100.01, .01, symbol),
    bids: Array.from({ length: 25 }, (_, i) => ({ px: 99.99 - i * .001, qty: .01 })),
    asks: Array.from({ length: 25 }, (_, i) => ({ px: 100.01 + i * .001, qty: .01 })) });
  for (const symbol of ["BTC/USD", "ETH/USD"]) {
    const quote = deep(1_801_000, symbol);
    full.onBook(quote); top.onBook({ ...quote, bids: quote.bids.slice(0, 5), asks: quote.asks.slice(0, 5) });
  }
  assert.deepEqual(full.snapshot("BTC/USD", 1_801_000), top.snapshot("BTC/USD", 1_801_000));
  const callerBook = deep(1_802_000);
  full.onBook(deep(1_802_000, "ETH/USD")); full.onBook(callerBook);
  const snapshot = full.snapshot("BTC/USD", 1_802_000);
  const execution = new DistributionExecutionCase(action, scenario, { ...callerBook,
    asks: [{ px: 101, qty: 1 }] }, .1, costs);
  const arrival = deep(1_802_250);
  full.onBook(arrival); execution.observe(arrival);
  assert.ok(execution.snapshot().filledQty > .099999, "execution still receives liquidity beyond five levels");
  assert.equal(arrival.asks.length, 25, "feature storage does not truncate caller depth");
  full.onBook(deep(1_803_000, "ETH/USD"));
  const mutable = deep(1_803_000); full.onBook(mutable);
  const frozen = full.snapshot("BTC/USD", 1_803_000);
  mutable.bids[0]!.qty = 1000; mutable.asks[0]!.px += 10;
  assert.deepEqual(full.snapshot("BTC/USD", 1_803_000), frozen, "stored top levels own their copies");
  assert.equal(snapshot?.ready, true);
  const invalidTail = deep(1_804_000); invalidTail.asks[20]!.qty = NaN;
  assert.equal(full.onBook(invalidTail)?.reason, "INVALID_DEPTH", "discarded feature levels still undergo input validation");
});

test("ordered trade expiry preserves the exact retention boundary, duplicate suppression and reversed-trade rejection", () => {
  const market = new DistributionMarket(); warm(market);
  market.onTrade(trade(1_800_000, "expired"));
  for (let at = 1_801_000; at <= 1_950_000; at += 1000) {
    market.onBook(book(at)); market.onBook(book(at, 49.99, 50.01, 1, "ETH/USD"));
    if (at === 1_801_000) market.onTrade(trade(at, "boundary"));
  }
  market.onTrade(trade(1_950_000, "new-at-boundary"));
  const first = market.snapshot("BTC/USD", 1_950_000)!.features[2];
  market.onTrade(trade(1_950_000, "expired"));
  assert.equal(market.snapshot("BTC/USD", 1_950_000)!.features[2], first, "exact150second expiry boundary remains retained");
  market.onBook(book(1_951_000)); market.onBook(book(1_951_000, 49.99, 50.01, 1, "ETH/USD"));
  market.onTrade(trade(1_951_000, "trigger-expiry"));
  const second = market.snapshot("BTC/USD", 1_951_000)!.features[2]!;
  market.onTrade(trade(1_951_000, "boundary"));
  market.onTrade(trade(1_950_999, "reversed"));
  assert.equal(market.snapshot("BTC/USD", 1_951_000)!.features[2], second);
  market.onTrade(trade(1_951_000, "expired"));
  assert.ok(market.snapshot("BTC/USD", 1_951_000)!.features[2]! > second, "an expired identifier can be accepted again after expiry processing");
});
function warm(market: DistributionMarket, end = 1_800_000): void {
  for (let atMs = 0; atMs <= end; atMs += 1000) {
    market.onBook(book(atMs, 100 + atMs / 10_000_000, 100.02 + atMs / 10_000_000));
    market.onBook(book(atMs, 49.99, 50.01, 1, "ETH/USD"));
  }
}

test("distribution market uses fixed causal market features, synchronized peers and clean 30-minute warmup", () => {
  const market = new DistributionMarket(); warm(market);
  const snapshot = market.snapshot("BTC/USD", 1_800_000)!;
  assert.equal(snapshot.ready, true); assert.equal(snapshot.features.length, 12);
  assert.equal(DISTRIBUTION_FEATURES.length, 12);
  assert.ok(snapshot.features.every(f => Number.isFinite(f) && Math.abs(f) <= 1));
  assert.ok(snapshot.features[6]! > 0); assert.equal(snapshot.features[9], 0);
  assert.ok(Math.abs(snapshot.features[7]! - snapshot.features[10]!) < 1e-10);
  assert.equal(snapshot.features[11], 1);
  const frozen = structuredClone(snapshot);
  market.onBook(book(1_801_000, 110, 110.02));
  assert.deepEqual(snapshot, frozen, "future ticks never mutate emitted vectors");
  assert.equal(market.snapshot("BTC/USD", 1_800_000)!.ready, false, "historical snapshots cannot read future state");
  market.onBook(book(1_803_000, 110, 110.02));
  assert.equal(market.snapshot("BTC/USD", 1_803_000)!.reason, "PEER_NOT_SYNCHRONIZED");
});

test("distribution gaps, invalidity, duplicate refreshes and reversed events cannot fabricate price coverage", () => {
  for (const failure of ["gap", "invalid", "reverse"] as const) {
    const market = new DistributionMarket(); warm(market);
    if (failure === "gap") market.onBook(book(1_806_000));
    if (failure === "invalid") market.onBook({ ...book(1_801_000), valid: false });
    if (failure === "reverse") market.onBook(book(1_799_500));
    market.onBook(book(1_807_000)); market.onBook(book(1_807_000, 49.99, 50.01, 1, "ETH/USD"));
    assert.equal(market.snapshot("BTC/USD", 1_807_000)!.ready, false);
  }
  const market = new DistributionMarket(); warm(market);
  market.onBook({ ...book(1_803_000), sequence: 1_800_001n });
  assert.equal(market.snapshot("BTC/USD", 1_803_000)!.reason, "STALE_BOOK");
});

test("brief endpoint gaps recover after fresh flow warmup; long gaps discard history and ordinary reset images remain usable", () => {
  const market = new DistributionMarket(); warm(market);
  market.onBook({ ...book(1_801_000), valid: false });
  for (let atMs = 1_810_000; atMs <= 1_840_000; atMs += 1000) {
    market.onBook({ ...book(atMs), sourceReset: true });
    market.onBook({ ...book(atMs, 49.99, 50.01, 1, "ETH/USD"), sourceReset: true });
    if (atMs < 1_840_000) assert.equal(market.snapshot("BTC/USD", atMs)!.ready, false);
  }
  assert.equal(market.snapshot("BTC/USD", 1_840_000)!.ready, true);
  assert.equal(market.snapshot("BTC/USD", 1_840_000)!.features[2], 0);
  for (let atMs = 1_940_000; atMs <= 1_971_000; atMs += 1000) {
    market.onBook(book(atMs)); market.onBook(book(atMs, 49.99, 50.01, 1, "ETH/USD"));
  }
  assert.equal(market.snapshot("BTC/USD", 1_971_000)!.reason, "WARMING_30_MINUTES");
});

test("trade flow deduplicates events, decays in clock time, resets with gaps and does not leak future events", () => {
  const market = new DistributionMarket(); warm(market);
  market.onTrade(trade(1_800_000));
  const first = market.snapshot("BTC/USD", 1_800_000)!.features[2]!;
  assert.ok(first > 0); market.onTrade(trade(1_800_000));
  assert.equal(market.snapshot("BTC/USD", 1_800_000)!.features[2], first);
  for (let atMs = 1_801_000; atMs <= 1_830_000; atMs += 1000) {
    market.onBook(book(atMs)); market.onBook(book(atMs, 49.99, 50.01, 1, "ETH/USD"));
  }
  assert.ok(market.snapshot("BTC/USD", 1_830_000)!.features[2]! < first);
  market.onTrade(trade(1_830_500));
  assert.equal(market.snapshot("BTC/USD", 1_830_000)!.ready, false);
  market.onBook(book(1_830_250));
  assert.equal(market.snapshot("BTC/USD", 1_830_250)!.ready, false);
});

test("book validation accepts complete reset images and rejects stale, crossed, unsorted, nonfinite and empty depth", () => {
  for (const invalid of [
    { ...book(2000), exchangeTsMs: 0 }, { ...book(0), exchangeTsMs: 1 }, { ...book(0), valid: false },
    book(0, 101, 100), { ...book(0), bids: [] }, { ...book(0), asks: [{ px: 100, qty: NaN }] },
    { ...book(0), bids: [{ px: 100, qty: 1 }, { px: 101, qty: 1 }] },
  ]) assert.ok(distributionBookReason(invalid));
  assert.equal(distributionBookReason(book(0)), null);
  assert.equal(distributionBookReason({ ...book(0), sourceReset: true }), null);
});

test("capped IOC waits for arrival, preserves observed nonfills and refuses unavailable entry observations", () => {
  const pending = new DistributionExecutionCase(action, scenario, book(0), .1, costs);
  assert.equal(pending.observe(book(100)), null); assert.equal(pending.snapshot().status, "PENDING");
  const zero = pending.observe(book(250, 100.02, 100.04))!;
  assert.equal(zero.status, "UNFILLED"); assert.equal(zero.netBps, 0); assert.equal(zero.filledFraction, 0);
  assert.equal(zero.entryAtMs, null);
  const missing = new DistributionExecutionCase(action, scenario, book(0), .1, costs);
  assert.equal(missing.observe(book(1001))!.status, "INVALID");
  const stale = new DistributionExecutionCase(action, scenario, book(0), .1, costs);
  assert.equal(stale.observe({ ...book(250), exchangeTsMs: -1000 })!.status, "INVALID");
});

test("partial entries weight exact two-sided fees and reserve by the original requested quantity", () => {
  const position = new DistributionExecutionCase(action, scenario, book(0, 99.98, 100, .05), .1, costs);
  position.observe(book(250, 99.98, 100, .05));
  assert.equal(position.snapshot().filledQty, .05);
  position.observe(book(500, 99, 99.02)); // Gross stop triggers; fill is delayed.
  assert.equal(position.snapshot().status, "EXIT_PENDING");
  const outcome = position.observe(book(750, 98.95, 98.97))!;
  assert.equal(outcome.status, "FILLED"); assert.equal(outcome.reason, "STOP_LOSS");
  assert.equal(outcome.filledFraction, .5);
  assert.ok(Math.abs(outcome.grossBps! - -52.5) < 1e-8);
  assert.ok(Math.abs(outcome.netBps! - (-105 - 5 * (1 + .9895) - 3) * .5) < 1e-8);
  outcome.netBps = 1000;
  assert.ok(position.snapshot().outcome!.netBps! < 0, "callers cannot rewrite completed labels");
});

test("short exits sweep asks, apply adverse arrival costs, and fee/depth stress changes observed cashflows", () => {
  const short = { ...action, side: -1 as const };
  const position = new DistributionExecutionCase(short, DISTRIBUTION_SCENARIOS[1], book(0, 100, 100.02), .1, costs);
  position.observe(book(250, 100, 100.02));
  position.observe(book(500, 101, 101.02));
  const outcome = position.observe(book(750, 101.03, 101.05))!;
  assert.ok(Math.abs(outcome.netBps! - (-105 - 7.5 * (1 + 1.0105) - 3)) < 1e-8);
  const stressed = new DistributionExecutionCase(action, DISTRIBUTION_SCENARIOS[2], book(0, 99.98, 100, .1), .1, costs);
  stressed.observe(book(250, 99.98, 100, .1)); assert.equal(stressed.snapshot().status, "PENDING");
  stressed.observe(book(750, 99.98, 100, .1)); assert.equal(stressed.snapshot().filledQty, .05);
});

test("execution refuses missing paths, reversed quotes and insufficient exit depth", () => {
  for (const invalid of [book(6000), book(200), { ...book(500), valid: false }, book(500, 99.99, 100.01, .01)]) {
    const position = new DistributionExecutionCase(action, scenario, book(0), .1, costs);
    position.observe(book(250));
    assert.equal(position.observe(invalid)!.status, "INVALID");
    assert.equal(position.snapshot().outcome!.netBps, null);
  }
  const missedExit = new DistributionExecutionCase(action, scenario, book(0), .1, costs);
  missedExit.observe(book(250)); missedExit.observe(book(500, 99, 99.02));
  assert.equal(missedExit.observe(book(750, 98, 98.02))!.reason, "EXIT_CAP_OR_DEPTH_UNAVAILABLE");
  const expiredExit = new DistributionExecutionCase(action, scenario, book(0), .1, costs);
  expiredExit.observe(book(250)); expiredExit.observe(book(500, 99, 99.02));
  assert.equal(expiredExit.observe(book(1501, 99, 99.02))!.reason, "MISSING_EXIT_ARRIVAL_QUOTE");
});

test("shared exit function has stop priority, net targets and actual-entry holding deadlines", () => {
  assert.equal(distributionExit(action, -action.stopLossBps, 100, action.horizonMs), "STOP_LOSS");
  assert.equal(distributionExit(action, 50, action.takeProfitNetBps, 1), "TAKE_PROFIT");
  assert.equal(distributionExit(action, 20, action.takeProfitNetBps - 1, action.horizonMs - 1), null);
  assert.equal(distributionExit(action, 0, -10, action.horizonMs), "DEADLINE");
  const shortAction = { ...action, horizonMs: 1000 };
  const position = new DistributionExecutionCase(shortAction, scenario, book(0), .1, costs);
  position.observe(book(250)); position.observe(book(1000)); assert.equal(position.snapshot().status, "OPEN");
  position.observe(book(1250)); assert.equal(position.snapshot().status, "EXIT_PENDING");
  assert.equal(position.observe(book(1500))!.reason, "DEADLINE");
});

test("execution freezes proposal-time policy and fee assumptions against subsequent caller mutation", () => {
  const policy = { ...action, horizonMs: 1000 }, feeAssumptions = { ...costs };
  const position = new DistributionExecutionCase(policy, scenario, book(0), .1, feeAssumptions);
  policy.horizonMs = 1; feeAssumptions.feeBps = 100;
  position.observe(book(250)); position.observe(book(500)); assert.equal(position.snapshot().status, "OPEN");
  position.observe(book(1250)); const outcome = position.observe(book(1500))!;
  assert.equal(outcome.reason, "DEADLINE");
  assert.ok(outcome.netBps! > -20, "fee changes after the proposal cannot rewrite its target");
});
