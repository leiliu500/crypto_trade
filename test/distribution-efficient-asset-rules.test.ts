import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { DistributionController } from "../src/distribution/controller.js";
import { DISTRIBUTION_SPEC as S } from "../src/distribution/spec.js";
import { TradingEngine } from "../src/engine/trading-engine.js";
import type { AssetRules } from "../src/execution/planner.js";
import { KrakenPaperBroker, type KrakenFuturesInstrumentRules } from "../src/kraken/paper-broker.js";

class MarketStream extends EventEmitter { connect(): void {} close(): void {} reconnectNow(): void {} }
const instruments = new Map<string, KrakenFuturesInstrumentRules>(S.symbols.map((symbol, i) => [symbol, {
  symbol, productId: i ? "PF_ETHUSD" : "PF_XBTUSD", tickSize: i ? .1 : 1,
  quantityIncrement: i ? .001 : .0001, maximumOrderQty: i ? 21_000 : 1200,
}]));
const initialAssets: Record<string, AssetRules> = Object.fromEntries([...instruments].map(([symbol, rule]) => [symbol, {
  symbol, minOrderSize: rule.quantityIncrement, minTradeIncrement: rule.quantityIncrement,
  priceIncrement: rule.tickSize, maximumOrderQty: rule.maximumOrderQty, shortable: true,
}]));
function broker(): KrakenPaperBroker {
  return new KrakenPaperBroker({ initialEquity: 100_000,
    productsBySymbol: { "BTC/USD": "PF_XBTUSD", "ETH/USD": "PF_ETHUSD" }, instruments,
    makerFeeBpsBySymbol: { "BTC/USD": 2, "ETH/USD": 2 }, takerFeeBpsBySymbol: { "BTC/USD": 5, "ETH/USD": 5 } });
}
function config(efficient = true) {
  return loadConfig({ TRADING_MODE: "paper", CONFIG_DIR: "config", CONTINUOUS_RECORDING_ENABLED: "false",
    DISTRIBUTIONAL_ENGINE_ENABLED: "true", DISTRIBUTIONAL_PAPER_ENTRIES_ENABLED: "true",
    DISTRIBUTIONAL_PAPER_TRIAL_ENABLED: "true", DISTRIBUTIONAL_EFFICIENT_TRAINING_ENABLED: String(efficient) });
}

test("Kraken instrument rules remain identical through account reconciliation and efficient quote routing", async t => {
  const paper = broker(), stream = new MarketStream(); let now = 10_000, calls = 0;
  const observe = DistributionController.prototype.onBook;
  t.mock.method(DistributionController.prototype, "onBook", function (this: DistributionController,
    ...args: Parameters<DistributionController["onBook"]>) { calls++; return observe.apply(this, args); });
  const engine = new TradingEngine(config(), { rest: paper, gateway: paper, tradeStream: paper.tradeStream,
    marketStream: stream, now: () => now, distributionalAssets: initialAssets });
  assert.equal(await engine.reconcileAccount(), true);
  const runtimes = (engine as unknown as { runtimes: Map<string, { asset: AssetRules }> }).runtimes;
  for (const symbol of S.symbols) {
    assert.equal((await paper.getAsset(symbol)).data.maximum_order_qty, String(initialAssets[symbol]!.maximumOrderQty));
    assert.deepEqual(runtimes.get(symbol)!.asset, initialAssets[symbol]);
  }
  for (let i = 0; i < 8; i++, now += 250) for (const symbol of S.symbols) {
    const mid = symbol === "BTC/USD" ? 100_000 : 3000;
    assert.doesNotThrow(() => stream.emit("book", { symbol, reset: true, sourceId: `${symbol}:${now}`,
      bids: [{ px: mid - 1, qty: 1 }], asks: [{ px: mid + 1, qty: 1 }], receiveTsMs: now, exchangeTsMs: now }));
  }
  assert.ok(calls > 0, "real engine quote processing reaches the efficient controller with reconciled rules");
  assert.deepEqual((await paper.listOrders({ status: "all" })).data, []);
});

test("supplied invalid venue maxima fail reconciliation and absent maxima preserve legacy broker fallback", async t => {
  const paper = broker(), original = (await paper.listAssets()).data;
  let maximum: string | undefined = "0";
  t.mock.method(paper, "listAssets", async () => ({ status: 200, data: original.map(value => {
    const { maximum_order_qty: _discard, ...asset } = value;
    return { ...asset, ...(maximum === undefined ? {} : { maximum_order_qty: maximum }) };
  }) }));
  const engine = new TradingEngine(config(false), { rest: paper, gateway: paper, tradeStream: paper.tradeStream, now: () => 10_000 });
  for (maximum of ["0", "-1", "NaN", "Infinity", "", "0.00000001"]) assert.equal(await engine.reconcileAccount(), false);
  maximum = undefined;
  assert.equal(await engine.reconcileAccount(), true);
  const runtimes = (engine as unknown as { runtimes: Map<string, { asset: AssetRules }> }).runtimes;
  for (const symbol of S.symbols) assert.equal(runtimes.get(symbol)!.asset.maximumOrderQty,
    Number.MAX_SAFE_INTEGER * initialAssets[symbol]!.minTradeIncrement);
});
