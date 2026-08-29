import type { DashboardOrderCard, OrderTimelineEntry } from "../dashboard/types.js";
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

/** Converts the simulator's authoritative state into the dashboard/database representation. */
export function projectKrakenPaperHistory(history: KrakenPaperHistory, nowMs = Date.now()): ProjectedKrakenPaperHistory {
  const orders = history.orders.flatMap((order) => projectOrder(order, nowMs));
  const orderByRemoteId = new Map(history.orders.map((order) => [order.remote.id, order]));
  const cumulativeFillByOrder = new Map<string, number>();
  const activities = [...history.activities].sort((left, right) => activityTime(left) - activityTime(right));
  const fills: HistoricalFillRecord[] = [];
  for (const activity of activities) {
    if (activity.activity_type !== "FILL" || !activity.order_id) continue;
    const order = orderByRemoteId.get(activity.order_id);
    if (!order) continue;
    const qty = Number(activity.qty), price = Number(activity.price), atMs = activityTime(activity);
    if (!(qty > 0) || !(price > 0) || !Number.isFinite(atMs)) continue;
    const cumulative = (cumulativeFillByOrder.get(activity.order_id) ?? 0) + qty;
    cumulativeFillByOrder.set(activity.order_id, cumulative);
    const remoteFilledQty = Number(order.remote.filled_qty);
    fills.push({
      id: activity.id,
      clientOrderId: order.plan.clientOrderId,
      symbol: order.plan.symbol,
      side: order.plan.side,
      qty,
      price,
      final: order.remote.status === "filled" && cumulative + quantityTolerance(remoteFilledQty) >= remoteFilledQty,
      atMs,
    });
  }
  return { orders, fills };
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
function statusLabel(status: string): string {
  return status.toLowerCase().replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}
function quantityTolerance(qty: number): number { return Math.max(1e-8, Math.abs(qty) * 1e-6); }
