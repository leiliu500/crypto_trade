import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import type { AssetRules, ExecutionPlan } from "../src/execution/planner.js";
import type { FillDelta, PrivateOrderEvent } from "../src/execution/order-state.js";
import { TradingEngine } from "../src/engine/trading-engine.js";
import { decodeKrakenFuturesMessage } from "../src/kraken/market-stream.js";
import { KrakenPaperBroker, type KrakenFuturesInstrumentRules } from "../src/kraken/paper-broker.js";

test("Kraken Futures paper configuration needs no funded-account credentials and rejects live routing", () => {
  const cfg = loadConfig({ TRADING_MODE: "paper", TRADING_VENUE: "kraken_futures", CONFIG_DIR: "config" });
  assert.equal(cfg.venue, "kraken_futures");
  assert.equal(cfg.paper, true);
  assert.equal(cfg.credentials.keyId, "");
  assert.deepEqual(cfg.krakenFutures.productsBySymbol, { "BTC/USD": "PF_XBTUSD", "ETH/USD": "PF_ETHUSD" });
  assert.equal(cfg.krakenFutures.paperStateFile, "data/kraken-paper-state.json");
  assert.equal(cfg.symbolConfigs["BTC/USD"]?.cost.makerFeeBps, 2);
  assert.equal(cfg.symbolConfigs["BTC/USD"]?.cost.takerFeeBps, 5);
  assert.throws(() => loadConfig({ TRADING_MODE: "paper", TRADING_VENUE: "kraken_futures", CONFIG_DIR: "config",
    KRAKEN_PAPER_INITIAL_EQUITY: "0" }), /must be positive/);
  assert.throws(() => loadConfig({ TRADING_MODE: "live", TRADING_VENUE: "kraken_futures", CONFIG_DIR: "config" }),
    /live order routing is not implemented/);
  assert.throws(() => loadConfig({ TRADING_MODE: "paper", TRADING_VENUE: "kraken_futures", CONFIG_DIR: "config",
    CRYPTO_SHORT_OPTIONS_ENABLED: "true" }), /incompatible with native Kraken Futures shorts/);
});

test("Kraken Futures book decoder resets from snapshots, preserves exchange sequences, and fails on gaps", () => {
  const symbols = new Map([["PF_XBTUSD", "BTC/USD"]]);
  const sequences = new Map<string, number>();
  const snapshot = decodeKrakenFuturesMessage({ feed: "book_snapshot", product_id: "PF_XBTUSD", seq: 10,
    timestamp: 1_000, bids: [{ price: 100, qty: 2 }], asks: [{ price: 101, qty: 3 }] }, 1_001, symbols, sequences);
  assert.equal(snapshot.kind, "book");
  if (snapshot.kind === "book") {
    assert.equal(snapshot.delta.reset, true);
    assert.deepEqual(snapshot.delta.bids, [{ px: 100, qty: 2 }]);
    assert.deepEqual(snapshot.delta.asks, [{ px: 101, qty: 3 }]);
  }
  const delta = decodeKrakenFuturesMessage({ feed: "book", product_id: "PF_XBTUSD", seq: 11,
    timestamp: 1_010, side: "buy", price: 100, qty: 4 }, 1_011, symbols, sequences);
  assert.equal(delta.kind, "book");
  if (delta.kind === "book") assert.deepEqual(delta.delta.bids, [{ px: 100, qty: 4 }]);
  assert.equal(decodeKrakenFuturesMessage({ feed: "book", product_id: "PF_XBTUSD", seq: 13,
    timestamp: 1_020, side: "sell", price: 101, qty: 1 }, 1_021, symbols, sequences).kind, "sequence_gap");
  const trade = decodeKrakenFuturesMessage({ feed: "trade", product_id: "PF_XBTUSD", uid: "trade-1",
    time: 1_030, side: "sell", price: 100, qty: .25 }, 1_031, symbols, sequences);
  assert.equal(trade.kind, "trade");
  if (trade.kind === "trade") assert.equal(trade.trade.aggressor, -1);
});

