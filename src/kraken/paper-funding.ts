import { createHash } from "node:crypto";
import { createFundingAccrualProjection, type FundingPositionChange, type FundingAccrualSnapshot } from "../carry/funding-accrual.js";

const HOUR = 3_600_000;
const PRODUCTS: Readonly<Record<string, string>> = { "BTC/USD": "PF_XBTUSD", "ETH/USD": "PF_ETHUSD" };
export const PAPER_FUNDING_SPEC = Object.freeze({ version: "kraken-paper-absolute-funding-v1",
  model: "PAPER_MODEL_NOT_VENUE_CASH_RECEIPTS", interval: "HALF_OPEN_UTC_HOUR_OR_INVENTORY_CHANGE",
  calculation: "NEGATIVE_SIGNED_BASE_QTY_TIMES_ABSOLUTE_USD_PER_BASE_PER_HOUR_TIMES_HELD_FRACTION",
  missing: "UNKNOWN_NOT_ZERO", posting: "IDEMPOTENT_CUMULATIVE_SETTLEMENT_ADJUSTMENT",
  source: "https://docs.kraken.com/api-reference/historical-funding-rates/historical-funding-rates.md" });

export interface PaperFundingConfig {
  startedAtMs: number; productsBySymbol: Readonly<Record<string, string>>;
  initialSignedQtyBySymbol?: Readonly<Record<string, number>>;
}
export interface PaperFundingFill { id: string; symbol: string; occurredAtMs: number; side: 1 | -1; qty: number }
export interface PaperFundingRate {
  id: string; symbol: string; productId: string; effectiveFromMs: number; effectiveToMs: number;
  knownAtMs: number; absoluteUsdPerBasePerHour: number; sourceResponseSha256: string;
}
export interface PaperFundingPosting {
  id: string; symbol: string; postedAtMs: number; settledThroughMs: number;
  cashDeltaUsd: number; targetSettledCashUsd: number; basisSha256: string;
  source: "PAPER_MODEL_NOT_VENUE_CASH_RECEIPTS";
}
export type PaperFundingEvent =
  | { type: "FILL"; observedAtMs: number; fill: PaperFundingFill }
  | { type: "RATES"; observedAtMs: number; rates: readonly PaperFundingRate[] }
  | { type: "POSTING"; observedAtMs: number; posting: PaperFundingPosting };
