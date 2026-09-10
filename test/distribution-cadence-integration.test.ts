import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { loadConfig, type SymbolConfig } from "../src/config.js";
import type { BookState } from "../src/core/market.js";
import type { BookDelta } from "../src/core/order-book.js";
import { DistributionController, type SelectedPolicyOutcome } from "../src/distribution/controller.js";
import { DistributionMarket } from "../src/distribution/market.js";
import { ConditionalDistributionModel } from "../src/distribution/model.js";
import { DISTRIBUTION_SPEC as S, DISTRIBUTION_ENTRY_PROFILES, type DistributionDecision, type DistributionEstimate } from "../src/distribution/spec.js";
import { createDistributionSizingPolicy } from "../src/distribution/sizing.js";
import { TradingEngine } from "../src/engine/trading-engine.js";
import type { AssetRules, ExecutionPlan } from "../src/execution/planner.js";
import { KrakenPaperBroker } from "../src/kraken/paper-broker.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";
import type { VenueOrder } from "../src/venue/types.js";

const cfg = loadConfig({ DISTRIBUTIONAL_SIZING_MODE: "LEGACY_FIXED", TRADING_MODE: "paper", CONFIG_DIR: "config", DISTRIBUTIONAL_ENGINE_ENABLED: "true",
  DISTRIBUTIONAL_PAPER_ENTRIES_ENABLED: "true", CONTINUOUS_RECORDING_ENABLED: "false" });
const asset = (symbol: string): AssetRules => ({ symbol, minOrderSize: .001, minTradeIncrement: .001,
  priceIncrement: .001, maximumOrderQty: 100, shortable: true });
function features(b: BookState): DeterministicFeatures {
  const mid = (b.bids[0]!.px + b.asks[0]!.px) / 2;
  const pullback = { ready: false, structuralMoveBps: 100, pullbackDepthBps: 40, recoveryBps: 8,
    remainingRoomBps: 40, structuralExtremeAgeMs: 600_000, reversalExtremeAgeMs: 10_000 };
  return { symbol: b.symbol, mid, spread: .01, spreadBps: .01 / mid * 10_000, microprice: mid, visibleDepth: 20,
    qi1: .5, qiK: .5, persistentQiK: .5, ofi: 1, tfi: 1, bidCancellationRatio: 0, askCancellationRatio: 0,
    replenishmentPressure: 0, velocity: 0, acceleration: 0, varianceRate: 1e-8, sigmaHBps: 1,
    microEdgeZ: 0, velocityZ: 1, accelerationZ: 0, efficiency: .8, cusumUp: true, cusumDown: false,
    spreadZ: 0, depthZ: 0, signalFlipRate: 0, providerAgeMs: 0, staleThresholdMs: 1_000,
    warmedUp: true, kinematicsReady: true, stale: false, staleReason: null, receiveTsMs: b.receiveTsMs,
    microEdgeBps: 1, impulseBps: 2, breakoutUpBps: 2, breakoutDownBps: 0, anchorDistanceBps: 0,
    sigmaImpulseBps: 1, cusumUpScore: 1, cusumDownScore: 1, flowFlipRate: 0,
    usableDepthQty: 20, usableDepthNotional: 2_000, slowTrendReady: true,
    trendFastBps: 10, trendMediumBps: 20, trendSlowBps: 40, slowTrendAlignment: 1,
    slowTrendEfficiency: .6, slowVarianceRate: 1e-8, slowSigmaBps: 10,
    longPullback: { ...pullback }, shortPullback: { ...pullback } };
}
interface Runtime {
  config: SymbolConfig; asset: AssetRules; latestFeatures: DeterministicFeatures;
  book: { apply: (delta: BookDelta) => void; snapshot: () => BookState };
  liquidity: { observe: (spread: number) => void };
  entryEngine: { evaluate: () => never };
}
interface Internals {
  equity: number; equityHighWater: number; distributional: DistributionController;
  riskState: { setHealth: (value: Record<string, boolean>) => void };
  runtimes: Map<string, Runtime>;
  processMarketState: (runtime: Runtime, book: BookState, features: DeterministicFeatures, quoteEvent?: boolean) => void;
  attemptPolicyEntry: () => void;
}

