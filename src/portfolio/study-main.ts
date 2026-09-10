import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHourlyDataset, mergeHourlyBars, type FundingRow } from "../research/hourly-data.js";
import { pairedWeeklyPnlInterval } from "../research/hourly-study-statistics.js";
import { buildPortfolioTargets } from "./signals.js";
import { simulatePortfolioReplay } from "./replay.js";
import { PORTFOLIO_DAY_MS as DAY, PORTFOLIO_HOUR_MS as HOUR, PORTFOLIO_SYMBOLS as SYMBOLS,
  type AssetRules, type Pair, type PortfolioPolicy } from "./types.js";
import { PORTFOLIO_PERIODS as PERIODS, PORTFOLIO_POLICIES as POLICIES,
  PORTFOLIO_SCENARIOS as SCENARIOS, PORTFOLIO_STUDY_PROTOCOL as PROTOCOL,
  portfolioEvidenceGates, portfolioEvidenceUtility, type PortfolioEvidence, type PortfolioStage } from "./protocol.js";

const RULES = "reports/distribution-instrument-rules-2026-09-07.json";
const SOURCES = ["src/portfolio/types.ts", "src/portfolio/signals.ts", "src/portfolio/kernel.ts",
  "src/portfolio/replay.ts", "src/portfolio/protocol.ts", "src/portfolio/study-main.ts",
  "src/portfolio/shadow.ts", "src/portfolio/live-main.ts", "src/research/hourly-data.ts",
  "src/research/hourly-study-statistics.ts", "src/core/order-book.ts", "src/core/market.ts",
  "src/kraken/market-stream.ts", "src/kraken/paper-broker.ts", "src/execution/planner.ts",
  "src/venue/client.ts", "package-lock.json", RULES];
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const jsonHash = (v: unknown) => hash(JSON.stringify(v));
const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
export async function portfolioSourceHashes() {
  return Object.fromEntries(await Promise.all(SOURCES.map(async path => [path, hash(await readFile(path))])));
}
interface DataSeal { directory: string; datasetSha256: string; manifestSha256: string }
async function dataSeals(older: string, recent: string): Promise<DataSeal[]> {
  return Promise.all([older, recent].map(async directory => ({ directory: resolve(directory),
    datasetSha256: hash(await readFile(join(directory, "dataset.json"))),
    manifestSha256: hash(await readFile(join(directory, "manifest.json"))) })));
}
interface Registration { protocol: typeof PROTOCOL; sourceHashes: Record<string, string>; dataSeals: DataSeal[]; createdAtUtc: string }
type Run = ReturnType<typeof simulatePortfolioReplay>;
export function portfolioRunEvidence(run: Run, targetCount: number): PortfolioEvidence {
  const days = (run.endMs - run.startMs) / DAY;
  return { known: run.allPathsKnown, netPnlUsd: run.netPnlUsd, maximumDrawdownUsd: run.maximumDrawdownUsd,
    maximumOneDayLossUsd: run.allPathsKnown ? Math.max(0, ...run.daily.map(d => -(d.netPnlUsd ?? 0))) : null,
    targetCoverageFraction: targetCount / days,
    exposureHours: run.equity.filter(e => e.atMs < run.endMs && SYMBOLS.some(s => e.quantities[s] !== 0)).length,
    perAsset: { "BTC/USD": { netPnlUsd: run.perAsset["BTC/USD"].netPnlUsd, exposureHours: run.perAsset["BTC/USD"].exposedHours },
      "ETH/USD": { netPnlUsd: run.perAsset["ETH/USD"].netPnlUsd, exposureHours: run.perAsset["ETH/USD"].exposedHours } } };
}
function compact(run: Run, targetCount: number) {
  const evidence = portfolioRunEvidence(run, targetCount);
  return { ...evidence, utility: portfolioEvidenceUtility(evidence), filledAdjustments: run.fills.length,
    feesUsd: run.totalFeesUsd, slippageUsdAlreadyInPricePnl: run.totalSlippageUsd,
    fundingCostUsd: run.totalFundingCostUsd, turnoverUsd: run.totalTurnoverUsd,
    meanGrossExposureUsd: run.meanGrossExposureUsd, maximumGrossExposureUsd: run.maximumGrossExposureUsd,
    zeroVolumeNoFills: run.zeroVolumeNoFills, unknownCount: run.unknowns.length,
    unknownReasons: [...new Set(run.unknowns.map(u => u.reason))],
    perAssetAccounting: run.perAsset,
    sourceInputs: run.inputReceipts,
    indicativePartialNetPnlUsd: run.allPathsKnown ? null : run.indicativeNetPnlUsd };
}

