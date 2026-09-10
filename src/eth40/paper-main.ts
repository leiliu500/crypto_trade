import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEth40Bootstrap } from "./bootstrap.js";
import { createPaperState, runPaperCycle } from "./engine.js";
import { Eth40Market } from "./market.js";
import { openEth40Store } from "./store.js";
import { DAY_MS, ETH40_SPEC } from "./spec.js";
import { eth40Status, ETH40_PAGE } from "./status.js";
import type { CycleResult, MarketSnapshot } from "./types.js";

export async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? "data/eth40-paper");
  const port = Number(process.env.ETH40_PORT ?? 3003);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("ETH40_INVALID_PORT");
  const bootstrap = await loadEth40Bootstrap();
  const store = await openEth40Store(root, bootstrap.manifest, () => createPaperState(Date.now()));
  const restored = store.latestMarketHistories;
  const market = new Eth40Market({
    "ETH/USD": restored?.["ETH/USD"].length ? restored["ETH/USD"] : bootstrap.histories["ETH/USD"],
    "BTC/USD": restored?.["BTC/USD"].length ? restored["BTC/USD"] : bootstrap.histories["BTC/USD"],
  }, (kind, payload) => store.evidence(kind, payload));
  const processStartedAtMs = Date.now();
  let lastCycle: CycleResult | null = null, lastMarket: MarketSnapshot | null = null;
  let fatalError: string | null = null, stopping = false;
  let wake: (() => void) | undefined;
  const status = () => eth40Status({ state: store.state, sequence: store.sequence, lastHash: store.lastHash,
    lastCycle, market: lastMarket, processStartedAtMs, fatalError, nowMs: Date.now() });
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); response.end(); return; }
    const path = request.url?.split("?")[0];
    if (path === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(ETH40_PAGE); return;
    }
    let result: unknown;
    if (path === "/healthz") { const s = status(); response.statusCode = s.collectorHealthy ? 200 : 503;
      result = { healthy: s.collectorHealthy, lastCycleAtMs: store.state.lastCycleAtMs, sequence: store.sequence, fatalError }; }
    else if (path === "/api/status") result = status();
    else if (path === "/api/manifest") result = bootstrap.manifest;
    else if (path === "/api/receipts") result = Object.fromEntries(Object.entries(store.state.portfolios)
      .map(([id, portfolio]) => [id, { symbol: portfolio.symbol, account: portfolio.account }]));
    else { response.writeHead(404); response.end(); return; }
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
  });
  try {
    await new Promise<void>((yes, no) => { server.once("error", no); server.listen(port, "0.0.0.0", yes); });
    market.start();
    const stop = () => { stopping = true; wake?.(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    console.log(JSON.stringify({ event: "eth40_started", port, root, startedAtMs: store.state.startedAtMs,
      firstExecutionDayMs: store.state.firstExecutionDayMs, restoredSequence: store.sequence }));
    while (!stopping) {
      const snapshot = await market.snapshot();
      // No result is published until its complete decision, quotes and receipt state are durable.
      const result = runPaperCycle(store.state, snapshot, `cycle-${store.sequence + 1}`);
      await store.appendCycle({ market: snapshot, result });
      lastMarket = snapshot; lastCycle = result;
      if (result.decisions.some(d => d.fill)) console.log(JSON.stringify({ event: "eth40_paper_fill", sequence: store.sequence, decisions: result.decisions }));
      const now = Date.now(), offset = now % DAY_MS;
      const waitMs = offset < ETH40_SPEC.executionWindowMs ? 1_000 : Math.min(30_000, DAY_MS - offset);
      if (!stopping) await new Promise<void>(done => {
        const timer = setTimeout(() => { wake = undefined; done(); }, waitMs);
        wake = () => { clearTimeout(timer); wake = undefined; done(); };
      });
    }
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
  } catch (error) {
    fatalError = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "eth40_stopped_on_error", error: fatalError }));
    throw error;
  } finally {
    market.stop();
    await new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections(); });
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
