import assert from "node:assert/strict";
import test from "node:test";
import type { AlpacaPosition } from "../src/alpaca/types.js";
import { loadConfig } from "../src/config.js";
import type { AssetRules } from "../src/execution/planner.js";
import { TradingEngine } from "../src/engine/trading-engine.js";

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
