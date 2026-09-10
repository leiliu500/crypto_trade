import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { loadHourlyDataset } from "../research/hourly-data.js";
import { SYSTEMATIC_SPEC } from "./spec.js";
import { prepareSystematicSignals, replaySystematic, SYSTEMATIC_REPLAY_ASSUMPTIONS as A,
  type ReplayScenario, type ReplayFundingAssumption } from "./replay.js";
import { evaluateSystematicValidation, SYSTEMATIC_VALIDATION_PROTOCOL as V,
  SYSTEMATIC_VALIDATION_PROTOCOL_SHA256, type SystematicValidationRun } from "./validation.js";

const SOURCE_FILES = ["src/systematic/spec.ts", "src/systematic/signal.ts", "src/systematic/history.ts",
  "src/systematic/planner.ts", "src/systematic/position.ts", "src/systematic/replay.ts", "src/systematic/replay-main.ts",
  "src/systematic/validation.ts", "src/risk/sizing.ts", "src/risk/risk-state.ts", "src/core/market.ts",
  "src/economics/net-liquidation.ts", "src/execution/book-walk.ts",
  "src/research/hourly-data.ts", "src/config.ts", "config/base.json", "config/btc_usd.json",
  "config/eth_usd.json", "package.json", "package-lock.json"];
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const jsonSha = (value: unknown) => sha(JSON.stringify(value));
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });

