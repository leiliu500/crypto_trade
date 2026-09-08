import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHourlyDataset, type HourlyDataset, type FundingRow } from "./hourly-data.js";
import { buildHourlyDataset, buildHourlyTrainingRows, HOURLY_CANDIDATES, HourlyRidgeModel } from "./hourly-model.js";
import { HOURLY_SCENARIOS, simulateHourlyAccount, type HourlyForecast } from "./hourly-simulator.js";
import { pairedWeeklyPnlInterval, predictionErrorSummary } from "./hourly-study-statistics.js";

const HOUR = 3_600_000;
const TRAIN = Date.parse("2024-01-01T00:00:00Z"), DEVELOPMENT = Date.parse("2025-01-01T00:00:00Z"),
  TEST = Date.parse("2026-01-01T00:00:00Z"), END = Date.parse("2026-08-01T00:00:00Z");
const SYMBOLS = ["BTC/USD", "ETH/USD"] as const;
type Candidate = typeof HOURLY_CANDIDATES[number];
type IndexedData = ReturnType<typeof buildHourlyDataset>;
type Simulation = ReturnType<typeof simulateHourlyAccount>;
const SOURCE_FILES = ["src/research/hourly-data.ts", "src/research/hourly-model.ts", "src/research/hourly-simulator.ts",
  "src/research/hourly-study-main.ts", "src/research/hourly-study-statistics.ts", "package.json", "package-lock.json"];
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const jsonHash = (value: unknown) => sha256(JSON.stringify(value));
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
async function sourceHashes() {
  return Object.fromEntries(await Promise.all(SOURCE_FILES.map(async path => [path, sha256(await readFile(path))])));
}

function fundingReserves(rows: FundingRow[], fromMs: number, cutoffMs: number, quantile = .95) {
  return Object.fromEntries(SYMBOLS.map(symbol => {
    const values = rows.filter(row => row.symbol === symbol && row.timestampMs >= fromMs && row.timestampMs < cutoffMs)
      .map(row => Math.abs(row.rate) * 10_000).sort((a, b) => a - b);
    if (values.length < 6000) throw new Error(`HOURLY_TRAINING_FUNDING_TOO_SHORT:${symbol}:${values.length}`);
    return [symbol, values[Math.ceil(values.length * quantile) - 1]!];
  })) as Record<typeof SYMBOLS[number], number>;
}

function fit(index: IndexedData, candidate: Candidate, cutoffMs: number) {
  const rows = buildHourlyTrainingRows(index, candidate.horizonHours, TRAIN, cutoffMs)
    .filter(row => row.decisionMs < cutoffMs - 25 * HOUR);
  const counts = Object.fromEntries(SYMBOLS.map(symbol => [symbol, rows.filter(row => row.symbol === symbol).length]));
  if (Object.values(counts).some(count => count < 6000)) throw new Error("HOURLY_TRAINING_SAMPLES_TOO_SHORT");
  const model = new HourlyRidgeModel(candidate, rows, cutoffMs);
  const unconditional = Object.fromEntries(SYMBOLS.map(symbol => {
    const own = rows.filter(row => row.symbol === symbol);
    return [symbol, own.reduce((sum, row) => sum + row.grossBps, 0) / own.length];
  })) as Record<typeof SYMBOLS[number], number>;
  return { model, unconditional, counts, trainingRowsSha256: jsonHash(rows) };
}

function forecasts(index: IndexedData, fitted: ReturnType<typeof fit>, candidate: Candidate,
  reserves: Record<typeof SYMBOLS[number], number>, startMs: number, endMs: number) {
  const qualified: HourlyForecast[] = [];
  let origins = 0;
  for (const point of index.points) {
    if (point.decisionMs < startMs || point.decisionMs >= endMs - 26 * HOUR) continue;
    const predictedGrossBps = fitted.model.predict(point.symbol, point.features, point.decisionMs);
    if (predictedGrossBps === null) continue;
    origins++;
    const expectedFundingCostBps = reserves[point.symbol] * candidate.horizonHours;
    if (Math.abs(predictedGrossBps) - 13 - expectedFundingCostBps > 5) qualified.push({ symbol: point.symbol,
      decisionMs: point.decisionMs, predictedGrossBps, horizonHours: candidate.horizonHours, expectedFundingCostBps });
  }
  return { qualified, origins };
}

