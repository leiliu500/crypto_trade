import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { EngineMarketSnapshot, EngineOperationalSnapshot, TradingEngine } from "../engine/trading-engine.js";
import type { PositionDecision } from "../strategy/position-manager.js";
import type {
  DashboardEvent, DashboardLivePosition, DashboardMarketCard, DashboardOrderCard, DashboardPnlPoint,
  DashboardPositionCard, DashboardSnapshot, DatabaseHealth, EventSeverity, OrderTimelineEntry, TelemetryRecord,
} from "./types.js";
import { disabledDatabaseHealth } from "./types.js";

const ENGINE_EVENTS = [
  "reconciled", "engineError", "preflight", "publicStreamReady", "privateStreamReady", "decision",
  "orderReserved", "orderSending", "orderAccepted", "orderCancelRequested", "orderUpdate", "orderRejected",
  "positionDecision", "positionDust", "exitDecision", "fill", "watchdogFault", "entryBlocked",
] as const;
const TERMINAL_ORDER_STATES = new Set(["FILLED", "CANCELED", "REJECTED", "EXPIRED"]);

interface MonitorOptions {
  pollIntervalMs?: number;
  marketSampleMs?: number;
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

/** Read-only projection of engine state for UI and durable telemetry. */
export class OperationsMonitor extends EventEmitter {
  private readonly pollIntervalMs: number;
  private readonly marketSampleMs: number;
  private readonly maximumEvents: number;
  private readonly pnlSampleMs: number;
  private readonly maximumPnlHistory: number;
  private readonly events: DashboardEvent[] = [];
  private readonly orderTimelines = new Map<string, OrderTimelineEntry[]>();
  private readonly orderStatuses = new Map<string, string>();
  private readonly positionDecisions = new Map<string, LatestPositionDecision>();
  private readonly positionPnlHistories = new Map<string, PositionPnlSeries>();
  private readonly orderPositionPnl = new Map<string, DashboardLivePosition>();
  private readonly historicalOrders = new Map<string, DashboardOrderCard>();
  private readonly boundListeners = new Map<string, (...args: unknown[]) => void>();
  private engine?: TradingEngine;
  private timer?: NodeJS.Timeout;
  private lastMarketTelemetryMs = 0;
  private databaseHealth = disabledDatabaseHealth();
  private snapshotValue: DashboardSnapshot = emptySnapshot();

  public constructor(options: MonitorOptions = {}) {
    super();
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.marketSampleMs = options.marketSampleMs ?? 1_000;
    this.maximumEvents = options.maximumEvents ?? 200;
    this.pnlSampleMs = Math.max(0, options.pnlSampleMs ?? 1_000);
    this.maximumPnlHistory = Math.max(1, options.maximumPnlHistory ?? Number.POSITIVE_INFINITY);
  }

