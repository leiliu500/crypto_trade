import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { OperationsMonitor } from "../src/dashboard/operations-monitor.js";
import { DashboardServer } from "../src/dashboard/server.js";
import { compactHealthSnapshot } from "../src/database/postgres-store.js";
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
  assert.equal(snapshot.orders[0]?.configurationVersion, "test-policy");
  assert.equal(snapshot.orders[0]?.regime, "TREND_UP");
  assert.equal(snapshot.orders[0]?.edgeSource, "CALIBRATED");
  assert.equal(snapshot.orders[0]?.edgeEffectiveSampleCount, 150);
  assert.equal(snapshot.orders[0]?.researchOnly, false);
  assert.equal(snapshot.orders[0]?.livePosition?.active, true);
  assert.equal(snapshot.orders[0]?.livePosition?.closedAtMs, null);
  assert.equal(snapshot.orders[0]?.livePosition?.unrealizedPnl, .8);
  assert.ok(Math.abs((snapshot.orders[0]?.livePosition?.unrealizedPnlBps ?? 0) - 80) < 1e-12);
  assert.equal(snapshot.orders[0]?.livePosition?.pnlHistory.length, 1);
  assert.equal(snapshot.positions[0]?.currentPx, 101);
  assert.equal(snapshot.positions[0]?.unrealizedPnl, .8);
  assert.equal(snapshot.sessionStartingEquity, 9_994.5);
  assert.equal(snapshot.sessionRealizedPnl, 4);
  assert.equal(snapshot.sessionUnrealizedPnl, 1.5);
  assert.equal(snapshot.sessionPnl, 5.5);
  assert.equal(snapshot.equity, 10_000);
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
  changed.markets[0]!.bestAsk = 103;
  monitor.ingestEngineSnapshot(changed);
  const changedSnapshot = monitor.snapshot();
  const livePosition = changedSnapshot.orders[0]?.livePosition;
  assert.equal(livePosition?.unrealizedPnl, 1.8);
  assert.equal(livePosition?.pnlHistory.length, 2);
  assert.equal(livePosition?.pnlHistory[1]?.changePnl, .5);
  assert.equal(changedSnapshot.sessionRealizedPnl, 4);
  assert.equal(changedSnapshot.sessionUnrealizedPnl, 2.5);
  assert.equal(changedSnapshot.sessionPnl, 6.5);
  assert.equal(changedSnapshot.equity, 10_001);

  const closed = engineState();
  closed.generatedAtMs += 2_000;
  closed.positions = [];
  closed.orders[0]!.status = "CANCELED";
  monitor.ingestEngineSnapshot(closed);
  const retained = monitor.snapshot().orders[0]?.livePosition;
  assert.equal(retained?.active, false);
  assert.equal(retained?.closedAtMs, closed.generatedAtMs);
  assert.equal(retained?.unrealizedPnl, 1.8);
  assert.equal(retained?.pnlHistory.length, 2);

  const stillClosed = { ...closed, generatedAtMs: closed.generatedAtMs + 5_000 };
  monitor.ingestEngineSnapshot(stillClosed);
  assert.equal(monitor.snapshot().orders[0]?.livePosition?.closedAtMs, closed.generatedAtMs);
  monitor.stop();
});

test("operations monitor emits one authoritative closed-position telemetry record", () => {
  const monitor = new OperationsMonitor({ marketSampleMs: 1_000 });
  const positionTelemetry: Array<Record<string, unknown>> = [];
  monitor.on("telemetry", (record: { kind: string; payload: unknown }) => {
    if (record.kind === "position") positionTelemetry.push(record.payload as Record<string, unknown>);
  });
  const opened = engineState();
  opened.orders[0]!.status = "FILLED";
  opened.orders[0]!.filledQty = 1;
  opened.orders[0]!.averageFillPx = 100;
  monitor.ingestEngineSnapshot(opened);

  const closed = structuredClone(opened);
  closed.generatedAtMs += 100;
  closed.positions = [];
  const entry = closed.orders[0]!;
  closed.orders = [...closed.orders, {
    ...entry,
    plan: { ...entry.plan, clientOrderId: "exit-close-audit", side: -1, reduceOnlyIntent: true,
      exitReason: "EVIDENCE_EXIT", createdMs: closed.generatedAtMs - 50, expiresMs: closed.generatedAtMs + 950 },
    alpacaOrderId: "alpaca-exit-close-audit",
    status: "FILLED",
    filledQty: 1,
    averageFillPx: 99,
    lastUpdateMs: closed.generatedAtMs,
  }];
  monitor.ingestEngineSnapshot(closed);
  monitor.ingestEngineSnapshot({ ...closed, generatedAtMs: closed.generatedAtMs + 100 });
  monitor.stop();

  assert.equal(positionTelemetry.length, 2);
  assert.equal(positionTelemetry[0]?.active, true);
  assert.equal(positionTelemetry[1]?.active, false);
  assert.equal(positionTelemetry[1]?.phase, "CLOSED");
  assert.equal(positionTelemetry[1]?.qty, 0);
  assert.equal(positionTelemetry[1]?.currentPx, 99);
  assert.equal(positionTelemetry[1]?.closedAtMs, closed.generatedAtMs);
  assert.equal(positionTelemetry[1]?.latestReason, "EVIDENCE_EXIT");
});

test("operations monitor bounds default P&L history retained in memory", () => {
  const monitor = new OperationsMonitor({ pnlSampleMs: 0 });
  const state = engineState();
  for (let index = 0; index < 2_050; index += 1) {
    state.generatedAtMs += 1;
    state.markets[0]!.bestBid = 101 + index / 10_000;
    monitor.ingestEngineSnapshot(state);
  }
  assert.equal(monitor.snapshot().positions[0]?.symbol, "BTC/USD");
  assert.equal(monitor.snapshot().orders[0]?.livePosition?.pnlHistory.length, 2_000);
  monitor.stop();
});

test("dashboard broadcast skips serialization when there are no websocket clients", () => {
  const monitor = new OperationsMonitor();
  const server = new DashboardServer(monitor, { host: "127.0.0.1", port: 0 });
  const internals = server as unknown as {
    sockets: { clients: Set<unknown> };
    broadcast: (snapshot: unknown) => void;
  };
  internals.sockets = { clients: new Set() };
  assert.doesNotThrow(() => internals.broadcast({ value: 1n }));
  monitor.stop();
});

