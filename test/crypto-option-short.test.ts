import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { encode } from "@msgpack/msgpack";
import { decodeOptionStreamMessages } from "../src/alpaca/option-stream.js";
import { AlpacaApiError, type AlpacaRestClient } from "../src/alpaca/rest.js";
import type { AlpacaAccount, AlpacaOptionContract, AlpacaOrder, AlpacaPosition } from "../src/alpaca/types.js";
import { loadConfig } from "../src/config.js";
import {
  CryptoOptionShortController, newYorkSession, optionOrderIsFinal, selectZeroDtePut,
  type OptionQuoteStream, type StockQuoteStream,
} from "../src/options/crypto-option-short.js";

const nowMs = Date.parse("2026-08-25T18:00:00.000Z"); // 14:00 America/New_York (EDT)
const contract: AlpacaOptionContract = {
  id: "contract-1", symbol: "IBIT260825P00050000", name: "IBIT Aug 25 2026 50 Put",
  status: "active", tradable: true, expiration_date: "2026-08-25", root_symbol: "IBIT",
  underlying_symbol: "IBIT", underlying_asset_id: "ibit", type: "put", style: "american",
  strike_price: "50", size: "100", open_interest: "1000", ppind: true,
};

test("0DTE selection accepts only fresh same-New-York-day streamed put quotes", () => {
  const cfg = loadConfig({ TRADING_MODE: "replay" }).optionShort;
  const quote = { symbol: contract.symbol, timestampMs: nowMs - 100, bidPrice: .96, bidSize: 20, askPrice: 1, askSize: 20 };
  const selected = selectZeroDtePut({
    contracts: [contract, { ...contract, symbol: "IBIT260826P00050000", expiration_date: "2026-08-26" }],
    quotes: new Map([[contract.symbol, quote], ["IBIT260826P00050000", { ...quote, symbol: "IBIT260826P00050000" }]]),
    proxyMid: 50, expirationDate: "2026-08-25", nowMs, cfg,
  });
  assert.equal(selected?.contract.symbol, contract.symbol);
  assert.equal(newYorkSession(nowMs).date, "2026-08-25");
  assert.equal(newYorkSession(nowMs).minute, 14 * 60);

  assert.equal(selectZeroDtePut({
    contracts: [contract], quotes: new Map([[contract.symbol, { ...quote, timestampMs: nowMs - cfg.maximumQuoteAgeMs - 1 }]]),
    proxyMid: 50, expirationDate: "2026-08-25", nowMs, cfg,
  }), null);
});

test("options WebSocket frames are decoded as MessagePack", () => {
  const frame = encode([{ T: "q", S: contract.symbol, t: "2026-08-25T18:00:00Z", bp: .96, bs: 20, ap: 1, as: 20 }]);
  const messages = decodeOptionStreamMessages(frame);
  assert.equal(messages[0]?.T, "q");
  assert.equal(messages[0]?.S, contract.symbol);
});

test("an open option exposure publishes fresh WebSocket bid marks for dashboard P&L", async () => {
  const optionStream = new FakeOptionStream();
  const controller = optionController(nowMs, exitRest([], nowMs), new FakeStockStream(), optionStream);
  let marks = 0;
  controller.on("mark", () => { marks += 1; });
  await controller.reconcile(optionAccount(), [optionPosition("2")], [filledOpeningOrder("2")]);
  optionStream.emit("quote", {
    symbol: contract.symbol, timestampMs: nowMs - 12, bidPrice: 1.23, bidSize: 10, askPrice: 1.25, askSize: 10,
  });
  const exposure = controller.snapshot().exposures[0];
  controller.stop();
  assert.equal(marks, 1);
  assert.equal(exposure?.markPremium, 1.23);
  assert.equal(exposure?.markBidPremium, 1.23);
  assert.equal(exposure?.markAskPremium, 1.25);
  assert.equal(exposure?.markTimestampMs, nowMs - 12);
});

