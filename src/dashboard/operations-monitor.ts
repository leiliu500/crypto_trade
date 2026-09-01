import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { EngineMarketSnapshot, EngineOperationalSnapshot, TradingEngine } from "../engine/trading-engine.js";
import type { PositionDecision } from "../strategy/position-manager.js";
import type {
  DashboardEvent, DashboardLivePosition, DashboardMarketCard, DashboardOrderCard, DashboardPnlPoint,
  DashboardOptionShort, DashboardOptionShortTrade, DashboardPositionCard, DashboardSessionPnlBreakdown, DashboardSnapshot,
  DatabaseHealth, EventSeverity,
  OptionShortPnlTelemetry, OrderTimelineEntry, TelemetryRecord,
} from "./types.js";
import { disabledDatabaseHealth } from "./types.js";

const ENGINE_EVENTS = [
  "reconciled", "engineError", "preflight", "publicStreamReady", "privateStreamReady", "decision",
  "orderReserved", "orderSending", "orderAccepted", "orderCancelRequested", "orderUpdate", "orderRejected",
  "positionDecision", "positionDust", "exitDecision", "fill", "watchdogFault", "entryBlocked", "pendingKinematicsGrace",
  "pendingSignalGrace", "pendingSignalRecovered", "pendingAdverseFlowGrace", "pendingAdverseFlowRecovered",
  "missedEntryRetryArmed", "entryRouteEvaluated", "entryRouteShadowStarted", "entryRouteShadowMark",
  "optionShortDecision", "optionShortBlocked", "optionShortOrderAccepted", "optionShortOrderCancelRequested",
  "optionShortOrderCancelUnknown", "optionShortOrderReconciled", "optionShortOrderUpdate", "optionShortOrderError",
  "optionShortReconciled", "optionShortUniverse", "optionShortStockStreamReady",
  "optionShortMarketStreamReady", "optionShortStockStreamDown", "optionShortMarketStreamDown",
] as const;
const TERMINAL_ORDER_STATES = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);
const DEFAULT_MAXIMUM_PNL_HISTORY = 2_000;

interface MonitorOptions {
  pollIntervalMs?: number;
  marketSampleMs?: number;
  healthSampleMs?: number;
  maximumEvents?: number;
  pnlSampleMs?: number;
  maximumPnlHistory?: number;
}

interface LatestPositionDecision {
  action: string;
  reason: string | null;
  holdEdgeBps: number | null;
  reversalProbability: number | null;
}

interface PositionPnlSeries {
  openedMs: number;
  points: DashboardPnlPoint[];
  lastAppendMs: number | null;
}

interface UtcSessionProjection {
  dayStartMs: number;
  startingEquity: number;
  realizedBaseline: number;
  unrealizedBaseline: number;
  equityHighWater: number;
  lastEquity: number;
}

/** Read-only projection of engine state for UI and durable telemetry. */
export class OperationsMonitor extends EventEmitter {
  private readonly pollIntervalMs: number;
  private readonly marketSampleMs: number;
  private readonly healthSampleMs: number;
  private readonly maximumEvents: number;
  private readonly pnlSampleMs: number;
  private readonly maximumPnlHistory: number;
  private readonly events: DashboardEvent[] = [];
  private readonly orderTimelines = new Map<string, OrderTimelineEntry[]>();
  private readonly orderStatuses = new Map<string, string>();
  private readonly positionDecisions = new Map<string, LatestPositionDecision>();
  private readonly positionPnlHistories = new Map<string, PositionPnlSeries>();
  private readonly observedPositions = new Map<string, DashboardPositionCard>();
  private readonly optionPnlHistories = new Map<string, PositionPnlSeries>();
  private readonly optionTrades = new Map<string, DashboardOptionShortTrade>();
  private readonly orderPositionPnl = new Map<string, DashboardLivePosition>();
  private readonly historicalOrders = new Map<string, DashboardOrderCard>();
  private readonly boundListeners = new Map<string, (...args: unknown[]) => void>();
  private engine?: TradingEngine;
  private timer?: NodeJS.Timeout;
  private lastMarketTelemetryMs = 0;
  private lastHealthTelemetryMs = 0;
  private readonly lastOrderTelemetry = new Map<string, string>();
  private readonly lastOptionOrderTelemetry = new Map<string, string>();
  private readonly lastOptionTradeTelemetry = new Map<string, string>();
  private readonly lastOptionPnlTelemetry = new Map<string, string>();
  private databaseHealth = disabledDatabaseHealth();
  private snapshotValue: DashboardSnapshot = emptySnapshot();
  private utcSession?: UtcSessionProjection;

  public constructor(options: MonitorOptions = {}) {
    super();
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.marketSampleMs = options.marketSampleMs ?? 1_000;
    this.healthSampleMs = Math.max(this.marketSampleMs, options.healthSampleMs ?? 10_000);
    this.maximumEvents = options.maximumEvents ?? 200;
    this.pnlSampleMs = Math.max(0, options.pnlSampleMs ?? 1_000);
    this.maximumPnlHistory = Math.max(1, options.maximumPnlHistory ?? DEFAULT_MAXIMUM_PNL_HISTORY);
  }

  public attach(engine: TradingEngine): void {
    if (this.engine) this.detach();
    this.engine = engine;
    for (const eventName of ENGINE_EVENTS) {
      const listener = (...args: unknown[]): void => this.recordEvent(eventName, args[0]);
      this.boundListeners.set(eventName, listener);
      engine.on(eventName, listener);
    }
    const optionMarkListener = (): void => this.poll();
    this.boundListeners.set("optionShortMark", optionMarkListener);
    engine.on("optionShortMark", optionMarkListener);
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.timer.unref();
  }

  public detach(): void {
    if (this.timer) clearInterval(this.timer);
    delete this.timer;
    if (this.engine) for (const [name, listener] of this.boundListeners) this.engine.off(name, listener);
    this.boundListeners.clear();
    delete this.engine;
  }

  public stop(): void { this.detach(); }
  public snapshot(): DashboardSnapshot { return safeClone(this.snapshotValue) as DashboardSnapshot; }

  public hydrateOrders(orders: readonly DashboardOrderCard[]): void {
    const restoredOrders: DashboardOrderCard[] = [];
    for (const order of orders) {
      const restored = safeClone({ ...order, historical: true }) as DashboardOrderCard;
      restoredOrders.push(restored);
      this.orderStatuses.set(restored.clientOrderId, `${restored.status}:${restored.cancellationReason ?? restored.cancelRequestReason ?? ""}`);
      this.orderTimelines.set(restored.clientOrderId, [...restored.timeline]);
    }
    for (const restored of this.linkExitOrderPnl(restoredOrders)) {
      this.historicalOrders.set(restored.clientOrderId, restored);
    }
    this.snapshotValue = {
      ...this.snapshotValue,
      orders: sortOrders([...this.historicalOrders.values()]),
    };
  }

  public setDatabaseHealth(health: DatabaseHealth): void {
    this.databaseHealth = { ...health };
  }