test("ordinary database telemetry is sampled and unchanged orders are deduplicated", () => {
  const monitor = new OperationsMonitor({ marketSampleMs: 1_000, healthSampleMs: 10_000 });
  const telemetry: string[] = [];
  monitor.on("telemetry", (record: { kind: string }) => { telemetry.push(record.kind); });
  const first = engineState();
  monitor.ingestEngineSnapshot(first);
  assert.equal(telemetry.filter((kind) => kind === "health").length, 1);
  assert.equal(telemetry.filter((kind) => kind === "market").length, 1);
  assert.equal(telemetry.filter((kind) => kind === "position").length, 1);
  assert.equal(telemetry.filter((kind) => kind === "order").length, 1);

  const rapid = engineState();
  rapid.generatedAtMs = first.generatedAtMs + 100;
  monitor.ingestEngineSnapshot(rapid);
  assert.equal(telemetry.filter((kind) => kind === "health").length, 1);
  assert.equal(telemetry.filter((kind) => kind === "position").length, 1);
  assert.equal(telemetry.filter((kind) => kind === "order").length, 1);

  const marked = engineState();
  marked.generatedAtMs = first.generatedAtMs + 1_000;
  marked.markets[0]!.bestBid = 102;
  marked.markets[0]!.bestAsk = 103;
  monitor.ingestEngineSnapshot(marked);
  assert.equal(telemetry.filter((kind) => kind === "health").length, 1);
  assert.equal(telemetry.filter((kind) => kind === "position").length, 2);
  assert.equal(telemetry.filter((kind) => kind === "order").length, 1);

  marked.generatedAtMs += 100;
  marked.orders[0]!.status = "CANCELED";
  marked.orders[0]!.lastUpdateMs = marked.generatedAtMs;
  monitor.ingestEngineSnapshot(marked);
  assert.equal(telemetry.filter((kind) => kind === "order").length, 2);
  assert.equal(telemetry.filter((kind) => kind === "health").length, 1);

  const sampled = engineState();
  sampled.generatedAtMs = first.generatedAtMs + 2_000;
  sampled.orders[0]!.status = "CANCELED";
  sampled.orders[0]!.lastUpdateMs = marked.orders[0]!.lastUpdateMs;
  monitor.ingestEngineSnapshot(sampled);
  assert.equal(telemetry.filter((kind) => kind === "health").length, 1);
  assert.equal(telemetry.filter((kind) => kind === "market").length, 3);
  assert.equal(telemetry.filter((kind) => kind === "position").length, 3);
  assert.equal(telemetry.filter((kind) => kind === "order").length, 2);

  const healthSample = engineState();
  healthSample.generatedAtMs = first.generatedAtMs + 10_000;
  healthSample.orders[0]!.status = "CANCELED";
  healthSample.orders[0]!.lastUpdateMs = marked.orders[0]!.lastUpdateMs;
  monitor.ingestEngineSnapshot(healthSample);
  assert.equal(telemetry.filter((kind) => kind === "health").length, 2);
  assert.equal(telemetry.filter((kind) => kind === "market").length, 4);
  assert.equal(telemetry.filter((kind) => kind === "position").length, 4);
  assert.equal(telemetry.filter((kind) => kind === "order").length, 2);
  monitor.stop();
});

test("durable health payload excludes high-cardinality dashboard collections", () => {
  const monitor = new OperationsMonitor();
  monitor.ingestEngineSnapshot(engineState());
  const compact = compactHealthSnapshot(monitor.snapshot());
  assert.equal(compact.overall, "healthy");
  assert.deepEqual(compact.database, monitor.snapshot().database);
  for (const field of ["markets", "positions", "orders", "optionShort", "events"]) assert.equal(field in compact, false);
  monitor.stop();
});

test("dashboard resets total session P&L at UTC rollover and carries live equity forward", () => {
  const monitor = new OperationsMonitor();
  const before = engineState();
  monitor.ingestEngineSnapshot(before);
  assert.equal(monitor.snapshot().sessionPnl, 5.5);
  assert.equal(monitor.snapshot().equity, 10_000);

  const nextUtcDay = engineState();
  nextUtcDay.generatedAtMs = Math.floor(before.generatedAtMs / 86_400_000) * 86_400_000 + 86_400_000 + 1_000;
  monitor.ingestEngineSnapshot(nextUtcDay);
  assert.equal(monitor.snapshot().sessionStartingEquity, 10_000);
  assert.equal(monitor.snapshot().sessionRealizedPnl, 0);
  assert.equal(monitor.snapshot().sessionUnrealizedPnl, 0);
  assert.equal(monitor.snapshot().sessionPnl, 0);
  assert.equal(monitor.snapshot().equity, 10_000);

  nextUtcDay.generatedAtMs += 1_000;
  nextUtcDay.markets[0]!.bestBid = 102;
  nextUtcDay.markets[0]!.bestAsk = 103;
  monitor.ingestEngineSnapshot(nextUtcDay);
  assert.equal(monitor.snapshot().sessionRealizedPnl, 0);
  assert.equal(monitor.snapshot().sessionUnrealizedPnl, 1);
  assert.equal(monitor.snapshot().sessionPnl, 1);
  assert.equal(monitor.snapshot().equity, 10_001);
  monitor.stop();
});

test("dashboard does not subtract the prior Kraken UTC session after the broker resets its counter", () => {
  const monitor = new OperationsMonitor();
  const before = engineState();
  before.venue = "kraken_futures";
  before.generatedAtMs = Date.UTC(2026, 7, 27, 23, 59, 59);
  before.positions = [];
  before.orders = [];
  before.equity = 99_994.54782779;
  before.equityHighWater = before.equity;
  before.realizedSessionPnl = -1.43715354;
  monitor.ingestEngineSnapshot(before);

  const afterRollover = structuredClone(before);
  afterRollover.generatedAtMs = Date.UTC(2026, 7, 28, 0, 0, 1);
  afterRollover.realizedSessionPnl = 0;
  monitor.ingestEngineSnapshot(afterRollover);
  assert.equal(monitor.snapshot().sessionStartingEquity, before.equity);
  assert.equal(monitor.snapshot().sessionRealizedPnl, 0);
  assert.equal(monitor.snapshot().sessionPnl, 0);

  const afterTrade = structuredClone(afterRollover);
  afterTrade.generatedAtMs += 1_000;
  afterTrade.realizedSessionPnl = .01100667;
  afterTrade.equity += .01100667;
  monitor.ingestEngineSnapshot(afterTrade);
  assert.ok(Math.abs(monitor.snapshot().sessionRealizedPnl - .01100667) < 1e-12);
  assert.ok(Math.abs(monitor.snapshot().sessionPnl - .01100667) < 1e-12);
  monitor.stop();
});