test("REST reconciliation publishes every changed owned option-order state exactly once", async () => {
  const controller = optionController(nowMs, exitRest([], nowMs), new FakeStockStream(), new FakeOptionStream());
  const states: Array<{ order: AlpacaOrder }> = [];
  controller.on("orderReconciled", (event: { order: AlpacaOrder }) => { states.push(event); });
  const opening = filledOpeningOrder("1");
  await controller.reconcile(optionAccount(), [optionPosition("1")], [opening]);
  await controller.reconcile(optionAccount(), [optionPosition("1")], [opening]);
  await controller.reconcile(optionAccount(), [optionPosition("1")], [{ ...opening,
    filled_avg_price: "1.02", updated_at: new Date(nowMs + 1).toISOString() }]);
  controller.stop();
  assert.equal(states.length, 2);
  assert.equal(states[0]?.order.filled_avg_price, "1");
  assert.equal(states[1]?.order.filled_avg_price, "1.02");
});

test("paper short route discovers only today's contract, consumes WebSocket quotes, and sends a bounded long put", async () => {
  const cfg = loadConfig({
    TRADING_MODE: "paper", ALPACA_PAPER: "true", ALPACA_API_KEY: "key", ALPACA_API_SECRET: "secret",
    CRYPTO_SHORT_OPTIONS_ENABLED: "true",
  });
  const stockStream = new FakeStockStream();
  const optionStream = new FakeOptionStream();
  const createBodies: Array<Record<string, unknown>> = [];
  const contractQueries: Array<Record<string, unknown>> = [];
  const order = {
    id: "option-order", client_order_id: "", asset_id: "contract-1", symbol: contract.symbol,
    asset_class: "us_option", qty: "1", notional: null, filled_qty: "0", filled_avg_price: null,
    order_class: "simple", order_type: "limit", type: "limit", side: "buy", time_in_force: "day",
    limit_price: "1.01", stop_price: null, status: "new", created_at: new Date(nowMs).toISOString(),
    updated_at: new Date(nowMs).toISOString(), submitted_at: new Date(nowMs).toISOString(), filled_at: null,
    canceled_at: null, failed_at: null, replaced_at: null, replaced_by: null, replaces: null,
  } satisfies AlpacaOrder;
  const rest = {
    getClock: async () => ({ data: { timestamp: new Date(nowMs).toISOString(), is_open: true, next_open: "", next_close: "" }, status: 200 }),
    listOptionContracts: async (query: Record<string, unknown>) => {
      contractQueries.push(query);
      return { data: { option_contracts: [contract] }, status: 200 };
    },
    getOptionContract: async () => ({ data: contract, status: 200 }),
    createOrder: async (body: Record<string, unknown>) => {
      createBodies.push(body);
      return { data: { ...order, client_order_id: String(body.client_order_id) }, status: 200 };
    },
    cancelOrder: async () => ({ data: undefined, status: 204 }),
    getOrder: async () => ({ data: order, status: 200 }),
  } as unknown as AlpacaRestClient;
  const controller = new CryptoOptionShortController(cfg.optionShort, cfg.credentials, cfg.mode, rest, {
    now: () => nowMs, stockStream, optionStream,
  });
  await controller.reconcile({
    options_trading_level: 2, options_buying_power: "1000",
  } as never, [], []);
  controller.start();
  stockStream.emit("authenticated");
  optionStream.emit("authenticated");
  stockStream.emit("quote", { symbol: "IBIT", timestampMs: nowMs - 50, bidPrice: 49.99, bidSize: 100, askPrice: 50.01, askSize: 100 });
  await nextTurn();
  assert.deepEqual(optionStream.symbols, [contract.symbol]);
  optionStream.emit("subscription", { symbols: optionStream.symbols });
  optionStream.emit("quote", { symbol: contract.symbol, timestampMs: nowMs - 25, bidPrice: .96, bidSize: 20, askPrice: 1, askSize: 20 });

  const plan = await controller.tryOpen({ cryptoSymbol: "BTC/USD", cryptoPrice: 110_000, decisionId: "decision", reason: "bearish" });
  controller.stop();

  assert.equal(contractQueries[0]?.expiration_date, "2026-08-25");
  assert.equal(contractQueries[0]?.type, "put");
  assert.equal(plan?.expirationDate, "2026-08-25");
  assert.equal(plan?.marketData, "ALPACA_WEBSOCKET");
  assert.equal(plan?.maximumPremiumRiskDollars, 101);
  assert.equal(createBodies[0]?.symbol, contract.symbol);
  assert.equal(createBodies[0]?.qty, "1");
  assert.equal(createBodies[0]?.side, "buy");
  assert.equal(createBodies[0]?.time_in_force, "day");
  assert.equal(createBodies[0]?.position_intent, "buy_to_open");
  assert.equal(createBodies[0]?.limit_price, "1.01");
});

