import { createHash } from "node:crypto";
import { applySpotFill, markSpotAccount, planSpotPaperFill,
  type SpotAccount, type SpotFill, type SpotPaperBook, type SpotPaperRules } from "./account.js";

/** Orders belong to the local paper broker. No exchange credentials or transport are used. */
export interface SpotOrderRequest {
  clientOrderId: string;
  symbol: "BTC/USD";
  side: "buy" | "sell";
  quantity: number;
  limitPrice: number;
  timeInForce: "ioc";
  reduceOnly: boolean;
  createdAtMs: number;
  feeBps: number;
}

export type SpotPaperOrderStatus = "SUBMITTED" | "ACCEPTED" | "FILLED" | "CANCELED" | "REJECTED";
export interface SpotPaperOrderEvent {
  type: SpotPaperOrderStatus | "PARTIAL_FILL";
  timestampMs: number;
  detail?: string;
}
export interface SpotPaperOrder {
  request: SpotOrderRequest;
  orderId: string;
  status: SpotPaperOrderStatus;
  filledQuantity: number;
  averageFillPrice: number | null;
  feeUsd: number;
  rejectionReason: string | null;
  cancellationReason: string | null;
  events: SpotPaperOrderEvent[];
  fill: SpotFill | null;
}

export interface SpotOrderExecutionSnapshot {
  book: SpotPaperBook;
  rules: SpotPaperRules;
  /** Expected fee from the deployed policy, independently checked against the request. */
  feeBps: number;
}

export const SPOT_ORDER_SPEC = Object.freeze({ maximumLifetimeMs: 30_000, timeInForce: "ioc", mode: "PAPER" });

const REQUEST_KEYS = ["clientOrderId", "symbol", "side", "quantity", "limitPrice", "timeInForce", "reduceOnly", "createdAtMs", "feeBps"];
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const timestamp = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0
  && value <= 8_640_000_000_000_000;
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 160 && value.trim() === value;
const near = (a: number, b: number): boolean => Math.abs(a - b)
  <= 32 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
const aligned = (value: number, step: number): boolean => positive(value) && positive(step)
  && Number.isSafeInteger(Math.round(value / step)) && near(value / step, Math.round(value / step));
const orderIdFor = (request: SpotOrderRequest): string => `paper-spot-${createHash("sha256").update(request.clientOrderId).digest("hex").slice(0, 32)}`;
const fillIdFor = (order: SpotPaperOrder): string => order.request.clientOrderId;
const sameFill = (a: SpotFill, b: SpotFill): boolean => a.id === b.id && a.side === b.side && a.quantity === b.quantity
  && a.price === b.price && a.feeBps === b.feeBps && a.timestampMs === b.timestampMs;
const sameRequest = (a: SpotOrderRequest, b: SpotOrderRequest): boolean => REQUEST_KEYS.every(key =>
  a[key as keyof SpotOrderRequest] === b[key as keyof SpotOrderRequest]);

/** Invalid non-JSON values cannot be represented faithfully in a durable rejection. */
function serializableRequest(request: SpotOrderRequest): void {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || Object.keys(request).length !== REQUEST_KEYS.length || REQUEST_KEYS.some(key => !(key in request))
    || !identifier(request.clientOrderId) || !timestamp(request.createdAtMs)
    || ![request.quantity, request.limitPrice, request.feeBps].every(finite)
    || typeof request.symbol !== "string" || typeof request.side !== "string"
    || typeof request.timeInForce !== "string" || typeof request.reduceOnly !== "boolean")
    throw new Error("SPOT_UNSERIALIZABLE_ORDER_REQUEST");
}

function invalidRequest(request: SpotOrderRequest): string | null {
  if (request.symbol !== "BTC/USD") return "UNSUPPORTED_SYMBOL";
  if (!["buy", "sell"].includes(request.side)) return "INVALID_SIDE";
  if (request.timeInForce !== "ioc") return "UNSUPPORTED_TIME_IN_FORCE";
  if (!positive(request.quantity) || !positive(request.limitPrice)) return "INVALID_QUANTITY_OR_PRICE";
  if (request.feeBps < 0 || request.feeBps >= 10_000) return "INVALID_FEE";
  if (request.reduceOnly !== (request.side === "sell")) return "INVALID_REDUCE_ONLY";
  const notional = request.quantity * request.limitPrice;
  if (!positive(notional) || !positive(notional + notional * request.feeBps / 10_000)) return "INVALID_ORDER_ARITHMETIC";
  return null;
}

