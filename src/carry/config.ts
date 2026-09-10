import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { validateFeeBps } from "../economics/fee-validation.js";

export interface CarryResearchConfig {
  schemaVersion: 1; mode: "MONITOR_ONLY";
  spotTakerFeeBps: number; derivativeTakerFeeBps: number;
  annualCapitalHurdleFraction: number; slippageBpsPerExecution: number;
  settlementBasisReserveBps: number; unwindReserveBps: number;
  maximumQuoteAgeMs: number; maximumQuoteSkewMs: number;
  maximumFundingAgeMs: number; settlementPriceMultipliers: number[];
  perpetualScenarioHoldingHours: number;
  minimumDatedMaturityDays: number; maximumDatedMaturityDays: number;
  derivativeReserveFraction: number;
  budgets: Array<{ id: string; availableGrossUsd: number; availableCashUsd: number; availableCollateralUsd: number }>;
}
const numericKeys = ["spotTakerFeeBps", "derivativeTakerFeeBps", "annualCapitalHurdleFraction",
  "slippageBpsPerExecution", "settlementBasisReserveBps", "unwindReserveBps", "maximumQuoteAgeMs",
  "maximumQuoteSkewMs", "maximumFundingAgeMs", "perpetualScenarioHoldingHours", "minimumDatedMaturityDays",
  "maximumDatedMaturityDays", "derivativeReserveFraction"] as const;

export function validateCarryResearchConfig(value: unknown): CarryResearchConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_CARRY_CONFIG");
  const c = value as CarryResearchConfig;
  if (Object.keys(c).some(k => !["schemaVersion", "mode", "budgets", "settlementPriceMultipliers", ...numericKeys].includes(k))
    || c.schemaVersion !== 1 || c.mode !== "MONITOR_ONLY") throw new Error("CARRY_CONFIG_REQUIRES_MONITOR_ONLY_SCHEMA_1");
  if (numericKeys.some(k => typeof c[k] !== "number" || !Number.isFinite(c[k]) || c[k] < 0)) throw new Error("INVALID_CARRY_CONFIG_NUMBER");
  validateFeeBps(c.spotTakerFeeBps); validateFeeBps(c.derivativeTakerFeeBps);
  if (c.derivativeReserveFraction < 1 || c.annualCapitalHurdleFraction > 1
    || c.maximumQuoteAgeMs <= 0 || c.maximumQuoteAgeMs > 5_000 || c.maximumQuoteSkewMs > c.maximumQuoteAgeMs
    || c.perpetualScenarioHoldingHours <= 0 || c.perpetualScenarioHoldingHours > 24 * 365
    || c.minimumDatedMaturityDays <= 0 || c.maximumDatedMaturityDays < c.minimumDatedMaturityDays
    || c.maximumDatedMaturityDays > 365 || c.maximumFundingAgeMs <= 0 || c.maximumFundingAgeMs > 3_600_000)
    throw new Error("INVALID_CARRY_CONFIG_LIMITS");
  if (!Array.isArray(c.settlementPriceMultipliers) || c.settlementPriceMultipliers.length < 1
    || c.settlementPriceMultipliers.length > 10 || c.settlementPriceMultipliers.some(n => !Number.isFinite(n) || n <= 0))
    throw new Error("INVALID_CARRY_SETTLEMENT_SCENARIOS");
  if (!Array.isArray(c.budgets) || c.budgets.length < 1 || c.budgets.length > 10
    || new Set(c.budgets.map(b => b?.id)).size !== c.budgets.length
    || c.budgets.some(b => !b || typeof b.id !== "string" || !/^[a-z0-9-]+$/.test(b.id)
      || Object.keys(b).sort().join(",") !== "availableCashUsd,availableCollateralUsd,availableGrossUsd,id"
      || [b.availableGrossUsd, b.availableCashUsd, b.availableCollateralUsd].some(n => !Number.isFinite(n) || n <= 0))) {
    throw new Error("INVALID_CARRY_RESEARCH_BUDGETS");
  }
  return structuredClone(c);
}

export function loadCarryResearchConfig(path = "config/carry-research.json") {
  const raw = readFileSync(path);
  return { config: validateCarryResearchConfig(JSON.parse(raw.toString("utf8"))),
    configurationSha256: createHash("sha256").update(raw).digest("hex") };
}