export interface PaperFundingState {
  version: typeof PAPER_FUNDING_SPEC.version; config: PaperFundingConfig;
  lastObservedAtMs: number; events: readonly PaperFundingEvent[]; stateSha256: string;
}
export interface PaperFundingSymbolSnapshot {
  symbol: string; signedBaseQty: number; fundingCashUsd: number | null; knownPartialFundingCashUsd: number;
  settledFundingCashUsd: number | null; unsettledFundingCashUsd: number | null; postedFundingCashUsd: number;
  unpostedSettledFundingCashUsd: number | null; missingRateMs: number; ratesKnown: boolean;
  cashPostingsCurrent: boolean; fundingAccountingKnown: boolean;
  missingIntervals: Array<{ fromMs: number; toMs: number; signedBaseQty: number; missingRateMs: number }>;
  obligations: FundingAccrualSnapshot["obligations"];
}
export interface PaperFundingSnapshot {
  version: typeof PAPER_FUNDING_SPEC.version; model: typeof PAPER_FUNDING_SPEC.model;
  startedAtMs: number; asOfMs: number; fundingCashUsd: number | null; knownPartialFundingCashUsd: number;
  postedFundingCashUsd: number; fundingAccountingKnown: boolean; perSymbol: PaperFundingSymbolSnapshot[];
  dueModelPostings: PaperFundingPosting[]; venueCashReceiptsVerified: false;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const time = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && v.trim() === v;
const hashText = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
const hash = (v: unknown) => hashText(canonical(v));
function freeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v;
}
/** Sum input decimal values before converting back to the public number schema. */
function sum(values: readonly number[]): number {
  const parts = values.map(v => {
    if (!finite(v)) throw new Error("PAPER_FUNDING_NONFINITE_AMOUNT");
    const [mantissa, exponent = "0"] = String(v).split("e");
    return { n: BigInt(mantissa!.replace(".", "")), scale: (mantissa!.split(".")[1]?.length ?? 0) - Number(exponent) };
  });
  const scale = Math.max(0, ...parts.map(p => p.scale));
  const n = parts.reduce((a, p) => a + p.n * 10n ** BigInt(scale - p.scale), 0n);
  const result = Number(`${n}e-${scale}`);
  if (!finite(result)) throw new Error("PAPER_FUNDING_ARITHMETIC_OVERFLOW");
  return result;
}
type Body = Omit<PaperFundingState, "stateSha256">;
const trusted = new WeakSet<object>();
function seal(body: Body): PaperFundingState {
  const result = freeze({ ...body, stateSha256: hash(body) }); trusted.add(result);
  const projections = projectionCache.get(body); if (projections) projectionCache.set(result, projections);
  return result;
}
function body(state: PaperFundingState): Body {
  const { stateSha256: _, ...rest } = state; const result = structuredClone(rest);
  const projections = projectionCache.get(state); if (projections) projectionCache.set(result, projections);
  return result;
}
function validConfig(config: PaperFundingConfig): boolean {
  if (!config || !time(config.startedAtMs) || !config.productsBySymbol || Array.isArray(config.productsBySymbol)) return false;
  const entries = Object.entries(config.productsBySymbol);
  return entries.length > 0 && entries.every(([symbol, product]) => PRODUCTS[symbol] === product)
    && Object.entries(config.initialSignedQtyBySymbol ?? {}).every(([symbol, qty]) => symbol in config.productsBySymbol && finite(qty));
}
export function newPaperFundingState(config: PaperFundingConfig): PaperFundingState {
  if (!validConfig(config)) throw new Error("PAPER_FUNDING_INVALID_CONFIG");
  return seal({ version: PAPER_FUNDING_SPEC.version, config: structuredClone(config), lastObservedAtMs: config.startedAtMs, events: [] });
}
function economicRate(rate: PaperFundingRate) {
  const { knownAtMs: _, sourceResponseSha256: __, ...economics } = rate; return economics;
}
function evidence(state: Pick<PaperFundingState, "events">) {
  return { fills: state.events.flatMap(event => event.type === "FILL" ? [event.fill] : []),
    rates: state.events.flatMap(event => event.type === "RATES" ? [...event.rates] : []),
    postings: state.events.flatMap(event => event.type === "POSTING" ? [event.posting] : []) };
}
const projectionCache = new WeakMap<object, Map<string, ReturnType<typeof createFundingAccrualProjection>>>();
const obligationBasisCache = new WeakMap<object, string>();
function calculate(state: Body, asOfMs: number): PaperFundingSnapshot {
  if (!time(asOfMs) || asOfMs < state.lastObservedAtMs) throw new Error("PAPER_FUNDING_INVALID_CLOCK");
  const data = evidence(state), perSymbol: PaperFundingSymbolSnapshot[] = [], dueModelPostings: PaperFundingPosting[] = [];
  for (const [symbol, product] of Object.entries(state.config.productsBySymbol).sort(([a], [b]) => a.localeCompare(b))) {
    const instrumentId = `kraken:LINEAR_PERPETUAL:${product}`;
    let projections = projectionCache.get(state);
    if (!projections) { projections = new Map(); projectionCache.set(state, projections); }
    let core = projections.get(symbol);
    // Reconstruct inventory chronologically, then admit rates using the current
    // knowledge cutoff. This permits late recovered fills without backdating
    // the time at which the caller first knew their funding consequence.
    if (!core) {
      const fills = data.fills.filter(fill => fill.symbol === symbol).sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.id.localeCompare(b.id));
      let qty = state.config.initialSignedQtyBySymbol?.[symbol] ?? 0, sequence = 0;
      const positions: FundingPositionChange[] = [];
      for (const fill of fills) {
        const next = sum([qty, fill.side * fill.qty]);
        if (next !== qty) positions.push({ instrumentId, id: `fill:${hash(fill.id)}`, sequence: ++sequence,
          atMs: fill.occurredAtMs, newSignedBaseQty: next });
        qty = next;
      }
      const rates = data.rates.filter(row => row.symbol === symbol).sort((a, b) => a.effectiveFromMs - b.effectiveFromMs)
        .map(rate => ({ instrumentId, id: rate.id, effectiveFromMs: rate.effectiveFromMs,
          effectiveToMs: rate.effectiveToMs, knownAtMs: rate.knownAtMs, absoluteUsdPerBasePerHour: rate.absoluteUsdPerBasePerHour }));
      core = createFundingAccrualProjection({ instrumentId, startedAtMs: state.config.startedAtMs,
        initialSignedBaseQty: state.config.initialSignedQtyBySymbol?.[symbol] ?? 0, reconciliationToleranceUsd: 0 }, positions, rates, state.lastObservedAtMs);
      projections.set(symbol, core);
    }
    const snap = core.snapshot(asOfMs), postings = data.postings.filter(row => row.symbol === symbol);
    const postedFundingCashUsd = sum(postings.map(row => row.cashDeltaUsd));
    const settledFundingCashUsd = snap.expectedSettledCostUsd === null ? null : -snap.expectedSettledCostUsd;
    let basisSha256 = obligationBasisCache.get(snap.obligations);
    if (!basisSha256) {
      basisSha256 = hash(snap.obligations.map(row => ({ id: row.id, fromMs: row.fromMs, toMs: row.toMs,
        signedBaseQty: row.signedBaseQty, exactExpectedCostUsd: row.exactExpectedCostUsd, rateIds: row.rateIds })));
      obligationBasisCache.set(snap.obligations, basisSha256);
    }
    const latest = postings.at(-1), settledThroughMs = snap.obligations.at(-1)?.dueAtMs ?? state.config.startedAtMs;
    const cashPostingsCurrent = settledFundingCashUsd !== null && (snap.obligations.length === 0 && postings.length === 0
      || latest?.basisSha256 === basisSha256 && latest.targetSettledCashUsd === settledFundingCashUsd);
    if (settledFundingCashUsd !== null && !cashPostingsCurrent) {
      const cashDeltaUsd = sum([settledFundingCashUsd, -postedFundingCashUsd]);
      dueModelPostings.push({ id: `paper-funding:${hash({ symbol, basisSha256, prior: latest?.id ?? null })}`,
        symbol, postedAtMs: asOfMs, settledThroughMs, cashDeltaUsd, targetSettledCashUsd: settledFundingCashUsd,
        basisSha256, source: "PAPER_MODEL_NOT_VENUE_CASH_RECEIPTS" });
    }
    const slices = [...snap.obligations, ...(snap.unsettledAccrual ? [snap.unsettledAccrual] : [])];
    perSymbol.push({ symbol, signedBaseQty: snap.signedBaseQty,
      fundingCashUsd: snap.expectedTotalCostUsd === null ? null : -snap.expectedTotalCostUsd,
      knownPartialFundingCashUsd: -snap.knownPartialAccrualCostUsd,
      settledFundingCashUsd, unsettledFundingCashUsd: snap.accruedUnsettledCostUsd === null ? null : -snap.accruedUnsettledCostUsd,
      postedFundingCashUsd, unpostedSettledFundingCashUsd: settledFundingCashUsd === null ? null : sum([settledFundingCashUsd, -postedFundingCashUsd]),
      missingRateMs: snap.missingRateMs, ratesKnown: snap.ratesKnown, cashPostingsCurrent,
      fundingAccountingKnown: snap.ratesKnown && cashPostingsCurrent,
      missingIntervals: slices.filter(row => row.missingRateMs > 0).map(row => ({ fromMs: row.fromMs, toMs: row.toMs,
        signedBaseQty: row.signedBaseQty, missingRateMs: row.missingRateMs })), obligations: snap.obligations });
  }
  return { version: PAPER_FUNDING_SPEC.version, model: PAPER_FUNDING_SPEC.model,
    startedAtMs: state.config.startedAtMs, asOfMs,
    fundingCashUsd: perSymbol.every(row => row.fundingCashUsd !== null) ? sum(perSymbol.map(row => row.fundingCashUsd!)) : null,
    knownPartialFundingCashUsd: sum(perSymbol.map(row => row.knownPartialFundingCashUsd)),
    postedFundingCashUsd: sum(perSymbol.map(row => row.postedFundingCashUsd)),
    fundingAccountingKnown: perSymbol.every(row => row.fundingAccountingKnown), perSymbol, dueModelPostings,
    venueCashReceiptsVerified: false };
}

