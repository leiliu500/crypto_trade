import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { loadConfig, type EngineConfig, type SymbolConfig } from "../src/config.js";
import type { BookState } from "../src/core/market.js";
import type { AssetRules, ExecutionPlan } from "../src/execution/planner.js";
import type { OrderStateReconciler, PrivateOrderEvent } from "../src/execution/order-state.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";
import type { Position } from "../src/strategy/position-manager.js";
import { TradingEngine } from "../src/engine/trading-engine.js";
import { KrakenPaperBroker } from "../src/kraken/paper-broker.js";
import { DistributionController } from "../src/distribution/controller.js";
import { buildDistributionPlan, executableDistributionDecision } from "../src/distribution/planner.js";
import { DISTRIBUTION_SPEC as S, DISTRIBUTION_ACTIONS, type DistributionDecision } from "../src/distribution/spec.js";
import { policyReserveBps } from "../src/research/policy-planner.js";
import { policyQuantity, POLICY_VERSION } from "../src/research/trading-policy.js";

const cfg = loadConfig({ TRADING_MODE: "paper", CONFIG_DIR: "config", DISTRIBUTIONAL_ENGINE_ENABLED: "true",
  DISTRIBUTIONAL_PAPER_ENTRIES_ENABLED: "true", CONTINUOUS_RECORDING_ENABLED: "false" });
const asset = (symbol = "BTC/USD"): AssetRules => ({ symbol, minOrderSize: .001, minTradeIncrement: .001,
  priceIncrement: .001, maximumOrderQty: 100, shortable: true });
function book(atMs: number, symbol = "BTC/USD", mid = 100): BookState {
  return { symbol, bids: [{ px: mid - .005, qty: 100 }], asks: [{ px: mid + .005, qty: 100 }],
    exchangeTsMs: atMs, receiveTsMs: atMs, sequence: BigInt(atMs), sourceReset: false, valid: true };
}
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
// Synthetic evidence exercises the authorization contract; it is not a claim
// that market data has produced a profitable model or validation cohort.
function decision(b: BookState, side: 1 | -1 = 1, config = cfg.symbolConfigs[b.symbol]!): DistributionDecision {
  const actionId = `${side === 1 ? "long" : "short"}-15m`;
  return { version: S.version, selectionPolicyVersion: S.selectionPolicyVersion,
    symbol: b.symbol, atMs: b.receiveTsMs, quoteSequence: String(b.sequence),
    referenceBid: b.bids[0]!.px, referenceAsk: b.asks[0]!.px, requestedQty: policyQuantity(b.asks[0]!.px, asset(b.symbol)),
    feeBps: config.cost.takerFeeBps, reserveBps: policyReserveBps(config), features: Array<number>(12).fill(0),
    estimates: [{ actionId, samples: 100, effectiveSamples: 80, observedDays: 8,
      meanNetBps: 40, lowerMeanNetBps: 31, tailLossBps: 10, scoreBps: 30,
      fillProbability: .9, reason: "POSITIVE_DISTRIBUTIONAL_SCORE", eligible: true },
    ...DISTRIBUTION_ACTIONS.filter(a => a.id !== actionId).map(a => ({ actionId: a.id,
      samples: 100, effectiveSamples: 80, observedDays: 8, meanNetBps: 0, lowerMeanNetBps: -10,
      tailLossBps: 10, scoreBps: -11, fillProbability: .9, reason: "SCORE_BELOW_MINIMUM", eligible: false }))],
    actionId, reason: "VALIDATED_NET_RETURN", paperReady: true,
    validation: { selections: 30, observedDays: 8, lowerNetBps: 5, ready: true } };
}
function planInput(b = book(1_000_000), side: 1 | -1 = 1) {
  return { config: cfg.symbolConfigs[b.symbol]!, book: b, features: features(b), asset: asset(b.symbol),
    decision: decision(b, side), paperAllowed: true, equity: 100_000, equityHighWater: 100_000, nowMs: b.receiveTsMs };
}

