import type { ExecutionPlan } from "./planner.js";

export type LocalOrderStatus = "RESERVED" | "SENDING" | "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCEL_PENDING" | "CANCELED" | "REJECTED" | "EXPIRED" | "UNKNOWN";
export type OrderCancelRequestReason =
  | "TTL_EXPIRED"
  | "MAKER_EXIT_FALLBACK"
  | "SIGNAL_INVALIDATED"
  | "COST_INVALIDATED"
  | "ADVERSE_FLOW"
  | "STALE_BOOK"
  | "KINEMATICS_UNAVAILABLE"
  | "POSITION_ALREADY_OPEN"
  | "POSITION_PROTECTION"
  | "BOOK_INVALID"
  | "NON_FINITE_FEATURES"
  | "PUBLIC_STREAM_DOWN"
  | "PRIVATE_STREAM_DOWN"
  | "PROCESS_STALL";
export type OrderCancellationReason = OrderCancelRequestReason
  | "IOC_NO_FILL"
  | "PARTIAL_REMAINDER_CANCELED"
  | "VENUE_CANCELED";
export interface TrackedOrder {
  plan: ExecutionPlan;
  venueOrderId?: string;
  status: LocalOrderStatus;
  filledQty: number;
  averageFillPx: number;
  lastUpdateMs: number;
  error?: string;
  cancelRequestReason?: OrderCancelRequestReason;
  cancellationReason?: OrderCancellationReason;
}
export interface RemoteOrderSnapshot {
  id: string;
  clientOrderId: string;
  filledQty: number;
  averageFillPx?: number;
  status: string;
  updatedMs?: number;
}
export interface PrivateOrderEvent { id: string; event: string; orderId: string; clientOrderId: string; symbol: string; filledQty: number; eventQty: number; eventPx: number; timestampMs: number; positionQty?: number; }
export interface FillDelta { symbol: string; side: 1 | -1; qty: number; price: number; clientOrderId: string; final: boolean; positionQty?: number; }

