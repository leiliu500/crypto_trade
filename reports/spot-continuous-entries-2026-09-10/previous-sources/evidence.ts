import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadSpotWeeks } from "./data.js";
import { SPOT_STUDY_SOURCES } from "./study-main.js";
import { SPOT_TREND_SPEC as S, SPOT_TREND_STUDY as D } from "./spec.js";

export interface SpotPaperEvidence {
  evidenceSha256: string;
  reportSha256: string;
  auditSha256: string;
  sourceHashes: Record<string, string>;
  summary: {
    baseNetUsd: number;
    stressNetUsd: number;
    baseEpisodes: number;
    stressEpisodes: number;
    lowerMeanWeeklyNetUsd: number | null;
    provenProfitable: false;
  };
}
const hash = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const fail = (reason: string): never => { throw new Error(`SPOT_PAPER_EVIDENCE_${reason}`); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : fail("INVALID_DOCUMENT");
const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : fail("INVALID_NUMBER");
const integer = (value: unknown): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fail("INVALID_COUNT");
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : fail("INVALID_ARRAY");
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-7;
const same = (a: unknown, b: unknown, reason: string): void => { if (!isDeepStrictEqual(a, b)) fail(reason); };
const sha = (value: unknown): string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : fail("INVALID_HASH");

function safeRelative(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(value)
    || value.split("/").some(part => part === "." || part === "..")
    || !(value.startsWith("reports/") || SPOT_STUDY_SOURCES.includes(value))) fail("UNSAFE_PATH");
  return value as string;
}