for (const symbol of S.symbols) for (const side of [1, -1] as const) {
  test(`distribution planner ${symbol} ${side} preserves executable net targets, exact size and risk limits`, () => {
    const input = planInput(book(1_000_000, symbol), side), { plan, reason } = buildDistributionPlan(input);
    assert.ok(plan, reason); assert.equal(plan.side, side); assert.equal(plan.style, "taker");
    assert.equal(plan.timeInForce, "ioc"); assert.equal(plan.researchOnly, true);
    assert.equal(plan.modelVersion, S.version); assert.equal(plan.qty, input.decision.requestedQty);
    assert.equal(plan.limitPx, side === 1 ? input.book.asks[0]!.px : input.book.bids[0]!.px);
    assert.equal(plan.policy?.id, "distribution-15m"); assert.equal(plan.economicHorizonMs, 900_000);
    assert.equal(plan.expiresMs, input.decision.atMs + S.maximumQuoteAgeMs);
    assert.ok(plan.qty * plan.limitPx <= S.maximumNotional);
    assert.ok(plan.risk.modeledMaximumLoss <= plan.risk.riskBudget);
    assert.equal(plan.conservativeNetEdgeBps, input.decision.estimates[0]!.scoreBps);
    assert.ok(Math.abs(plan.expectedValue - plan.qty * plan.limitPx * 40 / 10_000) < 1e-12,
      "the empirical net target is not charged fees a second time");
    input.decision.estimates[0]!.scoreBps = -100;
    assert.equal(plan.distributionDecision!.estimates[0]!.scoreBps, 30, "plan evidence is frozen by copy");
  });
}

test("distribution plans require fresh exact quote evidence and finite validated model dimensions", () => {
  const input = planInput();
  const corruptions: Array<(d: DistributionDecision) => void> = [
    d => { d.version = "legacy-model"; }, d => { d.symbol = "ETH/USD"; },
    d => { d.quoteSequence = "old"; }, d => { d.atMs--; },
    d => { d.referenceAsk += .01; }, d => { d.referenceBid -= .01; },
    d => { d.requestedQty = 1; }, d => { d.paperReady = false; },
    d => { d.validation.ready = false; }, d => { d.validation.selections = 19; },
    d => { d.validation.observedDays = 6; }, d => { d.validation.lowerNetBps = 0; },
    d => { d.validation.selections = Infinity; }, d => { d.validation.observedDays = NaN; },
    d => { d.estimates[0]!.samples = NaN; }, d => { d.estimates[0]!.effectiveSamples = Infinity; },
    d => { d.estimates[0]!.observedDays = Infinity; }, d => { d.estimates[0]!.eligible = false; },
    d => { d.estimates[0]!.lowerMeanNetBps = 41; }, d => { d.estimates[0]!.scoreBps = 35; },
    d => { d.estimates[0]!.tailLossBps = -1; }, d => { d.estimates[0]!.fillProbability = 1.1; },
    d => { d.features[0] = Infinity; }, d => { d.features.pop(); },
  ];
  for (const corrupt of corruptions) {
    const changed = structuredClone(input.decision); corrupt(changed);
    assert.equal(buildDistributionPlan({ ...input, decision: changed }).plan, null, corrupt.toString());
  }
  assert.equal(executableDistributionDecision(input.decision, input.book, input.nowMs + 1001), null);
  assert.equal(executableDistributionDecision(input.decision, input.book, input.nowMs - 1), null);
  assert.equal(buildDistributionPlan({ ...input, book: { ...input.book, valid: false } }).plan, null);
  assert.equal(buildDistributionPlan({ ...input, features: { ...input.features, mid: 101 } }).reason, "DISTRIBUTION_QUOTE_INVALID");
  assert.equal(buildDistributionPlan({ ...input, features: { ...input.features, stale: true } }).plan, null);
});

test("distribution planning rechecks fees, exact quantity, venue permission, risk and paper permission", () => {
  const input = planInput();
  assert.equal(buildDistributionPlan({ ...input, paperAllowed: false }).plan, null);
  for (const config of [
    { ...input.config, cost: { ...input.config.cost, takerFeeBps: input.config.cost.takerFeeBps + 1 } },
    { ...input.config, cost: { ...input.config.cost, positiveCostErrorP95Bps: 100 } },
  ]) assert.equal(buildDistributionPlan({ ...input, config }).reason, "DISTRIBUTION_COST_CONFIGURATION_CHANGED");
  for (const patch of [
    { equity: 1 }, { equity: 50_000 },
    { config: { ...input.config, maximumNotional: 1 } },
    { asset: { ...input.asset, maximumOrderQty: .01 } },
    { book: { ...input.book, asks: [{ px: input.book.asks[0]!.px, qty: .01 }] } },
    { config: { ...input.config, planner: { ...input.config.planner, minimumRewardRiskRatio: 100 } } },
    { config: { ...input.config, planner: { ...input.config.planner, minimumExpectedValueBps: 100 } } },
  ]) assert.equal(buildDistributionPlan({ ...input, ...patch }).plan, null);
  const short = planInput(input.book, -1);
  assert.equal(buildDistributionPlan({ ...short, asset: { ...short.asset, shortable: false } }).plan, null);
});

