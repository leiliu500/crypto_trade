import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHourlyDataset, mergeHourlyBars, type HourlyBar, type FundingRow, type HourlySymbol } from "./hourly-data.js";
import { buildHourlyDataset, buildHourlyTrainingRows, HOURLY_CANDIDATES, type HourlyCandidate } from "./hourly-model.js";
import { AdaptiveHourlyRidgeModel, HOURLY_ADAPTIVE_MODEL_SPEC } from "./hourly-adaptive-model.js";
import { buildHourlyPriceSetups, HOURLY_PRICE_SETUP_IDS, HOURLY_PRICE_SETUP_SPEC, type HourlyPriceSetupId } from "./hourly-price-setups.js";
import { simulateHourlyRetryAccount, HOURLY_SCENARIOS, type AssetRules, type HourlyForecast } from "./hourly-retry-simulator.js";
import { adaptiveAssetEligible, adaptivePortfolioGates, adaptiveUtility, ADAPTIVE_SELECTION_RULE,
  type AdaptiveAccountSummary, type AdaptiveScenarioSummary } from "./hourly-adaptive-study-gates.js";
import { pairedWeeklyPnlInterval, predictionErrorSummary } from "./hourly-study-statistics.js";

const HOUR = 3_600_000, DAY = HOUR * 24;
const SYMBOLS = ["BTC/USD", "ETH/USD"] as const;
const RULES_FILE = "reports/distribution-instrument-rules-2026-09-07.json";
const PERIODS = Object.freeze({
  develop: { startMs: Date.parse("2024-01-01T00:00:00Z"), endMs: Date.parse("2025-01-01T00:00:00Z") },
  confirm: { startMs: Date.parse("2025-01-01T00:00:00Z"), endMs: Date.parse("2026-01-01T00:00:00Z") },
  test: { startMs: Date.parse("2026-01-01T00:00:00Z"), endMs: Date.parse("2026-08-01T00:00:00Z") },
});
type Stage = keyof typeof PERIODS;
type Candidate = { id: string; model: HourlyCandidate } | { id: HourlyPriceSetupId; setup: HourlyPriceSetupId };
const CANDIDATES: readonly Candidate[] = Object.freeze([
  ...HOURLY_CANDIDATES.map(model => ({ id: `adaptive-${model.id}`, model })),
  ...HOURLY_PRICE_SETUP_IDS.map(setup => ({ id: setup, setup })),
]);
export const ADAPTIVE_STUDY_PROTOCOL = Object.freeze({
  version: "btc-eth-adaptive-versus-price-rules-v1", periods: PERIODS, candidates: CANDIDATES,
  priorExposure: "2024_WAS_PRIOR_TRAINING;_2025_PREVIOUSLY_INSPECTED;_2026_JAN_JUL_UNOPENED;_AUGUST_EXCLUDED",
  adaptiveModel: HOURLY_ADAPTIVE_MODEL_SPEC, priceSetups: HOURLY_PRICE_SETUP_SPEC,
  selection: ADAPTIVE_SELECTION_RULE,
  trainingDecisionPurgeHours: 26, decisionEndBufferHours: 51,
  entryQualification: "ABS_MODEL_GROSS_OR_GEOMETRIC_TWO_ATR_ROOM_MINUS_13BPS_MINUS_BASE_FUNDING_RESERVE_TIMES_HORIZON_STRICTLY_GREATER_THAN_5BPS",
  priceRuleScoreInterpretation: "GEOMETRIC_ROOM_IS_NOT_PREDICTED_RETURN_OR_PROBABILITY;_QUALIFICATION_IS_ONLY_A_COST_SCREEN",
  scenarios: HOURLY_SCENARIOS, fundingLookbackDays: 365, minimumFundingSamples: 6000,
  funding: "FIXED_AT_EACH_PERIOD_START:PRECEDING_365_DAYS_ABSOLUTE_HOURLY_RATE_P95_BASE_P99_STRESS;_ALWAYS_ADVERSE;_NO_CREDITS",
  fundingInterpretation: "SCENARIO_RETURNS;_ACTUAL_SETTLEMENT_TIMING_AND_POST_FEB2026_FUNDING_UNVERIFIED",
  orderRules: "SNAPSHOT_2026_09_07_ASSUMED_FOR_HISTORY;_ADVERSE_TICK_ROUNDING;_LOT_FLOOR;_MINIMUM_SIZE;_ONE_GLOBAL_12_USD_SLOT",
  exitRetry: "HOURLY_UNTIL_NOMINAL_PLUS_24H_INCLUSIVE;_LAST_ZERO_VOLUME_FAILURE_KNOWN_AT_PLUS_25H;_UNKNOWN_RETAINS_SLOT",
  baselines: ["flat", "fixed-trend-168h-held-24h", "buy-hold-btc", "buy-hold-eth"],
  baselineSelection: "HIGHEST_STRESS_NET_MINUS_HALF_DRAWDOWN_NONFLAT_IN_2024;_LEXICOGRAPHIC_ID_TIE",
  buyHoldHorizon: "PERIOD_HOURS_MINUS_28_ALLOWS_ENTRY_DELAY_AND_EXIT_RETRIES",
  inference: "2000_PAIRED_MOVING_7_DAY_BLOCKS_FULL_CALENDAR_SEED_20260908;_NOMINAL_ONE_SIDED_95_PERCENT_NOT_MULTIPLICITY_ADJUSTED",
  sealedRule: "ASSET_CHOICES_AND_UPDATE_ALGORITHM_FIXED_BEFORE_CONFIRMATION;_MONTHLY_CAUSAL_REFITS_ALLOWED_DURING_FINAL",
  noParameterSearch: true, noAutomaticActivation: true, realOrdersAllowed: false,
});
const SOURCE_FILES = ["src/research/hourly-data.ts", "src/research/hourly-model.ts", "src/research/hourly-adaptive-model.ts",
  "src/research/hourly-price-setups.ts", "src/research/hourly-retry-simulator.ts", "src/research/hourly-adaptive-study-main.ts",
  "src/research/hourly-adaptive-study-gates.ts", "src/research/hourly-study-statistics.ts", RULES_FILE, "package.json", "package-lock.json"];
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const jsonHash = (v: unknown) => hash(JSON.stringify(v));
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
async function sourceHashes() {
  return Object.fromEntries(await Promise.all(SOURCE_FILES.map(async path => [path, hash(await readFile(path))])));
}
interface StudyData { bars: HourlyBar[]; funding: FundingRow[]; rules: Record<HourlySymbol, AssetRules>; dataSeal: object; }
async function loadStudyData(older: string, recent: string): Promise<StudyData> {
  const fingerprints = () => Promise.all([older, recent].map(async directory => ({ directory: resolve(directory),
    datasetSha256: hash(await readFile(join(directory, "dataset.json"))), manifestSha256: hash(await readFile(join(directory, "manifest.json"))) })));
  const before = await fingerprints();
  const datasets = await Promise.all([loadHourlyDataset(older), loadHourlyDataset(recent)]);
  const allBars = datasets.flatMap(d => d.bars);
  const startMs = Math.min(...allBars.map(b => b.openMs)), endMs = Math.max(...allBars.map(b => b.openMs)) + HOUR;
  const bars = mergeHourlyBars(allBars, startMs, endMs, Date.now());
  if (startMs > Date.parse("2022-12-01T00:00:00Z") || endMs < PERIODS.test.endMs)
    throw new Error("ADAPTIVE_INCOMPLETE_STUDY_WINDOW");
  for (const symbol of SYMBOLS) {
    const own = bars.filter(b => b.symbol === symbol);
    if (own.length !== (endMs - startMs) / HOUR || own.some((b, i) => b.openMs !== startMs + i * HOUR))
      throw new Error(`ADAPTIVE_MERGED_HOURLY_GAP:${symbol}`);
  }
  const unique = new Map<string, FundingRow>();
  for (const row of datasets.flatMap(d => d.funding)) {
    const key = `${row.symbol}:${row.timestampMs}`, previous = unique.get(key);
    if (previous && (previous.rate !== row.rate || previous.absoluteRate !== row.absoluteRate)) throw new Error("ADAPTIVE_FUNDING_OVERLAP_CONFLICT");
    unique.set(key, row);
  }
  const funding = [...unique.values()].sort((a, b) => a.timestampMs - b.timestampMs || a.symbol.localeCompare(b.symbol));
  const after = await fingerprints();
  if (jsonHash(before) !== jsonHash(after)) throw new Error("ADAPTIVE_DATA_CHANGED_DURING_LOAD");
  const dataSeal = { datasets: after,
    normalizedBarsSha256: jsonHash(bars), normalizedFundingSha256: jsonHash(funding), bars: bars.length, fundingRows: funding.length };
  return { bars, funding, rules: await readJson(RULES_FILE), dataSeal };
}
function reserves(data: StudyData, cutoff: number, q: number) {
  return Object.fromEntries(SYMBOLS.map(symbol => {
    const values = data.funding.filter(r => r.symbol === symbol && r.timestampMs >= cutoff - 365 * DAY && r.timestampMs < cutoff)
      .map(r => Math.abs(r.rate) * 10000).sort((a, b) => a - b);
    if (values.length < 6000) throw new Error(`ADAPTIVE_FUNDING_SUPPORT:${symbol}:${values.length}`);
    return [symbol, values[Math.ceil(values.length * q) - 1]!];
  })) as Record<HourlySymbol, number>;
}
type Simulation = ReturnType<typeof simulateHourlyRetryAccount>;
type Pair = { base: Simulation; stress: Simulation };
function accountSummary(a: Simulation): AdaptiveAccountSummary {
  return { netPnlUsd: a.netPnlUsd, maximumDrawdownUsd: a.maximumDrawdownUsd, maximumOneDayLossUsd: a.maximumOneDayLossUsd,
    completed: a.metrics.completed, activeUtcDates: a.metrics.activeUtcDates, unknownTrades: a.metrics.unknownTrades, perAsset: a.perAsset };
}
function pairSummary(p: Pair): AdaptiveScenarioSummary { return { base: accountSummary(p.base), stress: accountSummary(p.stress) }; }
function detailedSummary(p: Pair) {
  return { ...pairSummary(p), accounting: { base: p.base.metrics, stress: p.stress.metrics } };
}
function simulations(data: StudyData, forecasts: HourlyForecast[], startMs: number, endMs: number): Pair {
  const run = (scenario: "base" | "stress") => simulateHourlyRetryAccount({ bars: data.bars, funding: data.funding,
    forecasts, startMs, endMs, scenario: HOURLY_SCENARIOS[scenario], assetRules: data.rules, rankingPolicy: "UTC_DAY_ALTERNATING",
    minimumExpectedNetBps: 5, forecastsPrequalified: true, adverseFundingBpsPerHour: reserves(data, startMs, scenario === "base" ? .95 : .99) });
  return { base: run("base"), stress: run("stress") };
}
type Index = ReturnType<typeof buildHourlyDataset>;
function candidateForecasts(data: StudyData, index: Index, candidate: Candidate, startMs: number, endMs: number) {
  const funding = reserves(data, startMs, .95), stop = endMs - 51 * HOUR;
  const forecasts: HourlyForecast[] = [], diagnostics: ReturnType<AdaptiveHourlyRidgeModel["diagnostics"]>[] = [];
  const errors: Record<HourlySymbol, Array<{ actual: number; predicted: number; unconditional: number }>> = { "BTC/USD": [], "ETH/USD": [] };
  const origins = { "BTC/USD": 0, "ETH/USD": 0 }, unavailable = { "BTC/USD": 0, "ETH/USD": 0 };
  if ("setup" in candidate) {
    const events = buildHourlyPriceSetups(data.bars, candidate.setup, startMs, stop);
    for (const event of events) {
      origins[event.symbol]++;
      const expectedFundingCostBps = funding[event.symbol] * event.horizonHours;
      if (event.roomBps - 13 - expectedFundingCostBps > 5) forecasts.push({ symbol: event.symbol, decisionMs: event.decisionMs,
        predictedGrossBps: event.side * event.roomBps, horizonHours: 24, expectedFundingCostBps });
    }
  } else {
    const outcomes = new Map(buildHourlyTrainingRows(index, candidate.model.horizonHours, startMs, endMs)
      .filter(r => r.decisionMs < stop).map(r => [`${r.symbol}:${r.decisionMs}`, r]));
    for (let cutoff = startMs; cutoff < endMs;) {
      const rows = buildHourlyTrainingRows(index, candidate.model.horizonHours, cutoff - 365 * DAY, cutoff)
        .filter(row => row.decisionMs < cutoff - 26 * HOUR);
      const model = new AdaptiveHourlyRidgeModel(candidate.model, rows, cutoff), diagnostic = model.diagnostics();
      diagnostics.push(diagnostic);
      for (const point of index.points) {
        if (point.decisionMs < cutoff || point.decisionMs >= Math.min(diagnostic.nextRefitMs, stop)) continue;
        origins[point.symbol]++;
        const predictedGrossBps = model.predict(point.symbol, point.features, point.decisionMs);
        if (predictedGrossBps === null) { unavailable[point.symbol]++; continue; }
        const expectedFundingCostBps = funding[point.symbol] * candidate.model.horizonHours;
        if (Math.abs(predictedGrossBps) - 13 - expectedFundingCostBps > 5) forecasts.push({ symbol: point.symbol,
          decisionMs: point.decisionMs, predictedGrossBps, horizonHours: candidate.model.horizonHours, expectedFundingCostBps });
        const outcome = outcomes.get(`${point.symbol}:${point.decisionMs}`);
        if (outcome) errors[point.symbol].push({ actual: outcome.grossBps, predicted: predictedGrossBps,
          unconditional: diagnostic.fits.find(f => f.symbol === point.symbol)!.targetMeanGrossBps! });
      }
      cutoff = diagnostic.nextRefitMs;
    }
  }
  forecasts.sort((a, b) => a.decisionMs - b.decisionMs || a.symbol.localeCompare(b.symbol));
  return { id: candidate.id, signalBasis: "setup" in candidate ? "GEOMETRIC_ROOM_NOT_EXPECTED_RETURN" : "PREDICTED_GROSS_RETURN",
    forecasts, forecastsSha256: jsonHash(forecasts), diagnostics, origins, unavailable,
    qualifiedByAsset: Object.fromEntries(SYMBOLS.map(symbol => [symbol, forecasts.filter(f => f.symbol === symbol).length])),
    predictionErrors: "setup" in candidate ? null : Object.fromEntries(SYMBOLS.map(symbol => [symbol, predictionErrorSummary(errors[symbol])])),
    knownOutcomeCounts: "setup" in candidate ? null : Object.fromEntries(SYMBOLS.map(symbol => [symbol, errors[symbol].length])),
    fundingReserveBpsPerHour: funding };
}
function baselineForecasts(id: string, index: Index, startMs: number, endMs: number): HourlyForecast[] {
  if (id === "flat") return [];
  if (id === "fixed-trend-168h-held-24h") return index.points.filter(p => p.decisionMs >= startMs
    && p.decisionMs < endMs - 51 * HOUR && p.features[2] !== 0).map(p => ({ symbol: p.symbol, decisionMs: p.decisionMs,
      predictedGrossBps: Math.sign(p.features[2]!) * 1_000_000, horizonHours: 24, expectedFundingCostBps: 0 }));
  if (id !== "buy-hold-btc" && id !== "buy-hold-eth") throw new Error("ADAPTIVE_UNKNOWN_BASELINE");
  return [{ symbol: id === "buy-hold-btc" ? "BTC/USD" : "ETH/USD", decisionMs: startMs, predictedGrossBps: 1_000_000,
    horizonHours: Math.floor((endMs - startMs) / HOUR) - 28, expectedFundingCostBps: 0 }];
}
function intervals(pair: Pair, baseline: Pair) {
  const daily = (s: Simulation) => s.daily.map(r => {
    if (r.netPnlUsd === null) throw new Error("ADAPTIVE_UNKNOWN_DAILY");
    return { date: r.date, netPnlUsd: r.netPnlUsd };
  });
  return Object.fromEntries((["base", "stress"] as const).map(scenario => {
    const s = pair[scenario], b = baseline[scenario];
    return [scenario, s.netPnlUsd === null || b.netPnlUsd === null ? null : {
      versusFlat: pairedWeeklyPnlInterval(daily(s), daily(s).map(r => ({ ...r, netPnlUsd: 0 }))),
      versusSelectedBaseline: pairedWeeklyPnlInterval(daily(s), daily(b)),
    }];
  })) as Record<"base" | "stress", null | { versusFlat: ReturnType<typeof pairedWeeklyPnlInterval>;
    versusSelectedBaseline: ReturnType<typeof pairedWeeklyPnlInterval> }>;
}
interface Seal { sourceHashes: Record<string, string>; protocolSha256: string; dataSeal: object; }
interface Selection extends Seal {
  selectedByAsset: Record<HourlySymbol, string | null>; selectedBaseline: string; developmentGatePassed: boolean;
}
async function assertSeal(seal: Seal, output: string, data?: StudyData) {
  if (jsonHash(seal.sourceHashes) !== jsonHash(await sourceHashes())
    || seal.protocolSha256 !== hash(await readFile(join(output, "protocol.json")))
    || data && jsonHash(seal.dataSeal) !== jsonHash(data.dataSeal)) throw new Error("ADAPTIVE_STUDY_SEAL_MISMATCH");
}
async function saveIntegrity(stage: Stage, summaryFile: string, output: string) {
  const names = (await readdir(output)).filter(name => name.startsWith(`${stage}-`) && name.endsWith(".json")
    && name !== `${stage}-integrity.json`).concat(summaryFile).sort();
  const artifacts = Object.fromEntries(await Promise.all(names.map(async name => [name, hash(await readFile(join(output, name)))])));
  await save(join(output, `${stage}-integrity.json`), { stage, completedAtUtc: new Date().toISOString(), artifacts });
}
async function verifyIntegrity(stage: Stage, summaryFile: string, output: string) {
  const receipt = await readJson(join(output, `${stage}-integrity.json`));
  if (receipt.stage !== stage || !receipt.artifacts?.[summaryFile] || !receipt.artifacts?.[`${stage}-start.json`]
    || !receipt.artifacts?.[`${stage}-portfolio.json`]) throw new Error("ADAPTIVE_INCOMPLETE_ARTIFACT_RECEIPT");
  for (const [name, expected] of Object.entries(receipt.artifacts)) {
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(name) || hash(await readFile(join(output, name))) !== expected)
      throw new Error("ADAPTIVE_ARTIFACT_CHANGED");
  }
}

