import { CROSS_ASSET_SYMBOLS, type CrossAssetQuote, type CrossAssetResearchVariant } from "./cross-asset-model.js";
import { replayCrossAsset, CROSS_ASSET_REPLAY_SCENARIOS } from "./cross-asset-replay.js";

export const MODEL_EXPERIMENT_SPEC = Object.freeze({ version: "model-endpoint-experiment-v1",
  proposalIntervalMs: 5_400_000, minimumObservedDays: 7,
  variants: ["production-15m", "endpoint-15m", "endpoint-30m", "endpoint-60m"] as const });

/** Fixed research menu. Every variant consumes the same source and chronological
 * boundaries. Unmatched or missing paths are excluded jointly, never rewarded. */
export async function compareModelExperiments(source: () => AsyncIterable<CrossAssetQuote> | Iterable<CrossAssetQuote>,
  costs: Readonly<Record<string, { feeBps: number; reserveBps: number }>>, entryStartMs: number, holdoutStartMs: number) {
  if (![entryStartMs, holdoutStartMs].every(Number.isFinite) || holdoutStartMs <= entryStartMs) throw new Error("INVALID_EXPERIMENT_BOUNDARIES");
  const experiments = [];
  for (const id of MODEL_EXPERIMENT_SPEC.variants) {
    const report = await replayCrossAsset(source(), costs, { paperEvaluation: true, entryStartMs,
      proposalIntervalMs: MODEL_EXPERIMENT_SPEC.proposalIntervalMs,
      ...(id === "production-15m" ? {} : { researchVariant: id as CrossAssetResearchVariant }) });
    const predictionDiagnostics = CROSS_ASSET_SYMBOLS.flatMap(symbol => ["VALIDATION", "HOLDOUT"].map(period => {
      const labels = report.forwardTrainingLabels.filter(label => label.symbol === symbol && (period === "VALIDATION"
        ? label.startMs < holdoutStartMs && label.endMs < holdoutStartMs : label.startMs >= holdoutStartMs));
      const squared = labels.reduce((s, l) => s + (l.actualGrossBps - l.predictedGrossBps) ** 2, 0);
      const zeroSquared = labels.reduce((s, l) => s + l.actualGrossBps ** 2, 0);
      return { symbol, period, completedLabels: labels.length,
        modelMse: labels.length ? squared / labels.length : null,
        zeroMse: labels.length ? zeroSquared / labels.length : null,
        mseRatioToZero: labels.length && zeroSquared > 0 ? squared / zeroSquared : null };
    }));
    experiments.push({ id, report, predictionDiagnostics });
  }
  const panels = new Map<string, Map<string, (typeof experiments)[number]["report"]["outcomes"]>>();
  for (const experiment of experiments) for (const row of experiment.report.outcomes) {
    const key = `${row.symbol}|${row.signalAtMs}`, variants = panels.get(key) ?? new Map();
    const rows = variants.get(experiment.id) ?? [];
    rows.push(row); variants.set(experiment.id, rows); panels.set(key, variants);
  }
  const common = [...panels.values()].filter(variants => variants.size === experiments.length
    && [...variants.values()].every(rows => rows.length === CROSS_ASSET_REPLAY_SCENARIOS.length
      && rows.every(row => row.status !== "INVALID")
      && new Set(rows.map(row => row.scenario)).size === CROSS_ASSET_REPLAY_SCENARIOS.length));
  const comparison = experiments.flatMap(experiment => CROSS_ASSET_SYMBOLS.flatMap(symbol =>
    CROSS_ASSET_REPLAY_SCENARIOS.flatMap(scenario => ["VALIDATION", "HOLDOUT"].flatMap(period => {
      const rows = common.filter(variants => [...variants.values()].flat().every(row => period === "VALIDATION"
        ? row.signalAtMs < holdoutStartMs && row.exitAtMs !== null && row.exitAtMs < holdoutStartMs
        : row.signalAtMs >= holdoutStartMs)).flatMap(variants => variants.get(experiment.id)!)
        .filter(row => row.symbol === symbol && row.scenario === scenario.id);
      return ["DIRECTIONAL", "CONSERVATIVE"].map(screen => {
        const accepted = rows.filter(row => row.status !== "SKIPPED" && (screen === "DIRECTIONAL" || row.forecastQualified));
        return { variant: experiment.id, symbol, scenario: scenario.id, period, screen,
          panelAttempts: rows.length, accepted: accepted.length, filled: accepted.filter(row => row.status === "FILLED").length,
          observedDays: new Set(rows.map(row => Math.floor(row.signalAtMs / 86_400_000))).size,
          meanNetBpsPerOriginalAttempt: rows.length ? accepted.reduce((s, row) => s + row.netBps!, 0) / rows.length : null };
      });
    }))));
  return { specification: MODEL_EXPERIMENT_SPEC, entryStartMs, holdoutStartMs,
    generatedAtMs: Date.now(), unionOpportunities: panels.size, commonCompleteOpportunities: common.length,
    jointlyExcludedOpportunities: panels.size - common.length,
    boundaryPurgedOpportunities: common.filter(variants => [...variants.values()].flat().some(row =>
      row.signalAtMs < holdoutStartMs && row.exitAtMs !== null && row.exitAtMs >= holdoutStartMs)).length,
    comparison, experiments, deploymentReady: false, orderSubmissionChanged: false,
    limitations: ["Exploratory comparisons on reused snapshots; the holdout period is chronological, not untouched",
      "90-minute proposals are shared research controls, not the submitting system's 30-minute schedule",
      "All variants and stresses must have a matching complete path; excluded observations may bias surviving means",
      "60-minute research exits reuse the 30-minute stop and target, with a 60-minute deadline",
      "Model training can use clean endpoints across gaps; missing trade execution paths always remain invalid",
      "Forecast errors on each model's own completed labels do not share an identical observation panel",
      "No automatic model installation or orders; short samples and zero-order results cannot demonstrate profitability"] };
}