  /** Allows replay/demo sources to drive the exact same operational UI. */
  public ingestEngineSnapshot(state: EngineOperationalSnapshot): void {
    this.snapshotValue = this.project(state);
    this.emit("snapshot", this.snapshot());
    this.emitTelemetry(state);
  }

  public recordEvent(type: string, rawPayload: unknown, atMs = Date.now()): void {
    const payload = safeClone(rawPayload);
    const severity = severityFor(type);
    const symbol = findString(payload, ["cryptoSymbol", "plan.cryptoSymbol", "order.cryptoSymbol", "symbol",
      "position.symbol", "plan.symbol", "order.symbol", "order.contractSymbol", "contractSymbol", "plan.contractSymbol",
      "event.cryptoSymbol", "event.symbol"]);
    const clientOrderId = findString(payload, ["clientOrderId", "client_order_id", "plan.clientOrderId",
      "order.clientOrderId", "order.client_order_id", "event.clientOrderId"]);
    const event: DashboardEvent = {
      id: randomUUID(), type, severity, atMs, symbol, clientOrderId,
      summary: summarize(type, payload, symbol), payload,
    };
    this.events.unshift(event);
    if (this.events.length > this.maximumEvents) this.events.length = this.maximumEvents;
    this.captureTimeline(event);
    this.capturePositionDecision(type, payload);
    this.emit("telemetry", { kind: "event", atMs, payload: event } satisfies TelemetryRecord);
    if (["decision", "positionDecision", "exitDecision", "optionShortDecision"].includes(type)) {
      this.emit("telemetry", { kind: "decision", atMs, payload: { type, event: payload } } satisfies TelemetryRecord);
    }
    if (type === "fill") this.emit("telemetry", { kind: "fill", atMs, payload } satisfies TelemetryRecord);
    if (this.engine) this.poll();
  }

  private poll(): void {
    if (!this.engine) return;
    this.ingestEngineSnapshot(this.engine.state());
  }

