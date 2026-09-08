import assert from "node:assert/strict";
import test from "node:test";
import type { RecordedEvent } from "../src/backtest/replay.js";
import type { BookState } from "../src/core/market.js";
import type { AssetRules } from "../src/execution/planner.js";
import { DistributionController } from "../src/distribution/controller.js";
import { DistributionMarket, DISTRIBUTION_LOOKBACK_MS, DISTRIBUTION_FLOW_WARM_MS,
  DISTRIBUTION_MAXIMUM_PRICE_GAP_MS } from "../src/distribution/market.js";
import { ConditionalDistributionModel } from "../src/distribution/model.js";
import { replayDistribution } from "../src/distribution/replay.js";
import { DISTRIBUTION_SPEC as S, type DistributionEstimate } from "../src/distribution/spec.js";

const START = 1_780_000_000_000, END = START + DISTRIBUTION_LOOKBACK_MS;
const READY = END + DISTRIBUTION_FLOW_WARM_MS;
const costs = Object.fromEntries(S.symbols.map(symbol => [symbol, { feeBps: 5, reserveBps: 3 }]));
const assets: Record<string, AssetRules> = Object.fromEntries(S.symbols.map(symbol => [symbol,
  { symbol, minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .01, maximumOrderQty: 1, shortable: true }]));
function book(atMs: number, symbol = "BTC/USD", bidQty = 1): BookState {
  return { symbol, bids: [{ px: 100, qty: bidQty }], asks: [{ px: 100.01, qty: 1 }],
    receiveTsMs: atMs, exchangeTsMs: atMs, sequence: BigInt(atMs + 1), valid: true, sourceReset: true };
}
function pair(target: Pick<DistributionController, "onBook"> | DistributionMarket, atMs: number): void {
  for (const symbol of S.symbols) target.onBook(book(atMs, symbol));
}
// These are actual observed endpoints, sampled by the real market. Restoring
// them saves repeated setup work; every test still warms fresh flow normally.
const seedMarket = new DistributionMarket();
for (let atMs = START; atMs <= END; atMs += 1_000) pair(seedMarket, atMs);
const history = seedMarket.exportHistory();
function warmController(): DistributionController {
  const controller = new DistributionController(costs, { ...assets });
  controller.restoreMarketHistory(history, END);
  for (let atMs = END; atMs <= READY; atMs += 1_000) pair(controller, atMs);
  assert.ok(controller.currentDecision("BTC/USD"));
  assert.equal(controller.stats(READY).pendingPanels, 2);
  return controller;
}

for (const reason of ["PUBLIC_STREAM_DOWN", "DISCONNECT"]) {
  test(`${reason} preserves prices but invalidates paths until both markets rebuild fresh flow`, () => {
    const controller = warmController();
    pair(controller, READY + 250);
    const before = controller.exportMarketHistory();
    const invalid = controller.invalidate(READY + 500, reason);
    assert.equal(invalid.length, 12);
    assert.ok(invalid.every(sample => sample.outcomes.every(outcome => outcome.status === "INVALID")));
    assert.equal(controller.stats(READY + 500).pendingPanels, 0);
    assert.equal(controller.stats(READY + 500).learning.acceptedSamples, 0);
    assert.deepEqual(controller.exportMarketHistory(), before);
    for (const symbol of S.symbols) {
      assert.equal(controller.currentDecision(symbol), null);
      const state = controller.stats(READY + 500).markets.find(row => row.symbol === symbol)!;
      assert.equal(state.remainingMs, 0);
      assert.equal(state.flowCoverageMs, 0);
      assert.equal(state.reason, "BOOK_NOT_READY");
    }

    const resumedAt = READY + 2_000;
    assert.equal(controller.onBook(book(resumedAt)).decision, null, "the old peer book cannot authorize inference");
    controller.onBook(book(resumedAt, "ETH/USD"));
    for (let atMs = resumedAt + 1_000; atMs < resumedAt + DISTRIBUTION_FLOW_WARM_MS; atMs += 1_000) {
      for (const symbol of S.symbols) assert.equal(controller.onBook(book(atMs, symbol)).decision, null);
    }
    for (const symbol of S.symbols) {
      const update = controller.onBook(book(resumedAt + DISTRIBUTION_FLOW_WARM_MS, symbol));
      assert.ok(update.decision, "fresh inference resumes after 30 seconds, without another 30-minute lookback");
      assert.equal(update.trainingDecision, null, "the independent training timer has not elapsed");
      assert.ok(update.decision.atMs < controller.stats(update.decision.atMs).nextProposals[symbol]!);
    }
    assert.equal(controller.stats(resumedAt + DISTRIBUTION_FLOW_WARM_MS).proposals, 2);
  });
}

