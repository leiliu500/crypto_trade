import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHourlyDataset, type HourlyBar, type FundingRow } from "../research/hourly-data.js";
import { loadSpotHistoryDataset } from "../research/spot-history-data.js";
import { HORIZON_CARRY_SPEC as S, HORIZON_CARRY_SPEC_SHA256 } from "./horizon-spec.js";
import { replayHorizonCarry } from "./horizon-replay.js";

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const sources = ["src/carry/horizon-spec.ts", "src/carry/horizon-signal.ts", "src/carry/horizon-replay.ts",
  "src/carry/horizon-study-main.ts", "src/carry/inventory.ts", "src/research/hourly-data.ts", "src/research/spot-history-data.ts"];

export async function runHorizonCarryStudy(out: string, spotDirectory: string, futuresDirectories: string[]) {
  const [spot, ...datasets] = await Promise.all([loadSpotHistoryDataset(spotDirectory),
    ...futuresDirectories.map(loadHourlyDataset)] as const);
  const bars = new Map<number, HourlyBar>(), funding = new Map<number, FundingRow>();
  const end = S.windows.at(-1)!.endMs, earliest = S.windows[0]!.startMs - 91 * S.dayMs;
  for (const data of datasets) {
    for (const row of data.bars) {
      if (row.symbol !== S.symbol || row.openMs < earliest || row.openMs >= end) continue;
      const prior = bars.get(row.openMs);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error("CARRY_CONFLICTING_BAR");
      bars.set(row.openMs, row);
    }
    for (const row of data.funding) {
      if (row.symbol !== S.symbol || row.timestampMs < earliest || row.timestampMs > end) continue;
      const prior = funding.get(row.timestampMs);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error("CARRY_CONFLICTING_FUNDING");
      funding.set(row.timestampMs, row);
    }
  }
  const input = { spotBars: spot.bars.filter(row => row.symbol === S.symbol && row.intervalMinutes === S.spotIntervalMinutes),
    futureBars: [...bars.values()].sort((a, b) => a.openMs - b.openMs),
    funding: [...funding.values()].sort((a, b) => a.timestampMs - b.timestampMs) };
  const sourceBytes = await Promise.all(sources.map(async path => ({ path, bytes: await readFile(path) })));
  const sourceHashes = Object.fromEntries(sourceBytes.map(row => [row.path, digest(row.bytes)]));
  const dataSources = await Promise.all([spotDirectory, ...futuresDirectories].map(async path => ({ path,
    datasetSha256: digest(await readFile(join(path, "dataset.json"))), manifestSha256: digest(await readFile(join(path, "manifest.json"))) })));
  await mkdir(out, { recursive: true });
  // Registration precedes the first strategy decision or return calculation.
  await save(join(out, "implementation-registration.json"), { registeredAt: new Date().toISOString(),
    specification: S, specificationSha256: HORIZON_CARRY_SPEC_SHA256, sourceHashes,
    admittedDataSha256: digest(JSON.stringify(input)), dataSources, reserved2026Evaluated: false });
  for (const row of sourceBytes) {
    const target = join(out, "sources", row.path); await mkdir(dirname(target), { recursive: true });
    await writeFile(target, row.bytes, { flag: "wx" });
  }
  const runs = [];
  for (const window of S.windows) for (const scenario of ["base", "stress"] as const)
    for (const fundingEndShiftHours of S.fundingEndShiftHours) {
      const run = replayHorizonCarry({ ...input, ...window, scenario, fundingEndShiftHours });
      const name = `${window.id}-${scenario}-funding-${fundingEndShiftHours}`;
      await save(join(out, `${name}.json`), run); runs.push(run);
      console.log(JSON.stringify({ name, cycles: run.completedCycles, netCashPnlUsd: run.netCashPnlUsd,
        capitalBenchmarkExcessUsd: run.capitalBenchmarkExcessUsd, decisions: run.decisions.length,
        projectedEntryCandidates: run.decisions.filter(d => d.signal.entryAllowed).length }));
    }
  for (const source of sourceBytes) if (digest(await readFile(source.path)) !== sourceHashes[source.path])
    throw new Error(`CARRY_SOURCE_CHANGED_DURING_STUDY:${source.path}`);
  const numericEconomicScreenPassed = runs.every(run => run.completedCycles > 0 && run.netCashPnlUsd !== null
    && run.netCashPnlUsd > 0 && run.capitalBenchmarkExcessUsd !== null && run.capitalBenchmarkExcessUsd > 0
    && run.missingHeldFundingHours === 0 && run.missingHeldPriceHours === 0 && run.collateralGuardBreaches === 0);
  const report = { generatedAt: new Date().toISOString(), specificationSha256: HORIZON_CARRY_SPEC_SHA256,
    numericEconomicScreenPassed, economicCandidateEligible: false, runtimeActivationAllowed: false,
    futureProfitGuaranteed: false, reserved2026Evaluated: false,
    executionEvidence: S.evidenceKind,
    limitations: ["NO_AUTHENTICATED_ACCOUNT_FEES_OR_HISTORICAL_MARGIN_RULES", "NO_SYNCHRONIZED_PAIRED_FILL_EVIDENCE",
      "INDEPENDENT_EXTREMA_ARE_BOUNDS_NOT_OBSERVED_EQUITY_DRAWDOWN", "REUSED_DEVELOPMENT_PERIODS_WITH_PRIOR_FAILED_HYPOTHESES",
      "5_PERCENT_CAPITAL_BENCHMARK_IS_NOT_ACTUAL_CASH_INTEREST", "TERMINAL_WEEKLY_FLATTEN_CAN_TRUNCATE_180_DAY_HORIZON"],
    runs: runs.map(({ decisions: _decisions, cycles: _cycles, ...run }) => run) };
  await save(join(out, "report.json"), report);
  await writeFile(join(out, "report.md"), [
    "Long-horizon matched BTC spot/perpetual carry economic screen. Runtime activation remains disabled.", "",
    "| Period | Cost scenario | Funding shift (hours) | Cycles | Net cash after fees/funding | Excess over capital benchmark |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...runs.map(r => `| ${r.id} | ${r.scenario} | ${r.fundingEndShiftHours} | ${r.completedCycles} | ${r.netCashPnlUsd?.toFixed(2) ?? "unknown"} | ${r.capitalBenchmarkExcessUsd?.toFixed(2) ?? "unknown"} |`), "",
    `Numeric economic screen: ${numericEconomicScreenPassed ? "passed" : "failed"}. Independent weekly trade aggregates cannot establish executable basis returns or validate a trading deployment.`, "",
    "All entry decisions, funding coverage, matched receipts, wallet balances, terminal truncation, and conservative collateral marks are retained in the per-run files. Cash profit and the 5% annual capital hurdle are separate. The cash benchmark is not an expense charged to the simulated account.", "",
  ].join("\n"), { flag: "wx" });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) throw new Error("CARRY_NEW_OUTPUT_DIRECTORY_REQUIRED");
  runHorizonCarryStudy(out, "reports/carry-horizon-audit-2026-09-09/spot-history", [
    "reports/hourly-adaptive-study-2026-09-08/data-older-restored", "reports/hourly-adaptive-study-2026-09-08/data-recent",
  ]).catch(error => { console.error(error); process.exitCode = 1; });
}
