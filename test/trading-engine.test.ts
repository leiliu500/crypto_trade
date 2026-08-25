import assert from "node:assert/strict";
import test from "node:test";
import type { AlpacaPosition } from "../src/alpaca/types.js";
import type { BookState, Features } from "../src/core/market.js";
import { loadConfig } from "../src/config.js";
import type { OrderGateway } from "../src/alpaca/gateway.js";
import type { AssetRules, ExecutionPlan } from "../src/execution/planner.js";
import { TradingEngine } from "../src/engine/trading-engine.js";
import type { FillDelta, TrackedOrder } from "../src/execution/order-state.js";
import type { Position } from "../src/strategy/position-manager.js";

test("reconciliation emits a position-dust event once per distinct residual", () => {
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "replay", CONFIG_DIR: "config" }));
  const internals = engine as unknown as {
    runtimes: Map<string, { asset?: AssetRules }>;
    reconcilePositions: (positions: readonly AlpacaPosition[]) => void;
  };
  internals.runtimes.get("BTC/USD")!.asset = {
    symbol: "BTC/USD", minOrderSize: 0.00000001, minTradeIncrement: 0.000000001,
    priceIncrement: 0.000000001, maximumOrderQty: 1, shortable: false,
  };
  const dust: AlpacaPosition = {
    asset_id: "btc", symbol: "BTCUSD", exchange: "CRYPTO", asset_class: "crypto",
    qty: "0.000000001", avg_entry_price: "68500", side: "long", market_value: "0.0000685",
    cost_basis: "0.0000685", unrealized_pl: "0", unrealized_plpc: "0",
    current_price: "68500", lastday_price: "68500",
  };
  const events: unknown[] = [];
  engine.on("positionDust", (event) => events.push(event));

  internals.reconcilePositions([dust]);
  internals.reconcilePositions([dust]);
  internals.reconcilePositions([dust]);

  assert.equal(events.length, 1);
  assert.equal(engine.state().positions.length, 0);

  internals.reconcilePositions([]);
  internals.reconcilePositions([dust]);
  assert.equal(events.length, 2);
});

test("account reconciliation preserves restored holding and risk state for a matching venue position", () => {
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "replay", CONFIG_DIR: "config" }), { now: () => 2_000_000 });
  const internals = engine as unknown as {
    runtimes: Map<string, { asset?: AssetRules }>;
    reconcilePositions: (positions: readonly AlpacaPosition[]) => void;
  };
  internals.runtimes.get("BTC/USD")!.asset = {
    symbol: "BTC/USD", minOrderSize: 0.00001, minTradeIncrement: 0.000000001,
    priceIncrement: 0.001, maximumOrderQty: 1, shortable: false,
  };
  const restored: Position = { symbol: "BTC/USD", side: 1, qty: .001, entryPx: 78_000.001, openedMs: 100_000,
    initialRiskPx: 2_000, roundTripCostPx: 315, mfePx: 400, maePx: 250, floorPx: 315,
    breakEvenArmed: true, phase: "EXITING", selectedHorizonMs: 7_200_000,
    executionPath: "MAKER_MAKER_TAKER_FALLBACK", adverseEvidenceSinceMs: 1_900_000 };
  assert.equal(engine.restorePositionStates([restored]), 1);
  const remote: AlpacaPosition = {
    asset_id: "btc", symbol: "BTCUSD", exchange: "CRYPTO", asset_class: "crypto",
    qty: "0.00099", avg_entry_price: "78000", side: "long", market_value: "77.22",
    cost_basis: "77.22", unrealized_pl: "0", unrealized_plpc: "0", current_price: "78000", lastday_price: "78000",
  };

  internals.reconcilePositions([remote]);

  const { adverseEvidenceSinceMs: _discardedEvidence, ...restoredWithoutEvidence } = restored;
  assert.deepEqual(engine.state().positions[0], { ...restoredWithoutEvidence, qty: .00099, entryPx: 78_000, phase: "OPEN" });
});

test("realized session P&L can be restored before engine startup", () => {
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "replay", CONFIG_DIR: "config" }));
  engine.restoreRealizedSessionPnl(-1.25);
  assert.equal(engine.state().realizedSessionPnl, -1.25);
  assert.throws(() => engine.restoreRealizedSessionPnl(Number.NaN), /must be finite/);
});