export class OrderStateReconciler {
  private readonly orders = new Map<string, TrackedOrder>();
  private readonly privateEventIds = new Set<string>();
  public reserve(plan: ExecutionPlan): void {
    if (this.hasPendingEntry(plan.symbol)) throw new Error(`Pending order already exists for ${plan.symbol}`);
    this.orders.set(plan.clientOrderId, { plan, status: "RESERVED", filledQty: 0, averageFillPx: 0, lastUpdateMs: plan.createdMs });
  }
  public markSending(clientOrderId: string): void { const order = this.must(clientOrderId); order.status = "SENDING"; order.lastUpdateMs = Date.now(); }
  public markAccepted(clientOrderId: string, venueOrderId: string, nowMs: number): void {
    const order = this.must(clientOrderId);
    order.venueOrderId = venueOrderId;
    // A marketable IOC can fill on the private stream before the POST response
    // reaches us. The acknowledgment must never regress that newer state.
    if (["RESERVED", "SENDING", "UNKNOWN"].includes(order.status)) order.status = "OPEN";
    order.lastUpdateMs = Math.max(order.lastUpdateMs, nowMs);
  }
  public markSendUnknown(clientOrderId: string, error: unknown): void { const order = this.must(clientOrderId); order.status = "UNKNOWN"; order.error = error instanceof Error ? error.message : String(error); order.lastUpdateMs = Date.now(); }
  public requestCancel(clientOrderId: string, reason: OrderCancelRequestReason, nowMs = Date.now()): void {
    const order = this.must(clientOrderId);
    order.cancelRequestReason ??= reason;
    if (["OPEN", "PARTIALLY_FILLED"].includes(order.status)) {
      order.status = "CANCEL_PENDING";
      order.lastUpdateMs = Math.max(order.lastUpdateMs, nowMs);
    }
  }
  public apply(event: PrivateOrderEvent): FillDelta | null {
    if (this.privateEventIds.has(event.id)) return null;
    this.privateEventIds.add(event.id);
    if (this.privateEventIds.size > 100_000) this.privateEventIds.clear();
    const order = this.orders.get(event.clientOrderId);
    if (!order) return null;
    order.venueOrderId = event.orderId;
    order.lastUpdateMs = event.timestampMs;
    const previousFilled = order.filledQty;
    order.filledQty = Math.max(order.filledQty, event.filledQty);
    if (event.eventPx > 0 && order.filledQty > 0) order.averageFillPx = event.eventPx;
    // A cancel/replace rejection describes the attempted mutation, not the
    // underlying order. Preserve the last authoritative order state until the
    // fill stream or REST reconciliation supplies a newer one.
    if (!["order_cancel_rejected", "order_replace_rejected"].includes(event.event)) {
      order.status = this.mapStatus(event.event, order.filledQty, order.plan.qty);
    }
    if (order.status === "CANCELED") order.cancellationReason = this.classifyCancellation(order, "VENUE_CANCELED");
    const deltaQty = event.eventQty > 0 ? event.eventQty : Math.max(0, order.filledQty - previousFilled);
    if (deltaQty <= 0 || !["partial_fill", "fill"].includes(event.event)) return null;
    return { symbol: event.symbol, side: order.plan.side, qty: deltaQty, price: event.eventPx, clientOrderId: event.clientOrderId,
      final: event.event === "fill", ...(event.positionQty !== undefined ? { positionQty: event.positionQty } : {}) };
  }
  public reconcileOrder(remote: RemoteOrderSnapshot): TrackedOrder | undefined {
    const tracked = this.orders.get(remote.clientOrderId);
    if (!tracked) return undefined;
    tracked.venueOrderId = remote.id;
    tracked.filledQty = Math.max(tracked.filledQty, remote.filledQty);
    if (remote.averageFillPx !== undefined && remote.averageFillPx > 0) tracked.averageFillPx = remote.averageFillPx;
    tracked.status = this.mapStatus(remote.status, tracked.filledQty, tracked.plan.qty);
    if (tracked.status === "CANCELED") tracked.cancellationReason = this.classifyCancellation(tracked, "VENUE_CANCELED");
    if (remote.updatedMs !== undefined && Number.isFinite(remote.updatedMs)) {
      tracked.lastUpdateMs = Math.max(tracked.lastUpdateMs, remote.updatedMs);
    }
    return tracked;
  }
  public reconcile(openOrders: readonly RemoteOrderSnapshot[]): void {
    const byClient = new Map(openOrders.map((order) => [order.clientOrderId, order]));
    for (const [clientId] of this.orders) {
      const remote = byClient.get(clientId);
      if (remote) this.reconcileOrder(remote);
    }
  }
  public hasPendingEntry(symbol: string): boolean {
    return [...this.orders.values()].some((order) => order.plan.symbol === symbol && ["RESERVED", "SENDING", "OPEN", "PARTIALLY_FILLED", "CANCEL_PENDING", "UNKNOWN"].includes(order.status));
  }
  public get(clientOrderId: string): TrackedOrder | undefined { return this.orders.get(clientOrderId); }
  public all(): readonly TrackedOrder[] { return [...this.orders.values()]; }
  private must(clientOrderId: string): TrackedOrder { const order = this.orders.get(clientOrderId); if (!order) throw new Error(`Unknown client order ${clientOrderId}`); return order; }
  private classifyCancellation(order: TrackedOrder, fallback: OrderCancellationReason): OrderCancellationReason {
    if (order.filledQty > 0 && order.filledQty < order.plan.qty) return "PARTIAL_REMAINDER_CANCELED";
    if (order.cancelRequestReason) return order.cancelRequestReason;
    if (order.plan.timeInForce === "ioc") return "IOC_NO_FILL";
    return fallback;
  }
  private mapStatus(event: string, filled: number, requested: number): LocalOrderStatus {
    if (["fill", "filled"].includes(event) || filled >= requested) return "FILLED";
    if (event === "canceled") return "CANCELED";
    if (event === "expired") return "EXPIRED";
    if (["rejected", "order_replace_rejected", "order_cancel_rejected", "suspended"].includes(event)) return "REJECTED";
    if (["partial_fill", "partially_filled"].includes(event) || filled > 0) return "PARTIALLY_FILLED";
    if (["new", "accepted", "pending_new", "replaced"].includes(event)) return "OPEN";
    if (["pending_cancel", "pending_replace"].includes(event)) return "CANCEL_PENDING";
    return "UNKNOWN";
  }
}