export async function runAdaptiveStudy(stage: "register" | Stage, older: string, recent: string, output: string) {
  await mkdir(output, { recursive: true });
  if (stage === "register") {
    await save(join(output, "protocol.json"), { registeredAtUtc: new Date().toISOString(), definition: ADAPTIVE_STUDY_PROTOCOL });
    return { status: "PROTOCOL_REGISTERED_NO_RETURNS_EVALUATED" };
  }
  let selection: Selection | undefined;
  if (stage !== "develop") {
    selection = await readJson(join(output, "selection.json")) as Selection;
    if (!selection.developmentGatePassed) throw new Error("ADAPTIVE_STAGE_DENIED_DEVELOPMENT_FAILED");
    await assertSeal(selection, output);
    await verifyIntegrity("develop", "selection.json", output);
    if (stage === "test") {
      const confirmation = await readJson(join(output, "confirmation.json"));
      if (!confirmation.confirmationGatePassed) throw new Error("ADAPTIVE_FINAL_DENIED_CONFIRMATION_FAILED");
      if (confirmation.selectionSha256 !== hash(await readFile(join(output, "selection.json")))) throw new Error("ADAPTIVE_SELECTION_CHANGED");
      await assertSeal(confirmation, output);
      await verifyIntegrity("confirm", "confirmation.json", output);
    }
  }
  const protocol = await readJson(join(output, "protocol.json"));
  if (jsonHash(protocol.definition) !== jsonHash(ADAPTIVE_STUDY_PROTOCOL)) throw new Error("ADAPTIVE_PROTOCOL_CHANGED");
  const loaded = await loadStudyData(older, recent);
  if (selection) await assertSeal(selection, output, loaded);
  const seal: Seal = { sourceHashes: await sourceHashes(), protocolSha256: hash(await readFile(join(output, "protocol.json"))), dataSeal: loaded.dataSeal };
  await save(join(output, `${stage}-start.json`), { ...seal, startedAtUtc: new Date().toISOString() });
  const { startMs, endMs } = PERIODS[stage];
  // Do not even build future-period features or outcomes before its gated stage opens.
  const data: StudyData = { ...loaded, bars: loaded.bars.filter(b => b.openMs + HOUR <= endMs),
    funding: loaded.funding.filter(r => r.timestampMs < endMs) };
  const index = buildHourlyDataset(data.bars);
  const chosen = selection ? new Set(Object.values(selection.selectedByAsset)) : null;
  const inputs = new Map<string, ReturnType<typeof candidateForecasts>>();
  const perAssetResults: Array<{ id: string; symbol: HourlySymbol; eligible: boolean; utility: number | null; summary: ReturnType<typeof detailedSummary> }> = [];
  for (const candidate of CANDIDATES) {
    if (chosen && !chosen.has(candidate.id)) continue;
    const signals = candidateForecasts(data, index, candidate, startMs, endMs);
    inputs.set(candidate.id, signals);
    await save(join(output, `${stage}-signals-${candidate.id}.json`), signals);
    if (stage === "develop") for (const symbol of SYMBOLS) {
      const pair = simulations(data, signals.forecasts.filter(f => f.symbol === symbol), startMs, endMs);
      const utility = adaptiveUtility(accountSummary(pair.stress));
      const row = { id: candidate.id, symbol, eligible: adaptiveAssetEligible(pairSummary(pair), symbol),
        utility: Number.isFinite(utility) ? utility : null, summary: detailedSummary(pair) };
      perAssetResults.push(row);
      await save(join(output, `develop-${candidate.id}-${symbol.slice(0, 3)}.json`), pair);
      process.stdout.write(JSON.stringify({ stage, id: candidate.id, symbol, qualified: signals.qualifiedByAsset[symbol],
        trades: pair.base.metrics.completed, base: pair.base.netPnlUsd, stress: pair.stress.netPnlUsd, eligible: row.eligible }) + "\n");
    }
  }
  const baselineIds = stage === "develop" ? ADAPTIVE_STUDY_PROTOCOL.baselines : ["flat", selection!.selectedBaseline];
  const baselines = baselineIds.map(id => ({ id, ...simulations(data, baselineForecasts(id, index, startMs, endMs), startMs, endMs) }));
  await save(join(output, `${stage}-baselines.json`), baselines);
  const selectedBaseline = selection?.selectedBaseline ?? baselines.filter(b => b.id !== "flat")
    .sort((a, b) => adaptiveUtility(accountSummary(b.stress)) - adaptiveUtility(accountSummary(a.stress)) || a.id.localeCompare(b.id))[0]!.id;
  const selectedByAsset = selection?.selectedByAsset ?? Object.fromEntries(SYMBOLS.map(symbol => [symbol,
    perAssetResults.filter(r => r.symbol === symbol && r.eligible).sort((a, b) => b.utility! - a.utility! || a.id.localeCompare(b.id))[0]?.id ?? null,
  ])) as Record<HourlySymbol, string | null>;
  const forecasts = SYMBOLS.flatMap(symbol => {
    const id = selectedByAsset[symbol];
    return id ? inputs.get(id)!.forecasts.filter(f => f.symbol === symbol) : [];
  }).sort((a, b) => a.decisionMs - b.decisionMs || a.symbol.localeCompare(b.symbol));
  const portfolio = simulations(data, forecasts, startMs, endMs), baseline = baselines.find(b => b.id === selectedBaseline)!;
  await save(join(output, `${stage}-portfolio.json`), { selectedByAsset, forecastsSha256: jsonHash(forecasts), ...portfolio });
  const gate = { bothAssetsHaveEligibleSelection: SYMBOLS.every(s => selectedByAsset[s] !== null),
    ...adaptivePortfolioGates(pairSummary(portfolio), pairSummary(baseline)) };
  const confidence = intervals(portfolio, baseline);
  const finalConfidencePassed = confidence.base !== null && (confidence.base.versusFlat.lower95TotalUsd ?? -Infinity) > 0
    && (confidence.base.versusSelectedBaseline.lower95TotalUsd ?? -Infinity) > 0;
  const passed = Object.values(gate).every(Boolean) && (stage !== "test" || finalConfidencePassed);
  await assertSeal(seal, output, await loadStudyData(older, recent));
  const summary = { ...seal, completedAtUtc: new Date().toISOString(), stage, selectedByAsset, selectedBaseline,
    portfolio: detailedSummary(portfolio), baselines: baselines.map(b => ({ id: b.id, ...detailedSummary(b) })),
    candidateComparisons: perAssetResults, gates: gate, intervals: confidence, finalConfidencePassed,
    predictionQuality: [...inputs.values()].map(i => ({ id: i.id, signalBasis: i.signalBasis, origins: i.origins,
      unavailable: i.unavailable, qualifiedByAsset: i.qualifiedByAsset, knownOutcomeCounts: i.knownOutcomeCounts, predictionErrors: i.predictionErrors })),
    developmentGatePassed: stage === "develop" ? passed : true,
    confirmationGatePassed: stage === "confirm" ? passed : stage === "test",
    finalTestOpened: stage === "test", candidateActivated: false, profitabilityEstablished: false, livePromotionAllowed: false,
    ...(selection ? { selectionSha256: hash(await readFile(join(output, "selection.json"))) } : {}),
    status: stage === "test" ? passed ? "HISTORICAL_PAPER_CANDIDATE_REQUIRES_EXECUTION_VALIDATION" : "FINAL_FAILED_NO_PROMOTION"
      : passed ? `${stage.toUpperCase()}_PASSED_NEXT_STAGE_PENDING` : `${stage.toUpperCase()}_FAILED_FINAL_UNOPENED` };
  const summaryFile = stage === "develop" ? "selection.json" : stage === "confirm" ? "confirmation.json" : "summary.json";
  await save(join(output, summaryFile), summary);
  await saveIntegrity(stage, summaryFile, output);
  return { status: summary.status, selectedByAsset, selectedBaseline, gates: gate, portfolio: pairSummary(portfolio), finalTestOpened: stage === "test" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stage, older, recent, output] = process.argv.slice(2);
  if (!older || !recent || !output || !["register", "develop", "confirm", "test"].includes(stage ?? ""))
    throw new Error("Usage: hourly-adaptive-study-main register|develop|confirm|test OLDER_DATA_DIRECTORY RECENT_DATA_DIRECTORY OUTPUT_DIRECTORY");
  process.stdout.write(JSON.stringify(await runAdaptiveStudy(stage as "register" | Stage, resolve(older), resolve(recent), resolve(output)), null, 2) + "\n");
}