export async function runSystematicEconomicStudy(dataDirectory: string, outputDirectory: string) {
  const out = resolve(outputDirectory), cfg = loadConfig({ CONFIG_DIR: "config", TRADING_MODE: "paper" });
  // Read-only integrity verification may inspect dataset structure and byte
  // hashes. Reserved 2026 candles are excluded before any signal or P&L work.
  const dataset = await loadHourlyDataset(dataDirectory);
  const studyStart = V.developmentWindows[0]!.startMs, studyEnd = V.developmentWindows.at(-1)!.endMs;
  const bars = dataset.bars.filter(row => row.openMs >= studyStart - 200 * A.entryDelayHours * SYSTEMATIC_SPEC.barMs
    && row.openMs < studyEnd);
  const funding = dataset.funding.filter(row => row.timestampMs > studyStart && row.timestampMs <= studyEnd + SYSTEMATIC_SPEC.barMs);
  const dataSha256 = jsonSha({ bars, funding }), originalDataSha256 = sha(await readFile(join(dataDirectory, "dataset.json")));
  const sourceBytes = await Promise.all(SOURCE_FILES.map(async path => ({ path, bytes: await readFile(path) })));
  const sourceHashes = Object.fromEntries(sourceBytes.map(row => [row.path, sha(row.bytes)]));
  const strategySourceSha256 = jsonSha(sourceHashes);
  const configuration = { assumptions: A, effectiveSymbolConfigs: cfg.symbolConfigs,
    effectiveLimits: { maximumGrossNotional: cfg.portfolio.maximumGrossNotional, maximumClusterPositions: cfg.portfolio.maximumClusterPositions } };
  for (const symbol of ["BTC/USD", "ETH/USD"]) {
    const c = cfg.symbolConfigs[symbol]!;
    if (c.cost.takerFeeBps !== A.fees.base || c.cost.positiveCostErrorP95Bps !== A.positiveCostErrorP95Bps
      || c.sizing.baseRiskFraction !== A.baseRiskFraction || c.sizing.targetSigmaHBps !== A.targetAtrBps
      || c.sizing.maximumDrawdown !== A.maximumDrawdownFraction || c.maximumNotional !== A.maximumNotionalUsd)
      throw new Error(`SYSTEMATIC_REPLAY_CONFIG_MISMATCH:${symbol}`);
  }
  const strategyConfigSha256 = jsonSha(configuration), registeredAtMs = Date.now();
  await mkdir(out, { recursive: true });
  // wx is deliberate: a later study must use a new directory, preserving all
  // candidate rejections and preventing retrospective protocol replacement.
  await save(join(out, "protocol.json"), { registeredAtMs, registeredAt: new Date(registeredAtMs).toISOString(),
    strategy: SYSTEMATIC_SPEC, validation: V, assumptions: A,
    protocolSha256: SYSTEMATIC_VALIDATION_PROTOCOL_SHA256, strategySourceSha256, strategyConfigSha256,
    dataSha256, originalDataSha256, sourceHashes, dataDirectory: resolve(dataDirectory),
    evaluatedBars: { fromMs: bars[0]?.openMs, toMsExclusive: studyEnd },
    excludedReservedWindow: { fromMs: Date.UTC(2026, 0, 1), toMsExclusive: Date.UTC(2026, 7, 1), evaluated: false },
    interpretation: "FROZEN_BEFORE_THIS_REPLAY; PRIOR_STUDIES_ALREADY_INSPECTED_DEVELOPMENT_PERIODS",
  });
  await save(join(out, "configuration.json"), configuration);
  for (const source of sourceBytes) {
    const target = join(out, "sources", source.path); await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source.bytes, { flag: "wx", mode: 0o600 });
  }
  const runs: SystematicValidationRun[] = [], summaries: unknown[] = [], latencySensitivity: unknown[] = [];
  for (const window of V.developmentWindows) {
    const signals = prepareSystematicSignals(bars, window.startMs, window.endMs);
    for (const scenario of V.scenarios) for (const fundingAssumption of V.fundingSensitivities) {
      const result = replaySystematic({ bars, funding, startMs: window.startMs, endMs: window.endMs,
        scenario: scenario as ReplayScenario, fundingAssumption: fundingAssumption as ReplayFundingAssumption, signals });
      const run = { ...result, windowId: window.windowId, strategyVersion: SYSTEMATIC_SPEC.version,
        protocolSha256: SYSTEMATIC_VALIDATION_PROTOCOL_SHA256, strategySourceSha256, strategyConfigSha256, dataSha256 } as SystematicValidationRun;
      runs.push(run);
      const { trades: _trades, dailyNetPnlUsd: _daily, limitations: _limitations, ...summary } = result;
      summaries.push({ windowId: window.windowId, ...summary });
      await save(join(out, `${window.windowId}-${scenario}-${fundingAssumption}.json`), run);
      console.log(JSON.stringify({ windowId: window.windowId, scenario, fundingAssumption, trades: result.completedTrades,
        netPnlUsd: result.netPnlUsd, feeUsd: result.feeUsd, fundingCashUsd: result.fundingCashUsd,
        maxDrawdownUsd: result.maxDrawdownUsd, accountingKnown: result.accountingKnown }));
    }
    const expired = replaySystematic({ bars, funding, startMs: window.startMs, endMs: window.endMs,
      scenario: "stress", fundingAssumption: "source-plus-hour", delayHours: A.expirySensitivityDelayHours });
    if (expired.completedTrades !== 0) throw new Error("SYSTEMATIC_LATENCY_EXPIRY_INVARIANT");
    latencySensitivity.push({ windowId: window.windowId, delayHours: A.expirySensitivityDelayHours,
      completedTrades: expired.completedTrades, netPnlUsd: expired.netPnlUsd, blockReasons: expired.blockReasons,
      interpretation: "OPERATIONAL_EXPIRY_CHECK_NOT_A_PROFITABILITY_RUN" });
  }
  const asOfMs = Date.now(), validation = evaluateSystematicValidation({
    protocolSha256: SYSTEMATIC_VALIDATION_PROTOCOL_SHA256, strategySourceSha256, strategyConfigSha256,
    registeredAtMs, asOfMs, runs });
  // Confirm the executing source files remained fixed during the study.
  for (const source of sourceBytes) if (sha(await readFile(source.path)) !== sourceHashes[source.path])
    throw new Error(`SYSTEMATIC_SOURCE_CHANGED_DURING_REPLAY:${source.path}`);
  const report = { generatedAt: new Date(asOfMs).toISOString(), strategyVersion: SYSTEMATIC_SPEC.version,
    protocolSha256: SYSTEMATIC_VALIDATION_PROTOCOL_SHA256, strategySourceSha256, strategyConfigSha256, dataSha256,
    validation, runs: summaries, latencySensitivity, limitations: A.limitations,
    conclusion: validation.developmentPassed
      ? "DEVELOPMENT_SCREEN_PASSED; PROSPECTIVE_FUNDED_EXECUTION_EVIDENCE_REQUIRED; DO_NOT_ACTIVATE"
      : "REJECTED: DEVELOPMENT_ECONOMICS_DO_NOT_ESTABLISH_PROFITABILITY; DO_NOT_ACTIVATE",
  };
  await save(join(out, "report.json"), report);
  const dollars = (v: number | null) => v === null ? "unknown" : `$${v.toFixed(2)}`;
  const rows = runs.map(run => `| ${run.windowId} | ${run.scenario} | ${run.fundingAssumption} | ${run.completedTrades} | ${dollars(run.netPnlUsd)} | ${dollars(run.maxDrawdownUsd)} |`);
  await writeFile(join(out, "report.md"), [
    `The frozen ${SYSTEMATIC_SPEC.version} candidate ${validation.developmentPassed ? "passed" : "failed"} the repeated-development economic screen. Paper activation is ${validation.paperActivationAllowed ? "allowed" : "not allowed"}; no future-profit guarantee is made.`, "",
    "| Period | Costs | Funding convention | Trades | Net after fees and funding | Maximum drawdown |",
    "| --- | --- | --- | ---: | ---: | ---: |", ...rows, "",
    "Both periods were inspected in earlier studies. They are repeated development evidence, not untouched holdouts. The reserved January–July 2026 data was excluded from signal and P&L evaluation.", "",
    "The report includes complete calendar marked liquidation P&L, per-asset results, funding coverage, fixed-block uncertainty checks, all rejections, and a flat $0 benchmark. A two-hour signal delay expires under the unchanged freshness rule and produces no trades.", "",
    "This is hourly candle research. Depth, fills, the actual tick path and funding settlement convention are unverified; it cannot establish executable profit. Missing funding or unresolved inventory makes accounting unknown and fails validation.", "",
    `Validation failures: ${validation.reasons.join(", ")}.`, "",
    "Parameters, source copies, dataset identity and configuration hashes were saved before replay in protocol.json and sources/. No search or post-result tuning was performed.", "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npm run research:systematic -- --data-dir DATA_DIRECTORY --out-dir NEW_REPORT_DIRECTORY\nDefaults: --data-dir reports/hourly-adaptive-study-2026-09-08/data-recent\nReplays only frozen 2024 and 2025 H1 development windows. --out-dir is required and existing study files are never overwritten."); return;
  }
  let dataDirectory = "reports/hourly-adaptive-study-2026-09-08/data-recent", outputDirectory: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("SYSTEMATIC_REPLAY_ARGUMENT_VALUE_REQUIRED");
    if (arg === "--data-dir") dataDirectory = value;
    else if (arg === "--out-dir") outputDirectory = value;
    else throw new Error(`UNKNOWN_SYSTEMATIC_REPLAY_ARGUMENT:${arg}`);
  }
  if (!outputDirectory) throw new Error("Usage: npm run research:systematic -- --out-dir NEW_REPORT_DIRECTORY");
  const result = await runSystematicEconomicStudy(dataDirectory, outputDirectory);
  console.log(JSON.stringify({ conclusion: result.conclusion, validation: result.validation }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