interface Runtime {
  config: SymbolConfig; asset: AssetRules; latestFeatures: DeterministicFeatures; position?: Position;
  book: { apply: (delta: unknown) => void; snapshot: () => BookState }; liquidity: { observe: (spread: number) => void };
  entryEngine: { evaluate: () => never };
}
interface Internals {
  equity: number; equityHighWater: number; distributional: DistributionController;
  riskState: { setHealth: (value: Record<string, boolean>) => void };
  portfolio: { canAdd: (...args: unknown[]) => boolean };
  runtimes: Map<string, Runtime>;
  processMarketState: (runtime: Runtime, b: BookState, f: DeterministicFeatures, quoteEvent?: boolean) => void;
  attemptPolicyEntry: () => void; attemptDistributionalEntry: () => void;
  managePosition: (runtime: Runtime, b: BookState, f: DeterministicFeatures) => void;
  evaluatePosition: (runtime: Runtime, b: BookState, f: DeterministicFeatures) => { nowMs: number; decision: { action: string; reason?: string } };
  orderState: OrderStateReconciler; onPrivateEvent: (event: PrivateOrderEvent) => void;
  submit: (plan: ExecutionPlan) => Promise<boolean>;
}
function fixture(t: TestContext, patch: Partial<EngineConfig> = {}) {
  let nowMs = Date.now();
  const broker = new KrakenPaperBroker({ initialEquity: 100_000,
    productsBySymbol: { "BTC/USD": "BTC", "ETH/USD": "ETH" },
    instruments: new Map(S.symbols.map(symbol => [symbol, { symbol, productId: symbol, tickSize: .001,
      quantityIncrement: .001, maximumOrderQty: 100 }])),
    makerFeeBpsBySymbol: { "BTC/USD": 2, "ETH/USD": 2 }, takerFeeBpsBySymbol: { "BTC/USD": 5, "ETH/USD": 5 } });
  const engine = new TradingEngine({ ...cfg, ...patch }, { rest: broker, gateway: broker, tradeStream: broker.tradeStream, now: () => nowMs });
  const internals = engine as unknown as Internals;
  internals.equity = internals.equityHighWater = 100_000;
  internals.riskState.setHealth({ publicStream: true, privateStream: true, accountReconciled: true, bookValid: true, riskRecomputed: true });
  const quotes = new Map<string, BookState>();
  const update = (symbol = "BTC/USD", mid = 100) => {
    const runtime = internals.runtimes.get(symbol)!, b = book(nowMs, symbol, mid);
    const delta = { symbol, bids: [...b.bids], asks: [...b.asks], reset: true, exchangeTsMs: nowMs, receiveTsMs: nowMs,
      sourceId: `integration-${symbol}-${nowMs}` };
    runtime.book.apply(delta); broker.onBook(delta);
    const actual = runtime.book.snapshot(); runtime.latestFeatures = features(actual); quotes.set(symbol, actual);
    return actual;
  };
  for (const [symbol, runtime] of internals.runtimes) {
    runtime.asset = asset(symbol); update(symbol);
    for (let i = 0; i <= cfg.dynamicLiquidity.minimumSamples; i++) runtime.liquidity.observe(1);
    runtime.entryEngine.evaluate = () => { throw new Error("Legacy deterministic entry route ran"); };
  }
  t.mock.method(internals, "attemptPolicyEntry", () => { throw new Error("Legacy policy entry route ran"); });
  t.mock.method(internals.distributional, "onBook", () => ({ decision: null, samples: [] }));
  let current: DistributionDecision | null = decision(quotes.get("BTC/USD")!);
  t.mock.method(internals.distributional, "currentDecision", (symbol: string) => current?.symbol === symbol ? structuredClone(current) : null);
  const sent = t.mock.method(broker, "send");
  return { engine, internals, broker, sent, update, quotes,
    setDecision: (value: DistributionDecision | null) => { current = value; },
    advance: (ms: number) => { nowMs += ms; }, now: () => nowMs };
}