  private project(state: EngineOperationalSnapshot): DashboardSnapshot {
    const nowMs = state.generatedAtMs;
    const markets = state.markets.map((market): DashboardMarketCard => {
      const features = market.features;
      return {
        symbol: market.symbol,
        bookValid: market.bookValid,
        bestBid: market.bestBid,
        bestAsk: market.bestAsk,
        mid: features?.mid ?? midpoint(market.bestBid, market.bestAsk),
        spread: features?.spread ?? difference(market.bestAsk, market.bestBid),
        spreadBps: features?.spreadBps ?? spreadBps(market.bestBid, market.bestAsk),
        sigmaHBps: features?.sigmaHBps ?? null,
        slowTrendReady: features?.slowTrendReady ?? false,
        trendFastBps: features?.trendFastBps ?? null,
        trendMediumBps: features?.trendMediumBps ?? null,
        trendSlowBps: features?.trendSlowBps ?? null,
        slowTrendAlignment: features?.slowTrendAlignment ?? null,
        slowTrendEfficiency: features?.slowTrendEfficiency ?? null,
        longPullbackReady: features?.longPullback.ready ?? false,
        longPullbackDepthBps: features?.longPullback.pullbackDepthBps ?? null,
        longPullbackRecoveryBps: features?.longPullback.recoveryBps ?? null,
        longPullbackRemainingRoomBps: features?.longPullback.remainingRoomBps ?? null,
        providerAgeMs: features?.providerAgeMs ?? null,
        staleThresholdMs: features?.staleThresholdMs ?? null,
        warmedUp: features?.warmedUp ?? false,
        kinematicsReady: features?.kinematicsReady ?? false,
        kinematicsResetReason: features?.kinematicsResetReason ?? null,
        stale: features?.stale ?? !market.bookValid,
        staleReason: features?.staleReason ?? (!market.bookValid ? "BOOK_INVALID" : null),
        sequence: market.sequence,
        qi1: features?.qi1 ?? null,
        ofi: features?.ofi ?? null,
        tfi: features?.tfi ?? null,
        efficiency: features?.efficiency ?? null,
        velocityZ: features?.velocityZ ?? null,
        regime: market.regime?.name ?? null,
        longScore: market.ruleEvaluation?.long.score ?? null,
        shortScore: market.ruleEvaluation?.short.score ?? null,
        longPhase: market.ruleEvaluation?.long.phase ?? null,
        shortPhase: market.ruleEvaluation?.short.phase ?? null,
        longRule: market.ruleEvaluation ? projectRule(market.ruleEvaluation.long) : null,
        shortRule: market.ruleEvaluation ? projectRule(market.ruleEvaluation.short) : null,
        candidateReady: market.ruleEvaluation?.candidate !== null && market.ruleEvaluation?.candidate !== undefined,
        candidateSide: market.ruleEvaluation?.candidate?.side ?? null,
        entryReady: market.entryReady ?? (market.ruleEvaluation?.intent !== null && market.ruleEvaluation?.intent !== undefined),
        liquidityTradeThresholdBps: market.liquidity?.long.tradeThresholdBps ?? null,
        liquidityStressThresholdBps: market.liquidity?.long.stressThresholdBps ?? null,
        liquidityReasons: [...new Set([
          ...(market.liquidity?.long.reasons ?? []), ...(market.liquidity?.short.reasons ?? []),
        ])],
        entryPipeline: market.entryPipeline ? {
          counts: { ...market.entryPipeline.counts },
          lastRejection: market.entryPipeline.lastRejection ? {
            ...market.entryPipeline.lastRejection, values: { ...market.entryPipeline.lastRejection.values },
          } : null,
        } : null,
        blockReasons: [...new Set([
          ...(market.ruleEvaluation?.long.reasons ?? []), ...(market.ruleEvaluation?.short.reasons ?? []),
        ])],
      };
    });
    const marketBySymbol = new Map(markets.map((market) => [market.symbol, market]));
    const completedExitBySymbol = new Map<string, EngineOperationalSnapshot["orders"][number]>();
    for (const order of state.orders) {
      if (!order.plan.reduceOnlyIntent || order.status !== "FILLED" || order.filledQty <= 0) continue;
      const previous = completedExitBySymbol.get(order.plan.symbol);
      if (!previous || order.lastUpdateMs > previous.lastUpdateMs) completedExitBySymbol.set(order.plan.symbol, order);
    }
    const exitedDustSymbols = new Set(state.positions.flatMap((position) => {
      const exit = completedExitBySymbol.get(position.symbol);
      if (!exit || exit.lastUpdateMs < position.openedMs) return [];
      return position.qty <= quantityTolerance(exit.filledQty) ? [position.symbol] : [];
    }));
    const livePositionOrderIds = new Map<string, string>();
    for (const position of state.positions) {
      if (exitedDustSymbols.has(position.symbol)) continue;
      let nearestOrderId: string | null = null;
      let nearestFillDistanceMs = Number.POSITIVE_INFINITY;
      for (const order of state.orders) {
        if (order.plan.symbol !== position.symbol || order.plan.side !== position.side
          || order.plan.reduceOnlyIntent || order.filledQty <= 0) continue;
        const distanceMs = Math.abs(order.lastUpdateMs - position.openedMs);
        if (distanceMs < nearestFillDistanceMs) {
          nearestFillDistanceMs = distanceMs;
          nearestOrderId = order.plan.clientOrderId;
        }
      }
      if (nearestOrderId) livePositionOrderIds.set(position.symbol, nearestOrderId);
    }

    const activePositionSymbols = new Set<string>();
    const activePnlOrderIds = new Set<string>();
    const positions = state.positions.map((position): DashboardPositionCard => {
      const exitedAsDust = exitedDustSymbols.has(position.symbol);
      if (!exitedAsDust) activePositionSymbols.add(position.symbol);
      const market = marketBySymbol.get(position.symbol);
      const currentPx = position.side > 0
        ? market?.bestBid ?? market?.mid ?? null
        : market?.bestAsk ?? market?.mid ?? null;
      const netMovePx = currentPx === null ? null
        : position.side * (currentPx - position.entryPx) - Math.max(0, position.roundTripCostPx);
      const unrealizedPnl = netMovePx === null ? null : position.qty * netMovePx;
      const unrealizedPnlBps = netMovePx === null ? null : netMovePx / position.entryPx * 10_000;
      const latest = this.positionDecisions.get(position.symbol);
      const ageMs = Math.max(0, nowMs - position.openedMs);
      if (!exitedAsDust && currentPx !== null && unrealizedPnl !== null && unrealizedPnlBps !== null) {
        const orderId = livePositionOrderIds.get(position.symbol);
        const positionPnl: DashboardLivePosition = {
          active: true,
          closedAtMs: null,
          openedMs: position.openedMs,
          ageMs,
          qty: position.qty,
          entryPx: position.entryPx,
          currentPx,
          unrealizedPnl,
          unrealizedPnlBps,
          realizedPnl: null,
          realizedPnlBps: null,
          realizedBreakdown: null,
          closePx: null,
          entryOrderId: orderId ?? null,
          exitOrderId: null,
          phase: position.phase,
          latestAction: latest?.action ?? "MONITOR",
          latestReason: latest?.reason ?? null,
          pnlHistory: [...this.trackPositionPnl(position.symbol, position.openedMs, nowMs, currentPx, unrealizedPnl, unrealizedPnlBps)],
        };
        if (orderId) {
          activePnlOrderIds.add(orderId);
          this.orderPositionPnl.set(orderId, positionPnl);
        }
      }
      return {
        active: !exitedAsDust, closedAtMs: null,
        symbol: position.symbol, side: position.side, qty: position.qty, entryPx: position.entryPx, currentPx,
        marketValue: currentPx === null ? null : currentPx * position.qty,
        unrealizedPnl,
        unrealizedPnlBps,
        phase: position.phase, openedMs: position.openedMs, ageMs,
        initialRiskPx: position.initialRiskPx, roundTripCostPx: position.roundTripCostPx, floorPx: position.floorPx,
        stopPx: position.entryPx + position.side * position.floorPx,
        mfePx: position.mfePx, maePx: position.maePx, breakEvenArmed: position.breakEvenArmed,
        selectedHorizonMs: position.selectedHorizonMs ?? null, executionPath: position.executionPath ?? null,
        latestAction: latest?.action ?? "MONITOR", latestReason: latest?.reason ?? null,
        holdEdgeBps: latest?.holdEdgeBps ?? null, reversalProbability: latest?.reversalProbability ?? null,
      };
    });
    this.prunePositionPnlHistories(activePositionSymbols);
    for (const [orderId, positionPnl] of this.orderPositionPnl) {
      if (!activePnlOrderIds.has(orderId) && positionPnl.active) {
        this.orderPositionPnl.set(orderId, {
          ...positionPnl,
          active: false,
          closedAtMs: nowMs,
          ageMs: Math.max(0, nowMs - positionPnl.openedMs),
        });
      }
    }

    const orders = state.orders.map((order): DashboardOrderCard => {
      const cancellationReason = order.cancellationReason ?? order.cancelRequestReason ?? null;
      this.trackOrderStatus(order.plan.clientOrderId, order.status, order.lastUpdateMs, order.error ?? null, cancellationReason);
      const remainingQty = Math.max(0, order.plan.qty - order.filledQty);
      const livePosition = this.orderPositionPnl.get(order.plan.clientOrderId) ?? null;
      return {
        clientOrderId: order.plan.clientOrderId,
        decisionId: order.plan.decisionId,
        alpacaOrderId: order.alpacaOrderId ?? null,
        historical: false,
        symbol: order.plan.symbol,
        side: order.plan.side,
        style: order.plan.style,
        entryFamily: order.plan.entryFamily ?? null,
        economicHorizonMs: order.plan.economicHorizonMs ?? null,
        executionPath: order.plan.executionPath ?? null,
        exitReason: order.plan.exitReason ?? null,
        fallbackFromClientOrderId: order.plan.fallbackFromClientOrderId ?? null,
        timeInForce: order.plan.timeInForce,
        status: order.status,
        statusLabel: orderStatusLabel(order.status, cancellationReason),
        terminal: TERMINAL_ORDER_STATES.has(order.status),
        requestedQty: order.plan.qty,
        filledQty: order.filledQty,
        remainingQty,
        fillPercent: order.plan.qty > 0 ? Math.min(100, order.filledQty / order.plan.qty * 100) : 0,
        averageFillPx: order.averageFillPx,
        limitPx: order.plan.limitPx,
        expectedValue: order.plan.expectedValue,
        fillProbability: order.plan.fillProbability,
        expectedCost: { ...order.plan.expectedCost },
        reduceOnlyIntent: order.plan.reduceOnlyIntent,
        createdMs: order.plan.createdMs,
        expiresMs: order.plan.expiresMs,
        updatedMs: order.lastUpdateMs,
        ageMs: Math.max(0, nowMs - order.plan.createdMs),
        expiresInMs: order.plan.expiresMs - nowMs,
        error: order.error ?? null,
        cancelRequestReason: order.cancelRequestReason ?? null,
        cancellationReason: order.cancellationReason ?? null,
        timeline: [...(this.orderTimelines.get(order.plan.clientOrderId) ?? [])],
        livePosition,
      };
    });
    const currentOrderIds = new Set(orders.map((order) => order.clientOrderId));
    const visibleOrders = sortOrders(this.linkExitOrderPnl([
      ...orders,
      ...[...this.historicalOrders.values()].filter((order) => !currentOrderIds.has(order.clientOrderId)),
    ])).filter((order) => isCurrentUtcDay(order.createdMs, nowMs));
    for (const order of visibleOrders) {
      if (currentOrderIds.has(order.clientOrderId) && order.livePosition) {
        this.orderPositionPnl.set(order.clientOrderId, cloneLivePosition(order.livePosition));
      }
    }
    const markUnrealizedPnl = sessionMarkUnrealizedPnl(state);
    const session = this.projectUtcSession(state, markUnrealizedPnl);
    const realizedBreakdown = aggregateRealizedSessionPnl(visibleOrders, nowMs);
    const realizedSessionBreakdown: DashboardSessionPnlBreakdown = {
      grossPricePnl: realizedBreakdown?.grossPricePnl ?? null,
      entryFee: realizedBreakdown?.entryFee ?? null,
      exitFee: realizedBreakdown?.exitFee ?? null,
      realizedPnl: session.realizedPnl,
      unrealizedPnl: session.unrealizedPnl,
      totalPnl: session.totalPnl,
      tradeCount: realizedBreakdown?.tradeCount ?? 0,
      entryStyle: realizedBreakdown?.entryStyle ?? null,
      exitStyle: realizedBreakdown?.exitStyle ?? null,
    };
    const health = state.risk.health;
    const kraken = state.venue === "kraken_futures";
    const liveness: DashboardSnapshot["liveness"] = [
      check("engine", "Engine process", state.started, state.started ? `Up ${formatDuration(state.uptimeMs)}` : "Not started", nowMs),
      check("public", kraken ? "Kraken Futures market stream" : "Alpaca market stream", health.publicStream,
        health.publicStream ? (kraken ? "Subscribed · receiving" : "Authenticated · receiving") : "Disconnected", nowMs),
      check("private", kraken ? "Local paper order stream" : "Alpaca trade updates", health.privateStream,
        health.privateStream ? (kraken ? "Simulator connected" : "Authenticated · receiving") : "Disconnected", nowMs),
      check("account", "Account reconciliation", health.accountReconciled, health.accountReconciled ? "Positions and orders reconciled" : "Unknown account state", nowMs),
      check("book", "Local order books", health.bookValid, health.bookValid ? `${markets.length} book${markets.length === 1 ? "" : "s"} valid` : "Invalid or warming up", nowMs),
      check("clock", "Clock sanity", health.clockValid, health.clockValid ? "Timestamps valid" : "Clock invalid", nowMs),
      check("risk", "Risk state", health.riskRecomputed, health.riskRecomputed ? "Exposure recomputed" : "Risk recomputation required", nowMs),
      check("database", "PostgreSQL writer", this.databaseHealth.status === "disabled" || this.databaseHealth.connected,
        this.databaseHealth.status === "disabled" ? "Persistence disabled" : this.databaseHealth.connected ? `${this.databaseHealth.queuedRecords} queued` : this.databaseHealth.lastError ?? "Connecting", nowMs),
    ];
    const coreHealthy = liveness.filter((item) => item.id !== "database").every((item) => item.healthy);
    const entriesAllowed = coreHealthy && state.risk.reasons.length === 0;
    const overall = state.risk.reasons.length > 0 || (!health.publicStream && state.started) ? "critical"
      : !coreHealthy || (this.databaseHealth.status !== "disabled" && !this.databaseHealth.connected) ? "degraded" : "healthy";
    const optionShort = this.projectOptionShort(state.optionShort, nowMs);
    return {
      version: 1, generatedAtMs: nowMs, mode: state.mode, paper: state.paper, paperEntryExercise: state.paperEntryExercise,
      strategyVersion: state.strategyVersion, modelVersion: state.modelVersion,
      configurationVersion: state.configurationVersion ?? "-", signalMode: state.signalMode ?? "DETERMINISTIC_ONLY",
      started: state.started, uptimeMs: state.uptimeMs, overall, entriesAllowed,
      haltReasons: [...state.risk.reasons], equity: session.equity, equityHighWater: session.equityHighWater,
      sessionStartingEquity: session.startingEquity,
      sessionPnl: session.totalPnl,
      sessionRealizedPnl: session.realizedPnl,
      sessionUnrealizedPnl: session.unrealizedPnl,
      realizedSessionPnl: state.realizedSessionPnl,
      realizedSessionBreakdown,
      latencyP95Ms: state.latency.decisionToVenue?.count ? state.latency.decisionToVenue.p95 : null,
      liveness, database: { ...this.databaseHealth }, markets, positions, orders: visibleOrders, optionShort,
      events: this.events.filter((event) => isCurrentUtcDay(event.atMs, nowMs)),
    };
  }

