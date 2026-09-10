import { applySpotFill, createSpotAccount, markSpotAccount, type SpotAccount, type SpotFill } from "../spot-trend/account.js";
import type { SpotPaperDecision, SpotPaperState } from "../spot-trend/paper.js";
import type { SpotPaperOrder } from "../spot-trend/orders.js";

export type SpotActivityAccountTotals = Pick<SpotAccount, "initialCashUsd" | "cashUsd" | "quantity" | "entryCostUsd" | "realizedNetUsd" | "feesUsd">;
export interface SpotCommittedActivityCycle {
  before: { account: SpotActivityAccountTotals; startedAtMs: number; lastCycleMs: number; cycles: number };
  after: { account: SpotActivityAccountTotals; startedAtMs: number; lastCycleMs: number; cycles: number };
  decision: SpotPaperDecision;
  market?: { book?: { bids: [number, number][]; receivedAtMs: number } };
  recordedAtMs: number;
  phase?: string;
}
export interface SpotPositionActivityEvent {
  id: string;
  timestampMs: number;
  type: string;
  orderId?: string;
  cycle?: number;
  reason?: string;
  quantity?: number;
  markPrice?: number | null;
  totalNetUsd?: number | null;
  realizedNetUsd?: number;
  unrealizedNetUsd?: number | null;
}
export interface SpotPositionActivity {
  orderId: string;
  entryOrderId: string;
  direction: "LONG";
  intent: "OPEN_LONG" | "CLOSE_LONG";
  positionStatus: "OPEN" | "EXIT_PENDING" | "PARTIALLY_EXITED" | "CLOSED";
  openedAtMs: number;
  closedAtMs: number | null;
  remainingQuantity: number;
  remainingEntryCostUsd: number;
  realizedNetUsd: number;
  unrealizedNetUsd: number | null;
  totalNetUsd: number | null;
  markPrice: number | null;
  markAtMs: number | null;
  events: SpotPositionActivityEvent[];
}

interface Episode {
  entryOrder: SpotPaperOrder;
  linkedOrders: SpotPaperOrder[];
  entryCount: number;
  exitCount: number | null;
  openedAtMs: number;
  closedAtMs: number | null;
  priorRealizedNetUsd: number;
  remainingQuantity: number;
  remainingEntryCostUsd: number;
  realizedNetUsd: number;
  partialExit: boolean;
  events: Map<string, SpotPositionActivityEvent>;
  latestMark: { cycleAtMs: number; price: number | null; atMs: number | null; unrealizedNetUsd: number | null } | null;
}
const TOTAL_FIELDS = ["initialCashUsd", "cashUsd", "quantity", "entryCostUsd", "realizedNetUsd", "feesUsd"] as const;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const timestamp = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0;
const near = (left: number, right: number): boolean => finite(left) && finite(right)
  && Math.abs(left - right) <= 32 * Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
const sameTotals = (left: SpotActivityAccountTotals, right: SpotActivityAccountTotals): boolean => !!left && !!right
  && TOTAL_FIELDS.every(field => near(left[field], right[field]));
const sameFill = (left: SpotFill, right: SpotFill): boolean => left.id === right.id && left.side === right.side
  && left.quantity === right.quantity && left.price === right.price && left.timestampMs === right.timestampMs && left.feeBps === right.feeBps;

function addEvent(episode: Episode, event: SpotPositionActivityEvent): void {
  const previous = episode.events.get(event.id);
  if (previous && JSON.stringify(previous) !== JSON.stringify(event)) throw new Error("SPOT_ACTIVITY_CONFLICTING_EVENT");
  episode.events.set(event.id, event);
}