test("dashboard waits for account reconciliation before locking the UTC opening equity", () => {
  const monitor = new OperationsMonitor();
  const starting = engineState();
  starting.equity = 0;
  starting.equityHighWater = 0;
  starting.risk.equity = 0;
  starting.risk.equityHighWater = 0;
  starting.risk.health.accountReconciled = false;
  monitor.ingestEngineSnapshot(starting);
  assert.equal(monitor.snapshot().equity, 0);

  const reconciled = engineState();
  reconciled.generatedAtMs += 1_000;
  monitor.ingestEngineSnapshot(reconciled);
  assert.equal(monitor.snapshot().sessionStartingEquity, 9_994.5);
  assert.equal(monitor.snapshot().sessionPnl, 5.5);
  assert.equal(monitor.snapshot().equity, 10_000);
  monitor.stop();
});

test("filled reduce-only exit cards inherit complete history and actual realized P&L", () => {
  const monitor = new OperationsMonitor({ pnlSampleMs: 0 });
  const opened = engineState();
  opened.orders[0]!.status = "FILLED";
  opened.orders[0]!.filledQty = 1;
  opened.orders[0]!.averageFillPx = 100;
  monitor.ingestEngineSnapshot(opened);

  const marked = engineState();
  marked.generatedAtMs += 1_500;
  marked.markets[0]!.bestBid = 102;
  marked.orders[0]!.status = "FILLED";
  marked.orders[0]!.filledQty = 1;
  marked.orders[0]!.averageFillPx = 100;
  monitor.ingestEngineSnapshot(marked);

  const closed = engineState();
  closed.generatedAtMs += 2_000;
  closed.markets[0]!.bestBid = 99;
  closed.positions[0]!.qty = 1e-9;
  closed.orders[0]!.status = "FILLED";
  closed.orders[0]!.filledQty = 1;
  closed.orders[0]!.averageFillPx = 100;
  const entryOrder = closed.orders[0]!;
  closed.orders = [...closed.orders, {
    ...entryOrder,
    plan: {
      ...entryOrder.plan,
      clientOrderId: "exit-1",
      side: -1,
      qty: .999999999,
      reduceOnlyIntent: true,
      createdMs: closed.generatedAtMs - 500,
      expiresMs: closed.generatedAtMs + 500,
    },
    alpacaOrderId: "alpaca-exit-1",
    status: "FILLED",
    filledQty: .999999999,
    averageFillPx: 99,
    lastUpdateMs: closed.generatedAtMs,
  }];
  closed.realizedSessionPnl = -1.00994999899505;
  monitor.ingestEngineSnapshot(closed);

  const snapshot = monitor.snapshot();
  monitor.stop();
  const exitCard = snapshot.orders.find((order) => order.clientOrderId === "exit-1")!;
  const entryCard = snapshot.orders.find((order) => order.clientOrderId === "client-1")!;
  assert.equal(exitCard.livePosition?.active, false);
  assert.equal(exitCard.livePosition?.entryOrderId, "client-1");
  assert.equal(exitCard.livePosition?.exitOrderId, "exit-1");
  assert.equal(exitCard.livePosition?.closePx, 99);
  assert.ok(Math.abs((exitCard.livePosition?.realizedPnl ?? 0) + 1.00994999899505) < 1e-10,
    `realized P&L was ${exitCard.livePosition?.realizedPnl}`);
  const breakdown = exitCard.livePosition?.realizedBreakdown;
  assert.ok(breakdown);
  assert.ok(Math.abs(breakdown.grossPricePnl + .999999999) < 1e-12);
  assert.ok(Math.abs(breakdown.entryFee - .004999999995) < 1e-12);
  assert.ok(Math.abs(breakdown.exitFee - .00494999999505) < 1e-12);
  assert.equal(breakdown.entryStyle, "maker");
  assert.equal(breakdown.exitStyle, "maker");
  assert.ok(Math.abs(breakdown.realizedPnl
    - (breakdown.grossPricePnl - breakdown.entryFee - breakdown.exitFee)) < 1e-12);
  assert.equal(snapshot.realizedSessionBreakdown?.tradeCount, 1);
  assert.ok(Math.abs((snapshot.realizedSessionBreakdown?.grossPricePnl ?? 0) - breakdown.grossPricePnl) < 1e-12);
  assert.ok(Math.abs((snapshot.realizedSessionBreakdown?.entryFee ?? 0) - breakdown.entryFee) < 1e-12);
  assert.ok(Math.abs((snapshot.realizedSessionBreakdown?.exitFee ?? 0) - breakdown.exitFee) < 1e-12);
  assert.ok(Math.abs((snapshot.realizedSessionBreakdown?.realizedPnl ?? 0) - breakdown.realizedPnl) < 1e-10,
    `session realized ${snapshot.realizedSessionBreakdown?.realizedPnl} did not match ${breakdown.realizedPnl}`);
  assert.equal(exitCard.livePosition?.pnlHistory.length, 3);
  assert.equal(exitCard.livePosition?.pnlHistory.at(-1)?.kind, "close");
  assert.ok(Math.abs((exitCard.livePosition?.pnlHistory.at(-1)?.changePnl ?? 0) + 2.80994999899505) < 1e-10);
  assert.deepEqual(entryCard.livePosition, exitCard.livePosition);

  const legacyEntry = structuredClone(entryCard);
  const legacyExit = structuredClone(exitCard);
  legacyExit.livePosition = null;
  legacyEntry.livePosition = {
    ...legacyEntry.livePosition!,
    active: false,
    qty: 1e-9,
    currentPx: 99.5,
    unrealizedPnl: -5e-10,
    unrealizedPnlBps: -50,
    realizedPnl: null,
    realizedPnlBps: null,
    realizedBreakdown: null,
    closePx: null,
    exitOrderId: null,
    pnlHistory: [
      ...legacyEntry.livePosition!.pnlHistory.slice(0, -1),
      { atMs: closed.generatedAtMs - 1, currentPx: 99.5, unrealizedPnl: -5e-10, unrealizedPnlBps: -50, changePnl: -2.0000000005, kind: "mark" },
    ],
  };
  const afterReboot = new OperationsMonitor();
  afterReboot.hydrateOrders([legacyExit, legacyEntry]);
  const repairedExit = afterReboot.snapshot().orders.find((order) => order.clientOrderId === "exit-1")!;
  afterReboot.stop();
  assert.ok(Math.abs((repairedExit.livePosition?.realizedPnl ?? 0) + 1.00994999899505) < 1e-10);
  assert.ok(repairedExit.livePosition?.realizedBreakdown);
  assert.equal(repairedExit.livePosition?.pnlHistory.length, 3);
  assert.equal(repairedExit.livePosition?.pnlHistory.at(-1)?.kind, "close");
});