function apply(state: Body, event: PaperFundingEvent): Body {
  if (!time(event.observedAtMs) || event.observedAtMs < state.lastObservedAtMs) throw new Error("PAPER_FUNDING_INVALID_CLOCK");
  const data = evidence(state);
  if (event.type === "FILL") {
    const f = event.fill;
    if (!f || !id(f.id) || !(f.symbol in state.config.productsBySymbol) || !time(f.occurredAtMs)
      || f.occurredAtMs < state.config.startedAtMs || f.occurredAtMs > event.observedAtMs
      || ![1, -1].includes(f.side) || !finite(f.qty) || f.qty <= 0) throw new Error("PAPER_FUNDING_INVALID_FILL");
    if (data.fills.some(old => old.id === f.id)) throw new Error("PAPER_FUNDING_DUPLICATE_FILL");
  } else if (event.type === "RATES") {
    if (!Array.isArray(event.rates) || event.rates.length === 0) throw new Error("PAPER_FUNDING_INVALID_RATE_BATCH");
    const rates = [...data.rates];
    for (const r of event.rates) {
      if (!r || !id(r.id) || state.config.productsBySymbol[r.symbol] !== r.productId || !time(r.effectiveFromMs)
        || r.effectiveFromMs % HOUR !== 0 || r.effectiveToMs !== r.effectiveFromMs + HOUR
        || !time(r.knownAtMs) || r.knownAtMs < r.effectiveFromMs || r.knownAtMs > event.observedAtMs
        || !finite(r.absoluteUsdPerBasePerHour) || !/^[a-f0-9]{64}$/.test(r.sourceResponseSha256))
        throw new Error("PAPER_FUNDING_INVALID_OR_FUTURE_RATE");
      if (rates.some(old => old.id === r.id || old.symbol === r.symbol
        && old.effectiveFromMs < r.effectiveToMs && r.effectiveFromMs < old.effectiveToMs))
        throw new Error("PAPER_FUNDING_CONFLICTING_RATE");
      rates.push(r);
    }
  } else if (event.type === "POSTING") {
    const expected = calculate(state, event.observedAtMs).dueModelPostings.find(row => row.symbol === event.posting?.symbol);
    if (!expected || canonical(expected) !== canonical(event.posting)) throw new Error("PAPER_FUNDING_INVALID_POSTING");
  } else throw new Error("PAPER_FUNDING_INVALID_EVENT");
  const result = { ...state, lastObservedAtMs: event.observedAtMs, events: [...state.events, structuredClone(event)] };
  // A posting changes cash evidence, but cannot change historical inventory or
  // rate integration. Share only that immutable projection across the commit.
  if (event.type === "POSTING") {
    const projections = projectionCache.get(state); if (projections) projectionCache.set(result, projections);
  }
  return result;
}
function checked(state: PaperFundingState) {
  if (!validatePaperFundingState(state)) throw new Error("PAPER_FUNDING_INVALID_STATE");
}
export function observePaperFundingFill(state: PaperFundingState, fill: PaperFundingFill, observedAtMs: number): PaperFundingState {
  checked(state);
  if (!time(observedAtMs) || fill.occurredAtMs > observedAtMs) throw new Error("PAPER_FUNDING_INVALID_CLOCK");
  const old = evidence(state).fills.find(row => row.id === fill.id);
  if (old) { if (canonical(old) === canonical(fill)) return state; throw new Error("PAPER_FUNDING_CONFLICTING_FILL"); }
  const next = apply(body(state), { type: "FILL", observedAtMs, fill }); calculate(next, observedAtMs); return seal(next);
}
export function observePaperFundingRates(state: PaperFundingState, rates: readonly PaperFundingRate[], observedAtMs: number): PaperFundingState {
  checked(state);
  if (!Array.isArray(rates) || !time(observedAtMs)) throw new Error("PAPER_FUNDING_INVALID_RATE_BATCH");
  const known = evidence(state).rates, admitted: PaperFundingRate[] = [];
  for (const rate of rates) {
    if (!rate || rate.knownAtMs > observedAtMs) throw new Error("PAPER_FUNDING_INVALID_OR_FUTURE_RATE");
    const old = [...known, ...admitted].find(row => row.id === rate.id);
    if (old) {
      if (canonical(economicRate(old)) !== canonical(economicRate(rate))) throw new Error("PAPER_FUNDING_CONFLICTING_RATE");
    } else admitted.push(rate);
  }
  if (!admitted.length) return state;
  const next = apply(body(state), { type: "RATES", observedAtMs, rates: admitted }); calculate(next, observedAtMs); return seal(next);
}
export function paperFundingSnapshot(state: PaperFundingState, asOfMs = state.lastObservedAtMs): PaperFundingSnapshot {
  checked(state); return calculate(state, asOfMs);
}
/** Persist returned state and broker cash/activity changes atomically before
 * publishing either. Replaying the committed state returns no repeated delta. */
