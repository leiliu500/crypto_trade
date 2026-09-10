import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

// Explicit-enable distribution mathematics/engine tests remain in their own suites.
// These checks cover the active dashboard after its distribution UI was removed.
const nowMs = 1_800_000_000_000;
const app = await readFile("src/dashboard/public/app.js", "utf8");
const bootstrapStart = app.indexOf('el("symbol-filter").addEventListener');
assert.ok(bootstrapStart > 0, "Dashboard renderer boundary exists");
const renderSource = app.slice(0, bootstrapStart);
const removedPanels = /distribution-market-card|distribution-panel|Executable net-return model|EXECUTABLE RETURN DISTRIBUTIONS|PAPER TRIAL · UNVALIDATED|PAPER ENTRY CHECKS|Training outcomes per action|Prospective selections \/ required|cross-asset-panel|policy-market-card/;

function market(symbol = "BTC/USD") {
  const bitcoin = symbol === "BTC/USD";
  return { symbol, bookValid: true, stale: false, kinematicsReady: true, mid: bitcoin ? 78_000 : 2_450,
    bestBid: bitcoin ? 77_999.5 : 2_449.5, bestAsk: bitcoin ? 78_000.5 : 2_450.5,
    spreadBps: 1, providerAgeMs: 40, localAgeMs: 25, staleThresholdMs: 1_000,
    regime: "TREND_UP", entryReady: true, slowTrendReady: true,
    longScore: 2, shortScore: 0, longPhase: "READY", shortPhase: "WAITING",
    distributional: { paperEnabled: true,
      statistics: { version: "residual-distribution-model", entryMode: "PAPER_TRIAL", completePanels: 999,
        minimumSamples: 48, minimumEffectiveSamples: 32, minimumDays: 7,
        learning: { byAction: [{ symbol, samples: 100 }] }, markets: [{ symbol, ready: true }],
        validation: { selections: 30, observedDays: 8, lowerNetBps: 12, ready: true } },
      decision: { atMs: nowMs, actionId: "long-15m", paperReady: true, entryMode: "PAPER_TRIAL",
        reason: "PAPER_TRIAL_NET_RETURN", estimates: [{ actionId: "long-15m", meanNetBps: 12, scoreBps: 4.5,
          samples: 80, effectiveSamples: 65.5, observedDays: 8, reason: "POSITIVE_DISTRIBUTIONAL_SCORE" }] } },
    policyPulse: { status: "WAITING_FOR_SIGNAL", research: { crossAsset: { paperSubmissionEnabled: true,
      learning: { version: "btc-eth-dynamic-bayes-v1", labelsPerSymbol: 100 },
      forecast: { reason: "POSITIVE_RESEARCH_FORECAST", eligible: true } } } } };
}
function snapshot(overrides: Record<string, unknown> = {}) {
  return { generatedAtMs: nowMs, mode: "paper", paper: true, overall: "healthy", entriesAllowed: false,
    distributionalEngineEnabled: false, policyEngineEnabled: false, crossAssetPaperEntriesEnabled: false,
    equity: 99_876.54, sessionStartingEquity: 100_000, equityHighWater: 100_000, sessionPnl: -123.46,
    realizedPnlMeasurement: "KNOWN", realizedPnl24h: -25, latencyP95Ms: 1, uptimeMs: 3_600_000,
    strategyVersion: "retained-engine", configurationVersion: "disabled-distribution", signalMode: "DETERMINISTIC_ONLY",
    database: { status: "connected", queuedRecords: 0 }, markets: [market(), market("ETH/USD")],
    orders: [], positions: [], events: [], liveness: [], ...overrides };
}
function dashboard(value = snapshot()) {
  const clock = { mono: 0 }, queries: string[] = [];
  const nodes = new Map<string, { innerHTML: string; textContent: string; className: string; value: string; hidden: boolean; style: Record<string, string> }>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: "", textContent: "", className: "", value: "all", hidden: false, style: {} });
    return nodes.get(id)!;
  };
  const context = createContext({ snapshot: value, Date, performance: { now: () => clock.mono },
    document: { getElementById: node, querySelectorAll: (selector: string) => { queries.push(selector); return []; } } });
  runInContext(`${renderSource}\nstate.snapshot=snapshot;state.snapshotReceivedAt=0;render(snapshot);`, context);
  return { clock, node, queries, evaluate: (code: string) => runInContext(code, context),
    allOutput: () => [...nodes.values()].map(node => `${node.textContent}\n${node.innerHTML}`).join("\n") };
}

test("residual ready and paper-trial distribution payloads cannot restore removed dashboard panels", () => {
  for (const entryMode of ["VALIDATED", "PAPER_TRIAL"]) {
    const markets = [market(), market("ETH/USD")];
    for (const m of markets) { m.distributional.statistics.entryMode = entryMode; m.distributional.decision.entryMode = entryMode; }
    const d = dashboard(snapshot({ markets })), html = d.node("market-grid").innerHTML;
    assert.doesNotMatch(d.allOutput(), removedPanels);
    assert.doesNotMatch(html, /residual-distribution-model|long-15m|POSITIVE_DISTRIBUTIONAL_SCORE|Rule state|ENTRY READY|All deterministic gates ready/);
    for (const value of ["BTC/USD", "ETH/USD", "$77,999.50", "$78,000.50", "$2,449.50", "$2,450.50"]) assert.ok(html.includes(value), value);
    assert.match(d.node("market-subtitle").textContent, /BID \/ ASK AND FEED STATUS/);
  }
});

