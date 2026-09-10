import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OperationsMonitor } from "../src/dashboard/operations-monitor.js";
import { DashboardServer } from "../src/dashboard/server.js";
import { SpotPaperStatusProxy } from "../src/dashboard/spot-proxy.js";

function status() {
  const nowMs = Date.now();
  return { system: "BTC spot weekly trend", mode: "RESEARCH_PAPER", liveTradingEnabled: false,
    provenProfitable: false, healthy: true, lastError: null, lastSuccessMs: nowMs,
    generatedAtMs: 1, orderSubmissionEnabled: true, strategy: { cycleIntervalMs: 300_000 },
    state: { version: "btc-spot-weekly-paper-v2", mode: "RESEARCH_PAPER", startedAtMs: nowMs - 1000,
      lastCycleMs: nowMs, cycles: 1, orders: [], account: { initialCashUsd: 100000, cashUsd: 100000,
        quantity: 0, entryCostUsd: 0, feesUsd: 0, realizedNetUsd: 0, receipts: [] } } };
}

async function upstream(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}/status`, close: async () => {
    server.closeAllConnections();
    await new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
  } };
}

function json(response: ServerResponse, value: unknown, code = 200) {
  response.writeHead(code, { "Content-Type": "application/json" }); response.end(JSON.stringify(value));
}

test("main dashboard proxies only its fixed paper URL, preserves other endpoints, and serves spot.js", async () => {
  const received: Array<{ path: string | undefined; authorization: string | undefined; cookie: string | undefined }> = [];
  const fixture = await upstream((request, response) => {
    received.push({ path: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie });
    json(response, status());
  });
  const publicDirectory = await mkdtemp(join(tmpdir(), "spot-dashboard-assets-"));
  const monitor = new OperationsMonitor();
  const dashboard = new DashboardServer(monitor, { host: "127.0.0.1", port: 0, publicDirectory,
    spotPaperStatusUrl: fixture.url });
  try {
    await writeFile(join(publicDirectory, "spot.js"), "window.spotPanelLoaded = true;\n");
    const base = await dashboard.start();
    const response = await fetch(`${base}/api/spot-dashboard?url=http://attacker.invalid/&target=http://other.invalid/`,
      { headers: { authorization: "Bearer must-not-forward", cookie: "session=must-not-forward" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const body = await response.json() as ReturnType<typeof status> & { available: boolean; orderActivity: { available: boolean } };
    assert.equal(body.available, true); assert.equal(body.mode, "RESEARCH_PAPER");
    assert.equal(body.liveTradingEnabled, false); assert.equal(body.state.account.cashUsd, 100000);
    assert.equal(body.orderActivity.available, false, "Missing history degrades only position activity, not paper telemetry");
    assert.ok(body.generatedAtMs > 1);
    assert.deepEqual(received, [{ path: "/status", authorization: undefined, cookie: undefined }]);
    const futures = await fetch(`${base}/api/dashboard`);
    assert.equal(futures.status, 200);
    const original = await futures.json() as { overall: string };
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, original.overall === "critical" ? 503 : 200);
    const asset = await fetch(`${base}/spot.js`);
    assert.equal(asset.status, 200); assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    assert.equal(await asset.text(), "window.spotPanelLoaded = true;\n");
    assert.equal((await fetch(`${base}/api/spot-dashboard`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/api/spot-order-activity`)).status, 400);
    assert.equal((await fetch(`${base}/api/spot-order-activity?orderId=${"x".repeat(241)}`)).status, 400);
    assert.equal((await fetch(`${base}/api/spot-order-activity?orderId=paper-order`, { method: "POST" })).status, 405);
    const absentActivity = await fetch(`${base}/api/spot-order-activity?orderId=paper-order`);
    assert.equal(absentActivity.status, 503);
    assert.equal((await absentActivity.json() as { available: boolean }).available, false);
    assert.equal((await fetch(`${base}/arbitrary.js`)).status, 404);
  } finally { await dashboard.stop(); monitor.stop(); await fixture.close(); await rm(publicDirectory, { recursive: true, force: true }); }
});

test("spot proxy shares one in-flight request and a bounded cache between dashboard clients", async () => {
  let calls = 0;
  const fixture = await upstream((_request, response) => { calls++; setTimeout(() => json(response, status()), 15); });
  try {
    const proxy = new SpotPaperStatusProxy({ statusUrl: fixture.url });
    const results = await Promise.all(Array.from({ length: 20 }, () => proxy.snapshot()));
    assert.ok(results.every(result => result.statusCode === 200)); assert.equal(calls, 1);
    const cached = await proxy.snapshot(); assert.equal(cached.statusCode, 200); assert.equal(calls, 1);
    assert.equal(cached.body.upstreamFetchedAtMs, results[0]!.body.upstreamFetchedAtMs);
    assert.ok((cached.body.generatedAtMs as number) >= (cached.body.upstreamFetchedAtMs as number));
  } finally { await fixture.close(); }
});

test("spot proxy preserves paper order transitions, fills, and durable rejection details", async () => {
  const value: Record<string, any> = status(), nowMs = Date.now();
  const request = { clientOrderId: "entry-1", symbol: "BTC/USD", side: "buy", quantity: .001,
    limitPrice: 100001, timeInForce: "ioc", reduceOnly: false, createdAtMs: nowMs, feeBps: 40 };
  const fill = { id: "entry-1", side: "buy", quantity: .001, price: 100000, feeBps: 40, timestampMs: nowMs };
  value.state.orders = [{ request, orderId: "paper-spot-order-1", status: "FILLED", filledQuantity: .001,
    averageFillPrice: 100000, feeUsd: .4, rejectionReason: null, cancellationReason: null,
    events: ["SUBMITTED", "ACCEPTED", "FILLED"].map(type => ({ type, timestampMs: nowMs })), fill },
  { request: { ...request, clientOrderId: "invalid-2", quantity: -1 }, orderId: "paper-spot-order-2", status: "REJECTED",
    filledQuantity: 0, averageFillPrice: null, feeUsd: 0, rejectionReason: "INVALID_QUANTITY_OR_PRICE", cancellationReason: null,
    events: [{ type: "SUBMITTED", timestampMs: nowMs },
      { type: "REJECTED", timestampMs: nowMs, detail: "INVALID_QUANTITY_OR_PRICE" }], fill: null }];
  value.state.account = { initialCashUsd: 100000, cashUsd: 99899.6, quantity: .001, entryCostUsd: 100.4,
    feesUsd: .4, realizedNetUsd: 0, receipts: [fill] };
  const fixture = await upstream((_request, response) => json(response, value));
  try {
    const result = await new SpotPaperStatusProxy({ statusUrl: fixture.url }).snapshot();
    assert.equal(result.statusCode, 200); assert.deepEqual(result.body.state, value.state);
  } finally { await fixture.close(); }
});

test("an expired successful cache never hides an upstream failure with stale green telemetry", async () => {
  let fail = false;
  const fixture = await upstream((_request, response) => json(response, fail ? { internal: "private stack" } : status(), fail ? 500 : 200));
  try {
    const proxy = new SpotPaperStatusProxy({ statusUrl: fixture.url, cacheMs: 20 });
    assert.equal((await proxy.snapshot()).statusCode, 200); fail = true;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
    const result = await proxy.snapshot();
    assert.equal(result.statusCode, 503);
    assert.deepEqual(Object.keys(result.body).sort(), ["available", "error", "generatedAtMs"]);
    assert.equal(result.body.available, false); assert.equal(result.body.error, "SPOT_PAPER_UNAVAILABLE");
    assert.equal(result.body.healthy, undefined);
  } finally { await fixture.close(); }
});

test("spot proxy rejects live mode, malformed accounting, order arrays, and non-JSON statuses", async t => {
  const invalid: Array<[string, (value: Record<string, any>) => unknown]> = [
    ["live mode", value => ({ ...value, mode: "LIVE" })],
    ["live enabled", value => ({ ...value, liveTradingEnabled: true })],
    ["claimed proof", value => ({ ...value, provenProfitable: true })],
    ["missing account", value => { delete value.state.account; return value; }],
    ["non-finite cash", value => { value.state.account.cashUsd = Infinity; return value; }],
    ["negative quantity", value => { value.state.account.quantity = -1; return value; }],
    ["invalid timestamp", value => { value.state.lastCycleMs = "today"; return value; }],
    ["invalid receipts", value => { value.state.account.receipts = [null]; return value; }],
    ["missing enabled orders", value => { delete value.state.orders; return value; }],
    ["invalid order", value => { value.state.orders = [{ status: "FILLED" }]; return value; }],
    ["null response", () => null], ["array response", () => []],
  ];
  for (const [name, mutate] of invalid) await t.test(name, async () => {
    const fixture = await upstream((_request, response) => json(response, mutate(status())));
    try { assert.equal((await new SpotPaperStatusProxy({ statusUrl: fixture.url }).snapshot()).statusCode, 503); }
    finally { await fixture.close(); }
  });
  await t.test("HTML response", async () => {
    const fixture = await upstream((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end("private error"); });
    try { assert.equal((await new SpotPaperStatusProxy({ statusUrl: fixture.url }).snapshot()).statusCode, 503); }
    finally { await fixture.close(); }
  });
});

test("spot proxy caps both declared and streamed response bodies", async t => {
  for (const declared of [true, false]) await t.test(declared ? "content length" : "chunked stream", async () => {
    const fixture = await upstream((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json", ...(declared ? { "Content-Length": String(2 * 1024 * 1024 + 1) } : {}) });
      response.end("x".repeat(2 * 1024 * 1024 + 1));
    });
    try {
      const result = await new SpotPaperStatusProxy({ statusUrl: fixture.url }).snapshot();
      assert.equal(result.statusCode, 503); assert.equal(result.body.error, "SPOT_PAPER_UNAVAILABLE");
    } finally { await fixture.close(); }
  });
});

test("spot proxy never follows an upstream redirect", async () => {
  let redirected = 0;
  const fixture = await upstream((request, response) => {
    if (request.url === "/status") { response.writeHead(302, { Location: "/private" }); response.end(); }
    else { redirected++; json(response, status()); }
  });
  try {
    assert.equal((await new SpotPaperStatusProxy({ statusUrl: fixture.url }).snapshot()).statusCode, 503);
    assert.equal(redirected, 0);
  } finally { await fixture.close(); }
});

test("spot proxy enforces its deadline through both headers and body streaming", async t => {
  for (const sendHeaders of [false, true]) await t.test(sendHeaders ? "body stalls" : "headers stall", async () => {
    const fixture = await upstream((_request, response) => {
      if (sendHeaders) { response.writeHead(200, { "Content-Type": "application/json" }); response.write("{"); }
    });
    try {
      const started = Date.now();
      const result = await new SpotPaperStatusProxy({ statusUrl: fixture.url, timeoutMs: 30 }).snapshot();
      assert.equal(result.statusCode, 503); assert.ok(Date.now() - started < 1000);
    } finally { await fixture.close(); }
  });
});

test("a cached response cannot claim health with stale or future upstream success time", async t => {
  for (const offset of [-600_001, 10_000]) await t.test(String(offset), async () => {
    const fixture = await upstream((_request, response) => json(response, { ...status(), lastSuccessMs: Date.now() + offset }));
    try {
      const result = await new SpotPaperStatusProxy({ statusUrl: fixture.url }).snapshot();
      assert.equal(result.statusCode, 200); assert.equal(result.body.healthy, false);
      assert.equal(result.body.lastError, "SPOT_PAPER_STATUS_STALE");
    } finally { await fixture.close(); }
  });
});

test("invalid or credential-bearing upstream configuration fails closed without throwing", async () => {
  for (const statusUrl of ["not-a-url", "file:///etc/passwd", "http://user:secret@127.0.0.1/status", "http://127.0.0.1/status#fragment"])
    assert.equal((await new SpotPaperStatusProxy({ statusUrl }).snapshot()).statusCode, 503);
});
