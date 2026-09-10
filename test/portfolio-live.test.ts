import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, RequestListener, Server, ServerResponse } from "node:http";
import test from "node:test";
import { acquirePortfolioCheckpointOwnership, fetchPortfolioClosedHistory, runPortfolioShadow,
  type PortfolioShadowRuntimeDependencies } from "../src/portfolio/live-main.js";
import { PORTFOLIO_DAY_MS as DAY, PORTFOLIO_HOUR_MS as HOUR, type AssetRules,
  type HourlyBar, type Pair } from "../src/portfolio/types.js";

const T = Date.UTC(2024, 0, 1), symbols = ["BTC/USD", "ETH/USD"] as const;
const rules: Pair<AssetRules> = {
  "BTC/USD": { symbol: "BTC/USD", minOrderSize: .01, minTradeIncrement: .01, priceIncrement: .01, maximumOrderQty: 100, shortable: true },
  "ETH/USD": { symbol: "ETH/USD", minOrderSize: .01, minTradeIncrement: .01, priceIncrement: .01, maximumOrderQty: 100, shortable: true },
};
class FakeStream extends EventEmitter {
  connected = 0; closed = 0;
  connect() { this.connected++; }
  close() { this.closed++; }
}
class FakeServer extends EventEmitter {
  listening = false; closed = 0;
  constructor(readonly listener: RequestListener) { super(); }
  listen(_port: number, _host: string, callback: () => void) { this.listening = true; queueMicrotask(callback); }
  close(callback: () => void) { this.listening = false; this.closed++; queueMicrotask(callback); }
  request(path: string) {
    let code = 0, body = "";
    this.listener({ url: path } as IncomingMessage, { writeHead: (value: number) => { code = value; },
      end: (value?: string) => { body = value ?? ""; } } as unknown as ServerResponse);
    return { code, body: body ? JSON.parse(body) as Record<string, unknown> : null };
  }
}
function history(from = T - 362 * DAY, to = T) {
  const result: HourlyBar[] = [];
  for (let t = from; t < to; t += HOUR) for (const symbol of symbols) {
    const p = 100 + (t - from) / DAY / 10;
    result.push({ symbol, openMs: t, open: p, high: p, low: p, close: p, volume: 1 });
  }
  return result;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "portfolio-live-test-")), study = join(root, "study"), checkpoint = join(root, "state.json");
  await mkdir(study);
  const stream = new FakeStream(), clock = { now: T + 2 * HOUR };
  let server: FakeServer | undefined;
  const dependencies: PortfolioShadowRuntimeDependencies = {
    preflight: async () => ({ allowed: true, reason: "SYNTHETIC_TEST", realOrdersAllowed: false }),
    loadInstruments: async () => new Map(symbols.map(symbol => [symbol, { symbol, productId: symbol,
      tickSize: .01, quantityIncrement: .01, maximumOrderQty: 100 }])),
    readRules: async () => structuredClone(rules), fetchHistory: async () => history(),
    createStream: () => stream,
    createHttpServer: listener => { server = new FakeServer(listener!); return server as unknown as Server; },
    now: () => clock.now,
  };
  return { root, study, checkpoint, stream, clock, dependencies, server: () => server!,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}
function book(stream: FakeStream, symbol: typeof symbols[number], at: number, suffix = "") {
  stream.emit("book", { symbol, bids: [{ px: 100, qty: 1 }], asks: [{ px: 100.01, qty: 1 }], reset: true,
    exchangeTsMs: at, receiveTsMs: at, sourceId: `${symbol}:${at}:${suffix}` });
}

test("closed history partitions large windows and excludes each inclusive API endpoint", async () => {
  const from = T, to = T + 6000 * HOUR, calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); calls.push(url.toString());
    const start = Number(url.searchParams.get("from")) * 1000, end = Number(url.searchParams.get("to")) * 1000;
    const candles = [];
    for (let t = start; t <= end; t += HOUR) candles.push({ time: t, open: "100", high: "101", low: "99", close: "100", volume: "1" });
    return new Response(JSON.stringify({ candles, more_candles: false }), { status: 200 });
  };
  const rows = await fetchPortfolioClosedHistory(from, to, to + 60_000, fetcher);
  assert.equal(calls.length, 4); assert.equal(rows.length, 12000);
  assert.equal(Math.max(...rows.map(r => r.openMs)), to - HOUR);
  assert.equal(new Set(rows.map(r => `${r.symbol}:${r.openMs}`)).size, rows.length);
  assert.ok(calls.every(call => call.startsWith("https://futures.kraken.com/api/charts/v1/trade/PF_")));
});

