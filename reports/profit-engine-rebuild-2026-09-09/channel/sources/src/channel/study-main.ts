import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadHourlyDataset, type FundingRow, type HourlyBar } from "../research/hourly-data.js";
import { CHANNEL_SPEC as S, CHANNEL_STUDY_SPEC as D } from "./spec.js";
import { replayChannel } from "./replay.js";

const SHA = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const save = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const sourcePaths = ["src/channel/spec.ts", "src/channel/replay.ts", "src/channel/study-main.ts", "test/channel-replay.test.ts", "test/channel-study.test.ts",
  "src/research/hourly-data.ts", "package-lock.json", "tsconfig.json"];
export function channelBootstrap(runs: Array<ReturnType<typeof replayChannel>>) {
  const weeks: Array<{ windowStartMs: number; weekStartMs: number; netUsd: number }> = [], weekMs = 7 * S.dayMs;
  for (const run of runs.filter(r => r.scenario === "base" && r.policy === "channel")) {
    const byWeek = new Map<number, Array<{ dayStartMs: number; netPnlUsd: number }>>();
    for (const day of run.dailyNetPnlUsd) {
      const mondayEpoch = Date.UTC(1970, 0, 5), start = mondayEpoch + Math.floor((day.dayStartMs - mondayEpoch) / weekMs) * weekMs;
      const group = byWeek.get(start) ?? []; group.push(day); byWeek.set(start, group);
    }
    for (const [weekStartMs, group] of byWeek) if (group.length === 7 && group.every((day, i) => day.dayStartMs === weekStartMs + i * S.dayMs))
      weeks.push({ windowStartMs: run.startMs, weekStartMs, netUsd: group.reduce((n, d) => n + d.netPnlUsd, 0) });
  }
  const blocks = weeks.flatMap((week, i) => {
    const part = weeks.slice(i, i + D.bootstrap.contiguousBlockWeeks);
    return part.length === D.bootstrap.contiguousBlockWeeks && part.every((p, n) => p.windowStartMs === week.windowStartMs
      && p.weekStartMs === week.weekStartMs + n * weekMs) ? [part.map(p => p.netUsd)] : [];
  });
  if (!weeks.length || !blocks.length) return { weeks, completeWeeks: weeks.length, validBlocks: blocks.length, lowerMeanWeeklyNetUsd: null };
  let random = D.bootstrap.seed;
  const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 2 ** 32; };
  const means: number[] = [];
  for (let r = 0; r < D.bootstrap.repetitions; r++) {
    const sampled: number[] = [];
    while (sampled.length < weeks.length) sampled.push(...blocks[Math.floor(next() * blocks.length)]!);
    means.push(sampled.slice(0, weeks.length).reduce((a, b) => a + b, 0) / weeks.length);
  }
  means.sort((a, b) => a - b);
  return { weeks, completeWeeks: weeks.length, validBlocks: blocks.length,
    lowerMeanWeeklyNetUsd: means[Math.floor(D.bootstrap.lowerQuantile * (means.length - 1))]! };
}
export async function runChannelStudy(output: string) {
  const inputs = ["reports/hourly-adaptive-study-2026-09-08/data-older-restored", "reports/hourly-adaptive-study-2026-09-08/data-recent"];
  const datasets = await Promise.all(inputs.map(loadHourlyDataset));
  const barMap = new Map<string, HourlyBar>(), fundingMap = new Map<string, FundingRow>();
  for (const dataset of datasets) {
    for (const row of dataset.bars) {
      if (row.openMs < D.warmupStartMs || row.openMs >= D.windows.at(-1)!.endMs) continue;
      const key = `${row.symbol}:${row.openMs}`, prior = barMap.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error("CHANNEL_CONFLICTING_SOURCE_BARS");
      barMap.set(key, row);
    }
    for (const row of dataset.funding) {
      if (row.timestampMs <= D.warmupStartMs || row.timestampMs > D.windows.at(-1)!.endMs) continue;
      const key = `${row.symbol}:${row.timestampMs}`, prior = fundingMap.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error("CHANNEL_CONFLICTING_SOURCE_FUNDING");
      fundingMap.set(key, row);
    }
  }
  const bars = [...barMap.values()].sort((a, b) => a.openMs - b.openMs || a.symbol.localeCompare(b.symbol));
  const funding = [...fundingMap.values()].sort((a, b) => a.timestampMs - b.timestampMs || a.symbol.localeCompare(b.symbol));
  const dataSha256 = SHA(JSON.stringify({ bars, funding }));
  const sources = await Promise.all(sourcePaths.map(async path => ({ path, bytes: await readFile(path) })));
  const hashes = Object.fromEntries(sources.map(s => [s.path, SHA(s.bytes)]));
  const inputHashes = await Promise.all(inputs.map(async path => ({ path, datasetSha256: SHA(await readFile(join(path, "dataset.json"))),
    manifestSha256: SHA(await readFile(join(path, "manifest.json"))) })));
  await mkdir(output, { recursive: true });
  // Immutable protocol and source copies precede the first historical daily signal or replay.
  await save(join(output, "protocol.json"), { frozenAtUtc: new Date().toISOString(), strategy: S, study: D,
    sourceHashes: hashes, inputs: inputHashes, permittedDataSha256: dataSha256,
    barRows: bars.length, fundingRows: funding.length, priorFailedResearchAcknowledged: true,
    reserved2026PerformanceInspected: false, strategyOutcomesComputedBeforeSeal: false });
  for (const source of sources) {
    const target = join(output, "sources", source.path); await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source.bytes, { flag: "wx" });
  }
  const runs: ReturnType<typeof replayChannel>[] = [], benchmarks: ReturnType<typeof replayChannel>[] = [];
  for (const window of D.windows) for (const scenario of D.scenarios)
    for (const policy of ["channel", "buy-hold-btc", "buy-hold-eth"] as const) {
      const run = replayChannel({ bars, funding, startMs: window.startMs, endMs: window.endMs, scenario, policy });
      (policy === "channel" ? runs : benchmarks).push(run);
      await save(join(output, `${window.id}-${scenario}-${policy}.json`), run);
      process.stdout.write(JSON.stringify({ period: window.id, scenario, policy, netPnlUsd: run.netPnlUsd,
        episodes: run.closedEpisodes, feesUsd: run.feeUsd, fundingUsd: run.fundingCashUsd,
        drawdownUsd: run.maxDrawdownUsd, accountingKnown: run.accountingKnown }) + "\n");
    }
  const bootstrap = channelBootstrap(runs), baseEpisodes = runs.filter(r => r.scenario === "base").reduce((n, r) => n + r.closedEpisodes, 0);
  const checks = { allRunsAccounted: runs.length === 4 && runs.every(r => r.accountingKnown),
    bothPeriodsPositiveBaseAndStress: runs.length === 4 && runs.every(r => r.netPnlUsd !== null && r.netPnlUsd > 0),
    enoughEpisodes: baseEpisodes >= D.minimumClosedEpisodesTotal,
    lowerBootstrapWeeklyNetPositive: bootstrap.lowerMeanWeeklyNetUsd !== null && bootstrap.lowerMeanWeeklyNetUsd > 0 };
  for (const source of sources) if (SHA(await readFile(source.path)) !== hashes[source.path]) throw new Error(`CHANNEL_FROZEN_SOURCE_CHANGED:${source.path}`);
  const summarize = ({ orders: _o, episodes: _e, hourly: _h, dailyNetPnlUsd: _d, ...rest }: ReturnType<typeof replayChannel>) => rest;
  const report = { generatedAtUtc: new Date().toISOString(), strategyVersion: S.version, dataSha256,
    historicalDevelopmentEligible: Object.values(checks).every(Boolean), checks, baseEpisodes, bootstrap,
    runs: runs.map(summarize), benchmarks: benchmarks.map(summarize), cashBenchmarkNetUsd: 0,
    sourceHashes: hashes, reserved2026Evaluated: false, runtimeActivated: false, futureProfitGuaranteed: false,
    limitations: ["Prior candidate failures and repeated use of 2024/2025 make this development evidence, not untouched validation.",
      "Hourly trade candles do not prove executable books, price-impact depth, exact intrahour chronology, or live latency.",
      "Stops use adverse execution and charge paying funding for the whole touched hour while dropping receiving funding; this is a conservative timing bound, not exact observed cash.",
      "Drawdown uses hourly liquidation closes. The additional downside envelope uses prior close peaks, not intrahour high-water marks.",
      "The sum of separate adverse asset extremes is a risk envelope rather than synchronized observed portfolio prices.",
      "Known positive candle volume is a retrospective fill availability proxy; intrahour arrival and partial fills remain unobserved.",
      "Passive comparators are independent constant-unit paths with $1000 entry caps; later mark notional can exceed the entry cap. They are descriptive, not risk-matched alternatives.",
      "Quoted fees, ticks, minimum quantities and known-at-hour-start funding are declared assumptions rather than verified historical account entitlements."] };
  await save(join(output, "report.json"), report);
  const money = (n: number | null) => n === null ? "unknown" : `$${n.toFixed(2)}`;
  const table = (r: ReturnType<typeof replayChannel>) => `| ${new Date(r.startMs).getUTCFullYear()}${new Date(r.endMs).getUTCMonth() === 6 ? " H1" : ""} | ${r.scenario} | ${r.policy} | ${r.closedEpisodes} | ${money(r.netPnlUsd)} | ${money(r.feeUsd)} | ${money(r.fundingCashUsd)} | ${money(r.maxDrawdownUsd)} |`;
  await writeFile(join(output, "report.md"), [
    `The fixed daily 55/20 channel candidate ${report.historicalDevelopmentEligible ? "passed" : "failed"} its declared historical development screen. Runtime activation remains false.`, "",
    "| Period | Cost case | Policy | Episodes | Net after costs/funding | Fees | Funding | Hourly close drawdown |",
    "|---|---|---|---:|---:|---:|---:|---:|", ...runs.map(table), "",
    `Base closed episodes: ${baseEpisodes}. Complete base weeks: ${bootstrap.completeWeeks}. Four-week moving-block bootstrap lower 5% mean weekly net: ${money(bootstrap.lowerMeanWeeklyNetUsd)}.`, "",
    "Descriptive cash benchmark: $0. Constant-unit long perpetual benchmarks:", "",
    "| Period | Cost case | Policy | Episodes | Net after costs/funding | Fees | Funding | Hourly close drawdown |",
    "|---|---|---|---:|---:|---:|---:|---:|", ...benchmarks.map(table), "",
    "This single candidate was sealed with source copies before its first economic replay. Both historical periods were reused after prior candidate failures. No parameter grid or 2026 performance was evaluated.", "",
    ...report.limitations.map(l => `- ${l}`), "",
    "Full orders, partial reductions, episodes, hourly marked equity, calendar daily net changes, missing data and unresolved positions are retained in each run JSON. No future profit is guaranteed.", "",
  ].join("\n"), { flag: "wx" });
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error("Usage: npx tsx src/channel/study-main.ts NEW_OUTPUT_DIRECTORY");
  await runChannelStudy(process.argv[2]!);
}