  private projectUtcSession(state: EngineOperationalSnapshot, markUnrealizedPnl: number): {
    startingEquity: number; equity: number; equityHighWater: number;
    realizedPnl: number; unrealizedPnl: number; totalPnl: number;
  } {
    const dayStartMs = utcDayStartMs(state.generatedAtMs);
    if (!this.utcSession) {
      const totalPnl = state.realizedSessionPnl + markUnrealizedPnl;
      if (!state.risk.health.accountReconciled) {
        return {
          startingEquity: state.equity - totalPnl,
          equity: state.equity,
          equityHighWater: Math.max(state.equityHighWater, state.equity),
          realizedPnl: state.realizedSessionPnl,
          unrealizedPnl: markUnrealizedPnl,
          totalPnl,
        };
      }
      this.utcSession = {
        dayStartMs,
        startingEquity: state.equity - totalPnl,
        realizedBaseline: 0,
        unrealizedBaseline: 0,
        equityHighWater: Math.max(state.equityHighWater, state.equity),
        lastEquity: state.equity,
      };
    } else if (this.utcSession.dayStartMs !== dayStartMs) {
      const previous = this.utcSession;
      const openingEquity = previous.lastEquity;
      this.utcSession = {
        dayStartMs,
        startingEquity: openingEquity,
        // Kraken's paper broker already resets this counter at UTC midnight.
        // Other venues retain a cumulative process value that must be rebased here.
        realizedBaseline: state.venue === "kraken_futures" ? 0 : state.realizedSessionPnl,
        unrealizedBaseline: markUnrealizedPnl,
        equityHighWater: openingEquity,
        lastEquity: openingEquity,
      };
    }
    const session = this.utcSession;
    const realizedPnl = state.realizedSessionPnl - session.realizedBaseline;
    const unrealizedPnl = markUnrealizedPnl - session.unrealizedBaseline;
    const totalPnl = realizedPnl + unrealizedPnl;
    const equity = session.startingEquity + totalPnl;
    session.equityHighWater = Math.max(session.equityHighWater, equity);
    session.lastEquity = equity;
    return { startingEquity: session.startingEquity, equity, equityHighWater: session.equityHighWater,
      realizedPnl, unrealizedPnl, totalPnl };
  }

