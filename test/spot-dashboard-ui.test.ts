import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const source = await readFile("src/dashboard/public/spot.js", "utf8");
const script = source.slice(0, source.lastIndexOf("bootstrapSpot();"));
const nowMs = Date.UTC(2026, 8, 10, 12);

function status() {
  return {
    generatedAtMs: nowMs, upstreamFetchedAtMs: nowMs, strategy: { cycleIntervalMs: 300_000 }, system: "btc-spot-funded-weekly-trend-v1", mode: "RESEARCH_PAPER",
    liveTradingEnabled: false, orderSubmissionEnabled: true, healthy: true, lastError: null, lastSuccessMs: nowMs,
    evidence: { historicalNetPnlUsd: 1175.6 },
    state: {
      startedAtMs: nowMs - 3_600_000, lastCycleMs: nowMs, cycles: 12, halted: false,
      account: { cashUsd: 99900, quantity: .001, entryCostUsd: 100, realizedNetUsd: -1.5, feesUsd: 2.5, receipts: [] as unknown[] },
      lastSignal: { state: "long", reason: "TREND_ENTER", close: 105000, movingAverage: 99000,
        lastWeekEndMs: Date.UTC(2026, 8, 3), availableAtMs: Date.UTC(2026, 8, 3, 0, 1) },
      lastDecision: { timestampMs: nowMs, action: "hold", reason: "NEXT_WEEK_ENTRY_WINDOW",
        mark: { equityUsd: 100010, liquidationEquityUsd: 100009.12, unrealizedNetUsd: 10.62, netPnlUsd: 9.12 } },
      orders: [] as unknown[],
    },
  };
}

function browser(wallOffset = 0) {
  const clock = { mono: 1_000, wall: nowMs + wallOffset };
  class BrowserDate extends Date {
    public constructor(value?: string | number | Date) { super(value === undefined ? clock.wall : value instanceof Date ? value.valueOf() : value); }
    public static override now() { return clock.wall; }
  }
  const nodes = new Map<string, { innerHTML: string; textContent: string; className: string; classes: Set<string>; classList: { toggle: (key: string, force: boolean) => void }; addEventListener: (...args: unknown[]) => void }>();
  const selectors = new Map<string, unknown[]>();
  const timers = new Map<number, { callback: () => void; at: number }>();
  const intervals: Array<{ callback: () => void; ms: number }> = [];
  const requests: Array<{ url: string; options: { signal: AbortSignal; cache: string }; resolve: (value: unknown) => void }> = [];
  let nextTimer = 0;
  const getNode = (id: string) => {
    let node = nodes.get(id);
    if (!node) {
      const classes = new Set<string>();
      node = { innerHTML: "", textContent: "", className: "", classes,
        classList: { toggle: (key, force) => { if (force) classes.add(key); else classes.delete(key); } }, addEventListener: () => {} };
      nodes.set(id, node);
    }
    return node;
  };
  const context = createContext({
    Date: BrowserDate, performance: { now: () => clock.mono }, AbortController, URLSearchParams, location: { search: "" },
    document: { getElementById: getNode, querySelectorAll: (selector: string) => selectors.get(selector) ?? [] },
    fetch: (url: string, options: { signal: AbortSignal; cache: string }) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      requests.push({ url, options, resolve });
    }),
    setTimeout: (callback: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { callback, at: clock.mono + delay }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: (callback: () => void, ms: number) => { intervals.push({ callback, ms }); return intervals.length; },
  });
  runInContext(script, context);
  const evaluate = <T = unknown>(code: string): T => runInContext(code, context) as T;
  return {
    clock, requests, intervals, selectors, evaluate, node: getNode,
    refresh: () => evaluate<Promise<void>>("refreshSpot()"),
    respond: (index: number, payload: unknown, ok = true) => requests[index]!.resolve({ ok, json: async () => payload }),
    advance: (ms: number) => { clock.mono += ms; },
    runTimers: () => { for (const [id, timer] of [...timers]) if (timer.at <= clock.mono) { timers.delete(id); timer.callback(); } },
  };
}

