import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHourlyDataset, mergeHourlyBars, type HourlyBar, type FundingRow, type HourlySymbol } from "./hourly-data.js";
import { buildHourlyVolumeFeatures, HOURLY_VOLUME_FEATURE_SPEC } from "./hourly-volume-features.js";
import { HourlyNetLabelIndex, HOURLY_NET_LABEL_SPEC } from "./hourly-net-labels.js";
import { fitStudentBoost, fitLinearStudent, STUDENT_BOOST_SPEC, studentTNll5 } from "./hourly-student-model.js";
import { NetResidualCalibration, NET_CALIBRATION_SPEC, chooseNetAction, type NetDistribution } from "./hourly-net-calibration.js";
import { simulateHourlyRetryAccount, HOURLY_SCENARIOS, type AssetRules, type HourlyForecast } from "./hourly-retry-simulator.js";
import { ADAPTIVE_SELECTION_RULE, adaptiveAssetEligible, adaptivePortfolioGates, adaptiveUtility,
  type AdaptiveAccountSummary } from "./hourly-adaptive-study-gates.js";
import { pairedWeeklyPnlInterval } from "./hourly-study-statistics.js";

const H = 3_600_000, DAY = 24 * H;
const SYMBOLS = ["BTC/USD", "ETH/USD"] as const;
const CANDIDATES = ["student-t-boost-net-24h", "matched-linear-net-24h"] as const;
type Candidate = typeof CANDIDATES[number];
export function studentEvaluationSymbols(candidate: Candidate, selected?: Readonly<Partial<Record<HourlySymbol, Candidate | null>>>) {
  return SYMBOLS.filter(symbol => selected === undefined || selected[symbol] === candidate);
}
const HEADS = ["long-base", "long-stress", "short-base", "short-stress"] as const;
type Head = typeof HEADS[number];
type Stage = "develop" | "confirm" | "test";
const PERIODS = { develop: { start: Date.UTC(2024, 0, 1), end: Date.UTC(2025, 0, 1) },
  confirm: { start: Date.UTC(2025, 0, 1), end: Date.UTC(2026, 0, 1) },
  test: { start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 7, 1) } } as const;
const RULES = "reports/distribution-instrument-rules-2026-09-07.json";
const SOURCE_FILES = ["src/research/hourly-data.ts", "src/research/hourly-volume-features.ts", "src/research/hourly-net-labels.ts",
  "src/research/hourly-student-model.ts", "src/research/hourly-net-calibration.ts", "src/research/hourly-student-study-main.ts",
  "src/research/hourly-retry-simulator.ts", "src/research/hourly-adaptive-study-gates.ts", "src/research/hourly-study-statistics.ts",
  RULES, "package.json", "package-lock.json"];
