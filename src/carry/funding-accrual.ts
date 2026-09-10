import { createHash } from "node:crypto";

export const FUNDING_ACCRUAL_SPEC = Object.freeze({ version: "linear-usd-continuous-funding-accrual-v1",
  researchOnly: true, externalOrdersAllowed: false, hourMs: 3_600_000, maximumWindowHours: 100_000,
  integration: "SIGNED_BASE_QTY*ABSOLUTE_USD_PER_BASE_PER_HOUR*ELAPSED_MS/3600000",
  arithmetic: "EXACT_RATIONAL_OF_INPUT_DECIMAL_NUMBERS;USD_NUMBER_OUTPUT_WITH_EXPLICIT_RECEIPT_TOLERANCE",
  sign: "POSITIVE_COST_DEBITS_CASH;NEGATIVE_COST_CREDITS_CASH",
  boundaries: "UTC_HOUR_END_OR_NET_POSITION_CHANGE;INTERVALS_HALF_OPEN",
  historyTimestamp: "OFFICIAL_HISTORICAL_RATE_TIMESTAMP_IS_EFFECTIVE_PERIOD_START;AVAILABILITY_IS_SEPARATE",
  availability: "RATES_AND_RECEIPTS_USABLE_ONLY_AFTER_KNOWN_AT_AND_LOCAL_OBSERVATION",
  reconciliation: "INDEPENDENT_USD_CASH_RECEIPT_PER_DUE_OBLIGATION;MISMATCH_PRESERVES_ACTUAL_CASH",
  missing: "MISSING_RATE_OR_DUE_CASH_RECEIPT_IS_UNKNOWN;NO_ZERO_IMPUTATION",
  scope: "FUNDING_COMPONENT_ONLY;DOES_NOT_ESTABLISH_TRADE_PROFIT_OR_VERIFY_INPUT_PROVENANCE",
  source: "https://support.kraken.com/articles/4844359082772-linear-multi-collateral-derivatives-contract-specifications",
  historicalRateSchema: "https://docs.kraken.com/api-reference/historical-funding-rates/historical-funding-rates.md",
});
const H = FUNDING_ACCRUAL_SPEC.hourMs;
export interface FundingAccrualConfig {
  instrumentId: string; startedAtMs: number; initialSignedBaseQty?: number; reconciliationToleranceUsd: number;
}
export interface FundingRateInterval {
  id: string; instrumentId: string; effectiveFromMs: number; effectiveToMs: number; knownAtMs: number;
  absoluteUsdPerBasePerHour: number;
}
export interface FundingPositionChange {
  id: string; instrumentId: string; sequence: number; atMs: number; newSignedBaseQty: number;
}
export interface FundingCashReceipt {
  id: string; instrumentId: string; currency: "USD"; obligationId: string;
  settledAtMs: number; knownAtMs: number; costUsd: number;
}
export type FundingAccrualEvent =
  | { type: "RATE"; asOfMs: number; rate: FundingRateInterval }
  | { type: "POSITION"; asOfMs: number; change: FundingPositionChange }
  | { type: "CASH"; asOfMs: number; receipt: FundingCashReceipt }
  | { type: "ADVANCE"; asOfMs: number };
