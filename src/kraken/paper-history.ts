import type { DashboardLivePosition, DashboardOrderCard, DashboardPnlPoint, OrderTimelineEntry } from "../dashboard/types.js";
import type { OrderCancellationReason } from "../execution/order-state.js";
import type { KrakenPaperHistory, KrakenPaperHistoricalOrder } from "./paper-broker.js";

export interface HistoricalFillRecord {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: 1 | -1;
  qty: number;
  price: number;
  final: boolean;
  atMs: number;
}

export interface ProjectedKrakenPaperHistory {
  orders: readonly DashboardOrderCard[];
  fills: readonly HistoricalFillRecord[];
}

interface HistoricalReplayFill extends HistoricalFillRecord {
  order: KrakenPaperHistoricalOrder;
}

interface ReconstructedPosition {
  symbol: string;
  side: 1 | -1;
  qty: number;
  entryQty: number;
  entryNotional: number;
  entryFee: number;
  openedMs: number;
  firstEntryPx: number;
  lastPx: number;
  lastAtMs: number;
  grossPricePnl: number;
  exitQty: number;
  exitNotional: number;
  exitFee: number;
  entryOrderIds: string[];
  exitOrderIds: string[];
  involvedOrderIds: Set<string>;
  entryStyles: Set<string>;
  exitStyles: Set<string>;
  latestExitReason: string | null;
}

/** Converts the simulator's authoritative state into the dashboard/database representation. */
export function projectKrakenPaperHistory(history: KrakenPaperHistory, nowMs = Date.now()): ProjectedKrakenPaperHistory {
  const orders = history.orders.flatMap((order) => projectOrder(order, nowMs));
  const orderByRemoteId = new Map(history.orders.map((order) => [order.remote.id, order]));
  const cumulativeFillByOrder = new Map<string, number>();
  // The paper broker retains activities newest-first. Reverse their original
  // order when timestamps collide so replay still follows execution order.
  const activities = history.activities.map((activity, index) => ({ activity, index }))
    .sort((left, right) => comparableActivityTime(left.activity) - comparableActivityTime(right.activity)
      || right.index - left.index);
  const fills: HistoricalFillRecord[] = [];
  const replayFills: HistoricalReplayFill[] = [];
  for (const { activity } of activities) {
    if (activity.activity_type !== "FILL" || !activity.order_id) continue;
    const order = orderByRemoteId.get(activity.order_id);
    if (!order) continue;
    const qty = Number(activity.qty), price = Number(activity.price), atMs = activityTime(activity);
    if (!(qty > 0) || !(price > 0) || !Number.isFinite(atMs)) continue;
    const cumulative = (cumulativeFillByOrder.get(activity.order_id) ?? 0) + qty;
    cumulativeFillByOrder.set(activity.order_id, cumulative);
    const remoteFilledQty = Number(order.remote.filled_qty);
    const fill: HistoricalReplayFill = {
      id: activity.id,
      clientOrderId: order.plan.clientOrderId,
      symbol: order.plan.symbol,
      side: order.plan.side,
      qty,
      price,
      final: order.remote.status === "filled" && cumulative + quantityTolerance(remoteFilledQty) >= remoteFilledQty,
      atMs,
      order,
    };
    replayFills.push(fill);
    const { order: _order, ...record } = fill;
    fills.push(record);
  }
  reconstructHistoricalPositions(orders, replayFills, history, nowMs);
  return { orders, fills };
}

