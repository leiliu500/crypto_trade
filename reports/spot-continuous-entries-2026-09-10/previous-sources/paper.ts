import { createSpotAccount, markSpotAccount, type SpotAccount, type SpotFill } from "./account.js";
import { WEEK_MS } from "./data.js";
import type { SpotMarketSnapshot } from "./market.js";
import { reconstructSpotTrend, type SpotTrendSignal } from "./signal.js";
import { SPOT_TREND_SPEC as S } from "./spec.js";
import { submitSpotPaperOrder, executeSpotPaperOrder, cancelSpotPaperOrder, validateSpotOrderLedger,
  type SpotPaperOrder, type SpotOrderRequest } from "./orders.js";

export const SPOT_PAPER_SPEC = Object.freeze({
  version: "btc-spot-weekly-research-paper-runner-v2", mode: "RESEARCH_PAPER",
  cycleIntervalMs: 300_000, maximumBookAgeMs: 5_000, entryWindowMs: 3_600_000,
  signalCutoff: "CURRENT_NATIVE_WEEK_OPEN;ONLY_ALREADY_FINALIZED_PREVIOUS_SIGNALS;MATCHES_HISTORICAL_BASE_WEEK_DELAY",
  entries: "FIRST_HOUR_OF_NATIVE_WEEK_ONLY;NO_MIDWEEK_CATCH_UP;FIRST_PARTIAL_FILL_CONSUMES_ENTRY_NO_ADDITIONS",
  exits: "CURRENT_DELAYED_WEEKLY_CASH_STATE_OR_MISSING_HISTORY_OR_PERSISTENT_ACCOUNT_DRAWDOWN_HALT;RETRY_PARTIAL_EXITS_WITH_FRESH_BOOKS",
  execution: "DURABLE_SUBMITTED_PAPER_IOC_THEN_BROKER_ACCEPTANCE_FILL_OR_CANCEL;10_BPS_COLLAR;5_PERCENT_ELIGIBLE_DEPTH;NO_LIVE_EXCHANGE_ORDERS",
  interpretation: "FORWARD_RESEARCH_PAPER_ONLY;L2_SIMULATED_FILLS_ARE_NOT_OBSERVED_VENUE_FILLS;LIVE_TRADING_DISABLED",
} as const);

export interface SpotPaperDecision {
  timestampMs: number; action: "buy" | "sell" | "hold"; reason: string; fill: SpotFill | null;
  orderId?: string | null;
  signal: SpotTrendSignal; mark: ReturnType<typeof markSpotAccount> | null;
}
export interface SpotPaperState {
  version: typeof SPOT_PAPER_SPEC.version; mode: "RESEARCH_PAPER"; startedAtMs: number;
  lastCycleMs: number; cycles: number; account: SpotAccount; peakEquityUsd: number; halted: boolean;
  lastSignal: SpotTrendSignal | null; lastDecision: SpotPaperDecision | null; evidenceSha256: string;
  orders: SpotPaperOrder[];
}

export function createSpotPaperState(evidenceSha256: string, nowMs: number): SpotPaperState {
  if (!/^[a-f0-9]{64}$/.test(evidenceSha256) || !Number.isSafeInteger(nowMs) || nowMs <= 0)
    throw new Error("INVALID_SPOT_PAPER_START");
  return { version: SPOT_PAPER_SPEC.version, mode: "RESEARCH_PAPER", startedAtMs: nowMs, lastCycleMs: nowMs - 1,
    cycles: 0, account: createSpotAccount(S.initialCashUsd), peakEquityUsd: S.initialCashUsd,
    halted: false, lastSignal: null, lastDecision: null, evidenceSha256, orders: [] };
}

