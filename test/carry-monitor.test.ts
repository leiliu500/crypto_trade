import assert from "node:assert/strict";
import test from "node:test";
import { collectCarryPublicSnapshot, carryMonitorReport } from "../src/carry/monitor.js";
import { loadCarryResearchConfig } from "../src/carry/config.js";

test("public snapshot adapter preserves BTC decimal lots and distinguishes dated policy from diagnostics", async () => {
  const nowMs = Date.UTC(2026, 0, 1), calls: string[] = [];
  const spotPair = (min: string) => ({ ordermin: min, costmin: "0.5", lot_decimals: 8, status: "online" });
  const instrument = (base: string, symbol: string, precision: number, extra = {}) => ({ base, symbol,
    quote: "USD", type: "flexible_futures", contractSize: 1, tradeable: true, isExpired: false,
    contractValueTradePrecision: precision, maxPositionSize: 1000, ...extra });
  const ticker = (symbol: string, bid: number) => ({ symbol, bid, ask: bid + 1, bidSize: 1, askSize: 1, fundingRate: .02 });
  const fetcher = (async (url: string, options?: RequestInit) => {
    calls.push(url); assert.equal(options?.method, undefined); assert.equal(options?.headers, undefined);
    let payload: unknown;
    if (url.includes("/instruments")) payload = { result: "success", instruments: [instrument("BTC", "PF_XBTUSD", 4),
      instrument("ETH", "PF_ETHUSD", 3), instrument("ETH", "FF_ETHUSD_260301", 3,
        { lastTradingTime: new Date(nowMs + 59 * 86_400_000).toISOString() })] };
    else if (url.includes("/tickers")) payload = { result: "success", serverTime: new Date(nowMs).toISOString(),
      tickers: [ticker("PF_XBTUSD", 80_000), ticker("PF_ETHUSD", 2500), ticker("FF_ETHUSD_260301", 2550)] };
    else if (url.includes("AssetPairs")) payload = { error: [], result: { XXBTZUSD: spotPair("0.00005"), XETHZUSD: spotPair("0.001") } };
    else {
      const btc = url.includes("XBTUSD"), price = btc ? "80000" : "2500";
      payload = { error: [], result: { [btc ? "XXBTZUSD" : "XETHZUSD"]:
        { bids: [[price, "1", nowMs / 1000]], asks: [[String(Number(price) + 1), "1", nowMs / 1000]] } } };
    }
    return new Response(JSON.stringify(payload), { headers: { date: new Date(nowMs).toUTCString() } });
  }) as typeof fetch;
  const snapshot = await collectCarryPublicSnapshot(fetcher, () => nowMs);
  const report = carryMonitorReport(snapshot, loadCarryResearchConfig().config);
  assert.equal(calls.length, 5);
  const btc = report.rows.find(r => r.base === "BTC" && r.budgetId === "prior-12-usd-research")!;
  assert.equal(btc.economics.matchedQuantityStep, .0001);
  assert.equal(btc.economics.status, "INFEASIBLE");
  assert.ok(btc.economics.minimumPairedGrossUsd! > 16);
  assert.ok(report.rows.some(r => r.datedPolicyEligible && r.economics.status === "FEASIBLE"));
  assert.equal(report.activationAllowed, false);
  const stale = carryMonitorReport({ ...snapshot, collectedAtMs: nowMs + 10_000 }, loadCarryResearchConfig().config);
  assert.ok(stale.rows.every(r => r.economics.status === "INVALID"));
});