test("unfinalized history is denied before fetch and missing completed hours are rejected", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ candles: [], more_candles: false })); };
  await assert.rejects(fetchPortfolioClosedHistory(T, T + HOUR, T + HOUR + 59_999, fetcher), /LIVE_HISTORY_WINDOW/);
  assert.equal(calls, 0);
  await assert.rejects(fetchPortfolioClosedHistory(T, T + HOUR, T + HOUR + 60_000, fetcher), /LIVE_HISTORY_GAP/);
});

test("exclusive checkpoint lock rejects a second writer without overwriting state and releases once", async () => {
  const f = await fixture();
  try {
    await writeFile(f.checkpoint, "existing-checkpoint");
    const owner = await acquirePortfolioCheckpointOwnership(f.checkpoint);
    const lockBefore = await readFile(owner.lockPath, "utf8"), metadata = JSON.parse(lockBefore);
    assert.equal(metadata.pid, process.pid); assert.equal(metadata.token, owner.token);
    await assert.rejects(acquirePortfolioCheckpointOwnership(f.checkpoint), /ALREADY_OWNED/);
    assert.equal(await readFile(f.checkpoint, "utf8"), "existing-checkpoint");
    assert.equal(await readFile(owner.lockPath, "utf8"), lockBefore);
    await Promise.all([owner.release(), owner.release()]);
    await assert.rejects(readFile(owner.lockPath), { code: "ENOENT" });
    const replacement = await acquirePortfolioCheckpointOwnership(f.checkpoint); await replacement.release();
  } finally { await f.cleanup(); }
});

test("ownership release cannot remove a replaced lock belonging to another token", async () => {
  const f = await fixture();
  try {
    const owner = await acquirePortfolioCheckpointOwnership(f.checkpoint);
    await writeFile(owner.lockPath, JSON.stringify({ token: "another-owner", pid: process.pid, checkpointPath: f.checkpoint }));
    await assert.rejects(owner.release(), /OWNERSHIP_CHANGED/);
    assert.equal(JSON.parse(await readFile(owner.lockPath, "utf8")).token, "another-owner");
  } finally { await f.cleanup(); }
});