function simulations(data: HourlyDataset, inputs: HourlyForecast[], startMs: number, endMs: number) {
  const baseReserve = fundingReserves(data.funding, TRAIN, startMs, .95);
  const stressReserve = fundingReserves(data.funding, TRAIN, startMs, .99);
  return {
    base: simulateHourlyAccount({ bars: data.bars, funding: data.funding, forecasts: inputs, startMs, endMs,
      scenario: HOURLY_SCENARIOS.base, minimumExpectedNetBps: 5, forecastsPrequalified: true, adverseFundingBpsPerHour: baseReserve }),
    stress: simulateHourlyAccount({ bars: data.bars, funding: data.funding, forecasts: inputs, startMs, endMs,
      scenario: HOURLY_SCENARIOS.stress, minimumExpectedNetBps: 5, forecastsPrequalified: true, adverseFundingBpsPerHour: stressReserve }),
  };
}

function evaluate(data: HourlyDataset, index: IndexedData, candidate: Candidate, fitted: ReturnType<typeof fit>,
  reserves: Record<typeof SYMBOLS[number], number>, startMs: number, endMs: number) {
  const inputs = forecasts(index, fitted, candidate, reserves, startMs, endMs);
  const outcomes = buildHourlyTrainingRows(index, candidate.horizonHours, startMs, endMs)
    .filter(row => row.decisionMs < endMs - 26 * HOUR);
  const predictionErrors = Object.fromEntries(SYMBOLS.map(symbol => [symbol, predictionErrorSummary(outcomes
    .filter(row => row.symbol === symbol).flatMap(row => {
      const predicted = fitted.model.predict(symbol, row.features, row.decisionMs);
      return predicted === null ? [] : [{ actual: row.grossBps, predicted, unconditional: fitted.unconditional[symbol] }];
    }))]));
  const outcomeCoverageByAsset = Object.fromEntries(SYMBOLS.map(symbol => {
    const origins = index.points.filter(point => point.symbol === symbol && point.decisionMs >= startMs && point.decisionMs < endMs - 26 * HOUR).length;
    const known = outcomes.filter(row => row.symbol === symbol).length;
    return [symbol, { origins, known, unknown: origins - known }];
  }));
  return { candidate, origins: inputs.origins, qualifiedForecasts: inputs.qualified.length,
    forecastsSha256: jsonHash(inputs.qualified), predictionErrors, outcomeCoverageByAsset,
    ...simulations(data, inputs.qualified, startMs, endMs) };
}

function baselines(data: HourlyDataset, index: IndexedData, startMs: number, endMs: number) {
  const trend: HourlyForecast[] = index.points.filter(point => point.decisionMs >= startMs && point.decisionMs < endMs - 26 * HOUR)
    .filter(point => point.features[2] !== 0).map(point => ({ symbol: point.symbol, decisionMs: point.decisionMs,
      // Magnitude is a constant policy eligibility token, not a forecast of a million basis points.
      predictedGrossBps: Math.sign(point.features[2]!) * 1_000_000, horizonHours: 24, expectedFundingCostBps: 0 }));
  const holdingHours = Math.floor((endMs - startMs) / HOUR) - 3;
  return [
    { id: "flat", ...simulations(data, [], startMs, endMs) },
    { id: "fixed-trend-168h-held-24h", ...simulations(data, trend, startMs, endMs) },
    ...SYMBOLS.map(symbol => ({ id: symbol === "BTC/USD" ? "buy-hold-btc" : "buy-hold-eth",
      ...simulations(data, [{ symbol, decisionMs: startMs, predictedGrossBps: 1_000_000, horizonHours: holdingHours,
        expectedFundingCostBps: 0 }], startMs, endMs) })),
  ];
}