export function postPaperFunding(state: PaperFundingState, asOfMs: number): { state: PaperFundingState; postings: PaperFundingPosting[] } {
  checked(state); const postings = calculate(state, asOfMs).dueModelPostings;
  let next = body(state);
  for (const posting of postings) next = apply(next, { type: "POSTING", observedAtMs: asOfMs, posting });
  return { state: postings.length ? seal(next) : state, postings };
}
export function validatePaperFundingState(value: unknown, nowMs?: number): value is PaperFundingState {
  try {
    const state = value as PaperFundingState;
    if (!state || state.version !== PAPER_FUNDING_SPEC.version || !validConfig(state.config) || !Array.isArray(state.events)
      || nowMs !== undefined && (!time(nowMs) || state.lastObservedAtMs > nowMs)) return false;
    if (trusted.has(state)) return true;
    let expected = body(newPaperFundingState(state.config));
    for (const event of state.events) expected = apply(expected, event);
    if (hash(expected) !== state.stateSha256 || canonical(expected) !== canonical(body(state))) return false;
    calculate(expected, expected.lastObservedAtMs); return true;
  } catch { return false; }
}
export function restorePaperFundingState(value: unknown, nowMs: number): PaperFundingState {
  if (!validatePaperFundingState(value, nowMs)) throw new Error("PAPER_FUNDING_INVALID_CHECKPOINT");
  const restored = seal(body(value)); calculate(restored, nowMs); return restored;
}

