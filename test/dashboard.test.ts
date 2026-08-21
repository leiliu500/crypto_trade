import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { OperationsMonitor } from "../src/dashboard/operations-monitor.js";
import { DashboardServer } from "../src/dashboard/server.js";
import type { EngineOperationalSnapshot } from "../src/engine/trading-engine.js";
import { loadConfig } from "../src/config.js";

test("paper mode can never route to Alpaca's live endpoint", () => {
  assert.throws(() => loadConfig({ ALPACA_API_KEY: "paper-key", ALPACA_API_SECRET: "paper-secret", ALPACA_PAPER: "false", ALLOW_UNTRAINED_EXECUTION: "true" }, "paper"), /Paper mode requires ALPACA_PAPER=true/);
});

test("operations monitor retains an order's full P&L history after the position closes", () => {
  const monitor = new OperationsMonitor();
  monitor.recordEvent("engineError", { message: "sample", apiKey: "must-not-leak", nested: { password: "must-not-leak" } }, 1_699_999_999_999);
  monitor.ingestEngineSnapshot(engineState());
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.overall, "healthy");
  assert.equal(snapshot.entriesAllowed, true);
  assert.equal(snapshot.orders[0]?.fillPercent, 50);
  assert.equal(snapshot.orders[0]?.remainingQty, .5);
  assert.equal(snapshot.orders[0]?.livePosition?.active, true);
  assert.equal(snapshot.orders[0]?.livePosition?.closedAtMs, null);
  assert.equal(snapshot.orders[0]?.livePosition?.unrealizedPnl, 1);
  assert.equal(snapshot.orders[0]?.livePosition?.pnlHistory.length, 1);
  assert.equal(snapshot.positions[0]?.currentPx, 101);
  assert.equal(snapshot.positions[0]?.unrealizedPnl, 1);
  assert.equal(snapshot.markets[0]?.kinematicsReady, false);
  const payload = snapshot.events[0]?.payload as { apiKey: string; nested: { password: string } };
  assert.equal(payload.apiKey, "[REDACTED]");
  assert.equal(payload.nested.password, "[REDACTED]");

  const intermediate = engineState();
  intermediate.generatedAtMs += 800;
  intermediate.markets[0]!.bestBid = 101.5;
  monitor.ingestEngineSnapshot(intermediate);

  const changed = engineState();
  changed.generatedAtMs += 1_500;
  changed.markets[0]!.bestBid = 102;
  monitor.ingestEngineSnapshot(changed);
  const livePosition = monitor.snapshot().orders[0]?.livePosition;
  assert.equal(livePosition?.unrealizedPnl, 2);
  assert.equal(livePosition?.pnlHistory.length, 2);
  assert.equal(livePosition?.pnlHistory[1]?.changePnl, .5);

  const closed = engineState();
  closed.generatedAtMs += 2_000;
  closed.positions = [];
  closed.orders[0]!.status = "CANCELED";
  monitor.ingestEngineSnapshot(closed);
  const retained = monitor.snapshot().orders[0]?.livePosition;
  assert.equal(retained?.active, false);
  assert.equal(retained?.closedAtMs, closed.generatedAtMs);
  assert.equal(retained?.unrealizedPnl, 2);
  assert.equal(retained?.pnlHistory.length, 2);

  const stillClosed = { ...closed, generatedAtMs: closed.generatedAtMs + 5_000 };
  monitor.ingestEngineSnapshot(stillClosed);
  assert.equal(monitor.snapshot().orders[0]?.livePosition?.closedAtMs, closed.generatedAtMs);
  monitor.stop();
});

test("dashboard distinguishes a motion reset from invalid market data", async () => {
  const app = await readFile("src/dashboard/public/app.js", "utf8");
  assert.match(app, /MOTION RESET/);
  assert.match(app, /motion evidence unavailable until the next valid update/);
});

