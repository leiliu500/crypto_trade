import { createHash } from "node:crypto";
import type { PolicyObservation } from "./policy-collector.js";
import { findPolicy, POLICY_VERSION, POLICY_ENTRY_LATENCY_MS, POLICY_MAX_ENTRY_DELAY_MS,
  POLICY_MAX_QUOTE_GAP_MS, TRADING_POLICIES, type PolicyCandidate } from "./trading-policy.js";

export interface PolicyModel extends PolicyCandidate {
  key: string;
  configurationVersion: string;
  policyVersion: string;
  policyId: string;
  symbol: string;
  feeBps: number;
  reserveBps: number;
  fittedMeanNetBps: number;
  lowerNetBps: number;
  maximumSpreadBps: number;
  independentSamples: number;
  holdoutSamples: number;
  trainedThroughMs: number;
  holdoutStartMs: number;
  expiresAtMs: number;
}

export interface PolicyEvaluation {
  key: string;
  symbol: string;
  side: number;
  family: string;
  regime: string;
  selectedPolicyId: string | null;
  candidateCount: number;
  independentSamples: number;
  observedDays: number;
  spanMs: number;
  validationLowerNetBps: number | null;
  holdoutLowerNetBps: number | null;
  holdoutSamples: number;
  folds: Array<{ trainingEndMs: number; testStartMs: number; predictionNetBps: number; actualNetBps: number }>;
  reasons: string[];
  model: PolicyModel | null;
}
export interface PolicyReport {
  policyVersion: string;
  configurationVersion: string;
  generatedAtMs: number;
  evidenceEndMs: number;
  observations: number;
  evaluations: PolicyEvaluation[];
  models: PolicyModel[];
}
export const POLICY_MODEL_MAX_AGE_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;

/** A predeclared daily rolling origin: 7d train, 3.5d selection, 3.5d holdout.
 * Intraday refreshes do not move the boundaries or extend model expiry. */