export function validateSpotPaperState(state: SpotPaperState): void {
  if (!state || state.version !== SPOT_PAPER_SPEC.version || state.mode !== "RESEARCH_PAPER"
    || !/^[a-f0-9]{64}$/.test(state.evidenceSha256) || !Number.isSafeInteger(state.startedAtMs) || state.startedAtMs <= 0
    || !Number.isSafeInteger(state.lastCycleMs) || state.lastCycleMs < state.startedAtMs - 1
    || !Number.isSafeInteger(state.cycles) || state.cycles < 0 || typeof state.halted !== "boolean"
    || !Number.isFinite(state.peakEquityUsd) || state.peakEquityUsd < S.initialCashUsd
    || state.account.initialCashUsd !== S.initialCashUsd || !Array.isArray(state.orders)
    || (state.cycles === 0) !== (state.lastDecision === null)
    || state.lastDecision !== null && state.lastDecision.timestampMs !== state.lastCycleMs)
    throw new Error("INVALID_SPOT_PAPER_STATE");
  // Validates and replays every persisted cash/inventory receipt without changing capital.
  markSpotAccount(state.account, 1, S.scenarios.base.feeBps);
  validateSpotOrderLedger(state.orders, state.account);
  if ((state.account.receipts.at(-1)?.timestampMs ?? 0) > state.lastCycleMs) throw new Error("SPOT_RECEIPT_AFTER_CYCLE");
}