test("non-urgent exits fall back to a capped IOC at expiry even when kinematics are unavailable", async () => {
  let nowMs = 1_000;
  const plans: ExecutionPlan[] = [];
  const gateway: OrderGateway = {
    send: async (plan) => {
      plans.push(plan);
      return { id: `order-${plans.length}` } as never;
    },
    cancel: async () => undefined,
    cancelAll: async () => undefined,
  };
  const rest = {
    getOrder: async () => ({ data: {
      id: "order-1", client_order_id: plans[0]!.clientOrderId, symbol: "BTCUSD",
      filled_qty: "0", filled_avg_price: null, status: "canceled", updated_at: new Date(nowMs).toISOString(),
    } }),
  };
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "paper", ALPACA_PAPER: "true",
    ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test", CONFIG_DIR: "config" }), {
    gateway, rest: rest as never, now: () => nowMs,
  });
  const internals = engine as unknown as {
    runtimes: Map<string, {
      asset?: AssetRules; position?: Position; latestFeatures?: Features;
      book: { apply: (delta: unknown) => unknown };
    }>;
    orderState: { get: (clientOrderId: string) => TrackedOrder | undefined };
    submitExit: (runtime: unknown, qty: number, reason: string, book: BookState, features: Features) => Promise<void>;
    handlePendingWithPosition: (runtime: unknown, tracked: TrackedOrder, book: BookState, features: Features) => Promise<void>;
  };
  const runtime = internals.runtimes.get("BTC/USD")!;
  runtime.asset = { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001,
    priceIncrement: .001, maximumOrderQty: 1_000, shortable: false };
  runtime.position = { symbol: "BTC/USD", side: 1, qty: .01, entryPx: 100, openedMs: 0,
    initialRiskPx: 1, roundTripCostPx: .4, mfePx: 0, maePx: 0, floorPx: -1,
    breakEvenArmed: false, phase: "EXITING", executionPath: "MAKER_MAKER_TAKER_FALLBACK" };
  const book: BookState = { symbol: "BTC/USD", bids: [{ px: 99.99, qty: 1 }], asks: [{ px: 100.01, qty: 1 }],
    exchangeTsMs: nowMs, receiveTsMs: nowMs, sequence: 1n, valid: true, sourceReset: true };
  const features: Features = { symbol: "BTC/USD", mid: 100, spread: .02, spreadBps: 2, microprice: 100, visibleDepth: 2,
    qi1: 0, qiK: 0, persistentQiK: 0, ofi: 0, tfi: 0, bidCancellationRatio: 0, askCancellationRatio: 0,
    replenishmentPressure: 0, velocity: 0, acceleration: 0, varianceRate: 1e-8, sigmaHBps: 1,
    microEdgeZ: 0, velocityZ: 0, accelerationZ: 0, efficiency: .5, cusumUp: false, cusumDown: false,
    spreadZ: 0, depthZ: 0, signalFlipRate: 0, providerAgeMs: 0, staleThresholdMs: 1_000,
    warmedUp: true, kinematicsReady: true, stale: false, staleReason: null, receiveTsMs: nowMs };
  runtime.latestFeatures = features;
  runtime.book.apply({ symbol: "BTC/USD", bids: book.bids, asks: book.asks, reset: true,
    exchangeTsMs: nowMs, receiveTsMs: nowMs, sourceId: "test-book" });

  await within(internals.submitExit(runtime, .01, "TIME_STOP", book, features), "maker exit submission");
  assert.equal(plans[0]?.style, "maker");
  assert.equal(plans[0]?.timeInForce, "gtc");
  assert.equal(plans[0]?.limitPx, 100.01);
  assert.equal(plans[0]?.expiresMs, 31_000);

  const maker = internals.orderState.get(plans[0]!.clientOrderId)!;
  nowMs = 31_001;
  const unavailable = { ...features, receiveTsMs: nowMs, kinematicsReady: false,
    kinematicsResetReason: "EVENT_GAP" as const };
  runtime.latestFeatures = unavailable;
  await within(internals.handlePendingWithPosition(runtime, maker, book, unavailable), "maker exit fallback");
  assert.equal(maker.cancelRequestReason, "MAKER_EXIT_FALLBACK");
  assert.equal(plans[1]?.style, "taker");
  assert.equal(plans[1]?.timeInForce, "ioc");
  assert.equal(plans[1]?.fallbackFromClientOrderId, plans[0]?.clientOrderId);
  assert.ok(plans[1]!.limitPx <= book.bids[0]!.px + 1e-9);
});

test("a maker fallback in progress blocks a competing maker exit but permits its designated IOC", async () => {
  const plans: ExecutionPlan[] = [];
  const gateway: OrderGateway = {
    send: async (plan) => { plans.push(plan); return { id: `order-${plans.length}` } as never; },
    cancel: async () => undefined,
    cancelAll: async () => undefined,
  };
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "paper", ALPACA_PAPER: "true",
    ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test", CONFIG_DIR: "config" }), { gateway, now: () => 1_000 });
  const internals = engine as unknown as {
    runtimes: Map<string, { asset?: AssetRules; position?: Position }>;
    makerExitFallbackInFlight: Set<string>;
    orderState: {
      reserve: (plan: ExecutionPlan) => void;
      markAccepted: (clientOrderId: string, alpacaOrderId: string, atMs: number) => void;
      reconcileOrder: (value: { id: string; clientOrderId: string; filledQty: number; status: string }) => unknown;
    };
    submitExit: (runtime: unknown, qty: number, reason: string, book: BookState, features: Features,
      forcedStyle?: "maker" | "taker", fallbackFromClientOrderId?: string) => Promise<void>;
  };
  const runtime = internals.runtimes.get("BTC/USD")!;
  runtime.asset = { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001,
    priceIncrement: .001, maximumOrderQty: 1_000, shortable: false };
  runtime.position = { symbol: "BTC/USD", side: 1, qty: .01, entryPx: 100, openedMs: 0,
    initialRiskPx: 1, roundTripCostPx: .4, mfePx: 0, maePx: 0, floorPx: -1,
    breakEvenArmed: false, phase: "EXITING", executionPath: "MAKER_MAKER_TAKER_FALLBACK" };
  const book: BookState = { symbol: "BTC/USD", bids: [{ px: 99.99, qty: 1 }], asks: [{ px: 100.01, qty: 1 }],
    exchangeTsMs: 1_000, receiveTsMs: 1_000, sequence: 1n, valid: true, sourceReset: true };
  const features = basicFeatures(1_000);
  const expiredPlan: ExecutionPlan = { ...pullbackEntryPlan(), clientOrderId: "fallback-source",
    side: -1, style: "maker", reduceOnlyIntent: true, exitReason: "UNPRODUCTIVE_TIME_STOP" };
  internals.orderState.reserve(expiredPlan);
  internals.orderState.markAccepted(expiredPlan.clientOrderId, "expired-maker", 0);
  internals.orderState.reconcileOrder({ id: "expired-maker", clientOrderId: expiredPlan.clientOrderId,
    filledQty: 0, status: "canceled" });
  internals.makerExitFallbackInFlight.add(expiredPlan.clientOrderId);

  await internals.submitExit(runtime, .01, "UNPRODUCTIVE_TIME_STOP", book, features);
  assert.equal(plans.length, 0);
  await internals.submitExit(runtime, .01, "MAKER_EXIT_TAKER_FALLBACK", book, features, "taker", expiredPlan.clientOrderId);
  assert.equal(plans[0]?.style, "taker");
  assert.equal(plans[0]?.fallbackFromClientOrderId, expiredPlan.clientOrderId);
});

