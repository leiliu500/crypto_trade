import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Eth40PaperProxy } from "../src/dashboard/eth40-proxy.js";
import { OperationsMonitor } from "../src/dashboard/operations-monitor.js";
import { DashboardServer } from "../src/dashboard/server.js";
import { createPaperState, runPaperCycle } from "../src/eth40/engine.js";
import { ETH40_SPEC } from "../src/eth40/spec.js";
import { eth40Status } from "../src/eth40/status.js";
import type { MarketSnapshot } from "../src/eth40/types.js";

function fixtures() {
  const now = Date.now(), state = createPaperState(now);
  const market: MarketSnapshot = { observedAtMs: now, histories: { "ETH/USD": [], "BTC/USD": [] },
    books: {}, rules: {}, rulesFetchedAtMs: 0, errors: [], evidenceIds: [] };
  const lastCycle = runPaperCycle(state, market, "test-cycle");
  const status = eth40Status({ state: lastCycle.state, sequence: 2, lastHash: "a".repeat(64), lastCycle, market,
    processStartedAtMs: now, fatalError: null, nowMs: now });
  const receipts = Object.fromEntries(Object.entries(state.portfolios).map(([id, p]) => [id, { symbol: p.symbol, account: p.account }]));
  const manifest = { version: "eth40-frozen-runtime-v1", spec: ETH40_SPEC, runtimeSha256: "b".repeat(64),
    fingerprints: [{ file: "src/eth40/engine.ts", sha256: "c".repeat(64) }], researchStatus: "Prospective paper observation" };
  return { status, receipts, manifest };
}
function spotStatus() {
  const now = Date.now();
  return { system: "BTC spot weekly trend", mode: "RESEARCH_PAPER", liveTradingEnabled: false, provenProfitable: false,
    healthy: true, lastSuccessMs: now, lastError: null, strategy: { cycleIntervalMs: 300_000 },
    state: { version: "btc-spot-weekly-paper-v2", mode: "RESEARCH_PAPER", startedAtMs: now, lastCycleMs: now, cycles: 1,
      account: { initialCashUsd: 100_000, cashUsd: 100_000, quantity: 0, entryCostUsd: 0, feesUsd: 0, realizedNetUsd: 0, receipts: [] } } };
}
async function upstream(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes()));
  } };
}
function json(response: ServerResponse, value: unknown, code = 200) {
  response.writeHead(code, { "Content-Type": "application/json" }); response.end(JSON.stringify(value));
}
function unavailable(result: { statusCode: number; body: unknown }) {
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.body, { available: false, error: "ETH40_PAPER_UNAVAILABLE" });
}

test("ETH40 same-origin routes serve fixed read-only paths and eth40.js without forwarding queries or credentials", async () => {
  const payload = fixtures();
  const received: Array<{ url: string | undefined; method: string | undefined; authorization: string | undefined; cookie: string | undefined }> = [];
  const source = await upstream((request, response) => {
    received.push({ url: request.url, method: request.method, authorization: request.headers.authorization, cookie: request.headers.cookie });
    const resource = request.url?.slice("/api/".length) as keyof typeof payload;
    json(response, payload[resource] ?? { error: "wrong_path" }, payload[resource] ? 200 : 404);
  });
  const publicDirectory = await mkdtemp(join(tmpdir(), "eth40-dashboard-assets-"));
  const monitor = new OperationsMonitor(), dashboard = new DashboardServer(monitor, { host: "127.0.0.1", port: 0,
    publicDirectory, eth40PaperBaseUrl: source.url });
  try {
    await writeFile(join(publicDirectory, "eth40.js"), "window.eth40PanelLoaded = true;\n");
    const base = await dashboard.start(), start = Date.now();
    const response = await fetch(`${base}/api/eth40/status?url=http://attacker.invalid/&resource=private`,
      { headers: { authorization: "Bearer do-not-forward", cookie: "private=do-not-forward" } });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.available, true); assert.ok((body.dashboardFetchedAtMs as number) >= start);
    const { available, dashboardFetchedAtMs, ...original } = body;
    assert.deepEqual(original, JSON.parse(JSON.stringify(payload.status)));
    for (const endpoint of ["receipts", "manifest"] as const) {
      const result = await fetch(`${base}/api/eth40/${endpoint}`); assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), payload[endpoint]);
    }
    for (const endpoint of ["status", "receipts", "manifest"] as const) {
      const head = await fetch(`${base}/api/eth40/${endpoint}`, { method: "HEAD" });
      assert.equal(head.status, 200); assert.match(head.headers.get("content-type") ?? "", /application\/json/);
      assert.equal(await head.text(), "");
      for (const method of ["POST", "PUT", "DELETE", "PATCH"])
        assert.equal((await fetch(`${base}/api/eth40/${endpoint}`, { method })).status, 405);
    }
    assert.deepEqual(received, ["status", "receipts", "manifest"].map(resource => ({ url: `/api/${resource}`,
      method: "GET", authorization: undefined, cookie: undefined })));
    assert.equal((await fetch(`${base}/api/eth40/private`)).status, 404);
    assert.equal((await fetch(`${base}/api/eth40/status/extra`)).status, 404);
    const script = await fetch(`${base}/eth40.js`);
    assert.equal(script.status, 200); assert.match(script.headers.get("content-type") ?? "", /javascript/);
    assert.equal(await script.text(), "window.eth40PanelLoaded = true;\n");
  } finally { await dashboard.stop(); monitor.stop(); await source.close(); await rm(publicDirectory, { recursive: true, force: true }); }
});

