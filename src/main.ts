import { loadConfig, type EngineConfig } from "./config.js";
import { validateReplay } from "./backtest/replay.js";
import { TradingEngine } from "./engine/trading-engine.js";
import { loadLocalEnv } from "./env.js";
import { configurationAudit } from "./config/audit.js";
import { OperationsMonitor } from "./dashboard/operations-monitor.js";
import { DashboardServer } from "./dashboard/server.js";
import type { DatabaseHealth, TelemetryRecord } from "./dashboard/types.js";
import { PostgresTelemetryStore } from "./database/postgres-store.js";
import { PersistenceWatch } from "./database/persistence-watch.js";
import type { VenueClient } from "./venue/client.js";
import { loadVenueSlowTrendHistory } from "./venue/market-history.js";
import { KrakenFuturesMarketStream } from "./kraken/market-stream.js";
import { KrakenPaperBroker, loadKrakenFuturesInstruments } from "./kraken/paper-broker.js";
import { projectKrakenPaperHistory } from "./kraken/paper-history.js";
import type { SlowTrendObservation, SlowTrendRestoreResult } from "./strategy/deterministic-features.js";
import { PolicyStore } from "./research/policy-store.js";
import { recoverPolicyPositions } from "./research/policy-restore.js";
import type { Position } from "./strategy/position-manager.js";
import { readCrossAssetHistory } from "./research/cross-asset-history.js";
import { DistributionCheckpoint } from "./distribution/checkpoint.js";
import { DistributionHistoryCheckpoint } from "./distribution/history-checkpoint.js";
import { readDistributionTrainingArtifact } from "./distribution/training-import.js";