// These accessors also make selection reject unknown outcomes instead of treating null as zero.
function utility(report: Simulation) {
  return report.netPnlUsd === null || report.maximumDrawdownUsd === null ? Number.NEGATIVE_INFINITY
    : report.netPnlUsd - .5 * report.maximumDrawdownUsd;
}
function developmentEligible(report: ReturnType<typeof evaluate>) {
  return report.base.netPnlUsd !== null && report.base.netPnlUsd > 0 && report.stress.netPnlUsd !== null && report.stress.netPnlUsd > 0
    && completedTrades(report.base).length >= 100 && SYMBOLS.every(symbol => completedTrades(report.base).filter(trade => trade.symbol === symbol).length >= 20);
}
function completedTrades(report: Simulation) {
  return report.trades.filter((trade): trade is typeof trade & { entryMs: number; netPnlUsd: number } =>
    trade.status === "COMPLETE" && trade.entryMs !== null && trade.netPnlUsd !== null);
}
function knownDaily(report: Simulation) {
  return report.daily.map(row => {
    if (row.netPnlUsd === null) throw new Error("HOURLY_UNKNOWN_DAILY_PNL");
    return { date: row.date, netPnlUsd: row.netPnlUsd };
  });
}

export async function runHourlyDevelopment(datasetPath: string, outputDirectory: string) {
  await mkdir(outputDirectory, { recursive: true });
  if (basename(datasetPath) !== "dataset.json") throw new Error("HOURLY_MANIFEST_DATASET_PATH_REQUIRED");
  const raw = await readFile(datasetPath), data = await loadHourlyDataset(dirname(datasetPath));
  const hashes = await sourceHashes(), protocolHash = sha256(await readFile(join(outputDirectory, "protocol.json")));
  const seal = { startedAtUtc: new Date().toISOString(), dataSha256: sha256(raw), sourceHashes: hashes, protocolSha256: protocolHash };
  await save(join(outputDirectory, "development-start.json"), seal);
  const index = buildHourlyDataset(data.bars), reserves = fundingReserves(data.funding, TRAIN, DEVELOPMENT);
  const results = [];
  for (const candidate of HOURLY_CANDIDATES) {
    const fitted = fit(index, candidate, DEVELOPMENT), report = evaluate(data, index, candidate, fitted, reserves, DEVELOPMENT, TEST);
    await save(join(outputDirectory, `development-${candidate.id}.json`), { ...report, diagnostics: fitted.model.diagnostics(),
      trainingRowsSha256: fitted.trainingRowsSha256, fundingReserveBpsPerHour: reserves });
    results.push(report);
    process.stdout.write(JSON.stringify({ stage: "development", candidate: candidate.id, baseNetPnlUsd: report.base.netPnlUsd,
      stressNetPnlUsd: report.stress.netPnlUsd, trades: completedTrades(report.base).length }) + "\n");
  }
  const references = baselines(data, index, DEVELOPMENT, TEST);
  await save(join(outputDirectory, "development-baselines.json"), references);
  const selected = [...results].sort((a, b) => utility(b.stress) - utility(a.stress) || a.candidate.id.localeCompare(b.candidate.id))[0]!;
  const reference = references.filter(row => row.id !== "flat").sort((a, b) => utility(b.stress) - utility(a.stress) || a.id.localeCompare(b.id))[0]!;
  if (jsonHash(hashes) !== jsonHash(await sourceHashes())) throw new Error("HOURLY_SOURCE_CHANGED_DURING_DEVELOPMENT");
  const passed = developmentEligible(selected);
  const selection = { ...seal, completedAtUtc: new Date().toISOString(), selectedCandidate: selected.candidate, selectedBaseline: reference.id,
    developmentGatePassed: passed, finalTestOpened: false, candidateActivated: false, profitabilityEstablished: false,
    status: passed ? "DEVELOPMENT_PASSED_FINAL_TEST_PENDING" : "DEVELOPMENT_FAILED_FINAL_TEST_UNOPENED",
    summaries: results.map(row => ({ id: row.candidate.id, baseNetPnlUsd: row.base.netPnlUsd, stressNetPnlUsd: row.stress.netPnlUsd,
      trades: completedTrades(row.base).length, utility: Number.isFinite(utility(row.stress)) ? utility(row.stress) : null, eligible: developmentEligible(row) })) };
  await save(join(outputDirectory, "selection.json"), selection);
  if (passed) {
    const finalFit = fit(index, selected.candidate, TEST), finalReserves = fundingReserves(data.funding, TRAIN, TEST);
    await save(join(outputDirectory, "frozen-model.json"), { ...seal, candidate: selected.candidate, cutoffMs: TEST,
      diagnostics: finalFit.model.diagnostics(), trainingRowsSha256: finalFit.trainingRowsSha256, fundingReserveBpsPerHour: finalReserves });
  }
  return selection;
}