test("hard stops bypass maker exit optimization", async () => {
  const plans: ExecutionPlan[] = [];
  const gateway: OrderGateway = {
    send: async (plan) => { plans.push(plan); return { id: "hard-stop-order" } as never; },
    cancel: async () => undefined, cancelAll: async () => undefined,
  };
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "paper", ALPACA_PAPER: "true",
    ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test", CONFIG_DIR: "config" }), { gateway, now: () => 1_000 });
  const internals = engine as unknown as {
    runtimes: Map<string, { asset?: AssetRules; position?: Position }>;
    submitExit: (runtime: unknown, qty: number, reason: string, book: BookState, features: Features) => Promise<void>;
  };
  const runtime = internals.runtimes.get("BTC/USD")!;
  runtime.asset = { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001,
    priceIncrement: .001, maximumOrderQty: 1_000, shortable: false };
  runtime.position = { symbol: "BTC/USD", side: 1, qty: .01, entryPx: 100, openedMs: 0,
    initialRiskPx: 1, roundTripCostPx: .4, mfePx: 0, maePx: 0, floorPx: -1,
    breakEvenArmed: false, phase: "EXITING", executionPath: "MAKER_MAKER_TAKER_FALLBACK" };
  const book = { symbol: "BTC/USD", bids: [{ px: 99.99, qty: 1 }], asks: [{ px: 100.01, qty: 1 }],
    exchangeTsMs: 1_000, receiveTsMs: 1_000, sequence: 1n, valid: true, sourceReset: true } satisfies BookState;
  const features = { symbol: "BTC/USD", mid: 100, spread: .02, spreadBps: 2, microprice: 100, visibleDepth: 2,
    qi1: 0, qiK: 0, persistentQiK: 0, ofi: 0, tfi: 0, bidCancellationRatio: 0, askCancellationRatio: 0,
    replenishmentPressure: 0, velocity: 0, acceleration: 0, varianceRate: 1e-8, sigmaHBps: 1,
    microEdgeZ: 0, velocityZ: 0, accelerationZ: 0, efficiency: .5, cusumUp: false, cusumDown: false,
    spreadZ: 0, depthZ: 0, signalFlipRate: 0, providerAgeMs: 0, staleThresholdMs: 1_000,
    warmedUp: true, kinematicsReady: true, stale: false, staleReason: null, receiveTsMs: 1_000 } satisfies Features;
  await within(internals.submitExit(runtime, .01, "HARD_STOP", book, features), "hard-stop exit submission");
  assert.equal(plans[0]?.style, "taker");
  assert.equal(plans[0]?.timeInForce, "ioc");
});

test("a partial entry cancels its remainder while kinematics are unavailable", async () => {
  const canceledOrderIds: string[] = [];
  const plan = pullbackEntryPlan();
  const gateway: OrderGateway = {
    send: async () => ({ id: "partial-entry" }) as never,
    cancel: async (orderId) => { canceledOrderIds.push(orderId); },
    cancelAll: async () => undefined,
  };
  const rest = { getOrder: async () => ({ data: {
    id: "partial-entry", client_order_id: plan.clientOrderId, symbol: "BTCUSD",
    filled_qty: "0.004", filled_avg_price: "100", status: "canceled", updated_at: new Date(2_000).toISOString(),
  } }) };
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "paper", ALPACA_PAPER: "true",
    ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test", CONFIG_DIR: "config" }), {
    gateway, rest: rest as never, now: () => 2_000,
  });
  const internals = engine as unknown as {
    runtimes: Map<string, { position?: Position }>;
    orderState: {
      reserve: (value: ExecutionPlan) => void;
      markAccepted: (clientOrderId: string, alpacaOrderId: string, atMs: number) => void;
      apply: (event: unknown) => unknown;
      get: (clientOrderId: string) => TrackedOrder | undefined;
    };
    handlePendingWithPosition: (runtime: unknown, tracked: TrackedOrder, book: BookState, features: Features) => Promise<void>;
  };
  internals.orderState.reserve(plan);
  internals.orderState.markAccepted(plan.clientOrderId, "partial-entry", 1_100);
  internals.orderState.apply({ id: "partial-fill", event: "partial_fill", orderId: "partial-entry",
    clientOrderId: plan.clientOrderId, symbol: "BTC/USD", filledQty: .004, eventQty: .004,
    eventPx: 100, timestampMs: 1_500, positionQty: .003994 });
  const runtime = internals.runtimes.get("BTC/USD")!;
  runtime.position = { symbol: "BTC/USD", side: 1, qty: .003994, entryPx: 100, openedMs: 1_000,
    initialRiskPx: 1, roundTripCostPx: .4, mfePx: 0, maePx: 0, floorPx: -1,
    breakEvenArmed: false, phase: "OPEN", executionPath: "MAKER_MAKER_TAKER_FALLBACK" };
  const book = { symbol: "BTC/USD", bids: [{ px: 99.99, qty: 1 }], asks: [{ px: 100.01, qty: 1 }],
    exchangeTsMs: 2_000, receiveTsMs: 2_000, sequence: 1n, valid: true, sourceReset: true } satisfies BookState;
  const unavailable = { ...basicFeatures(2_000), kinematicsReady: false,
    kinematicsResetReason: "FILTER_BOUNDS" as const };

  const tracked = internals.orderState.get(plan.clientOrderId)!;
  await within(internals.handlePendingWithPosition(runtime, tracked, book, unavailable), "partial entry cancellation");
  assert.deepEqual(canceledOrderIds, ["partial-entry"]);
  assert.equal(tracked.cancelRequestReason, "POSITION_ALREADY_OPEN");
  assert.equal(tracked.cancellationReason, "PARTIAL_REMAINDER_CANCELED");
});

test("hard stops remain active while kinematics are unavailable", async () => {
  const plans: ExecutionPlan[] = [];
  const gateway: OrderGateway = {
    send: async (plan) => { plans.push(plan); return { id: "protective-exit" } as never; },
    cancel: async () => undefined,
    cancelAll: async () => undefined,
  };
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "paper", ALPACA_PAPER: "true",
    ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test", CONFIG_DIR: "config" }), { gateway, now: () => 2_000 });
  const internals = engine as unknown as {
    runtimes: Map<string, { asset?: AssetRules; position?: Position }>;
    enforceProtectiveExitWithoutKinematics: (runtime: unknown, book: BookState, features: Features) => Promise<void>;
  };
  const runtime = internals.runtimes.get("BTC/USD")!;
  runtime.asset = { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001,
    priceIncrement: .001, maximumOrderQty: 1_000, shortable: false };
  runtime.position = { symbol: "BTC/USD", side: 1, qty: .01, entryPx: 100, openedMs: 0,
    initialRiskPx: 1, roundTripCostPx: .4, mfePx: 0, maePx: 0, floorPx: -1,
    breakEvenArmed: false, phase: "OPEN", executionPath: "MAKER_MAKER_TAKER_FALLBACK" };
  const book = { symbol: "BTC/USD", bids: [{ px: 98.9, qty: 1 }], asks: [{ px: 98.92, qty: 1 }],
    exchangeTsMs: 2_000, receiveTsMs: 2_000, sequence: 1n, valid: true, sourceReset: true } satisfies BookState;
  const unavailable = { ...basicFeatures(2_000), mid: 98.91, kinematicsReady: false,
    kinematicsResetReason: "FILTER_BOUNDS" as const };

  await within(internals.enforceProtectiveExitWithoutKinematics(runtime, book, unavailable), "protective exit");
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.style, "taker");
  assert.equal(plans[0]?.exitReason, "HARD_STOP");
});

