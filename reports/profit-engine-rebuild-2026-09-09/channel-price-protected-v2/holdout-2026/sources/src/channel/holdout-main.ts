import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { loadHourlyDataset, missingHourlyTimes, type FundingRow, type HourlyBar } from "../research/hourly-data.js";
import { CHANNEL_SPEC as S, CHANNEL_STUDY_SPEC as D, CHANNEL_PRICE_PROTECTED_SPEC as P } from "./spec.js";
import { CHANNEL_HOLDOUT_SPEC as H } from "./holdout-spec.js";
import { CHANNEL_PLANNER_SPEC } from "./planner.js";
import { channelBootstrap } from "./study-main.js";
import { replayChannel, replayPriceProtectedChannel, replayPriceProtectedChannelHoldout } from "./replay.js";

const SHA = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const save = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const sourcePaths = ["src/channel/spec.ts", "src/channel/replay.ts", "src/channel/planner.ts", "src/channel/study-main.ts",
  "src/channel/holdout-spec.ts", "src/channel/holdout-main.ts", "src/channel/verify-v1-parity-main.ts",
  "test/channel-replay.test.ts", "test/channel-study.test.ts", "test/channel-price-protection.test.ts", "test/channel-planner.test.ts",
  "test/channel-holdout.test.ts", "src/research/hourly-data.ts", "src/execution/book-walk.ts", "src/execution/planner.ts",
  "src/risk/sizing.ts", "src/config.ts", "src/core/market.ts", "src/strategy/cost.ts", "package-lock.json", "tsconfig.json"];
const dataRoots = ["reports/hourly-adaptive-study-2026-09-08/data-older-restored", "reports/hourly-adaptive-study-2026-09-08/data-recent"];
const extensionRoot = "reports/portfolio-funding-extension-2026-09-09";
const developmentRoots = ["reports/profit-engine-rebuild-2026-09-09/channel", "reports/profit-engine-rebuild-2026-09-09/channel-price-protected-v2"];
const inputPaths = [...dataRoots.flatMap(root => [join(root, "dataset.json"), join(root, "manifest.json")]),
  join(extensionRoot, "manifest.json"), ...["PF_XBTUSD", "PF_ETHUSD"].flatMap(p => [join(extensionRoot, `${p}.json.gz`), join(extensionRoot, `${p}.headers`)])];
