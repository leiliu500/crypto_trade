import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Read-only real Chromium verification. No fixture, account mutation or order endpoint.
// Run after deployment: node <this-file> --url http://127.0.0.1:3001 --out <artifact-directory>
const require = createRequire(join(process.cwd(), "package.json"));
const { WebSocket } = require("ws");
const args = process.argv.slice(2);
const argument = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const base = new URL(argument("--url") ?? "http://127.0.0.1:3001");
assert.ok(["http:", "https:"].includes(base.protocol) && !base.username && !base.password, "Plain HTTP(S) dashboard URL required");
const output = resolve(argument("--out") ?? "reports/distribution-disabled-2026-09-10/browser-deployed");
const chrome = argument("--chrome") ?? "/home/ec2-user/.cache/ms-playwright/chromium-1187/chrome-linux/chrome";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const viewUrl = view => new URL(`/?view=${view}`, base).href;
const report = { generatedAt: new Date().toISOString(), mode: "DEPLOYED_READ_ONLY", url: base.href,
  observationIntervalMs: 5500, results: [], passed: false };
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "eth40-ui-chrome-"));
const child = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
  "--disable-background-networking", "--disable-component-update", "--disable-sync",
  "--metrics-recording-only", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "about:blank"],
{ stdio: ["ignore", "ignore", "pipe"] });
let socket, sequence = 0, stderr = "", currentSession = null, currentScenario = null;
const pending = new Map(), sessions = new Map();
const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
  pending.set(id, { resolve, reject, timeout });
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const evaluate = async (sessionId, expression) => {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const waitFor = async (sessionId, expression) => {
  for (let i = 0; i < 150; i++) {
    try { if (await evaluate(sessionId, expression)) return; }
    catch (error) { if (!/context|navigation|Cannot find/i.test(error.message)) throw error; }
    await pause(100);
  }
  throw new Error(`Browser condition timed out: ${expression}`);
};
const capture = async (sessionId, name) => {
  const size = await evaluate(sessionId, `({width:innerWidth,height:Math.min(10000,document.documentElement.scrollHeight)})`);
  const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } }, sessionId);
  const path = join(output, `${name}.png`);
  await writeFile(path, Buffer.from(screenshot.data, "base64"));
  return path;
};
const pathOf = request => new URL(request.url).pathname;
function assertNetwork(state, view, requireReceipts = false) {
  for (const request of state.requests) {
    const url = new URL(request.url);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) continue;
    const protocol = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
    assert.equal(`${protocol}//${url.host}`, base.origin, `Unexpected cross-origin/port request: ${request.url}`);
    if (request.kind === "http") assert.equal(request.method, "GET", "Browser verification must remain read-only");
  }
  const api = state.requests.filter(request => pathOf(request).startsWith("/api/"));
  if (view === "eth40") {
    assert.ok(api.filter(request => pathOf(request) === "/api/eth40/status").length >= 2, "ETH40 status must poll across a full interval");
    if (requireReceipts) assert.ok(api.some(request => pathOf(request) === "/api/eth40/receipts"), "ETH40 receipt source was requested");
    assert.ok(api.every(request => pathOf(request).startsWith("/api/eth40/")), "Hidden spot/futures view must not poll");
  } else if (view === "spot") {
    assert.ok(api.filter(request => pathOf(request) === "/api/spot-dashboard").length >= 2, "Spot must poll across a full interval");
    assert.ok(api.every(request => ["/api/spot-dashboard", "/api/spot-order-activity"].includes(pathOf(request))), "Hidden ETH40/futures view must not poll");
  } else {
    assert.ok(api.some(request => pathOf(request) === "/api/dashboard"), "Futures data requested");
    assert.ok(api.every(request => pathOf(request) === "/api/dashboard"), "Hidden spot/ETH40 view must not poll");
    assert.ok(state.requests.some(request => request.kind === "websocket" && pathOf(request) === "/ws"), "Futures websocket connected");
  }
  if (view !== "futures") {
    assert.equal(state.requests.filter(request => request.kind === "websocket").length, 0, "Hidden futures websocket must not connect");
    assert.equal(state.activeSockets.size, 0, "Hidden futures websocket must be closed");
  }
  assert.equal(state.errors.length, 0, state.errors.join("\n"));
  assert.equal(state.consoleErrors.length, 0, state.consoleErrors.join("\n"));
}
const readVisibility = sessionId => evaluate(sessionId, `(() => {
  const visible = element => !!element && !element.hidden && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden' && element.getBoundingClientRect().height > 0;
  const links = [...document.querySelectorAll('.dashboard-views a')];
  return {url:location.href,view:document.documentElement.dataset.dashboardView,
    links:links.map(link=>({id:link.id,text:link.textContent.trim(),href:link.href,visible:visible(link),current:link.getAttribute('aria-current')})),
    panels:Object.fromEntries([['spot','spot-system'],['eth40','eth40-system'],['futures','futures-monitoring']].map(([key,id])=>[key,visible(document.getElementById(id))])),
    bodyWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,
    header:document.getElementById('connection-status').textContent,mode:document.getElementById('mode-badge').textContent,
    bodyText:document.body.innerText};
})()`);
function assertVisibility(value, view, viewport) {
  assert.equal(value.view, view);
  assert.equal(new URL(value.url).searchParams.get("view"), view);
  assert.deepEqual(value.links.map(link => link.id).sort(), ["eth40-view-link", "futures-view-link", "spot-view-link"]);
  assert.ok(value.links.every(link => link.visible), "All three navigation links must be visible");
  assert.deepEqual(value.links.filter(link => link.current === "page").map(link => link.id), [`${view}-view-link`]);
  assert.deepEqual(value.panels, { spot: view === "spot", eth40: view === "eth40", futures: view === "futures" });
  assert.ok(value.bodyWidth <= value.viewportWidth, `${viewport.name}/${view} horizontal overflow: ${value.bodyWidth}/${value.viewportWidth}`);
  if(view === "futures"){
    assert.doesNotMatch(value.bodyText,/Executable net-return model|DISTRIBUTIONAL ENGINE|Training outcomes per action|Prospective selections|Entry evaluation cadence|Training collection cadence/);
    assert.match(value.bodyText,/Futures market data/);assert.match(value.bodyText,/Futures equity/i);assert.match(value.bodyText,/Trades and order attempts/);
  }
  if (view === "eth40") {
    assert.equal(value.mode, "ETH40 · PAPER");
    assert.match(value.bodyText, /Profitability unvalidated/);
    assert.match(value.bodyText, /ETH40 system liveness/);
    assert.match(value.bodyText, /Passive ETH/i); assert.match(value.bodyText, /Passive BTC/i);
    assert.match(value.bodyText, /Cash/i);
    assert.doesNotMatch(value.bodyText, /Executable net-return model|Liveness matrix|Market pulse|Operational events|Spot system liveness/);
  }
}
async function sourceObservation(sessionId) {
  return evaluate(sessionId, `Promise.all(['/api/eth40/status','/api/eth40/receipts'].map(async path=>{
    const response=await fetch(path,{cache:'no-store'});if(!response.ok)throw Error(path+' returned '+response.status);return response.json();
  })).then(([status,receipts])=>({status,receipts,capturedAtMs:Date.now()}))`);
}
function assertSource({ status, receipts, capturedAtMs }) {
  assert.equal(status.available, true); assert.equal(status.liveTradingEnabled, false);
  assert.equal(status.validatedProfitable, false); assert.equal(status.automaticPromotionAllowed, false);
  assert.equal(status.collectorHealthy, true); assert.equal(status.fatalError, null);
  assert.ok(status.sequence > 1, "A committed observation must exist");
  assert.ok(capturedAtMs - status.recordedAtMs >= 0 && capturedAtMs - status.recordedAtMs < 120000, "Recorded observation is fresh");
  assert.ok(capturedAtMs - status.dashboardFetchedAtMs >= 0 && capturedAtMs - status.dashboardFetchedAtMs < 15000, "Dashboard proxy response is fresh");
  assert.deepEqual(status.accounts.map(account => account.accountId).sort(), ["eth40", "passiveBtc", "passiveEth"]);
  for (const account of status.accounts) {
    const ledger = receipts[account.accountId].account;
    for (const key of ["cashUsd", "quantity", "initialCashUsd", "realizedNetUsd", "feesUsd"]) assert.equal(account[key], ledger[key]);
    assert.equal(account.fills, ledger.receipts.length);
    if (account.fills === 0) {
      assert.equal(account.quantity, 0); assert.equal(account.cashUsd, account.initialCashUsd);
      assert.equal(account.netPnlUsd, 0); assert.equal(account.realizedNetUsd, 0); assert.equal(account.feesUsd, 0);
      assert.equal(account.liquidationEquityUsd, account.initialCashUsd);
    }
  }
  assert.equal(status.cashBenchmark.netPnlUsd, 0);
}
const money = value => value === null ? "Unavailable" : value.toLocaleString("en-US", { style: "currency", currency: "USD" });
const signedMoney = value => value === null ? "Unavailable" : `${value < 0 ? "−" : "+"}${money(Math.abs(value))}`;
function assertDisplayedAccounts(display, status) {
  const metrics = Object.fromEntries(display.metrics.map(row => [row.label, row.value]));
  const strategy = status.accounts.find(account => account.accountId === "eth40");
  for (const [label, expected] of [["Cash", money(strategy.cashUsd)], ["Forward net P&L", signedMoney(strategy.netPnlUsd)],
    ["Net liquidation value", money(strategy.liquidationEquityUsd)], ["Fees paid", money(strategy.feesUsd)],
    ["Realized net P&L", signedMoney(strategy.realizedNetUsd)]]) assert.equal(metrics[label], expected, `Displayed ${label} must match the actual ETH40 account`);
  assert.deepEqual(display.comparisons.map(row => row[0]), ["ETH40", "Passive ETH", "Passive BTC", "Cash"]);
  for (const [index, id] of ["eth40", "passiveEth", "passiveBtc", "cash"].entries()) {
    const account = id === "cash" ? status.cashBenchmark : status.accounts.find(account => account.accountId === id);
    assert.equal(display.comparisons[index][1], money(id === "cash" ? account.equityUsd : account.liquidationEquityUsd));
    assert.equal(display.comparisons[index][2], signedMoney(account.netPnlUsd));
    if (id !== "cash" && account.fills === 0) assert.equal(display.comparisons[index][3], "No recorded fill");
  }
  assert.match(display.service, /Collector recording/);
}