  private trackPositionPnl(symbol: string, openedMs: number, atMs: number, currentPx: number,
    unrealizedPnl: number, unrealizedPnlBps: number): readonly DashboardPnlPoint[] {
    let series = this.positionPnlHistories.get(symbol);
    if (!series || series.openedMs !== openedMs) {
      series = { openedMs, points: [], lastAppendMs: null };
      this.positionPnlHistories.set(symbol, series);
    }

    const last = series.points.at(-1);
    if (last?.currentPx === currentPx && last.unrealizedPnl === unrealizedPnl) return series.points;

    if (last && series.lastAppendMs !== null && atMs - series.lastAppendMs < this.pnlSampleMs) {
      const previous = series.points.at(-2);
      series.points[series.points.length - 1] = {
        atMs,
        currentPx,
        unrealizedPnl,
        unrealizedPnlBps,
        changePnl: previous ? unrealizedPnl - previous.unrealizedPnl : null,
        kind: "mark",
      };
    } else {
      series.points.push({
        atMs,
        currentPx,
        unrealizedPnl,
        unrealizedPnlBps,
        changePnl: last ? unrealizedPnl - last.unrealizedPnl : null,
        kind: "mark",
      });
      series.lastAppendMs = atMs;
    }
    if (series.points.length > this.maximumPnlHistory) {
      series.points.splice(0, series.points.length - this.maximumPnlHistory);
    }
    return series.points;
  }

  private projectOptionShort(optionShort: EngineOperationalSnapshot["optionShort"], nowMs: number): DashboardOptionShort {
    const currentSessionDate = newYorkDate(nowMs);
    if (!optionShort) return emptyOptionShort(currentSessionDate);
    const activeKeys = new Set<string>();
    for (const exposure of optionShort.exposures) {
      const key = `${exposure.contractSymbol}:${exposure.openedMs}`;
      activeKeys.add(key);
      const currentPremium = exposure.markPremium ?? null;
      const premiumAtRiskDollars = exposure.averageEntryPremium * exposure.qty * 100;
      const unrealizedPnl = currentPremium === null ? null
        : (currentPremium - exposure.averageEntryPremium) * exposure.qty * 100;
      const unrealizedPnlBps = unrealizedPnl === null || !(premiumAtRiskDollars > 0) ? null
        : unrealizedPnl / premiumAtRiskDollars * 10_000;
      const previous = this.optionTrades.get(key);
      const pnlHistory = currentPremium === null || unrealizedPnl === null || unrealizedPnlBps === null
        ? previous?.pnlHistory ?? []
        : this.trackOptionPnl(key, exposure.openedMs, exposure.markTimestampMs ?? nowMs,
          currentPremium, unrealizedPnl, unrealizedPnlBps);
      this.optionTrades.set(key, {
        cryptoSymbol: exposure.cryptoSymbol,
        proxySymbol: exposure.proxySymbol,
        contractSymbol: exposure.contractSymbol,
        expirationDate: exposure.expirationDate,
        active: true,
        closedAtMs: null,
        qty: exposure.qty,
        averageEntryPremium: exposure.averageEntryPremium,
        premiumAtRiskDollars,
        currentDay: exposure.expirationDate === currentSessionDate,
        openedMs: exposure.openedMs,
        ageMs: Math.max(0, nowMs - exposure.openedMs),
        entryCryptoPrice: exposure.entryCryptoPrice ?? null,
        currentPremium,
        quoteAtMs: exposure.markTimestampMs ?? null,
        quoteAgeMs: exposure.markTimestampMs === undefined ? null : Math.max(0, nowMs - exposure.markTimestampMs),
        unrealizedPnl,
        unrealizedPnlBps,
        pnlHistory,
      });
    }
    for (const [key, trade] of this.optionTrades) {
      if (!trade.active || activeKeys.has(key)) continue;
      this.optionTrades.set(key, { ...trade, active: false, closedAtMs: nowMs,
        ageMs: Math.max(0, nowMs - trade.openedMs) });
    }
    const trades = [...this.optionTrades.values()].sort((a, b) => b.openedMs - a.openedMs);
    for (const trade of trades.slice(50)) this.optionTrades.delete(`${trade.contractSymbol}:${trade.openedMs}`);
    const currentTrades = trades.filter((trade) => trade.expirationDate === currentSessionDate
      && newYorkDate(trade.openedMs) === currentSessionDate);
    const currentPendingOrders = optionShort.pendingOrders.map((order) => {
      const expirationDate = optionExpirationDate(order.contractSymbol);
      return {
        ...order,
        alpacaOrderId: order.alpacaOrderId ?? null,
        expirationDate,
        currentDay: expirationDate === currentSessionDate,
        expiresInMs: order.expiresMs - nowMs,
        settling: ["SETTLING", "UNKNOWN"].includes(order.status.toUpperCase()),
      };
    }).filter((order) => order.currentDay);
    return {
      enabled: optionShort.enabled,
      ready: optionShort.enabled && optionShort.accountReady && optionShort.stockStreamReady && optionShort.optionStreamReady
        && optionShort.subscribedContracts > 0,
      accountReady: optionShort.accountReady,
      stockStreamReady: optionShort.stockStreamReady,
      optionStreamReady: optionShort.optionStreamReady,
      subscribedContracts: optionShort.subscribedContracts,
      currentSessionDate,
      trades: currentTrades.slice(0, 50),
      pendingOrders: currentPendingOrders,
      recentActivity: this.events.filter((event) => event.type.startsWith("optionShort")
        && newYorkDate(event.atMs) === currentSessionDate).slice(0, 8),
    };
  }

  private trackOptionPnl(key: string, openedMs: number, atMs: number, currentPremium: number,
    unrealizedPnl: number, unrealizedPnlBps: number): readonly DashboardPnlPoint[] {
    let series = this.optionPnlHistories.get(key);
    if (!series || series.openedMs !== openedMs) {
      series = { openedMs, points: [], lastAppendMs: null };
      this.optionPnlHistories.set(key, series);
    }
    const last = series.points.at(-1);
    if (last?.currentPx === currentPremium && last.unrealizedPnl === unrealizedPnl) return series.points;
    series.points.push({ atMs, currentPx: currentPremium, unrealizedPnl, unrealizedPnlBps,
      changePnl: last ? unrealizedPnl - last.unrealizedPnl : null, kind: "mark" });
    if (series.points.length > this.maximumPnlHistory) {
      series.points.splice(0, series.points.length - this.maximumPnlHistory);
    }
    return series.points;
  }

  private linkExitOrderPnl(orders: DashboardOrderCard[]): DashboardOrderCard[] {
    const linked = orders.map((order) => ({
      ...order,
      livePosition: order.livePosition ? cloneLivePosition(order.livePosition) : null,
    }));
    const latestEntryBySymbol = new Map<string, DashboardOrderCard>();
    for (const order of [...linked].sort((a, b) => a.createdMs - b.createdMs || a.updatedMs - b.updatedMs)) {
      if (!order.reduceOnlyIntent) {
        if (order.filledQty > 0) latestEntryBySymbol.set(order.symbol, order);
        continue;
      }
      if (order.filledQty <= 0 || !(order.averageFillPx > 0)) continue;
      const entry = latestEntryBySymbol.get(order.symbol);
      if (!entry?.livePosition || entry.side === order.side) continue;
      // Historical paper replay already carries the complete multi-fill trade.
      // Re-linking one exit card at a time would replace that authoritative
      // aggregate with a single-leg estimate.
      if (order.livePosition?.realizedBreakdown && order.livePosition.entryOrderId) continue;
      const closedPnl = this.closedTradePnl(entry, order);
      order.livePosition = closedPnl;
      if (!entry.livePosition.active) entry.livePosition = cloneLivePosition(closedPnl);
    }
    return linked;
  }

