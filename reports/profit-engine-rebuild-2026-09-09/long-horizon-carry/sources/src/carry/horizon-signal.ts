import type { FundingRow } from "../research/hourly-data.js";
import { HORIZON_CARRY_SPEC as S } from "./horizon-spec.js";

export interface HorizonSignalInput {
  atMs: number; spotPrice: number; futurePrice: number; funding: readonly FundingRow[];
  spotFeeBps: number; futureFeeBps: number; slippageBps: number;
  fundingEndShiftMs: 0 | 3600000;
}

/** Cash forecast on fixed base quantity. Prices and rates must already be
 * causally admitted by the caller. No relative-rate/current-price substitution. */
export function horizonCarrySignal(input: HorizonSignalInput) {
  const hour = S.hourMs, lookbackHours = S.forecastLookbackDays * 24, horizonHours = S.holdingDays * 24;
  if (!Number.isSafeInteger(input.atMs) || input.atMs < lookbackHours * hour
    || ![input.spotPrice, input.futurePrice].every(v => Number.isFinite(v) && v > 0)
    || ![input.spotFeeBps, input.futureFeeBps, input.slippageBps].every(v => Number.isFinite(v) && v >= 0 && v < 10_000)
    || ![0, hour].includes(input.fundingEndShiftMs)) throw new Error("INVALID_HORIZON_SIGNAL_INPUT");
  const lastEnd = Math.floor((input.atMs - S.decisionDelayMs) / hour) * hour;
  const rates = new Map<number, number>();
  for (const row of input.funding) {
    if (row.symbol !== "BTC/USD") continue;
    const end = row.timestampMs + input.fundingEndShiftMs;
    // Future and out-of-window values are excluded before reading prices/rates.
    if (end > lastEnd || end <= lastEnd - lookbackHours * hour) continue;
    if (end % hour || row.absoluteRate === undefined || !Number.isFinite(row.absoluteRate))
      throw new Error("INVALID_HORIZON_ABSOLUTE_FUNDING");
    if (rates.has(end)) throw new Error("DUPLICATE_HORIZON_FUNDING");
    rates.set(end, row.absoluteRate);
  }
  let total = 0, missingHours = 0, recent = 0;
  for (let end = lastEnd - (lookbackHours - 1) * hour; end <= lastEnd; end += hour) {
    const value = rates.get(end);
    if (value === undefined) missingHours++;
    else { total += value; if (end > lastEnd - S.fundingExitLookbackDays * 24 * hour) recent += value; }
  }
  const meanAbsolute = missingHours ? null : total / lookbackHours;
  const fundingPerBase = meanAbsolute === null ? null : S.forecastHaircutFraction * meanAbsolute * horizonHours;
  // Fees on each execution, with adverse price movement charged separately.
  const slip = input.slippageBps / 10_000;
  const feesPerBase = input.spotPrice * input.spotFeeBps / 10_000 * 2
    + input.futurePrice * input.futureFeeBps / 10_000 * 2;
  const slippagePerBase = (input.spotPrice + input.futurePrice) * slip * 2;
  const spotCashPerBase = input.spotPrice * (1 + slip) * (1 + input.spotFeeBps / 10_000);
  const collateralPerBase = input.futurePrice * S.collateralMultiple;
  const capitalPerBase = spotCashPerBase + collateralPerBase;
  const capitalHurdlePerBase = capitalPerBase * S.annualCapitalHurdleFraction * S.holdingDays / S.yearDays;
  const reservePerBase = Math.max(input.spotPrice, input.futurePrice) * S.basisUnwindReserveBps / 10_000;
  const cashCostPerBase = feesPerBase + slippagePerBase;
  const requiredPerBase = cashCostPerBase + reservePerBase + capitalHurdlePerBase;
  return { atMs: input.atMs, lastAdmittedFundingEndMs: lastEnd, missingHours,
    meanAbsoluteFundingUsdPerBasePerHour: meanAbsolute,
    trailingFundingAnnualizedFraction: meanAbsolute === null ? null : meanAbsolute * S.yearDays * 24 / input.futurePrice,
    recent28DayMeanAbsolute: missingHours ? null : recent / (S.fundingExitLookbackDays * 24),
    expectedHaircutFundingPerBase: fundingPerBase, feesPerBase, slippagePerBase,
    cashCostPerBase, capitalPerBase, spotCashPerBase, collateralPerBase, capitalHurdlePerBase,
    basisUnwindReservePerBase: reservePerBase, requiredPerBase,
    expectedExcessPerBase: fundingPerBase === null ? null : fundingPerBase - requiredPerBase,
    entryAllowed: fundingPerBase !== null && fundingPerBase > requiredPerBase,
    reason: missingHours ? "MISSING_MATURE_FUNDING" : fundingPerBase! > requiredPerBase ? "POSITIVE_PROJECTED_EXCESS" : "FUNDING_BELOW_FULL_ECONOMIC_HURDLE",
    forecastMeaning: "TRAILING_ABSOLUTE_RATE_WITH_50_PERCENT_HAIRCUT_IS_A_SCENARIO_NOT_A_GUARANTEED_RETURN" };
}