try {
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Chrome startup timeout: ${stderr.slice(-2000)}`)), 15000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Chrome exited ${code}: ${stderr.slice(-2000)}`)); });
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-16000);
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.on("message", raw => {
    const message = JSON.parse(raw.toString()), state = sessions.get(message.sessionId);
    if (message.id) {
      const entry = pending.get(message.id); if (!entry) return;
      clearTimeout(entry.timeout); pending.delete(message.id);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") state?.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") state?.consoleErrors.push(message.params.args.map(value => value.value ?? value.description).join(" "));
    else if (message.method === "Network.requestWillBeSent") state?.requests.push({ kind: "http", url: message.params.request.url, method: message.params.request.method });
    else if (message.method === "Network.webSocketCreated") {
      state?.requests.push({ kind: "websocket", url: message.params.url });
      state?.activeSockets.add(message.params.requestId);
    } else if (message.method === "Network.webSocketClosed") state?.activeSockets.delete(message.params.requestId);
  });
  for (const viewport of [{ name: "desktop", width: 1440, height: 1100 }, { name: "mobile", width: 390, height: 844 }]) {
    const { targetId } = await command("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await command("Target.attachToTarget", { targetId, flatten: true });
    currentSession = sessionId;
    const state = { errors: [], consoleErrors: [], requests: [], activeSockets: new Set() };
    sessions.set(sessionId, state);
    await command("Page.enable", {}, sessionId); await command("Runtime.enable", {}, sessionId); await command("Network.enable", {}, sessionId);
    await command("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
    await command("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.name === "mobile" }, sessionId);
    for (const [index, view] of ["eth40", "spot", "eth40", "futures", "eth40"].entries()) {
      currentScenario = `${viewport.name}:${index}:${view}`;
      state.requests = [];
      const phaseStartedAtMs = Date.now();
      if (index === 0) await command("Page.navigate", { url: viewUrl(view) }, sessionId);
      else if (index === 4) {
        const history = await command("Page.getNavigationHistory", {}, sessionId);
        assert.ok(history.currentIndex > 0, "Browser back history exists");
        await command("Page.navigateToHistoryEntry", { entryId: history.entries[history.currentIndex - 1].id }, sessionId);
      } else await evaluate(sessionId, `document.getElementById('${view}-view-link').click()`);
      const ready = view === "eth40" ? `document.querySelector('#eth40-content .spot-metrics, #eth40-content .eth40-metrics')!==null`
        : view === "spot" ? `document.querySelector('#spot-content .spot-metrics')!==null`
        : `document.getElementById('health-title')?.textContent!=='Establishing futures engine state'`;
      await waitFor(sessionId, `document.documentElement.dataset.dashboardView==='${view}' && (${ready})`);
      await pause(report.observationIntervalMs);
      // Timer guards and back/forward cache restoration may defer the first interval.
      // Count only the page's automatic requests here, before our independent API reads.
      if (view !== "futures") {
        const path = view === "eth40" ? "/api/eth40/status" : "/api/spot-dashboard";
        for (let attempt = 0; attempt < 60 && state.requests.filter(request => pathOf(request) === path).length < 2; attempt++) await pause(100);
      }
      const visibility = await readVisibility(sessionId);
      assertVisibility(visibility, view, viewport);
      assertNetwork(state, view, index === 0);
      const result = { viewport, scenario: index === 0 ? "direct-eth40" : index === 4 ? "browser-back-eth40" : `navigate-${index}-${view}`,
        automaticObservationDurationMs: Date.now() - phaseStartedAtMs,
        visibility, networkRequests: [...state.requests], javascriptErrors: [...state.errors], consoleErrors: [...state.consoleErrors] };
      if (view === "eth40") {
        result.source = await sourceObservation(sessionId);
        assertSource(result.source);
        assertNetwork(state, view);
        result.beforeFirstFill = result.source.status.accounts.every(account => account.fills === 0);
        result.display = await evaluate(sessionId, `({content:document.getElementById('eth40-content').innerText,receipts:document.getElementById('eth40-receipts').innerText,service:document.getElementById('eth40-service-status').innerText,
          metrics:[...document.querySelectorAll('#eth40-content .spot-metric')].map(node=>({label:node.querySelector('dt').textContent.trim(),value:node.querySelector('dd').textContent.trim()})),
          comparisons:[...document.querySelectorAll('#eth40-content .eth40-table tbody tr')].map(row=>[...row.children].map(cell=>cell.textContent.trim()))})`);
        assertDisplayedAccounts(result.display, result.source.status);
        if (result.beforeFirstFill) {
          assert.match(result.display.content, /\$10,000(?:\.00)?/);
          assert.match(result.display.content, /\$0(?:\.00)?/);
          assert.match(result.display.receipts, /no .*fills|no .*trades|waiting.*first/i);
        }
        result.liveness = await evaluate(sessionId, `({
          cards:[...document.querySelectorAll('#eth40-liveness .spot-liveness-card')].map(node=>({id:node.id,tone:node.className,value:node.querySelector('strong')?.textContent,detail:node.querySelector('p')?.textContent})),
          note:document.getElementById('eth40-liveness-note')?.textContent,
          observations:document.getElementById('eth40-observations')?.innerText
        })`);
        assert.ok(result.liveness.cards.length >= 6, 'Visible ETH40 liveness cards exist');
        assert.ok(result.liveness.cards.every(card => card.value && card.detail), 'All liveness cards have an explained status');
        assert.ok(result.liveness.observations, 'Recent committed observations are visible');
        if (index === 0 && viewport.name === 'desktop') {
          const sample = () => evaluate(sessionId, `({
            clock:document.getElementById('clock').textContent,
            execution:document.querySelector('#eth40-live-execution strong').textContent,
            api:document.getElementById('eth40-live-api').className,
            collector:document.getElementById('eth40-live-observations').className,
            records:[...document.querySelectorAll('#eth40-observations [data-eth40-observation]')].map(node=>({
              sequence:Number(node.dataset.eth40Observation),atMs:Number(node.dataset.eth40ObservationAtMs)}))
          })`);
          const initial = await sample();
          assert.ok(initial.records.length > 0 && initial.records.every(row=>row.sequence>1));
          await pause(1500);
          const timer = await sample();
          assert.notEqual(timer.clock,initial.clock,'Header clock advances without reload');
          assert.notEqual(timer.execution,initial.execution,'Execution countdown advances without reload');
          let progressed = timer;
          for(let attempt=0;attempt<90&&progressed.records[0].sequence<=initial.records[0].sequence;attempt++){
            await pause(500); progressed=await sample();
          }
          assert.ok(progressed.records[0].sequence>initial.records[0].sequence,'Durable observation advances while watching');
          assert.ok(progressed.records[0].atMs>initial.records[0].atMs,'Advanced record has a newer commit timestamp');
          assert.equal(new Set(progressed.records.map(row=>row.sequence)).size,progressed.records.length,'Repeated polls do not duplicate commits');
          assert.ok(progressed.records.length<=6,'Browser observations stay bounded');
          assert.match(progressed.api,/good/); assert.match(progressed.collector,/good/);
          result.liveProgress={initial,timer,progressed};
        }
        if (index === 0) result.screenshot = await capture(sessionId, `${viewport.name}-eth40`);
      }
      if(view==='futures'){
        result.marketCards=await evaluate(sessionId, `({count:document.querySelectorAll('[data-testid="futures-market-card"]').length,models:document.querySelectorAll('[data-testid="distribution-market-card"],[data-testid="distribution-model-panel"],[data-testid="policy-market-card"]').length,text:document.getElementById('market-grid').innerText})`);
        assert.equal(result.marketCards.count,2,'Both Futures market feeds are visible');
        assert.equal(result.marketCards.models,0,'No distribution or fallbackmodel panel remains');
        result.screenshot=await capture(sessionId,`${viewport.name}-futures-monitoring`);
      }
      delete result.visibility.bodyText;
      result.passed = true; report.results.push(result);
    }
    await command("Target.closeTarget", { targetId });
    currentSession = null;
  }
  report.passed = true;
} catch (error) {
  report.error = error.stack ?? String(error); process.exitCode = 1;
  report.failureScenario = currentScenario;
  if (currentSession) {
    const state = sessions.get(currentSession);
    report.failureEvents = { requests: state?.requests, errors: state?.errors, consoleErrors: state?.consoleErrors };
    try { report.failureVisibility = await readVisibility(currentSession); report.failureScreenshot = await capture(currentSession, "failure"); }
    catch (diagnosticError) { report.failureDiagnosticError = diagnosticError.message; }
  }
}
finally {
  socket?.close(); for (const entry of pending.values()) clearTimeout(entry.timeout);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await pause(100); }
  }
  try { await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); report.cleanup = { temporaryProfileRemoved: true }; }
  catch (error) { report.cleanup = { temporaryProfileRemoved: false, error: error.message }; report.passed = false; process.exitCode = 1; }
  await writeFile(join(output, "browser-report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.passed, output, error: report.error ?? null }));
