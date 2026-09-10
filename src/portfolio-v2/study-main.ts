import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHourlyDataset, mergeHourlyBars, type FundingRow } from "../research/hourly-data.js";
import { pairedWeeklyPnlInterval } from "../research/hourly-study-statistics.js";
import { buildPortfolioTargets } from "../portfolio/signals.js";
import { simulatePortfolioReplay as ungovernedReplay } from "../portfolio/replay.js";
import { portfolioSourceHashes, portfolioRunEvidence } from "../portfolio/study-main.js";
import { PORTFOLIO_DAY_MS as DAY, PORTFOLIO_HOUR_MS as HOUR, type AssetRules, type Pair,
  type PortfolioPolicy } from "../portfolio/types.js";
import type { PortfolioStage } from "../portfolio/protocol.js";
import { simulatePortfolioReplay } from "./replay.js";
import type { RiskGovernorState } from "./risk.js";
import { RISK_STUDY_PROTOCOL as PROTOCOL, PORTFOLIO_PERIODS as PERIODS, PORTFOLIO_SCENARIOS as SCENARIOS,
  CANDIDATES, POLICIES, UNGOVERNED_POLICIES, riskEvidenceGates, riskUtility, selectRiskPolicy,
  type CandidatePolicy, type RiskEvidence } from "./protocol.js";