test("dashboard server serves the read-only API, health probe, and local UI", async () => {
  const monitor = new OperationsMonitor();
  monitor.ingestEngineSnapshot(engineState());
  const server = new DashboardServer(monitor, { host: "127.0.0.1", port: 0 });
  const url = await server.start();
  try {
    const [api, health, html, app] = await Promise.all([fetch(`${url}/api/dashboard`), fetch(`${url}/healthz`), fetch(url), fetch(`${url}/app.js`)]);
    assert.equal(api.status, 200);
    assert.equal((await api.json() as { orders: unknown[] }).orders.length, 1);
    assert.equal(health.status, 200);
    const htmlText = await html.text();
    assert.match(htmlText, /data-testid="dashboard-root"/);
    assert.match(htmlText, /Orders and live P&amp;L/);
    assert.doesNotMatch(htmlText, /Exit dynamics/);
    const appText = await app.text();
    assert.match(appText, /Closed position P&amp;L history/);
    assert.match(appText, /All P&amp;L changes/);
    assert.match(appText, /order\.livePosition\|\|state\.orderFilter/);
    assert.doesNotMatch(appText, /slice\(-8\)/);
  } finally { await server.stop(); monitor.stop(); }
});

test("PostgreSQL migration defines the complete operational record set", async () => {
  const sql = await readFile("database/migrations/001_initial.sql", "utf8");
  for (const table of ["engine_runs", "system_events", "health_snapshots", "orders", "order_events", "fills", "positions", "position_events", "decisions", "market_snapshots"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
});

function engineState(): EngineOperationalSnapshot {
  const now = 1_700_000_000_000;
  const latency = { p50: 1, p90: 2, p95: 3, p99: 4, max: 5 };
  return {
    generatedAtMs: now, started: true, startedAtMs: now - 10_000, uptimeMs: 10_000, mode: "paper", paper: true,
    paperEntryExercise: false,
    strategyVersion: "test", modelVersion: "test-model", symbols: ["BTC/USD"], equity: 10_000, equityHighWater: 10_100, realizedSessionPnl: 4,
    risk: { health: { publicStream: true, privateStream: true, accountReconciled: true, bookValid: true, clockValid: true, riskRecomputed: true }, reasons: [], equity: 10_000, equityHighWater: 10_100 },
    markets: [{ symbol: "BTC/USD", bookValid: true, bestBid: 101, bestAsk: 102, sequence: "8", exchangeTsMs: now - 2, receiveTsMs: now - 1, features: null }],
    positions: [{ symbol: "BTC/USD", side: 1, qty: 1, entryPx: 100, openedMs: now - 5_000, initialRiskPx: 2, roundTripCostPx: .2,
      mfePx: 2, maePx: .5, floorPx: .2, breakEvenArmed: true, phase: "PROTECTED" }],
    orders: [{
      plan: { clientOrderId: "client-1", decisionId: "decision-1", riskApprovalId: "risk-1", symbol: "BTC/USD", side: 1, qty: 1, limitPx: 101,
        style: "maker", timeInForce: "gtc", createdMs: now - 1_000, expiresMs: now + 1_000, originatingSequence: 8n, featureHash: "hash",
        strategyVersion: "test", modelVersion: "test-model", expectedCost: { roundTripBps: 2, spreadBps: .5, feeBps: 1, impactBps: .1, latencyBps: .2, adverseSelectionBps: .2, fundingBps: 0, borrowBps: 0 },
        risk: { qty: 1, riskBudget: 5, maximumLossPerUnit: 2, modeledMaximumLoss: 2, drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit: "risk" },
        fillProbability: .8, expectedValue: 2, reduceOnlyIntent: false },
      alpacaOrderId: "alpaca-1", status: "PARTIALLY_FILLED", filledQty: .5, averageFillPx: 100.5, lastUpdateMs: now,
    }],
    latency: { feed: latency, compute: latency, send: latency, acknowledgment: latency, fill: latency, total: latency },
  };
}
