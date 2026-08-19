import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { EngineConfig, SymbolConfig } from "../config.js";
import { FeatureEngine } from "../core/features.js";
import { LatencyTracker } from "../core/latency.js";
import type { BookState, Features, MarketTrade } from "../core/market.js";
import { LocalOrderBook, type BookDelta } from "../core/order-book.js";
import { EventRecorder } from "../recorder.js";
import { ExecutionPlanner, type AssetRules, type ExecutionPlan } from "../execution/planner.js";
import { OrderStateReconciler, type FillDelta, type PrivateOrderEvent } from "../execution/order-state.js";
import { estimateSweep } from "../execution/book-walk.js";
import { PortfolioRiskEngine } from "../risk/portfolio.js";
import { RiskState } from "../risk/risk-state.js";
import { RiskSizer, type RiskApproval } from "../risk/sizing.js";
import { CostModel } from "../strategy/cost.js";
import { ForecastEngine } from "../strategy/forecast.js";
import { PositionManager, type Position } from "../strategy/position-manager.js";
import type { TradeIntent } from "../strategy/signal.js";
import { BookPressureTracker, DeterministicFeatureExtensions, type DeterministicFeatures } from "../strategy/deterministic-features.js";
import { DeterministicRegimeEngine, type RegimeDecision } from "../strategy/deterministic-regime.js";
import { DeterministicEntryEngine, type DeterministicEvaluation, type DeterministicTradeIntent, type SystemGateState } from "../strategy/deterministic-entry.js";
import { DeterministicHoldEngine } from "../strategy/deterministic-hold.js";
import { SignalRouter, type OptionalSignalModel } from "../strategy/signal-router.js";
import { AlpacaOrderGateway, type OrderGateway } from "../alpaca/gateway.js";
import { AlpacaMarketStream } from "../alpaca/market-stream.js";
import { AlpacaApiError, AlpacaRestClient } from "../alpaca/rest.js";
import { AlpacaTradeStream } from "../alpaca/trade-stream.js";
import type { AlpacaAsset, AlpacaOrder, AlpacaPosition } from "../alpaca/types.js";
import { HealthWatchdog, type WatchdogFault } from "./watchdog.js";

export interface EngineMarketSnapshot {
  symbol: string;
  bookValid: boolean;
  bestBid: number | null;
  bestAsk: number | null;
  sequence: string;
  exchangeTsMs: number;
  receiveTsMs: number;
  features: Features | null;
  regime?: RegimeDecision | null;
  ruleEvaluation?: DeterministicEvaluation | null;
}

export interface EngineOperationalSnapshot {
  generatedAtMs: number;
  started: boolean;
  startedAtMs: number | null;
  uptimeMs: number;
  mode: EngineConfig["mode"];
  paper: boolean;
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
  signalRouter: SignalRouter;
  holdEngine: DeterministicHoldEngine;
  cost: CostModel;
  planner: ExecutionPlanner;
  positionManager: PositionManager;
  asset?: AssetRules;
  latestFeatures?: DeterministicFeatures;
  latestRegime?: RegimeDecision;
  latestRuleEvaluation?: DeterministicEvaluation;
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

