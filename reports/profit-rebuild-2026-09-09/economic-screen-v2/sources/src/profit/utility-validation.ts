import { createHash } from "node:crypto";
import { PROFIT_UTILITY_SPEC as U } from "./utility.js";
import { PROFIT_VALIDATION_SPEC as V, validateProfitStudyIdentity, type ProfitValidationInput } from "./validation.js";

/** The second candidate changes its decision/sizing rule, never the financial
 * acceptance thresholds that rejected its predecessor. */
export const PROFIT_UTILITY_VALIDATION_SPEC = Object.freeze({ ...V,
  version: "weekly-mean-variance-economic-validation-v2", strategyVersion: U.version,
  candidatePolicy: "weekly-mean-variance",
  predecessor: "weekly-confidence-v1-produced-zero-trades-and-failed-validation",
  thresholdChangesAfterPredecessor: false,
});
export const PROFIT_UTILITY_VALIDATION_SPEC_SHA256 = createHash("sha256")
  .update(JSON.stringify(PROFIT_UTILITY_VALIDATION_SPEC)).digest("hex");
export function validateProfitUtilityStudy(input: ProfitValidationInput) {
  return validateProfitStudyIdentity(input, { strategyVersion: U.version, candidatePolicy: "weekly-mean-variance",
    validationSpecSha256: PROFIT_UTILITY_VALIDATION_SPEC_SHA256 });
}