  private closedTradePnl(entry: DashboardOrderCard, exit: DashboardOrderCard): DashboardLivePosition {
    const source = entry.livePosition!;
    const closeQty = exit.filledQty;
    const closePx = exit.averageFillPx;
    const grossEntryQty = Math.min(entry.filledQty, closeQty);
    const entryNotional = grossEntryQty * source.entryPx;
    const entryFee = entryNotional * legFeeBps(entry) / 10_000;
    const exitFee = closeQty * closePx * legFeeBps(exit) / 10_000;
    const grossPricePnl = entry.side * closeQty * (closePx - source.entryPx);
    const realizedPnl = grossPricePnl - entryFee - exitFee;
    const realizedPnlBps = entryNotional > 0 ? realizedPnl / entryNotional * 10_000 : 0;
    const history = source.pnlHistory.map((point) => ({ ...point }));
    if (!source.active && source.qty <= quantityTolerance(closeQty) && history.at(-1)?.kind !== "close") history.pop();
    const previous = history.at(-1);
    const closePoint: DashboardPnlPoint = {
      atMs: exit.updatedMs,
      currentPx: closePx,
      unrealizedPnl: realizedPnl,
      unrealizedPnlBps: realizedPnlBps,
      changePnl: previous ? realizedPnl - previous.unrealizedPnl : null,
      kind: "close",
    };
    if (previous?.kind === "close") history[history.length - 1] = closePoint;
    else history.push(closePoint);
    if (history.length > this.maximumPnlHistory) history.splice(0, history.length - this.maximumPnlHistory);
    return {
      ...source,
      active: false,
      closedAtMs: exit.updatedMs,
      ageMs: Math.max(0, exit.updatedMs - source.openedMs),
      qty: closeQty,
      currentPx: closePx,
      unrealizedPnl: realizedPnl,
      unrealizedPnlBps: realizedPnlBps,
      realizedPnl,
      realizedPnlBps,
      realizedBreakdown: {
        grossPricePnl,
        entryFee,
        exitFee,
        realizedPnl,
        entryStyle: entry.style,
        exitStyle: exit.style,
      },
      closePx,
      entryOrderId: entry.clientOrderId,
      exitOrderId: exit.clientOrderId,
      phase: "CLOSED",
      latestAction: "EXIT",
      latestReason: source.latestReason ?? "FILLED_REDUCE_ONLY_EXIT",
      pnlHistory: history,
    };
  }

  private prunePositionPnlHistories(activeSymbols: ReadonlySet<string>): void {
    for (const symbol of this.positionPnlHistories.keys()) {
      if (!activeSymbols.has(symbol)) this.positionPnlHistories.delete(symbol);
    }
  }

  private trackOrderStatus(clientOrderId: string, status: string, atMs: number, error: string | null, cancellationReason: string | null): void {
    const stateKey = `${status}:${cancellationReason ?? ""}`;
    if (this.orderStatuses.get(clientOrderId) === stateKey) return;
    this.orderStatuses.set(clientOrderId, stateKey);
    const timeline = this.orderTimelines.get(clientOrderId) ?? [];
    timeline.push({
      id: randomUUID(), status,
      label: error ? `${status}: ${error}` : orderStatusLabel(status, cancellationReason),
      atMs, severity: statusSeverity(status),
    });
    if (timeline.length > 20) timeline.splice(0, timeline.length - 20);
    this.orderTimelines.set(clientOrderId, timeline);
  }

  private captureTimeline(event: DashboardEvent): void {
    if (!event.clientOrderId || !event.type.toLowerCase().includes("order")) return;
    const timeline = this.orderTimelines.get(event.clientOrderId) ?? [];
    timeline.push({ id: event.id, status: event.type, label: event.summary, atMs: event.atMs, severity: event.severity });
    if (timeline.length > 20) timeline.splice(0, timeline.length - 20);
    this.orderTimelines.set(event.clientOrderId, timeline);
  }

  private capturePositionDecision(type: string, payload: unknown): void {
    if (type !== "positionDecision" && type !== "exitDecision") return;
    const symbol = findString(payload, ["position.symbol", "symbol"]);
    if (!symbol) return;
    const action = findString(payload, ["decision.action", "action"]) ?? (type === "exitDecision" ? "EXIT" : "MONITOR");
    const reason = findString(payload, ["decision.reason", "reason"]);
    this.positionDecisions.set(symbol, {
      action, reason,
      holdEdgeBps: findNumber(payload, ["hold.holdLowerBoundBps", "holdLowerBoundBps", "decision.holdLowerBoundBps"]),
      reversalProbability: findNumber(payload, ["hold.reversalScore", "regime.reversalProbability", "reversalProbability"]),
    });
  }

  private emitTelemetry(state: EngineOperationalSnapshot): void {
    const nowMs = state.generatedAtMs;
    for (const order of this.snapshotValue.orders) {
      if (order.historical) continue;
      const signature = [order.status, order.filledQty, order.averageFillPx, order.updatedMs,
        order.cancelRequestReason, order.cancellationReason, order.livePosition?.active,
        order.livePosition?.closedAtMs, order.livePosition?.realizedPnl].join(":");
      if (this.lastOrderTelemetry.get(order.clientOrderId) === signature) continue;
      this.lastOrderTelemetry.set(order.clientOrderId, signature);
      this.emit("telemetry", { kind: "order", atMs: nowMs, payload: order } satisfies TelemetryRecord);
    }
    this.emitPositionClosures(nowMs);
    for (const order of this.snapshotValue.optionShort.pendingOrders) {
      const signature = `${order.alpacaOrderId ?? ""}:${order.status}:${order.filledQty}:${order.expiresMs}`;
      if (this.lastOptionOrderTelemetry.get(order.clientOrderId) === signature) continue;
      this.lastOptionOrderTelemetry.set(order.clientOrderId, signature);
      this.emit("telemetry", { kind: "option_order", atMs: nowMs, payload: order } satisfies TelemetryRecord);
    }
    for (const trade of this.snapshotValue.optionShort.trades) {
      const tradeKey = optionTradeKey(trade);
      const signature = `${trade.active}:${trade.qty}:${trade.currentPremium ?? ""}:${trade.unrealizedPnl ?? ""}:${trade.closedAtMs ?? ""}`;
      if (this.lastOptionTradeTelemetry.get(tradeKey) !== signature) {
        this.lastOptionTradeTelemetry.set(tradeKey, signature);
        this.emit("telemetry", { kind: "option_trade", atMs: nowMs,
          payload: { ...trade, pnlHistory: [] } } satisfies TelemetryRecord);
      }
      const point = trade.pnlHistory.at(-1);
      if (!point) continue;
      const pointSignature = `${point.atMs}:${point.currentPx}:${point.unrealizedPnl}`;
      if (this.lastOptionPnlTelemetry.get(tradeKey) === pointSignature) continue;
      this.lastOptionPnlTelemetry.set(tradeKey, pointSignature);
      this.emit("telemetry", { kind: "option_pnl", atMs: point.atMs,
        payload: { tradeKey, cryptoSymbol: trade.cryptoSymbol, contractSymbol: trade.contractSymbol,
          point } satisfies OptionShortPnlTelemetry } satisfies TelemetryRecord);
    }
    if (nowMs - this.lastHealthTelemetryMs >= this.healthSampleMs) {
      this.lastHealthTelemetryMs = nowMs;
      this.emit("telemetry", { kind: "health", atMs: nowMs, payload: this.snapshotValue } satisfies TelemetryRecord);
    }
    if (nowMs - this.lastMarketTelemetryMs < this.marketSampleMs) return;
    this.lastMarketTelemetryMs = nowMs;
    for (const position of this.snapshotValue.positions) {
      this.emit("telemetry", { kind: "position", atMs: nowMs, payload: position } satisfies TelemetryRecord);
    }
    for (const market of this.snapshotValue.markets) {
      this.emit("telemetry", { kind: "market", atMs: nowMs, payload: market } satisfies TelemetryRecord);
    }
  }