test("closed-trade P&L uses exact asymmetric fees from each execution leg", () => {
  const monitor = new OperationsMonitor();
  const opened = engineState();
  opened.orders[0]!.status = "FILLED";
  opened.orders[0]!.filledQty = 1;
  opened.orders[0]!.averageFillPx = 100;
  opened.orders[0]!.plan.expectedCost = { ...opened.orders[0]!.plan.expectedCost,
    feeBps: 7, entryFeeBps: 2, exitFeeBps: 5 };
  monitor.ingestEngineSnapshot(opened);

  const closed = engineState();
  closed.generatedAtMs += 2_000;
  closed.positions = [];
  const entry = closed.orders[0]!;
  entry.status = "FILLED";
  entry.filledQty = 1;
  entry.averageFillPx = 100;
  entry.plan.expectedCost = { ...entry.plan.expectedCost, feeBps: 7, entryFeeBps: 2, exitFeeBps: 5 };
  closed.orders = [...closed.orders, {
    ...entry,
    plan: { ...entry.plan, clientOrderId: "exact-fee-exit", side: -1, style: "taker", reduceOnlyIntent: true,
      createdMs: closed.generatedAtMs - 500, expiresMs: closed.generatedAtMs + 500,
      expectedCost: { ...entry.plan.expectedCost, feeBps: 10, entryFeeBps: 5, exitFeeBps: 5 } },
    alpacaOrderId: "exact-fee-exit-remote", status: "FILLED", filledQty: 1, averageFillPx: 99,
    lastUpdateMs: closed.generatedAtMs,
  }];
  monitor.ingestEngineSnapshot(closed);
  const breakdown = monitor.snapshot().orders.find((order) => order.clientOrderId === "exact-fee-exit")
    ?.livePosition?.realizedBreakdown;
  monitor.stop();

  assert.ok(breakdown);
  assert.ok(Math.abs(breakdown.entryFee - .02) < 1e-12);
  assert.ok(Math.abs(breakdown.exitFee - .0495) < 1e-12);
  assert.ok(Math.abs(breakdown.realizedPnl + 1.0695) < 1e-12);
});

test("partial exits allocate entry fees once and aggregate as one realized trade", () => {
  const monitor = new OperationsMonitor({ pnlSampleMs: 0 });
  const opened = engineState();
  opened.positions[0]!.qty = 2;
  opened.positions[0]!.entryPx = 100;
  opened.orders[0]!.plan.qty = 2;
  opened.orders[0]!.plan.expectedCost.feeBps = 10;
  opened.orders[0]!.status = "FILLED";
  opened.orders[0]!.filledQty = 2;
  opened.orders[0]!.averageFillPx = 100;
  monitor.ingestEngineSnapshot(opened);

  const reduced = structuredClone(opened);
  reduced.generatedAtMs += 1_000;
  reduced.positions[0]!.qty = 1;
  const entryOrder = reduced.orders[0]!;
  reduced.orders = [...reduced.orders, {
    ...entryOrder,
    plan: { ...entryOrder.plan, clientOrderId: "exit-part-1", side: -1, qty: 1, reduceOnlyIntent: true,
      createdMs: reduced.generatedAtMs - 100, expiresMs: reduced.generatedAtMs + 1_000 },
    alpacaOrderId: "alpaca-exit-part-1", status: "FILLED", filledQty: 1, averageFillPx: 101,
    lastUpdateMs: reduced.generatedAtMs,
  }];
  reduced.realizedSessionPnl = .8995;
  monitor.ingestEngineSnapshot(reduced);

  const closed = structuredClone(reduced);
  closed.generatedAtMs += 1_000;
  closed.positions = [];
  closed.orders = [...closed.orders, {
    ...entryOrder,
    plan: { ...entryOrder.plan, clientOrderId: "exit-part-2", side: -1, qty: 1, reduceOnlyIntent: true,
      createdMs: closed.generatedAtMs - 100, expiresMs: closed.generatedAtMs + 1_000 },
    alpacaOrderId: "alpaca-exit-part-2", status: "FILLED", filledQty: 1, averageFillPx: 102,
    lastUpdateMs: closed.generatedAtMs,
  }];
  closed.realizedSessionPnl = 2.7985;
  monitor.ingestEngineSnapshot(closed);

  const snapshot = monitor.snapshot();
  monitor.stop();
  const firstExit = snapshot.orders.find((order) => order.clientOrderId === "exit-part-1")!;
  const secondExit = snapshot.orders.find((order) => order.clientOrderId === "exit-part-2")!;
  assert.ok(Math.abs((firstExit.livePosition?.realizedBreakdown?.entryFee ?? 0) - .05) < 1e-12);
  assert.ok(Math.abs((secondExit.livePosition?.realizedBreakdown?.entryFee ?? 0) - .05) < 1e-12);
  assert.equal(snapshot.realizedSessionBreakdown?.tradeCount, 1);
  assert.ok(Math.abs((snapshot.realizedSessionBreakdown?.grossPricePnl ?? 0) - 3) < 1e-12);
  assert.ok(Math.abs((snapshot.realizedSessionBreakdown?.entryFee ?? 0) - .1) < 1e-12);
  assert.ok(Math.abs((snapshot.realizedSessionBreakdown?.exitFee ?? 0) - .1015) < 1e-12);
  assert.ok(Math.abs((snapshot.realizedSessionBreakdown?.realizedPnl ?? 0) - 2.7985) < 1e-12);
});

test("dashboard distinguishes a motion reset from invalid market data", async () => {
  const app = await readFile("src/dashboard/public/app.js", "utf8");
  const html = await readFile("src/dashboard/public/index.html", "utf8");
  assert.match(app, /MOTION RESET/);
  assert.match(app, /motion evidence unavailable until the next valid update/);
  assert.match(app, /Estimated net position P&amp;L/);
  assert.match(app, /mark \/ net \/ change/);
  assert.match(app, /Gross price gain/);
  assert.match(app, /Actual realized P&amp;L/);
  assert.match(app, /signedMoney\(breakdown\.grossPricePnl,5\)/);
  assert.match(html, /Total · UTC day/);
  assert.match(html, /id="session-pnl-breakdown"/);
  assert.match(html, /app\.js\?v=20260829-paper-trades-1/);
});