test("denied preflight opens no checkpoint and performs no instrument/history request", async () => {
  const f = await fixture(); let calls = 0;
  try {
    await assert.rejects(runPortfolioShadow(f.study, f.checkpoint, 3002, { ...f.dependencies,
      preflight: async () => ({ allowed: false, reason: "SYNTHETIC_STAGE_DENIED", realOrdersAllowed: false }),
      loadInstruments: async () => { calls++; throw new Error("SHOULD_NOT_FETCH"); },
      fetchHistory: async () => { calls++; throw new Error("SHOULD_NOT_FETCH"); } }), /SYNTHETIC_STAGE_DENIED/);
    assert.equal(calls, 0);
    await assert.rejects(readFile(f.checkpoint), { code: "ENOENT" });
    await assert.rejects(readFile(`${f.checkpoint}.lock`), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("initialization failures clean up only the acquired owner lock", async () => {
  const f = await fixture();
  try {
    await assert.rejects(runPortfolioShadow(f.study, f.checkpoint, 3002, { ...f.dependencies,
      loadInstruments: async () => { throw new Error("SYNTHETIC_INSTRUMENT_FAILURE"); } }), /SYNTHETIC_INSTRUMENT_FAILURE/);
    await assert.rejects(readFile(`${f.checkpoint}.lock`), { code: "ENOENT" });
    await assert.rejects(readFile(f.checkpoint), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("runtime second owner is rejected before restore and close is idempotent", async () => {
  const f = await fixture(); let runtime: Awaited<ReturnType<typeof runPortfolioShadow>> | undefined;
  try {
    runtime = await runPortfolioShadow(f.study, f.checkpoint, 3002, f.dependencies);
    await runtime.refresh(); await runtime.waitForIdle();
    const before = await readFile(f.checkpoint, "utf8");
    await assert.rejects(runPortfolioShadow(f.study, f.checkpoint, 3003, f.dependencies), /ALREADY_OWNED/);
    assert.equal(await readFile(f.checkpoint, "utf8"), before);
    await Promise.all([runtime.close(), runtime.close()]);
    assert.equal(f.stream.closed, 1); assert.equal(f.server().closed, 1);
    await assert.rejects(readFile(`${f.checkpoint}.lock`), { code: "ENOENT" });
  } finally { await runtime?.close(); await f.cleanup(); }
});

test("health uses read-time freshness and disconnect discards already queued public books", async () => {
  const f = await fixture(); const runtime = await runPortfolioShadow(f.study, f.checkpoint, 3002, f.dependencies);
  try {
    await runtime.refresh(); await runtime.waitForIdle();
    book(f.stream, "BTC/USD", f.clock.now); book(f.stream, "ETH/USD", f.clock.now);
    f.stream.emit("disconnect"); await runtime.waitForIdle();
    let status = f.server().request("/api/status");
    assert.equal(status.body!.quoteReady, false);
    assert.equal((status.body!.counters as Record<string, number>).fills, 0);
    assert.equal((status.body!.counters as Record<string, number>).quoteUpdates, 0);
    book(f.stream, "BTC/USD", f.clock.now, "new"); book(f.stream, "ETH/USD", f.clock.now, "new");
    await runtime.waitForIdle(); f.clock.now += 300;
    book(f.stream, "BTC/USD", f.clock.now); await runtime.waitForIdle();
    assert.equal(f.server().request("/healthz").code, 200);
    f.clock.now += 6000;
    status = f.server().request("/api/status");
    assert.equal(status.code, 200); assert.equal(status.body!.healthy, false); assert.equal(status.body!.quoteReady, false);
    assert.equal(f.server().request("/healthz").code, 503);
  } finally { await runtime.close(); await f.cleanup(); }
});

test("temporary history failure is retried without stopping quote or exit processing", async () => {
  const f = await fixture(); let calls = 0;
  const runtime = await runPortfolioShadow(f.study, f.checkpoint, 3002, { ...f.dependencies,
    fetchHistory: async () => { if (++calls === 1) throw new Error("SYNTHETIC_RETRY"); return history(); } });
  try {
    await runtime.waitForIdle();
    assert.equal(f.server().request("/api/status").body!.halted, false);
    await runtime.refresh(); await runtime.waitForIdle();
    const status = f.server().request("/api/status").body!;
    assert.equal(calls, 2); assert.equal(status.historyError, null); assert.equal(status.dataReady, true);
  } finally { await runtime.close(); await f.cleanup(); }
});

test("restored daily history correction invalidates target while fresh quotes can still reduce inventory", async () => {
  const f = await fixture(); let runtime = await runPortfolioShadow(f.study, f.checkpoint, 3002, f.dependencies);
  const quotes = async () => {
    book(f.stream, "BTC/USD", f.clock.now); book(f.stream, "ETH/USD", f.clock.now);
    await runtime.waitForIdle();
  };
  try {
    await runtime.refresh(); await runtime.waitForIdle();
    await quotes(); f.clock.now += 300; await quotes(); f.clock.now += 300; await quotes(); f.clock.now += 300; await quotes();
    const before = f.server().request("/api/status").body!;
    assert.ok(Object.values(before.actual as Record<string, { qty: number }>).some(p => p.qty !== 0));
    await runtime.close();
    f.stream.removeAllListeners(); f.clock.now = T + 3 * HOUR;
    runtime = await runPortfolioShadow(f.study, f.checkpoint, 3002, { ...f.dependencies,
      fetchHistory: async () => {
        const rows = history(); const last = rows.at(-1)!;
        last.close *= 1.01; last.high = last.close; return rows;
      } });
    await runtime.refresh(); await runtime.waitForIdle();
    let status = f.server().request("/api/status").body!;
    assert.equal(status.halted, false); assert.equal(status.dataReady, false);
    assert.equal(status.historyError, "PORTFOLIO_LIVE_HISTORY_CORRECTION");
    await quotes(); f.clock.now += 300; await quotes(); f.clock.now += 300; await quotes(); f.clock.now += 300; await quotes();
    status = f.server().request("/api/status").body!;
    assert.ok(Object.values(status.actual as Record<string, { qty: number }>).every(p => p.qty === 0));
    assert.equal(status.halted, false);
  } finally { await runtime.close(); await f.cleanup(); }
});
