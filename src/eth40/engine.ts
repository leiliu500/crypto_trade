import { applySpotFill, createSpotAccount, markSpotAccount, planSpotPaperFill,
  type SpotAccount, type SpotPaperRules } from "../spot-trend/account.js";
import { DAY_MS, ETH40_SPEC as S } from "./spec.js";
import type { AccountId, Asset, CycleResult, DailyBar, Decision, MarketSnapshot,
  PaperPortfolio, PaperState, Valuation, VerifiedBook } from "./types.js";

export const ETH40_HISTORY_ANCHOR_MS = Date.UTC(2024, 8, 20);
const IDS: readonly AccountId[] = ["eth40", "passiveEth", "passiveBtc"];
const SYMBOLS: Record<AccountId, Asset> = { eth40: "ETH/USD", passiveEth: "ETH/USD", passiveBtc: "BTC/USD" };
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const positive = (x: unknown): x is number => finite(x) && x > 0;
const nonnegative = (x: unknown): x is number => finite(x) && x >= 0;
const timestamp = (x: unknown): x is number => nonnegative(x) && Number.isSafeInteger(x) && x <= 8_640_000_000_000_000;
const day = (time: number) => Math.floor(time / DAY_MS) * DAY_MS;
const near = (a: number, b: number) => Math.abs(a - b) <= 32 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
const fillId = (id: AccountId, dayMs: number, side: "buy" | "sell") => `${S.version}:${id}:${dayMs}:${side}`;