/** Pure display projection. Receipts define episodes; polling creates no activity. */
export function projectSpotOrderActivity(state: SpotPaperState, cycles: readonly SpotCommittedActivityCycle[]): Record<string, SpotPositionActivity> {
  if (!state || !Array.isArray(state.orders) || !Array.isArray(state.account?.receipts) || !Array.isArray(cycles)
    || !timestamp(state.lastCycleMs)) throw new Error("SPOT_ACTIVITY_INVALID_STATE");
  markSpotAccount(state.account, 1, 0);
  const ordersByFill = new Map<string, SpotPaperOrder>(), orderIds = new Set<string>();
  for (const order of state.orders) {
    if (!order || typeof order.orderId !== "string" || orderIds.has(order.orderId) || !order.request
      || !["buy", "sell"].includes(order.request.side) || !timestamp(order.request.createdAtMs) || !Array.isArray(order.events))
      throw new Error("SPOT_ACTIVITY_INVALID_ORDER");
    orderIds.add(order.orderId);
    for (const event of order.events) if (!event || !timestamp(event.timestampMs) || typeof event.type !== "string")
      throw new Error("SPOT_ACTIVITY_INVALID_ORDER_EVENT");
    if (order.fill) {
      if (ordersByFill.has(order.fill.id) || !["FILLED", "CANCELED"].includes(order.status)
        || order.fill.side !== order.request.side || order.filledQuantity !== order.fill.quantity
        || order.averageFillPrice !== order.fill.price || !near(order.feeUsd, order.fill.quantity * order.fill.price * order.fill.feeBps / 10_000))
        throw new Error("SPOT_ACTIVITY_ORDER_FILL_MISMATCH");
      ordersByFill.set(order.fill.id, order);
    } else if (order.filledQuantity !== 0) throw new Error("SPOT_ACTIVITY_ORDER_FILL_MISMATCH");
  }
  if (ordersByFill.size !== state.account.receipts.length) throw new Error("SPOT_ACTIVITY_RECEIPT_COUNT_MISMATCH");
  const prefixes: SpotAccount[] = [createSpotAccount(state.account.initialCashUsd)], episodes: Episode[] = [];
  let active: Episode | null = null;
  const linked = new Map<string, Episode>();
  for (const [index, fill] of state.account.receipts.entries()) {
    const order = ordersByFill.get(fill.id);
    if (!order?.fill || !sameFill(fill, order.fill)) throw new Error("SPOT_ACTIVITY_RECEIPT_MISMATCH");
    const before = prefixes.at(-1)!, after = applySpotFill(before, fill); prefixes.push(after);
    if (fill.side === "buy") {
      if (active || before.quantity !== 0) throw new Error("SPOT_ACTIVITY_POSITION_ADDITION_UNSUPPORTED");
      active = { entryOrder: order, linkedOrders: [order], entryCount: index + 1, exitCount: null,
        openedAtMs: fill.timestampMs, closedAtMs: null, priorRealizedNetUsd: before.realizedNetUsd,
        remainingQuantity: after.quantity, remainingEntryCostUsd: after.entryCostUsd, realizedNetUsd: 0,
        partialExit: false, events: new Map(), latestMark: null };
      episodes.push(active); linked.set(order.orderId, active);
    } else {
      if (!active) throw new Error("SPOT_ACTIVITY_EXIT_WITHOUT_POSITION");
      active.linkedOrders.push(order); linked.set(order.orderId, active);
      active.remainingQuantity = after.quantity; active.remainingEntryCostUsd = after.entryCostUsd;
      active.realizedNetUsd = after.realizedNetUsd - active.priorRealizedNetUsd;
      active.partialExit = after.quantity > 0;
      if (after.quantity === 0) { active.closedAtMs = fill.timestampMs; active.exitCount = index + 1; active = null; }
    }
  }
  if (!sameTotals(prefixes.at(-1)!, state.account)) throw new Error("SPOT_ACTIVITY_ACCOUNT_RECONCILIATION_FAILED");
  // An unfilled reduction belongs only to the episode holding inventory when it was requested.
  for (const order of state.orders) {
    if (linked.has(order.orderId) || order.request.side !== "sell") continue;
    const episode = episodes.find(candidate => order.request.createdAtMs >= candidate.openedAtMs
      && (candidate.closedAtMs === null || order.request.createdAtMs <= candidate.closedAtMs));
    if (episode) { episode.linkedOrders.push(order); linked.set(order.orderId, episode); }
  }
  for (const episode of episodes) for (const order of episode.linkedOrders) for (const [index, event] of order.events.entries()) {
    addEvent(episode, { id: `${order.orderId}:lifecycle:${index}:${event.type}:${event.timestampMs}`,
      timestampMs: event.timestampMs, type: event.type, orderId: order.orderId,
      ...(event.detail ? { reason: event.detail } : {}),
      ...(["FILLED", "PARTIAL_FILL"].includes(event.type) && order.fill ? { quantity: order.fill.quantity } : {}) });
  }
  const prefixFor = (totals: SpotActivityAccountTotals, atMs: number): number => {
    for (let index = prefixes.length - 1; index >= 0; index--) {
      if ((prefixes[index]!.receipts.at(-1)?.timestampMs ?? 0) <= atMs && sameTotals(prefixes[index]!, totals)) return index;
    }
    throw new Error("SPOT_ACTIVITY_CYCLE_ACCOUNT_MISMATCH");
  };
  const orderedCycles = [...cycles].sort((left, right) => left.recordedAtMs - right.recordedAtMs
    || (left.phase === "BROKER_SETTLEMENT" ? 1 : 0) - (right.phase === "BROKER_SETTLEMENT" ? 1 : 0));
  for (const cycle of orderedCycles) {
    if (!cycle?.before || !cycle.after || !cycle.decision || !timestamp(cycle.recordedAtMs)
      || cycle.recordedAtMs > state.lastCycleMs || cycle.after.lastCycleMs !== cycle.recordedAtMs
      || cycle.decision.timestampMs !== cycle.recordedAtMs || cycle.before.startedAtMs !== state.startedAtMs
      || cycle.after.startedAtMs !== state.startedAtMs || !Number.isSafeInteger(cycle.after.cycles) || cycle.after.cycles < 1)
      throw new Error("SPOT_ACTIVITY_INVALID_CYCLE");
    const beforeIndex = prefixFor(cycle.before.account, cycle.recordedAtMs), afterIndex = prefixFor(cycle.after.account, cycle.recordedAtMs);
    if (afterIndex < beforeIndex) throw new Error("SPOT_ACTIVITY_REVERSED_CYCLE_ACCOUNT");
    const episode = episodes.find(candidate => afterIndex >= candidate.entryCount
      && (candidate.exitCount === null || afterIndex <= candidate.exitCount)
      && cycle.recordedAtMs >= candidate.openedAtMs && (candidate.closedAtMs === null || cycle.recordedAtMs <= candidate.closedAtMs));
    if (!episode) continue;
    const account = prefixes[afterIndex]!, realizedNetUsd = account.realizedNetUsd - episode.priorRealizedNetUsd;
    const book = cycle.market?.book, bid = book?.bids?.[0]?.[0];
    const fresh = cycle.decision.mark !== null && !!book && timestamp(book.receivedAtMs) && book.receivedAtMs <= cycle.recordedAtMs
      && cycle.recordedAtMs - book.receivedAtMs <= 5_000 && finite(bid) && bid > 0;
    const calculatedMark = fresh ? markSpotAccount(account, bid!, episode.entryOrder.request.feeBps) : null;
    if (calculatedMark && (!cycle.decision.mark || (Object.keys(calculatedMark) as Array<keyof typeof calculatedMark>)
      .some(field => !near(calculatedMark[field], cycle.decision.mark![field])))) throw new Error("SPOT_ACTIVITY_MARK_MISMATCH");
    const unrealizedNetUsd = account.quantity === 0 ? 0 : calculatedMark?.unrealizedNetUsd ?? null;
    const markPrice = fresh ? bid! : null, markAtMs = fresh ? book!.receivedAtMs : null;
    episode.latestMark = { cycleAtMs: cycle.recordedAtMs, price: markPrice, atMs: markAtMs, unrealizedNetUsd };
    const type = cycle.phase === "BROKER_SETTLEMENT" ? "BROKER_SETTLEMENT" : "STRATEGY_EVALUATION";
    const orderId = cycle.decision.orderId && linked.get(cycle.decision.orderId) === episode ? cycle.decision.orderId : undefined;
    addEvent(episode, { id: `cycle:${cycle.after.startedAtMs}:${cycle.after.cycles}:${type}:${cycle.recordedAtMs}`,
      timestampMs: cycle.recordedAtMs, type, ...(orderId ? { orderId } : {}), cycle: cycle.after.cycles,
      reason: cycle.decision.reason, quantity: account.quantity, markPrice, realizedNetUsd, unrealizedNetUsd,
      totalNetUsd: unrealizedNetUsd === null ? null : realizedNetUsd + unrealizedNetUsd });
  }
  const result: Record<string, SpotPositionActivity> = Object.create(null) as Record<string, SpotPositionActivity>;
  for (const episode of episodes) {
    const closed = episode.closedAtMs !== null;
    const pendingExit = episode.linkedOrders.some(order => order.request.side === "sell" && ["SUBMITTED", "ACCEPTED"].includes(order.status));
    const positionStatus = closed ? "CLOSED" : pendingExit ? "EXIT_PENDING" : episode.partialExit ? "PARTIALLY_EXITED" : "OPEN";
    const knownMark = episode.latestMark && (closed || episode.latestMark.cycleAtMs === state.lastCycleMs) ? episode.latestMark : null;
    const unrealizedNetUsd = closed ? 0 : knownMark?.unrealizedNetUsd ?? null;
    const events = [...episode.events.values()].sort((left, right) => left.timestampMs - right.timestampMs
      || (left.type === "BROKER_SETTLEMENT" ? 1 : 0) - (right.type === "BROKER_SETTLEMENT" ? 1 : 0) || left.id.localeCompare(right.id));
    for (const order of episode.linkedOrders) result[order.orderId] = {
      orderId: order.orderId, entryOrderId: episode.entryOrder.orderId, direction: "LONG",
      intent: order.request.side === "buy" ? "OPEN_LONG" : "CLOSE_LONG", positionStatus,
      openedAtMs: episode.openedAtMs, closedAtMs: episode.closedAtMs, remainingQuantity: episode.remainingQuantity,
      remainingEntryCostUsd: episode.remainingEntryCostUsd, realizedNetUsd: episode.realizedNetUsd,
      unrealizedNetUsd, totalNetUsd: unrealizedNetUsd === null ? null : episode.realizedNetUsd + unrealizedNetUsd,
      markPrice: knownMark?.price ?? null, markAtMs: knownMark?.atMs ?? null, events: events.map(event => ({ ...event })) };
  }
  return result;
}