function accountRejection(request: SpotOrderRequest, account: SpotAccount): string | null {
  if (request.createdAtMs < (account.receipts.at(-1)?.timestampMs ?? 0)) return "REVERSED_REQUEST_TIME";
  if (request.side === "buy") {
    const notional = request.quantity * request.limitPrice;
    if (notional + notional * (request.feeBps / 10_000) > account.cashUsd) return "INSUFFICIENT_CASH_AT_LIMIT";
  } else if (request.quantity > account.quantity) return "INSUFFICIENT_INVENTORY";
  return null;
}

function validateAccount(account: SpotAccount): void {
  // The frozen ledger reconstructs untrusted JSON from every receipt before marking.
  markSpotAccount(account, 1, 0);
}

function validateOrder(order: SpotPaperOrder): void {
  if (!order || typeof order !== "object") throw new Error("SPOT_INVALID_ORDER_LEDGER");
  serializableRequest(order.request);
  if (order.orderId !== orderIdFor(order.request) || !Array.isArray(order.events) || !order.events.length
    || order.events[0]!.type !== "SUBMITTED" || order.events[0]!.timestampMs !== order.request.createdAtMs)
    throw new Error("SPOT_INVALID_ORDER_LEDGER");
  let prior = order.request.createdAtMs;
  for (const event of order.events) {
    if (!event || !timestamp(event.timestampMs) || event.timestampMs < prior
      || event.detail !== undefined && (typeof event.detail !== "string" || !event.detail.length))
      throw new Error("SPOT_INVALID_ORDER_EVENTS");
    prior = event.timestampMs;
  }
  const sequence = order.events.map(event => event.type).join(",");
  const expected = order.status === "SUBMITTED" ? "SUBMITTED" : order.status === "ACCEPTED" ? "SUBMITTED,ACCEPTED"
    : order.status === "REJECTED" ? "SUBMITTED,REJECTED" : order.status === "FILLED" ? "SUBMITTED,ACCEPTED,FILLED"
    : order.status === "CANCELED" ? order.fill ? "SUBMITTED,ACCEPTED,PARTIAL_FILL,CANCELED" : "SUBMITTED,ACCEPTED,CANCELED" : null;
  if (sequence !== expected || order.status !== "REJECTED" && invalidRequest(order.request) !== null)
    throw new Error("SPOT_INVALID_ORDER_TRANSITION");
  const rejection = order.status === "REJECTED", cancellation = order.status === "CANCELED";
  if (rejection ? !identifier(order.rejectionReason) || order.rejectionReason !== order.events.at(-1)!.detail : order.rejectionReason !== null)
    throw new Error("SPOT_INVALID_REJECTION_REASON");
  if (cancellation ? !identifier(order.cancellationReason) || order.cancellationReason !== order.events.at(-1)!.detail : order.cancellationReason !== null)
    throw new Error("SPOT_INVALID_CANCELLATION_REASON");
  if (order.fill) {
    const fill = order.fill, request = order.request;
    if (!["FILLED", "CANCELED"].includes(order.status) || fill.id !== fillIdFor(order) || fill.side !== request.side
      || !positive(fill.quantity) || fill.quantity > request.quantity || !positive(fill.price) || fill.feeBps !== request.feeBps
      || fill.timestampMs !== order.events[2]!.timestampMs || fill.timestampMs - request.createdAtMs > SPOT_ORDER_SPEC.maximumLifetimeMs
      || (request.side === "buy" ? fill.price > request.limitPrice : fill.price < request.limitPrice)
      || order.filledQuantity !== fill.quantity || order.averageFillPrice !== fill.price
      || order.feeUsd !== fill.quantity * fill.price * (fill.feeBps / 10_000)
      || (order.status === "FILLED" ? fill.quantity !== request.quantity : fill.quantity >= request.quantity))
      throw new Error("SPOT_ORDER_FILL_MISMATCH");
  } else if (order.status === "FILLED" || order.filledQuantity !== 0 || order.averageFillPrice !== null || order.feeUsd !== 0)
    throw new Error("SPOT_ORDER_FILL_MISMATCH");
}