export const STUDENT_STUDY_PROTOCOL = Object.freeze({
  version: "btc-eth-nonlinear-after-cost-student-study-v1", candidates: CANDIDATES, periods: PERIODS,
  priorExposure: "2024_AND_2025_ALREADY_INSPECTED_DEVELOPMENT;_2026_JAN_JUL_UNOPENED;_AUGUST_EXCLUDED",
  hypothesis: "VOLUME_RANGE_AND_BETA_RESIDUAL_FEATURES_PLUS_NONLINEAR_HEAVY_TAILED_CONDITIONAL_NET_DISTRIBUTIONS",
  features: HOURLY_VOLUME_FEATURE_SPEC, model: STUDENT_BOOST_SPEC, labels: HOURLY_NET_LABEL_SPEC, calibration: NET_CALIBRATION_SPEC,
  refit: "UTC_CALENDAR_MONTH_START;_EXPIRES_AT_NEXT_MONTH", trailingDays: 365, calibrationDays: 30,
  recencyHalfLifeDays: 90, commonAvailabilityPurgeHours: 51, minimumFitRows: 6000, minimumFitWeightESS: 1000,
  calibrationFit: "RETROSPECTIVE_AT_MONTH_CUTOFF_WITH_ALL_CALIBRATION_PRICES_AND_PAYOFFS_EXCLUDED_FROM_FIT;_NO_REFIT_AFTER_CALIBRATION",
  costAssumptionTiming: "PREDECLARED_PERIOD_COST_SCENARIO_KNOWN_AT_PERIOD_START_REPRICES_TRAINING_AND_CALIBRATION_PAYOFFS;_CALIBRATION_NOT_AN_ARCHIVED_PREQUENTIAL_STRATEGY",
  entry: "BASE_CALIBRATED_MEAN>5BPS;_STRESS_CALIBRATED_MEAN>0;_BOTH_PROB_NET_POSITIVE>0.5;_ABSTAIN_IF_BOTH_DIRECTIONS_QUALIFY",
  probabilityInterpretation: "EMPIRICAL_PREDICTIVE_DISTRIBUTION;_NOT_A_CONFIDENCE_BOUND_ON_MEAN_OR_GUARANTEE_OF_PROFIT",
  costScenarios: HOURLY_SCENARIOS, fundingLookbackDays: 365, minimumFundingRows: 6000,
  funding: "PRIOR_365_DAYS_BEFORE_EACH_EVALUATION_PERIOD_START;_P95_ABSOLUTE_BASE_P99_STRESS;_HELD_FIXED;_ALWAYS_ADVERSE",
  fundingInterpretation: "PROJECTED_SCENARIO_RETURN;_ACTUAL_SETTLEMENT_TIMING_AND_FULL_FUNDING_HISTORY_UNVERIFIED",
  counterfactuals: "LONG_SHORT_BASE_STRESS_INDEPENDENT_ONE_POSITION_LABELS;_KNOWN_NONFILLS_ZERO;_UNKNOWN_NULL_AND_REPORTED",
  payoffNormalization: "NET_USD_DIVIDED_BY_FIXED_12_USD_CAPACITY_TIMES_10000_INCLUDING_IDLE_CAPACITY",
  selection: ADAPTIVE_SELECTION_RULE,
  additionalPredictiveGate: "BOTH_SCENARIOS_AVERAGE_LONG_SHORT_BRIER_AND_CRPS_STRICTLY_BETTER_THAN_HELDOUT_UNCONDITIONAL_DISTRIBUTION",
  matchedBaseline: "SAME_FEATURES_LABELS_WEIGHTS_CALIBRATION_AND_COSTS;_RIDGE16_UNPENALIZED_INTERCEPT_HOMOSKEDASTIC_T5_SCALE",
  reference: "BUY_HOLD_BTC_SELECTED_BY_PREVIOUS_2024_STUDY;_FIXED_NO_BASELINE_RESELECTION",
  execution: "SHARED_RETRY_SIMULATOR_CURRENT_TICK_LOT_ASSUMPTION_ONE_GLOBAL_12_USD_SLOT_UTC_DAY_ALTERNATING",
  entryEndBufferHours: 51, buyHoldHorizon: "PERIOD_HOURS_MINUS_28",
  inference: "2000_PAIRED_MOVING_7_DAY_BLOCKS_FULL_CALENDAR_SEED_20260908_NOMINAL_ONE_SIDED_95_PERCENT",
  finalConfidenceGate: "BASE_LOWER95_TOTAL_IMPROVEMENT_POSITIVE_VS_FLAT_AND_FIXED_BUY_HOLD_BTC",
  noParameterSweep: true, noAutomaticActivation: true, realOrdersAllowed: false,
});
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const jhash = (v: unknown) => sha(JSON.stringify(v));
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const sourceHashes = async () => Object.fromEntries(await Promise.all(SOURCE_FILES.map(async name => [name, sha(await readFile(name))])));
interface Data { bars: HourlyBar[]; funding: FundingRow[]; rules: Record<HourlySymbol, AssetRules>; seal: object; }
async function loadData(older: string, recent: string): Promise<Data> {
  const fingerprints = () => Promise.all([older, recent].map(async directory => ({ directory: resolve(directory),
    datasetSha256: sha(await readFile(join(directory, "dataset.json"))), manifestSha256: sha(await readFile(join(directory, "manifest.json"))) })));
  const before = await fingerprints(), inputs = await Promise.all([loadHourlyDataset(older), loadHourlyDataset(recent)]);
  const all = inputs.flatMap(d => d.bars), first = Math.min(...all.map(b => b.openMs)), end = Math.max(...all.map(b => b.openMs)) + H;
  const bars = mergeHourlyBars(all, first, end, Date.now());
  if (first > Date.UTC(2022, 11, 1) || end < PERIODS.test.end) throw new Error("STUDENT_INCOMPLETE_HISTORY");
  for (const symbol of SYMBOLS) {
    const own = bars.filter(b => b.symbol === symbol);
    if (own.length !== (end - first) / H || own.some((b, i) => b.openMs !== first + i * H)) throw new Error("STUDENT_HOURLY_GAP");
  }
  const unique = new Map<string, FundingRow>();
  for (const row of inputs.flatMap(d => d.funding)) {
    const key = `${row.symbol}:${row.timestampMs}`, prior = unique.get(key);
    if (prior && (prior.rate !== row.rate || prior.absoluteRate !== row.absoluteRate)) throw new Error("STUDENT_FUNDING_CONFLICT");
    unique.set(key, row);
  }
  const funding = [...unique.values()].sort((a, b) => a.timestampMs - b.timestampMs || a.symbol.localeCompare(b.symbol));
  const after = await fingerprints(); if (jhash(before) !== jhash(after)) throw new Error("STUDENT_DATA_CHANGED_DURING_LOAD");
  return { bars, funding, rules: await json(RULES), seal: { files: after, barsSha256: jhash(bars), fundingSha256: jhash(funding) } };
}
function reserve(data: Data, cutoff: number, q: number) {
  return Object.fromEntries(SYMBOLS.map(symbol => {
    const values = data.funding.filter(r => r.symbol === symbol && r.timestampMs >= cutoff - 365 * DAY && r.timestampMs < cutoff)
      .map(r => Math.abs(r.rate) * 10000).sort((a, b) => a - b);
    if (values.length < 6000) throw new Error("STUDENT_FUNDING_SUPPORT");
    return [symbol, values[Math.ceil(q * values.length) - 1]!];
  })) as Record<HourlySymbol, number>;
}
type Simulation = ReturnType<typeof simulateHourlyRetryAccount>;
type Pair = { base: Simulation; stress: Simulation };
const account = (s: Simulation): AdaptiveAccountSummary => ({ netPnlUsd: s.netPnlUsd, maximumDrawdownUsd: s.maximumDrawdownUsd,
  maximumOneDayLossUsd: s.maximumOneDayLossUsd, completed: s.metrics.completed, activeUtcDates: s.metrics.activeUtcDates,
  unknownTrades: s.metrics.unknownTrades, perAsset: s.perAsset });