export async function runHourlyFinalTest(datasetPath: string, outputDirectory: string) {
  const selection = JSON.parse(await readFile(join(outputDirectory, "selection.json"), "utf8")) as Awaited<ReturnType<typeof runHourlyDevelopment>>;
  if (!selection.developmentGatePassed) throw new Error("HOURLY_FINAL_TEST_DENIED_DEVELOPMENT_FAILED");
  const raw = await readFile(datasetPath);
  if (sha256(raw) !== selection.dataSha256 || jsonHash(await sourceHashes()) !== jsonHash(selection.sourceHashes)
    || sha256(await readFile(join(outputDirectory, "protocol.json"))) !== selection.protocolSha256) throw new Error("HOURLY_FINAL_TEST_SEAL_MISMATCH");
  if (basename(datasetPath) !== "dataset.json") throw new Error("HOURLY_MANIFEST_DATASET_PATH_REQUIRED");
  const data = await loadHourlyDataset(dirname(datasetPath));
  const frozenRaw = await readFile(join(outputDirectory, "frozen-model.json")), frozen = JSON.parse(frozenRaw.toString());
  const index = buildHourlyDataset(data.bars), fitted = fit(index, selection.selectedCandidate, TEST);
  const reserves = fundingReserves(data.funding, TRAIN, TEST);
  if (jsonHash(fitted.model.diagnostics()) !== jsonHash(frozen.diagnostics) || fitted.trainingRowsSha256 !== frozen.trainingRowsSha256
    || jsonHash(reserves) !== jsonHash(frozen.fundingReserveBpsPerHour)) throw new Error("HOURLY_FROZEN_MODEL_RECONSTRUCTION_MISMATCH");
  await save(join(outputDirectory, "final-test-start.json"), { startedAtUtc: new Date().toISOString(), frozenModelSha256: sha256(frozenRaw),
    dataSha256: selection.dataSha256, sourceHashes: selection.sourceHashes, protocolSha256: selection.protocolSha256 });
  const report = evaluate(data, index, selection.selectedCandidate, fitted, reserves, TEST, END);
  const references = baselines(data, index, TEST, END), baseline = references.find(row => row.id === selection.selectedBaseline)!;
  await save(join(outputDirectory, "final-test.json"), report);
  await save(join(outputDirectory, "final-test-baselines.json"), references);
  const base = report.base, stress = report.stress;
  const baseTrades = completedTrades(base);
  const activeDates = new Set(baseTrades.map(trade => new Date(trade.entryMs).toISOString().slice(0, 10))).size;
  const perAsset = Object.fromEntries(SYMBOLS.map(symbol => [symbol, {
    trades: baseTrades.filter(trade => trade.symbol === symbol).length,
    baseNetPnlUsd: base.perAsset.find(row => row.symbol === symbol)!.netPnlUsd,
    stressNetPnlUsd: stress.perAsset.find(row => row.symbol === symbol)!.netPnlUsd,
    unknownBaseTrades: base.perAsset.find(row => row.symbol === symbol)!.unknownTrades,
    unknownStressTrades: stress.perAsset.find(row => row.symbol === symbol)!.unknownTrades,
  }]));
  const intervals = base.netPnlUsd === null || baseline.base.netPnlUsd === null ? null : {
    versusFlat: pairedWeeklyPnlInterval(knownDaily(base), base.daily.map(row => ({ date: row.date, netPnlUsd: 0 }))),
    versusSelectedBaseline: pairedWeeklyPnlInterval(knownDaily(base), knownDaily(baseline.base)),
  };
  const acceptance = {
    sufficientTrades: baseTrades.length >= 100 && activeDates >= 40 && Object.values(perAsset).every(row => row.trades >= 20),
    positiveBase: base.netPnlUsd !== null && base.netPnlUsd > 0 && Object.values(perAsset).every(row => row.baseNetPnlUsd !== null && row.baseNetPnlUsd > 0),
    survivesStress: stress.netPnlUsd !== null && stress.netPnlUsd >= 0 && Object.values(perAsset).every(row => row.stressNetPnlUsd !== null && row.stressNetPnlUsd >= 0),
    beatsBaseline: base.netPnlUsd !== null && baseline.base.netPnlUsd !== null && base.netPnlUsd > baseline.base.netPnlUsd
      && stress.netPnlUsd !== null && baseline.stress.netPnlUsd !== null && stress.netPnlUsd > baseline.stress.netPnlUsd,
    withinDrawdown: base.maximumDrawdownUsd !== null && base.maximumDrawdownUsd <= 12
      && stress.maximumDrawdownUsd !== null && stress.maximumDrawdownUsd <= 12,
    withinDailyLoss: base.daily.every(row => row.netPnlUsd !== null && row.netPnlUsd >= -12)
      && stress.daily.every(row => row.netPnlUsd !== null && row.netPnlUsd >= -12),
    fullPeriodKnown: base.netPnlUsd !== null && stress.netPnlUsd !== null,
  };
  const passed = Object.values(acceptance).every(Boolean);
  if (jsonHash(await sourceHashes()) !== jsonHash(selection.sourceHashes)) throw new Error("HOURLY_SOURCE_CHANGED_DURING_FINAL_TEST");
  const summary = { completedAtUtc: new Date().toISOString(), selectedCandidate: selection.selectedCandidate, selectedBaseline: selection.selectedBaseline,
    status: passed ? "HISTORICAL_PAPER_CANDIDATE_REQUIRES_EXECUTION_VALIDATION" : "FINAL_TEST_FAILED_NO_PROMOTION",
    baseNetPnlUsd: base.netPnlUsd, stressNetPnlUsd: stress.netPnlUsd, trades: baseTrades.length, activeDates, perAsset,
    predictionErrors: report.predictionErrors, acceptance, intervals, finalTestOpened: true, candidateActivated: false,
    profitabilityEstablished: false, livePromotionAllowed: false, sourceHashes: selection.sourceHashes, dataSha256: selection.dataSha256 };
  await save(join(outputDirectory, "summary.json"), summary);
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stage, input, output] = process.argv.slice(2);
  if (!input || !output || (stage !== "develop" && stage !== "test")) throw new Error("Usage: hourly-study-main develop|test DATASET_JSON OUTPUT_DIRECTORY");
  const report = stage === "develop" ? await runHourlyDevelopment(resolve(input), resolve(output)) : await runHourlyFinalTest(resolve(input), resolve(output));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