export function evaluatePolicies(rows: readonly PolicyObservation[], configurationVersion: string,
  now = Date.now()): PolicyReport {
  const groups = new Map<string, PolicyObservation[]>();
  const evidenceEndMs = Math.floor(now / DAY_MS) * DAY_MS;
  for (const row of rows) {
    if (row.sampling !== "ENTRY" || row.configurationVersion !== configurationVersion || row.policyVersion !== POLICY_VERSION
      || row.signalAtMs < evidenceEndMs - 14 * DAY_MS || row.signalAtMs >= evidenceEndMs
      || !findPolicy(row.policyId) || findPolicy(row.policyId)!.family !== row.family
      || ![1, -1].includes(row.side) || !Number.isFinite(row.signalAtMs)
      || ![row.feeBps, row.reserveBps, row.spreadBps].every((x) => Number.isFinite(x) && x >= 0)) continue;
    const key = [configurationVersion, POLICY_VERSION, row.symbol, row.family, row.side,
      row.regime, row.feeBps, row.reserveBps].join("|");
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  const evaluations = [...groups].map(([key, values]) => evaluatePolicyCohort(key, values, evidenceEndMs));
  return { policyVersion: POLICY_VERSION, configurationVersion, generatedAtMs: now,
    evidenceEndMs,
    observations: rows.length, evaluations, models: evaluations.flatMap((e) => e.model ? [e.model] : []) };
}

/** Pure evaluation shared by isolated research reports. Only evaluatePolicies
 * supplies rows to the production model store; EPISODE versions cannot install. */
export function evaluatePolicyCohort(key: string, rows: PolicyObservation[], now: number,
  latencyMs = POLICY_ENTRY_LATENCY_MS, selectedPolicyId?: string, embargoLatencyMs = latencyMs): PolicyEvaluation {
  if (!rows.length || !Number.isFinite(latencyMs) || latencyMs < 1 || latencyMs > 1_000) throw new Error("Invalid cohort");
  const first = rows[0]!;
  const declaredPolicies = TRADING_POLICIES.filter((p) => p.family === first.family);
  const maxHorizon = Math.max(...declaredPolicies.map((p) => p.horizonMs));
  const embargo = maxHorizon + 2 * Math.max(latencyMs, embargoLatencyMs) + POLICY_MAX_ENTRY_DELAY_MS + 2 * POLICY_MAX_QUOTE_GAP_MS;
  // Drop only observations whose predeclared deadline has not matured yet.
  // A missing/invalid mature result prevents promotion instead of disappearing.
  const mature = rows.filter((o) => o.signalAtMs + embargo < now);
  const times = [...new Set(mature.map((o) => o.signalAtMs))].sort((a, b) => a - b);
  const validationStart = now - 7 * DAY_MS;
  const holdoutStart = now - 3.5 * DAY_MS;
  const policyIds = declaredPolicies.map((p) => p.id).sort();
  const variants = policyIds.map((policyId) => {
    const samples = nonOverlapping(mature.filter((o) => o.policyId === policyId && validPolicyOutcome(o, latencyMs)), embargo);
    const training = samples.filter((o) => o.signalAtMs + embargo < validationStart);
    const validation = samples.filter((o) => o.signalAtMs >= validationStart && o.signalAtMs + embargo < holdoutStart);
    const holdout = samples.filter((o) => o.signalAtMs >= holdoutStart);
    return { policyId, samples, training, validation, holdout,
      lower: training.length >= 20 && validation.length >= 20 ? lowerMean(validation) : null };
  }).sort((a, b) => (b.lower ?? -Infinity) - (a.lower ?? -Infinity) || a.policyId.localeCompare(b.policyId));
  const winner = selectedPolicyId === undefined ? variants[0] : variants.find((v) => v.policyId === selectedPolicyId);
  const samples = winner?.samples ?? [];
  const reasons: string[] = [];
  const days = new Set(samples.map((o) => Math.floor(o.signalAtMs / 86_400_000))).size;
  const span = samples.length > 1 ? samples.at(-1)!.signalAtMs - samples[0]!.signalAtMs : 0;
  const holdout = winner?.holdout ?? [];
  const holdoutLower = lowerMean(holdout);
  const trainingAndValidation = samples.filter((o) => o.signalAtMs + embargo < holdoutStart);
  const folds: PolicyEvaluation["folds"] = [];
  for (let fold = 0; fold < 3; fold++) {
    const start = Math.floor(trainingAndValidation.length * (.4 + fold * .2));
    const end = fold === 2 ? trainingAndValidation.length : Math.floor(trainingAndValidation.length * (.6 + fold * .2));
    const test = trainingAndValidation.slice(start, end);
    const train = trainingAndValidation.slice(0, start).filter((o) => o.signalAtMs + embargo < (test[0]?.signalAtMs ?? 0));
    if (train.length >= 10 && test.length >= 5) folds.push({ trainingEndMs: train.at(-1)!.exitAtMs!,
      testStartMs: test[0]!.signalAtMs, predictionNetBps: meanNet(train), actualNetBps: meanNet(test) });
  }
  if (mature.some((o) => !validPolicyOutcome(o, latencyMs))) reasons.push("INCOMPLETE_OR_INVALID_OUTCOMES");
  // Every variant must see the same candidate timestamps; no selection on an
  // easier surviving subset of the path.
  if (policyIds.some((id) => mature.filter((o) => o.policyId === id).length !== times.length
    || new Set(mature.filter((o) => o.policyId === id).map((o) => o.signalAtMs)).size !== times.length)) {
    reasons.push("UNPAIRED_POLICY_CANDIDATES");
  }
  if (samples.length < 100) reasons.push("INSUFFICIENT_INDEPENDENT_SAMPLES");
  if (days < 7 || span < 7 * 86_400_000) reasons.push("INSUFFICIENT_OBSERVED_DAYS");
  if (!winner || winner.lower === null || winner.lower <= 0) reasons.push("NON_POSITIVE_VALIDATION_RETURN");
  if (holdout.length < 30) reasons.push("INSUFFICIENT_FINAL_HOLDOUT");
  if (holdoutLower === null || holdoutLower <= 0) reasons.push("NON_POSITIVE_FINAL_HOLDOUT_RETURN");
  if (folds.length < 3 || folds.some((f) => f.actualNetBps <= 0)) reasons.push("UNSTABLE_WALK_FORWARD_RETURNS");
  if (samples.length && now - samples.at(-1)!.exitAtMs! > POLICY_MODEL_MAX_AGE_MS) reasons.push("STALE_EVIDENCE");
  const fittedLower = lowerMean(trainingAndValidation);
  if (fittedLower === null || fittedLower <= 0) reasons.push("NON_POSITIVE_FITTED_RETURN");
  const fittedMean = meanNet(trainingAndValidation);
  const model: PolicyModel | null = reasons.length === 0 && winner ? {
    key: createHash("sha256").update(key).digest("hex"), configurationVersion: first.configurationVersion,
    policyVersion: first.policyVersion, symbol: first.symbol, family: first.family, side: first.side,
    regime: first.regime, policyId: winner.policyId, feeBps: first.feeBps, reserveBps: first.reserveBps,
    fittedMeanNetBps: fittedMean, lowerNetBps: Math.min(fittedLower!, winner.lower!, holdoutLower!),
    maximumSpreadBps: Math.max(...trainingAndValidation.map((o) => o.spreadBps)),
    independentSamples: samples.length, holdoutSamples: holdout.length,
    trainedThroughMs: trainingAndValidation.at(-1)!.exitAtMs!, holdoutStartMs: holdoutStart,
    expiresAtMs: now + POLICY_MODEL_MAX_AGE_MS,
  } : null;
  return { key, symbol: first.symbol, side: first.side, family: first.family, regime: first.regime,
    selectedPolicyId: winner?.policyId ?? null, candidateCount: times.length,
    independentSamples: samples.length, observedDays: days, spanMs: span,
    validationLowerNetBps: winner?.lower ?? null, holdoutLowerNetBps: holdoutLower,
    holdoutSamples: holdout.length, folds, reasons, model };
}

export function validPolicyModel(model: PolicyModel, configurationVersion: string, now: number): boolean {
  const policy = findPolicy(model.policyId);
  return model.policyVersion === POLICY_VERSION && model.configurationVersion === configurationVersion
    && !!policy && policy.family === model.family && [1, -1].includes(model.side)
    && !!model.symbol && !!model.regime && !!model.key
    && [model.feeBps, model.reserveBps, model.maximumSpreadBps].every((x) => Number.isFinite(x) && x >= 0)
    && Number.isFinite(model.expiresAtMs) && model.expiresAtMs > now
    && model.expiresAtMs <= Math.floor(now / DAY_MS) * DAY_MS + POLICY_MODEL_MAX_AGE_MS
    && Number.isFinite(model.lowerNetBps) && model.lowerNetBps > 0
    && Number.isFinite(model.fittedMeanNetBps) && model.fittedMeanNetBps >= model.lowerNetBps
    && Number.isInteger(model.independentSamples) && model.independentSamples >= 100
    && Number.isInteger(model.holdoutSamples) && model.holdoutSamples >= 30
    && Number.isFinite(model.trainedThroughMs) && model.trainedThroughMs < model.holdoutStartMs
    && model.holdoutStartMs < now;
}

export function validPolicyOutcome(o: PolicyObservation, latencyMs = POLICY_ENTRY_LATENCY_MS): boolean {
  if (!findPolicy(o.policyId) || ![1, -1].includes(o.side)
    || ![o.feeBps, o.reserveBps].every((v) => Number.isFinite(v) && v >= 0)) return false;
  const fraction = o.filledQty / o.qty;
  const gross = o.entryPrice && o.exitPrice ? o.side * (o.exitPrice / o.entryPrice - 1) * 10_000 * fraction : 0;
  const net = o.entryPrice && o.exitPrice
    ? gross - (o.feeBps * (1 + o.exitPrice / o.entryPrice) + o.reserveBps) * fraction : 0;
  return o.status === "COMPLETE" && o.netBps !== null && Number.isFinite(o.netBps)
    && o.qty > 0 && Number.isFinite(o.qty)
    && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1
    && Math.abs(net - o.netBps) < 1e-7 && Math.abs(gross - o.grossBps!) < 1e-7
    && o.grossBps !== null && Number.isFinite(o.grossBps) && o.exitAtMs !== null
    && Number.isFinite(o.exitAtMs) && o.exitAtMs >= o.signalAtMs
    && (o.reason === "ENTRY_NOT_FILLED" ? o.netBps === 0 && o.grossBps === 0 && o.entryAtMs === null
      && fraction === 0
      && o.exitAtMs >= o.signalAtMs + latencyMs
      && o.exitAtMs <= o.signalAtMs + latencyMs + POLICY_MAX_ENTRY_DELAY_MS
      : fraction > 0 && ["POLICY_TARGET", "POLICY_STOP", "POLICY_DEADLINE"].includes(o.reason ?? "")
        && o.entryAtMs !== null && o.entryAtMs >= o.signalAtMs + latencyMs
        && o.entryAtMs <= o.signalAtMs + latencyMs + POLICY_MAX_ENTRY_DELAY_MS
        && o.entryAtMs <= o.exitAtMs && (o.entryPrice ?? 0) > 0 && (o.exitPrice ?? 0) > 0
        && Number.isFinite(o.entryPrice) && Number.isFinite(o.exitPrice)
        && o.exitAtMs <= o.entryAtMs + findPolicy(o.policyId)!.horizonMs + latencyMs + 2 * POLICY_MAX_QUOTE_GAP_MS);
}
function nonOverlapping(rows: PolicyObservation[], embargo: number): PolicyObservation[] {
  const result: PolicyObservation[] = [];
  for (const row of [...rows].sort((a, b) => a.signalAtMs - b.signalAtMs || a.id.localeCompare(b.id))) {
    if (!result.length || row.signalAtMs > result.at(-1)!.signalAtMs + embargo) result.push(row);
  }
  return result;
}
function meanNet(rows: readonly PolicyObservation[]): number {
  return rows.length ? rows.reduce((sum, o) => sum + o.netBps!, 0) / rows.length : 0;
}
function lowerMean(rows: readonly PolicyObservation[]): number | null {
  if (rows.length < 2) return null;
  const mean = meanNet(rows);
  const variance = rows.reduce((sum, o) => sum + (o.netBps! - mean) ** 2, 0) / (rows.length - 1);
  const daily = new Map<number, PolicyObservation[]>();
  for (const row of rows) {
    const key = Math.floor(row.signalAtMs / DAY_MS);
    const values = daily.get(key) ?? []; values.push(row); daily.set(key, values);
  }
  const dailyMeans = [...daily.values()].map(meanNet);
  if (dailyMeans.length < 2) return null;
  const dailyMean = dailyMeans.reduce((sum, value) => sum + value, 0) / dailyMeans.length;
  const dailyVariance = dailyMeans.reduce((sum, value) => sum + (value - dailyMean) ** 2, 0) / (dailyMeans.length - 1);
  // Do not treat every non-overlapping trade as independent of its market day.
  return mean - 1.96 * Math.max(Math.sqrt(variance / rows.length), Math.sqrt(dailyVariance / dailyMeans.length));
}
