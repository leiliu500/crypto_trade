import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const source = await readFile("src/dashboard/public/eth40.js", "utf8");
const script = source.slice(0, source.lastIndexOf("bootstrapEth40();"));
const nowMs = Date.UTC(2026, 8, 10, 12);
function status() {
  return { available: true, dashboardFetchedAtMs: nowMs, collectorHealthy: true, fatalError: null,
    liveTradingEnabled: false, sequence: 14, recordedAtMs: nowMs, startedAtMs: nowMs - 86_400_000,
    processStartedAtMs: nowMs - 1_800_000,
    firstExecutionDayMs: nowMs + 43_200_000, nextExecutionWindowMs: nowMs + 43_200_000,
    reviewAtMs: Date.UTC(2027, 2, 9, 12), reviewStatus: "COLLECTING", historicalNetPnlUsd: 948.41,
    spec: { maximumQuoteAgeMs: 5_000, maximumExchangeClockLeadMs: 1_000, maximumRulesAgeMs: 86_400_000,
      warmupBars: 90, executionWindowMs: 60_000, finalizationDelayMs: 60_000, signalToExecutionDays: 2 },
    accounts: ["eth40", "passiveEth", "passiveBtc"].map((accountId, i) => ({ accountId,
      symbol: i === 2 ? "BTC/USD" : "ETH/USD", cashUsd: 9_000, quantity: i === 2 ? .01 : .25,
      liquidationEquityUsd: 10_012.34 + i, netPnlUsd: 12.34 + i, realizedNetUsd: -2.5,
      feesUsd: 7.94, completedEpisodes: 0, sampledMaxDrawdownUsd: 8, firstFillAtMs: nowMs - 86_400_000 })),
    cashBenchmark: { initialCashUsd: 10_000, equityUsd: 10_000, netPnlUsd: 0 },
    excessVsCashUsd: 12.34, excessVsPassiveEthUsd: -1, excessVsPassiveBtcUsd: -2,
    lastDecisions: [{ accountId: "eth40", reason: "HOLD_LONG_NO_ADDITIONS", action: "hold", signalDayMs: nowMs - 2 * 86_400_000 }],
    capturedMarkets: { observedAtMs: nowMs, quotes: [
      { symbol: "ETH/USD", bid: 4_045, ask: 4_046, ageAtCaptureMs: 150, checksumValid: true,
        receivedAtMs: nowMs - 150, exchangeUpdateAtMs: nowMs - 200 },
      { symbol: "BTC/USD", bid: 102_000, ask: 102_010, ageAtCaptureMs: 750, checksumValid: true,
        receivedAtMs: nowMs - 750, exchangeUpdateAtMs: nowMs - 800 },
    ], rulesFetchedAtMs: nowMs - 60_000, rulesFetchedAtMsByAsset: { "ETH/USD": nowMs - 60_000, "BTC/USD": nowMs - 120_000 },
    rules: { "ETH/USD": { lotSize: .00000001, minimumQuantity: .001, minimumNotionalUsd: .5, tickSize: .01 },
      "BTC/USD": { lotSize: .00000001, minimumQuantity: .00005, minimumNotionalUsd: .5, tickSize: .1 } },
    completedHistory: { "ETH/USD": { bars: 720, firstOpenTimeMs: Date.UTC(2024, 8, 20), lastOpenTimeMs: Date.UTC(2026, 8, 9) },
      "BTC/USD": { bars: 720, firstOpenTimeMs: Date.UTC(2024, 8, 20), lastOpenTimeMs: Date.UTC(2026, 8, 9) } },
    errors: [] },
  };
}
const ledger = () => Object.fromEntries(["eth40", "passiveEth", "passiveBtc"].map(id => [id, { account: { receipts: [] } }]));