test("local Kraken paper broker opens and reduce-only closes a native short through IOC lifecycle events", async () => {
  const instrument: KrakenFuturesInstrumentRules = {
    symbol: "BTC/USD", productId: "PF_XBTUSD", tickSize: 1, quantityIncrement: .001, maximumOrderQty: 1_000,
  };
  const broker = new KrakenPaperBroker({ initialEquity: 100_000, productsBySymbol: { "BTC/USD": "PF_XBTUSD" },
    instruments: new Map([["BTC/USD", instrument]]), makerFeeBpsBySymbol: { "BTC/USD": 0 }, takerFeeBpsBySymbol: { "BTC/USD": 0 } });
  const events: PrivateOrderEvent[] = [];
  broker.tradeStream.on("order", (event: PrivateOrderEvent) => events.push(event));
  broker.onBook({ symbol: "BTC/USD", bids: [{ px: 100, qty: 5 }], asks: [{ px: 101, qty: 5 }], reset: true,
    exchangeTsMs: 1_000, receiveTsMs: 1_001, sourceId: "snapshot" });

  await broker.send(plan("short-entry", -1, 1, 100, false));
  await Promise.resolve();
  const opened = (await broker.listPositions()).data;
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.side, "short");
  assert.equal(opened[0]!.qty, "1");
  assert.equal(events[0]?.event, "fill");
  assert.equal(events[0]?.positionQty, 1);

  await broker.send(plan("short-exit", 1, 1, 101, true));
  await Promise.resolve();
  assert.deepEqual((await broker.listPositions()).data, []);
  assert.equal(events[1]?.event, "fill");
  assert.equal(events[1]?.positionQty, 0);
  assert.equal(Number((await broker.getAccount()).data.equity), 99_999);
  await assert.rejects(() => broker.send(plan("oversized", -1, 1_001, 100, false)), /invalid paper order quantity/);
});

test("local Kraken maker order remains eligible after a partial fill", async () => {
  const instrument: KrakenFuturesInstrumentRules = {
    symbol: "BTC/USD", productId: "PF_XBTUSD", tickSize: 1, quantityIncrement: .001, maximumOrderQty: 1_000,
  };
  const broker = new KrakenPaperBroker({ initialEquity: 100_000, productsBySymbol: { "BTC/USD": "PF_XBTUSD" },
    instruments: new Map([["BTC/USD", instrument]]), makerFeeBpsBySymbol: { "BTC/USD": 0 }, takerFeeBpsBySymbol: { "BTC/USD": 0 } });
  broker.onBook({ symbol: "BTC/USD", bids: [{ px: 100, qty: 0 }], asks: [{ px: 101, qty: 5 }], reset: true,
    exchangeTsMs: 1_000, receiveTsMs: 1_001, sourceId: "snapshot" });
  const makerPlan = { ...plan("maker-entry", 1, 2, 100, false), style: "maker" as const, timeInForce: "gtc" as const };
  const order = await broker.send(makerPlan);
  broker.onTrade({ id: "trade-1", symbol: "BTC/USD", px: 100, qty: 1, aggressor: -1, exchangeTsMs: 1_010, receiveTsMs: 1_011 });
  assert.equal((await broker.getOrder(order.id)).data.status, "partially_filled");
  broker.onTrade({ id: "trade-2", symbol: "BTC/USD", px: 100, qty: 1, aggressor: -1, exchangeTsMs: 1_020, receiveTsMs: 1_021 });
  assert.equal((await broker.getOrder(order.id)).data.status, "filled");
  assert.equal((await broker.listPositions()).data[0]?.qty, "2");
});

