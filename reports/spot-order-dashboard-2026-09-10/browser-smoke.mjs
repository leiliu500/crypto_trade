import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Read-only Chromium/CDP verification. --fixture serves synthetic data on a temporary
// local server; --url visits the deployed dashboard. Neither mode submits orders.
const require = createRequire(join(process.cwd(), "package.json"));
const { WebSocket, WebSocketServer } = require("ws");
const args = process.argv.slice(2);
const argument = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const fixtureMode = args.includes("--fixture");
const output = resolve(argument("--out") ?? "/tmp/spot-browser-smoke");
const chromePath = argument("--chrome") ?? "/home/ec2-user/.cache/ms-playwright/chromium-1187/chrome-linux/chrome";
let url = argument("--url");
if (!fixtureMode && !url) throw new Error("Pass --fixture or --url http://127.0.0.1:3001");
await mkdir(output, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let fixtureServer, fixtureSockets;
const fixtureState = { mode: "healthy" };
const now = Date.now();
const fixtureOrder = (side, status, index, partial = false) => ({
  request: { clientOrderId: `fixture-client-${index}`, side, quantity: .002, limitPrice: 100100,
    createdAtMs: now - 5000 * index, timeInForce: "IOC", reduceOnly: side === "sell" },
  orderId: `fixture-paper-order-${index}`, status, filledQuantity: status === "REJECTED" ? 0 : partial ? .001 : .002,
  averageFillPrice: status === "REJECTED" ? null : 100000, feeUsd: status === "REJECTED" ? 0 : partial ? .8 : 1.6,
  rejectionReason: status === "REJECTED" ? "INSUFFICIENT_CASH" : null,
  cancellationReason: partial ? "IOC_REMAINDER_CANCELED" : null,
  events: [{ type: "SUBMITTED", timestampMs: now - 5000 * index },
    ...(status === "REJECTED" ? [] : [{ type: "ACCEPTED", timestampMs: now - 5000 * index }]),
    ...(partial ? [{ type: "PARTIAL_FILL", timestampMs: now - 5000 * index, detail: "Synthetic browser fixture; no account was changed." }] : []),
    { type: status, timestampMs: now - 5000 * index }],
});
const spotFixture = () => ({
  available: true, generatedAtMs: Date.now(), system: "SYNTHETIC_BROWSER_FIXTURE", mode: "RESEARCH_PAPER",
  liveTradingEnabled: false, orderSubmissionEnabled: true, healthy: fixtureState.mode !== "stale", lastError: fixtureState.mode === "stale" ? "SPOT_PAPER_STATUS_STALE" : null,
  lastSuccessMs: fixtureState.mode === "stale" ? now - 900000 : Date.now(),
  state: { startedAtMs: now - 86400000, lastCycleMs: now, cycles: 288, halted: false,
    account: { cashUsd: 99900, quantity: .001, entryCostUsd: 100, realizedNetUsd: -1.5, feesUsd: 2.5, receipts: [{ id: "fixture-receipt" }] },
    lastSignal: { state: "long", reason: "TREND_ENTER", close: 105000, movingAverage: 99000,
      lastWeekEndMs: Date.UTC(2026, 8, 3), availableAtMs: Date.UTC(2026, 8, 3, 0, 1) },
    lastDecision: { timestampMs: now, action: "hold", reason: "NEXT_WEEK_ENTRY_WINDOW",
      mark: { equityUsd: 100010, liquidationEquityUsd: 100009.12, unrealizedNetUsd: 10.62, netPnlUsd: 9.12 } },
    orders: [fixtureOrder("buy", "FILLED", 1), fixtureOrder("sell", "CANCELED", 2, true), fixtureOrder("buy", "REJECTED", 3)] },
});
const futuresFixture = () => ({ generatedAtMs: Date.now(), mode: "paper", paper: true, overall: "healthy", entriesAllowed: true,
  equity: 100000, sessionStartingEquity: 100000, equityHighWater: 100000, sessionPnl: 0,
  realizedPnlMeasurement: "KNOWN", realizedPnl24h: 0, latencyP95Ms: 1, uptimeMs: 3600000,
  strategyVersion: "SYNTHETIC_BROWSER_FIXTURE", configurationVersion: "fixture", haltReasons: [], liveness: [], markets: [], orders: [], events: [],
  database: { status: "connected", queuedRecords: 0 } });
if (fixtureMode) {
  fixtureServer = createServer(async (request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (path === "/api/dashboard") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(futuresFixture())); return; }
    if (path === "/api/spot-dashboard") { response.setHeader("Content-Type", "application/json"); response.statusCode = fixtureState.mode === "outage" ? 503 : 200; response.end(JSON.stringify(fixtureState.mode === "outage" ? { available: false } : spotFixture())); return; }
    const file = path === "/" ? "index.html" : ["/app.js", "/spot.js", "/styles.css"].includes(path) ? path.slice(1) : null;
    if (!file) { response.statusCode = 404; response.end(); return; }
    response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    response.end(await readFile(join(process.cwd(), "src/dashboard/public", file)));
  });
  fixtureSockets = new WebSocketServer({ server: fixtureServer, path: "/ws" });
  fixtureSockets.on("connection", socket => {
    const send = () => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "snapshot", data: futuresFixture() }));
    send(); const interval = setInterval(send, 1000); socket.on("close", () => clearInterval(interval));
  });
  await new Promise((resolve, reject) => { fixtureServer.once("error", reject); fixtureServer.listen(0, "127.0.0.1", resolve); });
  url = `http://127.0.0.1:${fixtureServer.address().port}`;
}
const profile = await mkdtemp(join(tmpdir(), "spot-ui-chrome-"));
const child = spawn(chromePath, ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--metrics-recording-only", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let socket, sequence = 0, stderr = "";
const pending = new Map(), sessions = new Map();
const report = { generatedAt: new Date().toISOString(), mode: fixtureMode ? "SYNTHETIC_FIXTURE" : "DEPLOYED_READ_ONLY", url, results: [], passed: false };
const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++sequence, timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 10000);
  pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const evaluate = async (sessionId, expression) => {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const waitFor = async (sessionId, expression) => {
  for (let i = 0; i < 100; i++) { if (await evaluate(sessionId, expression)) return; await pause(100); }
  throw new Error(`Browser condition timed out: ${expression}`);
};
const capture = async (sessionId, name, spotOnly = false) => {
  const dimensions = await evaluate(sessionId, `({width:innerWidth,height:Math.min(8000,${spotOnly ? "Math.ceil(document.getElementById('spot-system').getBoundingClientRect().bottom+scrollY+16)" : "document.documentElement.scrollHeight"})})`);
  const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: dimensions.width, height: dimensions.height, scale: 1 } }, sessionId);
  const path = join(output, `${name}.png`); await writeFile(path, Buffer.from(screenshot.data, "base64")); return path;
};
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Chrome startup timeout: ${stderr.slice(-2000)}`)), 15000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Chrome exited ${code}: ${stderr.slice(-2000)}`)); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16000); const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
  });
  socket = new WebSocket(endpoint); await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.on("message", raw => { const message = JSON.parse(raw.toString()); if (message.id) { const entry = pending.get(message.id); if (!entry) return; clearTimeout(entry.timeout); pending.delete(message.id); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); }
    else if (message.method === "Runtime.exceptionThrown") sessions.get(message.sessionId)?.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") sessions.get(message.sessionId)?.consoleErrors.push(message.params.args.map(value => value.value ?? value.description).join(" "));
  });
  for (const viewport of [{ name: "desktop", width: 1440, height: 1100 }, { name: "mobile", width: 390, height: 844 }]) {
    const { targetId } = await command("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await command("Target.attachToTarget", { targetId, flatten: true });
    const state = { errors: [], consoleErrors: [] }; sessions.set(sessionId, state);
    await command("Page.enable", {}, sessionId); await command("Runtime.enable", {}, sessionId);
    await command("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.name === "mobile" }, sessionId);
    await command("Page.navigate", { url }, sessionId);
    await waitFor(sessionId, `document.querySelector('#spot-content .spot-metrics') !== null`);
    await pause(200);
    const observation = await evaluate(sessionId, `(() => {const panel=document.getElementById('spot-system');return {heading:document.getElementById('spot-heading').textContent, orderMode:document.getElementById('spot-order-mode').textContent, exchangeMode:document.getElementById('spot-exchange-mode').textContent, serviceStatus:document.getElementById('spot-service-status').textContent, bodyWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,spotWidth:panel.getBoundingClientRect().width, spotOrders:document.querySelectorAll('.spot-order').length, partialOrders:[...document.querySelectorAll('.spot-order .order-status')].map(x=>x.textContent), values:[...document.querySelectorAll('.spot-metrics .spot-metric')].map(x=>({label:x.querySelector('dt').textContent,value:x.querySelector('dd').textContent})), futuresHeading:document.getElementById('health-title').textContent, scripts:[...document.scripts].map(x=>x.src), bodyText:document.body.innerText.slice(0,16000)}})()`);
    assert.equal(observation.heading, "BTC spot strategy"); assert.ok(observation.bodyWidth <= observation.viewportWidth, `${viewport.name} horizontal overflow: ${observation.bodyWidth}/${observation.viewportWidth}`);
    assert.equal(observation.orderMode, "Paper orders enabled"); assert.equal(observation.exchangeMode, "Live exchange orders disabled");
    assert.ok(observation.scripts.some(script => new URL(script).pathname === "/spot.js"));
    assert.match(observation.futuresHeading, /Futures/); assert.equal(state.errors.length, 0, state.errors.join("\n")); assert.equal(state.consoleErrors.length, 0, state.consoleErrors.join("\n"));
    if (fixtureMode) { assert.equal(observation.spotOrders, 3); assert.ok(observation.partialOrders.includes("PARTIAL FILL · CANCELED")); }
    delete observation.bodyText;
    const sourceStatus = await evaluate(sessionId, `fetch('/api/spot-dashboard',{cache:'no-store'}).then(r=>r.json()).then(s=>({generatedAtMs:s.generatedAtMs,orderSubmissionEnabled:s.orderSubmissionEnabled,liveTradingEnabled:s.liveTradingEnabled,healthy:s.healthy,lastSuccessMs:s.lastSuccessMs,lastDecisionReason:s.state.lastDecision.reason,account:{cashUsd:s.state.account.cashUsd,quantity:s.state.account.quantity,realizedNetUsd:s.state.account.realizedNetUsd,feesUsd:s.state.account.feesUsd},mark:s.state.lastDecision.mark,orderCount:s.state.orders.length,receiptCount:s.state.account.receipts.length}))`);
    assert.equal(observation.spotOrders, Math.min(20, sourceStatus.orderCount));
    assert.equal(observation.values.find(value=>value.label==="Cash").value, sourceStatus.account.cashUsd.toLocaleString("en-US",{style:"currency",currency:"USD"}));
    report.results.push({ viewport, ...observation, sourceStatus, javascriptErrors: state.errors, consoleErrors: state.consoleErrors, screenshot: await capture(sessionId, `${viewport.name}-${fixtureMode ? "fixture" : "deployed"}`), spotScreenshot: await capture(sessionId, `${viewport.name}-${fixtureMode ? "fixture" : "deployed"}-spot`, true) });
    if (fixtureMode && viewport.name === "mobile") {
      fixtureState.mode = "stale"; await waitFor(sessionId, `document.getElementById('spot-service-status').textContent.includes('stale')`);
      assert.equal(await evaluate(sessionId, `document.getElementById('spot-order-mode').textContent`), "Order readiness unknown");
      report.results.push({ scenario: "stale", screenshot: await capture(sessionId, "mobile-stale-fixture") });
      fixtureState.mode = "outage"; await waitFor(sessionId, `document.getElementById('spot-service-status').textContent.includes('unavailable')`);
      assert.equal(await evaluate(sessionId, `document.querySelectorAll('.spot-order').length`), 3);
      report.results.push({ scenario: "outage-retains-last-known", screenshot: await capture(sessionId, "mobile-outage-fixture") });
      fixtureState.mode = "healthy"; await waitFor(sessionId, `document.getElementById('spot-order-mode').textContent === 'Paper orders enabled'`);
      report.results.push({ scenario: "recovered", passed: true });
    }
    await command("Target.closeTarget", { targetId });
  }
  report.passed = true;
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  socket?.close(); for (const entry of pending.values()) clearTimeout(entry.timeout);
  child.kill("SIGTERM"); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once("exit", resolve));
  if (fixtureSockets) { for (const client of fixtureSockets.clients) client.terminate(); fixtureSockets.close(); }
  if (fixtureServer) await new Promise(resolve => fixtureServer.close(resolve));
  try { await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); report.cleanup = { temporaryProfileRemoved: true }; }
  catch (error) { report.cleanup = { temporaryProfileRemoved: false, error: error.message }; process.exitCode = 1; }
  await writeFile(join(output, "browser-report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.passed, output, error: report.error ?? null }));