test("session P&L includes credited-asset entry fees and quote-currency exit fees", () => {
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "paper", ALPACA_PAPER: "true",
    ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test", CONFIG_DIR: "config" }));
  const internals = engine as unknown as {
    orderState: {
      reserve: (value: ExecutionPlan) => void;
      markAccepted: (clientOrderId: string, alpacaOrderId: string, atMs: number) => void;
      apply: (event: unknown) => FillDelta | null;
    };
    applyFill: (fill: FillDelta) => void;
  };
  const entry = { ...pullbackEntryPlan(), clientOrderId: "fee-entry", qty: 1, limitPx: 100 };
  internals.orderState.reserve(entry);
  internals.orderState.markAccepted(entry.clientOrderId, "fee-entry-order", 1_001);
  const entryFill = internals.orderState.apply({ id: "fee-entry-fill", event: "fill", orderId: "fee-entry-order",
    clientOrderId: entry.clientOrderId, symbol: "BTC/USD", filledQty: 1, eventQty: 1,
    eventPx: 100, timestampMs: 1_002, positionQty: .9985 });
  assert.ok(entryFill);
  internals.applyFill(entryFill!);
  assert.ok(Math.abs(engine.state().realizedSessionPnl + .15) < 1e-12);

  const exit: ExecutionPlan = { ...entry, clientOrderId: "fee-exit", decisionId: "fee-exit-decision",
    riskApprovalId: "fee-exit-risk", side: -1, qty: .9985, limitPx: 101, style: "taker", timeInForce: "ioc",
    reduceOnlyIntent: true, expectedCost: { ...entry.expectedCost, feeBps: 50 } };
  internals.orderState.reserve(exit);
  internals.orderState.markAccepted(exit.clientOrderId, "fee-exit-order", 1_003);
  const exitFill = internals.orderState.apply({ id: "fee-exit-fill", event: "fill", orderId: "fee-exit-order",
    clientOrderId: exit.clientOrderId, symbol: "BTC/USD", filledQty: .9985, eventQty: .9985,
    eventPx: 101, timestampMs: 1_004, positionQty: 0 });
  assert.ok(exitFill);
  internals.applyFill(exitFill!);
  assert.ok(Math.abs(engine.state().realizedSessionPnl - .59637875) < 1e-12);
});

test("a deadline that fires while order submission is in flight cancels immediately after acknowledgment", async () => {
  const createdMs = Date.now();
  const plan = { ...pullbackEntryPlan(), clientOrderId: "deadline-in-flight", decisionId: "deadline-in-flight-decision",
    createdMs, expiresMs: createdMs + 25 };
  let acknowledge!: (value: { id: string }) => void;
  const acknowledgment = new Promise<{ id: string }>((resolve) => { acknowledge = resolve; });
  const canceledOrderIds: string[] = [];
  const gateway: OrderGateway = {
    send: async () => await acknowledgment as never,
    cancel: async (orderId) => { canceledOrderIds.push(orderId); },
    cancelAll: async () => undefined,
  };
  const rest = { getOrder: async () => ({ data: {
    id: "deadline-order", client_order_id: plan.clientOrderId, symbol: "BTCUSD",
    filled_qty: "0", filled_avg_price: null, status: "canceled", updated_at: new Date().toISOString(),
  } }) };
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "paper", ALPACA_PAPER: "true",
    ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test", CONFIG_DIR: "config" }), {
    gateway, rest: rest as never, now: Date.now,
  });
  const internals = engine as unknown as {
    orderState: { get: (clientOrderId: string) => TrackedOrder | undefined };
    submit: (value: ExecutionPlan) => Promise<boolean>;
  };
  const requested = new Promise<{ reason: string; alpacaOrderId: string | null }>((resolve) => {
    engine.once("orderCancelRequested", resolve);
  });

  const submission = internals.submit(plan);
  const request = await within(requested, "in-flight deadline request");
  assert.equal(request.reason, "TTL_EXPIRED");
  assert.equal(request.alpacaOrderId, null);
  assert.equal(internals.orderState.get(plan.clientOrderId)?.status, "SENDING");
  assert.equal(internals.orderState.get(plan.clientOrderId)?.cancelRequestReason, "TTL_EXPIRED");

  acknowledge({ id: "deadline-order" });
  assert.equal(await within(submission, "in-flight deadline cancellation"), true);
  assert.deepEqual(canceledOrderIds, ["deadline-order"]);
  assert.equal(internals.orderState.get(plan.clientOrderId)?.status, "CANCELED");
  assert.equal(internals.orderState.get(plan.clientOrderId)?.cancellationReason, "TTL_EXPIRED");
});