export function prepareSpotPaperCycle(state: SpotPaperState, snapshot: SpotMarketSnapshot, nowMs: number): {
  state: SpotPaperState; decision: SpotPaperDecision;
} {
  validateSpotPaperState(state);
  if (!Number.isSafeInteger(nowMs) || nowMs < state.startedAtMs) throw new Error("INVALID_SPOT_PAPER_CLOCK");
  if (nowMs < state.lastCycleMs) throw new Error("SPOT_PAPER_REVERSED_CLOCK");
  if (nowMs === state.lastCycleMs) {
    if (!state.lastDecision) throw new Error("SPOT_PAPER_REVERSED_CLOCK");
    return { state, decision: state.lastDecision };
  }
  const weekOpenMs = Math.floor(nowMs / WEEK_MS) * WEEK_MS;
  const signal = reconstructSpotTrend(snapshot.bars, weekOpenMs);
  const pending = state.orders.find(order => ["SUBMITTED", "ACCEPTED"].includes(order.status));
  if (pending) {
    const decision: SpotPaperDecision = { timestampMs: nowMs, action: pending.request.side,
      reason: "PENDING_ORDER_RECOVERY", fill: null, signal, mark: null, orderId: pending.orderId };
    return { state: { ...state, cycles: state.cycles + 1, lastCycleMs: nowMs, lastSignal: signal, lastDecision: decision }, decision };
  }
  const unchanged = (reason: string): { state: SpotPaperState; decision: SpotPaperDecision } => {
    const decision: SpotPaperDecision = { timestampMs: nowMs, action: "hold", reason, fill: null, signal, mark: null };
    return { state: { ...state, lastCycleMs: nowMs, cycles: state.cycles + 1, lastSignal: signal, lastDecision: decision }, decision };
  };
  if (!Number.isSafeInteger(snapshot.book.receivedAtMs) || snapshot.book.receivedAtMs > nowMs
    || nowMs - snapshot.book.receivedAtMs > SPOT_PAPER_SPEC.maximumBookAgeMs
    || !Number.isSafeInteger(snapshot.retrievedAtMs) || snapshot.retrievedAtMs > nowMs)
    return unchanged("STALE_OR_FUTURE_BOOK");
  const expectedLastEnd = Math.floor((nowMs - 60_000) / WEEK_MS) * WEEK_MS;
  const historyAvailable = snapshot.bars.at(-1)?.endMs === expectedLastEnd && !snapshot.historyError;
  const bid = snapshot.book.bids[0]?.[0], ask = snapshot.book.asks[0]?.[0];
  if (!bid || !ask || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || bid >= ask)
    return unchanged("INVALID_BOOK");
  const account = state.account;
  const mark = markSpotAccount(account, bid, S.scenarios.base.feeBps);
  const peakEquityUsd = Math.max(state.peakEquityUsd, mark.liquidationEquityUsd);
  const halted = state.halted || mark.liquidationEquityUsd <= peakEquityUsd * (1 - S.maximumAccountDrawdownFraction);
  let action: SpotPaperDecision["action"] = "hold", reason = "HOLD_CASH", quantity: number | undefined;
  if (account.quantity > 0) {
    if (halted || !historyAvailable || signal.state === "cash") {
      action = "sell"; reason = halted ? "ACCOUNT_DRAWDOWN_HALT" : !historyAvailable ? "HISTORY_UNAVAILABLE_EXIT" : "WEEKLY_TREND_EXIT";
    }
    else {
      const cap = Math.min(S.maximumMarkedNotionalUsd, Math.max(0, mark.liquidationEquityUsd) * S.maximumMarkedEquityFraction);
      if (account.quantity * bid > cap) {
        action = "sell"; reason = "MARKED_NOTIONAL_CAP";
        const keep = Math.floor(cap / bid / snapshot.rules.lotSize) * snapshot.rules.lotSize;
        const reduce = account.quantity - keep;
        quantity = keep < snapshot.rules.minimumQuantity || keep * bid < snapshot.rules.minimumNotionalUsd
          || reduce < snapshot.rules.minimumQuantity || reduce * bid < snapshot.rules.minimumNotionalUsd
          ? account.quantity : account.quantity - keep;
      } else reason = "HOLD_SPOT_NO_ADDITIONS";
    }
  } else if (halted) reason = "ACCOUNT_DRAWDOWN_HALT";
  else if (!historyAvailable) reason = "HISTORY_UNAVAILABLE";
  else if (signal.state === "long") {
    if (account.receipts.some(fill => Math.floor(fill.timestampMs / WEEK_MS) * WEEK_MS === weekOpenMs)) reason = "WEEKLY_ENTRY_ALREADY_CONSUMED";
    else if (nowMs - weekOpenMs >= SPOT_PAPER_SPEC.entryWindowMs) reason = "NEXT_WEEK_ENTRY_WINDOW";
    else { action = "buy"; reason = "WEEKLY_TREND_ENTER"; }
  } else reason = signal.reason;
  let orders = state.orders, orderId: string | null = null;
  if (action !== "hold") {
    const budgetUsd = Math.min(account.cashUsd, S.maximumEntryPrincipalUsd,
      S.entryPrincipalEquityFraction * Math.max(0, mark.liquidationEquityUsd));
    if (action === "buy" && budgetUsd <= 0) { action = "hold"; reason = "NO_SPOT_ENTRY_CASH"; }
    else {
      const tick = snapshot.rules.tickSize, lot = snapshot.rules.lotSize;
      let limitPrice = (action === "buy" ? Math.floor(ask * 1.001 / tick) : Math.ceil(bid * .999 / tick)) * tick;
      const requested = action === "buy" ? budgetUsd / (limitPrice * (1 + S.scenarios.base.feeBps / 10_000))
        : Math.min(account.quantity, quantity ?? account.quantity);
      const requestedQuantity = Math.floor(requested / lot) * lot;
      if (action === "sell" && requestedQuantity > 0)
        limitPrice = Math.max(limitPrice, Math.ceil(snapshot.rules.minimumNotionalUsd / requestedQuantity / tick) * tick);
      if (!Number.isFinite(requestedQuantity) || requestedQuantity < snapshot.rules.minimumQuantity
        || requestedQuantity * limitPrice < snapshot.rules.minimumNotionalUsd || action === "sell" && limitPrice > bid) {
        reason = `${reason}:BELOW_MINIMUM_EXECUTABLE_ORDER`; action = "hold";
      } else {
        const request: SpotOrderRequest = { clientOrderId: `${SPOT_PAPER_SPEC.version}:${state.startedAtMs}:${state.cycles + 1}:${action}`,
          symbol: "BTC/USD", side: action, quantity: requestedQuantity, limitPrice, timeInForce: "ioc",
          reduceOnly: action === "sell", createdAtMs: nowMs, feeBps: S.scenarios.base.feeBps };
        orders = submitSpotPaperOrder(orders, request, account);
        const order = orders.at(-1)!; orderId = order.orderId;
        if (order.status === "REJECTED") { action = "hold"; reason = `${reason}:${order.rejectionReason}`; }
      }
    }
  }
  const decision: SpotPaperDecision = { timestampMs: nowMs, action, reason, fill: null, orderId, signal, mark };
  return { state: { ...state, account, orders, peakEquityUsd, halted, cycles: state.cycles + 1,
    lastCycleMs: nowMs, lastSignal: signal, lastDecision: decision }, decision };
}