/** Every receipt has exactly one terminal order, and every order fill has its receipt. */
export function validateSpotOrderLedger(orders: SpotPaperOrder[], account: SpotAccount): void {
  validateAccount(account);
  if (!Array.isArray(orders)) throw new Error("SPOT_INVALID_ORDER_LEDGER");
  const clients = new Set<string>(), ids = new Set<string>(), fills = new Map<string, SpotFill>();
  let pending = 0;
  for (const order of orders) {
    validateOrder(order);
    if (clients.has(order.request.clientOrderId) || ids.has(order.orderId)) throw new Error("SPOT_DUPLICATE_ORDER_ID");
    clients.add(order.request.clientOrderId); ids.add(order.orderId);
    if (["SUBMITTED", "ACCEPTED"].includes(order.status) && ++pending > 1) throw new Error("SPOT_MULTIPLE_PENDING_ORDERS");
    if (order.fill) fills.set(order.fill.id, order.fill);
  }
  if (fills.size !== account.receipts.length) throw new Error("SPOT_ORDER_RECEIPT_COUNT_MISMATCH");
  for (const receipt of account.receipts) {
    const fill = fills.get(receipt.id);
    if (!fill || !sameFill(fill, receipt)) throw new Error("SPOT_ORDER_RECEIPT_MISMATCH");
  }
}

/** Caller must durably persist this SUBMITTED transition before calling execution. */
export function submitSpotPaperOrder(existingOrders: SpotPaperOrder[], request: SpotOrderRequest, account: SpotAccount): SpotPaperOrder[] {
  validateSpotOrderLedger(existingOrders, account);
  serializableRequest(request);
  const previous = existingOrders.find(order => order.request.clientOrderId === request.clientOrderId);
  if (previous) {
    if (!sameRequest(previous.request, request)) throw new Error("SPOT_CONFLICTING_CLIENT_ORDER_ID");
    return existingOrders;
  }
  const reason = invalidRequest(request) ?? accountRejection(request, account)
    ?? (existingOrders.some(order => ["SUBMITTED", "ACCEPTED"].includes(order.status)) ? "PENDING_ORDER_EXISTS" : null);
  const order: SpotPaperOrder = { request: { ...request }, orderId: orderIdFor(request), status: reason ? "REJECTED" : "SUBMITTED",
    filledQuantity: 0, averageFillPrice: null, feeUsd: 0, rejectionReason: reason, cancellationReason: null,
    events: [{ type: "SUBMITTED", timestampMs: request.createdAtMs },
      ...(reason ? [{ type: "REJECTED" as const, timestampMs: request.createdAtMs, detail: reason }] : [])], fill: null };
  validateOrder(order);
  return [...existingOrders, order];
}

/** Explicit cancellation is durable through the same terminal event shape as IOC expiry. */
export function cancelSpotPaperOrder(order: SpotPaperOrder, reason: string, nowMs: number): SpotPaperOrder {
  validateOrder(order);
  if (!["SUBMITTED", "ACCEPTED"].includes(order.status)) return order;
  if (!identifier(reason) || !timestamp(nowMs) || nowMs < order.events.at(-1)!.timestampMs)
    throw new Error("SPOT_INVALID_ORDER_CANCELLATION");
  const events: SpotPaperOrderEvent[] = [...order.events,
    ...(order.status === "SUBMITTED" ? [{ type: "ACCEPTED" as const, timestampMs: nowMs }] : []),
    { type: "CANCELED", timestampMs: nowMs, detail: reason }];
  const canceled: SpotPaperOrder = { ...order, status: "CANCELED", cancellationReason: reason, events };
  validateOrder(canceled);
  return canceled;
}

/** Limit filtering removes depth; this cap never invents additional displayed liquidity. */
function boundedDepth(levels: [number, number][], request: SpotOrderRequest, lotSize: number): [number, number][] {
  // Half a lot of cap headroom prevents roundoff flooring one lot below the request.
  // The next executable lot still lies outside this cap. All retained depth is real.
  let remaining = (Math.round(request.quantity / lotSize) + 0.5) * lotSize * 20;
  const result: [number, number][] = [];
  for (const [price, displayed] of levels) {
    if (request.side === "buy" ? price > request.limitPrice : price < request.limitPrice) break;
    const quantity = Math.min(displayed, remaining);
    if (quantity <= 0) break;
    result.push([price, quantity]);
    remaining -= quantity;
  }
  return result;
}