test("active rendering does not consume disabled model or policy objects even if old telemetry remains", () => {
  const markets = [market(), market("ETH/USD")];
  for (const m of markets) for (const key of ["distributional", "policyPulse"]) Object.defineProperty(m, key, {
    get: () => { throw new Error(`Removed ${key} payload must not be read`); }, enumerable: true,
  });
  const d = dashboard(snapshot({ markets, distributionalEngineEnabled: true, policyEngineEnabled: true, crossAssetPaperEntriesEnabled: true }));
  assert.doesNotMatch(d.allOutput(), removedPanels);
  assert.match(d.node("market-grid").innerHTML, /BTC\/USD/); assert.match(d.node("market-grid").innerHTML, /ETH\/USD/);
});

test("futures quote monitoring and its timer retain prices while expiring stale feed claims", () => {
  const d = dashboard(), initial = d.node("market-grid").innerHTML;
  assert.match(initial, /bid/i); assert.match(initial, /ask/i); assert.match(initial, /spread/i); assert.match(initial, /FEED CURRENT/);
  d.clock.mono = 6_000;
  const html = d.evaluate("renderFuturesMarket(state.snapshot.markets[0])") as string;
  assert.match(html, /SNAPSHOT STALE/);
  assert.ok(html.includes("$77,999.50")); assert.ok(html.includes("$78,000.50"));
  assert.doesNotMatch(html, /FEED CURRENT/); assert.doesNotMatch(html, removedPanels);
  d.evaluate("refreshFuturesMarketPanels()");
  assert.equal((d.node("market-grid").innerHTML.match(/SNAPSHOT STALE/g) ?? []).length, 2, "timer refresh ages both visible quote cards");
  assert.doesNotMatch(d.node("market-grid").innerHTML, /FEED CURRENT/);
  assert.ok(d.queries.every(selector => !/distribution|cross-asset|policy-market/.test(selector)));
});

test("distribution UI removal preserves account totals, existing orders and their recorded P&L history", () => {
  const value = snapshot({ orders: [{ clientOrderId: "retained-historical-order", symbol: "BTC/USD", side: 1,
    status: "FILLED", style: "TAKER", timeInForce: "IOC", historical: true, terminal: true,
    requestedQty: .01, filledQty: .01, fillPercent: 100, averageFillPx: 78_000, limitPx: 78_010,
    expectedValue: 0, ageMs: 60_000, createdMs: nowMs - 60_000, updatedMs: nowMs,
    timeline: [{ status: "FILLED", atMs: nowMs - 60_000, label: "Recorded original fill", severity: "info" }],
    livePosition: { active: false, openedMs: nowMs - 60_000, closedAtMs: nowMs, ageMs: 60_000,
      entryPx: 78_000, currentPx: 77_900, realizedPnl: -1.8, realizedPnlBps: -23,
      latestAction: "CLOSED", latestReason: "Historical exit retained",
      pnlHistory: [{ atMs: nowMs - 60_000, currentPx: 78_000, unrealizedPnl: -.4, kind: "open" },
        { atMs: nowMs, currentPx: 77_900, unrealizedPnl: -1.8, kind: "close" }] } }] });
  const before = JSON.stringify(value), d = dashboard(value);
  assert.equal(JSON.stringify(value), before, "view removal cannot mutate ledger or snapshot inputs");
  assert.match(d.node("equity").textContent, /99,876\.54000/);
  assert.match(d.node("session-pnl").textContent, /-\$123\.46000/); assert.match(d.node("rolling-pnl").textContent, /-\$25\.00000/);
  const orders = d.node("orders-grid").innerHTML;
  for (const text of ["retained-historical-order", "HISTORY", "FILLED", "P&amp;L history", "Historical exit retained", "-$1.80000"]) assert.ok(orders.includes(text), text);
  assert.doesNotMatch(d.node("market-grid").innerHTML, removedPanels);
});

test("remaining market text is escaped and malformed residual models cannot break monitoring", () => {
  const m = market('<img src=x onerror="unsafe()">');
  const d = dashboard(snapshot({ markets: [{ ...m, distributional: { decision: null, statistics: null }, policyPulse: null }] }));
  const html = d.node("market-grid").innerHTML;
  assert.doesNotMatch(html, /<img src=x|onerror="unsafe/);
  assert.match(html, /&lt;img/); assert.match(html, /&quot;unsafe\(\)&quot;/); assert.doesNotMatch(html, removedPanels);
});

test("distribution assets are removed while all three views and ETH40 liveness remain", async () => {
  const [html, css] = await Promise.all([readFile("src/dashboard/public/index.html", "utf8"), readFile("src/dashboard/public/styles.css", "utf8")]);
  assert.doesNotMatch(app, /function renderDistributionMarket|renderDistributionMarket\(/);
  assert.doesNotMatch(css, /\.distribution-panel|\.distribution-market-card/);
  assert.doesNotMatch(html, /EXECUTABLE RETURN DISTRIBUTIONS|Executable net-return model/);
  for (const view of ["spot", "eth40", "futures"]) assert.match(html, new RegExp(`id="${view}-view-link"`));
  for (const id of ["spot-system", "eth40-system", "futures-monitoring", "eth40-liveness", "eth40-liveness-grid", "orders-grid", "session-pnl-breakdown"])
    assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /src="\/eth40\.js\?/); assert.match(html, /src="\/spot\.js\?/);
});