/** Call only after the submitted request has been durably recorded. */
export function settleSpotPaperCycle(state: SpotPaperState, snapshot: SpotMarketSnapshot, nowMs: number): {
  state: SpotPaperState; decision: SpotPaperDecision;
} {
  validateSpotPaperState(state);
  if (!Number.isSafeInteger(nowMs) || nowMs < state.lastCycleMs || !state.lastDecision) throw new Error("INVALID_SPOT_SETTLEMENT_CLOCK");
  const pending = state.orders.find(order => ["SUBMITTED", "ACCEPTED"].includes(order.status));
  if (!pending) return { state, decision: state.lastDecision };
  const weekOpenMs = Math.floor(nowMs / WEEK_MS) * WEEK_MS;
  const signal = reconstructSpotTrend(snapshot.bars, weekOpenMs);
  const historyAvailable = !snapshot.historyError && snapshot.bars.at(-1)?.endMs === Math.floor((nowMs - 60_000) / WEEK_MS) * WEEK_MS;
  const buyInvalid = pending.request.side === "buy" && (!historyAvailable || state.halted || signal.state !== "long"
    || nowMs - weekOpenMs >= SPOT_PAPER_SPEC.entryWindowMs || Math.floor(pending.request.createdAtMs / WEEK_MS) * WEEK_MS !== weekOpenMs);
  const result = buyInvalid ? { order: cancelSpotPaperOrder(pending, "ENTRY_POLICY_INVALIDATED", nowMs), account: state.account }
    : executeSpotPaperOrder(pending, state.account, { book: snapshot.book, rules: snapshot.rules, feeBps: S.scenarios.base.feeBps }, nowMs);
  const orders = state.orders.map(order => order.orderId === pending.orderId ? result.order : order);
  const fresh = snapshot.book.receivedAtMs <= nowMs && nowMs - snapshot.book.receivedAtMs <= SPOT_PAPER_SPEC.maximumBookAgeMs;
  const bid = snapshot.book.bids[0]?.[0], ask = snapshot.book.asks[0]?.[0];
  const mark = fresh && bid && ask && bid > 0 && bid < ask ? markSpotAccount(result.account, bid, S.scenarios.base.feeBps) : null;
  const fill = result.order.fill;
  const decision: SpotPaperDecision = { ...state.lastDecision, timestampMs: nowMs, signal, fill, orderId: result.order.orderId,
    action: fill ? result.order.request.side : "hold", mark,
    reason: fill ? state.lastDecision.reason : `${state.lastDecision.reason}:${result.order.rejectionReason ?? result.order.cancellationReason ?? result.order.status}` };
  const next = { ...state, orders, account: result.account, lastCycleMs: nowMs, lastSignal: signal, lastDecision: decision };
  validateSpotPaperState(next);
  return { state: next, decision };
}

/** In-memory convenience for deterministic tests. The service persists between these phases. */
export function advanceSpotPaper(state: SpotPaperState, snapshot: SpotMarketSnapshot, nowMs: number) {
  const prepared = prepareSpotPaperCycle(state, snapshot, nowMs);
  return prepared.state === state ? prepared : settleSpotPaperCycle(prepared.state, snapshot, nowMs);
}