test("option-short tab projects streamed 0DTE P&L changes with entry and exit lifecycle", async () => {
  const monitor = new OperationsMonitor({ maximumPnlHistory: 20 });
  const telemetryKinds: string[] = [];
  monitor.on("telemetry", (record: { kind: string }) => { telemetryKinds.push(record.kind); });
  const opened = engineState();
  opened.generatedAtMs = Date.parse("2026-08-25T18:00:00.000Z");
  opened.optionShort = {
    enabled: true,
    accountReady: true,
    stockStreamReady: true,
    optionStreamReady: true,
    subscribedContracts: 12,
    exposures: [{
      cryptoSymbol: "BTC/USD", proxySymbol: "IBIT", contractSymbol: "IBIT260825P00050000",
      expirationDate: "2026-08-25", qty: 2, averageEntryPremium: 1,
      openedMs: opened.generatedAtMs - 60_000, entryCryptoPrice: 110_000,
      markPremium: 1.12, markBidPremium: 1.12, markAskPremium: 1.14,
      markTimestampMs: opened.generatedAtMs - 20,
    }],
    pendingOrders: [],
  };
  monitor.recordEvent("optionShortDecision", {
    cryptoSymbol: "BTC/USD", contractSymbol: "IBIT260825P00050000", purpose: "OPEN_SHORT",
    clientOrderId: "mlce-opt-open", qty: 2, limitPrice: 1, reason: "BEARISH_CONTINUATION",
  }, opened.generatedAtMs - 60_500);
  monitor.ingestEngineSnapshot(opened);
  let option = monitor.snapshot().optionShort;
  assert.equal(option.ready, true);
  assert.equal(option.currentSessionDate, "2026-08-25");
  assert.equal(option.trades[0]?.currentDay, true);
  assert.equal(option.trades[0]?.currentPremium, 1.12);
  assert.ok(Math.abs((option.trades[0]?.unrealizedPnl ?? 0) - 24) < 1e-10);
  assert.ok(Math.abs((option.trades[0]?.unrealizedPnlBps ?? 0) - 1_200) < 1e-10);
  assert.equal(option.trades[0]?.pnlHistory.length, 1);

  const exiting = engineState();
  exiting.generatedAtMs = opened.generatedAtMs + 500;
  exiting.optionShort = {
    ...opened.optionShort,
    exposures: [{ ...opened.optionShort.exposures[0]!, markPremium: .92, markBidPremium: .92,
      markAskPremium: .94, markTimestampMs: exiting.generatedAtMs - 10 }],
    pendingOrders: [{
      cryptoSymbol: "BTC/USD", contractSymbol: "IBIT260825P00050000", clientOrderId: "mlce-opt-close",
      alpacaOrderId: "alpaca-close", purpose: "CLOSE_SHORT", status: "new", filledQty: 0,
      expiresMs: exiting.generatedAtMs + 2_000,
    }],
  };
  monitor.recordEvent("optionShortDecision", {
    cryptoSymbol: "BTC/USD", contractSymbol: "IBIT260825P00050000", purpose: "CLOSE_SHORT",
    clientOrderId: "mlce-opt-close", qty: 2, limitPrice: .91, reason: "MANDATORY_0DTE_SESSION_EXIT",
  }, exiting.generatedAtMs - 25);
  monitor.ingestEngineSnapshot(exiting);
  option = monitor.snapshot().optionShort;
  assert.ok(Math.abs((option.trades[0]?.unrealizedPnl ?? 0) + 16) < 1e-10);
  assert.equal(option.trades[0]?.pnlHistory.length, 2);
  assert.ok(Math.abs((option.trades[0]?.pnlHistory[1]?.changePnl ?? 0) + 40) < 1e-10);
  assert.equal(option.pendingOrders[0]?.purpose, "CLOSE_SHORT");
  assert.equal(option.pendingOrders[0]?.expirationDate, "2026-08-25");
  assert.equal(option.pendingOrders[0]?.currentDay, true);

  const closed = engineState();
  closed.generatedAtMs = exiting.generatedAtMs + 500;
  closed.optionShort = { ...exiting.optionShort, exposures: [], pendingOrders: [] };
  monitor.ingestEngineSnapshot(closed);
  option = monitor.snapshot().optionShort;
  assert.equal(option.trades[0]?.active, false);
  assert.equal(option.trades[0]?.closedAtMs, closed.generatedAtMs);
  assert.equal(option.trades[0]?.pnlHistory.length, 2);
  assert.ok(telemetryKinds.includes("option_order"));
  assert.ok(telemetryKinds.includes("option_trade"));
  assert.equal(telemetryKinds.filter((kind) => kind === "option_pnl").length, 2);

  const nextSession = structuredClone(closed);
  nextSession.generatedAtMs = Date.parse("2026-08-26T14:00:00.000Z");
  nextSession.optionShort = {
    ...closed.optionShort,
    pendingOrders: [{
      cryptoSymbol: "BTC/USD", contractSymbol: "IBIT260825P00050000", clientOrderId: "stale-option-order",
      alpacaOrderId: "alpaca-stale", purpose: "OPEN_SHORT", status: "new", filledQty: 0,
      expiresMs: nextSession.generatedAtMs + 2_000,
    }],
  };
  monitor.ingestEngineSnapshot(nextSession);
  option = monitor.snapshot().optionShort;
  assert.equal(option.currentSessionDate, "2026-08-26");
  assert.deepEqual(option.trades, []);
  assert.deepEqual(option.pendingOrders, []);
  assert.deepEqual(option.recentActivity, []);
  monitor.stop();

  const [app, html, styles] = await Promise.all([
    readFile("src/dashboard/public/app.js", "utf8"),
    readFile("src/dashboard/public/index.html", "utf8"),
    readFile("src/dashboard/public/styles.css", "utf8"),
  ]);
  assert.match(html, /data-testid="option-shorts-tab"/);
  assert.match(html, /data-testid="option-shorts-panel"[^>]*hidden/);
  assert.match(html, /Trades, P&amp;L, entry and exit/);
  assert.match(app, /data-testid="option-short-trade-card"/);
  assert.match(app, /data-testid="option-live-pnl"/);
  assert.match(app, /data-testid="option-\$\{label\.toLowerCase\(\)\}-leg"/);
  assert.match(app, /streamed bid changes/);
  assert.match(styles, /\.dashboard-tabs/);
});