const RULES = "reports/distribution-instrument-rules-2026-09-07.json";
const SOURCES = ["src/portfolio-v2/risk.ts", "src/portfolio-v2/kernel.ts", "src/portfolio-v2/replay.ts",
  "src/portfolio-v2/protocol.ts", "src/portfolio-v2/study-main.ts"];
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const jsonHash = (v: unknown) => hash(JSON.stringify(v));
const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
export async function riskSourceHashes() {
  return { ...await portfolioSourceHashes(),
    ...Object.fromEntries(await Promise.all(SOURCES.map(async p => [p, hash(await readFile(p))]))) };
}
interface DataSeal { directory: string; datasetSha256: string; manifestSha256: string }
async function dataSeals(older: string, recent: string): Promise<DataSeal[]> {
  return Promise.all([older, recent].map(async directory => ({ directory: resolve(directory),
    datasetSha256: hash(await readFile(join(directory, "dataset.json"))),
    manifestSha256: hash(await readFile(join(directory, "manifest.json"))) })));
}
interface Registration { protocol: typeof PROTOCOL; sourceHashes: Record<string, string>; dataSeals: DataSeal[]; createdAtUtc: string }
type Run = ReturnType<typeof ungovernedReplay>;
export function riskRunEvidence(run: Run, targetCount: number): RiskEvidence {
  const risk = (run as Run & { finalRiskState?: RiskGovernorState }).finalRiskState;
  return { ...portfolioRunEvidence(run, targetCount), maximumLiquidationDrawdownUsd: run.maximumLiquidationDrawdownUsd,
    maximumObservedDailyLiquidationLossUsd: run.allPathsKnown && risk ? risk.maximumObservedDailyLossUsd : null };
}
function compact(run: Run, targetCount: number) {
  const e = riskRunEvidence(run, targetCount);
  return { ...e, utility: riskUtility(e), filledAdjustments: run.fills.length, feesUsd: run.totalFeesUsd,
    fundingCostUsd: run.totalFundingCostUsd, turnoverUsd: run.totalTurnoverUsd,
    meanGrossExposureUsd: run.meanGrossExposureUsd, maximumGrossExposureUsd: run.maximumGrossExposureUsd,
    perAssetAccounting: run.perAsset, zeroVolumeNoFills: run.zeroVolumeNoFills,
    unknownCount: run.unknowns.length, unknownReasons: [...new Set(run.unknowns.map(u => u.reason))],
    indicativePartialNetPnlUsd: run.allPathsKnown ? null : run.indicativeNetPnlUsd,
    sourceInputs: run.inputReceipts };
}
export function expectedRiskArtifacts(stage: PortfolioStage) {
  return POLICIES.flatMap(policy => [`${stage}-${policy}-targets.json`,
    ...SCENARIOS.map(s => `${stage}-governed-${policy}-${s.id}.json`),
    ...(UNGOVERNED_POLICIES.includes(policy as CandidatePolicy)
      ? SCENARIOS.map(s => `${stage}-ungoverned-${policy}-${s.id}.json`) : [])]).sort();
}
interface SummaryReceipt {
  stage: PortfolioStage; passed: boolean; period: object; protocolSha256: string; sourceHashes: object;
  dataSeals: object; artifacts: Record<string, string>; selectionSha256: string; selectedPolicy: CandidatePolicy | null;
}
async function verifyPrior(stage: PortfolioStage, output: string): Promise<SummaryReceipt> {
  let prior: SummaryReceipt;
  try { prior = await read(join(output, `${stage}-summary.json`)); }
  catch { throw new Error(`RISK_STAGE_DENIED_${stage.toUpperCase()}_MISSING`); }
  if (prior.passed !== true) throw new Error(`RISK_STAGE_DENIED_${stage.toUpperCase()}_FAILED`);
  const registration = await read(join(output, "protocol.json")) as Registration;
  const protocolSha256 = hash(await readFile(join(output, "protocol.json")));
  if (prior.stage !== stage || jsonHash(prior.period) !== jsonHash(PERIODS[stage])
    || prior.protocolSha256 !== protocolSha256 || jsonHash(registration.protocol) !== jsonHash(PROTOCOL)
    || jsonHash(prior.sourceHashes) !== jsonHash(registration.sourceHashes)
    || jsonHash(prior.dataSeals) !== jsonHash(registration.dataSeals)) throw new Error("RISK_STAGE_REGISTRATION_MISMATCH");
  if (!prior.artifacts || jsonHash(Object.keys(prior.artifacts).sort()) !== jsonHash(expectedRiskArtifacts(stage)))
    throw new Error("RISK_STAGE_ARTIFACT_SET");
  for (const [name, digest] of Object.entries(prior.artifacts)) {
    if (!/^[a-z0-9.-]+\.json$/.test(name) || hash(await readFile(join(output, name))) !== digest)
      throw new Error("RISK_STAGE_ARTIFACT_CHANGED");
  }
  const integrity = await read(join(output, `${stage}-integrity.json`));
  if (integrity.summarySha256 !== hash(await readFile(join(output, `${stage}-summary.json`)))
    || integrity.stage !== stage || integrity.protocolSha256 !== protocolSha256
    || jsonHash(integrity.sourceHashes) !== jsonHash(registration.sourceHashes)
    || jsonHash(integrity.dataSeals) !== jsonHash(registration.dataSeals)
    || jsonHash(integrity.artifacts) !== jsonHash(prior.artifacts)
    || integrity.selectionSha256 !== prior.selectionSha256) throw new Error("RISK_STAGE_SUMMARY_CHANGED");
  const selection = await read(join(output, "selection.json"));
  if (hash(await readFile(join(output, "selection.json"))) !== prior.selectionSha256
    || selection.protocolSha256 !== protocolSha256 || selection.stage !== "develop"
    || !CANDIDATES.includes(selection.selected) || selection.selected !== prior.selectedPolicy
    || jsonHash(selection.sourceHashes) !== jsonHash(registration.sourceHashes)
    || jsonHash(selection.dataSeals) !== jsonHash(registration.dataSeals)) throw new Error("RISK_STAGE_SELECTION_CHANGED");
  return prior;
}
/** Deny a failed/missing stage before opening any price or funding datasets. */
export async function assertRiskStageAllowed(stage: PortfolioStage, output: string): Promise<CandidatePolicy | null> {
  if (!Object.hasOwn(PERIODS, stage)) throw new Error("RISK_UNKNOWN_STAGE");
  if (stage === "develop") return null;
  const previous = await verifyPrior(stage === "confirm" ? "develop" : "confirm", output);
  if (stage === "test") {
    const development = await verifyPrior("develop", output);
    if (development.selectionSha256 !== previous.selectionSha256 || development.selectedPolicy !== previous.selectedPolicy)
      throw new Error("RISK_STAGE_RESELECTION_DENIED");
  }
  return previous.selectedPolicy;
}

