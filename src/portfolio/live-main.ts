import { createHash, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalOrderBook, type BookDelta } from "../core/order-book.js";
import { KrakenFuturesMarketStream } from "../kraken/market-stream.js";
import { loadKrakenFuturesInstruments } from "../kraken/paper-broker.js";
import { mergeHourlyBars, parseHourlyCandles } from "../research/hourly-data.js";
import { buildPortfolioTargets } from "./signals.js";
import { PortfolioShadowController, type PortfolioShadowEvent } from "./shadow.js";
import { assertPortfolioStageAllowed, portfolioSourceHashes } from "./study-main.js";
import { PORTFOLIO_STUDY_PROTOCOL } from "./protocol.js";
import { PORTFOLIO_DAY_MS as DAY, PORTFOLIO_HOUR_MS as HOUR, PORTFOLIO_SYMBOLS as SYMBOLS,
  type AssetRules, type HourlyBar, type Pair, type PortfolioQuote } from "./types.js";

const PRODUCTS = { "BTC/USD": "PF_XBTUSD", "ETH/USD": "PF_ETHUSD" };
const digest = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const jsonDigest = (v: unknown) => digest(JSON.stringify(v));
const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));

/** Gate before any live warmup can consume reserved historical prices. */
export async function portfolioShadowPreflight(studyDirectory: string) {
  try {
    await assertPortfolioStageAllowed("confirm", studyDirectory);
    await assertPortfolioStageAllowed("test", studyDirectory);
    const result = await read(join(studyDirectory, "test-summary.json"));
    const integrity = await read(join(studyDirectory, "test-integrity.json"));
    if (integrity.summarySha256 !== digest(await readFile(join(studyDirectory, "test-summary.json"))))
      throw new Error("PORTFOLIO_FINAL_SUMMARY_CHANGED");
    if (result.passed !== true || result.confidencePassed !== true || result.hourlyScenarioEvidencePassed !== true)
      throw new Error("PORTFOLIO_FINAL_EVIDENCE_FAILED");
    if (!result.artifacts || Object.keys(result.artifacts).length !== 25) throw new Error("PORTFOLIO_FINAL_ARTIFACT_SET");
    const registration = await read(join(studyDirectory, "protocol.json"));
    if (jsonDigest(registration.protocol) !== jsonDigest(PORTFOLIO_STUDY_PROTOCOL)
      || result.protocolSha256 !== digest(await readFile(join(studyDirectory, "protocol.json")))
      || jsonDigest(registration.sourceHashes) !== jsonDigest(await portfolioSourceHashes()))
      throw new Error("PORTFOLIO_SHADOW_SOURCE_OR_PROTOCOL_CHANGED");
    for (const [name, sha] of Object.entries(result.artifacts ?? {})) {
      if (!/^[a-z0-9.-]+\.json$/.test(name) || digest(await readFile(join(studyDirectory, name))) !== sha)
        throw new Error("PORTFOLIO_FINAL_ARTIFACT_CHANGED");
    }
    return { allowed: true, reason: "HOURLY_SCENARIO_GATES_PASSED_SHADOW_RECONCILIATION_REQUIRED", realOrdersAllowed: false };
  } catch (error) {
    return { allowed: false, reason: error instanceof Error ? error.message : String(error), realOrdersAllowed: false };
  }
}