test("restart-safe exit management submits stop, target, reversal, mandatory, and emergency closes", async () => {
  const cases = [
    { name: "stop", atMs: nowMs, cryptoPrice: 111_100, bullishReversal: false, quote: true, reason: "UNDERLYING_STOP", type: "limit" },
    { name: "target", atMs: nowMs, cryptoPrice: 108_350, bullishReversal: false, quote: true, reason: "UNDERLYING_TARGET", type: "limit" },
    { name: "reversal", atMs: nowMs, cryptoPrice: 110_000, bullishReversal: true, quote: true, reason: "BULLISH_REVERSAL", type: "limit" },
    { name: "mandatory", atMs: Date.parse("2026-08-25T19:15:00Z"), cryptoPrice: 110_000, bullishReversal: false,
      quote: true, reason: "MANDATORY_0DTE_SESSION_EXIT", type: "limit" },
    { name: "emergency", atMs: Date.parse("2026-08-25T19:25:00Z"), cryptoPrice: 110_000, bullishReversal: false,
      quote: false, reason: "MANDATORY_0DTE_SESSION_EXIT", type: "market" },
  ] as const;

  for (const scenario of cases) {
    const createBodies: Array<Record<string, unknown>> = [];
    const reasons: string[] = [];
    const optionStream = new FakeOptionStream();
    const rest = exitRest(createBodies, scenario.atMs);
    const controller = optionController(scenario.atMs, rest, new FakeStockStream(), optionStream);
    controller.on("decision", (plan: { purpose: string; reason: string }) => {
      if (plan.purpose === "CLOSE_SHORT") reasons.push(plan.reason);
    });
    await controller.reconcile(optionAccount(), [optionPosition("1")], [filledOpeningOrder("1")]);
    if (scenario.quote) emitOptionQuote(optionStream, scenario.atMs);
    await controller.manage({
      cryptoSymbol: "BTC/USD", cryptoPrice: scenario.cryptoPrice, bullishReversal: scenario.bullishReversal,
    });
    controller.stop();

    assert.equal(createBodies.length, 1, scenario.name);
    assert.equal(reasons[0], scenario.reason, scenario.name);
    assert.equal(createBodies[0]?.side, "sell", scenario.name);
    assert.equal(createBodies[0]?.position_intent, "sell_to_close", scenario.name);
    assert.equal(createBodies[0]?.time_in_force, "day", scenario.name);
    assert.equal(createBodies[0]?.type, scenario.type, scenario.name);
  }
});