  public attach(engine: TradingEngine): void {
    if (this.engine) this.detach();
    this.engine = engine;
    for (const eventName of ENGINE_EVENTS) {
      const listener = (...args: unknown[]): void => this.recordEvent(eventName, args[0]);
      this.boundListeners.set(eventName, listener);
      engine.on(eventName, listener);
    }
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
    for (const order of orders) {
      const restored = safeClone({ ...order, historical: true }) as DashboardOrderCard;
      this.historicalOrders.set(restored.clientOrderId, restored);
      this.orderStatuses.set(restored.clientOrderId, `${restored.status}:${restored.cancellationReason ?? restored.cancelRequestReason ?? ""}`);
      this.orderTimelines.set(restored.clientOrderId, [...restored.timeline]);
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
    const symbol = findString(payload, ["symbol", "position.symbol", "plan.symbol", "event.symbol"]);
    const clientOrderId = findString(payload, ["clientOrderId", "client_order_id", "plan.clientOrderId", "event.clientOrderId"]);
    const event: DashboardEvent = {
      id: randomUUID(), type, severity, atMs, symbol, clientOrderId,
      summary: summarize(type, payload, symbol), payload,
    };
    this.events.unshift(event);
    if (this.events.length > this.maximumEvents) this.events.length = this.maximumEvents;
    this.captureTimeline(event);
    this.capturePositionDecision(type, payload);
    this.emit("telemetry", { kind: "event", atMs, payload: event } satisfies TelemetryRecord);
    if (["decision", "positionDecision", "exitDecision"].includes(type)) {
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
        providerAgeMs: features?.providerAgeMs ?? null,
        staleThresholdMs: features?.staleThresholdMs ?? null,
        warmedUp: features?.warmedUp ?? false,
        kinematicsReady: features?.kinematicsReady ?? false,
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
    const livePositionOrderIds = new Map<string, string>();
    for (const position of state.positions) {
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
      activePositionSymbols.add(position.symbol);
      const market = marketBySymbol.get(position.symbol);
      const currentPx = position.side > 0
        ? market?.bestBid ?? market?.mid ?? null
        : market?.bestAsk ?? market?.mid ?? null;
      const unrealizedPnl = currentPx === null ? null : position.side * position.qty * (currentPx - position.entryPx);
      const unrealizedPnlBps = currentPx === null ? null : position.side * (currentPx / position.entryPx - 1) * 10_000;
      const latest = this.positionDecisions.get(position.symbol);
      const ageMs = Math.max(0, nowMs - position.openedMs);
      if (currentPx !== null && unrealizedPnl !== null && unrealizedPnlBps !== null) {
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
        symbol: position.symbol, side: position.side, qty: position.qty, entryPx: position.entryPx, currentPx,
        marketValue: currentPx === null ? null : currentPx * position.qty,
        unrealizedPnl,
        unrealizedPnlBps,
        phase: position.phase, openedMs: position.openedMs, ageMs,
        initialRiskPx: position.initialRiskPx, floorPx: position.floorPx,
        stopPx: position.entryPx + position.side * position.floorPx,
        mfePx: position.mfePx, maePx: position.maePx, breakEvenArmed: position.breakEvenArmed,
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
        alpacaOrderId: order.alpacaOrderId ?? null,
        historical: false,
        symbol: order.plan.symbol,
        side: order.plan.side,
        style: order.plan.style,
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
    const visibleOrders = sortOrders([
      ...orders,
      ...[...this.historicalOrders.values()].filter((order) => !currentOrderIds.has(order.clientOrderId)),
    ]);
    const health = state.risk.health;
    const liveness: DashboardSnapshot["liveness"] = [
      check("engine", "Engine process", state.started, state.started ? `Up ${formatDuration(state.uptimeMs)}` : "Not started", nowMs),
      check("public", "Alpaca market stream", health.publicStream, health.publicStream ? "Authenticated · receiving" : "Disconnected", nowMs),
      check("private", "Alpaca trade updates", health.privateStream, health.privateStream ? "Authenticated · receiving" : "Disconnected", nowMs),
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
    return {
      version: 1, generatedAtMs: nowMs, mode: state.mode, paper: state.paper, paperEntryExercise: state.paperEntryExercise,
      strategyVersion: state.strategyVersion, modelVersion: state.modelVersion,
      configurationVersion: state.configurationVersion ?? "-", signalMode: state.signalMode ?? "DETERMINISTIC_ONLY",
      started: state.started, uptimeMs: state.uptimeMs, overall, entriesAllowed,
      haltReasons: [...state.risk.reasons], equity: state.equity, equityHighWater: state.equityHighWater,
      realizedSessionPnl: state.realizedSessionPnl, latencyP95Ms: state.latency.total?.p95 ?? 0,
      liveness, database: { ...this.databaseHealth }, markets, positions, orders: visibleOrders,
      events: [...this.events],
    };
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
      };
    } else {
      series.points.push({
        atMs,
        currentPx,
        unrealizedPnl,
        unrealizedPnlBps,
        changePnl: last ? unrealizedPnl - last.unrealizedPnl : null,
      });
      series.lastAppendMs = atMs;
    }
    if (series.points.length > this.maximumPnlHistory) {
      series.points.splice(0, series.points.length - this.maximumPnlHistory);
    }
    return series.points;
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
    this.emit("telemetry", { kind: "health", atMs: nowMs, payload: this.snapshotValue } satisfies TelemetryRecord);
    for (const order of this.snapshotValue.orders) {
      if (!order.historical) this.emit("telemetry", { kind: "order", atMs: nowMs, payload: order } satisfies TelemetryRecord);
    }
    for (const position of this.snapshotValue.positions) this.emit("telemetry", { kind: "position", atMs: nowMs, payload: position } satisfies TelemetryRecord);
    if (nowMs - this.lastMarketTelemetryMs >= this.marketSampleMs) {
      this.lastMarketTelemetryMs = nowMs;
      for (const market of this.snapshotValue.markets) this.emit("telemetry", { kind: "market", atMs: nowMs, payload: market } satisfies TelemetryRecord);
    }
  }
}

function projectRule(rule: NonNullable<EngineMarketSnapshot["ruleEvaluation"]>["long"]): DashboardMarketCard["longRule"] {
  return {
    side: rule.side, phase: rule.phase, score: rule.score,
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
    persistencePass: rule.persistencePass, antiChasePass: rule.antiChasePass, exposurePass: rule.exposurePass,
    cooldownPass: rule.cooldownPass, costPass: rule.costPass,
    arbitrationPass: rule.arbitrationPass, tradeThresholdBps: rule.tradeThresholdBps,
    stressThresholdBps: rule.stressThresholdBps, liquidityReasons: [...rule.liquidityReasons], reasons: [...rule.reasons],
  };
}

function emptySnapshot(): DashboardSnapshot {
  return { version: 1, generatedAtMs: Date.now(), mode: "offline", paper: true, strategyVersion: "-", modelVersion: "-",
    configurationVersion: "-", signalMode: "DETERMINISTIC_ONLY", started: false,
    uptimeMs: 0, overall: "degraded", entriesAllowed: false, haltReasons: [], equity: 0, equityHighWater: 0, realizedSessionPnl: 0,
    latencyP95Ms: 0, liveness: [], database: disabledDatabaseHealth(), markets: [], positions: [], orders: [], events: [] };
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
function statusLabel(status: string): string { return status.toLowerCase().replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase()); }
function orderStatusLabel(status: string, cancellationReason: string | null): string {
  if (status === "CANCELED" && cancellationReason) return statusLabel(cancellationReason);
  if (status === "CANCEL_PENDING" && cancellationReason) return `Cancel pending: ${statusLabel(cancellationReason)}`;
  return statusLabel(status);
}
function statusSeverity(status: string): EventSeverity { return ["REJECTED", "UNKNOWN"].includes(status) ? "critical" : ["CANCELED", "EXPIRED", "CANCEL_PENDING"].includes(status) ? "warning" : "info"; }
function severityFor(type: string): EventSeverity { const value = type.toLowerCase(); return value.includes("error") || value.includes("fault") || value.includes("rejected") ? "critical" : value.includes("cancel") || value.includes("exit") || value.includes("disconnect") ? "warning" : "info"; }
function summarize(type: string, payload: unknown, symbol: string | null): string {
  const reason = findString(payload, ["reason", "decision.reason", "message"]);
  const action = findString(payload, ["decision.action", "action", "event"]);
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