/** Pure IOC matching: accepted events and account/receipt changes commit together. */
export function executeSpotPaperOrder(order: SpotPaperOrder, account: SpotAccount, snapshot: SpotOrderExecutionSnapshot,
  nowMs: number): { order: SpotPaperOrder; account: SpotAccount } {
  validateAccount(account); validateOrder(order);
  const previousFill = account.receipts.find(fill => fill.id === fillIdFor(order));
  if (!["SUBMITTED", "ACCEPTED"].includes(order.status)) {
    if (order.fill ? !previousFill || !sameFill(order.fill, previousFill) : previousFill !== undefined)
      throw new Error("SPOT_ORDER_RECEIPT_MISMATCH");
    return { order, account };
  }
  if (previousFill) throw new Error("SPOT_PENDING_ORDER_ALREADY_HAS_RECEIPT");
  if (!timestamp(nowMs) || nowMs < order.events.at(-1)!.timestampMs
    || nowMs < (account.receipts.at(-1)?.timestampMs ?? 0)) throw new Error("SPOT_INVALID_EXECUTION_CLOCK");
  const accepted: SpotPaperOrder = order.status === "ACCEPTED" ? order : { ...order, status: "ACCEPTED",
    events: [...order.events, { type: "ACCEPTED", timestampMs: nowMs }] };
  const cancel = (reason: string): { order: SpotPaperOrder; account: SpotAccount } => {
    const canceled: SpotPaperOrder = { ...accepted, status: "CANCELED", cancellationReason: reason,
      events: [...accepted.events, { type: "CANCELED", timestampMs: nowMs, detail: reason }] };
    validateOrder(canceled); return { order: canceled, account };
  };
  if (nowMs - order.request.createdAtMs > SPOT_ORDER_SPEC.maximumLifetimeMs) return cancel("REQUEST_EXPIRED");
  if (!snapshot || !finite(snapshot.feeBps) || snapshot.feeBps !== order.request.feeBps) return cancel("FEE_POLICY_MISMATCH");
  const { request } = order, { book, rules } = snapshot;
  const accountReason = accountRejection(request, account);
  // Other pending orders can consume cash or inventory after submission.
  if (accountReason) return cancel(accountReason);
  if (!rules || ![rules.lotSize, rules.minimumQuantity, rules.tickSize].every(positive)
    || !finite(rules.minimumNotionalUsd) || rules.minimumNotionalUsd < 0) return cancel("INVALID_RULES");
  if (!aligned(request.quantity, rules.lotSize) || !aligned(request.limitPrice, rules.tickSize)) return cancel("ORDER_RULE_STEP_MISMATCH");
  if (request.quantity < rules.minimumQuantity || request.quantity * request.limitPrice < rules.minimumNotionalUsd)
    return cancel("BELOW_MINIMUM_ORDER");
  // Validate the entire original book before filtering so malformed ignored depth cannot pass.
  const probe = planSpotPaperFill({ account, side: request.side, book, rules, nowMs, feeBps: request.feeBps,
    id: fillIdFor(order), ...(request.side === "sell" ? { quantity: request.quantity } : {}) });
  if (!probe.fill && probe.reason !== "BELOW_MINIMUM_EXECUTABLE_ORDER") return cancel(probe.reason);
  const levels = boundedDepth(request.side === "buy" ? book.asks : book.bids, request, rules.lotSize);
  if (!levels.length) return cancel("IOC_LIMIT_NOT_MARKETABLE");
  const limitedBook: SpotPaperBook = { ...book, ...(request.side === "buy" ? { asks: levels } : { bids: levels }) };
  const limitNotional = request.quantity * request.limitPrice;
  const plan = planSpotPaperFill({ account, side: request.side, book: limitedBook, rules, nowMs, feeBps: request.feeBps,
    id: fillIdFor(order), ...(request.side === "buy" ? { budgetUsd: limitNotional + limitNotional * (request.feeBps / 10_000) }
      : { quantity: request.quantity }) });
  if (!plan.fill) return cancel(plan.reason);
  const { fill } = plan;
  if (fill.quantity > request.quantity || (request.side === "buy" ? fill.price > request.limitPrice : fill.price < request.limitPrice))
    return cancel("EXECUTION_EXCEEDS_ORDER_LIMIT");
  const nextAccount = applySpotFill(account, fill), partial = fill.quantity < request.quantity;
  const filled: SpotPaperOrder = { ...accepted, status: partial ? "CANCELED" : "FILLED", fill,
    filledQuantity: fill.quantity, averageFillPrice: fill.price, feeUsd: fill.quantity * fill.price * (fill.feeBps / 10_000),
    cancellationReason: partial ? "IOC_UNFILLED_REMAINDER" : null,
    events: [...accepted.events, { type: partial ? "PARTIAL_FILL" : "FILLED", timestampMs: nowMs },
      ...(partial ? [{ type: "CANCELED" as const, timestampMs: nowMs, detail: "IOC_UNFILLED_REMAINDER" }] : [])] };
  validateOrder(filled);
  return { order: filled, account: nextAccount };
}
