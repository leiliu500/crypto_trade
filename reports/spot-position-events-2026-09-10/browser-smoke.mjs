import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Read-only dynamic position-card Chromium/CDP verification. --fixture serves synthetic data on a temporary
// local server; --url visits the deployed dashboard. Neither mode submits orders.
const require = createRequire(join(process.cwd(), "package.json"));
const { WebSocket, WebSocketServer } = require("ws");
const args = process.argv.slice(2);
const argument = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const fixtureMode = args.includes("--fixture");
const output = resolve(argument("--out") ?? "/tmp/spot-liveness-browser-smoke");
const chromePath = argument("--chrome") ?? "/home/ec2-user/.cache/ms-playwright/chromium-1187/chrome-linux/chrome";
let url = argument("--url");
if (!fixtureMode && !url) throw new Error("Pass --fixture or --url http://127.0.0.1:3001");
await mkdir(output, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let fixtureServer, fixtureSockets;
const now = Date.now();
const fixtureState = { mode: "healthy", cycles: 288, lastCycleMs: now - 17000 };
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
  available: true, generatedAtMs: Date.now(), upstreamFetchedAtMs: fixtureState.mode === "upstream-stale" ? Date.now() - 16000 : Date.now(), system: "SYNTHETIC_BROWSER_FIXTURE", mode: "RESEARCH_PAPER",
  liveTradingEnabled: false, orderSubmissionEnabled: true, healthy: fixtureState.mode !== "stale", lastError: fixtureState.mode === "stale" ? "SPOT_PAPER_STATUS_STALE" : null,
  lastSuccessMs: fixtureState.mode === "stale" ? now - 900000 : fixtureState.lastCycleMs,
  strategy: { cycleIntervalMs: 300000, entrySchedule: "CONTINUOUS_EACH_CYCLE", entryWindowMs: null },
  evidence: { scope: "PARENT_WEEKLY_STRATEGY", revisedTimingValidated: false },
  state: { startedAtMs: now - 86400000, lastCycleMs: fixtureState.lastCycleMs, cycles: fixtureState.cycles, halted: false,
    account: { cashUsd: 99900, quantity: .001, entryCostUsd: 100, realizedNetUsd: -1.5, feesUsd: 2.5, receipts: [{ id: "fixture-receipt" }] },
    lastSignal: { state: "long", reason: "TREND_ENTER", close: 105000, movingAverage: 99000,
      lastWeekEndMs: Date.UTC(2026, 8, 3), availableAtMs: Date.UTC(2026, 8, 3, 0, 1) },
    lastDecision: { timestampMs: fixtureState.lastCycleMs, action: "hold", reason: "NEXT_WEEK_ENTRY_WINDOW",
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
const report = { generatedAt: new Date().toISOString(), mode: fixtureMode ? "SYNTHETIC_FIXTURE" : "DEPLOYED_READ_ONLY", url,
  ordersSubmitted: false, accountWrites: false, results: [], passed: false };
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
const liveness = sessionId => evaluate(sessionId, `(() => {
  const panel=document.querySelector('[data-testid="spot-liveness-panel"]');
  return {heading:document.getElementById('spot-liveness-heading').textContent,
    cards:[...document.querySelectorAll('#spot-liveness-grid > .spot-liveness-card')].map(card=>({id:card.id,label:card.querySelector('.spot-label').textContent,value:card.querySelector(':scope > strong').textContent,detail:card.querySelector(':scope > p').textContent,tone:card.className})),
    observations:[...document.querySelectorAll('#spot-observations li')].map(row=>({label:row.querySelector('strong')?.textContent??null,time:row.querySelector('time')?.textContent??null,detail:row.querySelector('span')?.textContent??null})),
    panelTop:panel.getBoundingClientRect().top,panelBottom:panel.getBoundingClientRect().bottom,
    strategyTop:document.querySelector('#spot-content .spot-decision-row').getBoundingClientRect().top,
    bodyWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth};})()`);
const card = (view, name) => view.cards.find(value => value.id === `spot-live-${name}`);
const spotRequests = state => state.requests.filter(request => request.kind === "http" && new URL(request.url).pathname === "/api/spot-dashboard");
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
    else if (message.method === "Network.requestWillBeSent" && new URL(message.params.request.url).pathname.startsWith("/api/")) {
      const state = sessions.get(message.sessionId);
      state?.requests.push({ kind: "http", url: message.params.request.url, method: message.params.request.method, timestampMs: message.params.timestamp * 1000 });
      if (state && new URL(message.params.request.url).pathname === "/api/spot-dashboard") state.spotRequestIds.add(message.params.requestId);
    }
    else if (message.method === "Network.loadingFinished" && sessions.get(message.sessionId)?.spotRequestIds.has(message.params.requestId)) {
      const state = sessions.get(message.sessionId);
      void command("Network.getResponseBody", { requestId: message.params.requestId }, message.sessionId).then(result => {
        const body = JSON.parse(result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body);
        state.spotResponses.push({ receivedAt: Date.now(), body });
      }).catch(error => { state.bodyReadErrors.push(error.message); });
    }
    else if (message.method === "Network.webSocketCreated") sessions.get(message.sessionId)?.requests.push({ kind: "websocket", url: message.params.url });
  });
  for (const viewport of [{ name: "desktop", width: 1440, height: 1100 }, { name: "mobile", width: 390, height: 844 }]) {
    if (fixtureMode) fixtureState.mode = "healthy";
    const { targetId } = await command("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await command("Target.attachToTarget", { targetId, flatten: true });
    const state = { errors: [], consoleErrors: [], requests: [], spotRequestIds: new Set(), spotResponses: [], bodyReadErrors: [] }; sessions.set(sessionId, state);
    await command("Page.enable", {}, sessionId); await command("Runtime.enable", {}, sessionId); await command("Network.enable", {}, sessionId);
    await command("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.name === "mobile" }, sessionId);
    await command("Page.navigate", { url }, sessionId);
    await waitFor(sessionId, `document.querySelector('#spot-content .spot-metrics') !== null`);
    await waitFor(sessionId, `document.querySelectorAll('#spot-liveness-grid > .spot-liveness-card').length===6`);
    if (!fixtureMode) await waitFor(sessionId, `document.querySelector('[data-spot-position-card]')!==null`);
    const initialLiveness = await liveness(sessionId);
    await pause(5_300);
    for (let attempt=0; attempt<30 && state.spotResponses.length<2; attempt++) await pause(100);
    assert.ok(state.spotResponses.length>=2,"Wait for the second application poll response before measuring display-only ticks");
    await pause(150);
    const firstTick = await liveness(sessionId), pollingBeforeTick = spotRequests(state).length;
    // Cross two display ticks: a single tick can still round a freshly polled age to zero.
    await pause(2_250);
    const secondTick = await liveness(sessionId), pollingAfterTick = spotRequests(state).length;
    report.tickDiagnostics ??= [];
    report.tickDiagnostics.push({viewport,firstTick,secondTick,pollingBeforeTick,pollingAfterTick,
      responseTimes:state.spotResponses.map(response=>({receivedAt:response.receivedAt,generatedAtMs:response.body.generatedAtMs,upstreamFetchedAtMs:response.body.upstreamFetchedAtMs}))});
    assert.equal(firstTick.cards.length, 6); assert.equal(secondTick.cards.length, 6);
    assert.equal(secondTick.heading, "Spot system liveness");
    assert.ok(secondTick.panelBottom <= secondTick.strategyTop, "Liveness is prominent above the strategy and account content");
    assert.ok(secondTick.bodyWidth <= secondTick.viewportWidth, "Liveness introduces no horizontal overflow");
    assert.notEqual(card(firstTick,"market").value, card(secondTick,"market").value, "Market age updates independently of the API poll");
    assert.notEqual(card(firstTick,"service").detail, card(secondTick,"service").detail, "Upstream-response age updates each second");
    assert.notEqual(card(firstTick,"evaluations").detail, card(secondTick,"evaluations").detail, "Recorded-evaluation age updates each second");
    if (card(firstTick,"next").value.startsWith("About ")) assert.notEqual(card(firstTick,"next").value, card(secondTick,"next").value, "Next evaluation estimate counts down each second");
    else assert.match(card(firstTick,"next").value, /Due|settlement|unavailable/, "A timer may not invent a countdown when timing is unconfirmed");
    assert.equal(pollingAfterTick, pollingBeforeTick, "One-second DOM updates must not add an API request");
    const pollTimes = spotRequests(state).map(request=>request.timestampMs), pollIntervals = pollTimes.slice(1).map((time,index)=>time-pollTimes[index]);
    assert.ok(pollIntervals.length >= 1, "At least one full poll interval was observed");
    assert.ok(pollIntervals.every(interval=>interval>=4500), `Polling exceeded its five-second cadence: ${pollIntervals}`);
    if (fixtureMode) {
      assert.equal(initialLiveness.observations.length, 1);
      assert.deepEqual(secondTick.observations, initialLiveness.observations, "Repeated responses for one evaluation do not create activity");
    }
    const observation = await evaluate(sessionId, `(() => {const panel=document.getElementById('spot-system');return {heading:document.getElementById('spot-heading').textContent, orderMode:document.getElementById('spot-order-mode').textContent, exchangeMode:document.getElementById('spot-exchange-mode').textContent, serviceStatus:document.getElementById('spot-service-status').textContent, bodyWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,spotWidth:panel.getBoundingClientRect().width, spotOrders:document.querySelectorAll('.spot-order').length, partialOrders:[...document.querySelectorAll('.spot-order .order-status')].map(x=>x.textContent), values:[...document.querySelectorAll('.spot-metrics .spot-metric')].map(x=>({label:x.querySelector('dt').textContent,value:x.querySelector('dd').textContent})), futuresHeading:document.getElementById('health-title').textContent, scripts:[...document.scripts].map(x=>x.src), bodyText:document.body.innerText.slice(0,16000)}})()`);
    const schedule=await evaluate(sessionId, `({mode:document.getElementById('spot-entry-schedule').dataset.schedule,text:document.getElementById('spot-entry-schedule').innerText,research:document.getElementById('spot-research-status').innerText})`);
    assert.equal(schedule.mode,"continuous");assert.match(schedule.text,/Every 5 minutes, throughout the week/);assert.doesNotMatch(schedule.text,/Thursdays only|Next entry window|00:00–01:00/);assert.match(schedule.research,/profitability remains unvalidated/);
    observation.entrySchedule=schedule;
    assert.equal(observation.heading, "BTC spot strategy"); assert.ok(observation.bodyWidth <= observation.viewportWidth, `${viewport.name} horizontal overflow: ${observation.bodyWidth}/${observation.viewportWidth}`);
    assert.equal(observation.orderMode, "Paper orders enabled"); assert.equal(observation.exchangeMode, "Live exchange orders disabled");
    assert.ok(observation.scripts.some(script => new URL(script).pathname === "/spot.js"));
    const spotVisibility = await evaluate(sessionId, `({view:document.documentElement.dataset.dashboardView,spotVisible:document.getElementById('spot-system').getBoundingClientRect().height>0,futuresVisible:document.getElementById('futures-monitoring').getBoundingClientRect().height>0,header:document.getElementById('connection-status').textContent,mode:document.getElementById('mode-badge').textContent,selected:document.querySelector('.dashboard-views a[aria-current="page"]').id,bodyText:document.body.innerText})`);
    assert.equal(spotVisibility.view, "spot"); assert.equal(spotVisibility.spotVisible, true); assert.equal(spotVisibility.futuresVisible, false);
    assert.equal(spotVisibility.selected, "spot-view-link"); assert.match(spotVisibility.header, /Spot connected/); assert.equal(spotVisibility.mode, "SPOT · PAPER");
    assert.doesNotMatch(spotVisibility.bodyText, /Executable net-return model|Liveness matrix|Market pulse|Futures equity|Operational events/);
    assert.ok(state.requests.filter(request=>new URL(request.url).pathname==="/api/spot-dashboard").length>=2, "Spot polling observed across a full interval");
    assert.equal(state.requests.filter(request=>request.kind==="websocket"||new URL(request.url).pathname==="/api/dashboard").length,0,"Hidden futures view must not poll or connect its websocket");
    assert.equal(state.errors.length, 0, state.errors.join("\n")); assert.equal(state.consoleErrors.length, 0, state.consoleErrors.join("\n"));
    if (fixtureMode) { assert.equal(observation.spotOrders, 3); assert.ok(observation.partialOrders.includes("PARTIAL FILL · CANCELED")); }
    delete observation.bodyText;
    assert.ok(state.spotResponses.length >= 2, "Responses from the application polls were captured without extra probe requests");
    const upstream = state.spotResponses.at(-1).body;
    const sourceStatus = { generatedAtMs: upstream.generatedAtMs, orderSubmissionEnabled: upstream.orderSubmissionEnabled,
      liveTradingEnabled: upstream.liveTradingEnabled, healthy: upstream.healthy, lastSuccessMs: upstream.lastSuccessMs,
      cycles: upstream.state.cycles, lastCycleMs: upstream.state.lastCycleMs, lastDecisionReason: upstream.state.lastDecision.reason,
      account: { cashUsd: upstream.state.account.cashUsd, quantity: upstream.state.account.quantity,
        realizedNetUsd: upstream.state.account.realizedNetUsd, feesUsd: upstream.state.account.feesUsd },
      mark: upstream.state.lastDecision.mark, orderCount: upstream.state.orders.length, receiptCount: upstream.state.account.receipts.length };
    assert.equal(card(secondTick,"evaluations").value, `${sourceStatus.cycles.toLocaleString("en-US")} recorded`, "Displayed evaluations must exactly match the upstream counter");
    assert.equal(card(secondTick,"service").value,"Responding");
    assert.ok(secondTick.observations.some(row=>row.label?.startsWith(`Evaluation ${sourceStatus.cycles.toLocaleString("en-US")} · `)), "Observed row references a real upstream cycle");
    assert.equal(state.bodyReadErrors.length,0,state.bodyReadErrors.join("\n"));
    assert.ok(state.requests.filter(request=>request.kind==="http").every(request=>request.method==="GET"),"Browser only performed read requests");
    assert.equal(observation.spotOrders, Math.min(20, sourceStatus.orderCount));
    assert.equal(observation.values.find(value=>value.label==="Cash").value, sourceStatus.account.cashUsd.toLocaleString("en-US",{style:"currency",currency:"USD"}));
    if (!fixtureMode) {
      const position = await evaluate(sessionId, `(() => {
        const node=document.querySelector('[data-spot-position-card]'),card=node.closest('[data-spot-position-order]');
        return {orderId:node.dataset.spotPositionCard,title:card.querySelector('.order-head strong').textContent,
          status:node.querySelector('.spot-position-status').textContent,
          metrics:[...node.querySelectorAll('.spot-position-metrics .spot-metric')].map(x=>({label:x.querySelector('dt').textContent,value:x.querySelector('dd').textContent})),
          duration:node.querySelector('[data-spot-position-duration]').textContent,
          events:[...node.querySelectorAll('[data-spot-position-event]')].map(x=>({id:x.dataset.spotPositionEvent,text:x.textContent})),
          reason:node.querySelector('.spot-position-reason').textContent,
          freshness:node.querySelector('[data-spot-position-freshness]').textContent};})()`);
      assert.match(position.title,/OPEN LONG/);assert.doesNotMatch(position.title,/SHORT/);
      const expected=upstream.orderActivity.orders[position.orderId];assert.ok(expected);
      assert.equal(position.status,expected.positionStatus.replaceAll('_',' '));
      assert.equal(position.metrics.find(x=>x.label==='Remaining BTC').value,expected.remainingQuantity.toLocaleString('en-US',{minimumFractionDigits:8,maximumFractionDigits:8}));
      assert.equal(position.events.length,expected.events.length);
      assert.equal(new Set(position.events.map(e=>e.id)).size,position.events.length);
      assert.ok(position.events.some(e=>e.text.includes('Holding the existing BTC position')));
      await evaluate(sessionId, `document.querySelector('details[data-spot-position-history] summary').click()`);
      await pause(100);
      assert.equal(await evaluate(sessionId, `document.querySelector('details[data-spot-position-history]').open`),true);
      assert.match(await evaluate(sessionId, `document.querySelector('.spot-position-events').innerText`),/Holding the existing BTC position/,'Expanded timeline exposes recorded holding decisions');
      const beforeDuration=await evaluate(sessionId, `document.querySelector('[data-spot-position-duration]').textContent`);
      await pause(2_250);
      assert.notEqual(await evaluate(sessionId, `document.querySelector('[data-spot-position-duration]').textContent`),beforeDuration);
      await pause(5_100);
      assert.equal(await evaluate(sessionId, `document.querySelector('details[data-spot-position-history]').open`),true,'Expanded history survives an application poll');
      const ids=await evaluate(sessionId, `[...document.querySelectorAll('[data-spot-position-card] [data-spot-position-event]')].map(x=>x.dataset.spotPositionEvent)`);
      assert.equal(new Set(ids).size,ids.length,'Polling never duplicates durable position events');
      position.expandedHistoryPreserved=true;position.displayDurationTicks=true;observation.positionActivity=position;
      assert.equal(await evaluate(sessionId, `document.documentElement.scrollWidth<=innerWidth`),true);
    }
    delete spotVisibility.bodyText;
    report.results.push({ viewport, scenario:"default-spot", ...observation, visibility:spotVisibility, sourceStatus,
      liveness:{initial:initialLiveness,firstTick,secondTick,pollingBeforeTick,pollingAfterTick,pollIntervalsMs:pollIntervals},
      networkRequests:[...state.requests], javascriptErrors:[...state.errors], consoleErrors:[...state.consoleErrors], screenshot:await capture(sessionId,`${viewport.name}-spot`) });
    state.requests=[];
    await evaluate(sessionId, `document.getElementById('futures-view-link').click()`);
    await waitFor(sessionId, `document.documentElement.dataset.dashboardView==='futures' && document.getElementById('health-title').textContent!=='Establishing futures engine state'`);
    await pause(5_300);
    const futuresVisibility=await evaluate(sessionId,`({url:location.href,view:document.documentElement.dataset.dashboardView,spotVisible:document.getElementById('spot-system').getBoundingClientRect().height>0,futuresVisible:document.getElementById('futures-monitoring').getBoundingClientRect().height>0,header:document.getElementById('connection-status').textContent,selected:document.querySelector('.dashboard-views a[aria-current="page"]').id,bodyWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,bodyText:document.body.innerText})`);
    assert.equal(new URL(futuresVisibility.url).searchParams.get("view"),"futures");assert.equal(futuresVisibility.view,"futures");assert.equal(futuresVisibility.spotVisible,false);assert.equal(futuresVisibility.futuresVisible,true);
    assert.equal(futuresVisibility.selected,"futures-view-link");assert.doesNotMatch(futuresVisibility.header,/Spot/);assert.match(futuresVisibility.bodyText,/Liveness matrix/);assert.match(futuresVisibility.bodyText,/Market pulse/);assert.match(futuresVisibility.bodyText,/Operational events/);
    assert.ok(futuresVisibility.bodyWidth<=futuresVisibility.viewportWidth,`${viewport.name} futures overflow`);
    assert.ok(state.requests.some(request=>request.kind==="websocket"));assert.ok(state.requests.some(request=>new URL(request.url).pathname==="/api/dashboard"));assert.equal(state.requests.filter(request=>new URL(request.url).pathname==="/api/spot-dashboard").length,0,"Hidden spot view must not poll");
    delete futuresVisibility.bodyText;
    report.results.push({viewport,scenario:"explicit-futures",visibility:futuresVisibility,networkRequests:[...state.requests],screenshot:await capture(sessionId,`${viewport.name}-futures`)});
    state.requests=[];
    const history=await command("Page.getNavigationHistory",{},sessionId);
    await command("Page.navigateToHistoryEntry",{entryId:history.entries[history.currentIndex-1].id},sessionId);
    await waitFor(sessionId,`document.documentElement.dataset.dashboardView==='spot' && document.getElementById('spot-order-mode').textContent==='Paper orders enabled'`);
    await pause(5_300);
    assert.equal(await evaluate(sessionId,`document.getElementById('futures-monitoring').hidden`),true);
    assert.match(await evaluate(sessionId,`document.getElementById('connection-status').textContent`),/Spot connected/);
    assert.ok(state.requests.some(request=>new URL(request.url).pathname==="/api/spot-dashboard"));assert.equal(state.requests.filter(request=>request.kind==="websocket"||new URL(request.url).pathname==="/api/dashboard").length,0,"Back navigation restores isolated spot view");
    report.results.push({viewport,scenario:"browser-back-spot",networkRequests:[...state.requests],passed:true});
    if(viewport.name==="desktop"){
      state.requests=[];const invalid=new URL(url);invalid.searchParams.set("view","unknown");await command("Page.navigate",{url:invalid.href},sessionId);
      await waitFor(sessionId,`document.documentElement.dataset.dashboardView==='spot' && document.getElementById('spot-order-mode').textContent==='Paper orders enabled'`);
      assert.equal(state.requests.filter(request=>request.kind==="websocket"||new URL(request.url).pathname==="/api/dashboard").length,0);report.results.push({viewport,scenario:"invalid-view-defaults-spot",passed:true});
    }
    if(fixtureMode&&viewport.name==="desktop"){
      const beforeSettlement=await liveness(sessionId), oldTime=beforeSettlement.observations[0].time;
      fixtureState.lastCycleMs+=2000;
      await waitFor(sessionId,`document.querySelector('#spot-observations li time').textContent!==${JSON.stringify(oldTime)}`);
      const afterSettlement=await liveness(sessionId);
      assert.equal(afterSettlement.observations.length,beforeSettlement.observations.length,"Settlement time changes within one cycle update its existing row");
      assert.equal(card(afterSettlement,"evaluations").value,`${fixtureState.cycles} recorded`);
      report.results.push({viewport,scenario:"same-cycle-settlement-updates-row",before:beforeSettlement,after:afterSettlement,passed:true});
      fixtureState.cycles+=1;fixtureState.lastCycleMs=Date.now()-1000;
      await waitFor(sessionId,`document.querySelector('#spot-live-evaluations > strong').textContent===${JSON.stringify(`${fixtureState.cycles} recorded`)}`);
      const newCycle=await liveness(sessionId);
      assert.equal(newCycle.observations.length,2,"One new recorded cycle adds exactly one observation");
      await pause(5300);
      const repeatedCycle=await liveness(sessionId);
      assert.deepEqual(repeatedCycle.observations,newCycle.observations,"Repeated same-cycle polling cannot grow observations");
      report.results.push({viewport,scenario:"new-upstream-cycle-and-repeat",before:newCycle,after:repeatedCycle,passed:true});
      fixtureState.mode="stale";
      await waitFor(sessionId,`document.querySelector('#spot-live-next > strong').textContent==='Estimate unavailable' && document.querySelector('#spot-live-market > p').textContent.includes('SPOT_PAPER_STATUS_STALE')`);
      const stale=await liveness(sessionId);
      assert.equal(card(stale,"service").value,"Responding","A responding API must remain distinct from stale market checks");
      assert.equal(card(stale,"gate").value,"Data unconfirmed");
      assert.match(card(stale,"market").tone,/warning/);
      assert.equal(await evaluate(sessionId,`document.getElementById('spot-order-mode').textContent`),"Order readiness unknown");
      report.results.push({viewport,scenario:"stale-market-cycle",liveness:stale,screenshot:await capture(sessionId,"desktop-stale"),passed:true});
      fixtureState.mode="upstream-stale";
      await waitFor(sessionId,`document.querySelector('#spot-live-service > strong').textContent==='Last response stale'`);
      const oldResponse=await liveness(sessionId);
      assert.equal(card(oldResponse,"next").value,"Estimate unavailable");
      assert.equal(card(oldResponse,"gate").value,"Data unconfirmed");
      assert.equal(await evaluate(sessionId,`document.getElementById('spot-order-mode').textContent`),"Order readiness unknown");
      report.results.push({viewport,scenario:"stale-upstream-response",liveness:oldResponse,screenshot:await capture(sessionId,"desktop-upstream-stale"),passed:true});
      fixtureState.mode="outage";
      await waitFor(sessionId,`document.querySelector('#spot-live-service > strong').textContent==='Unavailable'`);
      const unavailable=await liveness(sessionId);
      assert.equal(card(unavailable,"next").value,"Estimate unavailable");
      assert.equal(card(unavailable,"gate").value,"Data unconfirmed");
      assert.equal(unavailable.observations.length,2,"Outage cannot manufacture a recorded evaluation");
      assert.match(await evaluate(sessionId,`document.getElementById('spot-service-status').textContent`),/last known/i);
      report.results.push({viewport,scenario:"api-outage-preserves-last-known-state",liveness:unavailable,screenshot:await capture(sessionId,"desktop-outage"),passed:true});
      fixtureState.mode="healthy";
      await waitFor(sessionId,`document.querySelector('#spot-live-service > strong').textContent==='Responding' && document.getElementById('spot-order-mode').textContent==='Paper orders enabled'`);
      const recovered=await liveness(sessionId);
      assert.equal(card(recovered,"evaluations").value,`${fixtureState.cycles} recorded`);
      assert.equal(recovered.observations.length,2);
      assert.match(card(recovered,"next").value,/^About /);
      assert.ok(state.consoleErrors.every(message=>/503/.test(message)),state.consoleErrors.join("\n"));
      report.results.push({viewport,scenario:"same-cycle-recovery",liveness:recovered,expectedOutageConsoleErrors:[...state.consoleErrors],screenshot:await capture(sessionId,"desktop-recovered"),passed:true});
    }
    assert.equal(state.errors.length,0,state.errors.join("\n"));
    if(!fixtureMode||viewport.name!=="desktop")assert.equal(state.consoleErrors.length,0,state.consoleErrors.join("\n"));
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