  private emitPositionClosures(nowMs: number): void {
    const active = new Map(this.snapshotValue.positions
      .filter((position) => position.active)
      .map((position) => [position.symbol, position] as const));
    for (const position of active.values()) {
      this.observedPositions.set(position.symbol, safeClone(position) as DashboardPositionCard);
    }
    for (const [symbol, previous] of this.observedPositions) {
      if (active.has(symbol)) continue;
      const exit = this.snapshotValue.orders
        .filter((order) => order.symbol === symbol && order.reduceOnlyIntent && order.status === "FILLED"
          && order.filledQty > 0 && order.livePosition?.openedMs === previous.openedMs
          && order.livePosition.active === false)
        .sort((left, right) => (right.livePosition?.closedAtMs ?? right.updatedMs)
          - (left.livePosition?.closedAtMs ?? left.updatedMs))[0];
      const closedAtMs = exit?.livePosition?.closedAtMs ?? exit?.updatedMs ?? nowMs;
      const closePx = exit?.livePosition?.closePx ?? (exit?.averageFillPx ? exit.averageFillPx : previous.currentPx);
      const closed: DashboardPositionCard = {
        ...previous,
        active: false,
        closedAtMs,
        qty: 0,
        currentPx: closePx,
        marketValue: 0,
        unrealizedPnl: 0,
        unrealizedPnlBps: 0,
        phase: "CLOSED",
        ageMs: Math.max(0, closedAtMs - previous.openedMs),
        latestAction: "EXIT",
        latestReason: exit?.exitReason ?? exit?.livePosition?.latestReason ?? previous.latestReason
          ?? "POSITION_CLOSED",
      };
      this.emit("telemetry", { kind: "position", atMs: closedAtMs, payload: closed } satisfies TelemetryRecord);
      this.observedPositions.delete(symbol);
    }
  }
}

function optionTradeKey(trade: Pick<DashboardOptionShortTrade, "contractSymbol" | "openedMs">): string {
  return `${trade.contractSymbol}:${trade.openedMs}`;
}

function projectRule(rule: NonNullable<EngineMarketSnapshot["ruleEvaluation"]>["long"]): DashboardMarketCard["longRule"] {
  return {
    family: rule.family, side: rule.side, phase: rule.phase, score: rule.score,
    bookVotes: rule.votes.book, flowVotes: rule.votes.flow, kinematicVotes: rule.votes.kinematic, quorumPass: rule.votes.quorum,
    persistence: rule.persistence, evidence: rule.evidence,
    confirmationMs: rule.confirmationMs, confirmationEvents: rule.confirmationEvents,
    deltaMicroBps: rule.deltaMicroBps, sensorThresholdBps: rule.sensorThresholdBps,
    microNoiseBps: rule.microNoiseBps, chaseBps: rule.chaseBps,
    grossOpportunityBps: rule.grossOpportunityBps, uncertaintyReserveBps: rule.uncertaintyReserveBps,
    roundTripCostBps: rule.roundTripCostBps, robustCostBps: rule.robustCostBps,
    lowerBoundNetBps: rule.lowerBoundNetBps, costShortfallBps: rule.costShortfallBps,
    continuationQuality: rule.continuationQuality, requiredContinuationQuality: rule.requiredContinuationQuality,
    economicSizeScale: rule.economicSizeScale, edgeHorizonMs: rule.edgeHorizonMs,
    executionPath: rule.executionPath ?? null,
    scorePass: rule.scorePass, rawDirectionalPass: rule.rawDirectionalPass, candidatePass: rule.candidatePass,
    healthPass: rule.healthPass, liquidityPass: rule.liquidityPass, regimePass: rule.regimePass,
    directionAuthorizationPass: rule.directionAuthorizationPass,
    persistencePass: rule.persistencePass, antiChasePass: rule.antiChasePass, exposurePass: rule.exposurePass,
    cooldownPass: rule.cooldownPass, costPass: rule.costPass,
    arbitrationPass: rule.arbitrationPass, slowTrendPass: rule.slowTrendPass,
    continuationTrendPass: rule.continuationTrendPass, pullbackRecoveryPass: rule.pullbackRecoveryPass,
    tradeThresholdBps: rule.tradeThresholdBps,
    stressThresholdBps: rule.stressThresholdBps, liquidityReasons: [...rule.liquidityReasons], reasons: [...rule.reasons],
  };
}

