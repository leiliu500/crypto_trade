/** Research-only arithmetic for funded spot longs matched to short linear USD
 * derivatives. Every quantity is BASE units, not a contract count. No input
 * annual rate or constant-price scenario is a forecast or an activation rule. */
export const CARRY_ECONOMICS_VERSION = "funded-spot-linear-carry-economics-v1";
const YEAR_HOURS = 365 * 24, HOUR_MS = 3_600_000, DECIMAL_SCALE = 1_000_000_000_000n;

export interface CarryLeg {
  instrumentId: string;
  base: "BTC" | "ETH";
  quote: "USD";
  kind: "SPOT" | "LINEAR_PERPETUAL" | "LINEAR_DATED";
  expiryMs?: number;
  book: { bid: number; ask: number; bidBaseQty: number; askBaseQty: number;
    exchangeAtMs: number; receivedAtMs: number };
  rules: { minimumBaseQty: number; quantityStep: number | string;
    minimumNotionalUsd: number; maximumBaseQty?: number };
}
export interface CarryEconomicsInput {
  nowMs: number;
  spot: CarryLeg;
  derivative: CarryLeg;
  fees: { spotTakerBps: number; derivativeTakerBps: number; accountVerified: boolean };
  executionEvidenceVerified: boolean;
  budget: { availableGrossUsd: number; availableCashUsd: number; availableCollateralUsd: number;
    derivativeReserveFraction?: number };
  assumptions: { holdingHours: number; annualCapitalHurdleFraction: number;
    slippageBpsPerExecution: number; settlementBasisReserveBps: number; unwindReserveBps: number;
    maximumQuoteAgeMs: number; maximumQuoteSkewMs: number; maximumFundingAgeMs?: number;
    settlementSpotPriceScenariosUsd?: readonly number[] };
  /** Positive absolute funding is paid by longs and received by this short. */
  currentFunding?: { absoluteUsdPerBasePerHour: number; knownAtMs: number };
}
export interface CarryExecutionFees {
  spotEntryUsd: number; derivativeEntryUsd: number;
  spotExitUsd: number; derivativeExitUsd: number; totalUsd: number;
}
export interface CarryScenario {
  name: "DATED_CONSTANT_SETTLEMENT_PRICE" | "PERPETUAL_CONSTANT_CURRENT_FUNDING"
    | "PERPETUAL_ZERO_FUNDING" | "PERPETUAL_ADVERSE_CURRENT_MAGNITUDE";
  assumedSettlementSpotPriceUsd: number | null;
  assumedAbsoluteFundingUsdPerBasePerHour: number | null;
  grossBasisCaptureUsd: number;
  executionSpreadCostUsd: number;
  slippageCostUsd: number;
  fees: CarryExecutionFees;
  fundingIncomeUsd: number;
  capitalHurdleCostUsd: number;
  settlementBasisReserveUsd: number;
  unwindReserveUsd: number;
  netAfterCostsUsd: number;
  annualizedNetOnReservedCapitalFraction: number;
}
export interface CarryEconomicsResult {
  version: typeof CARRY_ECONOMICS_VERSION;
  status: "INVALID" | "INFEASIBLE" | "FEASIBLE";
  activationAllowed: false;
  evidenceComplete: boolean;
  reasons: string[];
  matchedQuantityStep: number | null;
  minimumMatchedBaseQty: number | null;
  minimumPairedGrossUsd: number | null;
  allocatedBaseQty: number;
  allocatedPairedGrossUsd: number;
  requiredCashUsd: number;
  requiredCollateralUsd: number;
  reservedCapitalUsd: number;
  derivativeReserveFraction: number;
  holdingHours: number | null;
  currentFundingAgeMs: number | null;
  entryBasisPerBaseUsd: number | null;
  entryBasisBps: number | null;
  entryBasisAnnualizedFraction: number | null;
  /** Worst declared exit-price scenario fee reserve; actual future fees vary. */
  executionFees: CarryExecutionFees | null;
  breakEvenAbsoluteFundingUsdPerBasePerHour: number | null;
  breakEvenAnnualFundingFractionOnSpotNotional: number | null;
  breakEvenAnnualCarryFractionOnSpotNotional: number | null;
  scenarios: CarryScenario[];
  conventions: readonly string[];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nonnegative = (v: unknown): v is number => finite(v) && v >= 0;
const timestamp = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Exact decimal lattice, restricted to at most twelve BASE-unit decimals. */
function decimalUnits(value: number | string): bigint {
  if (typeof value !== "number" && typeof value !== "string") throw new Error("CARRY_INVALID_QUANTITY_STEP");
  const text = String(value).replace(/^\./, "0."), match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || !finite(Number(text)) || !(Number(text) > 0)) throw new Error("CARRY_INVALID_QUANTITY_STEP");
  const fraction = match[2] ?? "", exponent = Number(match[3] ?? 0), power = 12 + exponent - fraction.length;
  if (!Number.isSafeInteger(power) || power < -100 || power > 100) throw new Error("CARRY_INVALID_QUANTITY_STEP");
  const digits = BigInt(match[1]! + fraction);
  const divisor = power < 0 ? 10n ** BigInt(-power) : 1n;
  if (digits % divisor !== 0n) throw new Error("CARRY_QUANTITY_PRECISION_EXCEEDED");
  const units = power < 0 ? digits / divisor : digits * 10n ** BigInt(power);
  if (units <= 0n || units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CARRY_INVALID_QUANTITY_STEP");
  return units;
}
function gcd(a: bigint, b: bigint): bigint { while (b) { const next = a % b; a = b; b = next; } return a; }
function jointUnits(a: number | string, b: number | string): bigint {
  const left = decimalUnits(a), right = decimalUnits(b), units = left / gcd(left, right) * right;
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CARRY_MATCHED_STEP_OUT_OF_RANGE");
  return units;
}
export function matchedCarryQuantityStep(spotStep: number | string, derivativeStep: number | string): number {
  return Number(jointUnits(spotStep, derivativeStep)) / Number(DECIMAL_SCALE);
}
function quantity(lots: number, step: bigint): number {
  if (!Number.isSafeInteger(lots) || lots < 0) throw new Error("CARRY_QUANTITY_OUT_OF_RANGE");
  const units = BigInt(lots) * step;
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CARRY_QUANTITY_OUT_OF_RANGE");
  return Number(units) / Number(DECIMAL_SCALE);
}
function feeAmounts(q: number, spotEntry: number, futureEntry: number, spotExit: number, futureExit: number,
  spotRate: number, futureRate: number): CarryExecutionFees {
  const spotEntryUsd = q * spotEntry * spotRate, derivativeEntryUsd = q * futureEntry * futureRate;
  const spotExitUsd = q * spotExit * spotRate, derivativeExitUsd = q * futureExit * futureRate;
  return { spotEntryUsd, derivativeEntryUsd, spotExitUsd, derivativeExitUsd,
    totalUsd: spotEntryUsd + derivativeEntryUsd + spotExitUsd + derivativeExitUsd };
}

export function evaluateCarryEconomics(input: CarryEconomicsInput): CarryEconomicsResult {
  const result: CarryEconomicsResult = { version: CARRY_ECONOMICS_VERSION, status: "INVALID", activationAllowed: false,
    evidenceComplete: false, reasons: [], matchedQuantityStep: null, minimumMatchedBaseQty: null,
    minimumPairedGrossUsd: null, allocatedBaseQty: 0, allocatedPairedGrossUsd: 0,
    requiredCashUsd: 0, requiredCollateralUsd: 0, reservedCapitalUsd: 0, derivativeReserveFraction: 1,
    holdingHours: null, currentFundingAgeMs: null, entryBasisPerBaseUsd: null, entryBasisBps: null,
    entryBasisAnnualizedFraction: null, executionFees: null, breakEvenAbsoluteFundingUsdPerBasePerHour: null,
    breakEvenAnnualFundingFractionOnSpotNotional: null, breakEvenAnnualCarryFractionOnSpotNotional: null, scenarios: [],
    conventions: ["Research scenarios only; this module never authorizes trading.",
      "Linear USD contracts only; all quantities and depth are underlying BASE units. Contract multipliers must be normalized by the adapter.",
      "Gross exposure is the sum of both legs valued at adverse current asks; no hedge netting or price-path cap guarantee.",
      "Cash reserves fund the spot purchase and both spot fees; collateral reserves fund the derivative reserve, both derivative fees, all slippage, and basis/unwind buffers.",
      "Dated scenarios assume convergence to each supplied settlement price and charge a conservative four-execution round trip, including derivative close fees.",
      "Perpetual scenarios preserve current spot and derivative bid/ask prices; quoted entry basis is not assumed to converge.",
      "Funding scenarios are hypothetical constant-rate paths, not forecasts. Adverse funding uses negative absolute magnitude.",
      "Capital hurdle is simple annual cost on reserved spot cash plus derivative collateral over a 365-day year; basis/unwind reserves use spot entry ask notional.",
      "Future exit depth, fees, basis, liquidity, margin calls and funding are unverified by current books; residual and one-leg execution risk requires a separate coordinator."] };
  const deny = (reason: string) => { result.reasons.push(reason); return result; };
  if (!input || !timestamp(input.nowMs) || !input.spot || !input.derivative || !input.fees
    || !input.budget || !input.assumptions) return deny("CARRY_INVALID_INPUT");
  const { spot, derivative: future, fees, budget, assumptions: a, nowMs } = input;
  if (spot.kind !== "SPOT" || !["LINEAR_PERPETUAL", "LINEAR_DATED"].includes(future.kind)
    || !["BTC", "ETH"].includes(spot.base) || spot.base !== future.base || spot.quote !== "USD" || future.quote !== "USD"
    || typeof spot.instrumentId !== "string" || !spot.instrumentId || typeof future.instrumentId !== "string"
    || !future.instrumentId || spot.instrumentId === future.instrumentId) return deny("CARRY_UNSUPPORTED_INSTRUMENT_PAIR");
  if (![a.holdingHours, a.maximumQuoteAgeMs, a.maximumQuoteSkewMs].every(v => finite(v) && v >= 0)
    || a.holdingHours <= 0 || !nonnegative(a.annualCapitalHurdleFraction)
    || !nonnegative(a.slippageBpsPerExecution) || a.slippageBpsPerExecution >= 10_000
    || !nonnegative(a.settlementBasisReserveBps) || !nonnegative(a.unwindReserveBps)
    || a.maximumFundingAgeMs !== undefined && !nonnegative(a.maximumFundingAgeMs)) return deny("CARRY_INVALID_ASSUMPTIONS");
  result.holdingHours = a.holdingHours;
  if (future.kind === "LINEAR_DATED" && (!timestamp(future.expiryMs) || future.expiryMs <= nowMs
    || Math.abs((future.expiryMs - nowMs) / HOUR_MS - a.holdingHours) > 1 / HOUR_MS))
    return deny("CARRY_INVALID_OR_MISMATCHED_EXPIRY");
  if (future.kind === "LINEAR_PERPETUAL" && future.expiryMs !== undefined) return deny("CARRY_PERPETUAL_HAS_EXPIRY");
  for (const leg of [spot, future]) {
    const b = leg.book, r = leg.rules;
    if (!b || !r || ![b.bid, b.ask].every(v => finite(v) && v > 0) || b.bid >= b.ask
      || ![b.bidBaseQty, b.askBaseQty].every(nonnegative)) return deny("CARRY_INVALID_OR_CROSSED_BOOK");
    if (!timestamp(b.exchangeAtMs) || !timestamp(b.receivedAtMs) || b.exchangeAtMs > b.receivedAtMs
      || b.receivedAtMs > nowMs) return deny("CARRY_FUTURE_OR_INVALID_QUOTE_TIME");
    if (nowMs - b.exchangeAtMs > a.maximumQuoteAgeMs || nowMs - b.receivedAtMs > a.maximumQuoteAgeMs)
      return deny("CARRY_STALE_BOOK");
    if (!finite(r.minimumBaseQty) || r.minimumBaseQty <= 0 || !nonnegative(r.minimumNotionalUsd)
      || r.maximumBaseQty !== undefined && (!finite(r.maximumBaseQty) || r.maximumBaseQty < r.minimumBaseQty))
      return deny("CARRY_INVALID_QUANTITY_RULES");
  }
  if (Math.abs(spot.book.exchangeAtMs - future.book.exchangeAtMs) > a.maximumQuoteSkewMs
    || Math.abs(spot.book.receivedAtMs - future.book.receivedAtMs) > a.maximumQuoteSkewMs)
    return deny("CARRY_UNSYNCHRONIZED_BOOKS");
  if (![fees.spotTakerBps, fees.derivativeTakerBps].every(v => nonnegative(v) && v <= 10_000)
    || typeof fees.accountVerified !== "boolean" || typeof input.executionEvidenceVerified !== "boolean")
    return deny("CARRY_INVALID_FEES_OR_EVIDENCE");
  const reserveFraction = budget.derivativeReserveFraction ?? 1;
  if (![budget.availableGrossUsd, budget.availableCashUsd, budget.availableCollateralUsd, reserveFraction].every(nonnegative))
    return deny("CARRY_INVALID_BUDGET");
  result.derivativeReserveFraction = reserveFraction;
  if (input.currentFunding) {
    if (!finite(input.currentFunding.absoluteUsdPerBasePerHour) || !timestamp(input.currentFunding.knownAtMs)
      || input.currentFunding.knownAtMs > nowMs) return deny("CARRY_FUTURE_OR_INVALID_FUNDING");
    result.currentFundingAgeMs = nowMs - input.currentFunding.knownAtMs;
    if (a.maximumFundingAgeMs !== undefined && result.currentFundingAgeMs > a.maximumFundingAgeMs)
      return deny("CARRY_STALE_FUNDING");
  }
  const settlementPrices = future.kind === "LINEAR_DATED" ? a.settlementSpotPriceScenariosUsd : undefined;
  if (future.kind === "LINEAR_DATED" && (!Array.isArray(settlementPrices) || !settlementPrices.length
    || settlementPrices.length > 100 || !settlementPrices.every(v => finite(v) && v > 0)))
    return deny("CARRY_DATED_SETTLEMENT_SCENARIOS_REQUIRED");
  let step: bigint;
  try { step = jointUnits(spot.rules.quantityStep, future.rules.quantityStep); }
  catch (error) { return deny(error instanceof Error ? error.message : "CARRY_INVALID_QUANTITY_STEP"); }
  const stepNumber = Number(step) / Number(DECIMAL_SCALE);
  result.matchedQuantityStep = stepNumber;
  const slip = a.slippageBpsPerExecution / 10_000, spotRate = fees.spotTakerBps / 10_000, futureRate = fees.derivativeTakerBps / 10_000;
  const sb = spot.book, fb = future.book;
  const spotEntry = sb.ask * (1 + slip), futureEntry = fb.bid * (1 - slip);
  const exitReference = settlementPrices ? Math.max(...settlementPrices) : null;
  const spotExit = (exitReference ?? sb.bid) * (1 - slip), futureExit = (exitReference ?? fb.ask) * (1 + slip);
  const unitFees = feeAmounts(1, spotEntry, futureEntry, spotExit, futureExit, spotRate, futureRate);
  const unitSlippage = slip * (sb.ask + fb.bid + (exitReference === null ? sb.bid + fb.ask : 2 * exitReference));
  const unitBasisReserve = sb.ask * a.settlementBasisReserveBps / 10_000, unitUnwindReserve = sb.ask * a.unwindReserveBps / 10_000;
  const unitGross = (sb.ask + fb.ask) * (1 + slip);
  const unitCash = spotEntry + unitFees.spotEntryUsd + unitFees.spotExitUsd;
  const unitCollateral = fb.ask * (1 + slip) * reserveFraction + unitFees.derivativeEntryUsd
    + unitFees.derivativeExitUsd + unitSlippage + unitBasisReserve + unitUnwindReserve;
  if (![unitGross, unitCash, unitCollateral, unitFees.totalUsd, unitSlippage].every(finite)
    || unitGross <= 0 || unitCash <= 0) return deny("CARRY_NONFINITE_COSTS");
  const minRaw = Math.max(spot.rules.minimumBaseQty, future.rules.minimumBaseQty,
    spot.rules.minimumNotionalUsd / spotEntry, future.rules.minimumNotionalUsd / futureEntry);
  let minLots = Math.max(1, Math.ceil(minRaw / stepNumber));
  let minQty: number;
  try {
    minQty = quantity(minLots, step);
    const satisfiesMinimum = (q: number) => q >= spot.rules.minimumBaseQty && q >= future.rules.minimumBaseQty
      && q * spotEntry >= spot.rules.minimumNotionalUsd && q * futureEntry >= future.rules.minimumNotionalUsd;
    if (!satisfiesMinimum(minQty)) minQty = quantity(++minLots, step);
    if (minLots > 1 && satisfiesMinimum(quantity(minLots - 1, step))) minQty = quantity(--minLots, step);
  } catch { return deny("CARRY_QUANTITY_OUT_OF_RANGE"); }
  const minimumGross = minQty * unitGross, entryAnnual = (fb.bid / sb.ask - 1) * YEAR_HOURS / a.holdingHours;
  if (![minimumGross, entryAnnual, (fb.bid / sb.ask - 1) * 10_000].every(finite) || minimumGross <= 0)
    return deny("CARRY_NONFINITE_ECONOMICS");
  result.minimumMatchedBaseQty = minQty; result.minimumPairedGrossUsd = minimumGross;
  result.entryBasisPerBaseUsd = fb.bid - sb.ask;
  result.entryBasisBps = (fb.bid / sb.ask - 1) * 10_000;
  result.entryBasisAnnualizedFraction = entryAnnual;
  const maxima = [sb.askBaseQty, fb.bidBaseQty, spot.rules.maximumBaseQty ?? Infinity, future.rules.maximumBaseQty ?? Infinity];
  const maxDepth = Math.min(...maxima), cashQty = budget.availableCashUsd / unitCash;
  const collateralQty = unitCollateral > 0 ? budget.availableCollateralUsd / unitCollateral : Infinity;
  const rawMaximum = Math.min(maxDepth, budget.availableGrossUsd / unitGross, cashQty, collateralQty);
  let lots = Math.max(0, Math.floor(rawMaximum / stepNumber)), q: number;
  const fits = (x: number) => x <= maxDepth && x * unitGross <= budget.availableGrossUsd
    && x * unitCash <= budget.availableCashUsd && x * unitCollateral <= budget.availableCollateralUsd;
  try {
    q = quantity(lots, step);
    if (!fits(q) && lots > 0) q = quantity(--lots, step);
    // Recover a floating division underflow only when the exact lattice point
    // independently satisfies every budget and depth constraint. Never round a
    // genuinely oversized quantity up to fit a minimum lot.
    if (Number.isSafeInteger(lots + 1) && fits(quantity(lots + 1, step))) q = quantity(++lots, step);
  } catch { return deny("CARRY_QUANTITY_OUT_OF_RANGE"); }
  if (!fees.accountVerified) result.reasons.push("CARRY_ACCOUNT_FEES_UNVERIFIED");
  if (!input.executionEvidenceVerified) result.reasons.push("CARRY_EXECUTION_EVIDENCE_UNVERIFIED");
  if (future.kind === "LINEAR_PERPETUAL" && !input.currentFunding) result.reasons.push("CARRY_CURRENT_FUNDING_UNAVAILABLE");
  if (future.kind === "LINEAR_PERPETUAL" && a.maximumFundingAgeMs === undefined)
    result.reasons.push("CARRY_FUNDING_AGE_LIMIT_UNSPECIFIED");
  result.evidenceComplete = fees.accountVerified && input.executionEvidenceVerified
    && (future.kind === "LINEAR_DATED" || !!input.currentFunding && a.maximumFundingAgeMs !== undefined);
  if (q < minQty || !fits(q)) {
    result.status = "INFEASIBLE";
    if (minQty * unitGross > budget.availableGrossUsd) result.reasons.push("CARRY_MINIMUM_PAIR_EXCEEDS_GROSS_BUDGET");
    if (minQty * unitCash > budget.availableCashUsd) result.reasons.push("CARRY_MINIMUM_PAIR_EXCEEDS_CASH_BUDGET");
    if (minQty * unitCollateral > budget.availableCollateralUsd) result.reasons.push("CARRY_MINIMUM_PAIR_EXCEEDS_COLLATERAL_BUDGET");
    if (minQty > maxDepth) result.reasons.push("CARRY_MINIMUM_PAIR_EXCEEDS_DEPTH_OR_MAXIMUM_QUANTITY");
    return result;
  }
  result.status = "FEASIBLE"; result.allocatedBaseQty = q; result.allocatedPairedGrossUsd = q * unitGross;
  result.requiredCashUsd = q * unitCash; result.requiredCollateralUsd = q * unitCollateral;
  result.reservedCapitalUsd = result.requiredCashUsd + result.requiredCollateralUsd;
  result.executionFees = feeAmounts(q, spotEntry, futureEntry, spotExit, futureExit, spotRate, futureRate);
  const capitalCost = result.reservedCapitalUsd * a.annualCapitalHurdleFraction * a.holdingHours / YEAR_HOURS;
  const makeScenario = (name: CarryScenario["name"], settlement: number | null, funding: number | null): CarryScenario => {
    const exitSpotRaw = settlement ?? sb.bid, exitFutureRaw = settlement ?? fb.ask;
    const scenarioFees = feeAmounts(q, spotEntry, futureEntry, exitSpotRaw * (1 - slip), exitFutureRaw * (1 + slip), spotRate, futureRate);
    const grossBasisCaptureUsd = settlement === null ? 0 : q * (fb.bid - sb.ask);
    const executionSpreadCostUsd = settlement === null ? q * (sb.ask - sb.bid + fb.ask - fb.bid) : 0;
    const slippageCostUsd = q * slip * (sb.ask + fb.bid + exitSpotRaw + exitFutureRaw);
    const fundingIncomeUsd = q * (funding ?? 0) * a.holdingHours;
    const settlementBasisReserveUsd = q * unitBasisReserve, unwindReserveUsd = q * unitUnwindReserve;
    const netAfterCostsUsd = grossBasisCaptureUsd + fundingIncomeUsd - executionSpreadCostUsd - slippageCostUsd
      - scenarioFees.totalUsd - capitalCost - settlementBasisReserveUsd - unwindReserveUsd;
    return { name, assumedSettlementSpotPriceUsd: settlement, assumedAbsoluteFundingUsdPerBasePerHour: funding,
      grossBasisCaptureUsd, executionSpreadCostUsd, slippageCostUsd, fees: scenarioFees, fundingIncomeUsd,
      capitalHurdleCostUsd: capitalCost, settlementBasisReserveUsd, unwindReserveUsd, netAfterCostsUsd,
      annualizedNetOnReservedCapitalFraction: netAfterCostsUsd / result.reservedCapitalUsd * YEAR_HOURS / a.holdingHours };
  };
  if (settlementPrices) {
    result.scenarios = settlementPrices.map(price => makeScenario("DATED_CONSTANT_SETTLEMENT_PRICE", price, null));
  } else {
    const current = input.currentFunding?.absoluteUsdPerBasePerHour;
    if (current !== undefined) result.scenarios.push(makeScenario("PERPETUAL_CONSTANT_CURRENT_FUNDING", null, current));
    result.scenarios.push(makeScenario("PERPETUAL_ZERO_FUNDING", null, 0));
    if (current !== undefined) result.scenarios.push(makeScenario("PERPETUAL_ADVERSE_CURRENT_MAGNITUDE", null, -Math.abs(current)));
  }
  const maximumCost = Math.max(...result.scenarios.map(s => s.executionSpreadCostUsd + s.slippageCostUsd
    + s.fees.totalUsd + s.capitalHurdleCostUsd + s.settlementBasisReserveUsd + s.unwindReserveUsd));
  result.breakEvenAnnualCarryFractionOnSpotNotional = maximumCost / (q * sb.ask) * YEAR_HOURS / a.holdingHours;
  if (!settlementPrices) {
    result.breakEvenAbsoluteFundingUsdPerBasePerHour = maximumCost / q / a.holdingHours;
    result.breakEvenAnnualFundingFractionOnSpotNotional = result.breakEvenAbsoluteFundingUsdPerBasePerHour * YEAR_HOURS / sb.ask;
  }
  if (![capitalCost, maximumCost, result.minimumPairedGrossUsd, result.reservedCapitalUsd,
    result.entryBasisAnnualizedFraction, result.breakEvenAnnualCarryFractionOnSpotNotional,
    ...result.scenarios.flatMap(s => [s.netAfterCostsUsd, s.annualizedNetOnReservedCapitalFraction])].every(finite)) {
    return { ...result, status: "INVALID", allocatedBaseQty: 0, allocatedPairedGrossUsd: 0,
      requiredCashUsd: 0, requiredCollateralUsd: 0, reservedCapitalUsd: 0, executionFees: null,
      breakEvenAbsoluteFundingUsdPerBasePerHour: null, breakEvenAnnualFundingFractionOnSpotNotional: null,
      breakEvenAnnualCarryFractionOnSpotNotional: null, scenarios: [], reasons: [...result.reasons, "CARRY_NONFINITE_ECONOMICS"] };
  }
  return result;
}
