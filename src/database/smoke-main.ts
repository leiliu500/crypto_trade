import { Pool } from "pg";
import { loadConfig } from "../config.js";
import type { DashboardEvent, DashboardOptionShortTrade, OptionShortPnlTelemetry } from "../dashboard/types.js";
import { loadLocalEnv } from "../env.js";
import { PostgresTelemetryStore } from "./postgres-store.js";

loadLocalEnv();
const cfg = loadConfig(process.env, "replay");
const store = new PostgresTelemetryStore({ connectionString: cfg.databaseUrl, flushIntervalMs: 50, maximumQueue: 100 });
await store.start({ mode: "replay", paper: true, strategyVersion: cfg.strategyVersion, modelVersion: cfg.modelVersion,
  symbols: cfg.symbols, metadata: { purpose: "database-smoke-test", optionShortLifecycle: true } });
const atMs = Date.now();
const event: DashboardEvent = { id: `smoke-${atMs}`, type: "databaseSmokeTest", severity: "info", atMs,
  symbol: null, clientOrderId: null, summary: "Asynchronous telemetry writer verified", payload: { synthetic: true } };
store.enqueue({ kind: "event", atMs, payload: event });
const expirationDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
  .format(new Date(atMs));
const [year, month, day] = expirationDate.split("-");
const contractSymbol = `IBIT${year!.slice(2)}${month}${day}P00050000`;
const openClientOrderId = `mlce-opt-o-btcusd-${atMs}-smoke`;
const closeClientOrderId = `mlce-opt-c-btcusd-${atMs + 5}-smoke`;
const plan = (purpose: "OPEN_SHORT" | "CLOSE_SHORT", clientOrderId: string, createdMs: number) => ({
  cryptoSymbol: "BTC/USD", proxySymbol: "IBIT", contractSymbol, expirationDate, purpose,
  side: purpose === "OPEN_SHORT" ? "buy" : "sell",
  positionIntent: purpose === "OPEN_SHORT" ? "buy_to_open" : "sell_to_close",
  qty: 1, orderType: "limit", limitPrice: purpose === "OPEN_SHORT" ? 1 : 1.2,
  maximumPremiumRiskDollars: purpose === "OPEN_SHORT" ? 100 : 0,
  clientOrderId, decisionId: `decision-${clientOrderId}`, reason: purpose === "OPEN_SHORT"
    ? "DATABASE_SMOKE_ENTRY" : "DATABASE_SMOKE_EXIT",
  createdMs, expiresMs: createdMs + 2_000, marketData: "ALPACA_WEBSOCKET",
});
const order = (clientOrderId: string, status: string, filledQty: string, averageFillPremium: string | null,
  updatedMs: number) => ({
  id: `alpaca-${clientOrderId}`, client_order_id: clientOrderId, symbol: contractSymbol, asset_class: "us_option",
  qty: "1", filled_qty: filledQty, filled_avg_price: averageFillPremium, side: clientOrderId === openClientOrderId ? "buy" : "sell",
  order_type: "limit", type: "limit", time_in_force: "day", limit_price: clientOrderId === openClientOrderId ? "1" : "1.2",
  status, created_at: new Date(updatedMs - 10).toISOString(), submitted_at: new Date(updatedMs - 5).toISOString(),
  updated_at: new Date(updatedMs).toISOString(),
});
const lifecycle = (id: string, type: string, lifecycleAtMs: number, clientOrderId: string, payload: unknown): DashboardEvent => ({
  id, type, severity: "info", atMs: lifecycleAtMs, symbol: "BTC/USD", clientOrderId,
  summary: `Synthetic ${type}`, payload,
});
const openPlan = plan("OPEN_SHORT", openClientOrderId, atMs + 10);
const closePlan = plan("CLOSE_SHORT", closeClientOrderId, atMs + 50);
for (const item of [
  lifecycle(`smoke-open-decision-${atMs}`, "optionShortDecision", atMs + 10, openClientOrderId, openPlan),
  lifecycle(`smoke-open-accepted-${atMs}`, "optionShortOrderAccepted", atMs + 20, openClientOrderId,
    { plan: openPlan, order: order(openClientOrderId, "new", "0", null, atMs + 20) }),
  lifecycle(`smoke-open-partial-${atMs}`, "optionShortOrderUpdate", atMs + 30, openClientOrderId,
    { id: `private-open-partial-${atMs}`, event: "partial_fill", clientOrderId: openClientOrderId,
      symbol: contractSymbol, filledQty: .5, eventQty: .5, eventPx: 1, timestampMs: atMs + 30 }),
  lifecycle(`smoke-open-fill-${atMs}`, "optionShortOrderReconciled", atMs + 40, openClientOrderId,
    { cryptoSymbol: "BTC/USD", purpose: "OPEN_SHORT", order: order(openClientOrderId, "filled", "1", "1", atMs + 40) }),
  lifecycle(`smoke-close-decision-${atMs}`, "optionShortDecision", atMs + 50, closeClientOrderId, closePlan),
  lifecycle(`smoke-close-accepted-${atMs}`, "optionShortOrderAccepted", atMs + 60, closeClientOrderId,
    { plan: closePlan, order: order(closeClientOrderId, "new", "0", null, atMs + 60) }),
  lifecycle(`smoke-close-cancel-${atMs}`, "optionShortOrderCancelRequested", atMs + 70, closeClientOrderId,
    { order: { cryptoSymbol: "BTC/USD", contractSymbol, clientOrderId: closeClientOrderId,
      alpacaOrderId: `alpaca-${closeClientOrderId}`, purpose: "CLOSE_SHORT", status: "pending_cancel", filledQty: 0,
      expiresMs: atMs + 2_050 }, reason: "DATABASE_SMOKE_CANCEL" }),
  lifecycle(`smoke-close-fill-${atMs}`, "optionShortOrderReconciled", atMs + 80, closeClientOrderId,
    { cryptoSymbol: "BTC/USD", purpose: "CLOSE_SHORT", order: order(closeClientOrderId, "filled", "1", "1.2", atMs + 80) }),
]) store.enqueue({ kind: "event", atMs: item.atMs, payload: item });
store.enqueue({ kind: "decision", atMs: atMs + 10, payload: { type: "optionShortDecision", event: openPlan } });
store.enqueue({ kind: "decision", atMs: atMs + 50, payload: { type: "optionShortDecision", event: closePlan } });
const tradeKey = `${contractSymbol}:${atMs + 40}`;
const trade: DashboardOptionShortTrade = {
  cryptoSymbol: "BTC/USD", proxySymbol: "IBIT", contractSymbol, expirationDate, active: true, closedAtMs: null,
  qty: 1, averageEntryPremium: 1, premiumAtRiskDollars: 100, currentDay: true, openedMs: atMs + 40,
  ageMs: 20, entryCryptoPrice: 110_000, currentPremium: 1.2, quoteAtMs: atMs + 60, quoteAgeMs: 0,
  unrealizedPnl: 20, unrealizedPnlBps: 2_000, pnlHistory: [],
};
store.enqueue({ kind: "option_trade", atMs: atMs + 60, payload: trade });
const pnl: OptionShortPnlTelemetry = { tradeKey, cryptoSymbol: "BTC/USD", contractSymbol,
  point: { atMs: atMs + 60, currentPx: 1.2, unrealizedPnl: 20, unrealizedPnlBps: 2_000, changePnl: 20, kind: "mark" } };