test("an accepted maker order expires on its wall-clock deadline without another market event", async () => {
  const createdMs = Date.now();
  const plan = { ...pullbackEntryPlan(), clientOrderId: "event-free-deadline", decisionId: "event-free-deadline-decision",
    createdMs, expiresMs: createdMs + 100 };
  let observeCancel!: (orderId: string) => void;
  const canceled = new Promise<string>((resolve) => { observeCancel = resolve; });
  const gateway: OrderGateway = {
    send: async () => ({ id: "event-free-order" }) as never,
    cancel: async (orderId) => { observeCancel(orderId); },
    cancelAll: async () => undefined,
  };
  const rest = { getOrder: async () => ({ data: {
    id: "event-free-order", client_order_id: plan.clientOrderId, symbol: "BTCUSD",
    filled_qty: "0", filled_avg_price: null, status: "canceled", updated_at: new Date().toISOString(),
  } }) };
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "paper", ALPACA_PAPER: "true",
    ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test", CONFIG_DIR: "config" }), {
    gateway, rest: rest as never, now: Date.now,
  });
  const internals = engine as unknown as {
    orderState: { get: (clientOrderId: string) => TrackedOrder | undefined };
    submit: (value: ExecutionPlan) => Promise<boolean>;
  };

  assert.equal(await internals.submit(plan), true);
  assert.equal(internals.orderState.get(plan.clientOrderId)?.status, "OPEN");
  assert.equal(await within(canceled, "event-free order deadline"), "event-free-order");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(internals.orderState.get(plan.clientOrderId)?.status, "CANCELED");
  assert.equal(internals.orderState.get(plan.clientOrderId)?.cancellationReason, "TTL_EXPIRED");
});

test("an emergency cancel-all intent survives a delayed order acknowledgment", async () => {
  const nowMs = 2_000;
  const plan = { ...pullbackEntryPlan(), clientOrderId: "emergency-in-flight", decisionId: "emergency-in-flight-decision" };
  let acknowledge!: (value: { id: string }) => void;
  const acknowledgment = new Promise<{ id: string }>((resolve) => { acknowledge = resolve; });
  const canceledOrderIds: string[] = [];
  let cancelAllCalls = 0;
  const gateway: OrderGateway = {
    send: async () => await acknowledgment as never,
    cancel: async (orderId) => { canceledOrderIds.push(orderId); },
    cancelAll: async () => { cancelAllCalls += 1; },
  };
  const rest = { getOrder: async () => ({ data: {
    id: "emergency-order", client_order_id: plan.clientOrderId, symbol: "BTCUSD",
    filled_qty: "0", filled_avg_price: null, status: "canceled", updated_at: new Date(nowMs).toISOString(),
  } }) };
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "paper", ALPACA_PAPER: "true",
    ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test", CONFIG_DIR: "config" }), {
    gateway, rest: rest as never, now: () => nowMs,
  });
  const internals = engine as unknown as {
    orderState: { get: (clientOrderId: string) => TrackedOrder | undefined };
    submit: (value: ExecutionPlan) => Promise<boolean>;
    cancelAllSafely: (reason: "PUBLIC_STREAM_DOWN") => Promise<void>;
  };

  const submission = internals.submit(plan);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await internals.cancelAllSafely("PUBLIC_STREAM_DOWN");
  assert.equal(cancelAllCalls, 1);
  assert.equal(internals.orderState.get(plan.clientOrderId)?.cancelRequestReason, "PUBLIC_STREAM_DOWN");

  acknowledge({ id: "emergency-order" });
  assert.equal(await within(submission, "emergency post-ack cancellation"), true);
  assert.deepEqual(canceledOrderIds, ["emergency-order"]);
  assert.equal(internals.orderState.get(plan.clientOrderId)?.cancellationReason, "PUBLIC_STREAM_DOWN");
});

test("account reconciliation fetches exact status before terminalizing an order absent from the open list", async () => {
  const plan = { ...pullbackEntryPlan(), clientOrderId: "absent-but-filled", decisionId: "absent-but-filled-decision" };
  const exactLookups: string[] = [];
  const rest = { getOrder: async (orderId: string) => {
    exactLookups.push(orderId);
    return { data: {
      id: orderId, client_order_id: plan.clientOrderId, symbol: "BTCUSD",
      filled_qty: String(plan.qty), filled_avg_price: "100.25", status: "filled",
      updated_at: new Date(3_000).toISOString(),
    } };
  } };
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "paper", ALPACA_PAPER: "true",
    ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test", CONFIG_DIR: "config" }), {
    rest: rest as never, now: () => 3_000,
  });
  const internals = engine as unknown as {
    orderState: {
      reserve: (value: ExecutionPlan) => void;
      markAccepted: (clientOrderId: string, alpacaOrderId: string, atMs: number) => void;
      get: (clientOrderId: string) => TrackedOrder | undefined;
    };
    reconcileTrackedOrders: (openOrders: readonly []) => Promise<boolean>;
  };
  internals.orderState.reserve(plan);
  internals.orderState.markAccepted(plan.clientOrderId, "filled-order", 2_000);

  assert.equal(await internals.reconcileTrackedOrders([]), true);
  assert.deepEqual(exactLookups, ["filled-order"]);
  assert.equal(internals.orderState.get(plan.clientOrderId)?.status, "FILLED");
  assert.equal(internals.orderState.get(plan.clientOrderId)?.filledQty, plan.qty);
  assert.equal(internals.orderState.get(plan.clientOrderId)?.averageFillPx, 100.25);
  assert.equal(internals.orderState.get(plan.clientOrderId)?.cancellationReason, undefined);
});

test("a pullback maker entry survives one transient kinematics reset and cancels only after the configured grace", async () => {
  let nowMs = 2_000;
  const canceledOrderIds: string[] = [];
  const plan = pullbackEntryPlan();
  const gateway: OrderGateway = {
    send: async () => ({ id: "pullback-order" }) as never,
    cancel: async (orderId) => { canceledOrderIds.push(orderId); },
    cancelAll: async () => undefined,
  };
  const rest = { getOrder: async () => ({ data: {
    id: "pullback-order", client_order_id: plan.clientOrderId, symbol: "BTCUSD",
    filled_qty: "0", filled_avg_price: null, status: "canceled", updated_at: new Date(nowMs).toISOString(),
  } }) };
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "paper", ALPACA_PAPER: "true",
    ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test", CONFIG_DIR: "config" }), {
    gateway, rest: rest as never, now: () => nowMs,
  });
  const internals = engine as unknown as {
    runtimes: Map<string, unknown>;
    orderState: {
      reserve: (value: ExecutionPlan) => void;
      markAccepted: (clientOrderId: string, alpacaOrderId: string, atMs: number) => void;
      get: (clientOrderId: string) => TrackedOrder | undefined;
    };
    handlePendingKinematicsUnavailable: (runtime: unknown, tracked: TrackedOrder, features: Features) => Promise<void>;
  };
  internals.orderState.reserve(plan);
  internals.orderState.markAccepted(plan.clientOrderId, "pullback-order", nowMs);
  const tracked = internals.orderState.get(plan.clientOrderId)!;
  const graceEvents: Array<{ details?: { kinematicsResetReason?: string; consecutiveEvents?: number } }> = [];
  engine.on("pendingKinematicsGrace", (event) => graceEvents.push(event));
  const unavailable = { ...basicFeatures(nowMs), kinematicsReady: false,
    kinematicsResetReason: "FILTER_BOUNDS" as const };

  await internals.handlePendingKinematicsUnavailable(internals.runtimes.get("BTC/USD")!, tracked, unavailable);
  assert.equal(canceledOrderIds.length, 0);
  assert.equal(tracked.status, "OPEN");
  assert.equal(graceEvents.length, 1);
  assert.equal(graceEvents[0]?.details?.kinematicsResetReason, "FILTER_BOUNDS");
  assert.equal(graceEvents[0]?.details?.consecutiveEvents, 1);

  nowMs = 7_000;
  await internals.handlePendingKinematicsUnavailable(internals.runtimes.get("BTC/USD")!, tracked,
    { ...unavailable, receiveTsMs: nowMs });
  assert.deepEqual(canceledOrderIds, ["pullback-order"]);
  assert.equal(tracked.status, "CANCELED");
  assert.equal(tracked.cancellationReason, "KINEMATICS_UNAVAILABLE");
});