async function main(): Promise<void> {
  loadLocalEnv();
  const modeOverride = process.argv[2];
  const paperDemoSymbol = argumentValue(process.argv, "--paper-demo-entry");
  const cfg = loadConfig(process.env, modeOverride);
  const effectiveConfiguration = configurationAudit(cfg);
  process.stdout.write(`${JSON.stringify({ type: "configuration-ready", ...effectiveConfiguration })}\n`);
  if (paperDemoSymbol !== null && cfg.mode !== "paper") throw new Error("--paper-demo-entry is restricted to paper mode");
  if (cfg.mode === "replay") {
    const stats = await validateReplay(cfg.replayFile);
    process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
    return;
  }
  const instruments = await loadKrakenFuturesInstruments(cfg.krakenFutures.productsBySymbol);
  const marketStream = new KrakenFuturesMarketStream({
    websocketUrl: cfg.krakenFutures.websocketUrl,
    productsBySymbol: cfg.krakenFutures.productsBySymbol,
  });
  const paperBroker = new KrakenPaperBroker({
    initialEquity: cfg.krakenFutures.initialEquity,
    productsBySymbol: cfg.krakenFutures.productsBySymbol,
    instruments,
    makerFeeBpsBySymbol: Object.fromEntries(cfg.symbols.map((symbol) => [symbol, cfg.symbolConfigs[symbol]!.cost.makerFeeBps])),
    takerFeeBpsBySymbol: Object.fromEntries(cfg.symbols.map((symbol) => [symbol, cfg.symbolConfigs[symbol]!.cost.takerFeeBps])),
    stateFile: cfg.krakenFutures.paperStateFile,
    fundingEnabled: true,
  });
  marketStream.on("book", (delta) => {
    try { paperBroker.onBook(delta); } catch (error) { paperBroker.reportExecutionFailure(error); }
  });
  marketStream.on("trade", (trade) => {
    try { paperBroker.onTrade(trade); } catch (error) { paperBroker.reportExecutionFailure(error); }
  });
  const rest: VenueClient = paperBroker;
  const distributionalAssets = Object.fromEntries([...instruments].filter(([symbol]) => cfg.symbols.includes(symbol))
    .map(([symbol, rules]) => [symbol, { symbol, minOrderSize: rules.quantityIncrement,
      minTradeIncrement: rules.quantityIncrement, priceIncrement: rules.tickSize,
      maximumOrderQty: rules.maximumOrderQty, shortable: true }]));
  const engine = new TradingEngine(cfg, { rest, gateway: paperBroker, marketStream,
    tradeStream: paperBroker.tradeStream, distributionalAssets, paperHistory: () => paperBroker.history(),
    paperFunding: asOfMs => paperBroker.fundingHistory(asOfMs) });
  const monitor = new OperationsMonitor({ marketSampleMs: cfg.databaseMarketSampleMs });
  const persistenceWatch = new PersistenceWatch(cfg.databaseMaximumWriteLagMs);
  let databaseStartupFailed = false;
  const observePersistence = (health: DatabaseHealth): void => {
    const observed = persistenceWatch.observe(databaseStartupFailed ? { ...health, connected: false,
      status: "degraded", lastError: "DATABASE_STARTUP_AUDIT_UNAVAILABLE" } : health, Date.now());
    monitor.setDatabaseHealth(observed);
    engine.setPersistenceHealth(observed);
  };
  engine.setPersistenceHealth({ connected: false, status: "connecting", droppedRecords: 0 });
  let store: PostgresTelemetryStore | undefined;
  let persistedPositions: readonly Position[] = [];
  let slowTrendBootstrapComplete = false;
  if (cfg.databaseEnabled) {
    store = new PostgresTelemetryStore({ connectionString: cfg.databaseUrl, flushIntervalMs: cfg.databaseFlushIntervalMs,
      maximumQueue: cfg.databaseMaxQueue, statementTimeoutMs: cfg.databaseStatementTimeoutMs });
    const candidate = store;
    candidate.on("health", observePersistence);
    monitor.setDatabaseHealth(candidate.health());
    try {
      const migrations = await candidate.start({ mode: cfg.mode, paper: cfg.paper, strategyVersion: cfg.strategyVersion, modelVersion: cfg.modelVersion,
        symbols: cfg.symbols, metadata: { venue: cfg.venue, configurationVersion: cfg.configurationVersion, signalMode: cfg.signalMode,
          paperEntryExercise: cfg.paperEntryExercise, ...effectiveConfiguration } });
      let paperHistoryBackfill = { ordersInserted: 0, fillsInserted: 0 };
      try {
        const history = projectKrakenPaperHistory(paperBroker.history());
        paperHistoryBackfill = await candidate.backfillHistoricalOrders(history.orders, history.fills);
      } catch (error) {
        if (cfg.databaseRequired) throw error;
        process.stderr.write(`${JSON.stringify({ type: "paper-history-backfill-degraded",
          message: error instanceof Error ? error.message : String(error) })}\n`);
      }
      const hydrationAtMs = Date.now();
      const hydrationDayStartMs = utcDayStartMs(hydrationAtMs);
      const restoredOrders = await candidate.loadOrders(hydrationDayStartMs, hydrationDayStartMs + 86_400_000);
      monitor.hydrateOrders(restoredOrders);
      persistedPositions = await candidate.loadLatestPositionStates(cfg.symbols);
      const restoredPositionStates = persistedPositions.length;
      const restoredRealizedSessionPnl = await candidate.loadRealizedSessionPnl(utcDayStartMs(hydrationAtMs));
      engine.restoreRealizedSessionPnl(restoredRealizedSessionPnl);
      const restoredDecisionVenueLatencies = engine.restoreDecisionVenueLatencies(
        await candidate.loadDecisionVenueLatencies(hydrationAtMs - 3_600_000, hydrationAtMs));
      const slowTrendHistory = await restoreStartupSlowTrendHistory(engine, rest, cfg, candidate, hydrationAtMs);
      slowTrendBootstrapComplete = true;
      process.stdout.write(`${JSON.stringify({ type: "database-ready", migrations, restoredOrders: restoredOrders.length,
        restoredPositionStates, restoredRealizedSessionPnl, restoredDecisionVenueLatencies,
        policyEngineEnabled: cfg.policyEngineEnabled,
        paperHistoryBackfill,
        slowTrendHistory })}\n`);
    } catch (error) {
      databaseStartupFailed = true;
      // Failed cleanup must not delay reconciliation of existing positions.
      // Late health events cannot clear the startup failure latch.
      void candidate.close().catch(() => undefined);
      store = undefined;
      monitor.setDatabaseHealth({ connected: false, status: "degraded", queuedRecords: 0, droppedRecords: 0, lastPersistedAtMs: null,
        lastError: error instanceof Error ? error.message : String(error) });
      // Keep paper position reconciliation and exit retries running. Without
      // the audit store, new entries remain blocked until a healthy restart.
      engine.setPersistenceHealth({ connected: false, status: "degraded", droppedRecords: 0 });
      process.stderr.write(`${JSON.stringify({ type: "database-degraded", message: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
  if (!slowTrendBootstrapComplete) {
    const slowTrendHistory = await restoreStartupSlowTrendHistory(engine, rest, cfg);
    process.stdout.write(`${JSON.stringify({ type: "slow-trend-history-ready", slowTrendHistory })}\n`);
  }
  engine.restorePositionStates(recoverPolicyPositions(paperBroker.history(), (await paperBroker.listPositions()).data, persistedPositions));
  const activeStore = store;
  if (activeStore) monitor.on("telemetry", (record: TelemetryRecord) => activeStore.enqueue(record));
  monitor.attach(engine);
  const policyStore = activeStore && cfg.policyEngineEnabled ? new PolicyStore(cfg.databaseUrl) : undefined;
  let policyRefresh: Promise<void> | undefined;
  const refreshPolicies = (): Promise<void> => {
    if (policyRefresh) return policyRefresh;
    policyRefresh = (async () => {
      if (!policyStore) return;
      try {
        const report = await policyStore.evaluate(cfg.configurationVersion);
        const installed = engine.replacePolicyModels(report.models);
        process.stdout.write(`${JSON.stringify({ type: "policy-research-ready", observations: report.observations,
          cohorts: report.evaluations.length, installed, evidenceEndMs: report.evidenceEndMs })}\n`);
      } catch (error) {
        engine.replacePolicyModels([]);
        process.stderr.write(`${JSON.stringify({ type: "policy-research-degraded",
          message: error instanceof Error ? error.message : String(error) })}\n`);
      }
    })().finally(() => { policyRefresh = undefined; });
    return policyRefresh;
  };
  await refreshPolicies();
  let distributionSaveError: unknown = null;
  const distributionCheckpoint = cfg.distributionalEngineEnabled ? new DistributionCheckpoint(cfg.distributionalStateFile, engine,
    error => { distributionSaveError = error;
      process.stderr.write(`${JSON.stringify({ type: "distributional-state-error", message: String(error) })}\n`); }) : null;
  if (distributionCheckpoint) {
    try {
      const restored = await distributionCheckpoint.restore();
      process.stdout.write(`${JSON.stringify({ type: "distributional-state-ready", restored })}\n`);
    } catch (error) {
      // An incompatible per-action bank must not be replaced by an empty
      // legacy bank on rollback or by a failed efficient-mode migration.
      if (cfg.distributionalEfficientTrainingEnabled || cfg.distributionalSizingPolicy
        || String(error).includes("TRAINING_POLICY")) throw error;
      process.stderr.write(`${JSON.stringify({ type: "distributional-state-invalid", message: String(error), fallback: "LIVE_WARMUP" })}\n`);
    }
    if (cfg.distributionalTrainingFile) {
      const previous = engine.exportDistributionalState();
      try {
        const prepared = await readDistributionTrainingArtifact(cfg.distributionalTrainingFile, [cfg.distributionalStateFile,
          `${cfg.distributionalStateFile}.pending`, `${cfg.distributionalStateFile}.tmp`, `${cfg.distributionalStateFile}.pending.tmp`,
          cfg.distributionalHistoryFile, `${cfg.distributionalHistoryFile}.tmp`, cfg.krakenFutures.paperStateFile,
          `${cfg.krakenFutures.paperStateFile}.tmp`, cfg.recordFile, cfg.continuousRecordFile]);
        // The importer authenticates the artifact's sizing policy, costs,
        // instrument rules and replay provenance before replacing the bank.
        // A legacy $12 artifact cannot qualify the risk-bounded policy.
        const imported = engine.importDistributionalTraining(prepared.artifact, distributionalAssets);
        if (imported.addedSamples) {
          distributionSaveError = null;
          distributionCheckpoint.save(); await distributionCheckpoint.flush();
          if (distributionSaveError !== null) throw distributionSaveError;
        }
        process.stdout.write(`${JSON.stringify({ type: "distributional-training-ready", file: prepared.file, ...imported })}\n`);
      } catch (error) {
        if (previous) engine.restoreDistributionalState(previous);
        process.stderr.write(`${JSON.stringify({ type: "distributional-training-invalid", message: String(error),
          fallback: "EXISTING_LIVE_TRAINING_PRESERVED" })}\n`);
      }
    }
    if (cfg.distributionalEfficientTrainingEnabled) {
      // Persist the migrated policy and independent clocks before accepting
      // market events, even when historical import added no new labels.
      distributionSaveError = null;
      distributionCheckpoint.save(); await distributionCheckpoint.flush();
      if (distributionSaveError !== null) throw distributionSaveError;
    }
    engine.on("distributionalCheckpoint", () => distributionCheckpoint.save());
    engine.on("distributionalDecision", decision => {
      // Flat/occupied evaluations run on fresh quotes every second. They do
      // not mutate learned evidence and must not enqueue full model writes.
      if (!decision.actionId) return;
      try { distributionCheckpoint.markPending(decision); }
      catch (error) {
        engine.invalidateDistributionalValidation();
        process.stderr.write(`${JSON.stringify({ type: "distributional-journal-error", message: String(error) })}\n`);
      }
      distributionCheckpoint.save();
    });
  }
  if (activeStore && cfg.policyEngineEnabled && !cfg.paperEntryExercise) {
    try {
      const cutoffMs = Date.now();
      const bootstrap = await engine.restoreCrossAssetHistory(readCrossAssetHistory(cfg.databaseUrl, cutoffMs), cutoffMs);
      if (bootstrap) process.stdout.write(`${JSON.stringify({ type: "cross-asset-history-ready", ...bootstrap })}\n`);
    } catch (error) {
      // Historical research availability cannot disable position management.
      // The isolated candidate was not installed; retain normal live warmup.
      process.stderr.write(`${JSON.stringify({ type: "cross-asset-history-degraded",
        message: error instanceof Error ? error.message : String(error), fallback: "LIVE_WARMUP" })}\n`);
    }
  }
  let dashboard: DashboardServer | undefined;
  if (cfg.dashboardEnabled) {
    dashboard = new DashboardServer(monitor, { host: cfg.dashboardHost, port: cfg.dashboardPort });
    const url = await dashboard.start();
    process.stdout.write(`${JSON.stringify({ type: "dashboard-ready", url })}\n`);
  }
  engine.on("decision", (event) => process.stdout.write(`${JSON.stringify({ type: "decision", event }, bigintReplacer)}\n`));
  engine.on("positionDecision", (event) => process.stdout.write(`${JSON.stringify({ type: "position", event }, bigintReplacer)}\n`));
  engine.on("engineError", (error) => process.stderr.write(`${JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) })}\n`));
  const distributionHistory = cfg.distributionalEngineEnabled
    ? new DistributionHistoryCheckpoint(cfg.distributionalHistoryFile, engine,
      error => process.stderr.write(`${JSON.stringify({ type: "distributional-history-save-error", message: String(error) })}\n`)) : null;
  if (distributionHistory) {
    try {
      const restored = await distributionHistory.restore();
      process.stdout.write(`${JSON.stringify({ type: "distributional-market-history-ready", restored,
        next: restored?.restoredSamples ? "LIVE_MARKET_READINESS_CHECKS" : "LIVE_PRICE_WARMUP" })}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ type: "distributional-market-history-invalid", message: String(error),
        fallback: "LIVE_PRICE_WARMUP" })}\n`);
    }
  }
  try {
    await engine.start();
  } catch (error) {
    await engine.stop().catch(() => undefined);
    monitor.stop();
    if (dashboard) await dashboard.stop().catch(() => undefined);
    if (activeStore) await activeStore.close().catch(() => undefined);
    if (policyStore) await policyStore.close().catch(() => undefined);
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ type: "started", mode: cfg.mode, venue: cfg.venue, symbols: cfg.symbols, paper: cfg.paper,
    paperEntryExercise: cfg.paperEntryExercise, policyEngineEnabled: cfg.policyEngineEnabled })}\n`);
  let fundingRefresh: Promise<void> | undefined;
  const refreshFunding = (): Promise<void> => {
    if (fundingRefresh) return fundingRefresh;
    fundingRefresh = (async () => {
      try {
        const result = await paperBroker.refreshFunding();
        await engine.reconcileAccount();
        process.stdout.write(`${JSON.stringify({ type: "paper-funding-accounting", source: result.snapshot.model,
          coverageStartedAtMs: result.snapshot.startedAtMs, accountingKnown: result.snapshot.fundingAccountingKnown,
          lifetimeAccountingKnown: result.snapshot.lifetimeFundingAccountingKnown,
          postedFundingCashUsd: result.snapshot.postedFundingCashUsd,
          accruedFundingCashUsd: result.snapshot.fundingCashUsd,
          newPostings: result.postings.length })}\n`);
      } catch (error) {
        process.stderr.write(`${JSON.stringify({ type: "paper-funding-unavailable",
          message: error instanceof Error ? error.message : String(error) })}\n`);
      }
    })().finally(() => { fundingRefresh = undefined; });
    return fundingRefresh;
  };
  void refreshFunding();
  const fundingTimer = setInterval(() => { void refreshFunding(); }, 60_000);
  fundingTimer.unref();
  const policyTimer = policyStore ? setInterval(() => { void refreshPolicies(); }, 3_600_000) : undefined;
  policyTimer?.unref();
  const historyTimer = distributionHistory ? setInterval(() => distributionHistory.save(), 5_000) : undefined;
  historyTimer?.unref();
  const persistenceTimer = activeStore ? setInterval(() => observePersistence(activeStore.health()), 1_000) : undefined;
  persistenceTimer?.unref();
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
    clearInterval(fundingTimer);
    if (fundingRefresh) await fundingRefresh;
    if (policyTimer) clearInterval(policyTimer);
    if (policyRefresh) await policyRefresh;
    if (historyTimer) clearInterval(historyTimer);
    if (persistenceTimer) clearInterval(persistenceTimer);
    distributionHistory?.save();
    await engine.stop();
    await distributionHistory?.flush();
    distributionCheckpoint?.save();
    await distributionCheckpoint?.flush();
    monitor.stop();
    if (dashboard) await dashboard.stop();
    if (activeStore) await activeStore.close();
    if (policyStore) await policyStore.close();
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

async function restoreStartupSlowTrendHistory(engine: TradingEngine, rest: VenueClient, cfg: EngineConfig,
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
