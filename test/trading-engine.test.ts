import assert from "node:assert/strict";
import test from "node:test";
import type { AlpacaPosition } from "../src/alpaca/types.js";
import type { BookState, Features } from "../src/core/market.js";
import { loadConfig } from "../src/config.js";
import type { OrderGateway } from "../src/alpaca/gateway.js";
import type { AssetRules, ExecutionPlan } from "../src/execution/planner.js";
import { TradingEngine } from "../src/engine/trading-engine.js";
import type { TrackedOrder } from "../src/execution/order-state.js";
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

test("non-urgent exits rest first and a canceled maker exit falls back to a capped IOC", async () => {
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
    fallbackMakerExit: (runtime: unknown, tracked: TrackedOrder, trigger: string) => Promise<void>;
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
  await within(internals.fallbackMakerExit(runtime, maker, "TTL_EXPIRED"), "maker exit fallback");
  assert.equal(maker.cancelRequestReason, "MAKER_EXIT_FALLBACK");
  assert.equal(plans[1]?.style, "taker");
  assert.equal(plans[1]?.timeInForce, "ioc");
  assert.equal(plans[1]?.fallbackFromClientOrderId, plans[0]?.clientOrderId);
  assert.ok(plans[1]!.limitPx <= book.bids[0]!.px + 1e-9);
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
