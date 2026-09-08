import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SPEC, type DistributionAction } from "./spec.js";

/** Prespecified offline comparisons. These settings do not authorize orders,
 * change the deployed policy, or claim an empirically optimal horizon. */
export const HORIZON_RESEARCH_SPEC = Object.freeze({
  version: "btc-eth-horizon-comparison-v1",
  horizonsMinutes: Object.freeze([1, 3, 5, 15, 30] as const),
  proposalIntervalMs: 1_860_000,
  minimumTrainingPanels: 24,
  minimumTrainingDays: 3,
  volatilityLookbackMs: 30 * 60_000,
  fixedStopLossBps: 25,
  fixedTakeProfitNetBps: 40,
  volatilityStopSigmaMultiplier: 1,
  volatilityTargetSigmaMultiplier: 1.6,
  minimumVolatilityStopLossBps: 10,
  minimumVolatilityTakeProfitNetBps: 20,
});

export type HorizonResearchFamily = "LEGACY" | "FIXED_CONTROL" | "VOLATILITY";
export interface HorizonResearchAction extends DistributionAction {
  family: HorizonResearchFamily;
  volatility30mBps: number | null;
  referenceSigmaBps: number | null;
}

/** Only FIXED_CONTROL varies the deadline while holding its exit barriers
 * constant. Volatility-scaled and legacy actions compare bundled policies. */
export const HORIZON_RESEARCH_FAMILIES = Object.freeze({
  LEGACY: Object.freeze({ isolatesDeadline: false, volatilityAdjusted: false, usesSameBarrierAcrossHorizons: false }),
  FIXED_CONTROL: Object.freeze({ isolatesDeadline: true, volatilityAdjusted: false, usesSameBarrierAcrossHorizons: true }),
  VOLATILITY: Object.freeze({ isolatesDeadline: false, volatilityAdjusted: true, usesSameBarrierAcrossHorizons: false }),
});

// Copy the live reference once; later caller mutations cannot rewrite an
// already-created research action or the menu's reference policies.
const legacyActions = Object.freeze(DISTRIBUTION_ACTIONS.map(action => Object.freeze({ ...action })));

/** The caller supplies uncapped volatility calculated from observed preceding
 * prices. Square-root-of-time scaling is a fixed research assumption, not a
 * forecast of future realized volatility. Zero-volatility observations remain
 * in the comparison and use the fixed floors rather than being excluded. */
export function buildHorizonResearchActions(volatility30mBps: number): ReadonlyArray<Readonly<HorizonResearchAction>> {
  if (!Number.isFinite(volatility30mBps) || volatility30mBps < 0) throw new Error("INVALID_HORIZON_RESEARCH_VOLATILITY");
  const spec = HORIZON_RESEARCH_SPEC;
  const create = (family: HorizonResearchFamily, action: DistributionAction, sigma: number | null): Readonly<HorizonResearchAction> => {
    if (![action.horizonMs, action.stopLossBps, action.takeProfitNetBps].every(x => Number.isFinite(x) && x > 0)
      || action.horizonMs >= spec.proposalIntervalMs || action.horizonMs >= DISTRIBUTION_SPEC.proposalIntervalMs
      || (sigma !== null && (!Number.isFinite(sigma) || sigma < 0))) throw new Error("INVALID_HORIZON_RESEARCH_ACTION");
    const minutes = action.horizonMs / 60_000;
    const id = `horizon-${family.toLowerCase().replaceAll("_", "-")}-${action.side === 1 ? "long" : "short"}-${minutes}m`;
    return Object.freeze({ ...action, id, policyId: `research-${id}`, family,
      volatility30mBps: family === "VOLATILITY" ? volatility30mBps : null, referenceSigmaBps: sigma });
  };
  const actions: Array<Readonly<HorizonResearchAction>> = legacyActions.map(action => create("LEGACY", action, null));
  for (const family of ["FIXED_CONTROL", "VOLATILITY"] as const) {
    for (const minutes of spec.horizonsMinutes) {
      const horizonMs = minutes * 60_000;
      const sigma = family === "VOLATILITY" ? volatility30mBps * Math.sqrt(horizonMs / spec.volatilityLookbackMs) : null;
      const stopLossBps = sigma === null ? spec.fixedStopLossBps
        : Math.max(spec.minimumVolatilityStopLossBps, spec.volatilityStopSigmaMultiplier * sigma);
      const takeProfitNetBps = sigma === null ? spec.fixedTakeProfitNetBps
        : Math.max(spec.minimumVolatilityTakeProfitNetBps, spec.volatilityTargetSigmaMultiplier * sigma);
      for (const side of [1, -1] as const) {
        actions.push(create(family, { id: "", policyId: "", side, horizonMs, stopLossBps, takeProfitNetBps }, sigma));
      }
    }
  }
  return Object.freeze(actions);
}

export const HORIZON_RESEARCH_ACTION_IDS = Object.freeze(buildHorizonResearchActions(0).map(action => action.id));