test("a pullback maker entry requires persistent signal invalidation before cancellation", async () => {
  let nowMs = 2_000;
  let signalValid = false;
  const canceledOrderIds: string[] = [];
  const plan = pullbackEntryPlan();
  const gateway: OrderGateway = {
    send: async () => ({ id: "pullback-signal-order" }) as never,
    cancel: async (orderId) => { canceledOrderIds.push(orderId); },
    cancelAll: async () => undefined,
  };
  const rest = { getOrder: async () => ({ data: {
    id: "pullback-signal-order", client_order_id: plan.clientOrderId, symbol: "BTCUSD",
    filled_qty: "0", filled_avg_price: null, status: "canceled", updated_at: new Date(nowMs).toISOString(),
  } }) };
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "paper", ALPACA_PAPER: "true",
    ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test", CONFIG_DIR: "config" }), {
    gateway, rest: rest as never, now: () => nowMs,
  });
  const internals = engine as unknown as {
    runtimes: Map<string, {
      pendingEntryIntent?: unknown;
      entryEngine: unknown;
      regimeEngine: unknown;
      cost: unknown;
    }>;
    orderState: {
      reserve: (value: ExecutionPlan) => void;
      markAccepted: (clientOrderId: string, alpacaOrderId: string, atMs: number) => void;
      get: (clientOrderId: string) => TrackedOrder | undefined;
    };
    reevaluatePending: (runtime: unknown, tracked: TrackedOrder, book: BookState, features: Features) => void;
  };
  const runtime = internals.runtimes.get("BTC/USD")!;
  runtime.pendingEntryIntent = {
    decisionId: plan.decisionId, side: 1, diagnostics: { family: "PULLBACK_RECOVERY" },
  };
  runtime.entryEngine = {
    signalStillValid: () => signalValid,
    revalidateExactCost: (intent: unknown) => intent,
  };
  runtime.regimeEngine = { classify: () => ({ name: "TREND_UP", allowLong: true, allowShort: false, riskScale: 1 }) };
  runtime.cost = { estimate: () => plan.expectedCost };
  internals.orderState.reserve(plan);
  internals.orderState.markAccepted(plan.clientOrderId, "pullback-signal-order", nowMs);
  const tracked = internals.orderState.get(plan.clientOrderId)!;
  const book = { symbol: "BTC/USD", bids: [{ px: 99.99, qty: 1 }], asks: [{ px: 100.01, qty: 1 }],
    exchangeTsMs: nowMs, receiveTsMs: nowMs, sequence: 1n, valid: true, sourceReset: true } satisfies BookState;
  const graceEvents: unknown[] = [];
  const recoveredEvents: unknown[] = [];
  engine.on("pendingSignalGrace", (event) => graceEvents.push(event));
  engine.on("pendingSignalRecovered", (event) => recoveredEvents.push(event));

  internals.reevaluatePending(runtime, tracked, book, basicFeatures(nowMs));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(canceledOrderIds.length, 0);
  assert.equal(graceEvents.length, 1);

  signalValid = true;
  nowMs = 3_000;
  internals.reevaluatePending(runtime, tracked, book, basicFeatures(nowMs));
  assert.equal(recoveredEvents.length, 1);

  signalValid = false;
  nowMs = 6_000;
  internals.reevaluatePending(runtime, tracked, book, basicFeatures(nowMs));
  nowMs = 10_999;
  internals.reevaluatePending(runtime, tracked, book, basicFeatures(nowMs));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(canceledOrderIds.length, 0);
  assert.equal(graceEvents.length, 2);

  nowMs = 11_000;
  internals.reevaluatePending(runtime, tracked, book, basicFeatures(nowMs));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(canceledOrderIds, ["pullback-signal-order"]);
  assert.equal(tracked.status, "CANCELED");
  assert.equal(tracked.cancellationReason, "SIGNAL_INVALIDATED");
});

test("the incident's transient OFI spike enters grace and recovers without canceling the maker order", async () => {
  const harness = pendingEntryHarness("incident-adverse-flow", false);
  const graceEvents: Array<{ details?: { opposingOfi?: boolean; opposingTfi?: boolean; confirmationMs?: number } }> = [];
  const recoveredEvents: Array<{ adverseEvents?: number; lastOpposingOfi?: boolean }> = [];
  harness.engine.on("pendingAdverseFlowGrace", (event) => graceEvents.push(event));
  harness.engine.on("pendingAdverseFlowRecovered", (event) => recoveredEvents.push(event));

  await harness.reevaluate(5_052, -2.3797440632776063, 1);
  assert.equal(harness.canceledOrderIds.length, 0);
  assert.equal(harness.tracked.status, "OPEN");
  assert.equal(graceEvents.length, 1);
  assert.equal(graceEvents[0]?.details?.opposingOfi, true);
  assert.equal(graceEvents[0]?.details?.opposingTfi, false);
  assert.equal(graceEvents[0]?.details?.confirmationMs, 2_000);

  harness.setSignalValid(true);
  await harness.reevaluate(6_345, .809751841482451, 1);
  assert.equal(harness.canceledOrderIds.length, 0);
  assert.equal(harness.tracked.status, "OPEN");
  assert.equal(recoveredEvents.length, 1);
  assert.equal(recoveredEvents[0]?.adverseEvents, 1);
  assert.equal(recoveredEvents[0]?.lastOpposingOfi, true);
});

