import { createHash } from "node:crypto";
import type { EngineConfig } from "../config.js";
import { DISTRIBUTION_SPEC, distributionEntryProfile } from "../distribution/spec.js";
import { distributionNotionalLimit, distributionSizingId } from "../distribution/sizing.js";

/** Explicit allowlist: never serialize environment variables, credentials, or connection URLs. */
export function configurationAudit(cfg: EngineConfig) {
  const entryProfile = distributionEntryProfile(cfg.distributionalPaperTrialEnabled,
    cfg.distributionalEfficientTrainingEnabled, cfg.distributionalRegimeModelEnabled);
  const settings = {
    schemaVersion: 1, configurationVersion: cfg.configurationVersion,
    mode: cfg.mode, venue: cfg.venue, realOrdersSupported: false,
    symbols: cfg.symbols, productsBySymbol: cfg.krakenFutures.productsBySymbol, symbolConfigs: cfg.symbolConfigs,
    runtime: {
      paperEntryExercise: cfg.paperEntryExercise, policyEngineEnabled: cfg.policyEngineEnabled,
      modelOnlyEntries: cfg.modelOnlyEntries, breakoutRetestEnabled: cfg.breakoutRetestEnabled,
      distributionalEngineEnabled: cfg.distributionalEngineEnabled,
      distributionalPaperEntriesEnabled: cfg.distributionalPaperEntriesEnabled,
      distributionalPaperTrialEnabled: cfg.distributionalPaperTrialEnabled,
      distributionalEfficientTrainingEnabled: cfg.distributionalEfficientTrainingEnabled,
      distributionalRegimeModelEnabled: cfg.distributionalRegimeModelEnabled,
      crossAssetPaperEntriesEnabled: cfg.crossAssetPaperEntriesEnabled,
      crossAssetPaperEvaluationEnabled: cfg.crossAssetPaperEvaluationEnabled,
    },
    risk: { portfolio: { ...cfg.portfolio,
      maximumVariance: Number.isFinite(cfg.portfolio.maximumVariance) ? cfg.portfolio.maximumVariance : "DISABLED_NO_CALIBRATED_COVARIANCE" },
      rollingLossFraction: cfg.rollingLossFraction, sessionLossFraction: cfg.sessionLossFraction,
      rollingLossMeasurement: cfg.mode === "replay" ? "REPLAY_IMPLEMENTATION_DEFINED"
        : "TRAILING_24H_REALIZED_PRICE_PNL_MINUS_RECORDED_FEES_PLUS_PAPER_FUNDING_CASH_POSTINGS",
      rollingLossHistorySource: "MAIN_KRAKEN_PAPER_BROKER_HISTORY_RECONCILED_TO_ORDERS_AND_POSITIONS",
      rollingLossFundingIncluded: cfg.mode !== "replay",
      rollingLossFundingSource: "PAPER_MODEL_NOT_VENUE_CASH_RECEIPTS",
      rollingLossFundingCoverage: "DECLARED_EPOCH; UNKNOWN_HELD_INTERVALS_DENY_NEW_ENTRIES",
      initialPaperEquityUsd: cfg.krakenFutures.initialEquity },
    distribution: { entryProfile, evaluationIntervalMs: DISTRIBUTION_SPEC.evaluationIntervalMs,
      sizingMode: cfg.distributionalSizingPolicy ? "RISK_BOUNDED" : "LEGACY_FIXED",
      sizingPolicyId: distributionSizingId(cfg.distributionalSizingPolicy),
      maximumExperimentNotionalPerOrderUsd: cfg.distributionalSizingPolicy?.maximumNotional ?? DISTRIBUTION_SPEC.maximumNotional,
      maximumEquityFraction: cfg.distributionalSizingPolicy?.maximumEquityFraction ?? null,
      trainingCheckpointFile: cfg.distributionalStateFile,
      effectiveOrderCapsUsd: Object.fromEntries(cfg.symbols.map(symbol => [symbol,
        Math.min(distributionNotionalLimit(cfg.distributionalSizingPolicy, symbol), cfg.symbolConfigs[symbol]!.maximumNotional,
          cfg.portfolio.maximumGrossNotional)])) },
    costs: { source: "CONFIGURED_PAPER_ASSUMPTIONS", accountFeeTierVerified: false,
      fundingReserveIsActualSettlement: false,
      perSymbol: Object.fromEntries(cfg.symbols.map(symbol => [symbol, cfg.symbolConfigs[symbol]!.cost])) },
    persistence: { enabled: cfg.databaseEnabled, requiredForEntries: cfg.databaseRequired,
      flushIntervalMs: cfg.databaseFlushIntervalMs, maximumQueue: cfg.databaseMaxQueue,
      marketSampleMs: cfg.databaseMarketSampleMs, maximumWriteLagMs: cfg.databaseMaximumWriteLagMs,
      statementTimeoutMs: cfg.databaseStatementTimeoutMs,
      continuousRecordingEnabled: cfg.continuousRecordingEnabled },
    recall: cfg.recall,
  };
  return { configurationSha256: createHash("sha256").update(canonical(settings)).digest("hex"), settings };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