// Synthetic market readiness and positive evidence isolate scheduling/routing.
// They are not fitted market results or evidence of profitable trading. The
// controller, execution paths, planner, risk and order reservation remain real.
function fixture(t: TestContext, paperEnabled = true, trialEnabled = false, realPaperBroker = false, selectedAction = "long-5m", riskSizing = false) {
  let nowMs = Date.now(), supported = false;
  t.mock.method(DistributionMarket.prototype, "onBook", (b: BookState) => ({ symbol: b.symbol,
    atMs: b.receiveTsMs, ready: true, reason: "READY", features: Array<number>(S.featureDimension).fill(0) }));
  t.mock.method(ConditionalDistributionModel.prototype, "estimate", (_symbol: string, actionId: string): DistributionEstimate => {
    const eligible = supported && actionId === selectedAction;
    return { actionId, samples: 100, effectiveSamples: 80, observedDays: trialEnabled ? 3 : 8, meanNetBps: eligible ? 40 : 0,
      lowerMeanNetBps: eligible ? 31 : -10, tailLossBps: 10, scoreBps: eligible ? 30 : -11,
      fillProbability: .9, eligible, reason: eligible ? "POSITIVE_DISTRIBUTIONAL_SCORE" : "SCORE_BELOW_MINIMUM" };
  });
  const broker = new KrakenPaperBroker({ initialEquity: 100_000,
    productsBySymbol: { "BTC/USD": "BTC", "ETH/USD": "ETH" },
    instruments: new Map(S.symbols.map(symbol => [symbol, { symbol, productId: symbol, tickSize: .001,
      quantityIncrement: .001, maximumOrderQty: 100 }])),
    makerFeeBpsBySymbol: { "BTC/USD": 2, "ETH/USD": 2 }, takerFeeBpsBySymbol: { "BTC/USD": 5, "ETH/USD": 5 } });
  // Most cadence tests stop at dispatch. The trial lifecycle test delegates to
  // the real local paper broker and observes its fills and fees in memory.
  const send = broker.send.bind(broker);
  const sent = t.mock.method(broker, "send", async (plan: ExecutionPlan): Promise<VenueOrder> => realPaperBroker ? send(plan) : ({
    id: "cadence-mocked-order", client_order_id: plan.clientOrderId, asset_id: plan.symbol, symbol: plan.symbol,
    asset_class: "crypto", qty: String(plan.qty), notional: null, filled_qty: "0", filled_avg_price: null,
    order_class: "simple", order_type: "limit", type: "limit", side: plan.side === 1 ? "buy" : "sell",
    time_in_force: "ioc", limit_price: String(plan.limitPx), stop_price: null, status: "new",
    created_at: new Date(nowMs).toISOString(), updated_at: new Date(nowMs).toISOString(), submitted_at: null,
    filled_at: null, canceled_at: null, failed_at: null, replaced_at: null, replaced_by: null, replaces: null,
  }));
  const engine = new TradingEngine({ ...cfg, ...(riskSizing ? { distributionalSizingPolicy: createDistributionSizingPolicy(cfg.symbolConfigs, 1000, .01) } : {}), distributionalPaperEntriesEnabled: paperEnabled, distributionalPaperTrialEnabled: trialEnabled },
    { rest: broker, gateway: broker, tradeStream: broker.tradeStream, now: () => nowMs });
  const internals = engine as unknown as Internals;
  internals.equity = internals.equityHighWater = 100_000;
  internals.riskState.setHealth({ publicStream: true, privateStream: true, accountReconciled: true,
    bookValid: true, riskRecomputed: true });
  t.mock.method(internals.distributional as unknown as { validation: () => DistributionDecision["validation"] },
    "validation", () => trialEnabled ? { selections: 0, observedDays: 0, lowerNetBps: null, ready: false }
      : { selections: 30, observedDays: 8, lowerNetBps: 5, ready: true });
  t.mock.method(internals, "attemptPolicyEntry", () => { throw new Error("Legacy policy route ran"); });
  const update = (symbol = "BTC/USD", mid = 100) => {
    const runtime = internals.runtimes.get(symbol)!;
    const delta = { symbol, bids: [{ px: mid - .005, qty: 100 }], asks: [{ px: mid + .005, qty: 100 }],
      reset: true, exchangeTsMs: nowMs, receiveTsMs: nowMs, sourceId: `cadence-${symbol}-${nowMs}` };
    runtime.book.apply(delta); broker.onBook(delta);
    const book = runtime.book.snapshot(); runtime.latestFeatures = features(book); return book;
  };
  for (const [symbol, runtime] of internals.runtimes) {
    runtime.asset = asset(symbol); update(symbol);
    for (let i = 0; i <= cfg.dynamicLiquidity.minimumSamples; i++) runtime.liquidity.observe(1);
    runtime.entryEngine.evaluate = () => { throw new Error("Legacy deterministic route ran"); };
  }
  const tick = (advanceMs: number, quoteEvent = true, symbol = "BTC/USD", mid = 100) => {
    nowMs += advanceMs;
    const runtime = internals.runtimes.get(symbol)!, book = update(symbol, mid);
    internals.processMarketState(runtime, book, features(book), quoteEvent);
  };
  return { engine, broker, internals, sent, tick, now: () => nowMs, support: () => { supported = true; } };
}

