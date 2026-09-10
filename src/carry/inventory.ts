import { createHash } from "node:crypto";

export const CARRY_INVENTORY_SPEC = Object.freeze({ version: "matched-segregated-continuous-carry-v1",
  researchOnly: true, realOrdersAllowed: false, position: "MATCHED_LONG_SPOT_SHORT_LINEAR_PERPETUAL_BASE_QUANTITY",
  receipts: "BOTH_LEGS_ALREADY_FILLED;NOT_AN_ATOMIC_EXECUTION_ASSUMPTION",
  funding: "SIGNED_ABSOLUTE_USD_PER_BASE_PER_HOUR;EXACT_DECIMAL_RATIONAL;HALF_OPEN_HOLDING_INTERVALS",
  fundingTimestamps: "NORMALIZED_INTERVAL_END;KNOWN_AT_NOT_BEFORE_INTERVAL_END",
  missing: "UNCOVERED_HELD_INTERVAL_IS_UNKNOWN_NOT_ZERO", transfers: "NONE;NO_BORROWING",
  bounds: "INDEPENDENT_PRICE_EXTREMA_AT_ONE_ACCOUNTING_CUTOFF;NOT_SYNCHRONIZED_DRAWDOWN" });
const HOUR = 3_600_000;
export interface CarryInventoryRules { instrumentId: string; minQty: number; qtyIncrement: number; priceIncrement: number }
export interface CarryInventoryConfig {
  startedAtMs: number; spot: CarryInventoryRules; future: CarryInventoryRules;
  spotCashUsd: number; derivativeCollateralUsd: number; maximumLegNotionalUsd: number;
  initialMarginFraction: number; maintenanceMarginFraction: number;
  spotExitFeeBps: number; futureExitFeeBps: number;
}
export interface CarryInventoryPair {
  id: string; atMs: number; kind: "ENTER" | "REDUCE"; qty: number;
  spot: { price: number; feeUsd: number }; future: { price: number; feeUsd: number };
}
export interface CarryInventoryFunding {
  id: string; intervalEndMs: number; absoluteUsdPerBasePerHour: number; knownAtMs: number;
}
export type CarryInventoryEvent = { type: "PAIR"; observedAtMs: number; pair: CarryInventoryPair }
  | { type: "FUNDING"; observedAtMs: number; rate: CarryInventoryFunding };
