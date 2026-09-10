import type { ProfitModelFit } from "./model.js";
import { replayProfit, type ProfitReplayInput } from "./replay.js";
import { PROFIT_SPEC } from "./spec.js";
import { PROFIT_UTILITY_SPEC } from "./utility.js";

export type ProfitUtilityReplayPolicy = "weekly-mean-variance" | "risk-managed-long-btc" | "risk-managed-long-eth";
export interface ProfitUtilityReplayInput extends Omit<ProfitReplayInput, "policy" | "fits"> {
  fits: readonly ProfitModelFit[];
  policy?: ProfitUtilityReplayPolicy;
}

/** Research-only selection variant. Model fitting, fee/funding accounting,
 * inventory life cycle and account controls remain in the shared kernel. */
export function replayProfitUtility(input: ProfitUtilityReplayInput) {
  const policy = input.policy ?? "weekly-mean-variance";
  if (!["weekly-mean-variance", "risk-managed-long-btc", "risk-managed-long-eth"].includes(policy))
    throw new Error("INVALID_PROFIT_UTILITY_REPLAY_POLICY");
  const result = replayProfit({ ...input, policy });
  return { ...result, version: PROFIT_UTILITY_SPEC.version, estimatorVersion: PROFIT_SPEC.version,
    selectionSpec: PROFIT_UTILITY_SPEC };
}