test("actual controller routes an eligible one-second entry while the 31-minute training panel is pending", async t => {
  const f = fixture(t), decisions: DistributionDecision[] = [], plans: ExecutionPlan[] = [];
  f.engine.on("distributionalDecision", (d: DistributionDecision) => decisions.push(d));
  f.engine.on("decision", (value: { plan: ExecutionPlan }) => plans.push(value.plan));
  try {
    const start = f.now(); f.tick(0);
    assert.equal(decisions.length, 1); assert.equal(decisions[0]!.actionId, null);
    assert.equal(f.internals.distributional.stats(f.now()).pendingPanels, 1);
    f.support(); f.tick(500);
    assert.equal(decisions.length, 1); assert.equal(f.sent.mock.callCount(), 0);
    f.tick(500, false);
    assert.equal(decisions.length, 1, "a trade/periodic update cannot authorize entry");
    f.tick(0);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(decisions.length, 2); assert.equal(decisions[1]!.atMs - start, S.evaluationIntervalMs);
    assert.equal(decisions[1]!.selectionPolicyVersion, S.selectionPolicyVersion);
    assert.equal(decisions[1]!.paperReady, true); assert.equal(decisions[1]!.actionId, "long-5m");
    assert.equal(plans.length, 1); assert.equal(f.sent.mock.callCount(), 1);
    assert.equal(plans[0]!.createdMs - start, 1_000);
    assert.ok(plans[0]!.createdMs < start + S.proposalIntervalMs);
    const stats = f.internals.distributional.stats(f.now());
    assert.equal(stats.proposals, 1); assert.equal(stats.pendingPanels, 1); assert.equal(stats.pendingSelected, 1);
    assert.equal(stats.learning.acceptedSamples, 0, "incomplete training outcomes remain excluded");
    assert.equal(stats.nextProposals["BTC/USD"], start + S.proposalIntervalMs);
    assert.equal(stats.nextEvaluations["BTC/USD"], start + 2_000);
    const state = f.engine.exportDistributionalState()!;
    assert.equal(state.pendingSelections.length, 1); assert.equal(state.selectionPolicyVersion, S.selectionPolicyVersion);
  } finally { await f.engine.stop(); }
});

test("selected outcomes emit an engine checkpoint before an unrelated long training action completes", async t => {
  const f = fixture(t, false), selections: SelectedPolicyOutcome[] = [];
  let checkpoints = 0, trainingSamples = 0;
  f.engine.on("distributionalSelection", (row: SelectedPolicyOutcome) => selections.push(row));
  f.engine.on("distributionalCheckpoint", () => { checkpoints++; });
  f.engine.on("distributionalSample", () => { trainingSamples++; });
  try {
    f.tick(0); f.support(); f.tick(1_000);
    for (let i = 0; i < 305 && !selections.length; i++) f.tick(1_000);
    assert.equal(selections.length, 1); assert.equal(selections[0]!.valid, true);
    assert.equal(selections[0]!.sample.actionId, "long-5m");
    assert.equal(selections[0]!.sample.outcomes.length, 3);
    assert.ok(selections[0]!.sample.outcomes.every(outcome => outcome.status === "FILLED"));
    assert.equal(trainingSamples, 0); assert.equal(checkpoints, 1);
    const stats = f.internals.distributional.stats(f.now());
    assert.equal(stats.pendingPanels, 1); assert.equal(stats.pendingSelected, 0);
    assert.equal(stats.learning.acceptedSamples, 0);
    const state = f.engine.exportDistributionalState()!;
    assert.equal(state.validationSelections.length, 1); assert.equal(state.samples.length, 0);
    assert.equal(state.pendingSelections.length, 0);
    assert.deepEqual(state.validationSelections[0]!.sample, selections[0]!.sample);
    assert.equal(f.sent.mock.callCount(), 0, "paper permission stays independently enforced");
  } finally { await f.engine.stop(); }
});

