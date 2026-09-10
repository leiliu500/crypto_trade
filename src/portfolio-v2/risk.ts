import { createHash } from "node:crypto";

export const RISK_SPEC = Object.freeze({ version: "btc-eth-liquidation-risk-governor-v2", maximumGrossNotionalUsd: 12,
  drawdownBudgetUsd: 3, dailyLossBudgetUsd: 1.2, dayMs: 86_400_000,
  capFormula: "12*min(1,max(0,1-drawdown/3),max(0,1-dailyLoss/1.2))",
  peak: "INITIAL_EQUITY_THEN_MONOTONIC_OBSERVED_LIQUIDATION_PEAK",
  drawdownBreach: "PERMANENT_LATCH", dailyBreach: "LATCH_UNTIL_NEXT_UTC_DAY",
  accountingUnknown: "PERMANENT_LATCH_AND_FORCE_FLAT",
  dailyBoundary: "FIRST_PRETRADE_OBSERVATION_SETTLES_PREVIOUS_DAY_THEN_SETS_NEW_DAY_REFERENCE",
  equalTimestampOrdering: "ORDERED_PRETRADE_THEN_POSTFILL_OBSERVATIONS_ALLOWED",
  missingDayBoundary: "ACCOUNTING_UNKNOWN_PERMANENT_LATCH",
  targetScaling: "ORIGINAL_TARGET_USD_TIMES_CAP_DIVIDED_BY_12_ONCE",
  costs: "LIQUIDATION_EQUITY_INCLUDES_PAID_FEES_FUNDING_AND_EXECUTABLE_EXIT_COSTS",
});
export interface RiskObservation {
  readonly atMs: number; readonly liquidationEquityUsd: number | null; readonly accountingKnown: boolean;
}
interface RiskCore {
  readonly version: typeof RISK_SPEC.version; readonly initialEquityUsd: number;
  readonly peakLiquidationEquityUsd: number; readonly lastAtMs: number | null;
  readonly lastLiquidationEquityUsd: number | null; readonly utcDayStartMs: number | null;
  readonly dailyReferenceEquityUsd: number | null; readonly drawdownUsd: number | null;
  readonly dailyLossUsd: number | null; readonly maximumDrawdownUsd: number; readonly maximumObservedDailyLossUsd: number;
  readonly drawdownHalted: boolean; readonly dailyHalted: boolean; readonly accountingHalted: boolean;
  readonly previousDayLossUsd: number | null; readonly previousDayHalted: boolean | null;
  readonly lastAccountingKnown: boolean;
}
export interface RiskGovernorState extends RiskCore {
  readonly observations: readonly RiskObservation[];
  readonly observationsSha256: string; readonly stateSha256: string;
}
export interface RiskGovernorDecision {
  readonly atMs: number | null; readonly maximumGrossNotionalUsd: number; readonly exposureScale: number;
  readonly drawdownUsd: number | null; readonly dailyLossUsd: number | null;
  readonly drawdownHalted: boolean; readonly dailyHalted: boolean; readonly accountingHalted: boolean;
  readonly forceFlat: boolean; readonly accountingKnown: boolean; readonly reasons: readonly string[];
  readonly previousDayLossUsd: number | null; readonly previousDayHalted: boolean | null;
}
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const time = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0;
const trusted = new WeakSet<object>();
const keys = ["version", "initialEquityUsd", "peakLiquidationEquityUsd", "lastAtMs", "lastLiquidationEquityUsd",
  "utcDayStartMs", "dailyReferenceEquityUsd", "drawdownUsd", "dailyLossUsd", "maximumDrawdownUsd", "maximumObservedDailyLossUsd",
  "drawdownHalted", "dailyHalted", "accountingHalted", "previousDayLossUsd", "previousDayHalted", "lastAccountingKnown"] as const;