  public async stop(): Promise<void> {
    this.marketStream.close();
    this.tradeStream.close();
    this.watchdog.stop();
    if (this.recorder) await this.recorder.close();
    this.started = false;
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
      };
    });
    return {
      generatedAtMs,
      started: this.started,
      startedAtMs: this.startedAtMs,
      uptimeMs: this.startedAtMs === null ? 0 : Math.max(0, generatedAtMs - this.startedAtMs),
      mode: this.cfg.mode,
      paper: this.cfg.paper,
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
        const modelLowerBoundBps = forecast.grossAtArrivalBps - forecast.residualQ95Bps
          - cfg.signal.costSafetyFactor * intent.diagnostics.roundTripCostBps;
        const accept = !forecast.expired && forecast.side === intent.side
          && forecast.probability >= cfg.signal.minimumDirectionProbability
          && modelLowerBoundBps >= cfg.signal.minimumNetEdgeBps;
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
    this.tradeStream.on("disconnect", () => { this.riskState.setHealth({ privateStream: false }); this.riskState.halt("PRIVATE_STREAM_DOWN"); void this.cancelAllSafely(); });
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
      void this.cancelAllSafely();
      return;
    }
    const baseFeatures = runtime.features.onBook(result.state, result.flow);
    if (!baseFeatures) return;
    const features = runtime.deterministicFeatures.update(baseFeatures, runtime.pressure.update(result.state));
    this.processMarketState(runtime, result.state, features);
  }

  private processMarketState(runtime: SymbolRuntime, book: BookState, features: DeterministicFeatures): void {
    runtime.latestFeatures = features;
    const allBooksStructurallyValid = [...this.runtimes.values()].every((item) => item.book.isValid());
    const staleExposure = [...this.runtimes.values()].some((item) =>
      Boolean(item.position || this.pendingForSymbol(item.book.symbol)) && item.latestFeatures?.stale !== false);
    this.riskState.setHealth({ bookValid: allBooksStructurallyValid && !staleExposure });
    if (features.stale) {
      const pending = this.pendingForSymbol(book.symbol);
      if (pending) void this.cancelTracked(pending);
      // An idle symbol may go stale without disabling unrelated symbols. Existing exposure still fails closed globally.
      if (runtime.position || pending) {
        this.riskState.halt("BOOK_INVALID");
      }
      return;
    }
    this.riskState.setHealth({ riskRecomputed: true });
    this.riskState.resumeAfterReconciliation();
    if (this.cfg.mode === "record") return;

    // Priority: existing exposure -> pending order cancellation -> new entry.
    if (runtime.position && runtime.position.qty > 0) { this.managePosition(runtime, book, features); return; }
    const pending = this.pendingForSymbol(book.symbol);
    if (pending) { this.reevaluatePending(runtime, pending, book, features); return; }
    const expectedLatencyMs = Math.max(1, this.latency.p95Total(this.now()) || 250);
    let regime = runtime.regimeEngine.classify(features);
    if (!runtime.asset?.shortable && regime.allowShort) regime = { ...regime, allowShort: false };
    runtime.latestRegime = regime;
    if (!runtime.asset) return;
    const smallQty = runtime.asset?.minOrderSize ?? 0;
    const longCost = runtime.planner.preliminaryCost(features, book, 1, smallQty);
    const shortCost = runtime.planner.preliminaryCost(features, book, -1, smallQty);
    if (!longCost || !shortCost) return;
    const deterministicIntent = runtime.entryEngine.evaluate({
      symbol: book.symbol, sequence: book.sequence, nowMs: features.receiveTsMs, features, regime,
      system: this.systemGates(runtime), bestBid: book.bids[0]!.px, bestAsk: book.asks[0]!.px,
      expectedLatencyMs, longCost, shortCost,
    });
    const evaluation = runtime.entryEngine.latestEvaluation();
    if (evaluation) runtime.latestRuleEvaluation = evaluation;
    this.emit("ruleEvaluation", {
      configurationVersion: runtime.config.configurationVersion, strategyVersion: runtime.config.strategyVersion,
      symbolRulesetVersion: assetRulesVersion(runtime.asset), features, regime, evaluation: runtime.latestRuleEvaluation,
    });
    const routed = runtime.signalRouter.route(deterministicIntent, features);
    if (!routed || routed.sizeMultiplier <= 0) return;
    const intent = plannerIntent(routed.intent, 1);
    const initialStopDistance = Math.max(
      cfgPriceSigma(features, runtime.config.initialStopSigma),
      runtime.config.minimumStopSpreadMultiple * features.spread,
      runtime.asset.priceIncrement,
    );
    const plan = runtime.planner.build(intent, features, book, runtime.asset, {
      equity: this.equity, equityHighWater: this.equityHighWater, initialStopDistance,
      jumpBuffer: cfgPriceSigma(features, runtime.config.jumpSigma), maximumNotional: runtime.config.maximumNotional,
      lotSize: runtime.asset.minTradeIncrement, regimeScale: regime.riskScale,
      exposureCapacityQty: runtime.config.maximumNotional / features.mid,
    }, false, {
      createdMs: features.receiveTsMs, decisionId: routed.intent.decisionId,
      quantityMultiplier: routed.sizeMultiplier,
      revalidateCost: (exactCost) => {
        const exact = runtime.entryEngine.revalidateExactCost(routed.intent, exactCost);
        return exact ? plannerIntent(exact, 1) : null;
      },
    });
    if (!plan) return;
    const candidate = { symbol: plan.symbol, notional: plan.qty * features.mid * plan.side, cluster: runtime.cluster, stressedLoss: plan.risk.modeledMaximumLoss };
    if (!this.portfolio.canAdd(candidate, this.equity, Math.max(0, -this.realizedSessionPnl))) return;
    this.emit("decision", {
      configurationVersion: runtime.config.configurationVersion, strategyVersion: runtime.config.strategyVersion,
      adapterVersion: "alpaca-v1", symbolRulesetVersion: assetRulesVersion(runtime.asset),
      regime, deterministicIntent: routed.intent, routing: routed, features, plan, mode: this.cfg.mode,
    });
    if (this.cfg.mode === "shadow") runtime.entryEngine.markFired(plan.side, this.now());
    else void this.submit(plan);
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
    if (fill) this.applyFill(fill);
    if (["rejected", "order_replace_rejected", "order_cancel_rejected"].includes(event.event)) this.emit("orderRejected", event);
  }

  private async submit(plan: ExecutionPlan): Promise<void> {
    if (this.cfg.mode === "shadow") return;
    if (this.cfg.mode !== "paper" && this.cfg.mode !== "live") return;
    try {
      this.orderState.reserve(plan);
      if (!plan.reduceOnlyIntent) this.runtimes.get(plan.symbol)?.entryEngine.markFired(plan.side, this.now());
      this.orderState.markSending(plan.clientOrderId);
      const sentMs = this.now();
      const order = await this.gateway.send(plan);
      const acknowledgedMs = this.now();
      this.orderState.markAccepted(plan.clientOrderId, order.id, acknowledgedMs);
      this.latency.record({ localReceiptMs: plan.createdMs, decisionCompleteMs: plan.createdMs, sentMs, acknowledgedMs }, acknowledgedMs);
      this.emit("orderAccepted", { order, plan });
    } catch (error) {
      if (error instanceof AlpacaApiError && error.status >= 400) {
        this.orderState.apply({ id: randomUUID(), event: "rejected", orderId: "", clientOrderId: plan.clientOrderId, symbol: plan.symbol, filledQty: 0, eventQty: 0, eventPx: 0, timestampMs: this.now() });
      } else {
        this.orderState.markSendUnknown(plan.clientOrderId, error);
        this.riskState.halt("ORDER_SEND_UNKNOWN");
        await this.reconcileAccount();
      }
      this.emit("engineError", error);
    }
  }

  private reevaluatePending(runtime: SymbolRuntime, pending: ReturnType<OrderStateReconciler["all"]>[number], book: ReturnType<LocalOrderBook["snapshot"]>, features: DeterministicFeatures): void {
    if (pending.status === "UNKNOWN") { this.riskState.halt("ORDER_SEND_UNKNOWN"); return; }
    const cost = runtime.cost.estimate(features, book, pending.plan.side, Math.max(pending.plan.qty - pending.filledQty, 0), pending.plan.style === "maker");
    let regime = runtime.regimeEngine.classify(features);
    if (!runtime.asset?.shortable && regime.allowShort) regime = { ...regime, allowShort: false };
    runtime.latestRegime = regime;
    const stillValid = runtime.entryEngine.signalStillValid(pending.plan.side, features, regime);
    const sourceIntent = runtime.latestRuleEvaluation?.intent;
    const exactCostValid = cost !== null && sourceIntent?.side === pending.plan.side
      && runtime.entryEngine.revalidateExactCost(sourceIntent, cost) !== null;
    const adverse = pending.plan.side * features.tfi < -.5 || pending.plan.side * features.ofi < -2;
    if (this.now() >= pending.plan.expiresMs || !stillValid || !exactCostValid || adverse || features.stale) void this.cancelTracked(pending);
  }

  private managePosition(runtime: SymbolRuntime, book: ReturnType<LocalOrderBook["snapshot"]>, features: DeterministicFeatures): void {
    const position = runtime.position!;
    const pending = this.pendingForSymbol(position.symbol);
    if (pending && pending.plan.side === 1) { void this.cancelTracked(pending); return; }
    let regime = runtime.regimeEngine.classify(features);
    if (!runtime.asset?.shortable && regime.allowShort) regime = { ...regime, allowShort: false };
    runtime.latestRegime = regime;
    const exitCost = runtime.cost.estimate(features, book, -1, position.qty, false);
    const expectedDelayAndExitCostBps = exitCost ? exitCost.spreadBps / 2 + exitCost.feeBps / 2 + exitCost.impactBps
      + exitCost.latencyBps + exitCost.adverseSelectionBps + exitCost.fundingBps + exitCost.borrowBps : Number.POSITIVE_INFINITY;
    const hold = runtime.holdEngine.evaluate(position.side, features, expectedDelayAndExitCostBps);
    const executableExit = book.bids[0]!.px;
    const decision = runtime.positionManager.update(position, executableExit, this.now(), features, hold.holdLowerBoundBps, hold.reversalScore, Math.max(0, -hold.holdLowerBoundBps));
    this.emit("positionDecision", { configurationVersion: runtime.config.configurationVersion, position: { ...position }, decision, hold, regime });
    if (hold.exitEvidence) void this.submitExit(runtime, position.qty, "DETERMINISTIC_HOLD_EVIDENCE", book, features);
    else if (decision.action === "EXIT") void this.submitExit(runtime, position.qty, decision.reason, book, features);
    else if (decision.action === "REDUCE") void this.submitExit(runtime, position.qty * decision.fraction, decision.reason, book, features);
  }

  private async submitExit(runtime: SymbolRuntime, desiredQty: number, reason: string, book: ReturnType<LocalOrderBook["snapshot"]>, features: Features): Promise<void> {
    if (!runtime.asset || !runtime.position) return;
    const qty = Math.min(runtime.position.qty, Math.floor(desiredQty / runtime.asset.minTradeIncrement + 1e-12) * runtime.asset.minTradeIncrement);
    if (qty < runtime.asset.minOrderSize) return;
    const sweep = estimateSweep(book.bids, qty);
    const cost = runtime.cost.estimate(features, book, -1, qty, false);
    if (!sweep || !cost) { this.riskState.halt("BOOK_INVALID"); return; }
    const risk: RiskApproval = { qty, riskBudget: 0, maximumLossPerUnit: 0, modeledMaximumLoss: 0, drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit: "exposure" };
    const nowMs = this.now();
    const plan: ExecutionPlan = {
      clientOrderId: `mlce-exit-${nowMs}-${randomUUID().slice(0, 8)}`, decisionId: randomUUID(), riskApprovalId: randomUUID(),
      symbol: runtime.position.symbol, side: -1, qty, limitPx: floorPrice(sweep.worstPx, runtime.asset.priceIncrement), style: "taker", timeInForce: "ioc",
      createdMs: nowMs, expiresMs: nowMs + 1_000, originatingSequence: book.sequence,
      featureHash: createHash("sha256").update(JSON.stringify(features)).digest("hex").slice(0, 24), strategyVersion: runtime.config.strategyVersion,
      modelVersion: runtime.config.modelVersion, expectedCost: cost, risk, fillProbability: 1,
      expectedValue: -qty * features.mid * cost.roundTripBps / 10_000, reduceOnlyIntent: true,
    };
    this.emit("exitDecision", { reason, plan });
    await this.submit(plan);
  }

  private applyFill(fill: FillDelta): void {
    const runtime = this.runtimes.get(fill.symbol);
    if (!runtime) return;
    const tracked = this.orderState.get(fill.clientOrderId);
    if (fill.side === 1) {
      if (!runtime.position) {
        const initialRiskPx = tracked?.plan.risk.maximumLossPerUnit || Math.max(fill.price * .005, runtime.asset?.priceIncrement ?? 0);
        runtime.position = { symbol: fill.symbol, side: 1, qty: fill.qty, entryPx: fill.price, openedMs: fill.final ? this.now() : (tracked?.plan.createdMs ?? this.now()),
          initialRiskPx, roundTripCostPx: fill.price * (tracked?.plan.expectedCost.roundTripBps ?? 0) / 10_000,
          mfePx: 0, maePx: 0, floorPx: -initialRiskPx, breakEvenArmed: false, phase: "OPEN" };
      } else if (tracked && runtime.position.symbol === tracked.plan.symbol) {
        const total = runtime.position.qty + fill.qty;
        runtime.position.entryPx = (runtime.position.entryPx * runtime.position.qty + fill.price * fill.qty) / total;
        runtime.position.qty = total;
      } else throw new Error("NO_AVERAGING_DOWN_INVARIANT");
    } else if (runtime.position) {
      const closeQty = Math.min(fill.qty, runtime.position.qty);
      this.realizedSessionPnl += closeQty * (fill.price - runtime.position.entryPx);
      runtime.position.qty -= closeQty;
      if (runtime.position.qty <= (runtime.asset?.minTradeIncrement ?? 1e-12) / 2) delete runtime.position;
    }
    this.recomputePortfolioRisk();
    this.riskState.setHealth({ riskRecomputed: true });
    this.emit("fill", fill);
  }

  private reconcilePositions(positions: readonly AlpacaPosition[]): void {
    for (const runtime of this.runtimes.values()) delete runtime.position;
    for (const remote of positions) {
      const runtime = this.runtimes.get(normalizeSymbol(remote.symbol));
      const qty = Number(remote.qty), entryPx = Number(remote.avg_entry_price);
      if (!runtime || !(qty > 0) || !(entryPx > 0) || remote.side !== "long") continue;
      const risk = Math.max(entryPx * .01, runtime.asset?.priceIncrement ?? 0);
      runtime.position = { symbol: runtime.book.symbol, side: 1, qty, entryPx, openedMs: this.now(), initialRiskPx: risk, roundTripCostPx: 0,
        mfePx: 0, maePx: 0, floorPx: -risk, breakEvenArmed: false, phase: "OPEN" };
    }
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
  private async cancelTracked(tracked: ReturnType<OrderStateReconciler["all"]>[number]): Promise<void> {
    if (!tracked.alpacaOrderId || tracked.status === "CANCEL_PENDING") return;
    this.orderState.requestCancel(tracked.plan.clientOrderId);
    try { await this.gateway.cancel(tracked.alpacaOrderId); } catch (error) { this.riskState.halt("ORDER_SEND_UNKNOWN"); this.emit("engineError", error); await this.reconcileAccount(); }
  }
  private async cancelAllSafely(): Promise<void> { if (this.cfg.mode === "paper" || this.cfg.mode === "live") try { await this.gateway.cancelAll(); } catch (error) { this.emit("engineError", error); } }
  private onPublicDisconnect(): void {
    this.riskState.setHealth({ publicStream: false, bookValid: false });
    this.riskState.halt("PUBLIC_STREAM_DOWN");
    for (const runtime of this.runtimes.values()) runtime.book.invalidate();
    void this.cancelAllSafely();
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
      void this.cancelAllSafely();
    } else if (fault === "PROCESS_STALL") {
      this.riskState.halt("PROCESS_STALL");
      void this.cancelAllSafely();
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
function floorPrice(price: number, increment: number): number { return Math.floor(price / increment + 1e-12) * increment; }
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
    ...diagnostics, reasons: [...diagnostics.reasons],
    votes: { ...diagnostics.votes, vector: { ...diagnostics.votes.vector } },
  });
  return {
    long: cloneDiagnostics(value.long), short: cloneDiagnostics(value.short),
    intent: value.intent ? { ...value.intent, diagnostics: cloneDiagnostics(value.intent.diagnostics) } : null,
  };
}
function rollingLossFromPortfolioHistory(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const equity = (value as { equity?: unknown }).equity;
  if (!Array.isArray(equity)) return 0;
  const values = equity.map(Number).filter(Number.isFinite);
  if (values.length < 2) return 0;
  return Math.max(0, values[0]! - values.at(-1)!);
}