test("main dashboard includes the spot module and clearly separates futures capital", async () => {
  const html = await readFile("src/dashboard/public/index.html", "utf8");
  assert.match(html, /src="\/spot\.js\?/);
  assert.match(html, /id="spot-service-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.ok(html.indexOf('id="spot-system"') < html.indexOf('id="top"'));
  assert.match(html, /Futures equity/);
  assert.match(html, /Futures session P&amp;L/);
  assert.match(html, /<html[^>]*data-dashboard-view="spot"/);
  assert.match(html, /id="futures-monitoring" hidden/);
  assert.match(html, /href="\/\?view=futures">Futures monitoring/);
  assert.doesNotMatch(source, /localhost|127\.0\.0\.1|3002|method:\s*["']POST/);
});

test("spot dashboard shows current account P&L and never imports historical gains", async () => {
  const b = browser(), pending = b.refresh();
  b.respond(0, status()); await pending;
  const html = b.node("spot-content").innerHTML;
  assert.equal(b.requests[0]!.url, "/api/spot-dashboard");
  assert.equal(b.requests[0]!.options.cache, "no-store");
  for (const text of ["+$9.12", "$100,010.00", "$99,900.00", "0.00100000", "−$1.50", "+$10.62", "$2.50", "0 submitted", "No spot orders submitted yet.", "2026-09-17 · 00:00–01:00 UTC", "2026-09-03 00:00:00 UTC"])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /1,175\.60/);
  assert.equal(b.node("spot-order-mode").textContent, "Paper orders enabled");
  assert.equal(b.node("spot-exchange-mode").textContent, "Live exchange orders disabled");
  assert.match(b.node("spot-service-status").className, /healthy/);
});

test("missing marks and metrics remain unknown instead of displaying fabricated zero profit", async () => {
  const b = browser(), s = status();
  const payload = { ...s, state: { ...s.state, account: { cashUsd: null, quantity: null, receipts: null }, lastDecision: { ...s.state.lastDecision, mark: null } } };
  const pending = b.refresh(); b.respond(0, payload); await pending;
  const html = b.node("spot-content").innerHTML;
  assert.match(html, /Current market valuation is unavailable/);
  assert.match(html, /Forward net P&amp;L<\/dt><dd class="">—/);
  assert.match(html, /Cash<\/dt><dd class="">—/);
  assert.doesNotMatch(html, /\$0\.00|NaN|undefined/);
});

test("a failed request retains the last account snapshot but removes order readiness", async () => {
  const b = browser(), first = b.refresh(); b.respond(0, status()); await first;
  const prior = b.node("spot-content").innerHTML;
  b.advance(5_000); const failed = b.refresh(); b.respond(1, {}, false); await failed;
  assert.equal(b.node("spot-content").innerHTML, prior);
  assert.ok(b.node("spot-content").classes.has("spot-old-values"));
  assert.match(b.node("spot-service-status").textContent, /unavailable.*last known values/);
  assert.equal(b.node("spot-order-mode").textContent, "Order readiness unknown");
  b.advance(5_000); const recovery = b.refresh(); b.respond(2, { ...status(), generatedAtMs: nowMs + 10_000 }); await recovery;
  assert.equal(b.node("spot-order-mode").textContent, "Paper orders enabled");
  assert.equal(b.node("spot-content").classes.has("spot-old-values"), false);
});

test("staleness uses server cycle time and monotonic elapsed time despite browser clock changes", async () => {
  const b = browser(-3_600_000), pending = b.refresh(); b.respond(0, status()); await pending;
  assert.match(b.node("spot-service-status").textContent, /0 min ago/);
  b.clock.wall += 86_400_000; b.advance(5_000);
  const later = b.refresh(); b.respond(1, { ...status(), generatedAtMs: nowMs + 600_000 }); await later;
  assert.match(b.node("spot-service-status").textContent, /stale/);
  assert.equal(b.node("spot-order-mode").textContent, "Order readiness unknown");
  b.advance(5_000); const fresh = b.refresh(); b.respond(2, { ...status(), generatedAtMs: nowMs + 601_000, upstreamFetchedAtMs: nowMs + 601_000, lastSuccessMs: nowMs + 601_000 }); await fresh;
  assert.equal(b.node("spot-order-mode").textContent, "Paper orders enabled");
  b.advance(15_000); b.evaluate("renderSpotConnection()");
  assert.match(b.node("spot-service-status").textContent, /stale/);
});

test("startup failure, malformed status, halted and unexpected execution modes are explicit", async () => {
  const b = browser(), pending = b.refresh(); b.respond(0, {}, false); await pending;
  assert.match(b.node("spot-service-status").textContent, /unavailable/);
  assert.equal(b.node("spot-order-mode").textContent, "Order readiness unknown");
  b.advance(5_000); const invalid = b.refresh(); b.respond(1, { healthy: true }); await invalid;
  assert.match(b.node("spot-service-status").textContent, /invalid/);
  b.advance(5_000); const halted = b.refresh(); const s = status(); s.state.halted = true; b.respond(2, s); await halted;
  assert.match(b.node("spot-service-status").textContent, /halted by the account risk limit/);
  b.advance(5_000); const mode = b.refresh(); b.respond(3, { ...status(), liveTradingEnabled: true }); await mode;
  assert.match(b.node("spot-service-status").textContent, /Unexpected execution mode/);
  assert.equal(b.node("spot-order-mode").textContent, "Order readiness unknown");
  assert.equal(b.node("spot-exchange-mode").textContent, "Unexpected exchange mode");
});

test("IOC partial fills show booked quantity, canceled remainder and escaped lifecycle details", async () => {
  const b = browser(), s = status();
  s.state.orders = [{
    request: { clientOrderId: "client-1", side: "buy", quantity: .002, limitPrice: 100100, createdAtMs: nowMs, timeInForce: "IOC", reduceOnly: false },
    orderId: 'order-<img src=x onerror="alert(1)">', status: "CANCELED", filledQuantity: .001, averageFillPrice: 100000, feeUsd: .8,
    cancellationReason: "IOC_REMAINDER_CANCELED", events: [{ type: "SUBMITTED", timestampMs: nowMs }, { type: "ACCEPTED", timestampMs: nowMs },
      { type: "PARTIAL_FILL", timestampMs: nowMs, detail: '<script>alert("x")</script>' }, { type: "CANCELED", timestampMs: nowMs }],
  }];
  const pending = b.refresh(); b.respond(0, s); await pending;
  const html = b.node("spot-content").innerHTML;
  for (const text of ["1 submitted", "PARTIAL FILL · CANCELED", "0.00200000", "0.00100000", "$100,100.00", "$100,000.00", "$0.80", "remaining quantity was canceled", "submitted</b>", "accepted</b>", "partial fill</b>", "canceled</b>"])
    assert.ok(html.includes(text), text);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|<img/);
});

test("rejected orders show their reason without fabricating fills or fill prices", async () => {
  const b = browser(), s = status();
  s.state.orders = [{ request: { side: "sell", quantity: .001, limitPrice: 99900, createdAtMs: nowMs, reduceOnly: true, timeInForce: "IOC" },
    orderId: "reject-1", status: "REJECTED", filledQuantity: 0, averageFillPrice: null, feeUsd: 0,
    rejectionReason: "STALE_BOOK", events: [{ type: "SUBMITTED", timestampMs: nowMs }, { type: "REJECTED", timestampMs: nowMs }] }];
  const pending = b.refresh(); b.respond(0, s); await pending;
  const html = b.node("spot-content").innerHTML;
  assert.match(html, /REJECTED/); assert.match(html, /stale book/); assert.match(html, /Reduce only/);
  assert.match(html, /Average fill<\/dt><dd class="">—/);
  assert.match(html, /Filled BTC<\/dt><dd class="">0\.00000000/);
});

test("entry window observes Thursday UTC boundaries and never announces a guaranteed entry", () => {
  const b = browser();
  const thursday = Date.UTC(2026, 8, 17);
  for (const [at, open, start] of [[thursday - 1, false, thursday], [thursday, true, thursday], [thursday + 3_599_999, true, thursday], [thursday + 3_600_000, false, thursday + 604_800_000]] as const) {
    const result = b.evaluate<{ open: boolean; startMs: number; endMs: number }>(`spotNextWindow(${at})`);
    assert.equal(result.open, open); assert.equal(result.startMs, start); assert.equal(result.endMs, start + 3_600_000);
  }
  assert.match(source, /Entry still requires a qualifying signal, fresh depth, and risk checks/);
});

test("entry schedule follows service metadata during the legacy-to-continuous rollout", async () => {
  const b = browser(), s = status();
  const legacy = b.refresh(); b.respond(0, { ...s, strategy: { ...s.strategy, entryWindowMs: 3_600_000 } }); await legacy;
  assert.match(b.node("spot-content").innerHTML, /data-schedule="weekly"/);
  assert.match(b.node("spot-content").innerHTML, /Next entry window/);
  assert.match(b.node("spot-content").innerHTML, /Thursdays only/);
  b.advance(5_000); const continuous = b.refresh(); b.respond(1, { ...s, generatedAtMs: nowMs + 5_000, upstreamFetchedAtMs: nowMs + 5_000,
    strategy: { ...s.strategy, entrySchedule: "CONTINUOUS_EACH_CYCLE", entryWindowMs: null },
    evidence: { scope: "PARENT_WEEKLY_STRATEGY", revisedTimingValidated: false } }); await continuous;
  const html = b.node("spot-content").innerHTML;
  assert.match(html, /data-schedule="continuous"/);
  assert.match(html, /Entry evaluation/);
  assert.match(html, /Historical research covers the parent weekly strategy/);
  assert.match(html, /profitability remains unvalidated/);
  assert.match(html, /Every 5 minutes, throughout the week/);
  assert.match(html, /One filled entry per strategy week; no additional buys/);
  assert.match(html, /Delayed closed-week signal/);
  assert.match(html, /previous decision used the weekly entry window/);
  assert.doesNotMatch(html, /Thursdays only|Next entry window|00:00–01:00 UTC|2026-09-17/);
  assert.match(b.node("spot-liveness-note").textContent, /throughout the week/);
  assert.match(b.node("spot-liveness-grid").innerHTML, /Continuous evaluation/);
  assert.doesNotMatch(b.node("spot-liveness-grid").innerHTML, /Waiting for entry window/);
  assert.match(b.node("spot-liveness-grid").innerHTML, /About 4m 55s/);
  assert.match(b.node("spot-observations").innerHTML, /Waiting for the next weekly entry window/, "historic observation keeps the recorded legacy reason");
});

test("continuous entry cadence uses configuration and retains consumed-entry and position limits", async () => {
  const b = browser(), s = status();
  const first = b.refresh(); b.respond(0, { ...s, strategy: { cycleIntervalMs: 120_000, entrySchedule: "CONTINUOUS_EACH_CYCLE", entryWindowMs: null },
    state: { ...s.state, lastDecision: { ...s.state.lastDecision, reason: "WEEKLY_ENTRY_ALREADY_CONSUMED" } } }); await first;
  assert.match(b.node("spot-content").innerHTML, /Every 2 minutes, throughout the week/);
  assert.match(b.node("spot-content").innerHTML, /entry has already been used/);
  assert.match(b.node("spot-content").innerHTML, /No additional buys this week/);
  assert.doesNotMatch(b.node("spot-content").innerHTML, /Every 5 minutes|Thursdays only/);
  b.advance(5_000); const missingCadence = b.refresh(); b.respond(1, { ...s, generatedAtMs: nowMs + 5_000, upstreamFetchedAtMs: nowMs + 5_000,
    strategy: { entrySchedule: "CONTINUOUS_EACH_CYCLE", entryWindowMs: null },
    state: { ...s.state, lastDecision: { ...s.state.lastDecision, reason: "HOLD_SPOT_NO_ADDITIONS" } } }); await missingCadence;
  assert.match(b.node("spot-content").innerHTML, /Cadence unknown, throughout the week/);
  assert.match(b.node("spot-content").innerHTML, /Holding the existing BTC position; no additional buys/);
});

test("unrecognized or contradictory schedule metadata does not invent continuous or weekly entry timing", async () => {
  const b = browser(), s = status();
  const first = b.refresh(); b.respond(0, { ...s, strategy: { ...s.strategy, entrySchedule: "CONTINUOUS_EACH_CYCLE", entryWindowMs: 3_600_000 } }); await first;
  assert.match(b.node("spot-content").innerHTML, /Schedule unconfirmed/);
  assert.doesNotMatch(b.node("spot-content").innerHTML, /Every 5 minutes|Thursdays only|00:00–01:00 UTC/);
});

test("spot polling runs every five seconds, permits one request at a time, and times out for retry", async () => {
  const b = browser(); b.evaluate("bootstrapSpot()");
  assert.equal(b.requests.length, 1); assert.equal(b.intervals.length, 2);
  assert.equal(b.intervals.filter(interval => interval.ms === 5_000).length, 1);
  assert.equal(b.intervals.filter(interval => interval.ms === 1_000).length, 1);
  await b.refresh(); assert.equal(b.requests.length, 1);
  b.advance(4_500); b.runTimers(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(b.requests[0]!.options.signal.aborted, true);
  assert.match(b.node("spot-service-status").textContent, /unavailable/);
  b.advance(499); await b.refresh(); assert.equal(b.requests.length, 1);
  b.advance(1); const retry = b.refresh(); assert.equal(b.requests.length, 2); b.respond(1, status()); await retry;
  assert.equal(b.node("spot-order-mode").textContent, "Paper orders enabled");
});

test("missing enablement and order ledger fields are not reported as disabled or zero submissions", async () => {
  const b = browser(), s = status();
  const payload = { ...s, orderSubmissionEnabled: undefined, state: { ...s.state, orders: undefined } };
  const pending = b.refresh(); b.respond(0, payload); await pending;
  assert.equal(b.node("spot-order-mode").textContent, "Order readiness unknown");
  assert.match(b.node("spot-content").innerHTML, /Ledger unavailable/);
  assert.doesNotMatch(b.node("spot-content").innerHTML, /0 submitted/);
});

test("spot response reachability is independent of stale recorded evaluations and market checks", async () => {
  const b = browser(), s = status();
  const payload = { ...s, healthy: false, lastError: "SPOT_PAPER_STATUS_STALE", lastSuccessMs: nowMs - 700_000,
    state: { ...s.state, lastCycleMs: nowMs - 700_000, lastDecision: { ...s.state.lastDecision, timestampMs: nowMs - 700_000 } } };
  const pending = b.refresh(); b.respond(0, payload); await pending;
  const html = b.node("spot-liveness-grid").innerHTML;
  assert.match(html, /id="spot-live-service" class="spot-liveness-card good"[^]*?<strong>Responding<\/strong>/);
  assert.match(html, /id="spot-live-evaluations" class="spot-liveness-card warning"[^]*?12 recorded/);
  assert.match(html, /No recent recorded evaluation/);
  assert.match(html, /Estimate unavailable/);
  assert.match(html, /11m 40s ago/);
  assert.match(html, /Data unconfirmed/);
  assert.equal(b.node("spot-order-mode").textContent, "Order readiness unknown");
  assert.doesNotMatch(b.node("spot-service-status").className, /healthy/);
});

test("liveness ages, approximate countdown and header clock tick every second without extra polling", async () => {
  const b = browser(); b.evaluate("bootstrapSpot()"); b.respond(0, status());
  await new Promise<void>(resolve => setImmediate(resolve));
  const tick = b.intervals.find(interval => interval.ms === 1_000)!;
  const clockBefore = b.node("clock").textContent;
  assert.match(b.node("spot-liveness-grid").innerHTML, /About 5m 0s/);
  b.advance(1_000); b.clock.wall += 1_000; tick.callback();
  assert.match(b.node("spot-liveness-grid").innerHTML, /About 4m 59s/);
  assert.match(b.node("spot-liveness-grid").innerHTML, /Last upstream response 1s ago/);
  assert.match(b.node("spot-liveness-grid").innerHTML, /Last evaluation 1s ago/);
  assert.notEqual(b.node("clock").textContent, clockBefore);
  assert.equal(b.requests.length, 1);
  for (let second = 0; second < 3; second++) { b.advance(1_000); tick.callback(); }
  assert.equal(b.requests.length, 1, "one-second display updates never fetch");
  b.advance(1_000); b.intervals.find(interval => interval.ms === 5_000)!.callback();
  assert.equal(b.requests.length, 2, "the separate five-second poll fetches");
  b.respond(1, { ...status(), generatedAtMs: nowMs + 5_000, upstreamFetchedAtMs: nowMs + 5_000 });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.match(b.node("spot-liveness-grid").innerHTML, /About 4m 55s/);
});

test("overdue evaluation estimate never resets on unchanged polls or claims a cycle is running", async () => {
  const b = browser(), s = status();
  const payload = { ...s, lastSuccessMs: nowMs - 299_000, state: { ...s.state, lastCycleMs: nowMs - 299_000,
    lastDecision: { ...s.state.lastDecision, timestampMs: nowMs - 299_000 } } };
  const first = b.refresh(); b.respond(0, payload); await first;
  assert.match(b.node("spot-liveness-grid").innerHTML, /About 1s/);
  b.advance(1_000); b.evaluate("renderSpotConnection()");
  assert.match(b.node("spot-liveness-grid").innerHTML, /Due · awaiting update/);
  b.advance(4_000); const repeated = b.refresh();
  b.respond(1, { ...payload, generatedAtMs: nowMs + 5_000, upstreamFetchedAtMs: nowMs + 5_000 }); await repeated;
  assert.match(b.node("spot-liveness-grid").innerHTML, /Due · awaiting update/);
  assert.doesNotMatch(b.node("spot-liveness-grid").innerHTML, /About 5m|Cycle running/);
  b.advance(5_000); const failed = b.refresh(); b.respond(2, { ...payload, generatedAtMs: nowMs + 10_000, upstreamFetchedAtMs: nowMs + 10_000,
    healthy: false, lastError: "MARKET_FETCH_FAILED" }); await failed;
  assert.match(b.node("spot-liveness-grid").innerHTML, /Estimate unavailable/);
  assert.equal(b.node("spot-order-mode").textContent, "Order readiness unknown");
});

test("session observations track distinct recorded evaluations and merge later settlement timestamps", async () => {
  const b = browser(), s = status();
  const first = b.refresh(); b.respond(0, s); await first;
  assert.equal(b.evaluate<number>("spotView.observations.length"), 1);
  assert.match(b.node("spot-observations").innerHTML, /Evaluation 12/);
  assert.doesNotMatch(b.node("spot-observations").innerHTML, /Evaluation 11/);
  b.advance(5_000); const repeated = b.refresh(); b.respond(1, { ...s, generatedAtMs: nowMs + 5_000, upstreamFetchedAtMs: nowMs + 5_000 }); await repeated;
  assert.equal(b.evaluate<number>("spotView.observations.length"), 1);
  b.advance(5_000); const settled = b.refresh(); b.respond(2, { ...s, generatedAtMs: nowMs + 10_000, upstreamFetchedAtMs: nowMs + 10_000,
    state: { ...s.state, lastCycleMs: nowMs + 2_000, lastDecision: { ...s.state.lastDecision, timestampMs: nowMs + 2_000, reason: "HOLD_SPOT_NO_ADDITIONS" } } }); await settled;
  assert.equal(b.evaluate<number>("spotView.observations.length"), 1, "settlement is not another recorded evaluation");
  assert.equal(b.evaluate<number>("spotView.observations[0].atMs"), nowMs + 2_000);
  assert.match(b.node("spot-observations").innerHTML, /Holding the existing BTC position/);
  b.advance(5_000); const newer = b.refresh(); b.respond(3, { ...s, generatedAtMs: nowMs + 15_000, upstreamFetchedAtMs: nowMs + 15_000,
    state: { ...s.state, cycles: 15, lastCycleMs: nowMs + 15_000, lastDecision: { ...s.state.lastDecision, timestampMs: nowMs + 15_000 } } }); await newer;
  assert.equal(b.evaluate<number>("spotView.observations.length"), 2);
  assert.match(b.node("spot-observations").innerHTML, /Evaluation 15/);
  assert.doesNotMatch(b.node("spot-observations").innerHTML, /Evaluation 13|Evaluation 14/);
});

test("missing and future telemetry stay unknown; zero only means no successful check when explicitly recorded", async () => {
  const b = browser(), s = status();
  const missing = b.refresh(); b.respond(0, { ...s, upstreamFetchedAtMs: undefined, lastSuccessMs: undefined, strategy: undefined,
    state: { ...s.state, cycles: undefined, lastCycleMs: undefined, orders: undefined } }); await missing;
  const html = b.node("spot-liveness-grid").innerHTML;
  assert.match(html, /Response time unknown/); assert.match(html, /Ledger unavailable/);
  assert.match(html, /Last successful market check<\/span><strong>Unknown/);
  assert.doesNotMatch(html, /No successful check|0 pending|0 recorded|About 5m/);
  assert.equal(b.node("spot-order-mode").textContent, "Order readiness unknown");
  b.advance(5_000); const zero = b.refresh(); b.respond(1, { ...s, generatedAtMs: nowMs + 5_000, upstreamFetchedAtMs: nowMs + 5_000,
    lastSuccessMs: 0, healthy: false, state: { ...s.state, cycles: 0, lastDecision: null } }); await zero;
  assert.match(b.node("spot-liveness-grid").innerHTML, /No successful check/);
  assert.match(b.node("spot-liveness-grid").innerHTML, /No recorded evaluations yet/);
  assert.equal(b.evaluate<number>("spotView.observations.length"), 0);
  b.advance(5_000); const future = b.refresh(); b.respond(2, { ...s, generatedAtMs: nowMs + 10_000, upstreamFetchedAtMs: nowMs + 10_000,
    lastSuccessMs: nowMs + 60_000 }); await future;
  assert.match(b.node("spot-liveness-grid").innerHTML, /Time unconfirmed/);
  assert.equal(b.node("spot-order-mode").textContent, "Order readiness unknown");
});

test("paper broker liveness counts lifecycle states separately and never reports terminal orders as profitable trades", async () => {
  const b = browser(), s = status();
  s.state.orders = ["SUBMITTED", "ACCEPTED", "FILLED", "CANCELED", "REJECTED", "UNKNOWN"].map(status => ({ status }));
  const pending = b.refresh(); b.respond(0, s); await pending;
  const html = b.node("spot-liveness-grid").innerHTML;
  assert.match(html, /2 pending · 3 terminal/);
  assert.match(html, /1 unknown statuses/);
  assert.match(html, /Awaiting order settlement/);
  assert.doesNotMatch(html, /profitable trades|successful trades|trades completed/);
  b.advance(5_000); const halted = b.refresh(); b.respond(1, { ...s, generatedAtMs: nowMs + 5_000, upstreamFetchedAtMs: nowMs + 5_000,
    state: { ...s.state, halted: true } }); await halted;
  assert.match(b.node("spot-liveness-grid").innerHTML, /id="spot-live-gate" class="spot-liveness-card bad"[^]*?Risk halt/);
});

test("cached upstream timestamps cannot renew liveness, and futures view starts no spot timers", async () => {
  const b = browser(), first = b.refresh(); b.respond(0, status()); await first;
  b.advance(5_000); const cached = b.refresh(); b.respond(1, { ...status(), generatedAtMs: nowMs + 20_000 }); await cached;
  assert.match(b.node("spot-liveness-grid").innerHTML, /Last response stale/);
  assert.match(b.node("spot-liveness-grid").innerHTML, /Last upstream response 20s ago/);
  assert.equal(b.node("spot-order-mode").textContent, "Order readiness unknown");
  const futures = browser(); futures.evaluate("location.search='?view=futures';bootstrapSpot()");
  assert.equal(futures.requests.length, 0); assert.equal(futures.intervals.length, 0);
});

function positionActivity(orderId = "entry-1") {
  return { orderId, entryOrderId: "entry-1", direction: "LONG", intent: "OPEN_LONG", positionStatus: "OPEN",
    openedAtMs: nowMs - 60_000, closedAtMs: null as number | null, remainingQuantity: .001, remainingEntryCostUsd: 100,
    realizedNetUsd: 0, unrealizedNetUsd: 1.2 as number | null, totalNetUsd: 1.2 as number | null,
    markPrice: 101200 as number | null, markAtMs: nowMs as number | null,
    events: [{ id: "event-3", timestampMs: nowMs, type: "STRATEGY_EVALUATION", reason: "HOLD_SPOT_NO_ADDITIONS", totalNetUsd: 1.2 },
      { id: "event-2", timestampMs: nowMs - 60_000, type: "FILLED", quantity: .001 }] as Array<Record<string, unknown>>,
    totalEvents: 3, nextCursor: "event-2&opaque?/ value" as string | null };
}
function positionSnapshot() {
  const s = status();
  s.state.orders = [{ request: { clientOrderId: "entry-1", side: "buy", quantity: .001, limitPrice: 100100, createdAtMs: nowMs - 60_000, timeInForce: "IOC", reduceOnly: false },
    orderId: "entry-1", status: "FILLED", filledQuantity: .001, averageFillPrice: 100000, feeUsd: .8,
    events: [{ type: "SUBMITTED", timestampMs: nowMs - 60_000 }, { type: "FILLED", timestampMs: nowMs - 60_000 }] }];
  return { ...s, orderActivity: { available: true, sourceCycle: s.state.cycles, sourceTimestampMs: s.state.lastCycleMs,
    orders: { "entry-1": positionActivity() } as Record<string, ReturnType<typeof positionActivity>> } };
}

test("filled order cards show evolving LONG position results while sell orders explicitly close LONG", async () => {
  const b = browser(), s = positionSnapshot(), first = b.refresh(); b.respond(0, s); await first;
  let html = b.node("spot-content").innerHTML;
  assert.match(html, /OPEN LONG · BTC \/ USD/); assert.match(html, /LONG position/); assert.match(html, /spot-position-status">OPEN/);
  assert.match(html, /Position net P&amp;L<\/dt><dd class="positive">\+\$1\.20/);
  assert.match(html, /Remaining BTC/); assert.match(html, /Recorded bid/); assert.match(html, /5m 0s cycle valuation · not live/);
  assert.match(html, /Holding the existing BTC position/);
  b.advance(5_000); const newer = b.refresh();
  const activity = { ...positionActivity(), positionStatus: "PARTIALLY_EXITED", remainingQuantity: .0005, remainingEntryCostUsd: 50,
    realizedNetUsd: 2, unrealizedNetUsd: -1, totalNetUsd: 1, markAtMs: nowMs + 5_000,
    events: [{ id: "event-4", timestampMs: nowMs + 5_000, type: "STRATEGY_EVALUATION", reason: "MARKED_NOTIONAL_CAP" }], totalEvents: 4 };
  b.respond(1, { ...s, generatedAtMs: nowMs + 5_000, upstreamFetchedAtMs: nowMs + 5_000,
    orderActivity: { ...s.orderActivity, orders: { "entry-1": activity, "exit-1": { ...activity, orderId: "exit-1", intent: "CLOSE_LONG" } } },
    state: { ...s.state, orders: [...s.state.orders, { ...(s.state.orders[0] as object), orderId: "exit-1",
      request: { side: "sell", quantity: .0005, createdAtMs: nowMs + 5_000, reduceOnly: true } }] } }); await newer;
  html = b.node("spot-content").innerHTML;
  assert.match(html, /CLOSE LONG · BTC \/ USD/); assert.doesNotMatch(html, /SHORT/);
  assert.match(html, /PARTIALLY EXITED/); assert.match(html, /\+\$2\.00/); assert.match(html, /−\$1\.00/);
  assert.match(html, /reducing the position to its exposure limit/);
  assert.equal((html.match(/data-spot-position-card=/g) ?? []).length, 2);
});

test("position history failures, mismatched sources and missing marks do not fabricate closure or profit", async () => {
  const b = browser(), s = positionSnapshot();
  s.orderActivity.orders["entry-1"] = { ...positionActivity(), unrealizedNetUsd: null, totalNetUsd: null, markAtMs: null, markPrice: null };
  const first = b.refresh(); b.respond(0, s); await first;
  assert.match(b.node("spot-content").innerHTML, /Recorded valuation unavailable/);
  assert.match(b.node("spot-content").innerHTML, /Position net P&amp;L<\/dt><dd class="">—/);
  b.evaluate("spotHistoryState('entry-1').expanded=true");
  b.advance(5_000); const mismatch = b.refresh(); b.respond(1, { ...s, generatedAtMs: nowMs + 5_000, upstreamFetchedAtMs: nowMs + 5_000,
    orderActivity: { ...s.orderActivity, sourceCycle: 999 } }); await mismatch;
  assert.match(b.node("spot-content").innerHTML, /Position history unavailable/);
  assert.match(b.node("spot-content").innerHTML, /FILLED/);
  assert.doesNotMatch(b.node("spot-content").innerHTML, /spot-position-status">CLOSED/);
  assert.equal(b.evaluate<number>("spotPositionEvents('entry-1').length"), 0);
  assert.equal(b.evaluate<boolean>("spotHistoryState('entry-1').expanded"), true);
  b.advance(5_000); const unavailable = b.refresh(); b.respond(2, { ...s, generatedAtMs: nowMs + 10_000, upstreamFetchedAtMs: nowMs + 10_000,
    orderActivity: { available: false, error: "JOURNAL_UNAVAILABLE" } }); await unavailable;
  assert.match(b.node("spot-content").innerHTML, /Position history unavailable/);
  assert.equal(b.evaluate<number>("spotPositionEvents('entry-1').length"), 0);
});

test("older activity pages URL-encode cursors, merge by event ID, and survive current snapshot refreshes", async () => {
  const b = browser(), s = positionSnapshot(), first = b.refresh(); b.respond(0, s); await first;
  b.evaluate("spotHistoryState('entry-1').expanded=true");
  const older = b.evaluate<Promise<void>>("loadEarlierSpotActivity('entry-1')");
  await b.evaluate<Promise<void>>("loadEarlierSpotActivity('entry-1')"); assert.equal(b.requests.length, 2);
  const url = new URL(b.requests[1]!.url, "https://dashboard.example");
  assert.equal(url.pathname, "/api/spot-order-activity"); assert.equal(url.searchParams.get("orderId"), "entry-1");
  assert.equal(url.searchParams.get("before"), "event-2&opaque?/ value");
  b.respond(1, { available: true, activity: { ...positionActivity(), totalNetUsd: 999,
    events: [{ id: "event-2", timestampMs: nowMs - 60_000, type: "FILLED" }, { id: "event-1", timestampMs: nowMs - 61_000, type: "SUBMITTED", reason: '<img src=x onerror="x">' }], nextCursor: null } }); await older;
  assert.equal(b.evaluate<number>("spotPositionEvents('entry-1').length"), 3);
  assert.equal(b.evaluate<boolean>("spotHistoryState('entry-1').expanded"), true);
  assert.match(b.node("spot-orders-grid").innerHTML, /&lt;img src=x onerror=&quot;x&quot;&gt;/);
  assert.doesNotMatch(b.node("spot-orders-grid").innerHTML, /\$999\.00|<img/);
  b.advance(5_000); const refresh = b.refresh(); b.respond(2, { ...s, generatedAtMs: nowMs + 5_000, upstreamFetchedAtMs: nowMs + 5_000,
    orderActivity: { ...s.orderActivity, orders: { "entry-1": { ...positionActivity(), totalEvents: 4,
      events: [{ id: "event-4", timestampMs: nowMs + 5_000, type: "STRATEGY_EVALUATION" }, ...positionActivity().events.slice(0, 1)] } } } }); await refresh;
  assert.equal(b.evaluate<number>("spotPositionEvents('entry-1').length"), 4);
  assert.equal(b.evaluate<boolean>("spotHistoryState('entry-1').expanded"), true);
  assert.equal(b.evaluate<null>("spotHistoryState('entry-1').nextCursor"), null);
  assert.match(b.node("spot-content").innerHTML, /data-spot-position-history="entry-1" open/);
  assert.equal((b.node("spot-content").innerHTML.match(/data-spot-position-event="event-2"/g) ?? []).length, 1);
  b.advance(5_000); const rolled = b.refresh(); b.respond(3, { ...s, generatedAtMs: nowMs + 10_000, upstreamFetchedAtMs: nowMs + 10_000,
    orderActivity: { ...s.orderActivity, orders: { "entry-1": { ...positionActivity(), totalEvents: 5,
      events: [{ id: "event-5", timestampMs: nowMs + 10_000, type: "STRATEGY_EVALUATION" }, { id: "event-4", timestampMs: nowMs + 5_000, type: "STRATEGY_EVALUATION" }] } } } }); await rolled;
  assert.equal(b.evaluate<number>("spotPositionEvents('entry-1').length"), 5, "the old tail of the latest window remains between new events and loaded older pages");
  assert.match(b.node("spot-content").innerHTML, /data-spot-position-event="event-3"/);
  assert.equal(b.evaluate<null>("spotHistoryState('entry-1').nextCursor"), null);
});

test("unfilled entry orders and loading position history are distinguished from missing history", async () => {
  const b = browser(), s = positionSnapshot();
  const first = b.refresh(); b.respond(0, { ...s, orderActivity: { ...s.orderActivity, orders: {} },
    state: { ...s.state, orders: [{ ...(s.state.orders[0] as object), filledQuantity: 0, status: "REJECTED" }] } }); await first;
  assert.match(b.node("spot-content").innerHTML, /No position opened yet/);
  assert.doesNotMatch(b.node("spot-content").innerHTML, /Position history unavailable|spot-position-status">CLOSED/);
  b.advance(5_000); const loading = b.refresh(); b.respond(1, { ...s, generatedAtMs: nowMs + 5_000, upstreamFetchedAtMs: nowMs + 5_000,
    orderActivity: { available: false, error: "SPOT_ACTIVITY_HISTORY_LOADING" } }); await loading;
  assert.match(b.node("spot-content").innerHTML, /Loading position history/);
  assert.doesNotMatch(b.node("spot-content").innerHTML, /Position history unavailable/);
});

test("pagination times out for retry and ignores results after the episode becomes unavailable", async () => {
  const b = browser(), s = positionSnapshot(), first = b.refresh(); b.respond(0, s); await first;
  const timed = b.evaluate<Promise<void>>("loadEarlierSpotActivity('entry-1')");
  b.advance(4_500); b.runTimers(); await timed;
  assert.equal(b.requests[1]!.options.signal.aborted, true);
  assert.equal(b.evaluate<boolean>("spotHistoryState('entry-1').loading"), false);
  assert.match(b.node("spot-orders-grid").innerHTML, /Earlier position history unavailable/);
  const retry = b.evaluate<Promise<void>>("loadEarlierSpotActivity('entry-1')"); assert.equal(b.requests.length, 3);
  b.advance(500); const refresh = b.refresh(); b.respond(3, { ...s, generatedAtMs: nowMs + 5_000, upstreamFetchedAtMs: nowMs + 5_000,
    orderActivity: { available: false } }); await refresh;
  b.respond(2, { available: true, activity: { ...positionActivity(), events: [{ id: "late-page", timestampMs: nowMs - 120_000, type: "FILLED" }], nextCursor: null } }); await retry;
  assert.equal(b.evaluate<number>("spotPositionEvents('entry-1').length"), 0);
  assert.match(b.node("spot-orders-grid").innerHTML, /Position history unavailable/);
  b.evaluate("location.search='?view=futures'"); await b.evaluate<Promise<void>>("loadEarlierSpotActivity('entry-1')");
  assert.equal(b.requests.length, 4);
});

test("position duration and recorded mark age tick without creating records; closed duration stays fixed", async () => {
  const b = browser(), s = positionSnapshot(), first = b.refresh(); b.respond(0, s); await first;
  const mark = { textContent: "", dataset: { spotPositionMarkAge: String(nowMs) } };
  const duration = { textContent: "", dataset: { spotPositionDuration: "entry-1" } };
  b.selectors.set("[data-spot-position-mark-age]", [mark]); b.selectors.set("[data-spot-position-duration]", [duration]);
  b.evaluate("updateSpotPositionAges()"); assert.equal(mark.textContent, "0s ago"); assert.equal(duration.textContent, "1m 0s");
  b.advance(1_000); b.evaluate("updateSpotPositionAges()");
  assert.equal(mark.textContent, "1s ago"); assert.equal(duration.textContent, "1m 1s"); assert.equal(b.requests.length, 1);
  assert.equal(b.evaluate<number>("spotPositionEvents('entry-1').length"), 2);
  b.evaluate(`spotView.snapshot.orderActivity.orders['entry-1'].positionStatus='CLOSED';spotView.snapshot.orderActivity.orders['entry-1'].closedAtMs=${nowMs};`);
  b.advance(1_000); b.evaluate("updateSpotPositionAges()"); assert.equal(duration.textContent, "1m 0s");
  b.advance(5_000); b.evaluate("updateSpotPositionAges()"); assert.equal(duration.textContent, "1m 0s");
  assert.equal(b.requests.length, 1);
});