test("the enabled distribution engine owns entry routing and requires quote, health and paper authorization", async t => {
  const f = fixture(t), runtime = f.internals.runtimes.get("BTC/USD")!, b = f.quotes.get("BTC/USD")!;
  const reasons: string[] = [], plans: ExecutionPlan[] = [];
  f.engine.on("policyEntryEvaluated", (value: { reason: string }) => reasons.push(value.reason));
  f.engine.on("decision", (value: { plan: ExecutionPlan }) => plans.push(value.plan));
  try {
    f.internals.processMarketState(runtime, b, features(b), false);
    assert.equal(plans.length, 0, "trade events cannot authorize a new entry");
    f.setDecision({ ...decision(b), paperReady: false });
    f.internals.processMarketState(runtime, b, features(b));
    assert.equal(plans.length, 0); assert.equal(reasons.at(-1), "DISTRIBUTION_NOT_VALIDATED");
    f.setDecision(decision(b)); f.internals.riskState.setHealth({ privateStream: false });
    f.internals.processMarketState(runtime, b, features(b));
    assert.equal(reasons.at(-1), "DISTRIBUTION_HEALTH_BLOCK");
    f.internals.riskState.setHealth({ privateStream: true });
    f.internals.processMarketState(runtime, b, features(b));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(plans.length, 1); assert.equal(f.sent.mock.callCount(), 1);
    assert.equal(plans[0]!.modelVersion, S.version);
    assert.equal(f.engine.state().crossAssetPaperEntriesEnabled, false);
    assert.equal(await f.internals.submit({ ...plans[0]!, clientOrderId: "duplicate-selected-exposure" }), false,
      "the final guard cannot reserve the same portfolio slot twice");
    assert.equal(f.sent.mock.callCount(), 1);
  } finally { await f.engine.stop(); }
});

test("dispatch independently rejects forged economics, stale decisions and disabled paper authorization", async t => {
  const f = fixture(t), b = f.quotes.get("BTC/USD")!, runtime = f.internals.runtimes.get("BTC/USD")!;
  const input = planInput(b), valid = buildDistributionPlan(input).plan!;
  assert.ok(valid);
  const mutations: Array<(plan: ExecutionPlan) => void> = [
    p => { p.limitPx = 1_000_000; }, p => { p.style = "maker"; }, p => { p.timeInForce = "gtc"; },
    p => { p.qty += .001; }, p => { p.side = -1; }, p => { p.expiresMs += 1; },
    p => { p.economicHorizonMs = 60_000; }, p => { p.policy!.feeBps += 1; },
    p => { p.policy!.reserveBps += 1; }, p => { p.policy!.id = "trend-15m"; },
    p => { p.configurationVersion = "unrelated"; }, p => { p.distributionDecision!.estimates[0]!.scoreBps = 100; },
    p => { p.risk.modeledMaximumLoss = 0; }, p => { p.researchOnly = false; },
    p => { p.featureHash = "forged"; }, p => { p.originatingSequence += 1n; },
    p => { delete p.distributionDecision!.selectionPolicyVersion; },
    p => { p.distributionDecision!.selectionPolicyVersion = "legacy-cadence"; },
  ];
  try {
    for (const mutate of mutations) {
      const changed = structuredClone(valid); mutate(changed);
      assert.equal(await f.internals.submit(changed), false, mutate.toString());
    }
    f.setDecision({ ...decision(b), reason: "CHANGED_DECISION" });
    assert.equal(await f.internals.submit(valid), false, "current controller evidence must equal the frozen plan");
    f.setDecision(decision(b));
    runtime.config = { ...runtime.config, cost: { ...runtime.config.cost, takerFeeBps: runtime.config.cost.takerFeeBps + 1 } };
    assert.equal(await f.internals.submit(valid), false, "dispatch rechecks the current fee schedule");
    runtime.config = input.config;
    f.internals.riskState.setHealth({ privateStream: false });
    assert.equal(await f.internals.submit(valid), false, "health is rechecked at the gateway boundary");
    f.internals.riskState.setHealth({ privateStream: true });
    const capacity = t.mock.method(f.internals.portfolio, "canAdd", () => false);
    assert.equal(await f.internals.submit(valid), false, "portfolio capacity is rechecked at dispatch");
    capacity.mock.restore();
    runtime.config = { ...runtime.config, planner: { ...runtime.config.planner,
      hybridEntry: { ...runtime.config.planner.hybridEntry, allowAnalyticPaperExecution: false } } };
    assert.equal(await f.internals.submit(valid), false);
    runtime.config = input.config;
    f.advance(1001); assert.equal(await f.internals.submit(valid), false);
    assert.equal(f.sent.mock.callCount(), 0, "rejected evidence must never reach the gateway");
  } finally { await f.engine.stop(); }
});