function initial(initialEquityUsd: number): RiskCore {
  if (!finite(initialEquityUsd) || initialEquityUsd <= 0) throw new Error("PORTFOLIO_RISK_INVALID_INITIAL_EQUITY");
  return { version: RISK_SPEC.version, initialEquityUsd, peakLiquidationEquityUsd: initialEquityUsd,
    lastAtMs: null, lastLiquidationEquityUsd: null, utcDayStartMs: null, dailyReferenceEquityUsd: null,
    drawdownUsd: null, dailyLossUsd: null, maximumDrawdownUsd: 0, maximumObservedDailyLossUsd: 0,
    drawdownHalted: false, dailyHalted: false, accountingHalted: false,
    previousDayLossUsd: null, previousDayHalted: null, lastAccountingKnown: false };
}
function core(state: RiskCore): RiskCore {
  return Object.fromEntries(keys.map(key => [key, state[key]])) as unknown as RiskCore;
}
const seedHash = (initialEquityUsd: number) => sha({ spec: RISK_SPEC, initialEquityUsd });
const chainHash = (previous: string, observation: RiskObservation) => sha({ previous, observation });
function finish(value: RiskCore, observations: readonly RiskObservation[], observationsSha256: string): RiskGovernorState {
  const base = core(value);
  const state = Object.freeze({ ...base, observations: Object.freeze(observations), observationsSha256,
    stateSha256: sha({ ...base, observationCount: observations.length, observationsSha256 }) });
  trusted.add(state); return state;
}
function observation(value: RiskObservation): RiskObservation {
  if (!value || !time(value.atMs) || typeof value.accountingKnown !== "boolean"
    || value.liquidationEquityUsd !== null && !finite(value.liquidationEquityUsd)) throw new Error("PORTFOLIO_RISK_INVALID_OBSERVATION");
  return Object.freeze({ atMs: value.atMs, liquidationEquityUsd: value.liquidationEquityUsd, accountingKnown: value.accountingKnown });
}
function breach(loss: number, budget: number, reference: number): boolean {
  // Decimal USD budgets must not miss a boundary through subtraction rounding.
  return loss >= budget || budget - loss <= Number.EPSILON * 8 * Math.max(1, Math.abs(reference));
}
function advance(state: RiskCore, input: RiskObservation): RiskCore {
  if (state.lastAtMs !== null && input.atMs < state.lastAtMs) throw new Error("PORTFOLIO_RISK_REVERSED_TIME");
  const day = Math.floor(input.atMs / RISK_SPEC.dayMs) * RISK_SPEC.dayMs;
  const newDay = state.utcDayStartMs !== null && day !== state.utcDayStartMs;
  const known = input.accountingKnown && input.liquidationEquityUsd !== null;
  const eq = known ? input.liquidationEquityUsd! : null;
  let accountingHalted = state.accountingHalted || !known;
  let peak = state.peakLiquidationEquityUsd, drawdown: number | null = null;
  let maxDrawdown = state.maximumDrawdownUsd, maximumDailyLoss = state.maximumObservedDailyLossUsd;
  let drawdownHalted = state.drawdownHalted, dailyHalted = state.dailyHalted;
  let dailyReference = state.dailyReferenceEquityUsd, dailyLoss: number | null = null;
  let previousDayLoss: number | null = null, previousDayHalted: boolean | null = null;
  if (eq !== null) {
    peak = Math.max(peak, eq); drawdown = Math.max(0, peak - eq);
    if (!finite(drawdown)) throw new Error("PORTFOLIO_RISK_ARITHMETIC_OVERFLOW");
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    drawdownHalted ||= breach(drawdown, RISK_SPEC.drawdownBudgetUsd, peak);
    if (dailyReference !== null) {
      dailyLoss = Math.max(0, dailyReference - eq);
      if (!finite(dailyLoss)) throw new Error("PORTFOLIO_RISK_ARITHMETIC_OVERFLOW");
      maximumDailyLoss = Math.max(maximumDailyLoss, dailyLoss);
      dailyHalted ||= breach(dailyLoss, RISK_SPEC.dailyLossBudgetUsd, dailyReference);
    }
  }
  if (newDay) {
    // Caller sends ending-interval funding/price mark BEFORE boundary fills.
    // This observation still tests the previous day's loss before resetting.
    previousDayLoss = dailyLoss; previousDayHalted = dailyHalted;
    if (input.atMs !== day || state.utcDayStartMs! + RISK_SPEC.dayMs !== day) accountingHalted = true;
    dailyReference = eq; dailyLoss = eq === null ? null : 0; dailyHalted = false;
  } else if (state.utcDayStartMs === null) {
    // The first observation is the account's pretrade starting reference.
    dailyReference = eq; dailyLoss = eq === null ? null : 0;
  }
  if (dailyReference === null) accountingHalted = true;
  return { version: RISK_SPEC.version, initialEquityUsd: state.initialEquityUsd, peakLiquidationEquityUsd: peak,
    lastAtMs: input.atMs, lastLiquidationEquityUsd: eq, utcDayStartMs: day, dailyReferenceEquityUsd: dailyReference,
    drawdownUsd: drawdown, dailyLossUsd: dailyLoss, maximumDrawdownUsd: maxDrawdown,
    maximumObservedDailyLossUsd: maximumDailyLoss, drawdownHalted, dailyHalted, accountingHalted,
    previousDayLossUsd: previousDayLoss, previousDayHalted, lastAccountingKnown: known };
}