function reconstructHistoricalPositions(orders: DashboardOrderCard[], fills: readonly HistoricalReplayFill[],
  history: KrakenPaperHistory, nowMs: number): void {
  const cardsById = new Map(orders.map((order) => [order.clientOrderId, order]));
  const positions = new Map<string, ReconstructedPosition>();
  for (const fill of fills) {
    const plan = fill.order.plan;
    if (!plan.reduceOnlyIntent) {
      const current = positions.get(fill.symbol);
      if (!current) {
        positions.set(fill.symbol, {
          symbol: fill.symbol,
          side: fill.side,
          qty: fill.qty,
          entryQty: fill.qty,
          entryNotional: fill.qty * fill.price,
          entryFee: executionFee(fill, history),
          openedMs: fill.atMs,
          firstEntryPx: fill.price,
          lastPx: fill.price,
          lastAtMs: fill.atMs,
          grossPricePnl: 0,
          exitQty: 0,
          exitNotional: 0,
          exitFee: 0,
          entryOrderIds: [fill.clientOrderId],
          exitOrderIds: [],
          involvedOrderIds: new Set([fill.clientOrderId]),
          entryStyles: new Set([plan.style]),
          exitStyles: new Set(),
          latestExitReason: null,
        });
      } else if (current.side === fill.side) {
        current.qty += fill.qty;
        current.entryQty += fill.qty;
        current.entryNotional += fill.qty * fill.price;
        current.entryFee += executionFee(fill, history);
        current.lastPx = fill.price;
        current.lastAtMs = fill.atMs;
        appendUnique(current.entryOrderIds, fill.clientOrderId);
        current.involvedOrderIds.add(fill.clientOrderId);
        current.entryStyles.add(plan.style);
      }
      continue;
    }

    const current = positions.get(fill.symbol);
    if (!current || fill.side !== -current.side) continue;
    const closeQty = Math.min(current.qty, fill.qty);
    if (!(closeQty > 0)) continue;
    const entryPx = current.entryNotional / current.entryQty;
    current.grossPricePnl += current.side * (fill.price - entryPx) * closeQty;
    current.exitQty += closeQty;
    current.exitNotional += closeQty * fill.price;
    current.exitFee += executionFee(fill, history, closeQty);
    current.qty = Math.max(0, current.qty - closeQty);
    current.lastPx = fill.price;
    current.lastAtMs = fill.atMs;
    appendUnique(current.exitOrderIds, fill.clientOrderId);
    current.involvedOrderIds.add(fill.clientOrderId);
    current.exitStyles.add(plan.style);
    current.latestExitReason = plan.exitReason ?? current.latestExitReason;
    if (current.qty > quantityTolerance(current.entryQty)) continue;
    attachPosition(cardsById, current, closedPosition(current));
    positions.delete(fill.symbol);
  }
  for (const current of positions.values()) attachPosition(cardsById, current, activePosition(current, nowMs));
}

function closedPosition(position: ReconstructedPosition): DashboardLivePosition {
  const entryPx = position.entryNotional / position.entryQty;
  const closePx = position.exitNotional / position.exitQty;
  const realizedPnl = position.grossPricePnl - position.entryFee - position.exitFee;
  const realizedPnlBps = position.entryNotional > 0 ? realizedPnl / position.entryNotional * 10_000 : 0;
  const entryOrderId = position.entryOrderIds[0] ?? null;
  const exitOrderId = position.exitOrderIds.at(-1) ?? null;
  const pnlHistory: DashboardPnlPoint[] = [openingPoint(position)];
  pnlHistory.push({
    atMs: position.lastAtMs,
    currentPx: closePx,
    unrealizedPnl: realizedPnl,
    unrealizedPnlBps: realizedPnlBps,
    changePnl: realizedPnl,
    kind: "close",
  });
  return {
    active: false,
    closedAtMs: position.lastAtMs,
    openedMs: position.openedMs,
    ageMs: Math.max(0, position.lastAtMs - position.openedMs),
    qty: position.exitQty,
    entryPx,
    currentPx: closePx,
    unrealizedPnl: realizedPnl,
    unrealizedPnlBps: realizedPnlBps,
    realizedPnl,
    realizedPnlBps,
    realizedBreakdown: {
      grossPricePnl: position.grossPricePnl,
      entryFee: position.entryFee,
      exitFee: position.exitFee,
      realizedPnl,
      entryStyle: styleSummary(position.entryStyles),
      exitStyle: styleSummary(position.exitStyles),
    },
    closePx,
    entryOrderId,
    exitOrderId,
    phase: "CLOSED",
    latestAction: "EXIT",
    latestReason: position.latestExitReason ?? "RECONSTRUCTED_FROM_PAPER_FILLS",
    pnlHistory,
  };
}