store.enqueue({ kind: "option_pnl", atMs: atMs + 60, payload: pnl });
store.enqueue({ kind: "option_trade", atMs: atMs + 80, payload: { ...trade, active: false, closedAtMs: atMs + 80,
  ageMs: 40, currentPremium: 1.2, quoteAtMs: atMs + 80 } });
await store.flush();
await store.close();

const pool = new Pool({ connectionString: cfg.databaseUrl, max: 1, connectionTimeoutMillis: 5_000, application_name: "crypto-trade-smoke-verifier" });
try {
  const result = await pool.query<{ run_id: string; event_count: string; option_order_count: string;
    lifecycle_count: string; trade_count: string; pnl_count: string; filled_order_count: string; closed_trade_count: string }>(`SELECT r.id::text AS run_id,
      (SELECT count(*)::text FROM system_events e WHERE e.run_id=r.id) AS event_count,
      (SELECT count(*)::text FROM option_short_orders o WHERE o.run_id=r.id) AS option_order_count,
      (SELECT count(*)::text FROM option_short_order_events oe WHERE oe.run_id=r.id) AS lifecycle_count,
      (SELECT count(*)::text FROM option_short_trades t WHERE t.run_id=r.id) AS trade_count,
      (SELECT count(*)::text FROM option_short_pnl_events p WHERE p.run_id=r.id) AS pnl_count,
      (SELECT count(*)::text FROM option_short_orders o WHERE o.run_id=r.id AND o.status='filled') AS filled_order_count,
      (SELECT count(*)::text FROM option_short_trades t WHERE t.run_id=r.id AND t.status='CLOSED') AS closed_trade_count
    FROM engine_runs r
    WHERE r.metadata->>'purpose' = 'database-smoke-test'
    ORDER BY r.started_at DESC LIMIT 1`);
  const row = result.rows[0];
  if (!row || Number(row.event_count) < 1) throw new Error("Database smoke event was not persisted");
  if (Number(row.option_order_count) !== 2 || Number(row.lifecycle_count) !== 8 || Number(row.trade_count) !== 1
    || Number(row.pnl_count) !== 1 || Number(row.filled_order_count) !== 2 || Number(row.closed_trade_count) !== 1) {
    throw new Error(`Option-short lifecycle smoke verification failed: ${JSON.stringify(row)}`);
  }
  process.stdout.write(`${JSON.stringify({ status: "ok", runId: row.run_id, eventCount: Number(row.event_count),
    optionOrderCount: Number(row.option_order_count), lifecycleCount: Number(row.lifecycle_count),
    tradeCount: Number(row.trade_count), pnlCount: Number(row.pnl_count), filledOrderCount: Number(row.filled_order_count),
    closedTradeCount: Number(row.closed_trade_count) })}\n`);
} finally { await pool.end(); }