export async function loadPaperFundingRates(input: { productsBySymbol: Readonly<Record<string, string>>; fromMs: number },
  dependencies: { fetcher?: typeof fetch; now?: () => number } = {}) {
  if (!validConfig({ startedAtMs: input.fromMs, productsBySymbol: input.productsBySymbol }))
    throw new Error("PAPER_FUNDING_INVALID_DOWNLOAD_REQUEST");
  const fetcher = dependencies.fetcher ?? fetch, now = dependencies.now ?? Date.now;
  const results = await Promise.allSettled(Object.entries(input.productsBySymbol).map(async ([symbol, productId]) => {
    const url = `https://futures.kraken.com/derivatives/api/v3/historical-funding-rates?symbol=${encodeURIComponent(productId)}`;
    const response = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`PAPER_FUNDING_HTTP_${response.status}:${symbol}`);
    const bytes = await response.text(), observedAtMs = now();
    if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new Error("PAPER_FUNDING_RESPONSE_TOO_LARGE");
    const payload = JSON.parse(bytes) as { result?: string; serverTime?: string; rates?: unknown[] };
    const serverMs = Date.parse(payload.serverTime ?? "");
    if (payload.result !== "success" || !Array.isArray(payload.rates) || !time(observedAtMs)
      || !time(serverMs) || serverMs > observedAtMs + 10_000) throw new Error("PAPER_FUNDING_INVALID_RESPONSE");
    const sourceResponseSha256 = hashText(bytes), rates: PaperFundingRate[] = [], seen = new Set<number>();
    for (const value of payload.rates) {
      const row = value as { timestamp?: string; fundingRate?: number; relativeFundingRate?: number };
      const fromMs = Date.parse(row?.timestamp ?? "");
      if (!row || !time(fromMs) || fromMs % HOUR || fromMs > observedAtMs || !finite(row.fundingRate)
        || !finite(row.relativeFundingRate) || row.fundingRate * row.relativeFundingRate < 0
        || (row.fundingRate === 0) !== (row.relativeFundingRate === 0) || seen.has(fromMs))
        throw new Error("PAPER_FUNDING_INVALID_SOURCE_RATE");
      seen.add(fromMs);
      if (fromMs + HOUR <= input.fromMs) continue;
      rates.push({ id: `kraken-rate:${productId}:${fromMs}`, symbol, productId,
        effectiveFromMs: fromMs, effectiveToMs: fromMs + HOUR, knownAtMs: observedAtMs,
        absoluteUsdPerBasePerHour: row.fundingRate, sourceResponseSha256 });
    }
    return { symbol, observedAtMs, rates: rates.sort((a, b) => a.effectiveFromMs - b.effectiveFromMs),
      source: { url, observedAtMs, sourceResponseSha256, serverMs, bytes: Buffer.byteLength(bytes) } };
  }));
  const failed = results.find((row): row is PromiseRejectedResult => row.status === "rejected");
  if (failed) throw failed.reason;
  const rows = results.flatMap(row => row.status === "fulfilled" ? [row.value] : []);
  return { observedAtMs: Math.max(...rows.map(row => row.observedAtMs)), rates: rows.flatMap(row => row.rates),
    sources: rows.map(row => row.source) };
}