interface Rational { n: bigint; d: bigint }
interface ExactAmount { numerator: string; denominator: string }
interface CarryInventoryCore {
  version: typeof CARRY_INVENTORY_SPEC.version; config: CarryInventoryConfig; configSha256: string;
  lastAtMs: number; qty: number; spotEntryPrice: number; futureEntryPrice: number;
  spotCashUsd: number; derivativeCollateralUsd: number;
  spotRealizedPricePnlUsd: number; futureRealizedPricePnlUsd: number;
  spotFeesUsd: number; futureFeesUsd: number; fundingCashUsd: number;
  exactFundingCashUsd: ExactAmount; coveredHeldMs: number;
  peakCapitalDeployedUsd: number; entryCount: number; reductionCount: number;
}
export interface CarryInventoryState extends CarryInventoryCore {
  events: readonly CarryInventoryEvent[]; eventsSha256: string; stateSha256: string;
}
export interface CarryInventoryMark {
  atMs: number; spotPrice: number; futurePrice: number;
}
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const positive = (x: unknown): x is number => finite(x) && x > 0;
const time = (x: unknown): x is number => finite(x) && Number.isSafeInteger(x) && x >= 0 && x <= 8_640_000_000_000_000;
const id = (x: unknown): x is string => typeof x === "string" && x.trim() === x && x.length > 0 && x.length <= 240;
const near = (a: number, b: number) => Math.abs(a - b) <= 32 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
const aligned = (qty: number, step: number) => near(qty / step, Math.round(qty / step));
const cleanQty = (qty: number) => Number(qty.toFixed(12));
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child); Object.freeze(value);
  }
  return value;
}
function gcd(a: bigint, b: bigint): bigint { while (b) { const next = a % b; a = b; b = next; } return a; }
function rational(n: bigint, d = 1n): Rational {
  const g = gcd(n < 0 ? -n : n, d); return { n: n / g, d: d / g };
}
function decimal(x: number): Rational {
  const [m, e = "0"] = String(x).split("e"), digits = BigInt(m!.replace(".", ""));
  const scale = (m!.split(".")[1]?.length ?? 0) - Number(e);
  return scale >= 0 ? rational(digits, 10n ** BigInt(scale)) : rational(digits * 10n ** BigInt(-scale));
}
const plus = (a: Rational, b: Rational) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const times = (a: Rational, b: Rational) => rational(a.n * b.n, a.d * b.d);
const exact = (x: Rational): ExactAmount => ({ numerator: String(x.n), denominator: String(x.d) });
function number(x: Rational): number {
  const numerator = Number(x.n), denominator = Number(x.d);
  const n = String(x.n < 0n ? -x.n : x.n), d = String(x.d);
  const leadingN = n.slice(0, 17), leadingD = d.slice(0, 17);
  const scale = n.length - leadingN.length - d.length + leadingD.length;
  const value = Number.isFinite(numerator) && Number.isFinite(denominator) ? numerator / denominator
    : Number(`${x.n < 0n ? "-" : ""}${Number(leadingN) / Number(leadingD)}e${scale}`);
  if (!finite(value)) throw new Error("CARRY_INVENTORY_ARITHMETIC_OVERFLOW"); return value;
}
const zero = (): Rational => ({ n: 0n, d: 1n });
const trusted = new WeakSet<object>();
interface EvidenceIndex { pairs: CarryInventoryPair[]; identities: Map<string, CarryInventoryEvent>; intervalEnds: Set<number> }
const evidenceCache = new WeakMap<CarryInventoryState, EvidenceIndex>();
function evidence(state: CarryInventoryState): EvidenceIndex {
  let value = evidenceCache.get(state);
  if (!value) {
    value = { pairs: [], identities: new Map(), intervalEnds: new Set() };
    for (const event of state.events) {
      value.identities.set(event.type === "PAIR" ? `pair:${event.pair.id}` : `rate:${event.rate.id}`, event);
      if (event.type === "PAIR") value.pairs.push(event.pair); else value.intervalEnds.add(event.rate.intervalEndMs);
    }
    evidenceCache.set(state, value);
  }
  return value;
}
function rules(rule: CarryInventoryRules, kind: "SPOT" | "LINEAR_PERPETUAL"): boolean {
  return Boolean(rule && id(rule.instrumentId) && new RegExp(`^[^:]+:${kind}:[^:]+$`).test(rule.instrumentId)
    && [rule.minQty, rule.qtyIncrement, rule.priceIncrement].every(positive)
    && rule.qtyIncrement >= 1e-12 && rule.priceIncrement >= 1e-12 && aligned(rule.minQty, rule.qtyIncrement));
}
function baseAsset(rule: CarryInventoryRules): string | undefined {
  const symbol = rule.instrumentId.split(":")[2]!, match = /^(?:PF_)?([A-Z0-9]+)(?:\/|_)?USD$/.exec(symbol);
  return match?.[1] === "XBT" ? "BTC" : match?.[1];
}
function initial(config: CarryInventoryConfig): CarryInventoryCore {
  if (!config || !time(config.startedAtMs) || !rules(config.spot, "SPOT") || !rules(config.future, "LINEAR_PERPETUAL")
    || !baseAsset(config.spot) || baseAsset(config.spot) !== baseAsset(config.future)
    || ![config.spotCashUsd, config.derivativeCollateralUsd, config.maximumLegNotionalUsd].every(positive)
    || ![config.initialMarginFraction, config.maintenanceMarginFraction].every(x => positive(x) && x <= 1)
    || config.maintenanceMarginFraction > config.initialMarginFraction
    || ![config.spotExitFeeBps, config.futureExitFeeBps].every(x => finite(x) && x >= 0 && x < 10_000))
    throw new Error("CARRY_INVENTORY_INVALID_CONFIG");
  const c = structuredClone(config);
  return { version: CARRY_INVENTORY_SPEC.version, config: c, configSha256: hash(c), lastAtMs: c.startedAtMs,
    qty: 0, spotEntryPrice: 0, futureEntryPrice: 0, spotCashUsd: c.spotCashUsd,
    derivativeCollateralUsd: c.derivativeCollateralUsd, spotRealizedPricePnlUsd: 0, futureRealizedPricePnlUsd: 0,
    spotFeesUsd: 0, futureFeesUsd: 0, fundingCashUsd: 0, exactFundingCashUsd: exact(zero()),
    coveredHeldMs: 0, peakCapitalDeployedUsd: 0, entryCount: 0, reductionCount: 0 };
}
function core(state: CarryInventoryState): CarryInventoryCore {
  const { events: _, eventsSha256: __, stateSha256: ___, ...rest } = state; return { ...rest };
}
function seal(value: CarryInventoryCore, events: readonly CarryInventoryEvent[], eventsSha256: string): CarryInventoryState {
  const numbers = [value.lastAtMs, value.qty, value.spotEntryPrice, value.futureEntryPrice, value.spotCashUsd,
    value.derivativeCollateralUsd, value.spotRealizedPricePnlUsd, value.futureRealizedPricePnlUsd,
    value.spotFeesUsd, value.futureFeesUsd, value.fundingCashUsd, value.coveredHeldMs, value.peakCapitalDeployedUsd];
  if (!numbers.every(finite) || value.qty < 0 || value.spotCashUsd < -1e-8) throw new Error("CARRY_INVENTORY_ARITHMETIC_OVERFLOW");
  const state = freeze({ ...value, events, eventsSha256,
    stateSha256: hash({ ...value, eventCount: events.length, eventsSha256 }) }); trusted.add(state); return state;
}
export function newCarryInventory(config: CarryInventoryConfig): CarryInventoryState {
  const value = initial(config); return seal(value, [], hash({ spec: CARRY_INVENTORY_SPEC, config: value.config }));
}
function checked(state: CarryInventoryState, atMs: number) {
  if (!validateCarryInventoryState(state)) throw new Error("CARRY_INVENTORY_INVALID_STATE");
  if (!time(atMs) || atMs < state.lastAtMs || atMs - state.config.startedAtMs > 100_000 * HOUR)
    throw new Error("CARRY_INVENTORY_INVALID_OR_REVERSED_TIME");
}
/** Integral of positive matched base quantity, with half-open fill boundaries. */
function exposure(pairs: readonly CarryInventoryPair[], fromMs: number, toMs: number) {
  let qty = 0, cursor = fromMs, heldMs = 0, baseQtyMs = zero();
  const include = (until: number) => {
    if (qty > 0 && until > cursor) { heldMs += until - cursor;
      baseQtyMs = plus(baseQtyMs, times(decimal(qty), rational(BigInt(until - cursor)))); }
    cursor = until;
  };
  for (const pair of pairs) {
    if (pair.atMs >= toMs) break;
    if (pair.atMs > cursor) include(pair.atMs);
    qty = pair.kind === "ENTER" ? pair.qty : cleanQty(qty - pair.qty);
  }
  include(toMs); return { heldMs, baseQtyMs };
}
function append(state: CarryInventoryState, next: CarryInventoryCore, event: CarryInventoryEvent): CarryInventoryState {
  const eventCopy = freeze(structuredClone(event));
  return seal(next, [...state.events, eventCopy], hash({ previous: state.eventsSha256, event: eventCopy }));
}
export function applyCarryInventoryPair(state: CarryInventoryState, pair: CarryInventoryPair): CarryInventoryState {
  checked(state, state.lastAtMs);
  if (!pair || !id(pair.id) || !["ENTER", "REDUCE"].includes(pair.kind) || !positive(pair.qty)
    || ![pair.spot?.price, pair.future?.price].every(positive)
    || ![pair.spot?.feeUsd, pair.future?.feeUsd].every(x => finite(x) && x >= 0)
    || ![state.config.spot, state.config.future].every(rule => pair.qty >= rule.minQty && aligned(pair.qty, rule.qtyIncrement)))
    throw new Error("CARRY_INVENTORY_INVALID_PAIR");
  const index = evidence(state), old = index.identities.get(`pair:${pair.id}`);
  if (old) { if (old.type === "PAIR" && canonical(old.pair) === canonical(pair)) return state;
    throw new Error("CARRY_INVENTORY_CONFLICTING_PAIR"); }
  checked(state, pair.atMs);
  const next = core(state); next.lastAtMs = pair.atMs;
  if (pair.kind === "ENTER") {
    if (state.qty !== 0) throw new Error("CARRY_INVENTORY_ALREADY_OPEN");
    if (exposure(index.pairs, state.config.startedAtMs, pair.atMs).heldMs !== state.coveredHeldMs)
      throw new Error("CARRY_INVENTORY_PRIOR_FUNDING_UNKNOWN");
    const spotNotional = pair.qty * pair.spot.price, futureNotional = pair.qty * pair.future.price;
    if (spotNotional > state.config.maximumLegNotionalUsd && !near(spotNotional, state.config.maximumLegNotionalUsd)
      || futureNotional > state.config.maximumLegNotionalUsd && !near(futureNotional, state.config.maximumLegNotionalUsd))
      throw new Error("CARRY_INVENTORY_LEG_NOTIONAL_CAP");
    if (spotNotional + pair.spot.feeUsd > state.spotCashUsd + 1e-10) throw new Error("CARRY_INVENTORY_SPOT_CASH_INSUFFICIENT");
    if (state.derivativeCollateralUsd - pair.future.feeUsd < futureNotional * state.config.initialMarginFraction)
      throw new Error("CARRY_INVENTORY_DERIVATIVE_COLLATERAL_INSUFFICIENT");
    next.qty = pair.qty; next.spotEntryPrice = pair.spot.price; next.futureEntryPrice = pair.future.price;
    next.spotCashUsd -= spotNotional + pair.spot.feeUsd; next.derivativeCollateralUsd -= pair.future.feeUsd;
    next.peakCapitalDeployedUsd = Math.max(next.peakCapitalDeployedUsd, spotNotional + pair.spot.feeUsd + state.config.derivativeCollateralUsd);
    next.entryCount++;
  } else {
    if (pair.qty > state.qty && !near(pair.qty, state.qty) || state.qty === 0) throw new Error("CARRY_INVENTORY_OVER_REDUCTION");
    next.qty = cleanQty(state.qty - pair.qty);
    if (next.qty > 0 && ![state.config.spot, state.config.future].every(rule => next.qty >= rule.minQty && aligned(next.qty, rule.qtyIncrement)))
      throw new Error("CARRY_INVENTORY_UNEXECUTABLE_REMAINDER");
    const spotGross = pair.qty * (pair.spot.price - state.spotEntryPrice);
    const futureGross = pair.qty * (state.futureEntryPrice - pair.future.price);
    next.spotCashUsd += pair.qty * pair.spot.price - pair.spot.feeUsd;
    next.derivativeCollateralUsd += futureGross - pair.future.feeUsd;
    next.spotRealizedPricePnlUsd += spotGross; next.futureRealizedPricePnlUsd += futureGross;
    if (!next.qty) { next.spotEntryPrice = 0; next.futureEntryPrice = 0; }
    next.reductionCount++;
  }
  next.spotFeesUsd += pair.spot.feeUsd; next.futureFeesUsd += pair.future.feeUsd;
  return append(state, next, { type: "PAIR", observedAtMs: pair.atMs, pair });
}
export function observeCarryInventoryFunding(state: CarryInventoryState, rate: CarryInventoryFunding,
  observedAtMs: number): CarryInventoryState {
  checked(state, state.lastAtMs);
  if (!rate || !id(rate.id) || !time(rate.intervalEndMs) || rate.intervalEndMs < HOUR || rate.intervalEndMs % HOUR
    || !time(rate.knownAtMs) || rate.knownAtMs < rate.intervalEndMs || rate.knownAtMs > observedAtMs
    || !finite(rate.absoluteUsdPerBasePerHour)) throw new Error("CARRY_INVENTORY_INVALID_OR_FUTURE_FUNDING");
  const index = evidence(state), old = index.identities.get(`rate:${rate.id}`);
  if (old) { if (old.type === "FUNDING" && canonical(old.rate) === canonical(rate)) return state;
    throw new Error("CARRY_INVENTORY_CONFLICTING_FUNDING"); }
  checked(state, observedAtMs);
  if (index.intervalEnds.has(rate.intervalEndMs)) throw new Error("CARRY_INVENTORY_DUPLICATE_FUNDING_INTERVAL");
  const held = exposure(index.pairs, rate.intervalEndMs - HOUR, rate.intervalEndMs);
  const delta = times(times(held.baseQtyMs, decimal(rate.absoluteUsdPerBasePerHour)), rational(1n, BigInt(HOUR)));
  const previous = { n: BigInt(state.exactFundingCashUsd.numerator), d: BigInt(state.exactFundingCashUsd.denominator) };
  const total = plus(previous, delta), next = core(state);
  next.lastAtMs = observedAtMs; next.exactFundingCashUsd = exact(total); next.fundingCashUsd = number(total);
  next.coveredHeldMs += held.heldMs; next.derivativeCollateralUsd += number(delta);
  return append(state, next, { type: "FUNDING", observedAtMs, rate });
}
export function markCarryInventory(state: CarryInventoryState, mark: CarryInventoryMark) {
  checked(state, mark?.atMs);
  if (!mark || ![mark.spotPrice, mark.futurePrice].every(positive)) throw new Error("CARRY_INVENTORY_INVALID_MARK");
  const requiredHeldMs = exposure(evidence(state).pairs, state.config.startedAtMs, mark.atMs).heldMs;
  const missingFundingMs = requiredHeldMs - state.coveredHeldMs, fundingKnown = missingFundingMs === 0;
  if (missingFundingMs < 0) throw new Error("CARRY_INVENTORY_FUNDING_COVERAGE_OVERFLOW");
  const spotUnrealized = state.qty * (mark.spotPrice - state.spotEntryPrice);
  const futureUnrealized = state.qty * (state.futureEntryPrice - mark.futurePrice);
  const spotGross = state.spotRealizedPricePnlUsd + spotUnrealized;
  const futureGross = state.futureRealizedPricePnlUsd + futureUnrealized;
  const spotExitFee = state.qty * mark.spotPrice * state.config.spotExitFeeBps / 10_000;
  const futureExitFee = state.qty * mark.futurePrice * state.config.futureExitFeeBps / 10_000;
  const knownCashNetPnlUsd = state.spotRealizedPricePnlUsd + state.futureRealizedPricePnlUsd
    - state.spotFeesUsd - state.futureFeesUsd + state.fundingCashUsd;
  const knownMarkedNet = spotGross + futureGross - state.spotFeesUsd - state.futureFeesUsd + state.fundingCashUsd;
  const initialCapitalUsd = state.config.spotCashUsd + state.config.derivativeCollateralUsd;
  const derivativeEquity = state.derivativeCollateralUsd + futureUnrealized;
  const requiredMarginUsd = state.qty * mark.futurePrice * state.config.maintenanceMarginFraction;
  const coveredEquity = derivativeEquity - futureExitFee;
  const result = { version: state.version, asOfMs: mark.atMs, matchedBaseQty: state.qty,
    cash: { spotUsd: state.spotCashUsd, derivativeCollateralUsd: state.derivativeCollateralUsd },
    spot: { realizedPricePnlUsd: state.spotRealizedPricePnlUsd, unrealizedPricePnlUsd: spotUnrealized,
      grossPricePnlUsd: spotGross, feesUsd: state.spotFeesUsd, estimatedExitFeeUsd: spotExitFee },
    future: { realizedPricePnlUsd: state.futureRealizedPricePnlUsd, unrealizedPricePnlUsd: futureUnrealized,
      grossPricePnlUsd: futureGross, feesUsd: state.futureFeesUsd, estimatedExitFeeUsd: futureExitFee },
    grossPricePnlUsd: spotGross + futureGross, feesUsd: state.spotFeesUsd + state.futureFeesUsd,
    fundingKnown, missingFundingMs, knownFundingCashUsd: state.fundingCashUsd,
    fundingCashUsd: fundingKnown ? state.fundingCashUsd : null, knownCashNetPnlUsd,
    cashNetPnlUsd: fundingKnown ? knownCashNetPnlUsd : null,
    markedNetPnlUsd: fundingKnown ? knownMarkedNet : null,
    liquidationNetPnlUsd: fundingKnown ? knownMarkedNet - spotExitFee - futureExitFee : null,
    equityUsd: fundingKnown ? initialCapitalUsd + knownMarkedNet : null,
    knownCashEquityUsd: initialCapitalUsd + knownMarkedNet,
    liquidationEquityUsd: fundingKnown ? initialCapitalUsd + knownMarkedNet - spotExitFee - futureExitFee : null,
    initialCapitalUsd, capitalDeployedUsd: state.qty * state.spotEntryPrice + state.config.derivativeCollateralUsd,
    peakCapitalDeployedUsd: state.peakCapitalDeployedUsd,
    margin: { fraction: state.config.maintenanceMarginFraction, requiredMarginUsd,
      derivativeEquityUsd: fundingKnown ? derivativeEquity : null,
      afterExitFeeEquityUsd: fundingKnown ? coveredEquity : null,
      collateralUtilization: fundingKnown && coveredEquity > 0 ? requiredMarginUsd / coveredEquity : null,
      coverageRatio: fundingKnown && requiredMarginUsd > 0 ? coveredEquity / requiredMarginUsd : null,
      covered: fundingKnown ? coveredEquity >= requiredMarginUsd : null },
    source: "MATCHED_PAIR_ECONOMIC_ACCOUNTING_NOT_VERIFIED_VENUE_SETTLEMENT", realOrdersAllowed: false as const };
  const numericLeaves = (value: unknown): number[] => typeof value === "number" ? [value]
    : value && typeof value === "object" ? Object.values(value).flatMap(numericLeaves) : [];
  if (!numericLeaves(result).every(finite)) throw new Error("CARRY_INVENTORY_ARITHMETIC_OVERFLOW");
  return result;
}
export function boundCarryInventoryEquity(state: CarryInventoryState, input: {
  atMs: number; spotLow: number; spotHigh: number; futureLow: number; futureHigh: number;
}) {
  if (!input || ![input.spotLow, input.spotHigh, input.futureLow, input.futureHigh].every(positive)
    || input.spotLow > input.spotHigh || input.futureLow > input.futureHigh) throw new Error("CARRY_INVENTORY_INVALID_BOUNDS");
  const lower = markCarryInventory(state, { atMs: input.atMs, spotPrice: input.spotLow, futurePrice: input.futureHigh });
  const upper = markCarryInventory(state, { atMs: input.atMs, spotPrice: input.spotHigh, futurePrice: input.futureLow });
  return { interpretation: CARRY_INVENTORY_SPEC.bounds, asOfMs: input.atMs,
    equityLowerUsd: lower.equityUsd, equityUpperUsd: upper.equityUsd,
    liquidationEquityLowerUsd: lower.liquidationEquityUsd, liquidationEquityUpperUsd: upper.liquidationEquityUsd,
    worstDerivativeMargin: lower.margin, fundingKnown: lower.fundingKnown, synchronizedDrawdownUsd: null };
}
/** Slippage is applied separately to each leg before adverse tick rounding. */
export function carryInventoryExecution(input: {
  side: 1 | -1; qty: number; referencePrice: number; slippageBps: number; feeBps: number; priceIncrement: number;
}) {
  if (!input || ![1, -1].includes(input.side) || ![input.qty, input.referencePrice, input.priceIncrement].every(positive)
    || ![input.slippageBps, input.feeBps].every(x => finite(x) && x >= 0 && x < 10_000))
    throw new Error("CARRY_INVENTORY_INVALID_EXECUTION");
  const reference = decimal(input.referencePrice), tick = decimal(input.priceIncrement);
  const adjusted = times(reference, plus(rational(1n), times(decimal(input.side * input.slippageBps), rational(1n, 10_000n))));
  const units = times(adjusted, { n: tick.d, d: tick.n });
  const rounded = input.side === 1 ? (units.n + units.d - 1n) / units.d : units.n / units.d;
  const priceExact = times(rational(rounded), tick), price = number(priceExact);
  const feeUsd = number(times(times(decimal(input.qty), priceExact), times(decimal(input.feeBps), rational(1n, 10_000n))));
  const slippageUsd = number(times(times(decimal(input.side * input.qty),
    plus(priceExact, { n: -reference.n, d: reference.d })), rational(1n)));
  if (![price, feeUsd, slippageUsd].every(finite) || price <= 0 || slippageUsd < -1e-10)
    throw new Error("CARRY_INVENTORY_ARITHMETIC_OVERFLOW");
  return { price, feeUsd, slippageUsd };
}
export function validateCarryInventoryState(value: unknown, nowMs?: number): value is CarryInventoryState {
  try {
    const state = value as CarryInventoryState;
    if (!state || state.version !== CARRY_INVENTORY_SPEC.version || !Array.isArray(state.events)
      || nowMs !== undefined && (!time(nowMs) || state.lastAtMs > nowMs)) return false;
    if (trusted.has(state)) return true;
    let expected = newCarryInventory(state.config);
    for (const event of state.events) {
      if (event.type === "PAIR") {
        if (event.observedAtMs !== event.pair.atMs) return false;
        expected = applyCarryInventoryPair(expected, event.pair);
      } else if (event.type === "FUNDING") expected = observeCarryInventoryFunding(expected, event.rate, event.observedAtMs);
      else return false;
    }
    return canonical(expected) === canonical(state);
  } catch { return false; }
}
export function restoreCarryInventoryState(value: unknown, nowMs: number): CarryInventoryState {
  if (!validateCarryInventoryState(value, nowMs)) throw new Error("CARRY_INVENTORY_INVALID_CHECKPOINT");
  const state = freeze(structuredClone(value)); trusted.add(state); return state;
}
