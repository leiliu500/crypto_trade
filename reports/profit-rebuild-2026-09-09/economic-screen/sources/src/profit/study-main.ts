import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHourlyDataset } from "../research/hourly-data.js";
import { PROFIT_SPEC } from "./spec.js";
import { replayProfit, PROFIT_REPLAY_ASSUMPTIONS } from "./replay.js";
import { PROFIT_STUDY_DESIGN as D, prepareProfitStudyData, prepareProfitStudyForecasts } from "./study.js";
import { PROFIT_VALIDATION_SPEC, validateProfitStudy } from "./validation.js";

const SOURCES = ["src/profit/spec.ts", "src/profit/model.ts", "src/profit/replay.ts", "src/profit/study.ts",
  "src/profit/study-main.ts", "src/profit/validation.ts", "src/risk/risk-state.ts", "src/research/hourly-data.ts",
  "package.json", "package-lock.json"];
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });

export async function runProfitStudy(dataDirectories: readonly string[], outputDirectory: string) {
  const out = resolve(outputDirectory);
  const datasets = await Promise.all(dataDirectories.map(loadHourlyDataset));
  const data = prepareProfitStudyData(datasets);
  const dataSources = await Promise.all(dataDirectories.map(async directory => ({ directory: resolve(directory),
    datasetSha256: sha(await readFile(join(directory, "dataset.json"))),
    manifestSha256: sha(await readFile(join(directory, "manifest.json"))) })));
  const sources = await Promise.all(SOURCES.map(async path => ({ path, bytes: await readFile(path) })));
  const sourceHashes = Object.fromEntries(sources.map(source => [source.path, sha(source.bytes)]));
  const sourceSha256 = sha(JSON.stringify(sourceHashes));
  const registeredAtMs = Date.now();
  const protocol = { registeredAtMs, registeredAt: new Date(registeredAtMs).toISOString(),
    strategy: PROFIT_SPEC, study: D, validation: PROFIT_VALIDATION_SPEC, executionAssumptions: PROFIT_REPLAY_ASSUMPTIONS,
    sourceHashes, sourceSha256, dataSha256: data.dataSha256, dataSources,
    interpretation: "SEALED_BEFORE_THIS_MODEL_FIT_AND_REPLAY; REUSED_HISTORICAL_PERIODS; NO_FUTURE_PROFIT_GUARANTEE" };
  await mkdir(out, { recursive: true });
  // Existing studies cannot be overwritten. No fitting/forecasting/replay has
  // occurred yet; reserve exclusion and integrity checks are read-only.
  await save(join(out, "protocol.json"), protocol);
  for (const source of sources) {
    const target = join(out, "sources", source.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source.bytes, { flag: "wx", mode: 0o600 });
  }
  const prepared = prepareProfitStudyForecasts(data.bars);
  await save(join(out, "models.json"), { fits: prepared.fits, fitSha256: prepared.fitSha256 });
  await save(join(out, "forecasts.json"), { forecasts: prepared.forecasts, forecastSha256: prepared.forecastSha256,
    unavailable: prepared.unavailable });
  const runs: ReturnType<typeof replayProfit>[] = [], benchmarks: ReturnType<typeof replayProfit>[] = [];
  for (const window of D.windows) for (const scenario of D.scenarios) for (const fundingAssumption of D.fundingAssumptions) {
    for (const policy of ["weekly-forecast", ...D.benchmarkPolicies] as const) {
      const run = replayProfit({ ...data, forecasts: prepared.forecasts, startMs: window.startMs, endMs: window.endMs,
        scenario, fundingAssumption, policy });
      (policy === "weekly-forecast" ? runs : benchmarks).push(run);
      await save(join(out, `${window.id}-${scenario}-${fundingAssumption}-${policy}.json`), run);
      console.log(JSON.stringify({ period: window.id, policy, scenario, fundingAssumption,
        inventoryEpisodes: run.completedTrades, orders: run.orderCount, netPnlUsd: run.netPnlUsd,
        maxDrawdownUsd: run.maxDrawdownUsd, feesUsd: run.feeUsd, fundingUsd: run.fundingCashUsd,
        accountingKnown: run.accountingKnown }));
    }
  }
  const validation = validateProfitStudy({ runs, benchmarks });
  // A concurrent source edit invalidates this attempt; preserve it and require
  // a new output directory after the correction, never mutate its protocol.
  for (const source of sources) if (sha(await readFile(source.path)) !== sourceHashes[source.path])
    throw new Error(`PROFIT_STUDY_SOURCE_CHANGED:${source.path}`);
  const summarize = (run: ReturnType<typeof replayProfit>) => {
    const { orders: _orders, trades: _trades, dailyNetPnlUsd: _daily, limitations: _limitations, ...summary } = run;
    return summary;
  };
  const report = { generatedAt: new Date().toISOString(), sourceSha256, dataSha256: data.dataSha256,
    strategyVersion: PROFIT_SPEC.version, validation, modelCount: prepared.fits.length,
    forecastCount: prepared.forecasts.length, unavailable: prepared.unavailable,
    runs: runs.map(summarize), benchmarks: benchmarks.map(summarize),
    reservedDataEvaluated: false, executionEvidence: "HOURLY_CANDLE_PROXY_NOT_OBSERVED_FILLS",
    runtimeActivated: false, guaranteedProfitable: false };
  await save(join(out, "report.json"), report);
  const dollars = (v: number | null) => v === null ? "unknown" : `$${v.toFixed(2)}`;
  await writeFile(join(out, "report.md"), [
    `Weekly inventory candidate ${PROFIT_SPEC.version}: historical economic results. No future profitability is guaranteed.`, "",
    "| Period | Costs | Funding interpretation | Episodes | Orders | Net after fees and funding | Drawdown |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
    ...runs.map(run => `| ${new Date(run.startMs).toISOString().slice(0, 10)}–${new Date(run.endMs).toISOString().slice(0, 10)} | ${run.scenario} | ${run.fundingAssumption} | ${run.completedTrades} | ${run.orderCount} | ${dollars(run.netPnlUsd)} | ${dollars(run.maxDrawdownUsd)} |`), "",
    "Full validation decisions and benchmark comparisons are in report.json. Individual runs retain every order, inventory episode, full calendar daily P&L, funding coverage and blocked decision.", "",
    "Both evaluated periods have been inspected in earlier studies. They are reused development and confirmation data, not fresh holdouts. January–July 2026 remains excluded. Parameters and source copies were sealed before model fitting and replay, and no parameter grid was searched.", "",
    "The comparator is the mean of independently constrained BTC-long and ETH-long paths. These use the same stop, sizing and risk controls and are risk-managed benchmarks, not passive buy-and-hold or a simultaneously executable two-position portfolio.", "",
    "The study uses hourly candles and assumed execution. It cannot prove available order-book depth, fills, slippage, intrabar chronology or actual funding settlement timing. A positive historical screen can support a bounded paper trial; it cannot establish live profitability.", "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
  return report;
}

async function main() {
  const args = process.argv.slice(2), dataDirectories: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help") {
      console.log("Usage: npm run research:profit -- --out-dir NEW_DIRECTORY [--data-dir DIRECTORY ...]\nUses frozen 2024 and 2025 H1 windows; keeps reserved 2026 data excluded. Never overwrites an existing protocol."); return;
    }
    const key = args[i], value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("PROFIT_STUDY_ARGUMENT_VALUE_REQUIRED");
    if (key === "--out-dir") out = value;
    else if (key === "--data-dir") dataDirectories.push(value);
    else throw new Error(`PROFIT_STUDY_UNKNOWN_ARGUMENT:${key}`);
  }
  if (!out) throw new Error("PROFIT_STUDY_NEW_OUT_DIR_REQUIRED");
  const dirs = dataDirectories.length ? dataDirectories : [
    "reports/hourly-adaptive-study-2026-09-08/data-older-restored", "reports/hourly-adaptive-study-2026-09-08/data-recent"];
  const report = await runProfitStudy(dirs, out);
  console.log(JSON.stringify({ validation: report.validation, modelCount: report.modelCount, forecastCount: report.forecastCount }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
