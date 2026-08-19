import type { ExecutionPlan } from "./planner.js";

export type LocalOrderStatus = "RESERVED" | "SENDING" | "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCEL_PENDING" | "CANCELED" | "REJECTED" | "EXPIRED" | "UNKNOWN";
export interface TrackedOrder { plan: ExecutionPlan; alpacaOrderId?: string; status: LocalOrderStatus; filledQty: number; averageFillPx: number; lastUpdateMs: number; error?: string; }
export interface PrivateOrderEvent { id: string; event: string; orderId: string; clientOrderId: string; symbol: string; filledQty: number; eventQty: number; eventPx: number; timestampMs: number; }
export interface FillDelta { symbol: string; side: 1 | -1; qty: number; price: number; clientOrderId: string; final: boolean; }

export class OrderStateReconciler {
  private readonly orders = new Map<string, TrackedOrder>();
  private readonly privateEventIds = new Set<string>();
  public reserve(plan: ExecutionPlan): void {
    if (this.hasPendingEntry(plan.symbol)) throw new Error(`Pending order already exists for ${plan.symbol}`);
    this.orders.set(plan.clientOrderId, { plan, status: "RESERVED", filledQty: 0, averageFillPx: 0, lastUpdateMs: plan.createdMs });
  }
  public markSending(clientOrderId: string): void { const order = this.must(clientOrderId); order.status = "SENDING"; order.lastUpdateMs = Date.now(); }
  public markAccepted(clientOrderId: string, alpacaOrderId: string, nowMs: number): void { const order = this.must(clientOrderId); order.alpacaOrderId = alpacaOrderId; order.status = "OPEN"; order.lastUpdateMs = nowMs; }
  public markSendUnknown(clientOrderId: string, error: unknown): void { const order = this.must(clientOrderId); order.status = "UNKNOWN"; order.error = error instanceof Error ? error.message : String(error); order.lastUpdateMs = Date.now(); }
  public requestCancel(clientOrderId: string): void { const order = this.must(clientOrderId); if (["OPEN", "PARTIALLY_FILLED"].includes(order.status)) order.status = "CANCEL_PENDING"; }
  public apply(event: PrivateOrderEvent): FillDelta | null {
    if (this.privateEventIds.has(event.id)) return null;
    this.privateEventIds.add(event.id);
    if (this.privateEventIds.size > 100_000) this.privateEventIds.clear();
    const order = this.orders.get(event.clientOrderId);
    if (!order) return null;
    order.alpacaOrderId = event.orderId;
    order.lastUpdateMs = event.timestampMs;
    const previousFilled = order.filledQty;
    order.filledQty = Math.max(order.filledQty, event.filledQty);
    if (event.eventPx > 0 && order.filledQty > 0) order.averageFillPx = event.eventPx;
    order.status = this.mapStatus(event.event, order.filledQty, order.plan.qty);
    const deltaQty = event.eventQty > 0 ? event.eventQty : Math.max(0, order.filledQty - previousFilled);
    if (deltaQty <= 0 || !["partial_fill", "fill"].includes(event.event)) return null;
    return { symbol: event.symbol, side: order.plan.side, qty: deltaQty, price: event.eventPx, clientOrderId: event.clientOrderId, final: event.event === "fill" };
  }
  public reconcile(openOrders: readonly { id: string; clientOrderId: string; filledQty: number; status: string }[]): void {
    const byClient = new Map(openOrders.map((order) => [order.clientOrderId, order]));
    for (const [clientId, tracked] of this.orders) {
      const remote = byClient.get(clientId);
      if (remote) { tracked.alpacaOrderId = remote.id; tracked.filledQty = remote.filledQty; tracked.status = this.mapStatus(remote.status, remote.filledQty, tracked.plan.qty); }
      else if (["UNKNOWN", "SENDING", "OPEN", "CANCEL_PENDING"].includes(tracked.status)) tracked.status = tracked.filledQty >= tracked.plan.qty ? "FILLED" : "CANCELED";
    }
  }
  public hasPendingEntry(symbol: string): boolean {
    return [...this.orders.values()].some((order) => order.plan.symbol === symbol && ["RESERVED", "SENDING", "OPEN", "PARTIALLY_FILLED", "CANCEL_PENDING", "UNKNOWN"].includes(order.status));
  }
  public get(clientOrderId: string): TrackedOrder | undefined { return this.orders.get(clientOrderId); }
  public all(): readonly TrackedOrder[] { return [...this.orders.values()]; }
  private must(clientOrderId: string): TrackedOrder { const order = this.orders.get(clientOrderId); if (!order) throw new Error(`Unknown client order ${clientOrderId}`); return order; }
  private mapStatus(event: string, filled: number, requested: number): LocalOrderStatus {
    if (event === "fill" || filled >= requested) return "FILLED";
    if (event === "partial_fill" || filled > 0) return "PARTIALLY_FILLED";
    if (["new", "accepted", "pending_new", "replaced"].includes(event)) return "OPEN";
    if (["pending_cancel", "pending_replace"].includes(event)) return "CANCEL_PENDING";
    if (event === "canceled") return "CANCELED";
    if (event === "expired") return "EXPIRED";
    if (["rejected", "order_replace_rejected", "order_cancel_rejected", "suspended"].includes(event)) return "REJECTED";
    return "UNKNOWN";
  }
}