const pairSummary = (p: Pair) => ({ base: account(p.base), stress: account(p.stress) });
const details = (p: Pair) => ({ ...pairSummary(p), accounting: { base: p.base.metrics, stress: p.stress.metrics } });
function simulate(data: Data, forecasts: HourlyForecast[], start: number, end: number): Pair {
  const run = (scenario: "base" | "stress") => simulateHourlyRetryAccount({ bars: data.bars, funding: data.funding, forecasts,
    startMs: start, endMs: end, scenario: HOURLY_SCENARIOS[scenario], assetRules: data.rules, rankingPolicy: "UTC_DAY_ALTERNATING",
    forecastsPrequalified: true, adverseFundingBpsPerHour: reserve(data, start, scenario === "base" ? .95 : .99) });
  return { base: run("base"), stress: run("stress") };
}
interface Row { decisionMs: number; completedAtMs: number; features: readonly number[]; target: number; status: string; }
/** Equal 51h decision purges plus explicit receipt cutoffs separate fit,
 * retrospective calibration, and each future prediction month. */
export function studentTrainingPartition(rows: readonly Row[], cutoff: number) {
  const calibrationStart = cutoff - 30 * DAY;
  return { fit: rows.filter(r => r.decisionMs >= cutoff - 365 * DAY && r.decisionMs < calibrationStart - 51 * H
      && r.completedAtMs < calibrationStart),
    calibration: rows.filter(r => r.decisionMs >= calibrationStart && r.decisionMs < cutoff - 51 * H && r.completedAtMs < cutoff) };
}
function weightRows(rows: readonly Row[], cutoff: number) {
  return rows.map(r => ({ features: r.features, target: r.target, weight: 2 ** ((r.completedAtMs - cutoff) / (90 * DAY)) }));
}
const emptyScores = () => ({ count: 0, unknown: 0, squared: 0, brier: 0, crps: 0, nll: 0, positive: 0, predictedPositive: 0,
  covered80: 0, referenceSquared: 0, referenceBrier: 0, referenceCrps: 0, referenceNll: 0 });