test("disconnect recovery drops stale quotes and all pre-disconnect order and trade flow", () => {
  const market = new DistributionMarket();
  market.restoreHistory(history, END);
  for (let atMs = END; atMs <= READY; atMs += 1_000) pair(market, atMs);
  market.onBook(book(READY + 250, "BTC/USD", 20));
  market.onTrade({ symbol: "BTC/USD", id: "old-flow", px: 100, qty: 100, aggressor: 1,
    receiveTsMs: READY + 250, exchangeTsMs: READY + 250 });
  const before = market.snapshot("BTC/USD", READY + 250)!;
  assert.ok(before.features[1]! > 0); assert.ok(before.features[2]! > 0);
  market.onDisconnect(READY + 500);
  assert.equal(market.snapshot("BTC/USD", READY + 500)!.reason, "BOOK_NOT_READY");
  const stale = { ...book(READY + 1_000), exchangeTsMs: READY - 1 };
  assert.equal(market.onBook(stale)!.reason, "STALE_PROVIDER_QUOTE");
  assert.equal(market.historyStats("BTC/USD", READY + 1_000).flowCoverageMs, 0);
  for (let atMs = READY + 2_000; atMs <= READY + 32_000; atMs += 1_000) pair(market, atMs);
  const resumed = market.snapshot("BTC/USD", READY + 32_000)!;
  assert.equal(resumed.ready, true);
  assert.equal(resumed.features[1], 0, "pre-disconnect OFI is not carried into fresh flow");
  assert.equal(resumed.features[2], 0, "pre-disconnect trades are not carried into fresh flow");
  market.onTrade({ symbol: "BTC/USD", id: "old-flow", px: 100, qty: 1, aggressor: 1,
    receiveTsMs: READY + 32_000, exchangeTsMs: READY + 32_000 });
  assert.ok(market.snapshot("BTC/USD", READY + 32_000)!.features[2]! > 0,
    "trade deduplication also belongs to the new connection");
});

test("a late first reconnect quote discards history after the total gap exceeds 90 seconds", () => {
  const controller = warmController();
  controller.invalidate(READY + 500, "PUBLIC_STREAM_DOWN");
  const resumedAt = READY + DISTRIBUTION_MAXIMUM_PRICE_GAP_MS + 1;
  pair(controller, resumedAt);
  for (const state of controller.stats(resumedAt).markets) {
    assert.equal(state.coverageMs, 0);
    assert.equal(state.remainingMs, DISTRIBUTION_LOOKBACK_MS);
    assert.equal(state.reason, "WARMING_30_MINUTES");
  }
  for (let atMs = resumedAt + 1_000; atMs < resumedAt + DISTRIBUTION_LOOKBACK_MS; atMs += 1_000) {
    for (const symbol of S.symbols) assert.equal(controller.onBook(book(atMs, symbol)).decision, null);
  }
  for (const symbol of S.symbols) assert.ok(controller.onBook(book(resumedAt + DISTRIBUTION_LOOKBACK_MS, symbol)).decision);
});

test("repeated disconnect notifications cannot refresh or extend old price history", () => {
  const controller = warmController(), before = controller.exportMarketHistory();
  controller.invalidate(READY + 1_000, "PUBLIC_STREAM_DOWN");
  controller.invalidate(READY + 80_000, "PUBLIC_STREAM_DOWN");
  assert.deepEqual(controller.exportMarketHistory(), before, "disconnect timestamps are not observed book timestamps");
  controller.invalidate(READY + DISTRIBUTION_MAXIMUM_PRICE_GAP_MS + 1, "PUBLIC_STREAM_DOWN");
  assert.equal(controller.exportMarketHistory().symbols.length, 0);
  assert.equal(controller.stats(READY + 90_001).markets[0]!.remainingMs, DISTRIBUTION_LOOKBACK_MS);
});

test("a reconnect exactly 90 seconds after the last clean book retains real endpoints", () => {
  const controller = warmController();
  controller.invalidate(READY + 1_000, "PUBLIC_STREAM_DOWN");
  const resumedAt = READY + DISTRIBUTION_MAXIMUM_PRICE_GAP_MS;
  for (let atMs = resumedAt; atMs <= resumedAt + DISTRIBUTION_FLOW_WARM_MS; atMs += 1_000) pair(controller, atMs);
  for (const symbol of S.symbols) {
    assert.equal(controller.currentDecision(symbol)?.atMs, resumedAt + DISTRIBUTION_FLOW_WARM_MS);
    assert.equal(controller.stats(resumedAt + DISTRIBUTION_FLOW_WARM_MS).markets.find(row => row.symbol === symbol)!.remainingMs, 0);
  }
});