test("persistent single-sensor adverse flow cancels after both time and event confirmation", async () => {
  const harness = pendingEntryHarness("persistent-adverse-flow", true);

  await harness.reevaluate(2_000, -2.1, 1);
  await harness.reevaluate(3_999, -2.4, 1);
  assert.equal(harness.canceledOrderIds.length, 0);
  assert.equal(harness.tracked.status, "OPEN");

  await harness.reevaluate(4_000, -2.2, 1);
  assert.deepEqual(harness.canceledOrderIds, ["persistent-adverse-flow-order"]);
  assert.equal(harness.tracked.status, "CANCELED");
  assert.equal(harness.tracked.cancellationReason, "ADVERSE_FLOW");
});

test("corroborated opposing OFI and trade flow cancel a pending maker order immediately", async () => {
  const harness = pendingEntryHarness("corroborated-adverse-flow", true);

  await harness.reevaluate(2_000, -2.1, -.6);
  assert.deepEqual(harness.canceledOrderIds, ["corroborated-adverse-flow-order"]);
  assert.equal(harness.tracked.status, "CANCELED");
  assert.equal(harness.tracked.cancellationReason, "ADVERSE_FLOW");
});

test("an expired pullback maker order reports TTL before a simultaneous kinematics reset", async () => {
  let nowMs = 21_001;
  const plan = pullbackEntryPlan();
  const gateway: OrderGateway = {
    send: async () => ({ id: "expired-pullback-order" }) as never,
    cancel: async () => undefined,
    cancelAll: async () => undefined,
  };
  const rest = { getOrder: async () => ({ data: {
    id: "expired-pullback-order", client_order_id: plan.clientOrderId, symbol: "BTCUSD",
    filled_qty: "0", filled_avg_price: null, status: "canceled", updated_at: new Date(nowMs).toISOString(),
  } }) };
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "paper", ALPACA_PAPER: "true",
    ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test", CONFIG_DIR: "config" }), {
    gateway, rest: rest as never, now: () => nowMs,
  });
  const internals = engine as unknown as {
    runtimes: Map<string, unknown>;
    orderState: {
      reserve: (value: ExecutionPlan) => void;
      markAccepted: (clientOrderId: string, alpacaOrderId: string, atMs: number) => void;
      get: (clientOrderId: string) => TrackedOrder | undefined;
    };
    handlePendingKinematicsUnavailable: (runtime: unknown, tracked: TrackedOrder, features: Features) => Promise<void>;
  };
  internals.orderState.reserve(plan);
  internals.orderState.markAccepted(plan.clientOrderId, "expired-pullback-order", nowMs);
  const tracked = internals.orderState.get(plan.clientOrderId)!;
  await internals.handlePendingKinematicsUnavailable(internals.runtimes.get("BTC/USD")!, tracked,
    { ...basicFeatures(nowMs), kinematicsReady: false, kinematicsResetReason: "EVENT_GAP" });
  assert.equal(tracked.status, "CANCELED");
  assert.equal(tracked.cancellationReason, "TTL_EXPIRED");
});

test("transient hold evidence cannot bypass the position manager minimum hold", async () => {
  const plans: ExecutionPlan[] = [];
  const gateway: OrderGateway = {
    send: async (plan) => { plans.push(plan); return { id: "unexpected-exit" } as never; },
    cancel: async () => undefined,
    cancelAll: async () => undefined,
  };
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "paper", ALPACA_PAPER: "true",
    ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test", CONFIG_DIR: "config" }), {
    gateway, now: () => 61_000,
  });
  const internals = engine as unknown as {
    runtimes: Map<string, {
      asset?: AssetRules; position?: Position;
      regimeEngine: { classify: (features: unknown) => unknown };
      holdEngine: { evaluate: (...args: unknown[]) => unknown };
      positionManager: { update: (...args: unknown[]) => unknown };
      cost: { estimate: (...args: unknown[]) => unknown };
    }>;
    managePosition: (runtime: unknown, book: BookState, features: unknown) => void;
  };
  const runtime = internals.runtimes.get("BTC/USD")!;
  runtime.asset = { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001,
    priceIncrement: .001, maximumOrderQty: 1_000, shortable: false };
  runtime.position = { symbol: "BTC/USD", side: 1, qty: .01, entryPx: 100, openedMs: 0,
    initialRiskPx: 10, roundTripCostPx: .4, mfePx: 0, maePx: 0, floorPx: -10,
    breakEvenArmed: false, phase: "OPEN", selectedHorizonMs: 7_200_000,
    executionPath: "MAKER_MAKER_TAKER_FALLBACK" };
  runtime.regimeEngine = { classify: () => ({ name: "CHOP", allowLong: false, allowShort: false, riskScale: 0 }) };
  runtime.holdEngine = { evaluate: () => ({ continuationScore: -1, reversalScore: 1, holdGrossBps: 0,
    uncertaintyBps: 1, holdLowerBoundBps: -1, exitEvidence: true, reversalVotes: 5 }) };
  runtime.positionManager = { update: () => ({ action: "HOLD", floorPx: -10, stopPx: 90, signedMovePx: 0 }) };
  runtime.cost = { estimate: () => ({ roundTripBps: 30, spreadBps: 0, feeBps: 30,
    impactBps: 0, latencyBps: 0, adverseSelectionBps: 0, fundingBps: 0, borrowBps: 0 }) };
  const book = { symbol: "BTC/USD", bids: [{ px: 100, qty: 1 }], asks: [{ px: 100.01, qty: 1 }],
    exchangeTsMs: 61_000, receiveTsMs: 61_000, sequence: 1n, valid: true, sourceReset: true } satisfies BookState;

  internals.managePosition(runtime, book, basicFeatures(61_000));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(plans.length, 0);
});