for (const patch of [{ distributionalPaperEntriesEnabled: false }, { mode: "shadow" as const }, { paper: false }]) {
  test(`distribution dispatch stays disabled for ${JSON.stringify(patch)}`, async t => {
    const f = fixture(t, patch), valid = buildDistributionPlan(planInput(f.quotes.get("BTC/USD")!)).plan!;
    try {
      assert.equal(await f.internals.submit(valid), false); assert.equal(f.sent.mock.callCount(), 0);
    } finally { await f.engine.stop(); }
  });
}

test("distribution entry readiness cannot interfere with management of an existing position", async t => {
  const f = fixture(t), runtime = f.internals.runtimes.get("BTC/USD")!, b = f.quotes.get("BTC/USD")!;
  runtime.position = { symbol: "BTC/USD", side: 1, qty: .1, entryPx: 100, openedMs: b.receiveTsMs - 60_000,
    initialRiskPx: 1, roundTripCostPx: .1, mfePx: 0, maePx: 0, floorPx: -1,
    breakEvenArmed: false, phase: "OPEN", executionPath: "TAKER_TAKER",
    policy: { version: POLICY_VERSION, id: "trend-15m", feeBps: 5, reserveBps: 2 } };
  const managed = t.mock.method(f.internals, "managePosition", () => {});
  const entries = t.mock.method(f.internals, "attemptDistributionalEntry", () => { throw new Error("An existing position attempted a new entry"); });
  f.setDecision(null);
  try {
    f.internals.processMarketState(runtime, b, features(b));
    assert.equal(managed.mock.callCount(), 1); assert.equal(entries.mock.callCount(), 0);
  } finally { delete runtime.position; await f.engine.stop(); }
});

test("reduce-only closes of existing positions remain executable with distribution entries disabled", async t => {
  const f = fixture(t, { distributionalPaperEntriesEnabled: false }), b = f.quotes.get("BTC/USD")!;
  const runtime = f.internals.runtimes.get("BTC/USD")!;
  const { distributionDecision: _evidence, ...original } = buildDistributionPlan(planInput(b)).plan!;
  const legacy: ExecutionPlan = { ...original, clientOrderId: "existing-legacy-entry",
    policy: { version: POLICY_VERSION, id: "trend-15m", feeBps: 5, reserveBps: 2 } };
  try {
    // Restore the economics of a position opened before the engine switch.
    await f.broker.send(legacy);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal((await f.broker.listPositions()).data.length, 1);
    runtime.position = { symbol: "BTC/USD", side: 1, qty: legacy.qty, entryPx: legacy.limitPx,
      openedMs: b.receiveTsMs - 60_000, initialRiskPx: 1, roundTripCostPx: .1, mfePx: 0, maePx: 0, floorPx: -1,
      breakEvenArmed: false, phase: "OPEN", executionPath: "TAKER_TAKER", policy: legacy.policy! };
    f.setDecision(null); f.internals.riskState.setHealth({ privateStream: false });
    const close: ExecutionPlan = { ...legacy, clientOrderId: "existing-position-close", side: -1,
      limitPx: b.bids[0]!.px, reduceOnlyIntent: true, exitReason: "POLICY_DEADLINE" };
    assert.equal(await f.internals.submit(close), true);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal((await f.broker.listPositions()).data.length, 0);
    assert.equal(f.engine.state().positions.length, 0);
    assert.equal(f.sent.mock.callCount(), 2);
    assert.equal(f.sent.mock.calls[1]!.arguments[0].reduceOnlyIntent, true);
  } finally { delete runtime.position; await f.engine.stop(); }
});