function reviewTime(start: number): number {
  const d = new Date(start), year = d.getUTCFullYear(), month = d.getUTCMonth() + S.reviewCalendarMonths;
  const date = Math.min(d.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return Date.UTC(year, month, date, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

export function createPaperState(startedAtMs: number): PaperState {
  if (!timestamp(startedAtMs) || !timestamp(reviewTime(startedAtMs))) throw new Error("ETH40_INVALID_START_TIME");
  const portfolios = Object.fromEntries(IDS.map(id => [id, {
    symbol: SYMBOLS[id], account: createSpotAccount(S.initialCashUsd), entered: false,
    lastFillDayMs: null, completedEpisodes: 0, peakLiquidationEquityUsd: S.initialCashUsd, maxDrawdownUsd: 0,
  }])) as Record<AccountId, PaperPortfolio>;
  return { version: S.version, startedAtMs, reviewAtMs: reviewTime(startedAtMs),
    firstExecutionDayMs: day(startedAtMs) + S.signalToExecutionDays * DAY_MS,
    lastCycleAtMs: startedAtMs, portfolios };
}

/** Reconcile all restored balances and the no-additions/one-fill-per-day policy. */
export function validatePaperState(state: PaperState): void {
  if (!state || state.version !== S.version || !timestamp(state.startedAtMs)
    || !timestamp(state.lastCycleAtMs) || state.lastCycleAtMs < state.startedAtMs
    || state.reviewAtMs !== reviewTime(state.startedAtMs)
    || state.firstExecutionDayMs !== day(state.startedAtMs) + S.signalToExecutionDays * DAY_MS
    || !state.portfolios || Object.keys(state.portfolios).sort().join() !== [...IDS].sort().join())
    throw new Error("ETH40_INVALID_STATE");
  for (const id of IDS) {
    const p = state.portfolios[id];
    if (!p || p.symbol !== SYMBOLS[id] || typeof p.entered !== "boolean"
      || !Number.isSafeInteger(p.completedEpisodes) || p.completedEpisodes < 0
      || !finite(p.peakLiquidationEquityUsd) || p.peakLiquidationEquityUsd < S.initialCashUsd
      || !nonnegative(p.maxDrawdownUsd) || p.maxDrawdownUsd > p.peakLiquidationEquityUsd
      || !p.account || p.account.initialCashUsd !== S.initialCashUsd || !Array.isArray(p.account.receipts))
      throw new Error("ETH40_INVALID_PORTFOLIO");
    let restored = createSpotAccount(S.initialCashUsd), buys = 0, completed = 0, latest: number | null = null;
    const receiptIds = new Set<string>(), days = new Set<number>();
    for (const fill of p.account.receipts) {
      if (!fill || !timestamp(fill.timestampMs)) throw new Error("ETH40_INVALID_RECEIPT");
      const date = day(fill.timestampMs);
      if (fill.timestampMs < state.firstExecutionDayMs || fill.timestampMs > state.lastCycleAtMs
        || fill.timestampMs - date >= S.executionWindowMs || days.has(date) || receiptIds.has(fill.id)
        || fill.id !== fillId(id, date, fill.side) || fill.feeBps !== (fill.side === "buy" ? S.entryFeeBps : S.exitFeeBps))
        throw new Error("ETH40_RECEIPT_POLICY_VIOLATION");
      if (fill.side === "buy") {
        const debit = fill.quantity * fill.price * (1 + fill.feeBps / 10_000);
        const cap = Math.min(S.maximumEntryUsd, restored.cashUsd * S.maximumEntryEquityFraction, restored.cashUsd);
        if (restored.quantity !== 0 || id !== "eth40" && buys > 0 || debit > cap && !near(debit, cap))
          throw new Error("ETH40_ADDITION_OR_ENTRY_CAP_VIOLATION");
        buys++;
      } else if (fill.side !== "sell" || id !== "eth40" || restored.quantity <= 0) {
        throw new Error("ETH40_INVALID_EXIT_RECEIPT");
      }
      restored = applySpotFill(restored, fill);
      if (fill.side === "sell" && restored.quantity === 0) completed++;
      receiptIds.add(fill.id); days.add(date); latest = date;
    }
    const fields: readonly (keyof Pick<SpotAccount, "cashUsd" | "quantity" | "entryCostUsd" | "realizedNetUsd" | "feesUsd">)[] =
      ["cashUsd", "quantity", "entryCostUsd", "realizedNetUsd", "feesUsd"];
    if (fields.some(key => !finite(p.account[key]) || !near(restored[key], p.account[key]))
      || p.entered !== (buys > 0) || p.completedEpisodes !== completed || p.lastFillDayMs !== latest)
      throw new Error("ETH40_STATE_RECEIPT_RECONCILIATION_FAILED");
    if (p.account.quantity === 0 && (p.peakLiquidationEquityUsd < p.account.cashUsd && !near(p.peakLiquidationEquityUsd, p.account.cashUsd)
      || p.maxDrawdownUsd < p.peakLiquidationEquityUsd - p.account.cashUsd
        && !near(p.maxDrawdownUsd, p.peakLiquidationEquityUsd - p.account.cashUsd)))
      throw new Error("ETH40_INVALID_FLAT_ACCOUNT_MARKS");
  }
}

interface Signal { target: "long" | "cash"; signalDayMs: number; sma40: number | null; close: number; volume: number }

/** Anchor the original warmup and hysteresis. Future rows are never consumed. */
function historyThrough(bars: DailyBar[], signalDayMs: number, nowMs: number): DailyBar[] {
  if (!Array.isArray(bars)) throw new Error("MISSING_HISTORY");
  const completed: DailyBar[] = [];
  for (const bar of bars) {
    if (!bar || !timestamp(bar.openTimeMs)) throw new Error("INVALID_HISTORY_TIMESTAMP");
    if (bar.openTimeMs < ETH40_HISTORY_ANCHOR_MS || bar.openTimeMs > signalDayMs) continue;
    if (bar.openTimeMs % DAY_MS !== 0 || bar.openTimeMs + DAY_MS + S.finalizationDelayMs > nowMs
      || ![bar.open, bar.high, bar.low, bar.close].every(positive) || !nonnegative(bar.volume)
      || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close)
      || bar.low > bar.high) throw new Error("INVALID_OR_UNFINALIZED_HISTORY");
    if (bar.openTimeMs !== ETH40_HISTORY_ANCHOR_MS + completed.length * DAY_MS)
      throw new Error("HISTORY_GAP_DUPLICATE_OR_REORDERED");
    completed.push(bar);
  }
  if (!completed.length || completed.at(-1)!.openTimeMs !== signalDayMs) throw new Error("MISSING_ELIGIBLE_SIGNAL_DAY");
  return completed;
}

function average(values: readonly number[]): number {
  // Compensated addition keeps the 40-close mean stable around strict boundaries.
  let sum = 0, correction = 0;
  for (const value of values) {
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
    sum = next;
  }
  return (sum + correction) / values.length;
}

export function deriveEth40Signal(bars: DailyBar[], nowMs: number): Signal {
  if (!timestamp(nowMs)) throw new Error("INVALID_SIGNAL_TIME");
  const signalDayMs = day(nowMs) - S.signalToExecutionDays * DAY_MS;
  const history = historyThrough(bars, signalDayMs, nowMs);
  let target: "long" | "cash" = "cash", sma40: number | null = null;
  for (let i = S.warmupBars; i < history.length; i++) {
    sma40 = average(history.slice(i - S.movingAverageDays + 1, i + 1).map(b => b.close));
    const close = history[i]!.close;
    if (close > sma40 * (1 + S.entryBandFraction)) target = "long";
    else if (close <= sma40) target = "cash";
  }
  const last = history.at(-1)!;
  return { target, signalDayMs, sma40, close: last.close, volume: last.volume };
}

function validRules(r: SpotPaperRules | undefined): r is SpotPaperRules {
  return !!r && [r.lotSize, r.minimumQuantity, r.tickSize].every(positive) && nonnegative(r.minimumNotionalUsd);
}

function quote(snapshot: MarketSnapshot, symbol: Asset): { book: VerifiedBook | null; reason: string; age: number | null } {
  const book = snapshot.books?.[symbol], now = snapshot.observedAtMs;
  const age = book && timestamp(book.receivedAtMs) && timestamp(book.exchangeUpdateAtMs)
    ? Math.max(0, now - book.receivedAtMs, now - book.exchangeUpdateAtMs) : null;
  const deny = (reason: string) => ({ book: null, reason, age });
  if (!book || book.symbol !== symbol || book.checksumValid !== true || typeof book.checksum !== "string" || !book.checksum
    || typeof book.connectionId !== "string" || !book.connectionId) return deny("UNVERIFIED_BOOK");
  if (!timestamp(book.receivedAtMs) || !timestamp(book.exchangeUpdateAtMs) || book.receivedAtMs > now
    || book.exchangeUpdateAtMs > now + S.maximumExchangeClockLeadMs || age === null || age > S.maximumQuoteAgeMs)
    return deny("STALE_OR_FUTURE_BOOK");
  for (const [levels, direction] of [[book.bids, -1], [book.asks, 1]] as const) {
    if (!Array.isArray(levels) || !levels.length || levels.some((level, i) => !Array.isArray(level) || level.length !== 2
      || !level.every(positive) || i > 0 && direction * (level[0] - levels[i - 1]![0]) <= 0))
      return deny("INVALID_BOOK");
  }
  if (book.bids[0]![0] >= book.asks[0]![0]) return deny("INVALID_BOOK");
  return { book, reason: "FRESH_VERIFIED_BOOK", age };
}

function valuation(id: AccountId, portfolio: PaperPortfolio, snapshot: MarketSnapshot): Valuation {
  const q = quote(snapshot, portfolio.symbol), account = portfolio.account;
  const known = account.quantity === 0 || q.book !== null;
  const equity = account.quantity === 0 ? account.cashUsd : q.book
    ? markSpotAccount(account, q.book.bids[0]![0], S.exitFeeBps).liquidationEquityUsd : null;
  if (equity !== null) {
    portfolio.peakLiquidationEquityUsd = Math.max(portfolio.peakLiquidationEquityUsd, equity);
    portfolio.maxDrawdownUsd = Math.max(portfolio.maxDrawdownUsd, portfolio.peakLiquidationEquityUsd - equity);
  }
  return { accountId: id, cashUsd: account.cashUsd, quantity: account.quantity,
    liquidationEquityUsd: equity, netPnlUsd: equity === null ? null : equity - account.initialCashUsd,
    realizedNetUsd: account.realizedNetUsd, feesUsd: account.feesUsd, quoteAgeMs: q.age, fresh: known };
}

export function runPaperCycle(previous: PaperState, snapshot: MarketSnapshot, cycleId: string): CycleResult {
  validatePaperState(previous);
  if (!snapshot || !timestamp(snapshot.observedAtMs) || snapshot.observedAtMs < previous.lastCycleAtMs
    || typeof cycleId !== "string" || !cycleId.trim() || cycleId.length > 240)
    throw new Error("ETH40_INVALID_OR_REVERSED_CYCLE");
  const state = structuredClone(previous), now = snapshot.observedAtMs, today = day(now);
  state.lastCycleAtMs = now;
  const decisions: Decision[] = [];
  for (const id of IDS) {
    const p = state.portfolios[id];
    const decision: Decision = { accountId: id, symbol: p.symbol, action: "hold", reason: "TARGET_CASH",
      target: null, signalDayMs: null, sma40: null, close: null, orderId: null, fill: null, budgetUsd: null };
    decisions.push(decision);
    const block = (reason: string) => { decision.action = "blocked"; decision.reason = reason; };
    if (today < state.firstExecutionDayMs) { block("WAITING_FOR_FIRST_PROSPECTIVE_EXECUTION_DAY"); continue; }
    let signal: Signal;
    try {
      if (id === "eth40") signal = deriveEth40Signal(snapshot.histories?.[p.symbol], now);
      else {
        const eligible = today - S.signalToExecutionDays * DAY_MS;
        const bars = historyThrough(snapshot.histories?.[p.symbol], eligible, now), bar = bars.at(-1)!;
        signal = { target: "long", signalDayMs: eligible, sma40: null, close: bar.close, volume: bar.volume };
      }
    } catch (error) { block(error instanceof Error ? error.message : "INVALID_HISTORY"); continue; }
    decision.target = signal.target; decision.signalDayMs = signal.signalDayMs;
    decision.sma40 = signal.sma40; decision.close = signal.close;
    const side = signal.target === "cash" && p.account.quantity > 0 ? "sell"
      : signal.target === "long" && p.account.quantity === 0 && (id === "eth40" || !p.entered) ? "buy" : null;
    if (side === null) {
      decision.reason = p.account.quantity > 0 ? "HOLD_LONG_NO_ADDITIONS" : signal.target === "cash" ? "TARGET_CASH" : "PASSIVE_PURCHASE_ALREADY_COMPLETED";
      continue;
    }
    if (p.lastFillDayMs === today) { block("ACCOUNT_ALREADY_FILLED_THIS_DAY"); continue; }
    if (now - today >= S.executionWindowMs) { block("EXECUTION_WINDOW_MISSED_NO_RETROFILL"); continue; }
    const verified = quote(snapshot, p.symbol);
    if (!verified.book) { block(verified.reason); continue; }
    const rules = snapshot.rules?.[p.symbol];
    if (!validRules(rules)) { block("INVALID_OR_MISSING_INSTRUMENT_RULES"); continue; }
    const rulesAtMs = snapshot.rulesFetchedAtMsByAsset?.[p.symbol] ?? snapshot.rulesFetchedAtMs;
    if (!timestamp(rulesAtMs) || rulesAtMs > now || now - rulesAtMs > S.maximumRulesAgeMs) {
      block("STALE_OR_FUTURE_INSTRUMENT_RULES"); continue;
    }
    const budget = side === "buy" ? Math.min(S.maximumEntryUsd, p.account.cashUsd * S.maximumEntryEquityFraction,
      p.account.cashUsd, signal.volume * signal.close * S.completedDayVolumeParticipation) : undefined;
    decision.budgetUsd = budget ?? null;
    if (budget !== undefined && !(budget > 0)) { block("NO_COMPLETED_DAY_VOLUME_BUDGET"); continue; }
    const orderId = fillId(id, today, side);
    const planned = planSpotPaperFill({ account: p.account, side, ...(budget === undefined ? {} : { budgetUsd: budget }),
      book: verified.book, nowMs: now, feeBps: side === "buy" ? S.entryFeeBps : S.exitFeeBps, rules, id: orderId });
    if (!planned.fill) { block(planned.reason); continue; }
    p.account = applySpotFill(p.account, planned.fill);
    p.entered ||= side === "buy"; p.lastFillDayMs = today;
    if (side === "sell" && p.account.quantity === 0) p.completedEpisodes++;
    decision.action = side; decision.reason = side === "sell" && p.account.quantity > 0 ? "PARTIAL_EXIT_RESIDUAL_REMAINS" : "PAPER_FILL";
    decision.orderId = orderId; decision.fill = planned.fill;
  }
  const valuations = IDS.map(id => valuation(id, state.portfolios[id], snapshot));
  validatePaperState(state);
  return { state, decisions, valuations };
}