export function newRiskGovernorState(initialEquityUsd = 100_000): RiskGovernorState {
  return finish(initial(initialEquityUsd), [], seedHash(initialEquityUsd));
}

/** Validates the complete ordered observation history and both hashes. An
 * optional explicit cutoff rejects future checkpoints without ambient clocks.
 * Frozen internally constructed states are trusted for constant-time updates.
 */
export function validateRiskGovernorState(value: unknown, nowMs?: number): value is RiskGovernorState {
  try {
    if (nowMs !== undefined && !time(nowMs)) return false;
    const state = value as RiskGovernorState;
    if (!state || state.version !== RISK_SPEC.version || !Array.isArray(state.observations)
      || state.lastAtMs !== null && (!time(state.lastAtMs) || nowMs !== undefined && state.lastAtMs > nowMs)) return false;
    if (trusted.has(state)) return true;
    let expected = initial(state.initialEquityUsd), chain = seedHash(state.initialEquityUsd);
    for (const row of state.observations) {
      const accepted = observation(row); expected = advance(expected, accepted); chain = chainHash(chain, accepted);
    }
    return keys.every(key => state[key] === expected[key]) && state.observationsSha256 === chain
      && state.stateSha256 === sha({ ...expected, observationCount: state.observations.length, observationsSha256: chain });
  } catch { return false; }
}

export function restoreRiskGovernorState(value: unknown, nowMs: number): RiskGovernorState {
  if (!validateRiskGovernorState(value, nowMs)) throw new Error("PORTFOLIO_RISK_INVALID_CHECKPOINT");
  return finish(core(value), value.observations.map(observation), value.observationsSha256);
}

export function riskGovernorDecision(state: RiskGovernorState): RiskGovernorDecision {
  if (!validateRiskGovernorState(state)) throw new Error("PORTFOLIO_RISK_INVALID_STATE");
  const reasons: string[] = [];
  if (state.accountingHalted) reasons.push("ACCOUNTING_UNKNOWN_LATCHED");
  if (state.drawdownHalted) reasons.push("DRAWDOWN_BUDGET_LATCHED");
  if (state.dailyHalted) reasons.push("DAILY_LOSS_BUDGET_LATCHED");
  if (!state.lastAccountingKnown) reasons.push("NO_KNOWN_LIQUIDATION_OBSERVATION");
  const halted = state.accountingHalted || state.drawdownHalted || state.dailyHalted || !state.lastAccountingKnown;
  const exposureScale = halted ? 0 : Math.min(1,
    Math.max(0, 1 - state.drawdownUsd! / RISK_SPEC.drawdownBudgetUsd),
    Math.max(0, 1 - state.dailyLossUsd! / RISK_SPEC.dailyLossBudgetUsd));
  if (!halted && state.drawdownUsd! > 0) reasons.push("DRAWDOWN_BUDGET_SCALING");
  if (!halted && state.dailyLossUsd! > 0) reasons.push("DAILY_LOSS_BUDGET_SCALING");
  if (!reasons.length) reasons.push("RISK_BUDGET_AVAILABLE");
  return Object.freeze({ atMs: state.lastAtMs, maximumGrossNotionalUsd: RISK_SPEC.maximumGrossNotionalUsd * exposureScale,
    exposureScale, drawdownUsd: state.drawdownUsd, dailyLossUsd: state.dailyLossUsd,
    drawdownHalted: state.drawdownHalted, dailyHalted: state.dailyHalted, accountingHalted: state.accountingHalted,
    accountingKnown: state.lastAccountingKnown, forceFlat: exposureScale === 0, reasons: Object.freeze(reasons),
    previousDayLossUsd: state.previousDayLossUsd, previousDayHalted: state.previousDayHalted });
}

/** Pure transition. Same-timestamp observations are deliberately ordered:
 * pretrade boundary accounting first, then each fill/fee receipt. No trade
 * outcome or future observation is used to construct an earlier risk decision.
 */
export function updateRiskGovernor(state: RiskGovernorState, input: RiskObservation):
  { state: RiskGovernorState; decision: RiskGovernorDecision } {
  if (!validateRiskGovernorState(state)) throw new Error("PORTFOLIO_RISK_INVALID_STATE");
  const accepted = observation(input), nextCore = advance(state, accepted);
  const prior = trusted.has(state) ? state.observations : state.observations.map(observation);
  const next = finish(nextCore, [...prior, accepted], chainHash(state.observationsSha256, accepted));
  return { state: next, decision: riskGovernorDecision(next) };
}