test("ETH40 upstream failure leaves BTC spot, futures and dashboard health routes accessible", async () => {
  const source = await upstream((request, response) => request.url === "/spot/status"
    ? json(response, spotStatus()) : json(response, { private: "unavailable stack" }, 500));
  const monitor = new OperationsMonitor(), dashboard = new DashboardServer(monitor, { host: "127.0.0.1", port: 0,
    eth40PaperBaseUrl: source.url, spotPaperStatusUrl: `${source.url}/spot/status` });
  try {
    const base = await dashboard.start();
    const eth = await fetch(`${base}/api/eth40/status`);
    unavailable({ statusCode: eth.status, body: await eth.json() });
    const btc = await fetch(`${base}/api/spot-dashboard`); assert.equal(btc.status, 200);
    assert.equal((await btc.json() as { system: string }).system, "BTC spot weekly trend");
    const futures = await fetch(`${base}/api/dashboard`); assert.equal(futures.status, 200);
    const state = await futures.json() as { overall: string };
    assert.equal((await fetch(`${base}/healthz`)).status, state.overall === "critical" ? 503 : 200);
  } finally { await dashboard.stop(); monitor.stop(); await source.close(); }
});

test("ETH40 proxy deduplicates concurrent reads per endpoint and preserves actual fetch time in its short cache", async () => {
  const payload = fixtures(), calls: string[] = [];
  const source = await upstream((request, response) => {
    calls.push(request.url!); const resource = request.url!.slice(5) as keyof typeof payload;
    setTimeout(() => json(response, payload[resource]), 15);
  });
  try {
    const proxy = new Eth40PaperProxy({ baseUrl: source.url });
    const results = await Promise.all(Array.from({ length: 20 }, () => proxy.read("status")));
    assert.ok(results.every(r => r.statusCode === 200)); assert.deepEqual(calls, ["/api/status"]);
    assert.equal((await proxy.read("status")).body.dashboardFetchedAtMs, results[0]!.body.dashboardFetchedAtMs);
    results[0]!.body.spec = { liveTradingEnabled: true };
    assert.deepEqual((await proxy.read("status")).body.spec, ETH40_SPEC, "caller mutations cannot modify cached identity");
    await Promise.all(Array.from({ length: 8 }, () => proxy.read("receipts")));
    assert.deepEqual(calls, ["/api/status", "/api/receipts"]);
  } finally { await source.close(); }
});

test("ETH40 proxy preserves legitimate stale status and null held-position PnL", async () => {
  const value = fixtures().status;
  value.collectorHealthy = false; value.recordedAtMs -= 300_000; value.heartbeatAgeMs = 300_000;
  value.accounts[0]!.quantity = 1; value.accounts[0]!.liquidationEquityUsd = null; value.accounts[0]!.netPnlUsd = null;
  value.accounts[0]!.returnOnAccountPct = null; value.accounts[0]!.fresh = false;
  value.excessVsCashUsd = null; value.excessVsPassiveEthUsd = null; value.excessVsPassiveBtcUsd = null;
  const source = await upstream((_request, response) => json(response, value));
  try {
    const result = await new Eth40PaperProxy({ baseUrl: source.url }).read("status");
    assert.equal(result.statusCode, 200); assert.equal(result.body.collectorHealthy, false);
    assert.deepEqual(result.body.accounts, value.accounts); assert.equal(result.body.recordedAtMs, value.recordedAtMs);
    assert.equal(result.body.excessVsCashUsd, null);
  } finally { await source.close(); }
});

test("expired ETH40 successes never mask a failed upstream with cached success data", async () => {
  let fail = false;
  const source = await upstream((_request, response) => json(response, fail ? { stack: "private failure" } : fixtures().status, fail ? 500 : 200));
  try {
    const proxy = new Eth40PaperProxy({ baseUrl: source.url, cacheMs: 20 });
    assert.equal((await proxy.read("status")).statusCode, 200); fail = true;
    await new Promise<void>(yes => setTimeout(yes, 25)); unavailable(await proxy.read("status"));
    unavailable(await proxy.read("receipts")); unavailable(await proxy.read("manifest"));
  } finally { await source.close(); }
});