export async function fetchPortfolioClosedHistory(startMs: number, endMs: number, nowMs: number,
  fetcher: typeof fetch = fetch): Promise<HourlyBar[]> {
  if (![startMs, endMs, nowMs].every(v => Number.isSafeInteger(v) && v >= 0)
    || startMs % HOUR || endMs % HOUR || endMs <= startMs || endMs > nowMs - 60_000
    || endMs - startMs > 370 * DAY) throw new Error("PORTFOLIO_LIVE_HISTORY_WINDOW");
  const byAsset = await Promise.all(SYMBOLS.map(async symbol => {
    const own: HourlyBar[] = [];
    for (let start = startMs; start < endMs; start += 5000 * HOUR) {
      const end = Math.min(endMs, start + 5000 * HOUR);
      const url = `https://futures.kraken.com/api/charts/v1/trade/${PRODUCTS[symbol]}/1h?from=${start / 1000}&to=${end / 1000}`;
      const response = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`PORTFOLIO_LIVE_HISTORY_HTTP_${response.status}`);
      const body = await response.text();
      if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error("PORTFOLIO_LIVE_HISTORY_RESPONSE_LIMIT");
      own.push(...parseHourlyCandles(JSON.parse(body), symbol).bars.filter(b => b.openMs >= start && b.openMs < end));
    }
    return own;
  }));
  const bars = mergeHourlyBars(byAsset.flat(), startMs, endMs, nowMs);
  for (const symbol of SYMBOLS) if (bars.filter(b => b.symbol === symbol).length !== (endMs - startMs) / HOUR)
    throw new Error(`PORTFOLIO_LIVE_HISTORY_GAP:${symbol}`);
  return bars;
}

async function atomicCheckpoint(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

/** An existing lock is never stolen, including locks left by a crashed process.
 * Operator recovery must establish that the old owner is stopped first. */
export async function acquirePortfolioCheckpointOwnership(path: string) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const checkpointPath = join(await realpath(dirname(resolve(path))), basename(path));
  const lockPath = `${checkpointPath}.lock`, token = randomUUID();
  let handle;
  try { handle = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("PORTFOLIO_CHECKPOINT_ALREADY_OWNED");
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ version: "portfolio-checkpoint-owner-v1", pid: process.pid,
      token, checkpointPath, createdAtUtc: new Date().toISOString() }));
    await handle.sync();
  } catch (error) {
    await handle.close(); await unlink(lockPath); throw error;
  }
  await handle.close();
  let released: Promise<void> | null = null;
  const release = () => released ??= (async () => {
    const owner = await read(lockPath);
    if (owner.token !== token || owner.pid !== process.pid || owner.checkpointPath !== checkpointPath)
      throw new Error("PORTFOLIO_CHECKPOINT_OWNERSHIP_CHANGED");
    await unlink(lockPath);
  })();
  return { checkpointPath, lockPath, token, release };
}

type PortfolioPublicStream = Pick<EventEmitter, "on"> & { connect(): void; close(): void };
export interface PortfolioShadowRuntimeDependencies {
  preflight?: typeof portfolioShadowPreflight;
  loadInstruments?: typeof loadKrakenFuturesInstruments;
  readRules?: () => Promise<Pair<AssetRules>>;
  fetchHistory?: typeof fetchPortfolioClosedHistory;
  createStream?: () => PortfolioPublicStream;
  createHttpServer?: (listener: Parameters<typeof createServer>[1]) => Server;
  now?: () => number;
}