export interface FundingAccrualState {
  version: typeof FUNDING_ACCRUAL_SPEC.version; config: FundingAccrualConfig; lastAsOfMs: number;
  rates: readonly FundingRateInterval[]; positions: readonly FundingPositionChange[];
  cashReceipts: readonly FundingCashReceipt[]; events: readonly FundingAccrualEvent[]; stateSha256: string;
}
export interface ExactFundingAmount { numerator: string; denominator: string }
export interface FundingAccrualSlice {
  fromMs: number; toMs: number; signedBaseQty: number; expectedCostUsd: number | null;
  exactExpectedCostUsd: ExactFundingAmount | null; knownPartialCostUsd: number;
  missingRateMs: number; rateIds: string[];
}
export interface FundingAccrualObligation extends FundingAccrualSlice {
  id: string; dueAtMs: number; reason: "HOUR_END" | "POSITION_CHANGE" | "HOUR_END_AND_POSITION_CHANGE";
  receiptId: string | null; actualCashCostUsd: number | null; differenceUsd: number | null;
  reconciliation: "MATCHED" | "MISMATCH" | "UNKNOWN"; reasons: string[];
}
export interface FundingAccrualSnapshot {
  version: typeof FUNDING_ACCRUAL_SPEC.version; instrumentId: string; asOfMs: number; lastObservedAtMs: number;
  signedBaseQty: number; obligations: FundingAccrualObligation[]; unsettledAccrual: FundingAccrualSlice | null;
  expectedSettledCostUsd: number | null; accruedUnsettledCostUsd: number | null; expectedTotalCostUsd: number | null;
  actualCashCostUsd: number; actualCashPnlUsd: number; expectedCashCostOutstandingUsd: number | null;
  knownPartialAccrualCostUsd: number; missingRateMs: number; missingCashReceipts: number; mismatchedCashReceipts: number;
  ratesKnown: boolean; dueCashReceiptsReconciled: boolean; fundingAccountingKnown: boolean;
  reconciledFundingComponentPnlUsd: number | null; fullyCostedNetPnlUsd: null;
  reasons: string[]; inputProvenanceVerified: false;
}
type Rational = { n: bigint; d: bigint };
const ZERO: Rational = { n: 0n, d: 1n };
const abs = (n: bigint) => n < 0n ? -n : n;
function gcd(a: bigint, b: bigint): bigint { while (b) { const c = a % b; a = b; b = c; } return a; }
function rational(n: bigint, d: bigint): Rational {
  if (!d) throw new Error("FUNDING_ZERO_DENOMINATOR");
  if (d < 0) { n = -n; d = -d; } const g = gcd(abs(n), d); return { n: n / g, d: d / g };
}
function decimal(value: number): Rational {
  const [mantissa, exponent = "0"] = String(value).split("e");
  const digits = mantissa!.replace(".", "");
  const scale = (mantissa!.split(".")[1]?.length ?? 0) - Number(exponent);
  return scale >= 0 ? rational(BigInt(digits), 10n ** BigInt(scale)) : rational(BigInt(digits) * 10n ** BigInt(-scale), 1n);
}
const add = (a: Rational, b: Rational) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const multiply = (a: Rational, b: Rational) => rational(a.n * b.n, a.d * b.d);
function amount(a: Rational): number {
  // Preserve tiny decimal rates and avoid Infinity/Infinity for finite ratios.
  const numerator = Number(a.n), denominator = Number(a.d);
  const n = String(abs(a.n)), d = String(a.d), leadingN = n.slice(0, 17), leadingD = d.slice(0, 17);
  const scale = n.length - leadingN.length - d.length + leadingD.length;
  const value = Number.isFinite(numerator) && Number.isFinite(denominator) ? numerator / denominator
    : Number(`${a.n < 0n ? "-" : ""}${Number(leadingN) / Number(leadingD)}e${scale}`);
  if (!Number.isFinite(value)) throw new Error("FUNDING_ARITHMETIC_OVERFLOW");
  return value;
}
const exact = (a: Rational): ExactFundingAmount => ({ numerator: String(a.n), denominator: String(a.d) });
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const time = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v >= 0;
const identifier = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && v.trim() === v;
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
function freeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v;
}
const trusted = new WeakSet<object>();
type Body = Omit<FundingAccrualState, "stateSha256">;
function initial(config: FundingAccrualConfig): Body {
  if (!config || !identifier(config.instrumentId) || !/^[^:]+:LINEAR_PERPETUAL:[^:]+$/.test(config.instrumentId)
    || !time(config.startedAtMs) || config.initialSignedBaseQty !== undefined && !finite(config.initialSignedBaseQty)
    || !finite(config.reconciliationToleranceUsd) || config.reconciliationToleranceUsd < 0)
    throw new Error("FUNDING_INVALID_CONFIG");
  return { version: FUNDING_ACCRUAL_SPEC.version, config: structuredClone(config), lastAsOfMs: config.startedAtMs,
    rates: [], positions: [], cashReceipts: [], events: [] };
}
function body(s: FundingAccrualState): Body { const { stateSha256: _, ...b } = s; return structuredClone(b); }
function seal(b: Body): FundingAccrualState {
  const s = freeze({ ...b, stateSha256: hash(b) }); trusted.add(s); return s;
}
export function newFundingAccrualState(config: FundingAccrualConfig): FundingAccrualState { return seal(initial(config)); }
function clock(b: Body, asOfMs: number) {
  if (!time(asOfMs) || asOfMs < b.lastAsOfMs || asOfMs - b.config.startedAtMs > FUNDING_ACCRUAL_SPEC.maximumWindowHours * H)
    throw new Error("FUNDING_REVERSED_OR_INVALID_CLOCK");
}
function integrate(b: Body, fromMs: number, toMs: number, qty: number): { slice: FundingAccrualSlice; cost: Rational } {
  let cursor = fromMs, cost = ZERO, missingRateMs = 0; const rateIds: string[] = [];
  // Rates are nonoverlapping and ordered. Do not scan historical intervals for
  // every new holding slice; locate its first possible interval logarithmically.
  let lo = 0, hi = b.rates.length;
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2);
    if (b.rates[mid]!.effectiveToMs <= fromMs) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < b.rates.length; i++) {
    const rate = b.rates[i]!;
    if (rate.effectiveFromMs >= toMs) break;
    if (rate.effectiveToMs <= cursor || rate.effectiveFromMs >= toMs) continue;
    if (rate.effectiveFromMs > cursor) { missingRateMs += rate.effectiveFromMs - cursor; cursor = rate.effectiveFromMs; }
    const until = Math.min(toMs, rate.effectiveToMs);
    cost = add(cost, multiply(multiply(decimal(qty), decimal(rate.absoluteUsdPerBasePerHour)), rational(BigInt(until - cursor), BigInt(H))));
    cursor = until; rateIds.push(rate.id); if (cursor === toMs) break;
  }
  missingRateMs += toMs - cursor;
  return { cost, slice: { fromMs, toMs, signedBaseQty: qty, expectedCostUsd: missingRateMs ? null : amount(cost),
    exactExpectedCostUsd: missingRateMs ? null : exact(cost), knownPartialCostUsd: amount(cost), missingRateMs, rateIds } };
}
export function fundingObligationId(instrumentId: string, fromMs: number, toMs: number): string {
  return `funding:${instrumentId}:${fromMs}:${toMs}`;
}
interface ProjectionCheckpoint {
  asOfMs: number; cursorMs: number; signedBaseQty: number;
  obligations: FundingAccrualObligation[]; settled: Rational; missingRateMs: number;
}
const projectionCheckpoints = new WeakMap<FundingAccrualSnapshot, ProjectionCheckpoint>();
function snapshot(b: Body, asOfMs: number, prefix?: ProjectionCheckpoint): FundingAccrualSnapshot {
  clock(b, asOfMs);
  let obligations: FundingAccrualObligation[] = prefix?.obligations ?? [];
  let unsettledAccrual: FundingAccrualSlice | null = null, settled = prefix?.settled ?? ZERO;
  let open = ZERO, totalKnown = settled;
  let missingRateMs = prefix?.missingRateMs ?? 0, currentQty = prefix?.signedBaseQty ?? b.config.initialSignedBaseQty ?? 0;
  let cursor = prefix?.cursorMs ?? b.config.startedAtMs;
  const receipts = new Map(b.cashReceipts.map(r => [r.obligationId, r]));
  const emit = (until: number, positionChange: boolean) => {
    if (currentQty === 0) { cursor = until; return; }
    while (cursor < until) {
      const hourEnd = (Math.floor(cursor / H) + 1) * H, toMs = Math.min(hourEnd, until);
      if (currentQty !== 0) {
        const integrated = integrate(b, cursor, toMs, currentQty), slice = integrated.slice;
        missingRateMs += slice.missingRateMs; totalKnown = add(totalKnown, integrated.cost);
        const due = toMs === hourEnd || positionChange;
        if (due) {
          settled = add(settled, integrated.cost);
          const id = fundingObligationId(b.config.instrumentId, cursor, toMs), cash = receipts.get(id);
          const exactDifference = cash && slice.expectedCostUsd !== null ? add(decimal(cash.costUsd), rational(-integrated.cost.n, integrated.cost.d)) : null;
          const difference = exactDifference === null ? null : amount(exactDifference);
          const reasons: string[] = [];
          if (slice.missingRateMs) reasons.push("MISSING_EFFECTIVE_RATE");
          if (!cash) reasons.push("MISSING_CASH_RECEIPT");
          const tolerance = decimal(b.config.reconciliationToleranceUsd);
          const mismatched = exactDifference !== null && abs(exactDifference.n) * tolerance.d > tolerance.n * exactDifference.d;
          if (mismatched) reasons.push("CASH_RECEIPT_MISMATCH");
          if (prefix && obligations === prefix.obligations) obligations = [...obligations];
          obligations.push({ ...slice, id, dueAtMs: toMs,
            reason: toMs === hourEnd ? positionChange && toMs === until ? "HOUR_END_AND_POSITION_CHANGE" : "HOUR_END" : "POSITION_CHANGE",
            receiptId: cash?.id ?? null, actualCashCostUsd: cash?.costUsd ?? null, differenceUsd: difference,
            reconciliation: mismatched ? "MISMATCH" : reasons.length ? "UNKNOWN" : "MATCHED", reasons });
        } else { unsettledAccrual = slice; open = integrated.cost; }
      }
      cursor = toMs;
    }
  };
  if (!prefix) for (const position of b.positions) { emit(position.atMs, true); currentQty = position.newSignedBaseQty; }
  emit(asOfMs, false);
  const missingCashReceipts = obligations.filter(o => o.receiptId === null).length;
  const mismatchedCashReceipts = obligations.filter(o => o.reconciliation === "MISMATCH").length;
  const settledKnown = obligations.every(o => o.expectedCostUsd !== null);
  const openKnown = unsettledAccrual === null || (unsettledAccrual as FundingAccrualSlice).missingRateMs === 0;
  const actual = b.cashReceipts.reduce((n, r) => add(n, decimal(r.costUsd)), ZERO);
  const fundingAccountingKnown = missingRateMs === 0 && !missingCashReceipts && !mismatchedCashReceipts;
  const reasons = [...new Set(obligations.flatMap(o => o.reasons))];
  if (!openKnown && !reasons.includes("MISSING_EFFECTIVE_RATE")) reasons.push("MISSING_EFFECTIVE_RATE");
  const result: FundingAccrualSnapshot = { version: FUNDING_ACCRUAL_SPEC.version, instrumentId: b.config.instrumentId, asOfMs, lastObservedAtMs: b.lastAsOfMs,
    signedBaseQty: currentQty, obligations, unsettledAccrual,
    expectedSettledCostUsd: settledKnown ? amount(settled) : null,
    accruedUnsettledCostUsd: openKnown ? amount(open) : null,
    expectedTotalCostUsd: missingRateMs ? null : amount(add(settled, open)),
    actualCashCostUsd: amount(actual), actualCashPnlUsd: -amount(actual),
    expectedCashCostOutstandingUsd: settledKnown ? amount(add(settled, rational(-actual.n, actual.d))) : null,
    knownPartialAccrualCostUsd: amount(totalKnown), missingRateMs, missingCashReceipts, mismatchedCashReceipts,
    ratesKnown: missingRateMs === 0, dueCashReceiptsReconciled: obligations.every(o => o.reconciliation === "MATCHED"),
    fundingAccountingKnown, reconciledFundingComponentPnlUsd: fundingAccountingKnown ? -amount(add(actual, open)) : null,
    fullyCostedNetPnlUsd: null, reasons, inputProvenanceVerified: false };
  projectionCheckpoints.set(result, { asOfMs, cursorMs: result.unsettledAccrual?.fromMs ?? asOfMs,
    signedBaseQty: currentQty, obligations, settled,
    missingRateMs: missingRateMs - (result.unsettledAccrual?.missingRateMs ?? 0) });
  return result;
}
function eventIdentity(event: FundingAccrualEvent): string | null {
  return event.type === "RATE" ? `RATE:${event.rate.id}` : event.type === "POSITION" ? `POSITION:${event.change.id}`
    : event.type === "CASH" ? `CASH:${event.receipt.id}` : null;
}
function payload(event: FundingAccrualEvent) { return event.type === "RATE" ? event.rate : event.type === "POSITION" ? event.change : event.type === "CASH" ? event.receipt : null; }
function reduce(b: Body, event: FundingAccrualEvent): Body {
  clock(b, event.asOfMs);
  if (event.type === "RATE") {
    const r = event.rate;
    if (!identifier(r.id) || r.instrumentId !== b.config.instrumentId || !time(r.effectiveFromMs) || !time(r.effectiveToMs)
      || r.effectiveToMs <= r.effectiveFromMs || !time(r.knownAtMs) || r.knownAtMs > event.asOfMs
      || !finite(r.absoluteUsdPerBasePerHour)) throw new Error("FUNDING_INVALID_OR_FUTURE_RATE");
    if (b.rates.some(old => r.effectiveFromMs < old.effectiveToMs && old.effectiveFromMs < r.effectiveToMs))
      throw new Error("FUNDING_OVERLAPPING_RATE_INTERVAL");
    b.rates = [...b.rates, structuredClone(r)].sort((a, z) => a.effectiveFromMs - z.effectiveFromMs);
  } else if (event.type === "POSITION") {
    const p = event.change, previous = b.positions.at(-1);
    const oldQty = previous?.newSignedBaseQty ?? b.config.initialSignedBaseQty ?? 0;
    if (!identifier(p.id) || p.instrumentId !== b.config.instrumentId || !time(p.atMs) || p.atMs < b.lastAsOfMs || p.atMs > event.asOfMs
      || !time(p.sequence) || previous && p.sequence <= previous.sequence || !finite(p.newSignedBaseQty) || p.newSignedBaseQty === oldQty)
      throw new Error("FUNDING_INVALID_OR_REORDERED_POSITION_CHANGE");
    b.positions = [...b.positions, structuredClone(p)];
  } else if (event.type === "CASH") {
    const r = event.receipt;
    if (!identifier(r.id) || r.instrumentId !== b.config.instrumentId || r.currency !== "USD" || !identifier(r.obligationId)
      || !time(r.settledAtMs) || !time(r.knownAtMs) || r.settledAtMs > r.knownAtMs || r.knownAtMs > event.asOfMs
      || !finite(r.costUsd)) throw new Error("FUNDING_INVALID_OR_FUTURE_CASH_RECEIPT");
    if (b.cashReceipts.some(old => old.obligationId === r.obligationId)) throw new Error("FUNDING_DUPLICATE_OBLIGATION_CASH");
    const due = snapshot(b, event.asOfMs).obligations.find(o => o.id === r.obligationId);
    if (!due || r.settledAtMs !== due.dueAtMs) throw new Error("FUNDING_CASH_WITHOUT_DUE_OBLIGATION");
    b.cashReceipts = [...b.cashReceipts, structuredClone(r)];
  } else if (event.type !== "ADVANCE") throw new Error("FUNDING_INVALID_EVENT");
  b.lastAsOfMs = event.asOfMs; b.events = [...b.events, structuredClone(event)];
  snapshot(b, event.asOfMs); // Fail atomically on arithmetic overflow.
  return b;
}
function commit(state: FundingAccrualState, event: FundingAccrualEvent): FundingAccrualState {
  if (!validateFundingAccrualState(state)) throw new Error("FUNDING_INVALID_STATE");
  if (!time(event.asOfMs)) throw new Error("FUNDING_REVERSED_OR_INVALID_CLOCK");
  const data = payload(event);
  if (data && "knownAtMs" in data && data.knownAtMs > event.asOfMs) throw new Error("FUNDING_FUTURE_KNOWLEDGE");
  if (data && "atMs" in data && data.atMs > event.asOfMs) throw new Error("FUNDING_FUTURE_POSITION");
  const identity = eventIdentity(event), old = identity === null ? undefined : state.events.find(e => eventIdentity(e) === identity);
  if (old) {
    if (canonical(payload(old)) === canonical(data)) return state;
    throw new Error("FUNDING_CONFLICTING_DUPLICATE_RECEIPT");
  }
  if (event.type === "ADVANCE" && event.asOfMs === state.lastAsOfMs) return state;
  return seal(reduce(body(state), event));
}
export function observeFundingRate(state: FundingAccrualState, rate: FundingRateInterval, asOfMs: number) {
  return commit(state, { type: "RATE", rate, asOfMs });
}
export function applyFundingPositionChange(state: FundingAccrualState, change: FundingPositionChange, asOfMs: number) {
  return commit(state, { type: "POSITION", change, asOfMs });
}
/** Cash truth is retained on mismatch. It does not silently replace expected
 * accrual or imply zero for an unknown rate. Tolerance is explicit config. */