test("ETH40 validates service identity, paper flags, account symbols and financial schema", async t => {
  const changes: Array<[string, (value: Record<string, any>) => unknown]> = [
    ["wrong service", value => ({ ...value, service: "BTC futures" })],
    ["live trading", value => ({ ...value, liveTradingEnabled: true })],
    ["promotion", value => ({ ...value, automaticPromotionAllowed: true })],
    ["profit claim", value => ({ ...value, validatedProfitable: true })],
    ["wrong candidate", value => { value.spec.candidateId = "btc-other"; return value; }],
    ["live spec", value => { value.spec.liveTradingEnabled = true; return value; }],
    ["wrong strategy asset", value => { value.accounts[0].symbol = "BTC/USD"; return value; }],
    ["wrong benchmark asset", value => { value.accounts[2].symbol = "ETH/USD"; return value; }],
    ["duplicate account", value => { value.accounts[2] = value.accounts[0]; return value; }],
    ["negative cash", value => { value.accounts[0].cashUsd = -1; return value; }],
    ["string PnL", value => { value.accounts[0].netPnlUsd = "100"; return value; }],
    ["wrong quote asset", value => { value.capturedMarkets.quotes = [{ symbol: "SOL/USD" }]; return value; }],
    ["array", () => []], ["null", () => null],
  ];
  for (const [name, change] of changes) await t.test(name, async () => {
    const value = change(structuredClone(fixtures().status));
    let otherRequests = 0;
    const source = await upstream((request, response) => { if (request.url !== "/api/status") otherRequests++; json(response, value); });
    try {
      const proxy = new Eth40PaperProxy({ baseUrl: source.url });
      unavailable(await proxy.read("status")); unavailable(await proxy.read("receipts")); unavailable(await proxy.read("manifest"));
      assert.equal(otherRequests, 0, "invalid paper identity prevents auxiliary requests");
    } finally { await source.close(); }
  });
});

test("ETH40 auxiliary responses are validated against their account and frozen-manifest identities", async t => {
  for (const endpoint of ["receipts", "manifest"] as const) await t.test(endpoint, async () => {
    const payload = fixtures();
    if (endpoint === "receipts") payload.receipts.eth40!.symbol = "BTC/USD";
    else payload.manifest.version = "live-runtime";
    const source = await upstream((request, response) => json(response, payload[request.url!.slice(5) as keyof typeof payload]));
    try { unavailable(await new Eth40PaperProxy({ baseUrl: source.url }).read(endpoint)); }
    finally { await source.close(); }
  });
});

test("ETH40 rejects malformed JSON, non-JSON responses, and invalid UTF-8 without exposing upstream details", async t => {
  for (const kind of ["json", "html", "utf8"]) await t.test(kind, async () => {
    const source = await upstream((_request, response) => {
      response.writeHead(200, { "Content-Type": kind === "html" ? "text/html" : "application/json" });
      response.end(kind === "utf8" ? Buffer.from([0xff]) : "private malformed upstream response");
    });
    try { unavailable(await new Eth40PaperProxy({ baseUrl: source.url }).read("status")); }
    finally { await source.close(); }
  });
});

test("ETH40 caps declared and streamed upstream response bodies", async t => {
  for (const declared of [true, false]) await t.test(declared ? "content-length" : "stream", async () => {
    const source = await upstream((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json", ...(declared ? { "Content-Length": String(2 * 1024 * 1024 + 1) } : {}) });
      response.end("x".repeat(2 * 1024 * 1024 + 1));
    });
    try { unavailable(await new Eth40PaperProxy({ baseUrl: source.url }).read("status")); }
    finally { await source.close(); }
  });
});

test("ETH40 proxy never follows redirects and enforces both header and streaming deadlines", async t => {
  await t.test("redirect", async () => {
    let followed = 0;
    const source = await upstream((request, response) => {
      if (request.url === "/api/status") { response.writeHead(302, { Location: "/private" }); response.end(); }
      else { followed++; json(response, fixtures().status); }
    });
    try { unavailable(await new Eth40PaperProxy({ baseUrl: source.url }).read("status")); assert.equal(followed, 0); }
    finally { await source.close(); }
  });
  for (const headers of [false, true]) await t.test(headers ? "stalled body" : "stalled headers", async () => {
    const source = await upstream((_request, response) => {
      if (headers) { response.writeHead(200, { "Content-Type": "application/json" }); response.write("{"); }
    });
    try {
      const start = Date.now(); unavailable(await new Eth40PaperProxy({ baseUrl: source.url, timeoutMs: 30 }).read("status"));
      assert.ok(Date.now() - start < 1_000);
    } finally { await source.close(); }
  });
});

test("ETH40 rejects invalid origin configuration and cannot address arbitrary resources", async () => {
  for (const baseUrl of ["not-url", "file:///etc/passwd", "http://user:secret@127.0.0.1", "http://127.0.0.1?url=other",
    "http://127.0.0.1#fragment", "http://127.0.0.1/private"])
    unavailable(await new Eth40PaperProxy({ baseUrl }).read("status"));
  unavailable(await new Eth40PaperProxy().read("constructor" as "status"));
  assert.throws(() => new Eth40PaperProxy({ timeoutMs: 2_001 }), /INVALID_ETH40_PROXY_LIMITS/);
  assert.throws(() => new Eth40PaperProxy({ cacheMs: 3_001 }), /INVALID_ETH40_PROXY_LIMITS/);
});