function mergeDevelopment(datasets: Awaited<ReturnType<typeof loadHourlyDataset>>[]) {
  const bmap = new Map<string, HourlyBar>(), fmap = new Map<string, FundingRow>();
  for (const dataset of datasets) {
    for (const row of dataset.bars) {
      if (row.openMs < D.warmupStartMs || row.openMs >= D.windows.at(-1)!.endMs) continue;
      const key = `${row.symbol}:${row.openMs}`, prior = bmap.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error("HOLDOUT_PREP_CONFLICTING_DEVELOPMENT_BARS"); bmap.set(key, row);
    }
    for (const row of dataset.funding) {
      if (row.timestampMs <= D.warmupStartMs || row.timestampMs > D.windows.at(-1)!.endMs) continue;
      const key = `${row.symbol}:${row.timestampMs}`, prior = fmap.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error("HOLDOUT_PREP_CONFLICTING_DEVELOPMENT_FUNDING"); fmap.set(key, row);
    }
  }
  return { bars: [...bmap.values()].sort((a, b) => a.openMs - b.openMs || a.symbol.localeCompare(b.symbol)),
    funding: [...fmap.values()].sort((a, b) => a.timestampMs - b.timestampMs || a.symbol.localeCompare(b.symbol)) };
}
export async function prepareChannelHoldout(out: string) {
  await mkdir(out, { recursive: false });
  const data = mergeDevelopment(await Promise.all(dataRoots.map(loadHourlyDataset)));
  const matches: Array<{ originalFile: string; originalSha256: string; reproducedSha256: string; identical: boolean }> = [];
  for (const [index, root] of developmentRoots.entries()) {
    const originalProtocol = JSON.parse(await readFile(join(root, "protocol.json"), "utf8")) as { sourceHashes: Record<string, string>; permittedDataSha256: string };
    if (SHA(JSON.stringify(data)) !== originalProtocol.permittedDataSha256) throw new Error("HOLDOUT_DEVELOPMENT_INPUT_CHANGED");
    for (const [path, hash] of Object.entries(originalProtocol.sourceHashes))
      if (SHA(await readFile(join(root, "sources", path))) !== hash) throw new Error("HOLDOUT_ORIGINAL_SOURCE_COPY_CHANGED");
    for (const window of D.windows) for (const scenario of D.scenarios) for (const policy of ["channel", "buy-hold-btc", "buy-hold-eth"] as const) {
      const originalFile = join(root, `${window.id}-${scenario}-${policy}.json`), old = await readFile(originalFile);
      const run = (index === 0 ? replayChannel : replayPriceProtectedChannel)({ ...data, startMs: window.startMs, endMs: window.endMs, scenario, policy });
      const reproduced = JSON.stringify(run, null, 2) + "\n";
      matches.push({ originalFile, originalSha256: SHA(old), reproducedSha256: SHA(reproduced), identical: SHA(old) === SHA(reproduced) });
    }
  }
  const parity = { checkedAtUtc: new Date().toISOString(), allDevelopmentRunsIdentical: matches.length === 24 && matches.every(m => m.identical),
    matches, holdoutSignalsOrOutcomesComputed: false };
  await save(join(out, "development-parity.json"), parity);
  if (!parity.allDevelopmentRunsIdentical) throw new Error("HOLDOUT_DEVELOPMENT_PARITY_FAILED");
  const sources = await Promise.all(sourcePaths.map(async path => ({ path, bytes: await readFile(path) })));
  const sourceHashes = Object.fromEntries(sources.map(s => [s.path, SHA(s.bytes)]));
  const inputHashes = Object.fromEntries(await Promise.all(inputPaths.map(async path => [path, SHA(await readFile(path))])));
  const developmentReport = JSON.parse(await readFile(join(developmentRoots[1]!, "report.json"), "utf8")) as { checks: unknown; bootstrap: { lowerMeanWeeklyNetUsd: number }; historicalDevelopmentEligible: boolean };
  const design = { preparedAtUtc: new Date().toISOString(), strategy: P, executionAndRisk: S, holdout: H,
    adapter: CHANNEL_PLANNER_SPEC, sourceHashes, inputHashes, developmentParitySha256: SHA(await readFile(join(out, "development-parity.json"))),
    preservedDevelopmentEligibility: developmentReport.historicalDevelopmentEligible, preservedDevelopmentChecks: developmentReport.checks,
    preservedDevelopmentBootstrapLowerMeanWeeklyNetUsd: developmentReport.bootstrap.lowerMeanWeeklyNetUsd,
    originalPlannerHistoricalGateChanged: false, holdoutSignalsOrOutcomesComputed: false,
    reviewRequirement: "ROOT_REVIEW_OF_THIS_EXACT_DESIGN_SHA256_BEFORE_EXPLICIT_EVALUATE_COMMAND",
    repeatPolicy: "ONE_FIXED_HOLDOUT_NO_POST_OUTCOME_PARAMETER_CHANGES" };
  await save(join(out, "protocol-design.json"), design);
  for (const source of sources) { const target = join(out, "sources", source.path); await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source.bytes, { flag: "wx" }); }
  const designSha256 = SHA(await readFile(join(out, "protocol-design.json")));
  return { out, readyForRootReview: true, designSha256, developmentRunsIdentical: 24, holdoutOutcomesComputed: false };
}
async function holdoutData() {
  const dataset = await loadHourlyDataset(dataRoots[1]!);
  const bars = dataset.bars.filter(b => b.openMs >= H.warmupStartMs && b.openMs < H.endMs);
  const rates = new Map<string, FundingRow>();
  const put = (row: FundingRow) => {
    if (row.timestampMs <= H.startMs || row.timestampMs > H.endMs) return;
    if (!Number.isSafeInteger(row.timestampMs) || row.timestampMs % S.hourMs || !Number.isFinite(row.absoluteRate)
      || !Number.isFinite(row.rate)) throw new Error("HOLDOUT_INVALID_FUNDING_ROW");
    const key = `${row.symbol}:${row.timestampMs}`, old = rates.get(key);
    if (old && (old.absoluteRate !== row.absoluteRate || old.rate !== row.rate)) throw new Error(`HOLDOUT_CONFLICTING_FUNDING:${key}`);
    rates.set(key, row);
  };
  for (const row of dataset.funding) put(row);
  const manifest = JSON.parse(await readFile(join(extensionRoot, "manifest.json"), "utf8")) as {
    version: string; files: Array<{ symbol: string; file: string; url: string; compressedSha256: string; jsonSha256: string; headersFile: string; headersSha256: string }> };
  if (manifest.version !== "public-funding-extension-evidence-v1" || manifest.files.length !== 2) throw new Error("HOLDOUT_INVALID_FUNDING_MANIFEST");
  const products = { PF_XBTUSD: "BTC/USD", PF_ETHUSD: "ETH/USD" } as const;
  const seenProducts = new Set<string>();
  for (const source of manifest.files) {
    if (!(source.symbol in products) || seenProducts.has(source.symbol) || source.file !== `${source.symbol}.json.gz`
      || source.headersFile !== `${source.symbol}.headers`
      || source.url !== `https://futures.kraken.com/derivatives/api/v3/historical-funding-rates?symbol=${source.symbol}`)
      throw new Error("HOLDOUT_FUNDING_SOURCE_IDENTITY_INVALID");
    seenProducts.add(source.symbol);
    const bytes = await readFile(join(extensionRoot, source.file)), headers = await readFile(join(extensionRoot, source.headersFile));
    if (SHA(bytes) !== source.compressedSha256 || SHA(headers) !== source.headersSha256) throw new Error("HOLDOUT_FUNDING_SOURCE_HASH_MISMATCH");
    const decoded = gunzipSync(bytes, { maxOutputLength: 4 * 1024 * 1024 });
    if (SHA(decoded) !== source.jsonSha256) throw new Error("HOLDOUT_FUNDING_JSON_HASH_MISMATCH");
    const payload = JSON.parse(decoded.toString("utf8")) as { result: string; rates: Array<{ timestamp: string; fundingRate: number; relativeFundingRate: number }> };
    if (payload.result !== "success" || !Array.isArray(payload.rates)) throw new Error("HOLDOUT_FUNDING_API_RESPONSE_INVALID");
    const seen = new Set<number>();
    for (const row of payload.rates) {
      const sourceMs = Date.parse(row.timestamp);
      if (!Number.isSafeInteger(sourceMs) || sourceMs % S.hourMs) throw new Error("HOLDOUT_FUNDING_TIMESTAMP_INVALID");
      if (sourceMs < H.startMs || sourceMs >= H.endMs) continue;
      if (seen.has(sourceMs)) throw new Error("HOLDOUT_DUPLICATE_API_FUNDING"); seen.add(sourceMs);
      put({ symbol: products[source.symbol as keyof typeof products], timestampMs: sourceMs + S.hourMs,
        rate: row.relativeFundingRate, absoluteRate: row.fundingRate });
    }
  }
  const funding = [...rates.values()].sort((a, b) => a.timestampMs - b.timestampMs || a.symbol.localeCompare(b.symbol));
  const coverage = S.symbols.map(symbol => ({ symbol,
    missingWarmupOrTestBars: missingHourlyTimes(bars.filter(b => b.symbol === symbol).map(b => b.openMs), H.warmupStartMs, H.endMs),
    missingTestFunding: missingHourlyTimes(funding.filter(f => f.symbol === symbol).map(f => f.timestampMs - S.hourMs), H.startMs, H.endMs) }));
  return { bars, funding, coverage };
}
export function validateChannelHoldout(runs: Array<ReturnType<typeof replayChannel>>) {
  const base = runs.find(r => r.scenario === "base" && r.policy === "channel");
  const selected = runs.filter(r => r.policy === "channel"), scenarios = new Set(selected.map(r => r.scenario));
  const knownFundedAccounting = selected.length === 2 && selected.every(r => r.accountingKnown
    && !r.unresolved.length && !r.missingFunding.length && !r.missingBars.length);
  // Partial marked paths cannot supply a funded confidence bound after missing cash evidence.
  // Keep the original development bootstrap unchanged and do not promote partial diagnostics.
  const bootstrap = knownFundedAccounting ? channelBootstrap(selected)
    : { weeks: [], completeWeeks: 0, validBlocks: 0, lowerMeanWeeklyNetUsd: null };
  const riskReasons = ["ACCOUNT_DRAWDOWN_ENVELOPE", "SESSION_OR_ROLLING_LOSS_ENVELOPE", "SESSION_OR_ROLLING_LOSS"];
  const checks = {
    exactTwoScenarios: selected.length === 2 && scenarios.size === 2 && scenarios.has("base") && scenarios.has("stress")
      && selected.every(r => r.version === P.version && r.startMs === H.startMs && r.endMs === H.endMs),
    knownFundedAccounting,
    positiveBaseAndStress: knownFundedAccounting && selected.every(r => r.netPnlUsd !== null && Number.isFinite(r.netPnlUsd) && r.netPnlUsd > 0),
    atLeastSixBaseEpisodes: !!base && base.closedEpisodes >= H.minimumBaseClosedEpisodes,
    holdoutBootstrapLowerMeanPositive: bootstrap.lowerMeanWeeklyNetUsd !== null && bootstrap.lowerMeanWeeklyNetUsd > 0,
    noAccountRiskBreaches: selected.length === 2 && selected.every(r => riskReasons.every(reason => !(r.haltReasons[reason]! > 0))),
  };
  return { historicalHoldoutPassed: Object.values(checks).every(Boolean), checks, bootstrap,
    fundedBootstrapStatus: knownFundedAccounting ? "KNOWN_ACCOUNTING" : "UNAVAILABLE_MISSING_FUNDED_EVIDENCE",
    originalDevelopmentBootstrapFailurePreserved: true, originalPlannerHistoricalGateChanged: false,
    paperPilotEligible: false, pendingIndependentCashVerification: true, pendingCurrentFeeRulesAndBookEvidence: true,
    realOrdersAllowed: false, futureProfitGuaranteed: false };
}
export async function evaluateChannelHoldout(out: string, reviewedDesignSha256: string) {
  const designBytes = await readFile(join(out, "protocol-design.json"));
  if (!/^[0-9a-f]{64}$/.test(reviewedDesignSha256) || SHA(designBytes) !== reviewedDesignSha256) throw new Error("HOLDOUT_EXACT_REVIEWED_DESIGN_REQUIRED");
  const design = JSON.parse(designBytes.toString("utf8")) as { sourceHashes: Record<string, string>; inputHashes: Record<string, string>; developmentParitySha256: string };
  for (const [path, hash] of Object.entries(design.sourceHashes))
    if (SHA(await readFile(path)) !== hash || SHA(await readFile(join(out, "sources", path))) !== hash) throw new Error(`HOLDOUT_SOURCE_CHANGED_AFTER_REVIEW:${path}`);
  for (const [path, hash] of Object.entries(design.inputHashes)) if (SHA(await readFile(path)) !== hash) throw new Error(`HOLDOUT_INPUT_CHANGED_AFTER_REVIEW:${path}`);
  if (SHA(await readFile(join(out, "development-parity.json"))) !== design.developmentParitySha256) throw new Error("HOLDOUT_PARITY_ARTIFACT_CHANGED");
  await save(join(out, "protocol.json"), { sealedAtUtc: new Date().toISOString(), reviewedDesignSha256,
    sourceHashes: design.sourceHashes, inputHashes: design.inputHashes, holdout: H, strategy: P,
    holdoutOutcomesComputedBeforeSeal: false, originalDevelopmentBootstrapFailurePreserved: true });
  const data = await holdoutData();
  await mkdir(join(out, "inputs"));
  await save(join(out, "inputs", "permitted-dataset.json"), data);
  const dataSha256 = SHA(await readFile(join(out, "inputs", "permitted-dataset.json")));
  await save(join(out, "inputs", "manifest.json"), { dataSha256, coverage: data.coverage, sourceHashes: design.inputHashes,
    noMissingFundingFilled: true, timestampConvention: S.funding });
  const runs: Array<ReturnType<typeof replayPriceProtectedChannelHoldout>> = [], benchmarks: Array<ReturnType<typeof replayPriceProtectedChannelHoldout>> = [];
  for (const scenario of H.scenarios) for (const policy of ["channel", "buy-hold-btc", "buy-hold-eth"] as const) {
    const run = replayPriceProtectedChannelHoldout({ ...data, startMs: H.startMs, endMs: H.endMs, scenario, policy });
    (policy === "channel" ? runs : benchmarks).push(run);
    await save(join(out, `2026-jan-jul-${scenario}-${policy}.json`), run);
    process.stdout.write(JSON.stringify({ scenario, policy, netPnlUsd: run.netPnlUsd, episodes: run.closedEpisodes,
      accountingKnown: run.accountingKnown, missingHeldFundingHours: run.missingFunding.length, unresolved: run.unresolved.length }) + "\n");
  }
  const validation = validateChannelHoldout(runs);
  for (const [path, hash] of Object.entries(design.sourceHashes)) if (SHA(await readFile(path)) !== hash) throw new Error(`HOLDOUT_SOURCE_CHANGED_DURING_REPLAY:${path}`);
  const summarize = ({ orders: _o, episodes: _e, hourly: _h, dailyNetPnlUsd: _d, ...rest }: ReturnType<typeof replayPriceProtectedChannelHoldout>) => rest;
  const report = { generatedAtUtc: new Date().toISOString(), strategyVersion: P.version, dataSha256, reviewedDesignSha256,
    validation, coverage: data.coverage, runs: runs.map(summarize), benchmarks: benchmarks.map(summarize), cashBenchmarkNetUsd: 0,
    originalDevelopmentResultChanged: false, noFurtherStrategySearch: true, runtimeActivated: false,
    evidence: "ONE_PREVIOUSLY_RESERVED_WINDOW;CANDLE_EXECUTION_PROXY;MISSING_HELD_FUNDING_INVALIDATES_FULL_RESULT" };
  await save(join(out, "report.json"), report);
  const money = (n: number | null) => n === null ? "unknown" : `$${n.toFixed(2)}`;
  await writeFile(join(out, "report.md"), [
    `The one reserved January–July 2026 test ${validation.historicalHoldoutPassed ? "passed" : "failed"} its declared historical checks. Paper eligibility remains false pending independent cash verification and current fee, venue-rule and quote evidence.`, "",
    "| Cost case | Episodes | Net after fees/funding | Held missing funding hours | Hourly close drawdown |",
    "|---|---:|---:|---:|---:|", ...runs.map(r => `| ${r.scenario} | ${r.closedEpisodes} | ${money(r.netPnlUsd)} | ${r.missingFunding.length} | ${money(r.maxDrawdownUsd)} |`), "",
    `Holdout-only bootstrap lower 5% mean weekly net: ${money(validation.bootstrap.lowerMeanWeeklyNetUsd)}.`, "",
    "V2 parameters, delay cases, costs, risk controls, and the half-ATR entry rule remained fixed. All 24 original development run files reproduced byte-for-byte before this test. The original development bootstrap failure and planner gate remain unchanged.", "",
    "The three previously known hourly funding omissions per asset remain absent. Any held exposure requiring an omitted rate makes full funded PnL unknown. No omission is treated as zero, and funding analytics are not substituted for hourly rates.", "",
    "Historical candles do not prove executable book depth, exact intrahour chronology, current account fees or future profit. Full orders, funding, source hashes, benchmarks and unresolved exposure are retained in the JSON artifacts. No real orders or strategy activation occurred.", "",
  ].join("\n"), { flag: "wx" });
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, out, reviewedHash] = process.argv.slice(2);
  if (!out || !["--prepare", "--evaluate"].includes(mode ?? "") || mode === "--evaluate" && !reviewedHash
    || mode === "--prepare" && reviewedHash) throw new Error("Usage: holdout-main.ts --prepare NEW_OUT | --evaluate OUT REVIEWED_DESIGN_SHA256");
  if (mode === "--prepare") process.stdout.write(JSON.stringify(await prepareChannelHoldout(out)) + "\n");
  else await evaluateChannelHoldout(out, reviewedHash!);
}
