import { loadConfig, type EngineConfig } from "./config.js";
import { validateReplay } from "./backtest/replay.js";
import { TradingEngine } from "./engine/trading-engine.js";
import { loadLocalEnv } from "./env.js";
import { OperationsMonitor } from "./dashboard/operations-monitor.js";
import { DashboardServer } from "./dashboard/server.js";
import type { DatabaseHealth, TelemetryRecord } from "./dashboard/types.js";
import { PostgresTelemetryStore } from "./database/postgres-store.js";
import { AlpacaRestClient } from "./alpaca/rest.js";
import { loadVenueSlowTrendHistory } from "./alpaca/market-history.js";
import { KrakenFuturesMarketStream } from "./kraken/market-stream.js";
import { KrakenPaperBroker, loadKrakenFuturesInstruments } from "./kraken/paper-broker.js";
import type { SlowTrendObservation, SlowTrendRestoreResult } from "./strategy/deterministic-features.js";

async function main(): Promise<void> {
  loadLocalEnv();
  const modeOverride = process.argv[2];
  const paperDemoSymbol = argumentValue(process.argv, "--paper-demo-entry");
  const cfg = loadConfig(process.env, modeOverride);
  if (paperDemoSymbol !== null && cfg.mode !== "paper") throw new Error("--paper-demo-entry is restricted to paper mode");
  if (cfg.mode === "replay") {
    const stats = await validateReplay(cfg.replayFile);
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return;
  }
  let rest: AlpacaRestClient;
  let engine: TradingEngine;
  if (cfg.venue === "kraken_futures") {
    const instruments = await loadKrakenFuturesInstruments(cfg.krakenFutures.productsBySymbol);
    const marketStream = new KrakenFuturesMarketStream({
      websocketUrl: cfg.krakenFutures.websocketUrl,
      productsBySymbol: cfg.krakenFutures.productsBySymbol,
    });
    const broker = new KrakenPaperBroker({
      initialEquity: cfg.krakenFutures.initialEquity,
      productsBySymbol: cfg.krakenFutures.productsBySymbol,
      instruments,
      makerFeeBpsBySymbol: Object.fromEntries(cfg.symbols.map((symbol) => [symbol, cfg.symbolConfigs[symbol]!.cost.makerFeeBps])),
      takerFeeBpsBySymbol: Object.fromEntries(cfg.symbols.map((symbol) => [symbol, cfg.symbolConfigs[symbol]!.cost.takerFeeBps])),
      stateFile: cfg.krakenFutures.paperStateFile,
    });
    marketStream.on("book", (delta) => broker.onBook(delta));
    marketStream.on("trade", (trade) => broker.onTrade(trade));
    rest = broker;
    engine = new TradingEngine(cfg, { rest, gateway: broker, marketStream, tradeStream: broker.tradeStream });
  } else {
    rest = new AlpacaRestClient({ credentials: cfg.credentials, paper: cfg.paper, cryptoLocation: cfg.cryptoLocation });
    engine = new TradingEngine(cfg, { rest });
  }
  const monitor = new OperationsMonitor({ marketSampleMs: cfg.databaseMarketSampleMs });
  let store: PostgresTelemetryStore | undefined;
  let slowTrendBootstrapComplete = false;
  if (cfg.databaseEnabled) {
    store = new PostgresTelemetryStore({ connectionString: cfg.databaseUrl, flushIntervalMs: cfg.databaseFlushIntervalMs, maximumQueue: cfg.databaseMaxQueue });
    const candidate = store;
    candidate.on("health", (health: DatabaseHealth) => monitor.setDatabaseHealth(health));
    monitor.setDatabaseHealth(candidate.health());
    try {
      const migrations = await candidate.start({ mode: cfg.mode, paper: cfg.paper, strategyVersion: cfg.strategyVersion, modelVersion: cfg.modelVersion,
        symbols: cfg.symbols, metadata: { venue: cfg.venue, configurationVersion: cfg.configurationVersion, signalMode: cfg.signalMode,
          paperEntryExercise: cfg.paperEntryExercise } });
      const restoredOrders = await candidate.loadOrders();
      monitor.hydrateOrders(restoredOrders);
      const restoredPositionStates = engine.restorePositionStates(await candidate.loadLatestPositionStates(cfg.symbols));
      const hydrationAtMs = Date.now();
      const restoredRealizedSessionPnl = await candidate.loadRealizedSessionPnl(utcDayStartMs(hydrationAtMs));
      engine.restoreRealizedSessionPnl(restoredRealizedSessionPnl);
      const restoredDecisionVenueLatencies = engine.restoreDecisionVenueLatencies(
        await candidate.loadDecisionVenueLatencies(hydrationAtMs - 3_600_000, hydrationAtMs));
      const slowTrendHistory = await restoreStartupSlowTrendHistory(engine, rest, cfg, candidate, hydrationAtMs);
      slowTrendBootstrapComplete = true;
      process.stdout.write(`${JSON.stringify({ type: "database-ready", migrations, restoredOrders: restoredOrders.length,
        restoredPositionStates, restoredRealizedSessionPnl, restoredDecisionVenueLatencies, slowTrendHistory })}\n`);
    } catch (error) {
      await candidate.close().catch(() => undefined);
      store = undefined;
      monitor.setDatabaseHealth({ connected: false, status: "degraded", queuedRecords: 0, droppedRecords: 0, lastPersistedAtMs: null,
        lastError: error instanceof Error ? error.message : String(error) });
      if (cfg.databaseRequired) throw error;
      process.stderr.write(`${JSON.stringify({ type: "database-degraded", message: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
  if (!slowTrendBootstrapComplete) {
    const slowTrendHistory = await restoreStartupSlowTrendHistory(engine, rest, cfg);
    process.stdout.write(`${JSON.stringify({ type: "slow-trend-history-ready", slowTrendHistory })}\n`);
  }
  const activeStore = store;
  if (activeStore) monitor.on("telemetry", (record: TelemetryRecord) => activeStore.enqueue(record));
  monitor.attach(engine);
  let dashboard: DashboardServer | undefined;
  if (cfg.dashboardEnabled) {
    dashboard = new DashboardServer(monitor, { host: cfg.dashboardHost, port: cfg.dashboardPort });
    const url = await dashboard.start();
    process.stdout.write(`${JSON.stringify({ type: "dashboard-ready", url })}\n`);
  }
  engine.on("decision", (event) => process.stdout.write(`${JSON.stringify({ type: "decision", event }, bigintReplacer)}\n`));
  engine.on("positionDecision", (event) => process.stdout.write(`${JSON.stringify({ type: "position", event }, bigintReplacer)}\n`));
  engine.on("optionShortDecision", (event) => process.stdout.write(`${JSON.stringify({ type: "option-short-decision", event }, bigintReplacer)}\n`));
  engine.on("optionShortBlocked", (event) => process.stdout.write(`${JSON.stringify({ type: "option-short-blocked", event }, bigintReplacer)}\n`));
  engine.on("optionShortOrderAccepted", (event) => process.stdout.write(`${JSON.stringify({ type: "option-short-order", event }, bigintReplacer)}\n`));
  engine.on("engineError", (error) => process.stderr.write(`${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })}\n`));
  try {
    await engine.start();
  } catch (error) {
    await engine.stop().catch(() => undefined);
    monitor.stop();
    if (dashboard) await dashboard.stop().catch(() => undefined);
    if (activeStore) await activeStore.close().catch(() => undefined);
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ type: "started", mode: cfg.mode, venue: cfg.venue, symbols: cfg.symbols, paper: cfg.paper,
    paperEntryExercise: cfg.paperEntryExercise })}\n`);
  if (paperDemoSymbol !== null) {
    void submitPaperDemoWhenReady(engine, paperDemoSymbol || "BTC/USD").then((plan) => {
      process.stdout.write(`${JSON.stringify({ type: "paper-demo-entry-submitted", symbol: plan.symbol, clientOrderId: plan.clientOrderId,
        qty: plan.qty, limitPx: plan.limitPx })}\n`);
    }).catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify({ type: "paper-demo-entry-failed", message: error instanceof Error ? error.message : String(error) })}\n`);
    });
  }
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await engine.stop();
    monitor.stop();
    if (dashboard) await dashboard.stop();
    if (activeStore) await activeStore.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

const bigintReplacer = (_key: string, value: unknown): unknown => typeof value === "bigint" ? value.toString() : value;
const utcDayStartMs = (atMs: number): number => {
  const value = new Date(atMs);
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
};

async function restoreStartupSlowTrendHistory(engine: TradingEngine, rest: AlpacaRestClient, cfg: EngineConfig,
  store?: PostgresTelemetryStore, asOfMs = Date.now()): Promise<Readonly<Record<string, SlowTrendRestoreResult>>> {
  const maximumLookbackMs = Math.max(...cfg.symbols.map((symbol) => {
    const extension = cfg.symbolConfigs[symbol]!.deterministicExtension;
    return Math.max(extension.trendSlowWindowMs, extension.pullbackWindowMs) + extension.trendSampleIntervalMs;
  }));
  const bySymbol = new Map<string, SlowTrendObservation[]>();
  if (store) {
    try {
      const observations = await store.loadRecentMarketMids(cfg.symbols, asOfMs - maximumLookbackMs, asOfMs);
      for (const observation of observations) appendHistory(bySymbol, observation.symbol, observation);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ type: "slow-trend-database-history-degraded",
        message: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
  let restored = engine.restoreSlowTrendHistory(bySymbol, asOfMs);
  const missing = cfg.symbols.filter((symbol) => restored[symbol]?.ready !== true);
  if (missing.length > 0) {
    try {
      const venue = await loadVenueSlowTrendHistory(rest, missing, asOfMs - maximumLookbackMs, asOfMs);
      for (const [symbol, observations] of venue) {
        for (const observation of observations) appendHistory(bySymbol, symbol, observation);
      }
      restored = engine.restoreSlowTrendHistory(bySymbol, Date.now());
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ type: "slow-trend-venue-history-degraded", symbols: missing,
        message: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
  return restored;
}

function appendHistory(history: Map<string, SlowTrendObservation[]>, symbol: string,
  observation: SlowTrendObservation): void {
  const values = history.get(symbol) ?? [];
  values.push({ atMs: observation.atMs, mid: observation.mid });
  history.set(symbol, values);
}

function argumentValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index < 0 ? null : (args[index + 1] ?? "");
}

async function submitPaperDemoWhenReady(engine: TradingEngine, symbol: string, timeoutMs = 120_000): Promise<Awaited<ReturnType<TradingEngine["submitPaperDemoEntry"]>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = engine.state();
    const market = state.markets.find((candidate) => candidate.symbol === symbol);
    if (state.started && state.risk.reasons.length === 0 && Object.values(state.risk.health).every(Boolean)
      && market?.bookValid && market.features?.warmedUp && !market.features.stale) {
      return engine.submitPaperDemoEntry(symbol);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for a healthy, warmed market for ${symbol}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ type: "fatal", message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