export function applyFundingCashReceipt(state: FundingAccrualState, receipt: FundingCashReceipt, asOfMs: number) {
  return commit(state, { type: "CASH", receipt, asOfMs });
}
export function advanceFundingAccrual(state: FundingAccrualState, asOfMs: number) { return commit(state, { type: "ADVANCE", asOfMs }); }
/** Future projection uses only already observed rate/position evidence and no
 * future cash. Save immutable earlier states for earlier knowledge cutoffs. */
export function fundingAccrualSnapshot(state: FundingAccrualState, asOfMs = state.lastAsOfMs): FundingAccrualSnapshot {
  if (!validateFundingAccrualState(state)) throw new Error("FUNDING_INVALID_STATE");
  return snapshot(state, asOfMs);
}

/** Read-only projection from a validated immutable evidence batch. This does
 * not create a checkpoint, accept cash receipts or replace event validation.
 * It avoids replaying N commits (and N complete snapshots) for N known rates. */
export function createFundingAccrualProjection(config: FundingAccrualConfig,
  positions: readonly FundingPositionChange[], rates: readonly FundingRateInterval[], observedAtMs: number) {
  const b = initial(config); clock(b, observedAtMs);
  if (!Array.isArray(positions) || !Array.isArray(rates)) throw new Error("FUNDING_INVALID_PROJECTION_EVIDENCE");
  const ids = new Set<string>(); let previous: FundingPositionChange | undefined;
  for (const p of positions) {
    const oldQty = previous?.newSignedBaseQty ?? config.initialSignedBaseQty ?? 0;
    if (!p || !identifier(p.id) || ids.has(`position:${p.id}`) || p.instrumentId !== config.instrumentId
      || !time(p.atMs) || p.atMs < (previous?.atMs ?? config.startedAtMs) || p.atMs > observedAtMs
      || !time(p.sequence) || previous && p.sequence <= previous.sequence
      || !finite(p.newSignedBaseQty) || p.newSignedBaseQty === oldQty) throw new Error("FUNDING_INVALID_OR_REORDERED_POSITION_CHANGE");
    ids.add(`position:${p.id}`); previous = p;
  }
  let priorRate: FundingRateInterval | undefined;
  for (const r of rates) {
    if (!r || !identifier(r.id) || ids.has(`rate:${r.id}`) || r.instrumentId !== config.instrumentId
      || !time(r.effectiveFromMs) || !time(r.effectiveToMs) || r.effectiveToMs <= r.effectiveFromMs
      || !time(r.knownAtMs) || r.knownAtMs > observedAtMs || !finite(r.absoluteUsdPerBasePerHour))
      throw new Error("FUNDING_INVALID_OR_FUTURE_RATE");
    if (priorRate && r.effectiveFromMs < priorRate.effectiveToMs) throw new Error("FUNDING_OVERLAPPING_RATE_INTERVAL");
    ids.add(`rate:${r.id}`); priorRate = r;
  }
  b.positions = structuredClone(positions); b.rates = structuredClone(rates); b.lastAsOfMs = observedAtMs;
  freeze(b);
  let cached: FundingAccrualSnapshot | undefined;
  return Object.freeze({ snapshot: (asOfMs: number) => {
    if (cached?.asOfMs === asOfMs) return cached;
    const prefix = cached && asOfMs >= cached.asOfMs ? projectionCheckpoints.get(cached) : undefined;
    const result = freeze(snapshot(b, asOfMs, prefix)); cached = result; return result;
  } });
}
export function validateFundingAccrualState(value: unknown, nowMs?: number): value is FundingAccrualState {
  try {
    const state = value as FundingAccrualState;
    if (!state || state.version !== FUNDING_ACCRUAL_SPEC.version || !Array.isArray(state.events)
      || nowMs !== undefined && (!time(nowMs) || state.lastAsOfMs > nowMs)) return false;
    if (trusted.has(state)) return true;
    let expected = initial(state.config); const ids = new Set<string>();
    for (const event of state.events) {
      const identity = eventIdentity(event); if (identity !== null) { if (ids.has(identity)) return false; ids.add(identity); }
      expected = reduce(expected, structuredClone(event));
    }
    return canonical(expected) === canonical(body(state)) && state.stateSha256 === hash(expected);
  } catch { return false; }
}
export function restoreFundingAccrualState(value: unknown, nowMs: number): FundingAccrualState {
  if (!validateFundingAccrualState(value, nowMs)) throw new Error("FUNDING_INVALID_CHECKPOINT");
  return advanceFundingAccrual(seal(body(value)), nowMs);
}