test("dashboard formats the realized P&L reconciliation at five-decimal USD precision", async () => {
  const app = await readFile("src/dashboard/public/app.js", "utf8");
  const utilitySource = app.slice(0, app.indexOf("function setConnection"));
  const formatted = runInNewContext(`${utilitySource}\nJSON.stringify([
    money(100000.00197408,5),
    signedMoney(1.345881920262224,5),
    signedMoney(-.6814765346049143,5),
    signedMoney(-.6824731453819951,5),
    signedMoney(-.01806775972468533,5)
  ])`) as string;
  assert.equal(formatted, '["$100,000.00197","+$1.34588","-$0.68148","-$0.68247","-$0.01807"]');
  assert.match(app, /money\(s\.equity,5\)/);
  assert.match(app, /money\(s\.sessionStartingEquity,5\)/);

  const breakdownSource = app.slice(
    app.indexOf("function renderRealizedPnlBreakdown"),
    app.indexOf("function renderOrders"),
  );
  const rendered = runInNewContext(`${utilitySource}\n${breakdownSource}\nrenderRealizedPnlBreakdown({
    active:false,
    realizedBreakdown:{
      grossPricePnl:1.345881920262224,
      entryFee:.6814765346049143,
      exitFee:.6824731453819951,
      realizedPnl:-.01806775972468533,
      entryStyle:"maker",
      exitStyle:"maker"
    }
  })`) as string;
  for (const expected of [
    "Gross price gain", "+$1.34588",
    "Entry maker fee", "-$0.68148",
    "Exit maker fee", "-$0.68247",
    "Actual realized P&amp;L", "-$0.01807",
  ]) assert.ok(rendered.includes(expected), `missing ${expected} from ${rendered}`);

  const sessionSource = app.slice(
    app.indexOf("function sessionPnlBreakdownHtml"),
    app.indexOf("function renderLiveness"),
  );
  const sessionRendered = runInNewContext(`${utilitySource}\n${sessionSource}\nsessionPnlBreakdownHtml({
    grossPricePnl:1.345881920262224,
    entryFee:.6814765346049143,
    exitFee:.6824731453819951,
    realizedPnl:-.01806775972468533,
    unrealizedPnl:.25,
    totalPnl:.23193224027531467,
    tradeCount:1,
    entryStyle:"maker",
    exitStyle:"maker"
  })`) as string;
  for (const expected of [
    "Gross price gain", "+$1.34588",
    "Entry maker fee", "-$0.68148",
    "Exit maker fee", "-$0.68247",
    "Realized P&amp;L", "-$0.01807",
    "Open mark P&amp;L", "+$0.25000",
    "Total UTC-day P&amp;L", "+$0.23193",
  ]) assert.ok(sessionRendered.includes(expected), `missing ${expected} from ${sessionRendered}`);
});

test("dashboard fills a complete twenty-minute P&L history with one-minute checkpoints", async () => {
  const app = await readFile("src/dashboard/public/app.js", "utf8");
  const completionSource = app.slice(
    app.indexOf("function completePnlHistory"),
    app.indexOf("function renderLivePnl"),
  );
  const result = runInNewContext(`${completionSource}\n(()=>{
    const points=completePnlHistory({
      openedMs:0,
      closedAtMs:1216551,
      ageMs:1216551,
      pnlHistory:[
        {atMs:0,currentPx:100,unrealizedPnl:0,unrealizedPnlBps:0,changePnl:null,kind:"mark"},
        {atMs:1216551,currentPx:101,unrealizedPnl:1,unrealizedPnlBps:100,changePnl:1,kind:"close"}
      ]
    });
    const gaps=points.slice(1).map((point,index)=>point.atMs-points[index].atMs);
    return JSON.stringify({
      pointCount:points.length,
      checkpointCount:points.filter(point=>point.kind==="checkpoint").length,
      firstAtMs:points[0].atMs,
      lastAtMs:points.at(-1).atMs,
      lastKind:points.at(-1).kind,
      maximumGapMs:Math.max(...gaps)
    });
  })()`) as string;
  assert.equal(result, '{"pointCount":22,"checkpointCount":20,"firstAtMs":0,"lastAtMs":1216551,"lastKind":"close","maximumGapMs":60000}');
  assert.match(app, /One-minute carry-forward checkpoint/);
  assert.match(app, /P&amp;L history · \$\{historyCoverage\} covered/);
  assert.match(app, /const displayedHistory=historyPoints\.slice\(\)\.reverse\(\)/);
});

test("dashboard uses adaptive price precision for micro-priced assets", async () => {
  const app = await readFile("src/dashboard/public/app.js", "utf8");
  const utilitySource = app.slice(0, app.indexOf("function setConnection"));
  assert.equal(runInNewContext(`${utilitySource}\nJSON.stringify([priceDigits(76808),priceDigits(78.5),priceDigits(.22),priceDigits(.000004025)])`), "[2,4,4,8]");
  const pepe = runInNewContext(`${utilitySource}\npriceMoney(.000004025)`) as string;
  assert.match(pepe, /0\.00000403/);
  assert.match(app, /priceMoney\(m\.mid\)/);
  assert.doesNotMatch(app, /m\.mid>1000\?2:4/);
});

test("dashboard assets provide a phone-safe layout", async () => {
  const [html, styles, app] = await Promise.all([
    readFile("src/dashboard/public/index.html", "utf8"),
    readFile("src/dashboard/public/styles.css", "utf8"),
    readFile("src/dashboard/public/app.js", "utf8"),
  ]);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /name="theme-color"/);
  assert.match(styles, /@media\(max-width:600px\)/);
  assert.match(styles, /safe-area-inset-left/);
  assert.match(styles, /\.event-table thead\{display:none\}/);
  assert.match(styles, /\.orders-grid\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(styles, /\.order-live-pnl\.closed \.pnl-history\{max-height:none;overflow:visible\}/);
  assert.match(app, /data-label="Context"/);
});

test("dashboard groups one trade into one card while keeping standalone order filters strict", async () => {
  const app = await readFile("src/dashboard/public/app.js", "utf8");
  const utilitySource = app.slice(0, app.indexOf("function setConnection"));
  const matches = runInNewContext(`${utilitySource}\nJSON.stringify({
    openWorking: orderMatchesFilter({terminal:false,livePosition:{active:true}}, "open"),
    openFilled: orderMatchesFilter({terminal:true,livePosition:{active:true}}, "open"),
    terminalWorking: orderMatchesFilter({terminal:false,livePosition:{active:true}}, "terminal"),
    terminalFilled: orderMatchesFilter({terminal:true,livePosition:{active:true}}, "terminal"),
    allFilled: orderMatchesFilter({terminal:true,livePosition:{active:true}}, "all")
  })`) as string;
  assert.equal(matches, '{"openWorking":true,"openFilled":false,"terminalWorking":false,"terminalFilled":true,"allFilled":true}');
  const groupingSource = app.slice(
    app.indexOf("function groupOrderCards"),
    app.indexOf("function renderOrderTimeline"),
  );
  const grouped = runInNewContext(`${utilitySource}\n${groupingSource}\n(()=>{
    const closed={active:false,entryOrderId:"entry-1",exitOrderId:"exit-1"};
    const cards=groupOrderCards([
      {clientOrderId:"attempt-1",terminal:true,livePosition:null},
      {clientOrderId:"exit-1",createdMs:3,updatedMs:3,terminal:true,reduceOnlyIntent:true,livePosition:closed},
      {clientOrderId:"exit-partial",createdMs:2,updatedMs:2,terminal:true,reduceOnlyIntent:true,livePosition:closed},
      {clientOrderId:"entry-1",createdMs:1,updatedMs:1,terminal:true,reduceOnlyIntent:false,livePosition:closed}
    ]);
    const trade=cards.find(card=>card.kind==="trade");
    const activeCards=groupOrderCards([{clientOrderId:"entry-2",terminal:true,livePosition:{active:true,entryOrderId:"entry-2",exitOrderId:null}}]);
    return JSON.stringify({
      cardCount:cards.length,
      tradeCount:cards.filter(card=>card.kind==="trade").length,
      attemptCount:cards.filter(card=>card.kind==="order").length,
      entryId:trade.entry.clientOrderId,
      exitId:trade.exit.clientOrderId,
      entryLegs:trade.entries.length,
      exitLegs:trade.exits.length,
      closedInTerminal:dashboardCardMatchesFilter(trade,"terminal"),
      closedInOpen:dashboardCardMatchesFilter(trade,"open"),
      activeInOpen:dashboardCardMatchesFilter(activeCards[0],"open")
    });
  })()`) as string;
  assert.equal(grouped, '{"cardCount":2,"tradeCount":1,"attemptCount":1,"entryId":"entry-1","exitId":"exit-1","entryLegs":1,"exitLegs":2,"closedInTerminal":true,"closedInOpen":false,"activeInOpen":true}');
  assert.match(app, /data-testid="trade-card"/);
  assert.match(app, /renderOrderLeg\(card\.entries\[0\]\|\|entry,"Entry"\)/);
  assert.match(app, /`Exit \$\{index\+1\}`/);
  assert.doesNotMatch(app, /clientOrderId\.slice\(0,24\)/);
});