test("a terminal close remains interlocked until reconciliation and cannot submit a duplicate exit", async () => {
  const atMs = Date.parse("2026-08-25T19:15:00Z");
  const createBodies: Array<Record<string, unknown>> = [];
  let accepted: AlpacaOrder | undefined;
  const optionStream = new FakeOptionStream();
  const rest = {
    ...exitRest(createBodies, atMs),
    createOrder: async (body: Record<string, unknown>) => {
      createBodies.push(body);
      accepted = makeOptionOrder({
        id: "close-order", client_order_id: String(body.client_order_id), symbol: String(body.symbol),
        side: "sell", status: "new", filled_qty: "0", type: String(body.type), order_type: String(body.type),
      });
      return { data: accepted, status: 200 };
    },
    getOrder: async () => ({ data: { ...accepted!, status: "filled", filled_qty: "1" }, status: 200 }),
  } as unknown as AlpacaRestClient;
  const controller = optionController(atMs, rest, new FakeStockStream(), optionStream);
  await controller.reconcile(optionAccount(), [optionPosition("1")], [filledOpeningOrder("1")]);
  emitOptionQuote(optionStream, atMs);

  await controller.manage({ cryptoSymbol: "BTC/USD", cryptoPrice: 110_000, bullishReversal: false });
  await maintenance(controller);
  assert.equal(createBodies.length, 1);
  assert.equal(controller.snapshot().pendingOrders[0]?.status, "filled");

  await controller.reconcile(optionAccount(), [], [filledOpeningOrder("1"), { ...accepted!, status: "filled", filled_qty: "1" }]);
  assert.equal(controller.snapshot().pendingOrders.length, 0);
  assert.equal(controller.snapshot().exposures.length, 0);
  await controller.manage({ cryptoSymbol: "BTC/USD", cryptoPrice: 110_000, bullishReversal: false });
  controller.stop();
  assert.equal(createBodies.length, 1);
});

test("an opening fill stays SETTLING until its Alpaca position is visible", async () => {
  const stockStream = new FakeStockStream();
  const optionStream = new FakeOptionStream();
  let accepted: AlpacaOrder | undefined;
  const rest = {
    getClock: async () => ({ data: { timestamp: new Date(nowMs).toISOString(), is_open: true, next_open: "", next_close: "" }, status: 200 }),
    listOptionContracts: async () => ({ data: { option_contracts: [contract] }, status: 200 }),
    getOptionContract: async () => ({ data: contract, status: 200 }),
    createOrder: async (body: Record<string, unknown>) => {
      accepted = makeOptionOrder({ client_order_id: String(body.client_order_id), symbol: String(body.symbol) });
      return { data: accepted, status: 200 };
    },
    getOrder: async () => ({ data: { ...accepted!, status: "filled", filled_qty: "1" }, status: 200 }),
    getOrderByClientId: async () => ({ data: { ...accepted!, status: "filled", filled_qty: "1" }, status: 200 }),
    cancelOrder: async () => ({ data: undefined, status: 204 }),
  } as unknown as AlpacaRestClient;
  const controller = optionController(nowMs, rest, stockStream, optionStream);
  await controller.reconcile(optionAccount(), [], []);
  readyEntryStreams(stockStream, optionStream, nowMs);
  await nextTurn();
  const plan = await controller.tryOpen({ cryptoSymbol: "BTC/USD", cryptoPrice: 110_000, decisionId: "open", reason: "bearish" });
  assert.ok(plan);
  await maintenance(controller);

  const filled = { ...accepted!, status: "filled", filled_qty: "1" };
  await controller.reconcile(optionAccount(), [], [filled]);
  assert.equal(controller.snapshot().exposures.length, 0);
  assert.equal(controller.snapshot().pendingOrders[0]?.status, "SETTLING");
  assert.equal(await controller.tryOpen({ cryptoSymbol: "BTC/USD", cryptoPrice: 110_000, decisionId: "duplicate", reason: "bearish" }), null);

  await controller.reconcile(optionAccount(), [optionPosition("1")], [filled]);
  controller.stop();
  assert.equal(controller.snapshot().pendingOrders.length, 0);
  assert.equal(controller.snapshot().exposures[0]?.entryCryptoPrice, 110_000);
});