test("opted-in three-date paper trial reaches dispatch without claiming prospective validation", async t => {
  const f = fixture(t, true, true), plans: ExecutionPlan[] = [];
  f.engine.on("decision", (row: { plan: ExecutionPlan }) => plans.push(row.plan));
  try {
    f.tick(0); f.support(); f.tick(1_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(f.sent.mock.callCount(), 1);
    const d = plans[0]!.distributionDecision!;
    assert.equal(d.entryMode, "PAPER_TRIAL");
    assert.equal(d.selectionPolicyVersion, DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL.selectionPolicyVersion);
    assert.equal(d.paperReady, true); assert.equal(d.validation.ready, false);
    assert.equal(d.validation.selections, 0); assert.equal(d.estimates[0]!.observedDays, 3);
    assert.ok(plans[0]!.qty * plans[0]!.limitPx <= S.maximumNotional);
  } finally { await f.engine.stop(); }
});

test("three-date trial still requires the separate paper-order permission", async t => {
  const f = fixture(t, false, true);
  try {
    f.tick(0); f.support(); f.tick(1_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(f.internals.distributional.currentDecision("BTC/USD")!.entryMode, "PAPER_TRIAL");
    assert.equal(f.sent.mock.callCount(), 0);
  } finally { await f.engine.stop(); }
});

for (const riskSizing of [false, true]) for (const [symbol, action, stopMid] of [["BTC/USD", "long-5m", 99], ["ETH/USD", "short-5m", 101]] as const) {
  test(`three-date trial submits, fills and closes ${symbol} through the real local paper broker (${riskSizing ? "risk-bounded" : "$12 legacy"})`, async t => {
    const f = fixture(t, true, true, true, action, riskSizing), errors: unknown[] = [];
    f.engine.on("engineError", error => errors.push(error));
    const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
    try {
      f.tick(0, true, symbol); f.support(); f.tick(1_000, true, symbol); await flush();
      let orders = (await f.broker.listOrders()).data;
      assert.equal(orders.length, 1); assert.equal(orders[0]!.status, "new");
      const entry = f.sent.mock.calls[0]!.arguments[0];
      assert.equal(entry.distributionDecision!.entryMode, "PAPER_TRIAL");
      assert.equal(entry.distributionDecision!.validation.ready, false);
      assert.equal(entry.distributionDecision!.validation.selections, 0);
      assert.equal(entry.distributionDecision!.estimates.find(e => e.actionId === action)!.observedDays, 3);
      assert.ok(entry.qty * entry.limitPx <= (riskSizing ? 1000 : S.maximumNotional));
      if (riskSizing) assert.ok(entry.qty * entry.limitPx > 12);
      assert.equal(entry.qty, entry.distributionDecision!.requestedQty);
      assert.equal((await f.broker.listPositions()).data.length, 0, "the decision quote cannot fill a delayed IOC");
      f.tick(250, true, symbol); await flush();
      orders = (await f.broker.listOrders()).data;
      assert.equal(orders[0]!.status, "filled");
      assert.equal(Number(orders[0]!.filled_qty), entry.qty);
      assert.equal((await f.broker.listPositions()).data.length, 1);
      assert.equal(f.engine.state().positions.length, 1, "the engine reconciles the private fill event");
      assert.ok(Number((await f.broker.getAccount()).data.equity) < 100_000, "entry fee and spread affect paper equity");
      assert.equal(f.sent.mock.callCount(), 1, "the open position prevents another entry");

      // A deliberately adverse synthetic quote exercises the protective exit.
      // This verifies execution, not strategy profitability on market data.
      f.tick(250, true, symbol, stopMid); await flush();
      assert.equal(f.sent.mock.callCount(), 2);
      assert.equal(f.sent.mock.calls[1]!.arguments[0].reduceOnlyIntent, true);
      f.tick(250, true, symbol, stopMid); await flush();
      orders = (await f.broker.listOrders()).data;
      assert.equal(orders.length, 2); assert.ok(orders.every(order => order.status === "filled"));
      assert.equal((await f.broker.listPositions()).data.length, 0);
      assert.equal(f.engine.state().positions.length, 0);
      assert.ok(Number((await f.broker.getAccount()).data.equity) < 100_000);
      assert.deepEqual(errors, []);
    } finally { await f.engine.stop(); }
  });
}
