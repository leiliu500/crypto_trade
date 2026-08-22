import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { EngineConfig, SymbolConfig } from "../config.js";
import { FeatureEngine } from "../core/features.js";
import { LatencyTracker } from "../core/latency.js";
import type { BookState, Features, MarketTrade } from "../core/market.js";
import { LocalOrderBook, type BookDelta } from "../core/order-book.js";
import { EventRecorder } from "../recorder.js";
import { bufferedTakerLimitPrice, ExecutionPlanner, type AssetRules, type ExecutionPlan } from "../execution/planner.js";
import {
  OrderStateReconciler, type FillDelta, type OrderCancelRequestReason, type PrivateOrderEvent, type TrackedOrder,
} from "../execution/order-state.js";
import { estimateSweep } from "../execution/book-walk.js";
import { PortfolioRiskEngine } from "../risk/portfolio.js";
import { RiskState } from "../risk/risk-state.js";
import { RiskSizer, type RiskApproval } from "../risk/sizing.js";
import { CostModel, incrementalHoldCostBps } from "../strategy/cost.js";
import { ForecastEngine } from "../strategy/forecast.js";
import { PositionManager, type Position } from "../strategy/position-manager.js";
import type { TradeIntent } from "../strategy/signal.js";
import { BookPressureTracker, DeterministicFeatureExtensions, type DeterministicFeatures, type SlowTrendObservation, type SlowTrendRestoreResult } from "../strategy/deterministic-features.js";
import { DeterministicRegimeEngine, type RegimeDecision } from "../strategy/deterministic-regime.js";
import { DeterministicEntryEngine, type DeterministicEvaluation, type DeterministicTradeIntent, type SystemGateState } from "../strategy/deterministic-entry.js";
import { DeterministicHoldEngine } from "../strategy/deterministic-hold.js";
import { DynamicLiquidityPolicy, type LiquidityDecision } from "../strategy/dynamic-liquidity.js";
import { SignalRouter, type OptionalSignalModel } from "../strategy/signal-router.js";
import { AlpacaOrderGateway, type OrderGateway } from "../alpaca/gateway.js";
import { AlpacaMarketStream } from "../alpaca/market-stream.js";
import { AlpacaApiError, AlpacaRestClient } from "../alpaca/rest.js";
import { AlpacaTradeStream } from "../alpaca/trade-stream.js";
import type { AlpacaAsset, AlpacaOrder, AlpacaPosition } from "../alpaca/types.js";
import { EntryPipelineAudit, type EntryPipelineSnapshot, type EntryPipelineStage } from "./entry-pipeline-audit.js";
import { HealthWatchdog, type WatchdogFault } from "./watchdog.js";

const PAPER_DEMO_TARGET_NOTIONAL = 11;
const CANCEL_PENDING_RECONCILE_DELAY_MS = 2_000;

export interface EngineMarketSnapshot {
  symbol: string;
  bookValid: boolean;
  bestBid: number | null;
  bestAsk: number | null;
  sequence: string;
  exchangeTsMs: number;
  receiveTsMs: number;
  features: DeterministicFeatures | null;
  regime?: RegimeDecision | null;
  ruleEvaluation?: DeterministicEvaluation | null;
  entryReady?: boolean;
  liquidity?: { long: LiquidityDecision; short: LiquidityDecision } | null;
  entryPipeline?: EntryPipelineSnapshot;
}

export interface EngineOperationalSnapshot {
  generatedAtMs: number;
  started: boolean;
  startedAtMs: number | null;
  uptimeMs: number;
  mode: EngineConfig["mode"];
  paper: boolean;
  paperEntryExercise: boolean;
  strategyVersion: string;
  modelVersion: string;
  configurationVersion?: string;
  signalMode?: EngineConfig["signalMode"];
  symbols: readonly string[];
  equity: number;
  equityHighWater: number;
  realizedSessionPnl: number;
  risk: ReturnType<RiskState["snapshot"]>;
  orders: ReturnType<OrderStateReconciler["all"]>;
  positions: readonly Position[];
  markets: readonly EngineMarketSnapshot[];
  latency: ReturnType<LatencyTracker["summary"]>;
}

interface SymbolRuntime {
  config: SymbolConfig;
  book: LocalOrderBook;
  features: FeatureEngine;
  pressure: BookPressureTracker;
  deterministicFeatures: DeterministicFeatureExtensions;
  regimeEngine: DeterministicRegimeEngine;
  entryEngine: DeterministicEntryEngine;
  liquidity: DynamicLiquidityPolicy;
  entryAudit: EntryPipelineAudit;
  signalRouter: SignalRouter;
  holdEngine: DeterministicHoldEngine;
  cost: CostModel;
  planner: ExecutionPlanner;
  positionManager: PositionManager;
  asset?: AssetRules;
  latestFeatures?: DeterministicFeatures;
  latestRegime?: RegimeDecision;
  latestRuleEvaluation?: DeterministicEvaluation;
  /** Exact accepted intent retained only while its maker entry is pending. */
  pendingEntryIntent?: DeterministicTradeIntent;
  latestLiquidity?: { long: LiquidityDecision; short: LiquidityDecision };
  position?: Position;
  cluster: string;
}

export interface EngineDependencies {
  rest?: AlpacaRestClient;
  gateway?: OrderGateway;
  marketStream?: AlpacaMarketStream;
  tradeStream?: AlpacaTradeStream;
  now?: () => number;
}

export class TradingEngine extends EventEmitter {
  private readonly runtimes = new Map<string, SymbolRuntime>();
  private readonly rest: AlpacaRestClient;
  private readonly gateway: OrderGateway;
  private readonly marketStream: AlpacaMarketStream;
  private readonly tradeStream: AlpacaTradeStream;
  private readonly orderState = new OrderStateReconciler();
  private readonly latency = new LatencyTracker();
  private readonly riskState: RiskState;
  private readonly portfolio: PortfolioRiskEngine;
  private readonly now: () => number;
  private readonly watchdog: HealthWatchdog;
  private readonly recorder?: EventRecorder;
  private readonly reportedPositionDust = new Map<string, number>();
  private readonly cancelReconcileInFlight = new Set<string>();
  private readonly cancelReconcileLastAttemptMs = new Map<string, number>();
  private readonly makerExitFallbackInFlight = new Set<string>();
  private equity = 0;
  private equityHighWater = 0;
  private realizedSessionPnl = 0;
  private started = false;
  private startedAtMs: number | null = null;