test("Kraken paper account survives restart and fail-closed cancels a resting remainder", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "kraken-paper-state-"));
  try {
    const stateFile = join(temporaryDirectory, "account.json");
    const instrument: KrakenFuturesInstrumentRules = {
      symbol: "BTC/USD", productId: "PF_XBTUSD", tickSize: 1, quantityIncrement: .001, maximumOrderQty: 1_000,
    };
    const config = { initialEquity: 100_000, productsBySymbol: { "BTC/USD": "PF_XBTUSD" },
      instruments: new Map([["BTC/USD", instrument]]), makerFeeBpsBySymbol: { "BTC/USD": 0 },
      takerFeeBpsBySymbol: { "BTC/USD": 0 }, stateFile };
    const first = new KrakenPaperBroker(config);
    first.onBook({ symbol: "BTC/USD", bids: [{ px: 100, qty: 5 }], asks: [{ px: 101, qty: 0 }], reset: true,
      exchangeTsMs: 1_000, receiveTsMs: 1_001, sourceId: "snapshot" });
    const makerPlan = { ...plan("durable-short", -1, 2, 101, false), style: "maker" as const, timeInForce: "gtc" as const };
    const order = await first.send(makerPlan);
    first.onTrade({ id: "partial", symbol: "BTC/USD", px: 101, qty: .5, aggressor: 1,
      exchangeTsMs: 1_010, receiveTsMs: 1_011 });
    assert.equal((await first.getOrder(order.id)).data.status, "partially_filled");

    const restarted = new KrakenPaperBroker(config);
    const restoredPosition = (await restarted.listPositions()).data[0];
    assert.equal(restoredPosition?.side, "short");
    assert.equal(restoredPosition?.qty, "0.5");
    const restoredOrder = (await restarted.getOrder(order.id)).data;
    assert.equal(restoredOrder.status, "canceled");
    assert.equal(restoredOrder.filled_qty, "0.5");
    assert.ok(restoredOrder.canceled_at);

    restarted.onBook({ symbol: "BTC/USD", bids: [{ px: 99, qty: 5 }], asks: [{ px: 100, qty: 5 }], reset: true,
      exchangeTsMs: 2_000, receiveTsMs: 2_001, sourceId: "snapshot" });
    await restarted.send(plan("durable-close", 1, .5, 100, true));
    await Promise.resolve();
    assert.deepEqual((await restarted.listPositions()).data, []);
    const afterSecondRestart = new KrakenPaperBroker(config);
    assert.deepEqual((await afterSecondRestart.listPositions()).data, []);
    assert.equal(Number((await afterSecondRestart.getAccount()).data.equity), 100_000.5);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("Kraken paper startup history can anchor to a fresh public REST order book", async () => {
  const instrument: KrakenFuturesInstrumentRules = {
    symbol: "BTC/USD", productId: "PF_XBTUSD", tickSize: 1, quantityIncrement: .001, maximumOrderQty: 1_000,
  };
  const fetcher = (async () => new Response(JSON.stringify({ result: "success", serverTime: "2026-08-26T01:00:00.000Z",
    orderBook: { bids: [[99, 1], [100, 2]], asks: [[102, 4], [101, 3]] } }), { status: 200 })) as typeof fetch;
  const broker = new KrakenPaperBroker({ initialEquity: 100_000, productsBySymbol: { "BTC/USD": "PF_XBTUSD" },
    instruments: new Map([["BTC/USD", instrument]]), makerFeeBpsBySymbol: {}, takerFeeBpsBySymbol: {} }, fetcher);
  const book = (await broker.latestOrderbooks(["BTC/USD"])).data.orderbooks["BTC/USD"];
  assert.equal(book?.t, "2026-08-26T01:00:00.000Z");
  assert.deepEqual(book?.b.slice(0, 2), [{ p: 100, s: 2 }, { p: 99, s: 1 }]);
  assert.deepEqual(book?.a.slice(0, 2), [{ p: 101, s: 3 }, { p: 102, s: 4 }]);
});

test("engine position accounting is symmetric for a profitable short and its buy-to-close fill", () => {
  const engine = new TradingEngine(loadConfig({ TRADING_MODE: "replay", CONFIG_DIR: "config" }), { now: () => 10_000 });
  const internals = engine as unknown as {
    runtimes: Map<string, { asset?: AssetRules }>;
    applyFill: (fill: FillDelta) => void;
  };
  internals.runtimes.get("BTC/USD")!.asset = { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001,
    priceIncrement: 1, maximumOrderQty: 1_000, shortable: true };
  internals.applyFill({ symbol: "BTC/USD", side: -1, qty: 1, price: 100, clientOrderId: "short", final: true, positionQty: 1 });
  assert.equal(engine.state().positions[0]?.side, -1);
  internals.applyFill({ symbol: "BTC/USD", side: 1, qty: 1, price: 90, clientOrderId: "cover", final: true, positionQty: 0 });
  assert.equal(engine.state().positions.length, 0);
  assert.equal(engine.state().realizedSessionPnl, 10);
});

function plan(clientOrderId: string, side: 1 | -1, qty: number, limitPx: number, reduceOnlyIntent: boolean): ExecutionPlan {
  return {
    clientOrderId, decisionId: `${clientOrderId}-decision`, riskApprovalId: `${clientOrderId}-risk`, symbol: "BTC/USD",
    side, qty, limitPx, style: "taker", timeInForce: "ioc", createdMs: 1_000, expiresMs: 2_000,
    originatingSequence: 1n, featureHash: "test", strategyVersion: "test", modelVersion: "none",
    expectedCost: { roundTripBps: 0, spreadBps: 0, feeBps: 0, impactBps: 0, latencyBps: 0,
      adverseSelectionBps: 0, fundingBps: 0, borrowBps: 0 },
    risk: { qty, riskBudget: 1, maximumLossPerUnit: 1, modeledMaximumLoss: qty,
      drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit: "risk" },
    fillProbability: 1, expectedValue: 0, reduceOnlyIntent,
  };
}