test("an active closing order takes priority over an older opening settlement", async () => {
  const atMs = Date.parse("2026-08-25T19:15:00Z");
  const controller = optionController(atMs, exitRest([], atMs), new FakeStockStream(), new FakeOptionStream());
  const activeClose = makeOptionOrder({
    id: "active-close", client_order_id: "mlce-opt-c-btcusd-2-abcd", side: "sell",
    status: "partially_filled", filled_qty: "1", qty: "2",
  });
  await controller.reconcile(optionAccount(), [], [activeClose, filledOpeningOrder("2")]);
  controller.stop();
  assert.equal(controller.snapshot().pendingOrders.length, 1);
  assert.equal(controller.snapshot().pendingOrders[0]?.alpacaOrderId, "active-close");
  assert.equal(controller.snapshot().pendingOrders[0]?.status, "partially_filled");
});

test("an ambiguous POST is resolved by client order ID without resubmission", async () => {
  const stockStream = new FakeStockStream();
  const optionStream = new FakeOptionStream();
  let clientOrderId = "";
  let clientLookups = 0;
  let submissions = 0;
  const rest = {
    getClock: async () => ({ data: { timestamp: new Date(nowMs).toISOString(), is_open: true, next_open: "", next_close: "" }, status: 200 }),
    listOptionContracts: async () => ({ data: { option_contracts: [contract] }, status: 200 }),
    getOptionContract: async () => ({ data: contract, status: 200 }),
    createOrder: async (body: Record<string, unknown>) => {
      submissions += 1;
      clientOrderId = String(body.client_order_id);
      throw new AlpacaApiError("timeout", 0, undefined, true);
    },
    getOrderByClientId: async () => {
      clientLookups += 1;
      return { data: makeOptionOrder({ id: "resolved", client_order_id: clientOrderId, status: "new" }), status: 200 };
    },
    getOrder: async () => ({ data: makeOptionOrder({ id: "resolved", client_order_id: clientOrderId, status: "new" }), status: 200 }),
    cancelOrder: async () => ({ data: undefined, status: 204 }),
  } as unknown as AlpacaRestClient;
  const controller = optionController(nowMs, rest, stockStream, optionStream);
  await controller.reconcile(optionAccount(), [], []);
  readyEntryStreams(stockStream, optionStream, nowMs);
  await nextTurn();
  assert.equal(await controller.tryOpen({ cryptoSymbol: "BTC/USD", cryptoPrice: 110_000, decisionId: "timeout", reason: "bearish" }), null);
  assert.equal(controller.snapshot().pendingOrders[0]?.status, "UNKNOWN");

  await maintenance(controller);
  controller.stop();
  assert.equal(clientLookups, 1);
  assert.equal(submissions, 1);
  assert.equal(controller.snapshot().pendingOrders[0]?.alpacaOrderId, "resolved");
  assert.equal(controller.snapshot().pendingOrders[0]?.status, "new");
});

test("the routed size multiplier reduces the premium budget without fractional contracts", async () => {
  const stockStream = new FakeStockStream();
  const optionStream = new FakeOptionStream();
  const bodies: Array<Record<string, unknown>> = [];
  const rest = entryRest(bodies, nowMs);
  const controller = optionController(nowMs, rest, stockStream, optionStream);
  await controller.reconcile(optionAccount(), [], []);
  readyEntryStreams(stockStream, optionStream, nowMs);
  await nextTurn();

  assert.equal(await controller.tryOpen({
    cryptoSymbol: "BTC/USD", cryptoPrice: 110_000, decisionId: "small", reason: "bearish", sizeMultiplier: .4,
  }), null);
  assert.equal(bodies.length, 0);
  assert.ok(await controller.tryOpen({
    cryptoSymbol: "BTC/USD", cryptoPrice: 110_000, decisionId: "large-enough", reason: "bearish", sizeMultiplier: .5,
  }));
  controller.stop();
  assert.equal(bodies.length, 1);
});