function emptySnapshot(): DashboardSnapshot {
  return { version: 1, generatedAtMs: Date.now(), mode: "offline", paper: true, strategyVersion: "-", modelVersion: "-",
    configurationVersion: "-", signalMode: "DETERMINISTIC_ONLY", started: false,
    uptimeMs: 0, overall: "degraded", entriesAllowed: false, haltReasons: [], equity: 0, equityHighWater: 0,
    sessionStartingEquity: 0, sessionPnl: 0, sessionRealizedPnl: 0, sessionUnrealizedPnl: 0, realizedSessionPnl: 0,
    realizedSessionBreakdown: null,
    latencyP95Ms: null, liveness: [], database: disabledDatabaseHealth(), markets: [], positions: [], orders: [],
    optionShort: emptyOptionShort(), events: [] };
}
function emptyOptionShort(currentSessionDate = "-"): DashboardOptionShort {
  return { enabled: false, ready: false, accountReady: false, stockStreamReady: false, optionStreamReady: false,
    subscribedContracts: 0, currentSessionDate, trades: [], pendingOrders: [], recentActivity: [] };
}
function newYorkDate(atMs: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit",
    day: "2-digit" }).formatToParts(new Date(atMs));
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
function optionExpirationDate(contractSymbol: string): string | null {
  const match = contractSymbol.match(/(\d{2})(\d{2})(\d{2})[CP]\d{8}$/);
  return match ? `20${match[1]}-${match[2]}-${match[3]}` : null;
}
function check(id: string, label: string, healthy: boolean, detail: string, updatedAtMs: number) { return { id, label, healthy, detail, updatedAtMs }; }
function midpoint(bid: number | null, ask: number | null): number | null { return bid === null || ask === null ? null : (bid + ask) / 2; }
function difference(a: number | null, b: number | null): number | null { return a === null || b === null ? null : a - b; }
function spreadBps(bid: number | null, ask: number | null): number | null { const mid = midpoint(bid, ask); return mid === null || mid <= 0 ? null : (ask! - bid!) / mid * 10_000; }
function formatDuration(ms: number): string { const total = Math.floor(ms / 1_000); const hours = Math.floor(total / 3_600); const minutes = Math.floor(total % 3_600 / 60); const seconds = total % 60; return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`; }
function sortOrders(orders: DashboardOrderCard[]): DashboardOrderCard[] {
  return orders.sort((a, b) => b.createdMs - a.createdMs
    || b.updatedMs - a.updatedMs
    || b.clientOrderId.localeCompare(a.clientOrderId));
}
function cloneLivePosition(position: DashboardLivePosition): DashboardLivePosition {
  return {
    ...position,
    realizedBreakdown: position.realizedBreakdown ? { ...position.realizedBreakdown } : null,
    pnlHistory: position.pnlHistory.map((point) => ({ ...point })),
  };
}
interface RealizedSessionBreakdown {
  grossPricePnl: number;
  entryFee: number;
  exitFee: number;
  realizedPnl: number;
  tradeCount: number;
  entryStyle: string | null;
  exitStyle: string | null;
}
function aggregateRealizedSessionPnl(orders: readonly DashboardOrderCard[], atMs: number): RealizedSessionBreakdown | null {
  const dayStartMs = utcDayStartMs(atMs);
  const closedExitLegs = new Map<string, DashboardRealizedTrade>();
  for (const order of orders) {
    const position = order.livePosition;
    const breakdown = position?.realizedBreakdown;
    if (!position || position.active || !breakdown || !position.entryOrderId || !position.exitOrderId || position.closedAtMs === null) continue;
    if (position.closedAtMs < dayStartMs || position.closedAtMs >= dayStartMs + 86_400_000) continue;
    const previous = closedExitLegs.get(position.exitOrderId);
    if (!previous || order.clientOrderId === position.exitOrderId) {
      closedExitLegs.set(position.exitOrderId, { entryOrderId: position.entryOrderId, breakdown });
    }
  }
  if (closedExitLegs.size === 0) return null;
  let grossPricePnl = 0;
  let entryFee = 0;
  let exitFee = 0;
  let realizedPnl = 0;
  const entryOrderIds = new Set<string>();
  const entryStyles = new Set<string>();
  const exitStyles = new Set<string>();
  for (const { entryOrderId, breakdown } of closedExitLegs.values()) {
    grossPricePnl += breakdown.grossPricePnl;
    entryFee += breakdown.entryFee;
    exitFee += breakdown.exitFee;
    realizedPnl += breakdown.realizedPnl;
    entryOrderIds.add(entryOrderId);
    entryStyles.add(breakdown.entryStyle);
    exitStyles.add(breakdown.exitStyle);
  }
  return {
    grossPricePnl,
    entryFee,
    exitFee,
    realizedPnl,
    tradeCount: entryOrderIds.size,
    entryStyle: entryStyles.size === 1 ? [...entryStyles][0]! : null,
    exitStyle: exitStyles.size === 1 ? [...exitStyles][0]! : null,
  };
}
function utcDayStartMs(atMs: number): number { return Math.floor(atMs / 86_400_000) * 86_400_000; }
function isCurrentUtcDay(candidateMs: number, atMs: number): boolean {
  const dayStartMs = utcDayStartMs(atMs);
  return candidateMs >= dayStartMs && candidateMs < dayStartMs + 86_400_000;
}
function sessionMarkUnrealizedPnl(state: EngineOperationalSnapshot): number {
  const markets = new Map(state.markets.map((market) => [market.symbol, market]));
  return state.positions.reduce((total, position) => {
    const market = markets.get(position.symbol);
    const mark = midpoint(market?.bestBid ?? null, market?.bestAsk ?? null) ?? position.entryPx;
    return total + position.side * (mark - position.entryPx) * position.qty;
  }, 0);
}
interface DashboardRealizedTrade {
  entryOrderId: string;
  breakdown: NonNullable<DashboardLivePosition["realizedBreakdown"]>;
}
function legFeeBps(order: DashboardOrderCard): number {
  return Number.isFinite(order.expectedCost.feeBps) ? Math.max(0, order.expectedCost.feeBps / 2) : 0;
}
function quantityTolerance(qty: number): number { return Math.max(1e-8, Math.abs(qty) * 1e-6); }
function statusLabel(status: string): string { return status.toLowerCase().replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase()); }
function orderStatusLabel(status: string, cancellationReason: string | null): string {
  if (status === "CANCELED" && cancellationReason) return statusLabel(cancellationReason);
  if (status === "CANCEL_PENDING" && cancellationReason) return `Cancel pending: ${statusLabel(cancellationReason)}`;
  return statusLabel(status);
}
function statusSeverity(status: string): EventSeverity { return ["REJECTED", "UNKNOWN"].includes(status) ? "critical" : ["CANCELED", "EXPIRED", "CANCEL_PENDING"].includes(status) ? "warning" : "info"; }
function severityFor(type: string): EventSeverity { const value = type.toLowerCase(); return value.includes("error") || value.includes("fault") || value.includes("rejected") ? "critical" : value.includes("cancel") || value.includes("exit") || value.includes("disconnect") || value.includes("blocked") || value.includes("down") ? "warning" : "info"; }
function summarize(type: string, payload: unknown, symbol: string | null): string {
  const reason = findString(payload, ["reason", "plan.reason", "decision.reason", "message"]);
  const action = findString(payload, ["purpose", "plan.purpose", "decision.action", "action", "event"]);
  const subject = symbol ? ` · ${symbol}` : "";
  return `${statusLabel(type)}${subject}${action ? ` · ${action}` : ""}${reason ? ` · ${reason}` : ""}`;
}
function safeClone(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value, (key, item: unknown) => {
      if (/secret|api.?key|authorization|credential|password/i.test(key)) return "[REDACTED]";
      if (typeof item === "bigint") return item.toString();
      if (typeof item === "number" && !Number.isFinite(item)) return null;
      return item;
    })) as unknown;
  } catch { return { value: String(value) }; }
}
function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
function findString(value: unknown, paths: readonly string[]): string | null {
  for (const path of paths) { const candidate = getPath(value, path); if (typeof candidate === "string" && candidate) return candidate; }
  return null;
}
function findNumber(value: unknown, paths: readonly string[]): number | null {
  for (const path of paths) { const candidate = Number(getPath(value, path)); if (Number.isFinite(candidate)) return candidate; }
  return null;
}