type Scores = ReturnType<typeof emptyScores>;
function scoreSummary(s: Scores) {
  const avg = (n: number) => s.count ? n / s.count : null;
  return { count: s.count, unknown: s.unknown, mseNetBps2: avg(s.squared), brier: avg(s.brier), crpsBps: avg(s.crps),
    rawStudentNll: avg(s.nll), observedPositiveRate: avg(s.positive), meanPredictedPositiveProbability: avg(s.predictedPositive),
    empirical80Coverage: avg(s.covered80), referenceMseNetBps2: avg(s.referenceSquared), referenceBrier: avg(s.referenceBrier),
    referenceCrpsBps: avg(s.referenceCrps), referenceRawStudentNll: avg(s.referenceNll) };
}
function predictiveGate(scores: Record<Head, Scores>) {
  return (["base", "stress"] as const).every(scenario => {
    const rows = [scores[`long-${scenario}`], scores[`short-${scenario}`]];
    return rows.every(s => s.count > 0 && s.unknown === 0) && rows.reduce((n, s) => n + s.brier, 0) < rows.reduce((n, s) => n + s.referenceBrier, 0)
      && rows.reduce((n, s) => n + s.crps, 0) < rows.reduce((n, s) => n + s.referenceCrps, 0);
  });
}
type FeaturePoint = ReturnType<typeof buildHourlyVolumeFeatures>[number];
function buildLabelPools(data: Data, points: readonly FeaturePoint[], start: number, end: number) {
  const index = new HourlyNetLabelIndex(data.bars, data.rules, reserve(data, start, .95), reserve(data, start, .99));
  const pools = Object.fromEntries(SYMBOLS.map(symbol => [symbol, Object.fromEntries(HEADS.map(head => [head, [] as Row[]]))])) as Record<HourlySymbol, Record<Head, Row[]>>;
  const unknown = Object.fromEntries(SYMBOLS.map(symbol => [symbol, Object.fromEntries(HEADS.map(head => [head, [] as number[]]))])) as Record<HourlySymbol, Record<Head, number[]>>;
  for (const p of points) {
    if (p.decisionMs < start - 365 * DAY || p.decisionMs >= end - 51 * H) continue;
    for (const head of HEADS) {
      const side = head.startsWith("long") ? 1 : -1, scenario = head.endsWith("base") ? "base" : "stress";
      const label = index.label(p.symbol, p.decisionMs, side, scenario);
      if (label.status === "UNKNOWN" || label.netBps === null) { unknown[p.symbol][head].push(p.decisionMs); continue; }
      pools[p.symbol][head].push({ decisionMs: p.decisionMs, completedAtMs: label.completedAtMs, features: p.features,
        target: label.netBps, status: label.status });
    }
  }
  return { pools, unknown };
}
async function evaluate(candidate: Candidate, data: Data, points: readonly FeaturePoint[], labels: ReturnType<typeof buildLabelPools>,
  start: number, end: number, stage: Stage, output: string, evaluatedSymbols: readonly HourlySymbol[]) {
  const scores = Object.fromEntries(SYMBOLS.map(s => [s, Object.fromEntries(HEADS.map(h => [h, emptyScores()]))])) as Record<HourlySymbol, Record<Head, Scores>>;
  const forecasts: HourlyForecast[] = [], decisions: object[] = [], unavailable = { "BTC/USD": 0, "ETH/USD": 0 }, incoherent = { "BTC/USD": 0, "ETH/USD": 0 };
  for (let cutoff = start; cutoff < end;) {
    const next = new Date(cutoff); next.setUTCMonth(next.getUTCMonth() + 1); const nextMs = next.getTime();
    const monthDiagnostics: object[] = [];
    for (const symbol of evaluatedSymbols) {
      const heads = new Map<Head, { model: ReturnType<typeof fitStudentBoost> | ReturnType<typeof fitLinearStudent>;
        calibration: NetResidualCalibration; reference: NetResidualCalibration; referenceRaw: NetDistribution }>();
      for (const head of HEADS) {
        const split = studentTrainingPartition(labels.pools[symbol][head], cutoff), training = weightRows(split.fit, cutoff);
        const sumW = training.reduce((n, r) => n + r.weight, 0), sumW2 = training.reduce((n, r) => n + r.weight ** 2, 0);
        const ess = sumW * sumW / sumW2;
        if (training.length < 6000 || !(ess >= 1000) || split.calibration.length < 500) {
          monthDiagnostics.push({ symbol, head, cutoff, reason: "INSUFFICIENT_FIT_OR_CALIBRATION_SUPPORT", samples: training.length,
            calibrationSamples: split.calibration.length, weightESS: ess }); continue;
        }
        const model = candidate === "student-t-boost-net-24h" ? fitStudentBoost(training, 12) : fitLinearStudent(training, 12);
        const residuals = split.calibration.map(r => { const p = model.predict(r.features); return (r.target - p.location) / p.scale; });
        const calibration = new NetResidualCalibration(residuals), reference = new NetResidualCalibration(split.calibration.map(r => r.target));
        const mean = training.reduce((n, r) => n + r.weight * r.target, 0) / sumW;
        const scale = Math.max(1, Math.sqrt(training.reduce((n, r) => n + r.weight * (r.target - mean) ** 2, 0) / sumW * 3 / 5));
        heads.set(head, { model, calibration, reference, referenceRaw: { location: mean, scale } });
        monthDiagnostics.push({ symbol, head, cutoff, expiresAtMs: nextMs, reason: "READY", samples: training.length, weightESS: ess,
          firstDecisionMs: split.fit[0]!.decisionMs, latestFitCompletedMs: Math.max(...split.fit.map(r => r.completedAtMs)),
          calibrationStartMs: cutoff - 30 * DAY, calibrationSamples: split.calibration.length,
          latestCalibrationCompletedMs: Math.max(...split.calibration.map(r => r.completedAtMs)),
          trainingRowsSha256: jhash(split.fit), calibrationRowsSha256: jhash(split.calibration),
          unknownTrainingRows: labels.unknown[symbol][head].filter(t => t >= cutoff - 365 * DAY && t < cutoff - 30 * DAY - 51 * H).length,
          unknownCalibrationRows: labels.unknown[symbol][head].filter(t => t >= cutoff - 30 * DAY && t < cutoff - 51 * H).length,
          model: model.diagnostics(), calibration: calibration.diagnostics() });
      }
      const outcomes = Object.fromEntries(HEADS.map(head => [head, new Map(labels.pools[symbol][head].map(r => [r.decisionMs, r.target]))])) as Record<Head, Map<number, number>>;
      for (const p of points) {
        if (p.symbol !== symbol || p.decisionMs < cutoff || p.decisionMs >= Math.min(nextMs, end - 51 * H)) continue;
        if (heads.size !== 4) { unavailable[symbol]++; continue; }
        const prediction = {} as Record<Head, ReturnType<NetResidualCalibration["predict"]>>;
        for (const head of HEADS) {
          const fitted = heads.get(head)!, raw = fitted.model.predict(p.features), calibrated = fitted.calibration.predict(raw);
          prediction[head] = calibrated;
          const actual = outcomes[head].get(p.decisionMs), s = scores[symbol][head];
          if (actual === undefined) { s.unknown++; continue; }
          const reference = fitted.reference.predict({ location: 0, scale: 1 }), positive = actual > 0 ? 1 : 0;
          s.count++; s.squared += (actual - calibrated.meanNetBps) ** 2; s.brier += (calibrated.probabilityNetPositive - positive) ** 2;
          s.crps += fitted.calibration.crps(raw, actual); s.nll += studentTNll5(actual, raw.location, raw.scale);
          s.positive += positive; s.predictedPositive += calibrated.probabilityNetPositive;
          s.covered80 += actual >= calibrated.lower10NetBps && actual <= calibrated.upper90NetBps ? 1 : 0;
          s.referenceSquared += (actual - reference.meanNetBps) ** 2; s.referenceBrier += (reference.probabilityNetPositive - positive) ** 2;
          s.referenceCrps += fitted.reference.crps({ location: 0, scale: 1 }, actual);
          s.referenceNll += studentTNll5(actual, fitted.referenceRaw.location, fitted.referenceRaw.scale);
        }
        const action = chooseNetAction({ base: prediction["long-base"], stress: prediction["long-stress"] },
          { base: prediction["short-base"], stress: prediction["short-stress"] });
        if (action.reason === "INCOHERENT_BOTH_DIRECTIONS_QUALIFY") incoherent[symbol]++;
        if (action.side !== null) forecasts.push({ symbol, decisionMs: p.decisionMs, horizonHours: 24,
          // Simulator direction token only. Actual net forecasts are persisted below; global ranking is exogenous.
          predictedGrossBps: action.side * 1_000_000, expectedFundingCostBps: 0 });
        decisions.push({ symbol, decisionMs: p.decisionMs, ...action, prediction });
      }
    }
    await save(join(output, `${stage}-fit-${candidate}-${new Date(cutoff).toISOString().slice(0, 7)}.json`), monthDiagnostics);
    process.stdout.write(JSON.stringify({ stage, candidate, month: new Date(cutoff).toISOString().slice(0, 7), qualifiedSoFar: forecasts.length }) + "\n");
    cutoff = nextMs;
  }
  forecasts.sort((a, b) => a.decisionMs - b.decisionMs || a.symbol.localeCompare(b.symbol));
  const quality = Object.fromEntries(SYMBOLS.map(symbol => [symbol, { unavailable: unavailable[symbol], incoherentDirections: incoherent[symbol],
    predictiveGatePassed: unavailable[symbol] === 0 && predictiveGate(scores[symbol]),
    heads: Object.fromEntries(HEADS.map(head => [head, scoreSummary(scores[symbol][head])])) }])) as Record<HourlySymbol, {
      unavailable: number; incoherentDirections: number; predictiveGatePassed: boolean; heads: Record<Head, ReturnType<typeof scoreSummary>> }>;
  await save(join(output, `${stage}-signals-${candidate}.json`), { candidate, forecasts, forecastsSha256: jhash(forecasts),
    tokenInterpretation: "PREDICTED_GROSS_FIELD_IS_ONLY_AN_ADAPTER_DIRECTION_TOKEN;_NET_FORECASTS_ARE_IN_DECISIONS", quality, decisions });
  return { candidate, forecasts, quality };
}