for (const reason of ["RECORDER_GAP", "BOOK_INVALID", "NON_FINITE_FEATURES"]) {
  test(`${reason} continues to clear history instead of taking the disconnect recovery path`, () => {
    const controller = warmController();
    controller.invalidate(READY + 500, reason);
    assert.equal(controller.exportMarketHistory().symbols.length, 0);
    for (let atMs = READY + 1_000; atMs <= READY + 31_000; atMs += 1_000) pair(controller, atMs);
    for (const symbol of S.symbols) assert.equal(controller.currentDecision(symbol), null);
    assert.ok(controller.stats(READY + 31_000).markets.every(row => row.reason === "WARMING_30_MINUTES"));
  });
}

test("brief disconnect invalidates selected execution evidence while preserving only price history", t => {
  // Only model eligibility is synthetic; market readiness and execution paths remain real.
  t.mock.method(ConditionalDistributionModel.prototype, "estimate", (_symbol: string, actionId: string): DistributionEstimate => ({
    actionId, samples: 60, effectiveSamples: 55, observedDays: 8, meanNetBps: 25, lowerMeanNetBps: 20,
    scoreBps: actionId === "long-5m" ? 20 : 15, tailLossBps: 0, fillProbability: 1,
    eligible: true, reason: "POSITIVE_DISTRIBUTIONAL_SCORE",
  }));
  const controller = warmController();
  assert.equal(controller.stats(READY).pendingSelected, 1);
  controller.invalidate(READY + 500, "PUBLIC_STREAM_DOWN");
  const selections = controller.drainSelections();
  assert.equal(selections.length, 1); assert.equal(selections[0]!.valid, false);
  assert.ok(selections[0]!.sample.outcomes.every(outcome => outcome.status === "INVALID"));
  assert.equal(controller.stats(READY + 500).pendingSelected, 0);
  assert.equal(controller.stats(READY + 500).validation.selections, 0);
  assert.equal(controller.stats(READY + 500).learning.acceptedSamples, 0);
  assert.equal(controller.exportMarketHistory().symbols.length, 2);
  assert.equal(controller.onBook(book(READY + 1_000)).decision, null);
});

test("raw replay public disconnect recovery matches direct live-controller decisions", async () => {
  const events: RecordedEvent[] = [];
  const appendPair = (atMs: number): void => {
    for (const symbol of S.symbols) {
      const quote = book(atMs, symbol);
      events.push({ kind: "BOOK", delta: { symbol, bids: quote.bids, asks: quote.asks,
        receiveTsMs: atMs, exchangeTsMs: atMs, reset: true, sourceId: `${symbol}:${atMs}` } });
    }
  };
  for (let atMs = START; atMs <= END; atMs += 1_000) appendPair(atMs);
  events.push({ kind: "DISCONNECT", stream: "public", receiveTsMs: END + 500 });
  for (let atMs = END + 2_000; atMs <= END + 32_000; atMs += 1_000) appendPair(atMs);
  const direct = new DistributionController(costs, { ...assets });
  const liveDecisions: Array<{ symbol: string; atMs: number; reason: string; features: number[] }> = [];
  for (const event of events) {
    if (event.kind === "DISCONNECT") direct.invalidate(event.receiveTsMs, "PUBLIC_STREAM_DOWN");
    if (event.kind === "BOOK") {
      const { decision } = direct.onBook(book(event.delta.receiveTsMs, event.delta.symbol));
      if (decision) liveDecisions.push({ symbol: decision.symbol, atMs: decision.atMs,
        reason: decision.reason, features: decision.features });
    }
  }
  const report = await replayDistribution(events, costs, assets,
    { validationStartMs: START, laterStartMs: END + 60_000, includeOutcomes: true });
  assert.equal(report.quality.disconnects, 1);
  assert.equal(report.quality.invalidBooks, 0);
  assert.deepEqual(report.decisions!.map(({ symbol, atMs, reason, features }) => ({ symbol, atMs, reason, features })), liveDecisions);
  assert.deepEqual(liveDecisions.filter(row => row.atMs > END).map(row => [row.symbol, row.atMs]),
    S.symbols.map(symbol => [symbol, END + 32_000]));
  assert.equal(report.trainingDecisions!.length, 2, "recovery does not restart the independent training schedule");
  assert.equal(report.samples!.length, 12);
  assert.ok(report.samples!.every(sample => sample.outcomes.every(outcome => outcome.status === "INVALID")));
});