/** An audited historical nomination can permit research paper only, never assert profit. */
export async function loadSpotPaperEvidence(studyDirectory: string, auditFile: string, repoRoot = process.cwd()): Promise<SpotPaperEvidence> {
  const root = await realpath(resolve(repoRoot));
  const relativeInput = (value: string): string => safeRelative(relative(root, resolve(root, value)).split(sep).join("/"));
  const studyPath = relativeInput(studyDirectory), auditPath = relativeInput(auditFile);
  if (!studyPath.startsWith("reports/") || !auditPath.startsWith("reports/")) fail("INVALID_REPORT_SCOPE");
  const cache = new Map<string, Buffer>(); let totalBytes = 0;
  const read = async (path: string): Promise<Buffer> => {
    safeRelative(path);
    const cached = cache.get(path); if (cached) return cached;
    const target = await realpath(join(root, path));
    if (!target.startsWith(root + sep)) fail("SYMLINK_ESCAPE");
    const info = await stat(target);
    if (!info.isFile() || info.size <= 0 || info.size > 16 * 1024 * 1024) fail("FILE_LIMIT");
    const bytes = await readFile(target);
    totalBytes += bytes.length;
    if (bytes.length !== info.size || totalBytes > 64 * 1024 * 1024) fail("FILE_CHANGED_OR_TOTAL_LIMIT");
    cache.set(path, bytes); return bytes;
  };
  const auditBytes = await read(auditPath), audit = object(JSON.parse(auditBytes.toString("utf8")));
  if (audit.passed !== true || integer(audit.checks) < 1) fail("AUDIT_NOT_PASSED");
  for (const key of ["failures", "failedChecks", "errors"]) if (key in audit) {
    const value = audit[key];
    if (!(Array.isArray(value) && value.length === 0 || value === 0)) fail("AUDIT_HAS_FAILURES");
  }
  const bindings = object(audit.fileHashes), bindingKeys = Object.keys(bindings);
  if (!bindingKeys.length || bindingKeys.length > 512) fail("AUDIT_BINDING_LIMIT");
  for (const path of bindingKeys) {
    safeRelative(path);
    if (hash(await read(path)) !== sha(bindings[path])) fail(`AUDIT_FILE_HASH_MISMATCH:${path}`);
  }
  const required = async (path: string): Promise<Buffer> => {
    safeRelative(path);
    if (!(path in bindings)) fail(`MISSING_AUDIT_BINDING:${path}`);
    return read(path);
  };
  const protocolPath = `${studyPath}/protocol.json`, reportPath = `${studyPath}/report.json`;
  const protocolBytes = await required(protocolPath), reportBytes = await required(reportPath);
  const protocol = object(JSON.parse(protocolBytes.toString("utf8"))), report = object(JSON.parse(reportBytes.toString("utf8")));
  same(protocol.strategy, S, "STRATEGY_MISMATCH"); same(protocol.study, D, "STUDY_MISMATCH");
  if (protocol.historicalStrategyOutcomesComputedBeforeSeal !== false || protocol.independentHoldoutClaimed !== false
    || protocol.recentHistoryPreviouslyUsedByOtherCandidates !== true || protocol.parameterGrid !== false) fail("PROTOCOL_CLAIM_MISMATCH");
  if (report.strategyVersion !== S.version || report.researchPaperEligible !== true || report.provenProfitable !== false
    || report.independentValidationPassed !== false || report.liveTradingAllowed !== false) fail("NOT_RESEARCH_PAPER_ONLY");
  if ("provenProfitable" in audit && audit.provenProfitable !== false
    || "independentProspectiveValidationPassed" in audit && audit.independentProspectiveValidationPassed !== false
    || "liveTradingAllowed" in audit && audit.liveTradingAllowed !== false) fail("AUDIT_PROFIT_CLAIM");
  if (audit.studyDirectory !== studyPath || audit.strategyVersion !== S.version || audit.researchPaperEligible !== true)
    fail("AUDIT_SCOPE_MISMATCH");
  const dataPath = safeRelative(audit.dataDirectory);
  if (!dataPath.startsWith("reports/")) fail("INVALID_DATA_SCOPE");
  const registeredData = protocol.inputDirectory;
  // The audited relative path permits relocating an immutable report bundle to a new repo root.
  if (typeof registeredData !== "string" || !(resolve(root, registeredData) === resolve(root, dataPath)
    || isAbsolute(registeredData) && registeredData.endsWith(`/${dataPath}`))) fail("DATA_DIRECTORY_MISMATCH");
  const sourceHashes = object(report.sourceHashes);
  same(Object.keys(sourceHashes).sort(), [...SPOT_STUDY_SOURCES].sort(), "SOURCE_CLOSURE_MISMATCH");
  same(sourceHashes, protocol.sourceHashes, "PROTOCOL_SOURCE_MISMATCH");
  for (const path of SPOT_STUDY_SOURCES) {
    const expected = sha(sourceHashes[path]);
    if (hash(await required(path)) !== expected || hash(await required(`${studyPath}/sources/${path}`)) !== expected)
      fail(`SOURCE_CHANGED:${path}`);
  }
  for (const file of ["source.json", "dataset.json", "manifest.json", "registration.json"]) await required(`${dataPath}/${file}`);
  if (hash(await required(`${dataPath}/source.json`)) !== sha(report.sourceDataSha256)
    || hash(await required(`${dataPath}/dataset.json`)) !== sha(report.datasetSha256)
    || report.datasetSha256 !== protocol.datasetSha256
    || hash(await required(`${dataPath}/manifest.json`)) !== sha(protocol.inputManifestSha256)) fail("DATA_HASH_MISMATCH");
  const data = await loadSpotWeeks(join(root, dataPath));
  same(data.coverage, report.coverage, "DATA_COVERAGE_MISMATCH");
  if (data.bars[0]!.openMs > D.startMs - (S.movingAverageWeeks + 2) * 7 * 86_400_000
    || data.bars.at(-1)!.endMs < D.endMsExclusive) fail("INCOMPLETE_DATA_SCOPE");

  const windows = [{ id: "full", startMs: D.startMs, endMs: D.endMsExclusive }, ...D.periods];
  const runEntries = array(report.runs);
  if (runEntries.length !== windows.length * 2 * D.policies.length) fail("INCOMPLETE_RUN_SET");
  const summaries = new Map<string, Record<string, unknown>>();
  for (const raw of runEntries) {
    const summary = object(raw);
    const file = typeof summary.file === "string" ? summary.file : fail("DUPLICATE_OR_INVALID_RUN");
    if (summaries.has(file)) fail("DUPLICATE_OR_INVALID_RUN");
    summaries.set(file, summary);
  }
  const loaded = new Map<string, Record<string, unknown>>();
  const budget = Math.min(S.maximumEntryPrincipalUsd, S.entryPrincipalEquityFraction * S.initialCashUsd);
  for (const window of windows) for (const scenario of ["base", "stress"] as const) for (const policy of D.policies) {
    const file = `${window.id}-${scenario}-${policy}.json`, summary = summaries.get(file);
    if (!summary) fail(`MISSING_RUN:${file}`);
    const run = object(JSON.parse((await required(`${studyPath}/${file}`)).toString("utf8")));
    const { orders, weekly, ...runSummary } = run;
    const orderEntries = array(orders), weekEntries = array(weekly);
    if (!weekEntries.length) fail("MISSING_RUN_DETAIL");
    same(summary, { window: window.id, file, ...runSummary }, "RUN_SUMMARY_MISMATCH");
    if (run.version !== S.version || run.policy !== policy || run.scenario !== scenario
      || run.startMs !== window.startMs || run.endMs !== window.endMs || run.initialCashUsd !== S.initialCashUsd
      || run.initialEntryBudgetUsd !== budget || run.terminalFlat !== true || run.finalQuantity !== 0)
      fail("INVALID_RUN_SCOPE_OR_INVENTORY");
    const net = number(run.netPnlUsd), finalCash = number(run.finalCashUsd), realized = number(run.realizedNetUsd);
    if (finalCash < 0 || !near(finalCash - S.initialCashUsd, net) || !near(realized, net) || number(run.feesUsd) < 0
      || number(run.maxWeeklyCloseDrawdownUsd) < 0 || typeof run.accountDrawdownHalted !== "boolean") fail("RUN_ACCOUNTING_MISMATCH");
    const episodes = integer(run.closedEpisodes), buys = integer(run.buys), sells = integer(run.sells);
    if (episodes > Math.min(buys, sells) || orderEntries.length !== buys + sells) fail("RUN_COUNT_MISMATCH");
    const hurdle = budget * .05 * (window.endMs - window.startMs) / (365.25 * 86_400_000);
    if (!near(number(run.fivePercentInitialBudgetHurdleUsd), hurdle)
      || !near(number(run.netAboveAllocatedCapitalHurdleUsd), net - hurdle)) fail("RUN_HURDLE_MISMATCH");
    loaded.set(file, run);
  }
  const base = loaded.get("full-base-trend.json")!, stress = loaded.get("full-stress-trend.json")!;
  const stressHold = loaded.get("full-stress-buy-hold.json")!;
  const checks = {
    allRunsTerminalFlat: [...loaded.values()].every(run => run.terminalFlat === true),
    bothPrimaryScenariosPositive: [base, stress].every(run => number(run.netPnlUsd) > 0),
    enoughEpisodesInEachScenario: [base, stress].every(run => integer(run.closedEpisodes) >= D.minimumClosedEpisodes),
    lessStressDollarDrawdownThanBuyHold: number(stress.maxWeeklyCloseDrawdownUsd) < number(stressHold.maxWeeklyCloseDrawdownUsd),
    noAccountDrawdownHalt: [base, stress].every(run => run.accountDrawdownHalted === false),
    netExceedsAllocatedCapitalHurdleBothScenarios: [base, stress].every(run => number(run.netAboveAllocatedCapitalHurdleUsd) > 0),
  };
  same(report.checks, checks, "PAPER_CHECKS_MISMATCH");
  if (!Object.values(checks).every(Boolean)) fail("PAPER_SCREEN_FAILED");
  const bootstrap = object(report.bootstrap), lower = bootstrap.lowerMeanWeeklyNetUsd;
  if (lower !== null) number(lower);
  const completeWeeks = integer(bootstrap.completeWeeks);
  if (completeWeeks !== (base.weekly as unknown[]).length || integer(bootstrap.blocks) !== Math.max(0, completeWeeks - D.bootstrap.blockWeeks + 1)
    || report.lowerBootstrapMeanPositive !== (lower !== null && number(lower) > 0)) fail("BOOTSTRAP_SUMMARY_MISMATCH");
  if ("bootstrapLowerMeanWeeklyNetUsd" in audit && audit.bootstrapLowerMeanWeeklyNetUsd !== lower) fail("AUDIT_BOOTSTRAP_MISMATCH");
  const reportSha256 = hash(reportBytes), auditSha256 = hash(auditBytes);
  return { evidenceSha256: hash(JSON.stringify({ protocolSha256: hash(protocolBytes), reportSha256, auditSha256 })),
    reportSha256, auditSha256, sourceHashes: sourceHashes as Record<string, string>,
    summary: { baseNetUsd: number(base.netPnlUsd), stressNetUsd: number(stress.netPnlUsd), baseEpisodes: integer(base.closedEpisodes),
      stressEpisodes: integer(stress.closedEpisodes), lowerMeanWeeklyNetUsd: lower as number | null, provenProfitable: false } };
}