test("operations monitor exposes structured cancellation reasons in order cards and timelines", () => {
  const monitor = new OperationsMonitor();
  const state = engineState();
  state.positions = [];
  state.orders[0]!.status = "CANCELED";
  state.orders[0]!.filledQty = 0;
  state.orders[0]!.cancelRequestReason = "SIGNAL_INVALIDATED";
  state.orders[0]!.cancellationReason = "SIGNAL_INVALIDATED";
  monitor.recordEvent("orderCancelRequested", {
    symbol: "BTC/USD", clientOrderId: "client-1", reason: "SIGNAL_INVALIDATED",
  }, state.generatedAtMs - 1);
  monitor.ingestEngineSnapshot(state);
  const order = monitor.snapshot().orders[0];
  assert.equal(order?.statusLabel, "Signal invalidated");
  assert.equal(order?.cancelRequestReason, "SIGNAL_INVALIDATED");
  assert.equal(order?.cancellationReason, "SIGNAL_INVALIDATED");
  assert.equal(order?.timeline.some((item) => item.label.includes("SIGNAL_INVALIDATED")), true);
  monitor.stop();
});

test("order cards stay in reverse creation-time order when an older order updates later", () => {
  const monitor = new OperationsMonitor();
  const state = engineState();
  state.positions = [];
  const template = state.orders[0]!;
  state.orders = [
    {
      ...template,
      plan: { ...template.plan, clientOrderId: "older-order", createdMs: state.generatedAtMs - 5_000 },
      lastUpdateMs: state.generatedAtMs + 1_000,
    },
    {
      ...template,
      plan: { ...template.plan, clientOrderId: "newest-order", createdMs: state.generatedAtMs - 1_000 },
      lastUpdateMs: state.generatedAtMs,
    },
  ];
  monitor.ingestEngineSnapshot(state);
  assert.deepEqual(monitor.snapshot().orders.map((order) => order.clientOrderId), ["newest-order", "older-order"]);
  monitor.stop();
});

test("dashboard only exposes orders and events from the current UTC session", () => {
  const monitor = new OperationsMonitor();
  const priorSession = engineState();
  priorSession.generatedAtMs = Date.parse("2026-08-29T23:59:59.000Z");
  priorSession.positions = [];
  priorSession.orders[0]!.plan.createdMs = priorSession.generatedAtMs - 1_000;
  priorSession.orders[0]!.plan.expiresMs = priorSession.generatedAtMs + 1_000;
  priorSession.orders[0]!.lastUpdateMs = priorSession.generatedAtMs;
  monitor.recordEvent("engineError", { message: "prior session" }, priorSession.generatedAtMs);
  monitor.ingestEngineSnapshot(priorSession);
  monitor.hydrateOrders(monitor.snapshot().orders);

  const currentSession = structuredClone(priorSession);
  currentSession.generatedAtMs = Date.parse("2026-08-30T00:00:01.000Z");
  currentSession.orders = [{
    ...currentSession.orders[0]!,
    plan: {
      ...currentSession.orders[0]!.plan,
      clientOrderId: "current-session-order",
      createdMs: currentSession.generatedAtMs - 500,
      expiresMs: currentSession.generatedAtMs + 500,
    },
    lastUpdateMs: currentSession.generatedAtMs,
  }];
  monitor.recordEvent("engineError", { message: "current session" }, currentSession.generatedAtMs);
  monitor.ingestEngineSnapshot(currentSession);

  const snapshot = monitor.snapshot();
  assert.deepEqual(snapshot.orders.map((order) => order.clientOrderId), ["current-session-order"]);
  assert.deepEqual(snapshot.events.map((event) => (event.payload as { message: string }).message), ["current session"]);
  monitor.stop();
});

test("hydrated database orders retain their full card details after an engine reboot", () => {
  const beforeReboot = new OperationsMonitor();
  beforeReboot.ingestEngineSnapshot(engineState());
  const persisted = beforeReboot.snapshot().orders[0]!;

  const afterReboot = new OperationsMonitor();
  afterReboot.hydrateOrders([persisted]);
  let rewrittenHistoricalOrders = 0;
  afterReboot.on("telemetry", (record: { kind: string }) => {
    if (record.kind === "order") rewrittenHistoricalOrders += 1;
  });
  const rebootedState = engineState();
  rebootedState.orders = [];
  rebootedState.positions = [];
  afterReboot.ingestEngineSnapshot(rebootedState);

  const restored = afterReboot.snapshot().orders[0];
  assert.equal(restored?.clientOrderId, persisted.clientOrderId);
  assert.equal(restored?.historical, true);
  assert.equal(restored?.status, persisted.status);
  assert.deepEqual(restored?.expectedCost, persisted.expectedCost);
  assert.deepEqual(restored?.timeline, persisted.timeline);
  assert.deepEqual(restored?.livePosition?.pnlHistory, persisted.livePosition?.pnlHistory);
  assert.equal(rewrittenHistoricalOrders, 0);
  beforeReboot.stop();
  afterReboot.stop();
});