test("distribution holding deadlines advance on real book timestamps and trade messages cannot trigger exits", async t => {
  const f = fixture(t), runtime = f.internals.runtimes.get("BTC/USD")!, b = f.quotes.get("BTC/USD")!;
  runtime.position = { symbol: "BTC/USD", side: 1, qty: .1, entryPx: 100,
    openedMs: b.receiveTsMs - 900_000 + 500, initialRiskPx: 1, roundTripCostPx: .1, mfePx: 0, maePx: 0, floorPx: -1,
    breakEvenArmed: false, phase: "OPEN", executionPath: "TAKER_TAKER",
    policy: { version: POLICY_VERSION, id: "distribution-15m", feeBps: 5, reserveBps: 2 } };
  const managed = t.mock.method(f.internals, "managePosition", () => {});
  try {
    f.advance(1000);
    const tradeClockBook = { ...b, receiveTsMs: f.now() };
    f.internals.processMarketState(runtime, tradeClockBook, features(tradeClockBook), false);
    assert.equal(managed.mock.callCount(), 0, "a trade cannot refresh an executable exit quote");
    const beforeDeadline = f.internals.evaluatePosition(runtime, b, features(b));
    assert.equal(beforeDeadline.nowMs, b.receiveTsMs);
    assert.equal(beforeDeadline.decision.action, "HOLD", "processing-clock delay must not advance the recorded holding deadline");
    f.advance(1); const fresh = f.update();
    const deadline = f.internals.evaluatePosition(runtime, fresh, features(fresh));
    assert.equal(deadline.nowMs, fresh.receiveTsMs); assert.equal(deadline.decision.reason, "POLICY_DEADLINE");
    f.internals.processMarketState(runtime, fresh, features(fresh));
    assert.equal(managed.mock.callCount(), 1, "a genuine quote reaches exit management");
  } finally { delete runtime.position; await f.engine.stop(); }
});

test("distribution holding age starts at the first fill event and a stopped position remains latched for exit retry", async t => {
  const f = fixture(t), b = f.quotes.get("BTC/USD")!, runtime = f.internals.runtimes.get("BTC/USD")!;
  const plan = buildDistributionPlan(planInput(b)).plan!;
  f.internals.orderState.reserve(plan);
  const firstFillAtMs = b.receiveTsMs + 250;
  try {
    f.advance(800);
    f.internals.onPrivateEvent({ id: "distribution-first-partial", event: "partial_fill", orderId: "distribution-fill-order",
      clientOrderId: plan.clientOrderId, symbol: plan.symbol, filledQty: .05, eventQty: .05, eventPx: plan.limitPx,
      timestampMs: firstFillAtMs, positionQty: .05, feeUsd: .001 });
    assert.equal(runtime.position!.openedMs, firstFillAtMs);
    assert.notEqual(runtime.position!.openedMs, f.now()); assert.notEqual(runtime.position!.openedMs, plan.createdMs);
    f.advance(400);
    f.internals.onPrivateEvent({ id: "distribution-final-partial", event: "fill", orderId: "distribution-fill-order",
      clientOrderId: plan.clientOrderId, symbol: plan.symbol, filledQty: plan.qty, eventQty: plan.qty - .05, eventPx: plan.limitPx,
      timestampMs: firstFillAtMs + 50, positionQty: plan.qty, feeUsd: .002 });
    assert.equal(runtime.position!.openedMs, firstFillAtMs, "the final fill cannot restart the holding clock");
    assert.equal(runtime.position!.qty, plan.qty);
    const stopped = f.update("BTC/USD", 99);
    assert.equal(f.internals.evaluatePosition(runtime, stopped, features(stopped)).decision.reason, "POLICY_STOP");
    assert.equal(runtime.position!.phase, "EXITING");
    f.advance(1); const recovered = f.update("BTC/USD", 100);
    assert.equal(f.internals.evaluatePosition(runtime, recovered, features(recovered)).decision.reason, "POLICY_EXIT_LATCHED",
      "an unfilled protected exit remains due even after the price recovers");
    assert.equal(f.sent.mock.callCount(), 0, "the synthetic fill-event test never sends an order");
  } finally { delete runtime.position; await f.engine.stop(); }
});