  public constructor(private readonly cfg: EngineConfig, dependencies: EngineDependencies = {}) {
    super();
    this.now = dependencies.now ?? Date.now;
    this.rest = dependencies.rest ?? new AlpacaRestClient({ credentials: cfg.credentials, paper: cfg.paper, cryptoLocation: cfg.cryptoLocation });
    this.gateway = dependencies.gateway ?? new AlpacaOrderGateway(this.rest);
    this.marketStream = dependencies.marketStream ?? new AlpacaMarketStream({ credentials: cfg.credentials, symbols: cfg.symbols, location: cfg.cryptoLocation });
    this.tradeStream = dependencies.tradeStream ?? new AlpacaTradeStream({ credentials: cfg.credentials, paper: cfg.paper });
    this.riskState = new RiskState(cfg.rollingLossFraction, cfg.sessionLossFraction, cfg.sizing.maximumDrawdown);
    this.portfolio = new PortfolioRiskEngine(cfg.portfolio);
    this.watchdog = new HealthWatchdog(
      { checkIntervalMs: 1_000, publicSilenceMs: 30_000, privateSilenceMs: 45_000, maximumEventLoopDriftMs: 2_000 },
      (fault) => this.onWatchdogFault(fault), this.now,
    );
    if (cfg.mode === "record") this.recorder = new EventRecorder(cfg.recordFile);
    else if (cfg.continuousRecordingEnabled && ["shadow", "paper", "live"].includes(cfg.mode)) this.recorder = new EventRecorder(cfg.continuousRecordFile);
    for (const symbol of cfg.symbols) {
      const symbolCfg = cfg.symbolConfigs[symbol];
      if (!symbolCfg) throw new Error(`Missing resolved symbol configuration for ${symbol}`);
      const optionalForecast = symbolCfg.signalMode === "DETERMINISTIC_ONLY" ? undefined
        : new ForecastEngine(symbolCfg.probabilityHead, symbolCfg.returnHead, symbolCfg.forecast);
      const cost = new CostModel(symbolCfg.cost);
      this.runtimes.set(symbol, {
        config: symbolCfg,
        book: new LocalOrderBook(symbol), features: new FeatureEngine(symbolCfg.feature), pressure: new BookPressureTracker(symbolCfg.feature.depthLevels),
        deterministicFeatures: new DeterministicFeatureExtensions(symbolCfg.deterministicExtension),
        regimeEngine: new DeterministicRegimeEngine(symbolCfg.deterministicRegime), entryEngine: new DeterministicEntryEngine(symbolCfg.deterministicSignal),
        liquidity: new DynamicLiquidityPolicy(symbolCfg.dynamicLiquidity), entryAudit: new EntryPipelineAudit(),
        signalRouter: new SignalRouter(symbolCfg.signalMode, this.optionalModel(symbolCfg, optionalForecast)),
        holdEngine: new DeterministicHoldEngine(symbolCfg.deterministicHold), cost,
        planner: new ExecutionPlanner(symbolCfg.planner, new RiskSizer(symbolCfg.sizing), cost, symbolCfg.strategyVersion, symbolCfg.modelVersion),
        positionManager: new PositionManager(symbolCfg.position), cluster: baseAsset(symbol),
      });
    }
    this.bindStreams();
  }

  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.startedAtMs = this.now();
    if (this.cfg.mode !== "record") {
      await this.preflight();
      await this.reconcileAccount();
    }
    else this.riskState.setHealth({ accountReconciled: true, privateStream: true, riskRecomputed: true });
    this.marketStream.connect();
    if (this.cfg.mode !== "record") this.tradeStream.connect();
    this.watchdog.start();
  }

  public restoreSlowTrendHistory(history: ReadonlyMap<string, readonly SlowTrendObservation[]>, asOfMs = this.now()): Readonly<Record<string, SlowTrendRestoreResult>> {
    const restored: Record<string, SlowTrendRestoreResult> = {};
    for (const [symbol, runtime] of this.runtimes) {
      restored[symbol] = runtime.deterministicFeatures.restoreSlowTrend(history.get(symbol) ?? [], asOfMs);
    }
    return restored;
  }

  public async stop(): Promise<void> {
    this.marketStream.close();
    this.tradeStream.close();
    this.watchdog.stop();
    if (this.recorder) {
      this.recorder.write({ kind: "DISCONNECT", receiveTsMs: this.now(), stream: "public" });
      await this.recorder.close();
    }
    this.started = false;
  }

  /**
   * Sends one minimum-size, marketable entry through the real order-state path.
   * This exists only for an explicitly requested Alpaca paper-account lifecycle
   * demonstration; it is never reachable from normal strategy evaluation.
   */
  public async submitPaperDemoEntry(symbol = "BTC/USD"): Promise<ExecutionPlan> {
    if (this.cfg.mode !== "paper" || !this.cfg.paper) throw new Error("Paper demo entries require paper mode and the Alpaca paper endpoint");
    if (!this.started) throw new Error("Paper demo entry requires a started engine");
    if (!this.riskState.entriesAllowed()) throw new Error(`Paper demo entry blocked by risk/health state: ${this.riskState.reasons().join(",") || "not ready"}`);
    const runtime = this.runtimes.get(symbol);
    if (!runtime) throw new Error(`Paper demo symbol is not configured: ${symbol}`);
    if (!runtime.asset) throw new Error(`Paper demo asset rules are not ready: ${symbol}`);
    if (runtime.position || this.pendingForSymbol(symbol)) throw new Error(`Paper demo requires no position or pending order for ${symbol}`);
    const book = runtime.book.snapshot();
    const features = runtime.latestFeatures;
    if (!book.valid || !features || !features.warmedUp || features.stale || !featureNumbersAreFinite(features)) {
      throw new Error(`Paper demo market is not ready: ${symbol}`);
    }
    // Alpaca enforces a $10 minimum cost basis for USD crypto orders even when
    // the asset endpoint reports a smaller dynamic quantity. Targeting $11
    // leaves a small price-movement buffer while remaining tightly capped.
    const targetQty = PAPER_DEMO_TARGET_NOTIONAL / book.asks[0]!.px;
    const qty = ceilQuantity(Math.max(runtime.asset.minOrderSize, targetQty), runtime.asset.minTradeIncrement);
    const sweep = estimateSweep(book.asks, qty);
    const cost = runtime.cost.estimate(features, book, 1, qty, false);
    if (!sweep || !cost) throw new Error(`Paper demo cannot build an executable capped order for ${symbol}`);
    const limitPx = ceilPrice(Math.max(sweep.worstPx, book.asks[0]!.px + Math.max(features.spread, runtime.asset.priceIncrement)), runtime.asset.priceIncrement);
    const notional = qty * limitPx;
    const maximumDemoNotional = Math.min(25, runtime.config.maximumNotional);
    if (!(notional > 0) || notional > maximumDemoNotional + 1e-8) {
      throw new Error(`Paper demo minimum order notional ${notional.toFixed(2)} exceeds the ${maximumDemoNotional.toFixed(2)} safety cap`);
    }
    const maximumLossPerUnit = Math.max(
      cfgPriceSigma(features, runtime.config.initialStopSigma),
      runtime.config.minimumStopSpreadMultiple * features.spread,
      runtime.asset.priceIncrement,
    ) + features.mid * cost.roundTripBps / 10_000;
    const risk: RiskApproval = {
      qty, riskBudget: qty * maximumLossPerUnit, maximumLossPerUnit,
      modeledMaximumLoss: qty * maximumLossPerUnit, drawdownScale: 1, qualityScale: 1,
      volatilityScale: 1, bindingLimit: "exchange",
    };
    const candidate = { symbol, notional, cluster: runtime.cluster, stressedLoss: risk.modeledMaximumLoss };
    if (!this.portfolio.canAdd(candidate, this.equity, Math.max(0, -this.realizedSessionPnl))) throw new Error("Paper demo entry blocked by portfolio risk limits");
    const nowMs = this.now();
    const plan: ExecutionPlan = {
      clientOrderId: `mlce-demo-entry-${nowMs}-${randomUUID().slice(0, 8)}`,
      decisionId: randomUUID(), riskApprovalId: randomUUID(), symbol, side: 1, qty, limitPx,
      style: "taker", timeInForce: "ioc", createdMs: nowMs, expiresMs: nowMs + 1_000,
      originatingSequence: book.sequence,
      featureHash: createHash("sha256").update(JSON.stringify(features)).digest("hex").slice(0, 24),
      strategyVersion: runtime.config.strategyVersion, modelVersion: runtime.config.modelVersion,
      expectedCost: cost, risk, fillProbability: 1,
      expectedValue: -notional * cost.roundTripBps / 10_000, reduceOnlyIntent: false,
    };
    this.emit("decision", {
      diagnostic: "PAPER_LIFECYCLE_DEMO", bypassedStrategyGates: true,
      reason: "User-requested minimum-size paper order lifecycle demonstration",
      configurationVersion: runtime.config.configurationVersion, strategyVersion: runtime.config.strategyVersion,
      adapterVersion: "alpaca-v1", symbolRulesetVersion: assetRulesVersion(runtime.asset), features, plan, mode: this.cfg.mode,
    });
    if (!await this.submit(plan)) throw new Error(`Paper demo entry submission failed for ${symbol}`);
    return plan;
  }

  public async reconcileAccount(): Promise<boolean> {
    this.riskState.setHealth({ accountReconciled: false, riskRecomputed: false });
    try {
      const [accountResponse, assetsResponse, ordersResponse, positionsResponse, historyResponse, activitiesResponse] = await Promise.all([
        this.rest.getAccount(), this.rest.listAssets({ status: "active", asset_class: "crypto", exchange: "CRYPTO" }),
        this.rest.listOrders({ status: "open", asset_class: "crypto", limit: 500 }), this.rest.listPositions(),
        this.rest.getPortfolioHistory({ period: "1D", timeframe: "1Min" }),
        this.rest.getActivities({ category: "trade_activity", direction: "desc", page_size: 100 }),
      ]);
      const account = accountResponse.data;
      if (account.account_blocked || account.trading_blocked || (account.crypto_status && account.crypto_status !== "ACTIVE")) throw new Error("Alpaca account is not available for crypto trading");
      this.equity = Number(account.equity);
      this.equityHighWater = Math.max(this.equityHighWater, this.equity);
      this.riskState.updateEquity(this.equity);
      const assets = new Map(assetsResponse.data.map((asset) => [asset.symbol, asset]));
      for (const [symbol, runtime] of this.runtimes) {
        const asset = assets.get(symbol) ?? (await this.rest.getAsset(symbol)).data;
        runtime.asset = assetRules(asset);
      }
      this.orderState.reconcile(ordersResponse.data.map((order) => ({ id: order.id, clientOrderId: order.client_order_id, filledQty: Number(order.filled_qty), status: order.status })));
      this.reconcilePositions(positionsResponse.data);
      const rollingLoss = rollingLossFromPortfolioHistory(historyResponse.data);
      this.realizedSessionPnl = Math.min(this.realizedSessionPnl, -rollingLoss);
      this.recomputePortfolioRisk();
      this.riskState.setHealth({ accountReconciled: true, riskRecomputed: true });
      this.riskState.resumeAfterReconciliation();
      this.emit("reconciled", { recentTradeActivities: activitiesResponse.data.length,
        requestIds: [accountResponse.requestId, assetsResponse.requestId, ordersResponse.requestId, positionsResponse.requestId, historyResponse.requestId, activitiesResponse.requestId].filter(Boolean) });
      return true;
    } catch (error) {
      this.riskState.halt("ACCOUNT_UNKNOWN");
      this.emit("engineError", error);
      return false;
    }
  }

  public state(): EngineOperationalSnapshot {
    const generatedAtMs = this.now();
    const markets = [...this.runtimes.entries()].map(([symbol, runtime]): EngineMarketSnapshot => {
      const book = runtime.book.snapshot();
      return {
        symbol,
        bookValid: book.valid,
        bestBid: book.bids[0]?.px ?? null,
        bestAsk: book.asks[0]?.px ?? null,
        sequence: book.sequence.toString(),
        exchangeTsMs: book.exchangeTsMs,
        receiveTsMs: book.receiveTsMs,
        features: runtime.latestFeatures ? { ...runtime.latestFeatures } : null,
        regime: runtime.latestRegime ? { ...runtime.latestRegime } : null,
        ruleEvaluation: runtime.latestRuleEvaluation ? cloneEvaluation(runtime.latestRuleEvaluation) : null,
        entryReady: Boolean(runtime.latestRuleEvaluation?.intent
          && (runtime.latestRuleEvaluation.intent.side === 1 || runtime.asset?.shortable === true)),
        liquidity: runtime.latestLiquidity ? cloneLiquidity(runtime.latestLiquidity) : null,
        entryPipeline: runtime.entryAudit.snapshot(),
      };
    });
    return {
      generatedAtMs,
      started: this.started,
      startedAtMs: this.startedAtMs,
      uptimeMs: this.startedAtMs === null ? 0 : Math.max(0, generatedAtMs - this.startedAtMs),
      mode: this.cfg.mode,
      paper: this.cfg.paper,
      paperEntryExercise: this.cfg.paperEntryExercise,
      strategyVersion: this.cfg.strategyVersion,
      modelVersion: this.cfg.modelVersion,
      configurationVersion: this.cfg.configurationVersion,
      signalMode: this.cfg.signalMode,
      symbols: [...this.cfg.symbols],
      equity: this.equity,
      equityHighWater: this.equityHighWater,
      realizedSessionPnl: this.realizedSessionPnl,
      risk: this.riskState.snapshot(),
      orders: this.orderState.all(),
      positions: [...this.runtimes.values()].flatMap((runtime) => runtime.position ? [{ ...runtime.position }] : []),
      markets,
      latency: this.latency.summary(generatedAtMs),
    };
  }

  private optionalModel(cfg: SymbolConfig, forecastEngine?: ForecastEngine): OptionalSignalModel | undefined {
    if (!forecastEngine) return undefined;
    return {
      evaluate: (features, intent) => {
        const forecast = forecastEngine.evaluate(features, Math.max(1, this.latency.p95Total(this.now()) || 250));
        const modelLowerBoundBps = forecast.grossAtArrivalBps - forecast.residualQ95Bps;
        const accept = !forecast.expired && forecast.side === intent.side
          && forecast.probability >= cfg.signal.minimumDirectionProbability;
        return {
          accept, rankingScore: modelLowerBoundBps,
          sizeMultiplier: Math.max(0, Math.min(1, modelLowerBoundBps / Math.max(cfg.signal.fullQualityEdgeBps, 1e-9))),
          modelVersion: cfg.modelVersion,
        };
      },
    };
  }

  private systemGates(runtime: SymbolRuntime): SystemGateState {
    const risk = this.riskState.snapshot();
    const bookValid = runtime.book.isValid() && risk.health.bookValid;
    return {
      bookValid, sequenceValid: bookValid, checksumValid: bookValid,
      publicStreamHealthy: risk.health.publicStream, privateStreamHealthy: risk.health.privateStream,
      accountReconciled: risk.health.accountReconciled, clockHealthy: risk.health.clockValid,
      entriesAllowed: this.riskState.entriesAllowed(), noExistingPosition: !runtime.position,
      noPendingEntry: !this.pendingForSymbol(runtime.book.symbol),
    };
  }

  private async preflight(): Promise<void> {
    const [configuration, clock, orderbooks, snapshots, quotes, trades, bars] = await Promise.all([
      this.rest.getAccountConfiguration(), this.rest.getClock(), this.rest.latestOrderbooks(this.cfg.symbols),
      this.rest.snapshots(this.cfg.symbols), this.rest.latestQuotes(this.cfg.symbols), this.rest.latestTrades(this.cfg.symbols),
      this.rest.latestBars(this.cfg.symbols),
    ]);
    const alpacaClockMs = Date.parse(clock.data.timestamp);
    const clockValid = Number.isFinite(alpacaClockMs) && Math.abs(this.now() - alpacaClockMs) <= 60_000;
    this.riskState.setHealth({ clockValid });
    if (!clockValid) { this.riskState.halt("CLOCK_INVALID"); throw new Error("Alpaca clock differs from the local clock by more than 60 seconds"); }
    this.emit("preflight", {
      accountConfiguration: configuration.data,
      clock: clock.data,
      marketResources: {
        orderbooks: Object.keys(orderbooks.data.orderbooks ?? {}), snapshots: Object.keys(snapshots.data.snapshots ?? {}),
        quotes: Boolean(quotes.data), trades: Boolean(trades.data), bars: Boolean(bars.data),
      },
      requestIds: [configuration.requestId, clock.requestId, orderbooks.requestId, snapshots.requestId, quotes.requestId, trades.requestId, bars.requestId].filter(Boolean),
    });
  }

  private bindStreams(): void {
    this.marketStream.on("authenticated", () => {
      this.watchdog.markPublic();
      this.riskState.setHealth({ publicStream: true });
      this.emit("publicStreamReady");
      if (this.cfg.mode !== "record") void this.reconcileAccount();
    });
    this.marketStream.on("book", (delta: BookDelta) => this.onBook(delta));
    this.marketStream.on("trade", (trade: MarketTrade) => this.onTrade(trade));
    // Socket pongs prove transport connectivity, not that the subscribed market feed is advancing.
    this.marketStream.on("heartbeat", () => undefined);
    this.marketStream.on("disconnect", () => this.onPublicDisconnect());
    this.marketStream.on("streamError", (error) => this.emit("engineError", error));
    this.tradeStream.on("authenticated", () => {
      this.watchdog.markPrivate();
      this.riskState.setHealth({ privateStream: true });
      this.emit("privateStreamReady");
      void this.reconcileAccount();
    });
    this.tradeStream.on("order", (event: PrivateOrderEvent) => this.onPrivateEvent(event));
    this.tradeStream.on("heartbeat", () => this.watchdog.markPrivate());
    this.tradeStream.on("disconnect", () => { this.riskState.setHealth({ privateStream: false }); this.riskState.halt("PRIVATE_STREAM_DOWN"); void this.cancelAllSafely("PRIVATE_STREAM_DOWN"); });
    this.tradeStream.on("streamError", (error) => this.emit("engineError", error));
  }

  private onBook(delta: BookDelta): void {
    this.watchdog.markPublic(delta.receiveTsMs);
    this.riskState.setHealth({ publicStream: true });
    this.recorder?.write({ kind: "BOOK", delta });
    const runtime = this.runtimes.get(delta.symbol);
    if (!runtime) return;
    const result = runtime.book.apply(delta);
    if (result.duplicate) return;
    if (!result.accepted || !result.state) {
      this.riskState.setHealth({ bookValid: false });
      this.riskState.halt("BOOK_INVALID");
      void this.cancelAllSafely("BOOK_INVALID");
      return;
    }
    const baseFeatures = runtime.features.onBook(result.state, result.flow);
    if (!baseFeatures) return;
    const features = runtime.deterministicFeatures.update(baseFeatures, runtime.pressure.update(result.state));
    this.processMarketState(runtime, result.state, features);
  }

  private processMarketState(runtime: SymbolRuntime, book: BookState, features: DeterministicFeatures): void {
    runtime.entryAudit.pass("MARKET_EVENT");
    if (book.valid) runtime.entryAudit.pass("BOOK_READY");
    else this.rejectEntry(runtime, "BOOK_READY", "BOOK_INVALID", features.receiveTsMs);
    if (!featureNumbersAreFinite(features)) {
      this.rejectEntry(runtime, "FEATURES_READY", "NON_FINITE_FEATURES", features.receiveTsMs);
      this.riskState.setHealth({ bookValid: false });
      this.riskState.halt("BOOK_INVALID");
      this.emit("engineError", new Error(`Non-finite feature state for ${book.symbol}`));
      void this.cancelAllSafely("NON_FINITE_FEATURES");
      return;
    }
    runtime.latestFeatures = features;
    const allBooksStructurallyValid = [...this.runtimes.values()].every((item) => item.book.isValid());
    const staleExposure = [...this.runtimes.values()].some((item) =>
      Boolean(item.position || this.pendingForSymbol(item.book.symbol)) && item.latestFeatures?.stale !== false);
    this.riskState.setHealth({ bookValid: allBooksStructurallyValid && !staleExposure });
    if (features.stale) {
      this.rejectEntry(runtime, "FEATURES_READY", features.staleReason ?? "FEATURES_STALE", features.receiveTsMs, {
        staleReason: features.staleReason, providerAgeMs: features.providerAgeMs,
        staleThresholdMs: features.staleThresholdMs,
      });
      const pending = this.pendingForSymbol(book.symbol);
      if (pending) void this.cancelTracked(pending, "STALE_BOOK", {
        staleReason: features.staleReason, providerAgeMs: features.providerAgeMs,
        staleThresholdMs: features.staleThresholdMs,
      });
      // An idle symbol may go stale without disabling unrelated symbols. Existing exposure still fails closed globally.
      if (runtime.position || pending) {
        this.riskState.halt("BOOK_INVALID");
      }
      return;
    }
    if (!features.warmedUp) {
      runtime.liquidity.observe(features.spreadBps);
      runtime.entryAudit.pass("LIQUIDITY_OBSERVATION");
      this.rejectEntry(runtime, "FEATURES_READY", "FEATURE_WARMUP", features.receiveTsMs);
      return;
    }
    runtime.entryAudit.pass("FEATURES_READY");
    this.riskState.setHealth({ riskRecomputed: true });
    this.riskState.resumeAfterReconciliation();
    const smallQty = runtime.asset?.minOrderSize ?? 0;
    const longCost = runtime.asset ? runtime.planner.preliminaryCost(features, book, 1, smallQty) : null;
    const shortCost = runtime.asset ? runtime.planner.preliminaryCost(features, book, -1, smallQty) : null;
    const longEconomicCosts = runtime.asset ? runtime.planner.economicCosts(features, book, 1, smallQty) : [];
    const shortEconomicCosts = runtime.asset ? runtime.planner.economicCosts(features, book, -1, smallQty) : [];
    const longLiquidity = longCost ? runtime.liquidity.evaluate(liquidityInput(features, longCost.impactBps)) : null;
    const shortLiquidity = shortCost ? runtime.liquidity.evaluate(liquidityInput(features, shortCost.impactBps)) : null;
    runtime.liquidity.observe(features.spreadBps);
    runtime.entryAudit.pass("LIQUIDITY_OBSERVATION");
    if (longLiquidity && shortLiquidity) runtime.latestLiquidity = { long: longLiquidity, short: shortLiquidity };
    if (this.cfg.mode === "record") return;

    // Observe liquidity first, then preserve order/exposure lifecycle priority over new entries.
    if (runtime.position && runtime.position.qty > 0) {
      if (!features.kinematicsReady) return;
      this.managePosition(runtime, book, features);
      return;
    }
    const pending = this.pendingForSymbol(book.symbol);
    if (pending) {
      if (!features.kinematicsReady) void this.cancelTracked(pending, "KINEMATICS_UNAVAILABLE");
      else this.reevaluatePending(runtime, pending, book, features);
      return;
    }

    if (!runtime.asset) {
      this.rejectEntry(runtime, "VENUE_DIRECTION_PASS", "ASSET_RULES_UNAVAILABLE", features.receiveTsMs);
      return;
    }
    if (!longCost || !shortCost || !longLiquidity || !shortLiquidity) {
      this.rejectEntry(runtime, "PRELIMINARY_COST_PASS", "COST_ESTIMATE_UNAVAILABLE", features.receiveTsMs);
      return;
    }
    const regime = runtime.regimeEngine.classify(features);
    runtime.latestRegime = regime;
    const deterministicIntent = runtime.entryEngine.evaluate({
      symbol: book.symbol, sequence: book.sequence, nowMs: features.receiveTsMs, features, regime,
      system: this.systemGates(runtime), bestBid: book.bids[0]!.px, bestAsk: book.asks[0]!.px,
      longCost, shortCost, longEconomicCosts, shortEconomicCosts, longLiquidity, shortLiquidity,
    });
    const evaluation = runtime.entryEngine.latestEvaluation();
    if (evaluation) runtime.latestRuleEvaluation = evaluation;
    this.emit("ruleEvaluation", {
      configurationVersion: runtime.config.configurationVersion, strategyVersion: runtime.config.strategyVersion,
      symbolRulesetVersion: assetRulesVersion(runtime.asset), features, regime, evaluation: runtime.latestRuleEvaluation,
    });
    if (evaluation) this.auditEvaluation(runtime, evaluation, features.receiveTsMs);

    const venueIntent = deterministicIntent && (deterministicIntent.side === 1 || runtime.asset.shortable) ? deterministicIntent : null;
    const routed = runtime.signalRouter.route(venueIntent, features);
    if (!routed || routed.sizeMultiplier <= 0) {
      if (venueIntent) this.rejectEntry(runtime, "EXECUTION_PLAN_PASS", "SIGNAL_ROUTER_BLOCK", features.receiveTsMs);
      return;
    }
    const intent = plannerIntent(routed.intent, 1);
    const riskSigmaHBps = routed.intent.selectedHorizonMs === undefined ? features.sigmaHBps
      : 10_000 * Math.sqrt(Math.max(features.slowVarianceRate, 1e-16) * routed.intent.selectedHorizonMs / 1_000);
    const initialStopDistance = Math.max(
      features.mid * riskSigmaHBps / 10_000 * runtime.config.initialStopSigma,
      runtime.config.minimumStopSpreadMultiple * features.spread,
      runtime.asset.priceIncrement,
    );
    const plan = runtime.planner.build(intent, features, book, runtime.asset, {
      equity: this.equity, equityHighWater: this.equityHighWater, initialStopDistance,
      jumpBuffer: cfgPriceSigma(features, runtime.config.jumpSigma), maximumNotional: runtime.config.maximumNotional,
      // A micro candidate is regime-independent by construction; candidate quality already scales risk.
      lotSize: runtime.asset.minTradeIncrement, regimeScale: 1,
      exposureCapacityQty: runtime.config.maximumNotional / features.mid,
    }, false, {
      createdMs: features.receiveTsMs, decisionId: routed.intent.decisionId,
      quantityMultiplier: routed.sizeMultiplier,
      riskSigmaHBps,
      ...(routed.intent.executionPath === undefined ? {} : { executionPath: routed.intent.executionPath }),
      ...(routed.intent.selectedHorizonMs === undefined ? {} : { economicHorizonMs: routed.intent.selectedHorizonMs }),
      revalidateCost: (exactCost) => {
        const exact = runtime.entryEngine.revalidateExactCost(routed.intent, exactCost);
        return exact ? plannerIntent(exact, 1) : null;
      },
    });
    if (!plan) {
      this.rejectEntry(runtime, "EXECUTION_PLAN_PASS", "NO_SAFE_SIZE_OR_EXACT_COST_PLAN", features.receiveTsMs, {
        side: routed.intent.side, lowerBoundNetBps: routed.intent.lowerBoundNetBps,
      });
      return;
    }
    runtime.entryAudit.pass("SIZE_PASS");
    runtime.entryAudit.pass("EXECUTION_PLAN_PASS");
    runtime.entryAudit.pass("FINAL_COST_PASS");
    runtime.entryAudit.pass("FINAL_COST_QUALITY_PASS");
    const candidate = { symbol: plan.symbol, notional: plan.qty * features.mid * plan.side, cluster: runtime.cluster, stressedLoss: plan.risk.modeledMaximumLoss };
    if (!this.portfolio.canAdd(candidate, this.equity, Math.max(0, -this.realizedSessionPnl))) {
      this.rejectEntry(runtime, "PORTFOLIO_PASS", "PORTFOLIO_CAPACITY_BLOCK", features.receiveTsMs);
      return;
    }
    runtime.entryAudit.pass("PORTFOLIO_PASS");
    this.emit("decision", {
      configurationVersion: runtime.config.configurationVersion, strategyVersion: runtime.config.strategyVersion,
      adapterVersion: "alpaca-v1", symbolRulesetVersion: assetRulesVersion(runtime.asset),
      regime, deterministicIntent: routed.intent, routing: routed, features, plan, mode: this.cfg.mode,
    });
    if (this.cfg.mode !== "shadow") {
      runtime.pendingEntryIntent = routed.intent;
      void this.submit(plan).then((submitted) => {
        if (!submitted && runtime.pendingEntryIntent?.decisionId === plan.decisionId) delete runtime.pendingEntryIntent;
      });
    }
  }

  private auditEvaluation(runtime: SymbolRuntime, evaluation: DeterministicEvaluation, atMs: number): void {
    runtime.entryAudit.pass("MICRO_EVENT");
    if (evaluation.long.votes.book > 0 || evaluation.short.votes.book > 0) runtime.entryAudit.pass("BOOK_GROUP_PASS");
    if (evaluation.long.votes.flow > 0 || evaluation.short.votes.flow > 0) runtime.entryAudit.pass("FLOW_GROUP_PASS");
    if (evaluation.long.votes.kinematic > 0 || evaluation.short.votes.kinematic > 0) runtime.entryAudit.pass("MOTION_GROUP_PASS");
    if (evaluation.long.votes.quorum || evaluation.short.votes.quorum) runtime.entryAudit.pass("GROUP_QUORUM_PASS");
    if (evaluation.long.phase === "ARMED" || evaluation.short.phase === "ARMED") runtime.entryAudit.pass("MICRO_ARMED");
    if (evaluation.candidate) runtime.entryAudit.pass("MICRO_CANDIDATE");
    const scoreFocus = evaluation.long.score >= evaluation.short.score ? evaluation.long : evaluation.short;
    if (!evaluation.long.rawDirectionalPass && !evaluation.short.rawDirectionalPass) {
      const focus = scoreFocus;
      const reason = focus.reasons.includes("KINEMATICS_NOT_READY") ? "MOTION_NOT_READY"
        : !focus.votes.quorum ? "RULE_QUORUM"
        : !focus.scorePass ? "SCORE_GATE" : "ARBITRATION_GATE";
      this.rejectEntry(runtime, "DIRECTIONAL_RAW_PASS", reason, atMs, {
        side: focus.side, score: focus.score, oppositeScore: focus.oppositeScore,
        bookVotes: focus.votes.book, flowVotes: focus.votes.flow, kinematicVotes: focus.votes.kinematic,
        deltaMicroBps: focus.deltaMicroBps, sensorThresholdBps: focus.sensorThresholdBps,
      });
      return;
    }
    runtime.entryAudit.pass("DIRECTIONAL_RAW_PASS");
    if (!evaluation.candidate) {
      const focus = evaluation.long.rawDirectionalPass ? evaluation.long : evaluation.short;
      const reason = focus.reasons.find((value) => ["OCCUPANCY_FALSE", "EVIDENCE_FALSE", "CONFIRMATION_TIME_FALSE",
        "CONFIRMATION_EVENTS_FALSE", "MAXIMUM_CHASE_EXCEEDED", "COOLDOWN_ACTIVE", "ALREADY_FIRED_IN_EPISODE"].includes(value))
        ?? "PERSISTENCE_GATE";
      this.rejectEntry(runtime, "DIRECTIONAL_CANDIDATE", reason, atMs, {
        side: focus.side, persistence: focus.persistence, confirmationMs: focus.confirmationMs,
        confirmationEvents: focus.confirmationEvents, evidence: focus.evidence, chaseBps: focus.chaseBps,
      });
      return;
    }
    const candidate = evaluation.candidate;
    const diagnostics = candidate.diagnostics;
    runtime.entryAudit.pass("DIRECTIONAL_CANDIDATE");
    if (!runtime.latestFeatures?.slowTrendReady) {
      this.rejectEntry(runtime, "CONTINUATION_FEATURES_READY", "SLOW_TREND_WARMUP", atMs, {
        slowTrendReady: false,
      });
      return;
    }
    runtime.entryAudit.pass("CONTINUATION_FEATURES_READY");
    if (!diagnostics.slowTrendPass) {
      this.rejectEntry(runtime, "SLOW_TREND_PASS", "SLOW_TREND_GATE", atMs, {
        side: diagnostics.side,
        trendFastBps: runtime.latestFeatures.trendFastBps,
        trendMediumBps: runtime.latestFeatures.trendMediumBps,
        trendSlowBps: runtime.latestFeatures.trendSlowBps,
        slowTrendAlignment: runtime.latestFeatures.slowTrendAlignment,
        slowTrendEfficiency: runtime.latestFeatures.slowTrendEfficiency,
      });
      return;
    }
    runtime.entryAudit.pass("SLOW_TREND_PASS");
    if (!diagnostics.healthPass) { this.rejectEntry(runtime, "HEALTH_PASS", "HEALTH_GATE", atMs); return; }
    runtime.entryAudit.pass("HEALTH_PASS");
    if (!diagnostics.liquidityPass) {
      this.rejectEntry(runtime, "LIQUIDITY_PASS", diagnostics.liquidityReasons.join("+") || "LIQUIDITY_GATE", atMs, {
        spreadBps: runtime.latestFeatures?.spreadBps ?? null,
        tradeThresholdBps: diagnostics.tradeThresholdBps, stressThresholdBps: diagnostics.stressThresholdBps,
      });
      return;
    }
    runtime.entryAudit.pass("LIQUIDITY_PASS");
    const venuePass = candidate.side === 1 || runtime.asset?.shortable === true;
    if (!venuePass) { this.rejectEntry(runtime, "VENUE_DIRECTION_PASS", "SPOT_SHORT_UNAVAILABLE", atMs); return; }
    runtime.entryAudit.pass("VENUE_DIRECTION_PASS");
    if (!diagnostics.exposurePass) { this.rejectEntry(runtime, "EXPOSURE_PASS", "EXISTING_POSITION_OR_PENDING_ENTRY", atMs); return; }
    runtime.entryAudit.pass("EXPOSURE_PASS");
    if (!diagnostics.cooldownPass) { this.rejectEntry(runtime, "COOLDOWN_PASS", "COOLDOWN_OR_RESET_GATE", atMs); return; }
    runtime.entryAudit.pass("COOLDOWN_PASS");
    if (!diagnostics.edgeResolvedPass) { this.rejectEntry(runtime, "EDGE_RESOLVED", "EDGE_NOT_RESOLVED", atMs); return; }
    runtime.entryAudit.pass("EDGE_RESOLVED");
    runtime.entryAudit.pass("COST_PATHS_RESOLVED");
    if (!diagnostics.costPass) {
      this.rejectEntry(runtime, "PRELIMINARY_COST_PASS", "COST_GATE", atMs, {
        edgeSource: diagnostics.edgeSource, edgeHorizonMs: diagnostics.edgeHorizonMs, edgeQuality: diagnostics.edgeQuality,
        grossOpportunityBps: diagnostics.grossOpportunityBps, uncertaintyReserveBps: diagnostics.uncertaintyReserveBps,
        roundTripCostBps: diagnostics.roundTripCostBps, robustCostBps: diagnostics.robustCostBps,
        lowerBoundNetBps: diagnostics.lowerBoundNetBps, costShortfallBps: diagnostics.costShortfallBps,
        continuationQuality: diagnostics.continuationQuality,
        requiredContinuationQuality: diagnostics.requiredContinuationQuality,
        executionPath: diagnostics.executionPath ?? "UNRESOLVED",
      });
      return;
    }
    runtime.entryAudit.pass("PRELIMINARY_COST_PASS");
    runtime.entryAudit.pass("COST_QUALITY_PASS");
    if (!diagnostics.antiChasePass) { this.rejectEntry(runtime, "ANTI_CHASE_PASS", "ANTI_CHASE_GATE", atMs); return; }
    runtime.entryAudit.pass("ANTI_CHASE_PASS");
  }

  private rejectEntry(runtime: SymbolRuntime, stage: EntryPipelineStage, reason: string, atMs: number,
    values: Readonly<Record<string, number | string | boolean | null>> = {}): void {
    if (!runtime.entryAudit.reject(stage, reason, atMs, values)) return;
    this.emit("entryBlocked", { symbol: runtime.book.symbol, stage, reason, values, atMs });
  }

  private onTrade(trade: MarketTrade): void {
    this.watchdog.markPublic(trade.receiveTsMs);
    this.riskState.setHealth({ publicStream: true });
    this.recorder?.write({ kind: "TRADE", trade });
    const runtime = this.runtimes.get(trade.symbol);
    if (!runtime) return;
    runtime.features.onTrade(trade);
    const snapshot = runtime.book.snapshot();
    if (!snapshot.valid) return;
    // Advance causal clocks on a trade without pretending the unchanged book is newer than its last exchange timestamp.
    const eventBook: BookState = { ...snapshot, receiveTsMs: trade.receiveTsMs };
    const baseFeatures = runtime.features.onBook(eventBook);
    if (!baseFeatures) return;
    const features = runtime.deterministicFeatures.update(baseFeatures, runtime.pressure.update(eventBook));
    this.processMarketState(runtime, eventBook, features);
  }

  private onPrivateEvent(event: PrivateOrderEvent): void {
    this.watchdog.markPrivate(event.timestampMs);
    this.recorder?.write({ kind: "PRIVATE", event });
    const fill = this.orderState.apply(event);
    const tracked = this.orderState.get(event.clientOrderId);
    if (tracked) this.emit("orderUpdate", { event, order: tracked });
    if (fill) this.applyFill(fill);
    if (tracked && !["RESERVED", "SENDING", "OPEN", "PARTIALLY_FILLED", "CANCEL_PENDING", "UNKNOWN"].includes(tracked.status)) {
      const runtime = this.runtimes.get(tracked.plan.symbol);
      if (runtime?.pendingEntryIntent?.decisionId === tracked.plan.decisionId) delete runtime.pendingEntryIntent;
    }
    if (["rejected", "order_replace_rejected", "order_cancel_rejected"].includes(event.event)) this.emit("orderRejected", event);
  }

  private async submit(plan: ExecutionPlan): Promise<boolean> {
    if (this.cfg.mode === "shadow") return false;
    if (this.cfg.mode !== "paper" && this.cfg.mode !== "live") return false;
    try {
      this.orderState.reserve(plan);
      this.runtimes.get(plan.symbol)?.entryAudit.pass("RISK_RESERVED");
      this.emit("orderReserved", { plan });
      this.orderState.markSending(plan.clientOrderId);
      this.runtimes.get(plan.symbol)?.entryAudit.pass("ORDER_SEND_ATTEMPT");
      this.emit("orderSending", { plan });
      const sentMs = this.now();
      const order = await this.gateway.send(plan);
      const acknowledgedMs = this.now();
      this.orderState.markAccepted(plan.clientOrderId, order.id, acknowledgedMs);
      this.runtimes.get(plan.symbol)?.entryAudit.pass("ORDER_ACK");
      this.latency.record({ localReceiptMs: plan.createdMs, decisionCompleteMs: plan.createdMs, sentMs, acknowledgedMs }, acknowledgedMs);
      this.emit("orderAccepted", { order, plan });
      return true;
    } catch (error) {
      const tracked = this.orderState.get(plan.clientOrderId);
      if (tracked && error instanceof AlpacaApiError && error.status >= 400) {
        this.orderState.apply({ id: randomUUID(), event: "rejected", orderId: "", clientOrderId: plan.clientOrderId, symbol: plan.symbol, filledQty: 0, eventQty: 0, eventPx: 0, timestampMs: this.now() });
      } else if (tracked) {
        this.orderState.markSendUnknown(plan.clientOrderId, error);
        this.riskState.halt("ORDER_SEND_UNKNOWN");
        await this.reconcileAccount();
      }
      this.emit("engineError", error);
      return false;
    }
  }

  private reevaluatePending(runtime: SymbolRuntime, pending: ReturnType<OrderStateReconciler["all"]>[number], book: ReturnType<LocalOrderBook["snapshot"]>, features: DeterministicFeatures): void {
    if (pending.status === "UNKNOWN") { this.riskState.halt("ORDER_SEND_UNKNOWN"); return; }
    const cost = runtime.cost.estimate(features, book, pending.plan.side, Math.max(pending.plan.qty - pending.filledQty, 0), pending.plan.style === "maker");
    const regime = runtime.regimeEngine.classify(features);
    runtime.latestRegime = regime;
    const sourceIntent = runtime.pendingEntryIntent?.decisionId === pending.plan.decisionId
      ? runtime.pendingEntryIntent : undefined;
    const stillValid = sourceIntent !== undefined
      && runtime.entryEngine.signalStillValid(pending.plan.side, features, regime, sourceIntent.diagnostics.family);
    const exactCostValid = cost !== null && sourceIntent?.side === pending.plan.side
      && runtime.entryEngine.revalidateExactCost(sourceIntent, cost) !== null;
    const adverse = pending.plan.side * features.tfi < -.5 || pending.plan.side * features.ofi < -2;
    const nowMs = this.now();
    const reason: OrderCancelRequestReason | null = nowMs >= pending.plan.expiresMs ? "TTL_EXPIRED"
      : features.stale ? "STALE_BOOK"
        : adverse ? "ADVERSE_FLOW"
          : !stillValid ? "SIGNAL_INVALIDATED"
            : !exactCostValid ? "COST_INVALIDATED" : null;
    if (reason) void this.cancelTracked(pending, reason, {
      nowMs, expiresMs: pending.plan.expiresMs, stillValid, exactCostValid, adverse,
      stale: features.stale, tfi: features.tfi, ofi: features.ofi,
      remainingQty: Math.max(pending.plan.qty - pending.filledQty, 0),
      roundTripCostBps: cost?.roundTripBps ?? null,
    });
  }

  private managePosition(runtime: SymbolRuntime, book: ReturnType<LocalOrderBook["snapshot"]>, features: DeterministicFeatures): void {
    const position = runtime.position!;
    const pending = this.pendingForSymbol(position.symbol);
    if (pending) {
      if (pending.plan.side === 1) void this.cancelTracked(pending, "POSITION_ALREADY_OPEN");
      else if (pending.plan.reduceOnlyIntent && pending.plan.style === "maker") {
        const executableExit = book.bids[0]!.px;
        const signedMovePx = position.side * (executableExit - position.entryPx);
        const riskFloorBreached = signedMovePx <= Math.max(position.floorPx, -position.initialRiskPx);
        if (this.now() >= pending.plan.expiresMs || riskFloorBreached) {
          void this.fallbackMakerExit(runtime, pending, riskFloorBreached ? "RISK_FLOOR_BREACHED" : "TTL_EXPIRED");
        }
      }
      return;
    }
    const regime = runtime.regimeEngine.classify(features);
    runtime.latestRegime = regime;
    const exitCost = runtime.cost.estimate(features, book, -1, position.qty, false);
    // Fees, current spread, and exit impact are unavoidable exit costs, not
    // incremental costs of holding for one more decision interval.
    const expectedIncrementalDelayCostBps = exitCost ? incrementalHoldCostBps(exitCost) : Number.POSITIVE_INFINITY;
    const remainingEconomicHorizonMs = position.selectedHorizonMs === undefined ? runtime.config.deterministicHold.holdHorizonMs
      : Math.max(1, position.selectedHorizonMs - (this.now() - position.openedMs));
    const hold = runtime.holdEngine.evaluate(position.side, features, expectedIncrementalDelayCostBps, remainingEconomicHorizonMs);
    const executableExit = book.bids[0]!.px;
    const nowMs = this.now();
    const decision = runtime.positionManager.update(position, executableExit, nowMs, features, hold.holdLowerBoundBps, hold.reversalScore, Math.max(0, -hold.holdLowerBoundBps));
    this.emit("positionDecision", { configurationVersion: runtime.config.configurationVersion, position: { ...position }, decision, hold, regime });
    if (decision.action === "EXIT") void this.submitExit(runtime, position.qty, decision.reason, book, features);
    else if (hold.exitEvidence && nowMs - position.openedMs >= runtime.config.position.minimumHoldMs) {
      void this.submitExit(runtime, position.qty, "DETERMINISTIC_HOLD_EVIDENCE", book, features);
    }
    else if (decision.action === "REDUCE") void this.submitExit(runtime, position.qty * decision.fraction, decision.reason, book, features);
  }

  private async submitExit(runtime: SymbolRuntime, desiredQty: number, reason: string, book: ReturnType<LocalOrderBook["snapshot"]>, features: Features,
    forcedStyle?: "maker" | "taker", fallbackFromClientOrderId?: string): Promise<void> {
    if (!runtime.asset || !runtime.position) return;
    if (this.pendingForSymbol(runtime.position.symbol)) return;
    const qty = Math.min(runtime.position.qty, Math.floor(desiredQty / runtime.asset.minTradeIncrement + 1e-12) * runtime.asset.minTradeIncrement);
    if (qty < runtime.asset.minOrderSize) return;
    const makerEligible = runtime.position.executionPath === "MAKER_MAKER_TAKER_FALLBACK" && makerExitEligible(reason);
    const style = forcedStyle ?? (makerEligible ? "maker" : "taker");
    const sweep = style === "taker" ? estimateSweep(book.bids, qty) : null;
    const cost = runtime.cost.estimate(features, book, -1, qty, style === "maker");
    if ((style === "taker" && !sweep) || !cost) { this.riskState.halt("BOOK_INVALID"); return; }
    const risk: RiskApproval = { qty, riskBudget: 0, maximumLossPerUnit: 0, modeledMaximumLoss: 0, drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit: "exposure" };
    const nowMs = this.now();
    const plan: ExecutionPlan = {
      clientOrderId: `mlce-exit-${nowMs}-${randomUUID().slice(0, 8)}`, decisionId: randomUUID(), riskApprovalId: randomUUID(),
      symbol: runtime.position.symbol, side: -1, qty,
      limitPx: style === "maker" ? ceilPrice(book.asks[0]!.px, runtime.asset.priceIncrement)
        : bufferedTakerLimitPrice(sweep!.worstPx, runtime.asset.priceIncrement, -1, runtime.config.planner.takerLimitBufferBps),
      style, timeInForce: style === "maker" ? "gtc" : "ioc",
      createdMs: nowMs, expiresMs: nowMs + (style === "maker" ? runtime.config.position.makerExitTtlMs : 1_000), originatingSequence: book.sequence,
      featureHash: createHash("sha256").update(JSON.stringify(features)).digest("hex").slice(0, 24), strategyVersion: runtime.config.strategyVersion,
      modelVersion: runtime.config.modelVersion, expectedCost: cost, risk,
      fillProbability: style === "maker" ? runtime.cost.makerExitFillProbability() : 1,
      expectedValue: -qty * features.mid * cost.roundTripBps / 10_000, reduceOnlyIntent: true,
      exitReason: reason,
      ...(runtime.position.executionPath === undefined ? {} : { executionPath: runtime.position.executionPath }),
      ...(fallbackFromClientOrderId === undefined ? {} : { fallbackFromClientOrderId }),
    };
    this.emit("exitDecision", { reason, plan });
    await this.submit(plan);
  }

  private async fallbackMakerExit(runtime: SymbolRuntime, tracked: TrackedOrder, trigger: string): Promise<void> {
    const clientOrderId = tracked.plan.clientOrderId;
    if (this.makerExitFallbackInFlight.has(clientOrderId)) return;
    this.makerExitFallbackInFlight.add(clientOrderId);
    try {
      await this.cancelTracked(tracked, "MAKER_EXIT_FALLBACK", {
        trigger, expiresMs: tracked.plan.expiresMs,
        requestedQty: tracked.plan.qty, filledQty: tracked.filledQty,
      });
      const reconciled = this.orderState.get(clientOrderId);
      if (reconciled && ["RESERVED", "SENDING", "OPEN", "PARTIALLY_FILLED", "CANCEL_PENDING", "UNKNOWN"].includes(reconciled.status)) return;
      const position = runtime.position;
      const features = runtime.latestFeatures;
      const book = runtime.book.snapshot();
      if (!position || !features || features.stale || !book.valid) return;
      const remainingPlannedQty = Math.max(0, tracked.plan.qty - (reconciled?.filledQty ?? tracked.filledQty));
      await this.submitExit(runtime, Math.min(position.qty, remainingPlannedQty), "MAKER_EXIT_TAKER_FALLBACK", book, features, "taker", clientOrderId);
    } finally {
      this.makerExitFallbackInFlight.delete(clientOrderId);
    }
  }

  private applyFill(fill: FillDelta): void {
    const runtime = this.runtimes.get(fill.symbol);
    if (!runtime) return;
    const tracked = this.orderState.get(fill.clientOrderId);
    runtime.entryAudit.pass(fill.final ? "FULL_FILL" : "PARTIAL_FILL");
    if (fill.side === 1) {
      if (!runtime.position) {
        const positionQty = fill.positionQty !== undefined && fill.positionQty > 0 ? fill.positionQty : fill.qty;
        const initialRiskPx = tracked?.plan.risk.maximumLossPerUnit || Math.max(fill.price * .005, runtime.asset?.priceIncrement ?? 0);
        runtime.position = { symbol: fill.symbol, side: 1, qty: positionQty, entryPx: fill.price, openedMs: fill.final ? this.now() : (tracked?.plan.createdMs ?? this.now()),
          initialRiskPx, roundTripCostPx: fill.price * (tracked?.plan.expectedCost.roundTripBps ?? 0) / 10_000,
          mfePx: 0, maePx: 0, floorPx: -initialRiskPx, breakEvenArmed: false, phase: "OPEN",
          ...(tracked?.plan.economicHorizonMs === undefined ? {} : { selectedHorizonMs: tracked.plan.economicHorizonMs }),
          ...(tracked?.plan.executionPath === undefined ? {} : { executionPath: tracked.plan.executionPath }) };
      } else if (tracked && runtime.position.symbol === tracked.plan.symbol) {
        const previous = runtime.position.qty;
        const total = fill.positionQty !== undefined && fill.positionQty >= previous ? fill.positionQty : previous + fill.qty;
        const added = Math.max(0, total - previous);
        if (added > 0) runtime.position.entryPx = (runtime.position.entryPx * previous + fill.price * added) / total;
        runtime.position.qty = total;
      } else throw new Error("NO_AVERAGING_DOWN_INVARIANT");
    } else if (runtime.position) {
      const remainingQty = fill.positionQty !== undefined ? Math.max(0, fill.positionQty) : Math.max(0, runtime.position.qty - fill.qty);
      const closeQty = Math.max(0, runtime.position.qty - remainingQty);
      this.realizedSessionPnl += closeQty * (fill.price - runtime.position.entryPx);
      runtime.position.qty = remainingQty;
      const minimumTradableQty = runtime.asset?.minOrderSize ?? runtime.asset?.minTradeIncrement ?? 1e-12;
      if (runtime.position.qty < minimumTradableQty) {
        if (runtime.position.qty > 0) this.reportPositionDust(fill.symbol, runtime.position.qty);
        else this.reportedPositionDust.delete(fill.symbol);
        delete runtime.position;
      }
    }
    this.recomputePortfolioRisk();
    this.riskState.setHealth({ riskRecomputed: true });
    this.emit("fill", fill);
  }

  private reconcilePositions(positions: readonly AlpacaPosition[]): void {
    const observedDustSymbols = new Set<string>();
    for (const runtime of this.runtimes.values()) delete runtime.position;
    for (const remote of positions) {
      const runtime = this.runtimes.get(normalizeSymbol(remote.symbol));
      const qty = Number(remote.qty), entryPx = Number(remote.avg_entry_price);
      if (!runtime || !(qty > 0) || !(entryPx > 0) || remote.side !== "long") continue;
      if (runtime.asset && qty < runtime.asset.minOrderSize) {
        observedDustSymbols.add(runtime.book.symbol);
        this.reportPositionDust(runtime.book.symbol, qty);
        continue;
      }
      this.reportedPositionDust.delete(runtime.book.symbol);
      const risk = Math.max(entryPx * .01, runtime.asset?.priceIncrement ?? 0);
      runtime.position = { symbol: runtime.book.symbol, side: 1, qty, entryPx, openedMs: this.now(), initialRiskPx: risk, roundTripCostPx: 0,
        mfePx: 0, maePx: 0, floorPx: -risk, breakEvenArmed: false, phase: "OPEN" };
    }
    for (const symbol of this.reportedPositionDust.keys()) {
      if (!observedDustSymbols.has(symbol)) this.reportedPositionDust.delete(symbol);
    }
  }

  private reportPositionDust(symbol: string, qty: number): void {
    if (this.reportedPositionDust.get(symbol) === qty) return;
    this.reportedPositionDust.set(symbol, qty);
    this.emit("positionDust", { symbol, qty, reason: "BELOW_MINIMUM_ORDER_SIZE" });
  }

  private recomputePortfolioRisk(): void {
    for (const [symbol, runtime] of this.runtimes) {
      const position = runtime.position;
      if (!position) this.portfolio.updateExposure({ symbol, notional: 0, cluster: runtime.cluster, stressedLoss: 0 });
      else this.portfolio.updateExposure({ symbol, notional: position.qty * position.entryPx, cluster: runtime.cluster,
        stressedLoss: position.qty * (position.initialRiskPx + position.roundTripCostPx) });
    }
    this.riskState.updateLosses(Math.max(0, -this.realizedSessionPnl), Math.max(0, -this.realizedSessionPnl), this.portfolio.stressedOpenLoss());
  }

  private pendingForSymbol(symbol: string): ReturnType<OrderStateReconciler["all"]>[number] | undefined {
    return this.orderState.all().find((order) => order.plan.symbol === symbol && ["RESERVED", "SENDING", "OPEN", "PARTIALLY_FILLED", "CANCEL_PENDING", "UNKNOWN"].includes(order.status));
  }
  private async cancelTracked(tracked: TrackedOrder, reason: OrderCancelRequestReason, details: Record<string, unknown> = {}): Promise<void> {
    if (!tracked.alpacaOrderId) return;
    if (tracked.status === "CANCEL_PENDING") {
      await this.reconcilePendingCancellation(tracked);
      return;
    }
    const requestedAtMs = this.now();
    this.orderState.requestCancel(tracked.plan.clientOrderId, reason, requestedAtMs);
    this.emit("orderCancelRequested", {
      symbol: tracked.plan.symbol,
      clientOrderId: tracked.plan.clientOrderId,
      alpacaOrderId: tracked.alpacaOrderId,
      reason,
      requestedAtMs,
      filledQty: tracked.filledQty,
      requestedQty: tracked.plan.qty,
      details,
    });
    try {
      await this.gateway.cancel(tracked.alpacaOrderId);
      await this.reconcilePendingCancellation(tracked, true);
    } catch (error) {
      this.riskState.halt("ORDER_SEND_UNKNOWN");
      this.emit("engineError", error);
      await this.reconcileAccount();
    }
  }
  private async reconcilePendingCancellation(tracked: ReturnType<OrderStateReconciler["all"]>[number], force = false): Promise<void> {
    const clientOrderId = tracked.plan.clientOrderId;
    const orderId = tracked.alpacaOrderId;
    if (!orderId || this.cancelReconcileInFlight.has(clientOrderId)) return;
    const nowMs = this.now();
    const lastAttemptMs = this.cancelReconcileLastAttemptMs.get(clientOrderId) ?? tracked.lastUpdateMs;
    if (!force && nowMs - lastAttemptMs < CANCEL_PENDING_RECONCILE_DELAY_MS) return;
    this.cancelReconcileLastAttemptMs.set(clientOrderId, nowMs);
    this.cancelReconcileInFlight.add(clientOrderId);
    try {
      const previousFilledQty = tracked.filledQty;
      const response = await this.rest.getOrder(orderId);
      const remote = response.data;
      const remoteFilledQty = Number(remote.filled_qty ?? 0);
      const remoteAverageFillPx = Number(remote.filled_avg_price ?? 0);
      const parsedUpdatedMs = Date.parse(remote.updated_at);
      const reconciled = this.orderState.reconcileOrder({
        id: remote.id,
        clientOrderId: remote.client_order_id,
        filledQty: remoteFilledQty,
        ...(remoteAverageFillPx > 0 ? { averageFillPx: remoteAverageFillPx } : {}),
        status: remote.status,
        updatedMs: Number.isFinite(parsedUpdatedMs) ? parsedUpdatedMs : nowMs,
      });
      if (reconciled) {
        const event: PrivateOrderEvent = {
          id: `rest-reconcile-${remote.id}-${remote.updated_at}`,
          event: `rest_reconcile_${remote.status}`,
          orderId: remote.id,
          clientOrderId: remote.client_order_id,
          symbol: normalizeSymbol(remote.symbol),
          filledQty: remoteFilledQty,
          eventQty: 0,
          eventPx: remoteAverageFillPx,
          timestampMs: Number.isFinite(parsedUpdatedMs) ? parsedUpdatedMs : nowMs,
        };
        this.emit("orderUpdate", { event, order: reconciled, source: "rest-cancel-reconciliation" });
        if (!["RESERVED", "SENDING", "OPEN", "PARTIALLY_FILLED", "CANCEL_PENDING", "UNKNOWN"].includes(reconciled.status)) {
          this.cancelReconcileLastAttemptMs.delete(clientOrderId);
          const runtime = this.runtimes.get(reconciled.plan.symbol);
          if (runtime?.pendingEntryIntent?.decisionId === reconciled.plan.decisionId) delete runtime.pendingEntryIntent;
        }
      }
      // A missed fill changes authoritative exposure and must use the full
      // account reconciliation path rather than inferring fee-adjusted quantity.
      if (remoteFilledQty > previousFilledQty + 1e-12) await this.reconcileAccount();
    } catch (error) {
      this.emit("engineError", error);
      await this.reconcileAccount();
    } finally {
      this.cancelReconcileInFlight.delete(clientOrderId);
    }
  }
  private async cancelAllSafely(reason: OrderCancelRequestReason): Promise<void> {
    if (this.cfg.mode !== "paper" && this.cfg.mode !== "live") return;
    const requestedAtMs = this.now();
    for (const tracked of this.orderState.all()) {
      if (!["RESERVED", "SENDING", "OPEN", "PARTIALLY_FILLED", "CANCEL_PENDING", "UNKNOWN"].includes(tracked.status)) continue;
      const firstRequest = tracked.cancelRequestReason === undefined;
      this.orderState.requestCancel(tracked.plan.clientOrderId, reason, requestedAtMs);
      if (firstRequest) this.emit("orderCancelRequested", {
        symbol: tracked.plan.symbol,
        clientOrderId: tracked.plan.clientOrderId,
        alpacaOrderId: tracked.alpacaOrderId ?? null,
        reason,
        requestedAtMs,
        filledQty: tracked.filledQty,
        requestedQty: tracked.plan.qty,
        details: { scope: "all-open-orders" },
      });
    }
    try { await this.gateway.cancelAll(); } catch (error) { this.emit("engineError", error); }
  }
  private onPublicDisconnect(): void {
    this.recorder?.write({ kind: "DISCONNECT", receiveTsMs: this.now(), stream: "public" });
    this.riskState.setHealth({ publicStream: false, bookValid: false });
    this.riskState.halt("PUBLIC_STREAM_DOWN");
    for (const runtime of this.runtimes.values()) runtime.book.invalidate();
    void this.cancelAllSafely("PUBLIC_STREAM_DOWN");
  }

  private onWatchdogFault(fault: WatchdogFault): void {
    if (fault === "PUBLIC_SILENCE") {
      if (this.riskState.snapshot().health.publicStream) {
        this.onPublicDisconnect();
        this.marketStream.reconnectNow();
      }
    }
    else if (fault === "PRIVATE_SILENCE" && this.cfg.mode !== "record") {
      this.riskState.setHealth({ privateStream: false });
      this.riskState.halt("PRIVATE_STREAM_DOWN");
      void this.cancelAllSafely("PRIVATE_STREAM_DOWN");
    } else if (fault === "PROCESS_STALL") {
      this.riskState.halt("PROCESS_STALL");
      void this.cancelAllSafely("PROCESS_STALL");
    }
    this.emit("watchdogFault", fault);
  }
}