test("dashboard server serves the read-only API, health probe, and browser routes", async () => {
  const monitor = new OperationsMonitor();
  monitor.ingestEngineSnapshot(engineState());
  const server = new DashboardServer(monitor, { host: "127.0.0.1", port: 0 });
  const url = await server.start();
  try {
    const [api, health, html, dashboardAlias, browserRoute, app, missingApi, missingAsset] = await Promise.all([
      fetch(`${url}/api/dashboard`),
      fetch(`${url}/healthz`),
      fetch(url),
      fetch(`${url}/dashboard`),
      fetch(`${url}/phone`, { headers: { accept: "text/html" } }),
      fetch(`${url}/app.js`),
      fetch(`${url}/api/missing`, { headers: { accept: "text/html" } }),
      fetch(`${url}/missing.js`, { headers: { accept: "text/html" } }),
    ]);
    assert.equal(api.status, 200);
    assert.equal((await api.json() as { orders: unknown[] }).orders.length, 1);
    assert.equal(health.status, 200);
    const htmlText = await html.text();
    assert.match(htmlText, /data-testid="dashboard-root"/);
    assert.match(htmlText, /Trades and order attempts/);
    assert.match(htmlText, /app\.js\?v=20260829-paper-trades-1/);
    assert.doesNotMatch(htmlText, /Exit dynamics/);
    assert.equal(dashboardAlias.status, 200);
    assert.match(await dashboardAlias.text(), /data-testid="dashboard-root"/);
    assert.equal(browserRoute.status, 200);
    assert.match(await browserRoute.text(), /data-testid="dashboard-root"/);
    assert.equal(missingApi.status, 404);
    assert.equal(missingAsset.status, 404);
    const appText = await app.text();
    assert.match(appText, /Realized trade P&amp;L/);
    assert.match(appText, /P&amp;L history · \$\{historyCoverage\} covered/);
    assert.match(appText, /groupOrderCards\(items\)/);
    assert.match(appText, /data-testid="trade-card"/);
    assert.match(appText, /o\.statusLabel/);
    assert.match(appText, /o\.cancelRequestReason/);
    assert.doesNotMatch(appText, /slice\(-8\)/);
  } finally { await server.stop(); monitor.stop(); }
});

test("PostgreSQL migration defines the complete operational record set", async () => {
  const sql = await readFile("database/migrations/001_initial.sql", "utf8");
  for (const table of ["engine_runs", "system_events", "health_snapshots", "orders", "order_events", "fills", "positions", "position_events", "decisions", "market_snapshots"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  const cancellationSql = await readFile("database/migrations/002_order_cancellation_reasons.sql", "utf8");
  assert.match(cancellationSql, /cancel_request_reason text/);
  assert.match(cancellationSql, /cancellation_reason text/);
  const optionShortSql = await readFile("database/migrations/003_option_short_lifecycle.sql", "utf8");
  for (const table of ["option_short_orders", "option_short_order_events", "option_short_trades", "option_short_pnl_events"]) {
    assert.match(optionShortSql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(optionShortSql, /source_event_id text NOT NULL UNIQUE/);
  assert.match(optionShortSql, /client_order_id text NOT NULL REFERENCES option_short_orders/);
  assert.match(optionShortSql, /trade_key text NOT NULL REFERENCES option_short_trades/);
  assert.match(optionShortSql, /option_short_pnl_trade_time_idx/);
  const compactHealthSql = await readFile("database/migrations/004_compact_health_telemetry.sql", "utf8");
  assert.match(compactHealthSql, /database_queued_records integer/);
  assert.match(compactHealthSql, /database_dropped_records bigint/);
  assert.match(compactHealthSql, /health_snapshots_run_dropped_idx/);
  const closedPositionsSql = await readFile("database/migrations/005_close_position_audit_rows.sql", "utf8");
  assert.match(closedPositionsSql, /phase = 'CLOSED'/);
  assert.match(closedPositionsSql, /closed_at = closed\.closed_at/);
  assert.match(closedPositionsSql, /closed\.closed_at >= position\.updated_at/);
});

function engineState(): EngineOperationalSnapshot {
  const now = 1_700_000_000_000;
  const latency = { count: 5, p50: 1, p90: 2, p95: 3, p99: 4, max: 5 };
  return {
    generatedAtMs: now, started: true, startedAtMs: now - 10_000, uptimeMs: 10_000, mode: "paper", paper: true,
    paperEntryExercise: false,
    strategyVersion: "test", modelVersion: "test-model", symbols: ["BTC/USD"], equity: 10_000, equityHighWater: 10_100, realizedSessionPnl: 4,
    risk: { health: { publicStream: true, privateStream: true, accountReconciled: true, bookValid: true, clockValid: true, riskRecomputed: true }, reasons: [], equity: 10_000, equityHighWater: 10_100 },
    markets: [{ symbol: "BTC/USD", bookValid: true, bestBid: 101, bestAsk: 102, sequence: "8", exchangeTsMs: now - 2, receiveTsMs: now - 1, features: null }],
    positions: [{ symbol: "BTC/USD", side: 1, qty: 1, entryPx: 100, openedMs: now - 5_000, initialRiskPx: 2, roundTripCostPx: .2,
      mfePx: 2, maePx: .5, floorPx: .2, breakEvenArmed: true, phase: "PROTECTED", entryFamily: "CONTINUATION" }],
    orders: [{
      plan: { clientOrderId: "client-1", decisionId: "decision-1", riskApprovalId: "risk-1", symbol: "BTC/USD", side: 1, qty: 1, limitPx: 101,
        style: "maker", timeInForce: "gtc", createdMs: now - 1_000, expiresMs: now + 1_000, originatingSequence: 8n, featureHash: "hash",
        strategyVersion: "test", modelVersion: "test-model", configurationVersion: "test-policy", regime: "TREND_UP",
        edgeSource: "CALIBRATED", edgeEffectiveSampleCount: 150, researchOnly: false,
        conservativeNetEdgeBps: 12, conservativeExpectedValueBps: 4, rewardRiskRatio: .5,
        entryFamily: "CONTINUATION", expectedCost: { roundTripBps: 2, spreadBps: .5, feeBps: 1, impactBps: .1, latencyBps: .2, adverseSelectionBps: .2, fundingBps: 0, borrowBps: 0 },
        risk: { qty: 1, riskBudget: 5, maximumLossPerUnit: 2, modeledMaximumLoss: 2, drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit: "risk" },
        fillProbability: .8, expectedValue: 2, reduceOnlyIntent: false },
      alpacaOrderId: "alpaca-1", status: "PARTIALLY_FILLED", filledQty: .5, averageFillPx: 100.5, lastUpdateMs: now,
    }],
    latency: { feed: latency, compute: latency, send: latency, acknowledgment: latency,
      decisionToVenue: latency, fill: latency, total: latency },
  };
}
