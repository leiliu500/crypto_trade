import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSpotWeeks } from "./data.js";
import { bootstrapSpotWeeks, replaySpotTrend, type SpotReplay } from "./replay.js";
import { SPOT_TREND_SPEC as S, SPOT_TREND_STUDY as D } from "./spec.js";

export const SPOT_STUDY_SOURCES = ["src/spot-trend/spec.ts", "src/spot-trend/data.ts", "src/spot-trend/account.ts",
  "src/spot-trend/signal.ts", "src/spot-trend/replay.ts", "src/spot-trend/study-main.ts", "package-lock.json", "tsconfig.json"];
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const save = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

export async function runSpotStudy(dataRoot: string, output: string) {
  const sources = await Promise.all(SPOT_STUDY_SOURCES.map(async path => ({ path, bytes: await readFile(path) })));
  const sourceHashes = Object.fromEntries(sources.map(s => [s.path, sha(s.bytes)]));
  const manifestBytes = await readFile(join(dataRoot, "manifest.json")), datasetBytes = await readFile(join(dataRoot, "dataset.json"));
  await mkdir(output, { recursive: false });
  await save(join(output, "protocol.json"), { sealedAtUtc: new Date().toISOString(), strategy: S, study: D,
    sourceHashes, inputDirectory: resolve(dataRoot), inputManifestSha256: sha(manifestBytes), datasetSha256: sha(datasetBytes),
    historicalStrategyOutcomesComputedBeforeSeal: false, independentHoldoutClaimed: false,
    recentHistoryPreviouslyUsedByOtherCandidates: true, parameterGrid: false,
    primary: "ONE_CONTINUOUS_2017_TO_2026_RUN_PER_SCENARIO;RESET_SUBPERIODS_ARE_DIAGNOSTICS_NOT_POOLED_TRADE_EVIDENCE" });
  for (const source of sources) {
    const file = join(output, "sources", source.path); await mkdir(dirname(file), { recursive: true });
    await writeFile(file, source.bytes, { flag: "wx" });
  }
  const data = await loadSpotWeeks(dataRoot);
  if (data.bars[0]!.openMs > D.startMs - (S.movingAverageWeeks + 2) * 7 * 86_400_000
    || data.bars.at(-1)!.endMs < D.endMsExclusive) throw new Error("SPOT_STUDY_INCOMPLETE_HISTORY_SCOPE");
  const windows = [{ id: "full", startMs: D.startMs, endMs: D.endMsExclusive }, ...D.periods];
  const runs: Array<{ window: string; file: string; result: SpotReplay }> = [];
  for (const window of windows) for (const scenario of ["base", "stress"] as const) for (const policy of D.policies) {
    const result = replaySpotTrend({ bars: data.bars, startMs: window.startMs, endMs: window.endMs, policy, scenario });
    const file = `${window.id}-${scenario}-${policy}.json`;
    await save(join(output, file), result); runs.push({ window: window.id, file, result });
    if (window.id === "full" && policy !== "cash") process.stdout.write(JSON.stringify({ window: window.id, scenario, policy,
      netPnlUsd: result.netPnlUsd, closedEpisodes: result.closedEpisodes, feesUsd: result.feesUsd,
      maxWeeklyCloseDrawdownUsd: result.maxWeeklyCloseDrawdownUsd, terminalFlat: result.terminalFlat }) + "\n");
  }
  const primary = runs.filter(r => r.window === "full" && r.result.policy === "trend").map(r => r.result);
  const stressTrend = primary.find(r => r.scenario === "stress")!;
  const stressHold = runs.find(r => r.window === "full" && r.result.policy === "buy-hold" && r.result.scenario === "stress")!.result;
  const baseTrend = primary.find(r => r.scenario === "base")!;
  const bootstrap = bootstrapSpotWeeks(baseTrend.weekly.map(w => w.weeklyNetUsd), D.bootstrap.blockWeeks,
    D.bootstrap.repetitions, D.bootstrap.seed, D.bootstrap.lowerQuantile);
  const checks = {
    allRunsTerminalFlat: runs.every(r => r.result.terminalFlat),
    bothPrimaryScenariosPositive: primary.every(r => r.netPnlUsd > 0),
    enoughEpisodesInEachScenario: primary.every(r => r.closedEpisodes >= D.minimumClosedEpisodes),
    lessStressDollarDrawdownThanBuyHold: stressTrend.maxWeeklyCloseDrawdownUsd < stressHold.maxWeeklyCloseDrawdownUsd,
    noAccountDrawdownHalt: primary.every(r => !r.accountDrawdownHalted),
    netExceedsAllocatedCapitalHurdleBothScenarios: primary.every(r => r.netAboveAllocatedCapitalHurdleUsd > 0),
  };
  for (const source of sources) if (sha(await readFile(source.path)) !== sourceHashes[source.path])
    throw new Error(`SPOT_RESEARCH_SOURCE_CHANGED:${source.path}`);
  const report = { generatedAtUtc: new Date().toISOString(), strategyVersion: S.version,
    sourceHashes, sourceDataSha256: data.sourceSha256, datasetSha256: sha(datasetBytes), coverage: data.coverage,
    researchPaperEligible: Object.values(checks).every(Boolean), checks, bootstrap,
    lowerBootstrapMeanPositive: bootstrap.lowerMeanWeeklyNetUsd !== null && bootstrap.lowerMeanWeeklyNetUsd > 0,
    provenProfitable: false, independentValidationPassed: false, existingFuturesEngineChanged: false,
    liveTradingAllowed: false, runtimeActivated: false,
    runs: runs.map(({ window, file, result: { orders: _o, weekly: _w, ...result } }) => ({ window, file, ...result })),
    limitations: [
      "This is one newly frozen hypothesis after many prior failures, not an untouched holdout or proof of future profit.",
      "The 1.66% moving-average band reduces turnover; distance from a moving average is not expected return or a guaranteed break-even margin.",
      "Weekly opening fills are adverse-price proxies. Positive completed weekly volume does not prove liquidity at the opening timestamp.",
      "Base execution waits for the first weekly open strictly after assumed one-minute signal finalization; stress waits one additional week. Forward quotes have different timing and require prospective verification.",
      "Fees are current entry-tier assumptions applied uniformly to all years, with no assumed discount from simulated equity. Historical account fees and historical venue minimum rules are not independently verified.",
      "Idle cash earns zero. The five-percent comparison is an opportunity-cost hurdle on the full-window initial $100 allocation, not interest credited to cash.",
      "Entire entry cash is at risk. Gains can increase marked inventory. Scheduled limits and drawdown checks can be exceeded between observations.",
      "Reported drawdown uses weekly liquidation closes; sampled-peak-to-weekly-low is a diagnostic and not a bound on full intraperiod peak-to-trough loss.",
      "Costed buy-and-hold begins at the first available opening and uses fixed units without the candidate's later cap reductions. Equal initial capital does not make exposures or risk identical.",
      "A positive historical screen nominates only a separate research paper experiment. It does not activate live trading or establish validated profit.",
    ] };
  await save(join(output, "report.json"), report);
  const money = (v: number) => `$${v.toFixed(2)}`;
  await writeFile(join(output, "report.md"), [
    `The new cash-funded BTC spot system ${report.researchPaperEligible ? "passed" : "failed"} its frozen historical economic screen for a separate research paper experiment. Profitability remains unvalidated.`, "",
    "| Window | Costs | Policy | Net after fees | Closed episodes | Fees | Weekly-close drawdown |",
    "|---|---|---|---:|---:|---:|---:|",
    ...report.runs.filter(r => r.policy !== "cash").map(r => `| ${r.window} | ${r.scenario} | ${r.policy} | ${money(r.netPnlUsd)} | ${r.closedEpisodes} | ${money(r.feesUsd)} | ${money(r.maxWeeklyCloseDrawdownUsd)} |`), "",
    `Starting paper cash: $100,000. Initial purchase budget including fees: $100. The full-window 5% annual opportunity-cost hurdle on that budget is ${money(baseTrend.fivePercentInitialBudgetHurdleUsd)}.`, "",
    `Thirteen-week moving-block bootstrap lower 5% mean weekly net: ${bootstrap.lowerMeanWeeklyNetUsd === null ? "unknown" : money(bootstrap.lowerMeanWeeklyNetUsd)} across ${bootstrap.completeWeeks} calendar weeks. This is dependent historical evidence, not independent validation.`, "",
    "The cash benchmark earned $0. Every trade, cash balance, inventory mark, source hash and failed check is retained in the JSON files. Reset subperiods are diagnostics; they are not counted again in the full-run episode sample.", "",
    ...report.limitations.map(l => `- ${l}`), "",
    "Cost source: [Kraken fee schedule](https://www.kraken.com/features/fee-schedule). Market source: [Kraken OHLC API](https://docs.kraken.com/api-reference/market-data/get-ohlc-data).", "",
  ].join("\n"), { flag: "wx" });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error("Usage: npx tsx src/spot-trend/study-main.ts DATA_DIRECTORY NEW_OUTPUT_DIRECTORY");
  await runSpotStudy(process.argv[2]!, process.argv[3]!);
}
