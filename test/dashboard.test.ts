import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
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
  assert.equal(snapshot.orders[0]?.livePosition?.unrealizedPnl, .8);
  assert.ok(Math.abs((snapshot.orders[0]?.livePosition?.unrealizedPnlBps ?? 0) - 80) < 1e-12);
  assert.equal(snapshot.orders[0]?.livePosition?.pnlHistory.length, 1);
  assert.equal(snapshot.positions[0]?.currentPx, 101);
  assert.equal(snapshot.positions[0]?.unrealizedPnl, .8);
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
  assert.equal(livePosition?.unrealizedPnl, 1.8);
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
  assert.equal(retained?.unrealizedPnl, 1.8);
  assert.equal(retained?.pnlHistory.length, 2);

  const stillClosed = { ...closed, generatedAtMs: closed.generatedAtMs + 5_000 };
  monitor.ingestEngineSnapshot(stillClosed);
  assert.equal(monitor.snapshot().orders[0]?.livePosition?.closedAtMs, closed.generatedAtMs);
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
  assert.ok(Math.abs((snapshot.realizedSessionBreakdown?.realizedPnl ?? 0) - breakdown.realizedPnl) < 1e-12);
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
  assert.match(html, /Realized · UTC day/);
  assert.match(html, /id="session-pnl-breakdown"/);
  assert.match(html, /app\.js\?v=20260825-pnl-history-4/);
});

test("dashboard formats the realized P&L reconciliation at five-decimal USD precision", async () => {
  const app = await readFile("src/dashboard/public/app.js", "utf8");
  const utilitySource = app.slice(0, app.indexOf("function setConnection"));
  const formatted = runInNewContext(`${utilitySource}\nJSON.stringify([
    signedMoney(1.345881920262224,5),
    signedMoney(-.6814765346049143,5),
    signedMoney(-.6824731453819951,5),
    signedMoney(-.01806775972468533,5)
  ])`) as string;
  assert.equal(formatted, '["+$1.34588","-$0.68148","-$0.68247","-$0.01807"]');

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
    tradeCount:1,
    entryStyle:"maker",
    exitStyle:"maker"
  })`) as string;
  for (const expected of [
    "Gross price gain", "+$1.34588",
    "Entry maker fee", "-$0.68148",
    "Exit maker fee", "-$0.68247",
    "Actual realized P&amp;L", "-$0.01807",
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
  assert.match(app, /position\.active\?historyPoints\.slice\(\)\.reverse\(\):historyPoints/);
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
      {clientOrderId:"exit-1",terminal:true,livePosition:closed},
      {clientOrderId:"entry-1",terminal:true,livePosition:closed}
    ]);
    const trade=cards.find(card=>card.kind==="trade");
    const activeCards=groupOrderCards([{clientOrderId:"entry-2",terminal:true,livePosition:{active:true,entryOrderId:"entry-2",exitOrderId:null}}]);
    return JSON.stringify({
      cardCount:cards.length,
      tradeCount:cards.filter(card=>card.kind==="trade").length,
      attemptCount:cards.filter(card=>card.kind==="order").length,
      entryId:trade.entry.clientOrderId,
      exitId:trade.exit.clientOrderId,
      closedInTerminal:dashboardCardMatchesFilter(trade,"terminal"),
      closedInOpen:dashboardCardMatchesFilter(trade,"open"),
      activeInOpen:dashboardCardMatchesFilter(activeCards[0],"open")
    });
  })()`) as string;
  assert.equal(grouped, '{"cardCount":2,"tradeCount":1,"attemptCount":1,"entryId":"entry-1","exitId":"exit-1","closedInTerminal":true,"closedInOpen":false,"activeInOpen":true}');
  assert.match(app, /data-testid="trade-card"/);
  assert.match(app, /renderOrderLeg\(entry,"Entry"\)/);
  assert.match(app, /renderOrderLeg\(exit,"Exit"\)/);
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
    assert.match(htmlText, /app\.js\?v=20260825-pnl-history-4/);
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
      mfePx: 2, maePx: .5, floorPx: .2, breakEvenArmed: true, phase: "PROTECTED" }],
    orders: [{
      plan: { clientOrderId: "client-1", decisionId: "decision-1", riskApprovalId: "risk-1", symbol: "BTC/USD", side: 1, qty: 1, limitPx: 101,
        style: "maker", timeInForce: "gtc", createdMs: now - 1_000, expiresMs: now + 1_000, originatingSequence: 8n, featureHash: "hash",
        strategyVersion: "test", modelVersion: "test-model", expectedCost: { roundTripBps: 2, spreadBps: .5, feeBps: 1, impactBps: .1, latencyBps: .2, adverseSelectionBps: .2, fundingBps: 0, borrowBps: 0 },
        risk: { qty: 1, riskBudget: 5, maximumLossPerUnit: 2, modeledMaximumLoss: 2, drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit: "risk" },
        fillProbability: .8, expectedValue: 2, reduceOnlyIntent: false },
      alpacaOrderId: "alpaca-1", status: "PARTIALLY_FILLED", filledQty: .5, averageFillPx: 100.5, lastUpdateMs: now,
    }],
    latency: { feed: latency, compute: latency, send: latency, acknowledgment: latency,
      decisionToVenue: latency, fill: latency, total: latency },
  };
}