function activePosition(position: ReconstructedPosition, nowMs: number): DashboardLivePosition {
  const entryPx = position.entryNotional / position.entryQty;
  const remainingEntryFee = position.entryFee * position.qty / position.entryQty;
  const unrealizedPnl = position.side * (position.lastPx - entryPx) * position.qty - remainingEntryFee;
  const remainingNotional = entryPx * position.qty;
  const unrealizedPnlBps = remainingNotional > 0 ? unrealizedPnl / remainingNotional * 10_000 : 0;
  const pnlHistory: DashboardPnlPoint[] = [openingPoint(position)];
  if (position.lastAtMs > position.openedMs) pnlHistory.push({
    atMs: position.lastAtMs,
    currentPx: position.lastPx,
    unrealizedPnl,
    unrealizedPnlBps,
    changePnl: unrealizedPnl,
    kind: "mark",
  });
  return {
    active: true,
    closedAtMs: null,
    openedMs: position.openedMs,
    ageMs: Math.max(0, nowMs - position.openedMs),
    qty: position.qty,
    entryPx,
    currentPx: position.lastPx,
    unrealizedPnl,
    unrealizedPnlBps,
    realizedPnl: null,
    realizedPnlBps: null,
    realizedBreakdown: null,
    closePx: null,
    entryOrderId: position.entryOrderIds[0] ?? null,
    exitOrderId: position.exitOrderIds.at(-1) ?? null,
    phase: "OPEN",
    latestAction: "MONITOR",
    latestReason: "RECONSTRUCTED_FROM_PAPER_FILLS",
    pnlHistory,
  };
}

function openingPoint(position: ReconstructedPosition): DashboardPnlPoint {
  return { atMs: position.openedMs, currentPx: position.firstEntryPx, unrealizedPnl: 0,
    unrealizedPnlBps: 0, changePnl: null, kind: "mark" };
}

function attachPosition(cardsById: ReadonlyMap<string, DashboardOrderCard>, position: ReconstructedPosition,
  linkedPosition: DashboardLivePosition): void {
  for (const clientOrderId of position.involvedOrderIds) {
    const card = cardsById.get(clientOrderId);
    if (card) card.livePosition = clonePosition(linkedPosition);
  }
}

function clonePosition(position: DashboardLivePosition): DashboardLivePosition {
  return { ...position,
    realizedBreakdown: position.realizedBreakdown ? { ...position.realizedBreakdown } : null,
    pnlHistory: position.pnlHistory.map((point) => ({ ...point })) };
}

function executionFee(fill: HistoricalReplayFill, history: KrakenPaperHistory, qty = fill.qty): number {
  const plan = fill.order.plan;
  const configured = plan.style === "maker"
    ? history.makerFeeBpsBySymbol[fill.symbol]
    : history.takerFeeBpsBySymbol[fill.symbol];
  const feeBps = Number.isFinite(configured) ? Math.max(0, configured ?? 0)
    : Number.isFinite(plan.expectedCost.feeBps) ? Math.max(0, plan.expectedCost.feeBps / 2) : 0;
  return qty * fill.price * feeBps / 10_000;
}

function styleSummary(styles: ReadonlySet<string>): string {
  return styles.size === 1 ? [...styles][0]! : [...styles].join(" + ") || "unknown";
}

function appendUnique(values: string[], value: string): void {
  if (values.at(-1) !== value) values.push(value);
}