function assetRules(asset: AlpacaAsset): AssetRules {
  const minTradeIncrement = Number(asset.min_trade_increment ?? "0");
  const priceIncrement = Number(asset.price_increment ?? "0");
  const minOrderSize = Number(asset.min_order_size ?? asset.min_trade_increment ?? "0");
  if (!asset.tradable || !(minTradeIncrement > 0) || !(priceIncrement > 0) || !(minOrderSize > 0)) throw new Error(`Invalid Alpaca asset rules for ${asset.symbol}`);
  return { symbol: asset.symbol, minOrderSize, minTradeIncrement, priceIncrement, maximumOrderQty: Number.MAX_SAFE_INTEGER * minTradeIncrement, shortable: asset.shortable };
}
function baseAsset(symbol: string): string { return symbol.split("/")[0] ?? symbol; }
function normalizeSymbol(symbol: string): string { return symbol.includes("/") ? symbol : symbol.replace(/(USD|USDT|USDC|BTC)$/, "/$1"); }
function cfgPriceSigma(features: Features, multiple: number): number { return features.mid * features.sigmaHBps / 10_000 * multiple; }
function ceilQuantity(quantity: number, increment: number): number { return Math.ceil(quantity / increment - 1e-12) * increment; }
function ceilPrice(price: number, increment: number): number { return Math.ceil(price / increment - 1e-12) * increment; }
function makerExitEligible(reason: string): boolean {
  return ["TIME_STOP", "EVIDENCE_EXIT", "DETERMINISTIC_HOLD_EVIDENCE", "REVERSAL_RISK"].includes(reason);
}
function plannerIntent(intent: DeterministicTradeIntent, sizeMultiplier: number): TradeIntent {
  return {
    side: intent.side, probability: 1, predictedGrossBps: intent.grossOpportunityBps,
    lowerBoundNetBps: intent.lowerBoundNetBps, quality: Math.max(0, Math.min(1, intent.quality * sizeMultiplier)),
    decisionTsMs: intent.createdMs,
  };
}
function assetRulesVersion(asset: AssetRules): string {
  return createHash("sha256").update(JSON.stringify(asset)).digest("hex").slice(0, 16);
}
function cloneEvaluation(value: DeterministicEvaluation): DeterministicEvaluation {
  const cloneDiagnostics = (diagnostics: DeterministicEvaluation["long"]): DeterministicEvaluation["long"] => ({
    ...diagnostics, reasons: [...diagnostics.reasons], liquidityReasons: [...diagnostics.liquidityReasons],
    ...(diagnostics.costBreakdown === undefined ? {} : { costBreakdown: { ...diagnostics.costBreakdown } }),
    votes: { ...diagnostics.votes, vector: { ...diagnostics.votes.vector } },
  });
  return {
    long: cloneDiagnostics(value.long), short: cloneDiagnostics(value.short),
    candidate: value.candidate ? { ...value.candidate, diagnostics: cloneDiagnostics(value.candidate.diagnostics) } : null,
    intent: value.intent ? { ...value.intent, diagnostics: cloneDiagnostics(value.intent.diagnostics) } : null,
  };
}
function cloneLiquidity(value: { long: LiquidityDecision; short: LiquidityDecision }): { long: LiquidityDecision; short: LiquidityDecision } {
  return {
    long: { ...value.long, reasons: [...value.long.reasons] },
    short: { ...value.short, reasons: [...value.short.reasons] },
  };
}
function liquidityInput(features: DeterministicFeatures, impactBps: number) {
  return {
    spreadBps: features.spreadBps, spreadZ: features.spreadZ, depthZ: features.depthZ,
    impactBps, providerAgeMs: features.providerAgeMs,
    stale: features.stale,
  };
}
function featureNumbersAreFinite(features: DeterministicFeatures): boolean {
  return nestedNumbersAreFinite(features);
}
function nestedNumbersAreFinite(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return true;
  return Object.values(value as Record<string, unknown>).every(nestedNumbersAreFinite);
}
function rollingLossFromPortfolioHistory(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const equity = (value as { equity?: unknown }).equity;
  if (!Array.isArray(equity)) return 0;
  const values = equity.map(Number).filter(Number.isFinite);
  if (values.length < 2) return 0;
  return Math.max(0, values[0]! - values.at(-1)!);
}