function browser(search = "?view=eth40", runSource = script) {
  const clock = { mono: 1_000, wall: nowMs + 86_400_000 };
  class BrowserDate extends Date {
    public constructor(value?: string | number | Date) { super(value === undefined ? clock.wall : value instanceof Date ? value.valueOf() : value); }
    public static override now() { return clock.wall; }
  }
  const nodes = new Map<string, { textContent: string; innerHTML: string; hidden: boolean; className: string;
    attributes: Map<string, string>; dataset: Record<string, string>; style: Record<string, string>;
    classList: { toggle: (...args: unknown[]) => void; add: (...args: unknown[]) => void; remove: (...args: unknown[]) => void };
    addEventListener: (...args: unknown[]) => void; setAttribute: (key: string, value: string) => void; removeAttribute: (key: string) => void }>();
  const node = (id: string) => {
    if (!nodes.has(id)) {
      const attributes = new Map<string, string>();
      nodes.set(id, { textContent: "", innerHTML: "", hidden: false, className: "", attributes, dataset: {}, style: {},
        classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {},
        setAttribute: (key, value) => { attributes.set(key, value); }, removeAttribute: key => { attributes.delete(key); } });
    }
    return nodes.get(id)!;
  };
  const timers = new Map<number, { callback: () => void; at: number }>();
  const intervals: Array<{ callback: () => void; ms: number }> = [];
  const requests: Array<{ url: string; options: { signal: AbortSignal; method?: string; cache: string }; resolve: (value: unknown) => void }> = [];
  const sockets: string[] = []; let nextTimer = 0;
  class Socket { public constructor(url: string) { sockets.push(url); } public addEventListener() {} }
  const document = { title: "", documentElement: { dataset: {} as Record<string, string> }, getElementById: node, querySelectorAll: () => [] };
  const context = createContext({ Date: BrowserDate, performance: { now: () => clock.mono }, URLSearchParams, AbortController,
    location: { search, protocol: "https:", host: "dashboard.example" }, document, WebSocket: Socket,
    fetch: (url: string, options: { signal: AbortSignal; cache: string }) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      requests.push({ url, options, resolve });
    }),
    setTimeout: (callback: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { callback, at: clock.mono + delay }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: (callback: () => void, ms: number) => { intervals.push({ callback, ms }); return intervals.length; },
  });
  runInContext(runSource, context);
  const evaluate = <T = unknown>(code: string): T => runInContext(code, context) as T;
  return { clock, nodes, node, document, requests, sockets, intervals, evaluate,
    refresh: () => evaluate<Promise<void>>("refreshEth40()"),
    respond: (index: number, value: unknown, ok = true) => requests[index]!.resolve({ ok, json: async () => value }),
    advance: (ms: number) => { clock.mono += ms; },
    runTimers: () => { for (const [id, timer] of [...timers]) if (timer.at <= clock.mono) { timers.delete(id); timer.callback(); } },
  };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function accept(b: ReturnType<typeof browser>, payload: unknown = status(), receipts = ledger()) {
  const first = b.requests.length, pending = b.refresh(); b.respond(first, payload); await tick();
  if (b.requests[first + 1]?.url === "/api/eth40/receipts") b.respond(first + 1, receipts);
  await pending;
}
function livenessCard(b: ReturnType<typeof browser>, id: string) {
  const html = b.node("eth40-liveness-grid").innerHTML;
  const match = new RegExp(`<([a-z][a-z0-9]*)\\b([^>]*\\bid="${id}"[^>]*)>([\\s\\S]*?)<\\/\\1>`).exec(html);
  assert.ok(match, `${id} must be rendered in the visible liveness panel`);
  return { html: match[0], text: match[3]!.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
    good: /class="[^"]*\bgood\b/.test(match[2]!), bad: /class="[^"]*\bbad\b/.test(match[2]!) };
}