test("closing a position arms the configured re-entry cooldown", () => {
  const nowMs = 10_000;
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "replay", CONFIG_DIR: "config" }), { now: () => nowMs });
  const internals = engine as unknown as {
    runtimes: Map<string, { asset?: AssetRules; position?: Position; reentryBlockedUntilMs?: number }>;
    applyFill: (fill: FillDelta) => void;
  };
  const runtime = internals.runtimes.get("BTC/USD")!;
  runtime.asset = { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001,
    priceIncrement: .001, maximumOrderQty: 1_000, shortable: false };
  runtime.position = { symbol: "BTC/USD", side: 1, qty: .01, entryPx: 100, openedMs: 0,
    initialRiskPx: 10, roundTripCostPx: .4, mfePx: 0, maePx: 0, floorPx: -10,
    breakEvenArmed: false, phase: "EXITING" };

  internals.applyFill({ symbol: "BTC/USD", side: -1, qty: .01, price: 101,
    clientOrderId: "exit", final: true, positionQty: 0 });

  assert.equal(runtime.position, undefined);
  assert.equal(runtime.reentryBlockedUntilMs, nowMs + 900_000);
});

function pullbackEntryPlan(): ExecutionPlan {
  return {
    clientOrderId: "pullback-entry", decisionId: "pullback-decision", riskApprovalId: "pullback-risk",
    symbol: "BTC/USD", side: 1, qty: .01, limitPx: 99.99, style: "maker", timeInForce: "gtc",
    createdMs: 1_000, expiresMs: 21_000, originatingSequence: 1n, featureHash: "test",
    strategyVersion: "test", modelVersion: "none",
    expectedCost: { roundTripBps: 30, spreadBps: 0, feeBps: 30, impactBps: 0, latencyBps: 0,
      adverseSelectionBps: 0, fundingBps: 0, borrowBps: 0 },
    risk: { qty: .01, riskBudget: 1, maximumLossPerUnit: 1, modeledMaximumLoss: .01,
      drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit: "risk" },
    fillProbability: .5, expectedValue: .01, reduceOnlyIntent: false,
    economicHorizonMs: 7_200_000, entryFamily: "PULLBACK_RECOVERY",
    executionPath: "MAKER_MAKER_TAKER_FALLBACK",
  };
}

function basicFeatures(nowMs: number): Features {
  return {
    symbol: "BTC/USD", mid: 100, spread: .02, spreadBps: 2, microprice: 100, visibleDepth: 2,
    qi1: 0, qiK: 0, persistentQiK: 0, ofi: 0, tfi: 0, bidCancellationRatio: 0, askCancellationRatio: 0,
    replenishmentPressure: 0, velocity: 0, acceleration: 0, varianceRate: 1e-8, sigmaHBps: 1,
    microEdgeZ: 0, velocityZ: 0, accelerationZ: 0, efficiency: .5, cusumUp: false, cusumDown: false,
    spreadZ: 0, depthZ: 0, signalFlipRate: 0, providerAgeMs: 0, staleThresholdMs: 1_000,
    warmedUp: true, kinematicsReady: true, kinematicsResetReason: null,
    stale: false, staleReason: null, receiveTsMs: nowMs,
  };
}

function pendingEntryHarness(clientOrderId: string, initialSignalValid: boolean) {
  let nowMs = 2_000;
  let signalValid = initialSignalValid;
  const canceledOrderIds: string[] = [];
  const plan = { ...pullbackEntryPlan(), clientOrderId, decisionId: `${clientOrderId}-decision` };
  const gateway: OrderGateway = {
    send: async () => ({ id: `${clientOrderId}-order` }) as never,
    cancel: async (orderId) => { canceledOrderIds.push(orderId); },
    cancelAll: async () => undefined,
  };
  const rest = { getOrder: async () => ({ data: {
    id: `${clientOrderId}-order`, client_order_id: plan.clientOrderId, symbol: "BTCUSD",
    filled_qty: "0", filled_avg_price: null, status: "canceled", updated_at: new Date(nowMs).toISOString(),
  } }) };
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "paper", ALPACA_PAPER: "true",
    ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test", CONFIG_DIR: "config" }), {
    gateway, rest: rest as never, now: () => nowMs,
  });
  const internals = engine as unknown as {
    runtimes: Map<string, {
      pendingEntryIntent?: unknown;
      entryEngine: unknown;
      regimeEngine: unknown;
      cost: unknown;
    }>;
    orderState: {
      reserve: (value: ExecutionPlan) => void;
      markAccepted: (trackedClientOrderId: string, alpacaOrderId: string, atMs: number) => void;
      get: (trackedClientOrderId: string) => TrackedOrder | undefined;
    };
    reevaluatePending: (runtime: unknown, tracked: TrackedOrder, book: BookState, features: Features) => void;
  };
  const runtime = internals.runtimes.get("BTC/USD")!;
  runtime.pendingEntryIntent = {
    decisionId: plan.decisionId, side: 1, diagnostics: { family: "PULLBACK_RECOVERY" },
  };
  runtime.entryEngine = {
    signalStillValid: () => signalValid,
    revalidateExactCost: (intent: unknown) => intent,
  };
  runtime.regimeEngine = { classify: () => ({ name: "TREND_UP", allowLong: true, allowShort: false, riskScale: 1 }) };
  runtime.cost = { estimate: () => plan.expectedCost };
  internals.orderState.reserve(plan);
  internals.orderState.markAccepted(plan.clientOrderId, `${clientOrderId}-order`, nowMs);
  const tracked = internals.orderState.get(plan.clientOrderId)!;
  const book = { symbol: "BTC/USD", bids: [{ px: 99.99, qty: 1 }], asks: [{ px: 100.01, qty: 1 }],
    exchangeTsMs: nowMs, receiveTsMs: nowMs, sequence: 1n, valid: true, sourceReset: true } satisfies BookState;
  return {
    engine,
    tracked,
    canceledOrderIds,
    setSignalValid: (value: boolean) => { signalValid = value; },
    reevaluate: async (atMs: number, ofi: number, tfi: number) => {
      nowMs = atMs;
      internals.reevaluatePending(runtime, tracked, { ...book, exchangeTsMs: atMs, receiveTsMs: atMs },
        { ...basicFeatures(atMs), ofi, tfi });
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

async function within<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out during ${label}`)), 1_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