interface Seal { sourceHashes: Record<string, string>; protocolSha256: string; dataSeal: object; }
interface Selection extends Seal { selectedByAsset: Record<HourlySymbol, Candidate | null>; developmentGatePassed: boolean; }
async function verifySeal(seal: Seal, output: string, data?: Data) {
  if (jhash(seal.sourceHashes) !== jhash(await sourceHashes()) || seal.protocolSha256 !== sha(await readFile(join(output, "protocol.json")))
    || data && jhash(data.seal) !== jhash(seal.dataSeal)) throw new Error("STUDENT_STUDY_SEAL_MISMATCH");
}
async function saveReceipt(stage: Stage, summary: string, output: string) {
  const names = (await readdir(output)).filter(n => n.startsWith(`${stage}-`) && n.endsWith(".json") && n !== `${stage}-integrity.json`).concat(summary).sort();
  await save(join(output, `${stage}-integrity.json`), { stage, artifacts: Object.fromEntries(await Promise.all(names.map(async n => [n, sha(await readFile(join(output, n)))]))) });
}
async function verifyReceipt(stage: Stage, summary: string, output: string) {
  const receipt = await json(join(output, `${stage}-integrity.json`));
  if (receipt.stage !== stage || !receipt.artifacts?.[summary] || !receipt.artifacts?.[`${stage}-start.json`]
    || !receipt.artifacts?.[`${stage}-portfolio.json`]) throw new Error("STUDENT_INCOMPLETE_ARTIFACT_RECEIPT");
  for (const [name, value] of Object.entries(receipt.artifacts)) if (!/^[a-zA-Z0-9._-]+\.json$/.test(name)
    || sha(await readFile(join(output, name))) !== value) throw new Error("STUDENT_ARTIFACT_CHANGED");
}
function confidence(pair: Pair, baseline: Pair) {
  const daily = (s: Simulation) => s.daily.map(r => {
    if (r.netPnlUsd === null) throw new Error("STUDENT_UNKNOWN_DAILY_PNL");
    return { date: r.date, netPnlUsd: r.netPnlUsd };
  });
  if (pair.base.netPnlUsd === null || baseline.base.netPnlUsd === null) return null;
  return { versusFlat: pairedWeeklyPnlInterval(daily(pair.base), daily(pair.base).map(r => ({ ...r, netPnlUsd: 0 }))),
    versusBuyHoldBtc: pairedWeeklyPnlInterval(daily(pair.base), daily(baseline.base)) };
}
export async function runStudentStudy(stage: "register" | Stage, older: string, recent: string, output: string) {
  await mkdir(output, { recursive: true });
  if (stage === "register") {
    await save(join(output, "protocol.json"), { registeredAtUtc: new Date().toISOString(), definition: STUDENT_STUDY_PROTOCOL });
    return { status: "STUDENT_PROTOCOL_REGISTERED_NO_RETURNS_EVALUATED" };
  }
  let selection: Selection | undefined;
  if (stage !== "develop") {
    selection = await json(join(output, "selection.json"));
    if (!selection!.developmentGatePassed) throw new Error("STUDENT_STAGE_DENIED_DEVELOPMENT_FAILED");
    await verifySeal(selection!, output); await verifyReceipt("develop", "selection.json", output);
    if (stage === "test") {
      const confirmation = await json(join(output, "confirmation.json"));
      if (!confirmation.confirmationGatePassed) throw new Error("STUDENT_FINAL_DENIED_CONFIRMATION_FAILED");
      if (confirmation.selectionSha256 !== sha(await readFile(join(output, "selection.json")))) throw new Error("STUDENT_SELECTION_CHANGED");
      await verifySeal(confirmation, output); await verifyReceipt("confirm", "confirmation.json", output);
    }
  }
  const protocol = await json(join(output, "protocol.json"));
  if (jhash(protocol.definition) !== jhash(STUDENT_STUDY_PROTOCOL)) throw new Error("STUDENT_PROTOCOL_CHANGED");
  const loaded = await loadData(older, recent); if (selection) await verifySeal(selection, output, loaded);
  const seal: Seal = { sourceHashes: await sourceHashes(), protocolSha256: sha(await readFile(join(output, "protocol.json"))), dataSeal: loaded.seal };
  await save(join(output, `${stage}-start.json`), { ...seal, startedAtUtc: new Date().toISOString() });
  const { start, end } = PERIODS[stage];
  const data: Data = { ...loaded, bars: loaded.bars.filter(b => b.openMs + H <= end), funding: loaded.funding.filter(r => r.timestampMs < end) };
  const points = buildHourlyVolumeFeatures(data.bars), labels = buildLabelPools(data, points, start, end);
  const results = new Map<Candidate, Awaited<ReturnType<typeof evaluate>>>();
  const comparisons: Array<{ candidate: Candidate; symbol: HourlySymbol; eligible: boolean; predictiveGatePassed: boolean;
    utility: number | null; summary: ReturnType<typeof details> }> = [];
  for (const candidate of CANDIDATES) {
    if (selection && !Object.values(selection.selectedByAsset).includes(candidate)) continue;
    const result = await evaluate(candidate, data, points, labels, start, end, stage, output,
      studentEvaluationSymbols(candidate, selection?.selectedByAsset)); results.set(candidate, result);
    if (stage === "develop") for (const symbol of SYMBOLS) {
      const pair = simulate(data, result.forecasts.filter(f => f.symbol === symbol), start, end), summary = pairSummary(pair);
      const predictiveGatePassed = result.quality[symbol].predictiveGatePassed, utility = adaptiveUtility(summary.stress);
      const eligible = predictiveGatePassed && adaptiveAssetEligible(summary, symbol);
      comparisons.push({ candidate, symbol, eligible, predictiveGatePassed, utility: Number.isFinite(utility) ? utility : null, summary: details(pair) });
      await save(join(output, `${stage}-${candidate}-${symbol.slice(0, 3)}.json`), pair);
      process.stdout.write(JSON.stringify({ stage, candidate, symbol, trades: pair.base.metrics.completed, base: pair.base.netPnlUsd,
        stress: pair.stress.netPnlUsd, predictiveGatePassed, eligible }) + "\n");
    }
  }
  const selectedByAsset = selection?.selectedByAsset ?? Object.fromEntries(SYMBOLS.map(symbol => [symbol,
    comparisons.filter(r => r.symbol === symbol && r.eligible).sort((a, b) => b.utility! - a.utility! || a.candidate.localeCompare(b.candidate))[0]?.candidate ?? null,
  ])) as Record<HourlySymbol, Candidate | null>;
  const forecasts = SYMBOLS.flatMap(symbol => selectedByAsset[symbol] ? results.get(selectedByAsset[symbol]!)!.forecasts.filter(f => f.symbol === symbol) : [])
    .sort((a, b) => a.decisionMs - b.decisionMs || a.symbol.localeCompare(b.symbol));
  const portfolio = simulate(data, forecasts, start, end), baseline = simulate(data, [{ symbol: "BTC/USD", decisionMs: start,
    predictedGrossBps: 1_000_000, horizonHours: Math.floor((end - start) / H) - 28, expectedFundingCostBps: 0 }], start, end);
  await save(join(output, `${stage}-portfolio.json`), { selectedByAsset, forecastsSha256: jhash(forecasts), ...portfolio });
  await save(join(output, `${stage}-baseline.json`), { id: "buy-hold-btc", ...baseline });
  const gates = { bothAssetsSelected: SYMBOLS.every(s => selectedByAsset[s] !== null),
    properPredictiveScores: SYMBOLS.every(s => selectedByAsset[s] !== null && results.get(selectedByAsset[s]!)!.quality[s].predictiveGatePassed),
    ...adaptivePortfolioGates(pairSummary(portfolio), pairSummary(baseline)) };
  const intervals = confidence(portfolio, baseline), confidencePassed = intervals !== null
    && (intervals.versusFlat.lower95TotalUsd ?? -Infinity) > 0 && (intervals.versusBuyHoldBtc.lower95TotalUsd ?? -Infinity) > 0;
  const passed = Object.values(gates).every(Boolean) && (stage !== "test" || confidencePassed);
  await verifySeal(seal, output, await loadData(older, recent));
  const summary = { ...seal, completedAtUtc: new Date().toISOString(), stage, selectedByAsset, comparisons, gates, intervals, confidencePassed,
    quality: [...results.values()].map(r => ({ candidate: r.candidate, ...r.quality })), portfolio: details(portfolio), baseline: details(baseline),
    developmentGatePassed: stage === "develop" ? passed : true, confirmationGatePassed: stage === "confirm" ? passed : stage === "test",
    finalTestOpened: stage === "test", candidateActivated: false, profitabilityEstablished: false, livePromotionAllowed: false,
    ...(selection ? { selectionSha256: sha(await readFile(join(output, "selection.json"))) } : {}),
    status: stage === "test" ? passed ? "STUDENT_HISTORICAL_PAPER_CANDIDATE_NEEDS_EXECUTION_VALIDATION" : "STUDENT_FINAL_FAILED_NO_PROMOTION"
      : passed ? `STUDENT_${stage.toUpperCase()}_PASSED_NEXT_STAGE_PENDING` : `STUDENT_${stage.toUpperCase()}_FAILED_FINAL_UNOPENED` };
  const summaryName = stage === "develop" ? "selection.json" : stage === "confirm" ? "confirmation.json" : "summary.json";
  await save(join(output, summaryName), summary); await saveReceipt(stage, summaryName, output);
  return { status: summary.status, selectedByAsset, gates, portfolio: pairSummary(portfolio), finalTestOpened: stage === "test" };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stage, older, recent, output] = process.argv.slice(2);
  if (!older || !recent || !output || !["register", "develop", "confirm", "test"].includes(stage ?? ""))
    throw new Error("Usage: hourly-student-study-main register|develop|confirm|test OLDER_DIRECTORY RECENT_DIRECTORY OUTPUT_DIRECTORY");
  process.stdout.write(JSON.stringify(await runStudentStudy(stage as "register" | Stage, resolve(older), resolve(recent), resolve(output)), null, 2) + "\n");
}