test("partial close reconciliation exits only the residual owned contract quantity", async () => {
  const atMs = Date.parse("2026-08-25T19:15:00Z");
  const createBodies: Array<Record<string, unknown>> = [];
  const optionStream = new FakeOptionStream();
  const controller = optionController(atMs, exitRest(createBodies, atMs), new FakeStockStream(), optionStream);
  const opening = filledOpeningOrder("2");
  const partialClose = makeOptionOrder({
    id: "partial-close", client_order_id: "mlce-opt-c-btcusd-2-abcd", side: "sell", status: "canceled", filled_qty: "1", qty: "2",
  });
  await controller.reconcile(optionAccount(), [optionPosition("1")], [opening, partialClose]);
  emitOptionQuote(optionStream, atMs);
  await controller.manage({ cryptoSymbol: "BTC/USD", cryptoPrice: 110_000, bullishReversal: false });
  controller.stop();
  assert.equal(controller.snapshot().exposures[0]?.qty, 1);
  assert.equal(createBodies[0]?.qty, "1");
});

test("option terminal statuses retain suspended orders and recognize replaced orders", () => {
  assert.equal(optionOrderIsFinal("suspended"), false);
  assert.equal(optionOrderIsFinal("replaced"), true);
});

test("0DTE options routing is disabled by default and live use has a separate interlock", () => {
  assert.equal(loadConfig({ TRADING_MODE: "replay" }).optionShort.enabled, false);
  assert.throws(() => loadConfig({
    TRADING_MODE: "live", ALPACA_PAPER: "false", ALPACA_API_KEY: "key", ALPACA_API_SECRET: "secret",
    ALLOW_LIVE_TRADING: "true", LIVE_TRADING_CONFIRMATION: "I_UNDERSTAND_LIVE_ORDERS_USE_REAL_MONEY",
    CRYPTO_SHORT_OPTIONS_ENABLED: "true",
  }), /0DTE option shorts require OPTIONS_SHORT_LIVE_CONFIRMATION/);
});

class FakeStockStream extends EventEmitter implements StockQuoteStream {
  public connect(): void {}
  public close(): void {}
  public ready(): boolean { return true; }
}
class FakeOptionStream extends FakeStockStream implements OptionQuoteStream {
  public symbols: string[] = [];
  public setSymbols(symbols: readonly string[]): void { this.symbols = [...symbols]; }
}

function optionController(atMs: number, rest: AlpacaRestClient, stockStream: FakeStockStream,
  optionStream: FakeOptionStream): CryptoOptionShortController {
  const cfg = loadConfig({
    TRADING_MODE: "paper", ALPACA_PAPER: "true", ALPACA_API_KEY: "key", ALPACA_API_SECRET: "secret",
    CRYPTO_SHORT_OPTIONS_ENABLED: "true",
  });
  return new CryptoOptionShortController(cfg.optionShort, cfg.credentials, cfg.mode, rest, {
    now: () => atMs, stockStream, optionStream,
  });
}

function optionAccount(): AlpacaAccount {
  return { options_trading_level: 2, options_buying_power: "1000" } as AlpacaAccount;
}

function optionPosition(qty: string): AlpacaPosition {
  return {
    asset_id: contract.id, symbol: contract.symbol, exchange: "OPRA", asset_class: "us_option", qty,
    avg_entry_price: "1", side: "long", market_value: qty, cost_basis: qty, unrealized_pl: "0",
    unrealized_plpc: "0", current_price: "1", lastday_price: "1",
  };
}

function makeOptionOrder(overrides: Partial<AlpacaOrder> = {}): AlpacaOrder {
  const timestamp = new Date(nowMs).toISOString();
  return {
    id: "option-order", client_order_id: "", asset_id: contract.id, symbol: contract.symbol,
    asset_class: "us_option", qty: "1", notional: null, filled_qty: "0", filled_avg_price: null,
    order_class: "simple", order_type: "limit", type: "limit", side: "buy", time_in_force: "day",
    limit_price: "1.01", stop_price: null, status: "new", created_at: timestamp, updated_at: timestamp,
    submitted_at: timestamp, filled_at: null, canceled_at: null, failed_at: null, replaced_at: null,
    replaced_by: null, replaces: null, ...overrides,
  };
}