export async function runPortfolioShadow(studyDirectory: string, checkpointPath: string, port = 3002,
  dependencies: PortfolioShadowRuntimeDependencies = {}) {
  const permission = await (dependencies.preflight ?? portfolioShadowPreflight)(studyDirectory);
  if (!permission.allowed) throw new Error(permission.reason);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORTFOLIO_SHADOW_PORT");
  if (resolve(checkpointPath).startsWith(resolve(studyDirectory) + "/")) throw new Error("PORTFOLIO_SHADOW_CHECKPOINT_INSIDE_SEALED_STUDY");
  const ownership = await acquirePortfolioCheckpointOwnership(checkpointPath);
  checkpointPath = ownership.checkpointPath;
  const nowMs = dependencies.now ?? Date.now;
  let stream: PortfolioPublicStream | undefined;
  let server: Server | undefined, timer: ReturnType<typeof setInterval> | undefined;
  let closePromise: Promise<void> | null = null;
  let signalClose: (() => void) | undefined;
  let stopRuntime = () => {};
  try {
  const protectedPath = await realpath(studyDirectory);
  if (checkpointPath === protectedPath || checkpointPath.startsWith(protectedPath + "/"))
    throw new Error("PORTFOLIO_SHADOW_CHECKPOINT_INSIDE_SEALED_STUDY");
  const instruments = await (dependencies.loadInstruments ?? loadKrakenFuturesInstruments)(PRODUCTS);
  const rules = Object.fromEntries(SYMBOLS.map(symbol => {
    const r = instruments.get(symbol);
    if (!r) throw new Error(`PORTFOLIO_MISSING_INSTRUMENT:${symbol}`);
    return [symbol, { symbol, minOrderSize: r.quantityIncrement, minTradeIncrement: r.quantityIncrement,
      priceIncrement: r.tickSize, maximumOrderQty: r.maximumOrderQty, shortable: true }];
  })) as Pair<AssetRules>;
  if (jsonDigest(rules) !== jsonDigest(await (dependencies.readRules?.() ?? read("reports/distribution-instrument-rules-2026-09-07.json"))))
    throw new Error("PORTFOLIO_LIVE_INSTRUMENT_RULES_CHANGED");
  const controller = new PortfolioShadowController({ rules, feeBps: 5 });
  try { controller.restore(await read(checkpointPath), nowMs()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  stream = dependencies.createStream?.() ?? new KrakenFuturesMarketStream({ websocketUrl: "wss://futures.kraken.com/ws/v1", productsBySymbol: PRODUCTS });
  const activeStream = stream;
  const books = { "BTC/USD": new LocalOrderBook("BTC/USD"), "ETH/USD": new LocalOrderBook("ETH/USD") };
  let queue = Promise.resolve(), stopped = false, failure: string | null = null, lastTargetMs = 0;
  let historyError: string | null = null, refreshing = false, feedEpoch = 0;
  stopRuntime = () => { stopped = true; feedEpoch++; };
  let lastQuoteEvaluationMs = 0;
  const events: PortfolioShadowEvent[] = [];
  const retain = async (items: PortfolioShadowEvent[]) => {
    if (!items.length) return;
    events.push(...items); if (events.length > 100) events.splice(0, events.length - 100);
    await atomicCheckpoint(checkpointPath, controller.checkpoint());
    process.stdout.write(JSON.stringify({ type: "portfolio-shadow-events", events: items }) + "\n");
  };
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(async () => { if (!stopped) await task(); }).catch(error => {
      stopped = true; failure = error instanceof Error ? error.message : String(error); activeStream.close();
      process.stderr.write(JSON.stringify({ type: "portfolio-shadow-halted", reason: failure }) + "\n");
    });
  };
  const refreshWork = async () => {
    if (refreshing || stopped) return;
    const cutoff = Math.floor((nowMs() - 60_000) / DAY) * DAY;
    if (lastTargetMs >= cutoff) return;
    refreshing = true;
    try {
      // Network/history work never owns the serialized quote/execution queue.
      const history = await (dependencies.fetchHistory ?? fetchPortfolioClosedHistory)(cutoff - 362 * DAY, cutoff, nowMs());
      const target = buildPortfolioTargets(history, cutoff, cutoff + DAY).at(-1);
      if (!target) throw new Error("PORTFOLIO_LIVE_SIGNAL_NOT_READY");
      enqueue(async () => {
        const prior = controller.snapshot().target;
        if (prior?.decisionMs === target.decisionMs) {
          if (prior.inputSha256 !== target.inputSha256) {
            historyError = "PORTFOLIO_LIVE_HISTORY_CORRECTION";
            await retain(controller.invalidateTarget(historyError, nowMs())); return;
          }
        } else await retain(controller.setTarget({ ...target, availableAtMs: nowMs() }, nowMs()));
        lastTargetMs = target.decisionMs; historyError = null;
      });
    } catch (error) {
      historyError = error instanceof Error ? error.message : String(error);
      process.stderr.write(JSON.stringify({ type: "portfolio-history-retry", reason: historyError }) + "\n");
    } finally { refreshing = false; }
  };
  let activeRefresh: Promise<void> | null = null;
  const refresh = () => activeRefresh ??= (async () => {
    try { await refreshWork(); } finally { activeRefresh = null; }
  })();
  await atomicCheckpoint(checkpointPath, controller.checkpoint());
  activeStream.on("book", (delta: BookDelta) => { const epoch = feedEpoch; enqueue(async () => {
    if (epoch !== feedEpoch) return;
    if (!SYMBOLS.includes(delta.symbol as typeof SYMBOLS[number])) return;
    const update = books[delta.symbol as typeof SYMBOLS[number]].apply(delta);
    if (!update.accepted) {
      if (!update.duplicate) await retain(controller.invalidateQuotes(update.reason ?? "INVALID_BOOK"));
      return;
    }
    const now = nowMs();
    if (now - lastQuoteEvaluationMs < 250) return;
    lastQuoteEvaluationMs = now;
    const snapshots = SYMBOLS.map(s => books[s].snapshot());
    if (snapshots.some(b => !b.valid || !b.bids[0] || !b.asks[0])) return;
    const quotes = Object.fromEntries(snapshots.map(b => [b.symbol, { symbol: b.symbol, atMs: b.receiveTsMs,
      bid: b.bids[0]!.px, ask: b.asks[0]!.px, bidQty: b.bids[0]!.qty, askQty: b.asks[0]!.qty }])) as Pair<PortfolioQuote>;
    await retain(controller.onQuotes(quotes, now));
  }); });
  activeStream.on("disconnect", () => { feedEpoch++; enqueue(async () => {
    for (const s of SYMBOLS) books[s].invalidate();
    await retain(controller.invalidateQuotes("PUBLIC_STREAM_DISCONNECTED"));
  }); });
  activeStream.on("streamError", error => process.stderr.write(JSON.stringify({ type: "portfolio-public-stream-error", message: String(error) }) + "\n"));
  server = (dependencies.createHttpServer ?? createServer)((request, response) => {
    const snapshot = controller.snapshot(nowMs());
    const healthy = !stopped && snapshot.quoteReady && snapshot.dataReady;
    const status = { ...snapshot, healthy, halted: stopped, failure, historyError, refreshing,
      evidence: permission, recentEvents: events };
    if (request.url !== "/api/status" && request.url !== "/healthz") { response.writeHead(404); response.end(); return; }
    response.writeHead(request.url === "/healthz" && !healthy ? 503 : 200,
      { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(status));
  });
  const activeServer = server;
  await new Promise<void>((yes, no) => { activeServer.once("error", no); activeServer.listen(port, "127.0.0.1", yes); });
  timer = setInterval(() => { void refresh(); }, 60_000);
  activeStream.connect();
  void refresh();
  const close = () => closePromise ??= (async () => {
    stopped = true; clearInterval(timer); activeStream.close();
    if (signalClose) { process.removeListener("SIGTERM", signalClose); process.removeListener("SIGINT", signalClose); }
    try {
      await queue; await atomicCheckpoint(checkpointPath, controller.checkpoint());
    } finally {
      try { if (activeServer.listening) await new Promise<void>(r => activeServer.close(() => r())); }
      finally { await ownership.release(); }
    }
  })();
  signalClose = () => { void close().catch(error => {
    process.stderr.write(JSON.stringify({ type: "portfolio-shadow-close-error", message: String(error) }) + "\n");
    process.exitCode = 1;
  }); };
  process.once("SIGTERM", signalClose); process.once("SIGINT", signalClose);
  return { close, port, refresh, waitForIdle: () => queue };
  } catch (error) {
    stopRuntime(); clearInterval(timer); stream?.close();
    try { if (server?.listening) await new Promise<void>(r => server!.close(() => r())); }
    finally { await ownership.release(); }
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [mode, directory, checkpoint] = process.argv.slice(2);
  if (!directory || !["preflight", "shadow"].includes(mode ?? "")) throw new Error("Usage: portfolio/live-main preflight study-directory | shadow study-directory checkpoint-file");
  if (mode === "preflight") {
    const result = await portfolioShadowPreflight(directory); process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (!result.allowed) process.exitCode = 1;
  } else {
    if (!checkpoint) throw new Error("PORTFOLIO_SHADOW_CHECKPOINT_REQUIRED");
    await runPortfolioShadow(directory, checkpoint);
  }
}
