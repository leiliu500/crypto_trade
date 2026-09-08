import assert from "node:assert/strict";
import test from "node:test";
import { loadKrakenFuturesInstruments } from "../src/kraken/paper-broker.js";

test("Kraken decimal quantity precision matches persisted instrument-rule values exactly", async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ result: "success", instruments: [
    { symbol: "PF_XBTUSD", type: "flexible_futures", tradeable: true, tickSize: 1, contractValueTradePrecision: 4, maxPositionSize: 1200 },
    { symbol: "PF_ETHUSD", type: "flexible_futures", tradeable: true, tickSize: .1, contractValueTradePrecision: 3, maxPositionSize: 21000 },
    { symbol: "BOUNDARY", type: "flexible_futures", tradeable: true, tickSize: .01, contractValueTradePrecision: 12, maxPositionSize: 1 },
  ] }), { status: 200 });
  const rules = await loadKrakenFuturesInstruments({ "BTC/USD": "PF_XBTUSD", "ETH/USD": "PF_ETHUSD", boundary: "BOUNDARY" }, fetcher);
  assert.equal(rules.get("BTC/USD")!.quantityIncrement, JSON.parse("0.0001"));
  assert.equal(rules.get("ETH/USD")!.quantityIncrement, .001);
  assert.equal(rules.get("boundary")!.quantityIncrement, .000000000001);
  assert.equal(JSON.stringify(rules.get("BTC/USD")!.quantityIncrement), "0.0001");
});