function encodedOpeningClientOrderId(entryCryptoPrice = 110_000): string {
  return `mlce-opt-o-btcusd-1-abcd-p${Math.round(entryCryptoPrice * 1_000_000).toString(36)}`;
}

function filledOpeningOrder(qty: string): AlpacaOrder {
  return makeOptionOrder({
    id: "opening", client_order_id: encodedOpeningClientOrderId(), qty, filled_qty: qty, filled_avg_price: "1",
    status: "filled", submitted_at: "2026-08-25T17:00:00Z", created_at: "2026-08-25T17:00:00Z",
  });
}

function emitOptionQuote(stream: FakeOptionStream, atMs: number): void {
  stream.emit("quote", {
    symbol: contract.symbol, timestampMs: atMs - 10, bidPrice: 1, bidSize: 20, askPrice: 1.05, askSize: 20,
  });
}

function readyEntryStreams(stockStream: FakeStockStream, optionStream: FakeOptionStream, atMs: number): void {
  stockStream.emit("authenticated");
  optionStream.emit("authenticated");
  stockStream.emit("quote", {
    symbol: "IBIT", timestampMs: atMs - 20, bidPrice: 49.99, bidSize: 100, askPrice: 50.01, askSize: 100,
  });
  emitOptionQuote(optionStream, atMs);
}

function entryRest(createBodies: Array<Record<string, unknown>>, atMs: number): AlpacaRestClient {
  return {
    getClock: async () => ({ data: { timestamp: new Date(atMs).toISOString(), is_open: true, next_open: "", next_close: "" }, status: 200 }),
    listOptionContracts: async () => ({ data: { option_contracts: [contract] }, status: 200 }),
    getOptionContract: async () => ({ data: contract, status: 200 }),
    createOrder: async (body: Record<string, unknown>) => {
      createBodies.push(body);
      return { data: makeOptionOrder({ client_order_id: String(body.client_order_id), symbol: String(body.symbol) }), status: 200 };
    },
    getOrder: async () => ({ data: makeOptionOrder(), status: 200 }),
    getOrderByClientId: async (clientOrderId: string) => ({ data: makeOptionOrder({ client_order_id: clientOrderId }), status: 200 }),
    cancelOrder: async () => ({ data: undefined, status: 204 }),
  } as unknown as AlpacaRestClient;
}

function exitRest(createBodies: Array<Record<string, unknown>>, atMs: number): AlpacaRestClient {
  return {
    getOptionContract: async () => ({ data: contract, status: 200 }),
    listOptionContracts: async () => ({ data: { option_contracts: [] }, status: 200 }),
    createOrder: async (body: Record<string, unknown>) => {
      createBodies.push(body);
      return { data: makeOptionOrder({
        id: `exit-${createBodies.length}`, client_order_id: String(body.client_order_id), symbol: String(body.symbol),
        side: "sell", type: String(body.type), order_type: String(body.type), status: "new",
        submitted_at: new Date(atMs).toISOString(), created_at: new Date(atMs).toISOString(),
      }), status: 200 };
    },
    getOrder: async () => ({ data: makeOptionOrder(), status: 200 }),
    getOrderByClientId: async (clientOrderId: string) => ({ data: makeOptionOrder({ client_order_id: clientOrderId }), status: 200 }),
    cancelOrder: async () => ({ data: undefined, status: 204 }),
  } as unknown as AlpacaRestClient;
}

async function maintenance(controller: CryptoOptionShortController): Promise<void> {
  await (controller as unknown as { maintain(): Promise<void> }).maintain();
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