test("ETH40 is the middle current-origin tab with a separate panel and no external browser port", async () => {
  const html = await readFile("src/dashboard/public/index.html", "utf8");
  assert.ok(html.indexOf('id="spot-view-link"') < html.indexOf('id="eth40-view-link"'));
  assert.ok(html.indexOf('id="eth40-view-link"') < html.indexOf('id="futures-view-link"'));
  assert.match(html, /href="\/\?view=eth40"/); assert.match(html, /id="eth40-system"[^>]*hidden/);
  assert.match(html, /id="eth40-service-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /src="\/eth40\.js\?/); assert.match(html, /Zero P&amp;L before the first trade is expected/);
  assert.doesNotMatch(source + html, /3003|localhost|127\.0\.0\.1|<iframe|method:\s*["']POST/);
});

test("the actual three-view bootstraps poll only their selected service", async () => {
  const [app, spot] = await Promise.all([readFile("src/dashboard/public/app.js", "utf8"), readFile("src/dashboard/public/spot.js", "utf8")]);
  for (const [view, endpoint, panel] of [["eth40", "/api/eth40/status", "eth40-system"], ["spot", "/api/spot-dashboard", "spot-system"], ["futures", "/api/dashboard", "futures-monitoring"]]) {
    const b = browser(`?view=${view}`, `${app}\n${spot}\n${source}`);
    assert.deepEqual(b.requests.map(r => r.url), [endpoint]);
    assert.equal(b.document.documentElement.dataset.dashboardView, view);
    for (const p of ["eth40-system", "spot-system", "futures-monitoring"]) assert.equal(b.node(p).hidden, p !== panel);
    assert.equal(b.node(`${view}-view-link`).attributes.get("aria-current"), "page");
    assert.equal(b.sockets.length, view === "futures" ? 1 : 0);
    if (view === "eth40") {
      b.respond(0, status()); await tick(); b.respond(1, ledger()); await tick();
      for (const interval of b.intervals.filter(i => i.ms === 1_000)) interval.callback();
      assert.equal(b.node("mode-badge").textContent, "ETH40 · PAPER");
      assert.match(b.node("connection-status").innerHTML, /ETH40 recording/);
      await b.evaluate<Promise<void>>("refreshSpot()"); assert.equal(b.requests.length, 2);
    }
  }
});

test("ETH40 uses forward account values and separate benchmarks, with asset-specific ages at capture", async () => {
  const b = browser(); await accept(b);
  const html = b.node("eth40-content").innerHTML;
  for (const text of ["+$12.34", "$10,012.34", "$9,000.00", "0.25000000", "$7.94", "−$2.50", "Passive ETH", "Passive BTC", "Holding the existing ETH position"]) assert.ok(html.includes(text), text);
  assert.match(html, /Recorded observations<\/span><strong>13/);
  assert.doesNotMatch(html, /948\.41|historicalNetPnl/);
  assert.match(b.node("eth40-quotes").innerHTML, /Age at capture: 150 ms/);
  assert.match(b.node("eth40-quotes").innerHTML, /Age at capture: 750 ms/);
  assert.match(b.node("eth40-receipts").innerHTML, /No ETH40 paper fills recorded yet/);
  assert.equal(b.requests[0]!.options.method, "GET"); assert.equal(b.requests[0]!.options.cache, "no-store");
  b.advance(5_000); await accept(b, { ...status(), dashboardFetchedAtMs: nowMs + 5_000 });
  assert.equal(b.requests.length, 3, "unchanged sequence does not fetch a new receipt ledger");
});

test("nullable or missing monetary values remain unavailable; an actual zero remains zero", async () => {
  const b = browser(), s = status();
  const pending = b.refresh(); b.respond(0, { ...s, accounts: [{ accountId: "eth40", netPnlUsd: null, liquidationEquityUsd: null, feesUsd: 0 }],
    excessVsCashUsd: null, excessVsPassiveEthUsd: null, excessVsPassiveBtcUsd: null });
  await tick(); b.respond(1, ledger()); await pending;
  const html = b.node("eth40-content").innerHTML;
  assert.match(html, /Forward net P&amp;L<\/dt><dd class="">Unavailable/);
  assert.match(html, /Cash<\/dt><dd class="">Unavailable/);
  assert.match(html, /Fees paid<\/dt><dd class="">\$0\.00/);
  assert.match(html, /Missing P&amp;L is not zero profit/); assert.doesNotMatch(html, /NaN|undefined/);
});

test("a failed or malformed response removes stale positive P&L and green header, then recovers", async () => {
  const b = browser(); await accept(b); b.advance(5_000);
  const failed = b.refresh(); b.respond(2, { available: false }, false); await failed;
  assert.match(b.node("eth40-service-status").className, /unavailable/);
  assert.equal(b.node("connection-status").className, "connection offline");
  assert.doesNotMatch(b.node("eth40-content").innerHTML, /\+\$12\.34|class="positive"/);
  assert.match(b.node("eth40-receipts").innerHTML, /ledger is unavailable/);
  b.advance(5_000); await accept(b, { ...status(), dashboardFetchedAtMs: nowMs + 10_000 });
  assert.match(b.node("connection-status").innerHTML, /ETH40 recording/);
  b.advance(5_000); const malformed = b.refresh(); b.respond(5, { ...status(), accounts: [null] }); await malformed;
  assert.equal(b.node("connection-status").className, "connection offline");
});

test("monotonic freshness expires without polling and cached timestamps cannot renew it", async () => {
  const b = browser(); await accept(b); b.clock.wall += 30 * 86_400_000;
  b.advance(15_000); b.evaluate("renderEth40()");
  assert.equal(b.node("connection-status").className, "connection offline");
  assert.match(b.node("eth40-content").innerHTML, /dashboard response 15s ago/);
  await accept(b, status());
  assert.equal(b.node("connection-status").className, "connection offline", "cached time cannot reset elapsed time");
  b.advance(5_000); await accept(b, { ...status(), dashboardFetchedAtMs: nowMs + 120_000 });
  assert.equal(b.node("connection-status").className, "connection offline", "fresh HTTP cannot renew a stale recorded observation");
  assert.match(b.node("eth40-content").innerHTML, /2m 0s ago/);
  b.advance(5_000); await accept(b, { ...status(), sequence: 15, dashboardFetchedAtMs: nowMs + 125_000, recordedAtMs: nowMs + 126_000 });
  assert.equal(b.node("connection-status").className, "connection offline", "future capture time is unconfirmed");
});

test("collector failure cannot be overwritten by a successful dashboard response", async () => {
  const b = browser(); await accept(b, { ...status(), collectorHealthy: false });
  assert.equal(b.node("connection-status").className, "connection offline");
  assert.match(b.node("eth40-content").innerHTML, /present readiness is unconfirmed/);
  assert.doesNotMatch(b.node("eth40-content").innerHTML, /class="positive"/);
});

test("upstream decision and receipt text are escaped and receipts stay separated by account", async () => {
  const b = browser(), malicious = '<img src=x onerror="alert(1)">';
  const receipts = ledger() as Record<string, { account: { receipts: unknown[] } }>;
  receipts.eth40!.account.receipts = [{ side: malicious, quantity: .25, price: 4_000, feeBps: 80, timestampMs: nowMs }];
  receipts.passiveBtc!.account.receipts = [{ side: "buy", quantity: .01, price: 100_000, feeBps: 80, timestampMs: nowMs }];
  await accept(b, { ...status(), lastDecisions: [{ accountId: "eth40", reason: malicious, action: "hold", signalDayMs: nowMs }] }, receipts as ReturnType<typeof ledger>);
  for (const id of ["eth40-content", "eth40-receipts"]) {
    assert.doesNotMatch(b.node(id).innerHTML, /<img/);
    assert.match(b.node(id).innerHTML, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  }
  assert.match(b.node("eth40-receipts").innerHTML, /\$8\.00/);
  assert.match(b.node("eth40-receipts").innerHTML, /Separate passive benchmark fills/);
});

test("timeouts release polling for retry and inactive tabs create no ETH40 requests or timers", async () => {
  const b = browser(), pending = b.refresh();
  await b.refresh(); assert.equal(b.requests.length, 1);
  b.advance(4_500); b.runTimers(); await pending;
  assert.equal(b.requests[0]!.options.signal.aborted, true);
  assert.equal(b.evaluate<boolean>("eth40View.polling"), false);
  b.advance(500); await accept(b);
  assert.match(b.node("connection-status").innerHTML, /ETH40 recording/);
  for (const view of ["spot", "futures", "unknown"]) {
    const inactive = browser(`?view=${view}`, source);
    await inactive.refresh(); assert.equal(inactive.requests.length, 0); assert.equal(inactive.intervals.length, 0);
  }
});

test("ETH40 liveness is visible above account results and distinguishes API response from durable observations", async () => {
  const html = await readFile("src/dashboard/public/index.html", "utf8");
  assert.match(html, /<section\b[^>]*id="eth40-liveness"[^>]*>/);
  assert.doesNotMatch(html.match(/<section\b[^>]*id="eth40-liveness"[^>]*>/)![0], /\bhidden\b/);
  assert.ok(html.indexOf('id="eth40-liveness"') > html.indexOf('id="eth40-service-status"'));
  assert.ok(html.indexOf('id="eth40-liveness"') < html.indexOf('id="eth40-content"'));
  const b = browser(); await accept(b);
  assert.equal(livenessCard(b, "eth40-live-api").good, true);
  assert.equal(livenessCard(b, "eth40-live-observations").good, true);
  b.advance(5_000);
  await accept(b, { ...status(), dashboardFetchedAtMs: nowMs + 120_000 });
  assert.equal(livenessCard(b, "eth40-live-api").good, true, "successful current API is still responding");
  assert.equal(livenessCard(b, "eth40-live-observations").good, false, "fresh HTTP cannot renew the durable record");
  assert.equal(livenessCard(b, "eth40-live-eth-book").good, false, "old observation cannot establish current market readiness");
  assert.equal(b.node("connection-status").className, "connection offline");
});

test("cached polls and one-second renders cannot invent durable observations or fill sequence gaps", async () => {
  const b = browser(); await accept(b);
  assert.match(livenessCard(b, "eth40-live-observations").text, /\b13\b/);
  const observedIds = () => [...b.node("eth40-observations").innerHTML.matchAll(/data-eth40-observation="(\d+)"/g)].map(match => Number(match[1]));
  assert.deepEqual(observedIds(), [14]);
  for (let index = 1; index <= 3; index++) {
    b.advance(5_000); await accept(b, { ...status(), dashboardFetchedAtMs: nowMs + index * 5_000 });
    b.evaluate("renderEth40()");
    assert.match(livenessCard(b, "eth40-live-observations").text, /\b13\b/);
    assert.deepEqual(observedIds(), [14], "cached polling does not add a recorded observation; its displayed age may advance");
  }
  b.advance(5_000);
  await accept(b, { ...status(), sequence: 20, dashboardFetchedAtMs: nowMs + 20_000, recordedAtMs: nowMs + 20_000 });
  assert.match(livenessCard(b, "eth40-live-observations").text, /\b19\b/, "total count comes from committed sequence minus genesis");
  const observed = JSON.parse(b.evaluate<string>("JSON.stringify(eth40View.observations.map(item=>item.sequence))")) as number[];
  assert.deepEqual([...observed].sort((a, z) => a - z), [14, 20], "browser shows only the two commits it actually observed");
  assert.equal(b.requests.filter(request => request.url === "/api/eth40/receipts").length, 2);
});

test("genesis, absent capture times, future captures and collector failures cannot appear as recording observations", async () => {
  for (const change of [
    { sequence: 1, accounts: [], lastDecisions: [] },
    { recordedAtMs: undefined },
    { recordedAtMs: nowMs + 1 },
    { collectorHealthy: false },
    { fatalError: "EVIDENCE_WRITE_FAILED" },
  ]) {
    const b = browser(); await accept(b, { ...status(), ...change });
    assert.equal(livenessCard(b, "eth40-live-api").good, true, "API reachability is independent of collector state");
    assert.equal(livenessCard(b, "eth40-live-observations").good, false, JSON.stringify(change));
    assert.equal(livenessCard(b, "eth40-live-eth-book").good, false, JSON.stringify(change));
    assert.equal(b.node("connection-status").className, "connection offline");
    if (change.sequence === 1) {
      assert.match(livenessCard(b, "eth40-live-observations").text, /\b0\b|no .*observations/i);
      assert.equal(b.evaluate<number>("eth40View.observations.length"), 0, "genesis is never an observed market cycle");
    }
  }
});

test("the actual one-second timer ages API and record timestamps with the header clock without polling", async () => {
  const b = browser("?view=eth40", source);
  b.respond(0, status()); await tick(); b.respond(1, ledger()); await tick();
  const oneSecond = b.intervals.filter(interval => interval.ms === 1_000);
  assert.equal(oneSecond.length, 1);
  const beforeClock = b.node("clock").textContent;
  assert.equal(beforeClock, new Date(nowMs).toLocaleTimeString([], { hour12: false }));
  b.clock.wall -= 30 * 86_400_000;
  b.advance(1_000); oneSecond[0]!.callback();
  assert.match(livenessCard(b, "eth40-live-api").text, /\b1s\b/);
  assert.match(livenessCard(b, "eth40-live-observations").text, /\b1s\b/);
  assert.equal(b.node("clock").textContent, new Date(nowMs + 1_000).toLocaleTimeString([], { hour12: false }));
  assert.notEqual(b.node("clock").textContent, beforeClock);
  assert.equal(b.requests.length, 2, "rendering never fetches or commits anything");
  b.advance(14_000); oneSecond[0]!.callback();
  assert.equal(livenessCard(b, "eth40-live-api").good, false, "response expires at 15 seconds without a poll");
  await accept(b, status());
  assert.equal(livenessCard(b, "eth40-live-api").good, false, "receiving cached source time cannot renew response freshness");
});

test("ETH and BTC quote capture ages stay independent and static while the durable observation ages", async () => {
  const b = browser(); await accept(b);
  const eth = livenessCard(b, "eth40-live-eth-book"), btc = livenessCard(b, "eth40-live-btc-book");
  assert.equal(eth.good, true); assert.equal(btc.good, true);
  assert.match(eth.text, /150\s*ms/); assert.match(btc.text, /750\s*ms/);
  b.advance(30_000);
  await accept(b, { ...status(), dashboardFetchedAtMs: nowMs + 30_000 });
  assert.equal(livenessCard(b, "eth40-live-eth-book").good, true, "30-second record age does not make a 150ms captured quote invalid at capture");
  assert.match(livenessCard(b, "eth40-live-eth-book").text, /150\s*ms/);
  assert.match(livenessCard(b, "eth40-live-btc-book").text, /750\s*ms/);
  assert.match(livenessCard(b, "eth40-live-observations").text, /\b30s\b/);
  assert.match(livenessCard(b, "eth40-live-eth-book").text, /capture|recorded/i);
});

test("bad ETH quote evidence never turns green or borrows the valid BTC book", async () => {
  const s = status();
  for (const change of [
    { checksumValid: false },
    { receivedAtMs: nowMs + 1 },
    { receivedAtMs: nowMs - 5_001, ageAtCaptureMs: 5_001 },
    { exchangeUpdateAtMs: nowMs + 1_001 },
    { exchangeUpdateAtMs: nowMs - 5_001 },
    { receivedAtMs: undefined },
    { ageAtCaptureMs: -1 },
    { ageAtCaptureMs: undefined },
    { bid: 4_046 },
    { bid: 4_047 },
  ]) {
    const b = browser(); await accept(b, { ...s, capturedMarkets: { ...s.capturedMarkets,
      quotes: [{ ...s.capturedMarkets.quotes[0], ...change }, s.capturedMarkets.quotes[1]] } });
    assert.equal(livenessCard(b, "eth40-live-eth-book").good, false, JSON.stringify(change));
    assert.equal(livenessCard(b, "eth40-live-btc-book").good, true, "BTC remains independently valid at capture");
  }
  for (const capturedMarkets of [null, { ...s.capturedMarkets, observedAtMs: nowMs + 1 }, { ...s.capturedMarkets, quotes: [] }]) {
    const b = browser(); await accept(b, { ...s, capturedMarkets });
    assert.equal(livenessCard(b, "eth40-live-eth-book").good, false);
    assert.equal(livenessCard(b, "eth40-live-btc-book").good, false);
  }
});

test("daily execution countdown describes legitimate waiting, counts down each second, and never implies a guaranteed fill", async () => {
  const s = status(), b = browser();
  await accept(b, { ...s, lastDecisions: [{ accountId: "eth40", reason: "WAITING_FOR_FIRST_PROSPECTIVE_EXECUTION_DAY", action: "blocked" }] });
  const waiting = livenessCard(b, "eth40-live-execution");
  assert.equal(waiting.bad, false, "scheduled waiting is not a collector failure");
  assert.equal(waiting.good, false, "a future execution window is not current execution readiness");
  assert.match(waiting.text, /12h|12 h|12 hours/i);
  b.advance(1_000); b.evaluate("renderEth40()");
  assert.match(livenessCard(b, "eth40-live-execution").text, /11h\s*59m\s*59s|11 h.*59 m.*59 s/i);
  const at = s.firstExecutionDayMs + 10_000;
  b.advance(5_000);
  await accept(b, { ...s, dashboardFetchedAtMs: at, recordedAtMs: at, sequence: 15 });
  const open = livenessCard(b, "eth40-live-execution");
  assert.match(open.text, /Window closes in/i); assert.match(open.text, /50s|50 seconds/i);
  assert.match(open.text, /qualif|target|signal|valid|not.*guarantee/i);
  b.advance(1_000); b.evaluate("renderEth40()");
  assert.match(livenessCard(b, "eth40-live-execution").text, /49s|49 seconds/i);
  b.advance(49_000);
  await accept(b, { ...s, dashboardFetchedAtMs: s.firstExecutionDayMs + 60_000,
    recordedAtMs: s.firstExecutionDayMs + 60_000, sequence: 16 });
  assert.match(livenessCard(b, "eth40-live-execution").text, /Next window in/i);
  assert.equal(livenessCard(b, "eth40-live-execution").bad, false);
  const missing = browser(); await accept(missing, { ...s, spec: undefined });
  assert.equal(livenessCard(missing, "eth40-live-execution").good, false);
  assert.match(livenessCard(missing, "eth40-live-execution").text, /unconfirmed|unavailable|unknown/i);
});

test("ETH history liveness requires finalized anchored coverage and keeps BTC errors separate", async () => {
  const s = status(), market = s.capturedMarkets, history = market.completedHistory["ETH/USD"];
  const valid = browser(); await accept(valid, s);
  assert.equal(livenessCard(valid, "eth40-live-history").good, true, "720 daily rows cover the frozen anchor through the completed day");
  assert.match(livenessCard(valid, "eth40-live-history").text, /720 daily candles/);
  assert.match(livenessCard(valid, "eth40-live-history").text, /summary/i, "the card reports captured coverage, not an independent signal replay");
  for (const change of [
    { bars: undefined },
    { bars: 90, lastOpenTimeMs: history.firstOpenTimeMs + 89 * 86_400_000 },
    { bars: history.bars - 1 },
    { firstOpenTimeMs: history.firstOpenTimeMs + 86_400_000 },
    { lastOpenTimeMs: undefined },
    { bars: history.bars + 1, lastOpenTimeMs: Date.UTC(2026, 8, 10) },
    { lastOpenTimeMs: history.lastOpenTimeMs + 1 },
  ]) {
    const b = browser(); await accept(b, { ...s, capturedMarkets: { ...market,
      completedHistory: { ...market.completedHistory, "ETH/USD": { ...history, ...change } } } });
    assert.equal(livenessCard(b, "eth40-live-history").good, false, JSON.stringify(change));
  }
  for (const capturedMarkets of [
    { ...market, completedHistory: undefined },
    { ...market, completedHistory: { "BTC/USD": history } },
    { ...market, errors: ["ETH/USD:HISTORY_FETCH_FAILED"] },
    { ...market, errors: ["ETH/USD:INVALID_CANDLE"] },
  ]) {
    const b = browser(); await accept(b, { ...s, capturedMarkets });
    assert.equal(livenessCard(b, "eth40-live-history").good, false);
  }
  for (const spec of [undefined, { ...s.spec, signalToExecutionDays: undefined }, { ...s.spec, finalizationDelayMs: undefined }]) {
    const b = browser(); await accept(b, { ...s, spec });
    assert.equal(livenessCard(b, "eth40-live-history").good, false);
  }
  const btcFailure = browser(); await accept(btcFailure, { ...s, capturedMarkets: { ...market,
    errors: ["BTC/USD:HISTORY_FETCH_FAILED", "BTC/USD:INVALID_CANDLE"] } });
  assert.equal(livenessCard(btcFailure, "eth40-live-history").good, true, "BTC history errors do not invalidate recorded ETH coverage");
});

test("ETH instrument-rule liveness uses its own captured metadata age and rejects missing, future or invalid rules", async () => {
  const s = status(), market = s.capturedMarkets, rules = market.rules["ETH/USD"];
  const valid = browser(); await accept(valid, { ...s, capturedMarkets: { ...market,
    rulesFetchedAtMs: nowMs - 2 * 86_400_000,
    rulesFetchedAtMsByAsset: { "ETH/USD": nowMs - 60_000, "BTC/USD": nowMs + 1 },
    errors: ["BTC/USD:INSTRUMENT_RULES_UNAVAILABLE"] } });
  assert.equal(livenessCard(valid, "eth40-live-rules").good, true, "ETH pair timestamp wins over global/other-pair ages");
  assert.match(livenessCard(valid, "eth40-live-rules").text, /Age at capture: 1m 0s/);
  valid.advance(5_000); await accept(valid, { ...s, dashboardFetchedAtMs: nowMs + 30_000 });
  assert.match(livenessCard(valid, "eth40-live-rules").text, /Age at capture: 1m 0s/, "metadata age at capture does not become current quote age");
  for (const capturedMarkets of [
    { ...market, rules: undefined },
    { ...market, rules: { "BTC/USD": market.rules["BTC/USD"] } },
    { ...market, rulesFetchedAtMsByAsset: { "ETH/USD": nowMs + 1 } },
    { ...market, rulesFetchedAtMsByAsset: { "ETH/USD": nowMs - 86_400_001 } },
    { ...market, rulesFetchedAtMsByAsset: undefined, rulesFetchedAtMs: undefined },
  ]) {
    const b = browser(); await accept(b, { ...s, capturedMarkets });
    assert.equal(livenessCard(b, "eth40-live-rules").good, false);
  }
  for (const change of [{ lotSize: 0 }, { minimumQuantity: undefined }, { minimumNotionalUsd: -1 }, { tickSize: 0 }]) {
    const b = browser(); await accept(b, { ...s, capturedMarkets: { ...market,
      rules: { ...market.rules, "ETH/USD": { ...rules, ...change } } } });
    assert.equal(livenessCard(b, "eth40-live-rules").good, false, JSON.stringify(change));
  }
  const fallback = browser(); await accept(fallback, { ...s, capturedMarkets: { ...market,
    rulesFetchedAtMsByAsset: undefined, rulesFetchedAtMs: nowMs - 60_000 } });
  assert.equal(livenessCard(fallback, "eth40-live-rules").good, true, "legacy global capture timestamp remains an explicit fallback");
  const missingSpec = browser(); await accept(missingSpec, { ...s, spec: { ...s.spec, maximumRulesAgeMs: undefined } });
  assert.equal(livenessCard(missingSpec, "eth40-live-rules").good, false);
});