function projectOrder(value: KrakenPaperHistoricalOrder, nowMs: number): DashboardOrderCard[] {
  const { plan, remote } = value;
  if (remote.client_order_id !== plan.clientOrderId || remote.symbol !== plan.symbol) return [];
  const requestedQty = Number(remote.qty ?? plan.qty);
  const filledQty = Number(remote.filled_qty);
  const averageFillPx = Number(remote.filled_avg_price ?? 0);
  const updatedMs = Date.parse(remote.updated_at);
  if (!(requestedQty > 0) || !Number.isFinite(filledQty) || filledQty < 0 || !Number.isFinite(updatedMs)) return [];
  const status = localStatus(remote.status, filledQty, requestedQty);
  const cancellationReason = inferCancellationReason(status, plan.timeInForce, filledQty, requestedQty);
  const timeline: OrderTimelineEntry[] = [{
    id: `kraken-paper-history:${plan.clientOrderId}:${status}`,
    status,
    label: cancellationReason ? statusLabel(cancellationReason) : statusLabel(status),
    atMs: updatedMs,
    severity: status === "REJECTED" ? "critical" : status === "CANCELED" || status === "EXPIRED" ? "warning" : "info",
  }];
  return [{
    clientOrderId: plan.clientOrderId,
    decisionId: plan.decisionId,
    alpacaOrderId: remote.id,
    historical: true,
    symbol: plan.symbol,
    side: plan.side,
    style: plan.style,
    entryFamily: plan.entryFamily ?? null,
    economicHorizonMs: plan.economicHorizonMs ?? null,
    executionPath: plan.executionPath ?? null,
    exitReason: plan.exitReason ?? null,
    fallbackFromClientOrderId: plan.fallbackFromClientOrderId ?? null,
    timeInForce: plan.timeInForce,
    status,
    statusLabel: cancellationReason ? statusLabel(cancellationReason) : statusLabel(status),
    terminal: ["FILLED", "CANCELED", "REJECTED", "EXPIRED"].includes(status),
    requestedQty,
    filledQty,
    remainingQty: Math.max(0, requestedQty - filledQty),
    fillPercent: Math.min(100, filledQty / requestedQty * 100),
    averageFillPx: averageFillPx > 0 ? averageFillPx : 0,
    limitPx: plan.limitPx,
    expectedValue: plan.expectedValue,
    fillProbability: plan.fillProbability,
    expectedCost: { ...plan.expectedCost },
    reduceOnlyIntent: plan.reduceOnlyIntent,
    createdMs: plan.createdMs,
    expiresMs: plan.expiresMs,
    updatedMs,
    ageMs: Math.max(0, nowMs - plan.createdMs),
    expiresInMs: plan.expiresMs - nowMs,
    error: remote.failed_at ? "Kraken paper order failed" : null,
    cancelRequestReason: null,
    cancellationReason,
    timeline,
    livePosition: null,
  }];
}

function localStatus(remoteStatus: string, filledQty: number, requestedQty: number): string {
  if (remoteStatus === "filled" || filledQty + quantityTolerance(requestedQty) >= requestedQty) return "FILLED";
  if (remoteStatus === "canceled") return "CANCELED";
  if (remoteStatus === "expired") return "EXPIRED";
  if (["rejected", "suspended"].includes(remoteStatus)) return "REJECTED";
  if (remoteStatus === "partially_filled" || filledQty > 0) return "PARTIALLY_FILLED";
  if (["new", "accepted", "pending_new", "replaced"].includes(remoteStatus)) return "OPEN";
  if (["pending_cancel", "pending_replace"].includes(remoteStatus)) return "CANCEL_PENDING";
  return "UNKNOWN";
}

function inferCancellationReason(status: string, timeInForce: string, filledQty: number,
  requestedQty: number): OrderCancellationReason | null {
  if (status !== "CANCELED") return null;
  if (filledQty > 0 && filledQty + quantityTolerance(requestedQty) < requestedQty) return "PARTIAL_REMAINDER_CANCELED";
  if (timeInForce === "ioc") return "IOC_NO_FILL";
  return "VENUE_CANCELED";
}

function activityTime(activity: { transaction_time?: string; date?: string }): number {
  return Date.parse(activity.transaction_time ?? activity.date ?? "");
}
function comparableActivityTime(activity: { transaction_time?: string; date?: string }): number {
  const atMs = activityTime(activity);
  return Number.isFinite(atMs) ? atMs : Number.POSITIVE_INFINITY;
}
function statusLabel(status: string): string {
  return status.toLowerCase().replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}
function quantityTolerance(qty: number): number { return Math.max(1e-8, Math.abs(qty) * 1e-6); }