export async function runRiskStudy(stage: "register" | PortfolioStage, older: string, recent: string, output: string) {
  if (stage !== "register" && !Object.hasOwn(PERIODS, stage)) throw new Error("RISK_UNKNOWN_STAGE");
  if (stage === "register") {
    await mkdir(output, { recursive: true });
    if ((await readdir(output)).some(n => n !== ".gitignore")) throw new Error("RISK_REGISTRATION_REQUIRES_EMPTY_DIRECTORY");
    const registration: Registration = { protocol: PROTOCOL, sourceHashes: await riskSourceHashes(),
      dataSeals: await dataSeals(older, recent), createdAtUtc: new Date().toISOString() };
    await save(join(output, "protocol.json"), registration);
    return { status: "REGISTERED_BEFORE_RETURNS", output };
  }
  let selectedPolicy = await assertRiskStageAllowed(stage, output);
  const registration = await read(join(output, "protocol.json")) as Registration;
  const protocolSha256 = hash(await readFile(join(output, "protocol.json")));
  if (jsonHash(registration.protocol) !== jsonHash(PROTOCOL)) throw new Error("RISK_PROTOCOL_CHANGED");
  if (jsonHash(registration.sourceHashes) !== jsonHash(await riskSourceHashes())) throw new Error("RISK_SOURCE_CHANGED");
  if (jsonHash(registration.dataSeals) !== jsonHash(await dataSeals(older, recent))) throw new Error("RISK_DATA_CHANGED");
  const frozenSelectionSha256 = stage === "develop" ? null : hash(await readFile(join(output, "selection.json")));
  await save(join(output, `${stage}-start.json`), { stage, startedAtUtc: new Date().toISOString(), protocolSha256,
    sourceHashes: registration.sourceHashes, frozenPolicy: selectedPolicy,
    selectionSha256: frozenSelectionSha256 });
  const datasets = await Promise.all([loadHourlyDataset(older), loadHourlyDataset(recent)]);
  const period = PERIODS[stage];
  const bars = mergeHourlyBars(datasets.flatMap(d => d.bars).filter(b => b.openMs >= period.startMs - 370 * DAY
    && b.openMs < period.endMs), period.startMs - 370 * DAY, period.endMs, Date.now());
  const map = new Map<string, FundingRow>();
  for (const row of datasets.flatMap(d => d.funding)) {
    if (row.timestampMs < period.startMs || row.timestampMs > period.endMs + HOUR) continue;
    const key = `${row.symbol}:${row.timestampMs}`, old = map.get(key);
    if (old && (old.rate !== row.rate || old.absoluteRate !== row.absoluteRate)) throw new Error("RISK_FUNDING_CONFLICT");
    map.set(key, row);
  }
  const funding = [...map.values()].sort((a, b) => a.timestampMs - b.timestampMs || a.symbol.localeCompare(b.symbol));
  const rules = await read(RULES) as Pair<AssetRules>;
  const runs = new Map<string, Run>(), targetCounts = new Map<PortfolioPolicy, number>();
  const summaries: Array<{ policy: PortfolioPolicy; variant: string; scenario: string; result: ReturnType<typeof compact> }> = [];
  const artifacts: Record<string, string> = {};
  for (const policy of POLICIES) {
    const targets = buildPortfolioTargets(bars, period.startMs, period.endMs, policy);
    targetCounts.set(policy, targets.length);
    const targetFile = `${stage}-${policy}-targets.json`;
    await save(join(output, targetFile), { policy, targets }); artifacts[targetFile] = hash(await readFile(join(output, targetFile)));
    const variants = UNGOVERNED_POLICIES.includes(policy as CandidatePolicy) ? ["governed", "ungoverned"] : ["governed"];
    for (const variant of variants) for (const scenario of SCENARIOS) {
      const input = { bars, funding, targets, rules, ...period, scenario };
      const run = variant === "governed" ? simulatePortfolioReplay(input) : ungovernedReplay(input);
      const file = `${stage}-${variant}-${policy}-${scenario.id}.json`;
      await save(join(output, file), run); artifacts[file] = hash(await readFile(join(output, file)));
      runs.set(`${variant}:${policy}:${scenario.id}`, run);
      summaries.push({ policy, variant, scenario: scenario.id, result: compact(run, targets.length) });
      process.stdout.write(JSON.stringify({ type: "risk-scenario-complete", stage, policy, variant,
        scenario: scenario.id, known: run.allPathsKnown, netPnlUsd: run.netPnlUsd, filledAdjustments: run.fills.length }) + "\n");
    }
  }
  const candidateEvidence = CANDIDATES.flatMap(policy => SCENARIOS.map(s => ({ policy, scenario: s.id,
    evidence: riskRunEvidence(runs.get(`governed:${policy}:${s.id}`)!, targetCounts.get(policy)!) })));
  const selection = stage === "develop" ? selectRiskPolicy(candidateEvidence) : null;
  if (selection) {
    selectedPolicy = selection.selected;
    await save(join(output, "selection.json"), { ...selection, stage, selectedAtUtc: new Date().toISOString(),
      protocolSha256, sourceHashes: registration.sourceHashes, dataSeals: registration.dataSeals, developmentArtifacts: artifacts });
  }
  const selectionSha256 = hash(await readFile(join(output, "selection.json")));
  if (frozenSelectionSha256 !== null && selectionSha256 !== frozenSelectionSha256)
    throw new Error("RISK_SELECTION_CHANGED_DURING_RUN");
  const comparisons = selectedPolicy === null ? [] : SCENARIOS.map(scenario => {
    const run = runs.get(`governed:${selectedPolicy}:${scenario.id}`)!;
    const simple = runs.get(`governed:sign-trend-90d:${scenario.id}`)!;
    const e = riskRunEvidence(run, targetCounts.get(selectedPolicy!)!), u = riskUtility(e);
    const simpleUtility = riskUtility(riskRunEvidence(simple, targetCounts.get("sign-trend-90d")!));
    const gates = { ...riskEvidenceGates(e), comparisonSatisfied: selectedPolicy === "sign-trend-90d"
      || u !== null && simpleUtility !== null && u > simpleUtility };
    const daily = (r: Run) => r.daily.map(d => ({ date: d.date, netPnlUsd: d.netPnlUsd! }));
    const intervals = run.allPathsKnown && simple.allPathsKnown ? {
      versusFlat: pairedWeeklyPnlInterval(daily(run), daily(run).map(d => ({ ...d, netPnlUsd: 0 }))),
      versusGovernedSimple: selectedPolicy === "sign-trend-90d" ? null : pairedWeeklyPnlInterval(daily(run), daily(simple)),
    } : null;
    return { scenario: scenario.id, gates, intervals };
  });
  const economicGatesPassed = selectedPolicy !== null && comparisons.length === SCENARIOS.length
    && comparisons.every(c => Object.values(c.gates).every(Boolean));
  const confidencePassed = economicGatesPassed && comparisons.every(c => c.intervals !== null
    && (c.intervals.versusFlat.lower95DailyUsd ?? -Infinity) > 0
    && (selectedPolicy === "sign-trend-90d" || (c.intervals.versusGovernedSimple?.lower95DailyUsd ?? -Infinity) > 0));
  const passed = economicGatesPassed && (stage !== "test" || confidencePassed);
  if (protocolSha256 !== hash(await readFile(join(output, "protocol.json")))
    || selectionSha256 !== hash(await readFile(join(output, "selection.json")))
    || jsonHash(registration.sourceHashes) !== jsonHash(await riskSourceHashes())
    || jsonHash(registration.dataSeals) !== jsonHash(await dataSeals(older, recent))) throw new Error("RISK_INPUT_CHANGED_DURING_RUN");
  const summary = { version: PROTOCOL.version, stage, period, completedAtUtc: new Date().toISOString(),
    protocolSha256, sourceHashes: registration.sourceHashes, dataSeals: registration.dataSeals,
    artifacts, selectionSha256, selectedPolicy, selection, summaries, comparisons, economicGatesPassed, confidencePassed,
    passed, status: passed ? "STAGE_PASSED" : "STAGE_FAILED", finalTestOpened: stage === "test",
    productionModelChanged: false, candidateActivated: false, profitabilityEstablished: false,
    incrementalAlphaEstablished: false, hourlyScenarioEvidencePassed: stage === "test" && passed,
    limitations: PROTOCOL.limitations };
  await save(join(output, `${stage}-summary.json`), summary);
  await save(join(output, `${stage}-integrity.json`), { stage, verifiedAtUtc: new Date().toISOString(), protocolSha256,
    summarySha256: hash(await readFile(join(output, `${stage}-summary.json`))), sourceHashes: registration.sourceHashes,
    dataSeals: registration.dataSeals, artifacts, selectionSha256 });
  return { status: summary.status, stage, passed, confidencePassed, selectedPolicy, output };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [stage, older, recent, output] = process.argv.slice(2);
  if (!stage || !older || !recent || !output) throw new Error("Usage: portfolio-v2/study-main register|develop|confirm|test older-dataset recent-dataset output-directory");
  process.stdout.write(JSON.stringify(await runRiskStudy(stage as "register" | PortfolioStage, older, recent, output), null, 2) + "\n");
}