/** Later stages deny before opening price or funding datasets. */
export async function assertPortfolioStageAllowed(stage: PortfolioStage, output: string) {
  if (stage === "develop") return;
  const priorStage = stage === "confirm" ? "develop" : "confirm";
  let prior: { passed?: boolean; artifacts?: Record<string, string>; stage?: string;
    protocolSha256?: string; sourceHashes?: object; dataSeals?: object; period?: object };
  try { prior = await read(join(output, `${priorStage}-summary.json`)); }
  catch { throw new Error(`PORTFOLIO_STAGE_DENIED_${priorStage.toUpperCase()}_MISSING`); }
  if (prior.passed !== true) throw new Error(`PORTFOLIO_STAGE_DENIED_${priorStage.toUpperCase()}_FAILED`);
  if (priorStage === "confirm") await assertPortfolioStageAllowed("confirm", output);
  const registration = await read(join(output, "protocol.json")) as Registration;
  const protocolSha256 = hash(await readFile(join(output, "protocol.json")));
  if (prior.stage !== priorStage || jsonHash(prior.period) !== jsonHash(PERIODS[priorStage])
    || prior.protocolSha256 !== protocolSha256 || jsonHash(registration.protocol) !== jsonHash(PROTOCOL)
    || jsonHash(prior.sourceHashes) !== jsonHash(registration.sourceHashes)
    || jsonHash(prior.dataSeals) !== jsonHash(registration.dataSeals)) throw new Error("PORTFOLIO_STAGE_REGISTRATION_MISMATCH");
  if (!prior.artifacts || !Object.keys(prior.artifacts).length) throw new Error("PORTFOLIO_STAGE_INVALID_ARTIFACT_SEAL");
  const expected = POLICIES.flatMap(policy => [`${priorStage}-${policy}-targets.json`,
    ...SCENARIOS.map(s => `${priorStage}-${policy}-${s.id}.json`)]).sort();
  if (jsonHash(Object.keys(prior.artifacts).sort()) !== jsonHash(expected)) throw new Error("PORTFOLIO_STAGE_ARTIFACT_SET");
  for (const [name, digest] of Object.entries(prior.artifacts)) {
    if (!/^[a-z0-9.-]+\.json$/.test(name) || hash(await readFile(join(output, name))) !== digest)
      throw new Error("PORTFOLIO_STAGE_ARTIFACT_CHANGED");
  }
  const integrity = await read(join(output, `${priorStage}-integrity.json`));
  if (integrity.summarySha256 !== hash(await readFile(join(output, `${priorStage}-summary.json`)))
    || integrity.stage !== priorStage || integrity.protocolSha256 !== protocolSha256
    || jsonHash(integrity.sourceHashes) !== jsonHash(registration.sourceHashes)
    || jsonHash(integrity.dataSeals) !== jsonHash(registration.dataSeals)
    || jsonHash(integrity.artifacts) !== jsonHash(prior.artifacts))
    throw new Error("PORTFOLIO_STAGE_SUMMARY_CHANGED");
}
export async function runPortfolioStudy(stage: "register" | PortfolioStage, older: string, recent: string, output: string) {
  if (stage !== "register" && !(stage in PERIODS)) throw new Error("PORTFOLIO_UNKNOWN_STAGE");
  if (stage === "register") {
    await mkdir(output, { recursive: true });
    if ((await readdir(output)).some(n => n !== ".gitignore")) throw new Error("PORTFOLIO_REGISTRATION_REQUIRES_EMPTY_DIRECTORY");
    const registration: Registration = { protocol: PROTOCOL, sourceHashes: await portfolioSourceHashes(),
      dataSeals: await dataSeals(older, recent), createdAtUtc: new Date().toISOString() };
    await save(join(output, "protocol.json"), registration);
    return { status: "REGISTERED_BEFORE_RETURNS", output };
  }
  await assertPortfolioStageAllowed(stage, output);
  const registration = await read(join(output, "protocol.json")) as Registration;
  const protocolSha256 = hash(await readFile(join(output, "protocol.json")));
  if (jsonHash(registration.protocol) !== jsonHash(PROTOCOL)) throw new Error("PORTFOLIO_PROTOCOL_CHANGED");
  if (jsonHash(registration.sourceHashes) !== jsonHash(await portfolioSourceHashes())) throw new Error("PORTFOLIO_SOURCE_CHANGED");
  if (jsonHash(registration.dataSeals) !== jsonHash(await dataSeals(older, recent))) throw new Error("PORTFOLIO_DATA_CHANGED");
  await save(join(output, `${stage}-start.json`), { stage, startedAtUtc: new Date().toISOString(), protocolSha256,
    sourceHashes: registration.sourceHashes });
  const datasets = await Promise.all([loadHourlyDataset(older), loadHourlyDataset(recent)]);
  const period = PERIODS[stage];
  const allBars = datasets.flatMap(d => d.bars);
  const bars = mergeHourlyBars(allBars.filter(b => b.openMs >= period.startMs - 370 * DAY && b.openMs < period.endMs),
    period.startMs - 370 * DAY, period.endMs, Date.now());
  const map = new Map<string, FundingRow>();
  for (const row of datasets.flatMap(d => d.funding)) {
    if (row.timestampMs < period.startMs || row.timestampMs > period.endMs + HOUR) continue;
    const key = `${row.symbol}:${row.timestampMs}`, old = map.get(key);
    if (old && (old.rate !== row.rate || old.absoluteRate !== row.absoluteRate)) throw new Error("PORTFOLIO_FUNDING_CONFLICT");
    map.set(key, row);
  }
  const funding = [...map.values()].sort((a, b) => a.timestampMs - b.timestampMs || a.symbol.localeCompare(b.symbol));
  const rules = await read(RULES) as Pair<AssetRules>;
  const runs = new Map<string, Run>();
  const summaries: Array<{ policy: PortfolioPolicy; scenario: string; result: ReturnType<typeof compact> }> = [];
  const artifacts: Record<string, string> = {};
  const targetCounts = new Map<PortfolioPolicy, number>();
  for (const policy of POLICIES) {
    const targets = buildPortfolioTargets(bars, period.startMs, period.endMs, policy);
    targetCounts.set(policy, targets.length);
    const targetFile = `${stage}-${policy}-targets.json`;
    await save(join(output, targetFile), { policy, targets });
    artifacts[targetFile] = hash(await readFile(join(output, targetFile)));
    for (const scenario of SCENARIOS) {
      const run = simulatePortfolioReplay({ bars, funding, targets, rules, ...period, scenario });
      const file = `${stage}-${policy}-${scenario.id}.json`;
      await save(join(output, file), run); artifacts[file] = hash(await readFile(join(output, file)));
      runs.set(`${policy}:${scenario.id}`, run);
      summaries.push({ policy, scenario: scenario.id, result: compact(run, targets.length) });
      process.stdout.write(`${JSON.stringify({ type: "portfolio-scenario-complete", stage, policy, scenario: scenario.id,
        known: run.allPathsKnown, netPnlUsd: run.netPnlUsd, filledAdjustments: run.fills.length })}\n`);
    }
  }
  const comparisons = SCENARIOS.map(scenario => {
    const candidate = runs.get(`multiscale-trend:${scenario.id}`)!;
    const baseline = runs.get(`sign-trend-90d:${scenario.id}`)!;
    const gates = portfolioEvidenceGates(portfolioRunEvidence(candidate, targetCounts.get("multiscale-trend")!),
      portfolioRunEvidence(baseline, targetCounts.get("sign-trend-90d")!));
    const daily = (r: Run) => r.daily.map(d => ({ date: d.date, netPnlUsd: d.netPnlUsd! }));
    const intervals = candidate.allPathsKnown && baseline.allPathsKnown ? {
      versusFlat: pairedWeeklyPnlInterval(daily(candidate), daily(candidate).map(d => ({ ...d, netPnlUsd: 0 }))),
      versusSimpleRule: pairedWeeklyPnlInterval(daily(candidate), daily(baseline)),
    } : null;
    return { scenario: scenario.id, gates, intervals };
  });
  // Keep the exact
  // nominal block-bootstrap output in the report rather than inventing p-values.
  const confidencePassed = comparisons.every(c => c.intervals !== null
    && (c.intervals.versusFlat.lower95DailyUsd ?? -Infinity) > 0
    && (c.intervals.versusSimpleRule.lower95DailyUsd ?? -Infinity) > 0);
  const economicGatesPassed = comparisons.every(c => Object.values(c.gates).every(Boolean));
  const passed = economicGatesPassed && (stage !== "test" || confidencePassed);
  if (protocolSha256 !== hash(await readFile(join(output, "protocol.json")))
    || jsonHash(registration.sourceHashes) !== jsonHash(await portfolioSourceHashes())
    || jsonHash(registration.dataSeals) !== jsonHash(await dataSeals(older, recent))) throw new Error("PORTFOLIO_INPUT_CHANGED_DURING_RUN");
  const summary = { version: PROTOCOL.version, stage, completedAtUtc: new Date().toISOString(),
    protocolSha256, sourceHashes: registration.sourceHashes, dataSeals: registration.dataSeals,
    period, summaries, comparisons, economicGatesPassed, confidencePassed, passed,
    status: passed ? "STAGE_PASSED" : "STAGE_FAILED", artifacts,
    finalTestOpened: stage === "test", productionModelChanged: false, candidateActivated: false,
    profitabilityEstablished: false, hourlyScenarioEvidencePassed: stage === "test" && passed,
    reasonProfitabilityNotCertified: "CANDLE_EXECUTION_AND_FUNDING_TIMESTAMP_UNCERTAINTY;LIVE_SHADOW_RECONCILIATION_STILL_REQUIRED" };
  await save(join(output, `${stage}-summary.json`), summary);
  await save(join(output, `${stage}-integrity.json`), { stage, verifiedAtUtc: new Date().toISOString(),
    summarySha256: hash(await readFile(join(output, `${stage}-summary.json`))), protocolSha256,
    sourceHashes: registration.sourceHashes, dataSeals: registration.dataSeals, artifacts });
  return { status: summary.status, stage, passed, confidencePassed, output };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [stage, older, recent, output] = process.argv.slice(2);
  if (!stage || !older || !recent || !output) throw new Error("Usage: portfolio/study-main register|develop|confirm|test older-dataset recent-dataset output-directory");
  const result = await runPortfolioStudy(stage as "register" | PortfolioStage, older, recent, output);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
