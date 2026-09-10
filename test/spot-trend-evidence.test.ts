import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { downloadSpotWeeks, WEEK_MS } from "../src/spot-trend/data.js";
import { loadSpotPaperEvidence } from "../src/spot-trend/evidence.js";
import { SPOT_TREND_SPEC as S, SPOT_TREND_STUDY as D } from "../src/spot-trend/spec.js";
import { SPOT_STUDY_SOURCES } from "../src/spot-trend/study-main.js";

const sha = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const STUDY = "reports/test-spot/historical-study", DATA = "reports/test-spot/market-data", AUDIT = "reports/test-spot/audit.json";
const json = async (path: string, value: unknown): Promise<void> => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value) + "\n"); };
const document = async (path: string): Promise<Record<string, any>> => JSON.parse(await readFile(path, "utf8")) as Record<string, any>;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "spot-paper-evidence-"));
  await mkdir(join(root, "reports/test-spot"), { recursive: true });
  const now = D.endMsExclusive + 60_000, rows: unknown[][] = [];
  for (let at = Date.UTC(2015, 11, 31); at <= D.endMsExclusive; at += WEEK_MS)
    rows.push([at / 1000, "100", "110", "90", "105", "102", "10", 12]);
  const data = await downloadSpotWeeks(join(root, DATA), { nowMs: now,
    fetcher: async () => new Response(JSON.stringify({ error: [], result: { XXBTZUSD: rows, last: now / 1000 } })) });
  const sourceHashes: Record<string, string> = {};
  for (const path of SPOT_STUDY_SOURCES) {
    const bytes = `fixture source ${path}\n`; sourceHashes[path] = sha(bytes);
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes);
    await mkdir(dirname(join(root, STUDY, "sources", path)), { recursive: true }); await writeFile(join(root, STUDY, "sources", path), bytes);
  }
  const datasetSha256 = sha(await readFile(join(root, DATA, "dataset.json")));
  await json(join(root, STUDY, "protocol.json"), { strategy: S, study: D, sourceHashes,
    inputDirectory: join(root, DATA), inputManifestSha256: sha(await readFile(join(root, DATA, "manifest.json"))), datasetSha256,
    historicalStrategyOutcomesComputedBeforeSeal: false, independentHoldoutClaimed: false,
    recentHistoryPreviouslyUsedByOtherCandidates: true, parameterGrid: false });
  const runs: Record<string, unknown>[] = [];
  for (const window of [{ id: "full", startMs: D.startMs, endMs: D.endMsExclusive }, ...D.periods])
    for (const scenario of ["base", "stress"] as const) for (const policy of D.policies) {
      const file = `${window.id}-${scenario}-${policy}.json`;
      const net = policy === "cash" ? 0 : scenario === "base" ? 100 : 90;
      const episodes = policy === "cash" ? 0 : policy === "trend" ? 8 : 1;
      const budget = Math.min(S.maximumEntryPrincipalUsd, S.entryPrincipalEquityFraction * S.initialCashUsd);
      const hurdle = budget * .05 * (window.endMs - window.startMs) / (365.25 * 86_400_000);
      const run = { version: S.version, policy, scenario, startMs: window.startMs, endMs: window.endMs,
        initialCashUsd: S.initialCashUsd, initialEntryBudgetUsd: budget, finalCashUsd: S.initialCashUsd + net,
        finalQuantity: 0, netPnlUsd: net, realizedNetUsd: net, feesUsd: policy === "cash" ? 0 : 1,
        closedEpisodes: episodes, buys: episodes, sells: episodes, accountDrawdownHalted: false, terminalFlat: true,
        maxWeeklyCloseDrawdownUsd: policy === "trend" ? 5 : 10,
        fivePercentInitialBudgetHurdleUsd: hurdle, netAboveAllocatedCapitalHurdleUsd: net - hurdle,
        orders: Array.from({ length: episodes * 2 }, (_, i) => ({ id: `${file}:${i}` })),
        weekly: Array.from({ length: 16 }, (_, i) => ({ weeklyNetUsd: i === 0 ? net : 0 })) };
      await json(join(root, STUDY, file), run);
      const { orders: _o, weekly: _w, ...summary } = run;
      runs.push({ window: window.id, file, ...summary });
    }
  await json(join(root, STUDY, "report.json"), { strategyVersion: S.version, sourceHashes, sourceDataSha256: data.sourceSha256,
    datasetSha256, coverage: data.coverage, researchPaperEligible: true, provenProfitable: false,
    independentValidationPassed: false, liveTradingAllowed: false,
    checks: { allRunsTerminalFlat: true, bothPrimaryScenariosPositive: true, enoughEpisodesInEachScenario: true,
      lessStressDollarDrawdownThanBuyHold: true, noAccountDrawdownHalt: true, netExceedsAllocatedCapitalHurdleBothScenarios: true },
    bootstrap: { lowerMeanWeeklyNetUsd: -.5, completeWeeks: 16, blocks: 4 }, lowerBootstrapMeanPositive: false, runs });
  const paths = [`${STUDY}/protocol.json`, `${STUDY}/report.json`, ...SPOT_STUDY_SOURCES,
    ...SPOT_STUDY_SOURCES.map(path => `${STUDY}/sources/${path}`),
    ...["source.json", "dataset.json", "manifest.json", "registration.json"].map(file => `${DATA}/${file}`),
    ...runs.map(run => `${STUDY}/${String(run.file)}`)];
  const fileHashes: Record<string, string> = {};
  for (const path of paths) fileHashes[path] = sha(await readFile(join(root, path)));
  await json(join(root, AUDIT), { passed: true, checks: 1000, fileHashes, studyDirectory: STUDY, dataDirectory: DATA,
    strategyVersion: S.version, researchPaperEligible: true, provenProfitable: false,
    independentProspectiveValidationPassed: false, liveTradingAllowed: false, bootstrapLowerMeanWeeklyNetUsd: -.5 });
  const bind = async (path: string) => {
    const audit = await document(join(root, AUDIT)); audit.fileHashes[path] = sha(await readFile(join(root, path)));
    await json(join(root, AUDIT), audit);
  };
  return { root, bind, load: () => loadSpotPaperEvidence(STUDY, AUDIT, root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("audited research nomination loads with negative uncertainty and never claims proven profit", async () => {
  const f = await fixture();
  try {
    const result = await f.load();
    assert.deepEqual(result.summary, { baseNetUsd: 100, stressNetUsd: 90, baseEpisodes: 8, stressEpisodes: 8,
      lowerMeanWeeklyNetUsd: -.5, provenProfitable: false });
    assert.match(result.evidenceSha256, /^[a-f0-9]{64}$/);
    assert.equal(result.reportSha256, sha(await readFile(join(f.root, STUDY, "report.json"))));
    assert.equal(result.auditSha256, sha(await readFile(join(f.root, AUDIT))));
    assert.deepEqual(await f.load(), result);
  } finally { await f.cleanup(); }
});

test("missing required run, source copy or data bindings cannot inherit a passed audit", async () => {
  const f = await fixture();
  try {
    const original = await document(join(f.root, AUDIT));
    for (const path of [`${STUDY}/full-stress-trend.json`, `${STUDY}/sources/src/spot-trend/spec.ts`, `${DATA}/source.json`]) {
      const changed = structuredClone(original); delete changed.fileHashes[path]; await json(join(f.root, AUDIT), changed);
      await assert.rejects(f.load(), /MISSING_AUDIT_BINDING/);
    }
  } finally { await f.cleanup(); }
});

test("source edits and artifact edits after the audit fail hash validation", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "src/spot-trend/signal.ts"), "changed source\n");
    await assert.rejects(f.load(), /AUDIT_FILE_HASH_MISMATCH/);
    await f.bind("src/spot-trend/signal.ts");
    await assert.rejects(f.load(), /SOURCE_CHANGED/);
  } finally { await f.cleanup(); }
});

test("profit claims, missing eligibility and protocol retuning fail even with updated hashes", async () => {
  const f = await fixture();
  try {
    const reportPath = `${STUDY}/report.json`, original = await document(join(f.root, reportPath));
    for (const mutation of [{ provenProfitable: true }, { independentValidationPassed: true },
      { liveTradingAllowed: true }, { researchPaperEligible: false }]) {
      await json(join(f.root, reportPath), { ...original, ...mutation }); await f.bind(reportPath);
      await assert.rejects(f.load(), /NOT_RESEARCH_PAPER_ONLY/);
    }
    await json(join(f.root, reportPath), original); await f.bind(reportPath);
    const protocolPath = `${STUDY}/protocol.json`, protocol = await document(join(f.root, protocolPath));
    protocol.strategy.movingAverageWeeks = 20; await json(join(f.root, protocolPath), protocol); await f.bind(protocolPath);
    await assert.rejects(f.load(), /STRATEGY_MISMATCH/);
  } finally { await f.cleanup(); }
});

test("failed audits, hidden failures and duplicate run substitutions are rejected", async () => {
  const f = await fixture();
  try {
    const original = await document(join(f.root, AUDIT));
    for (const mutation of [{ passed: false }, { checks: 0 }, { failures: ["cash"] }, { failedChecks: 1 }]) {
      await json(join(f.root, AUDIT), { ...original, ...mutation });
      await assert.rejects(f.load(), /AUDIT_/);
    }
    await json(join(f.root, AUDIT), original);
    const reportPath = `${STUDY}/report.json`, report = await document(join(f.root, reportPath));
    report.runs[1] = report.runs[0]; await json(join(f.root, reportPath), report); await f.bind(reportPath);
    await assert.rejects(f.load(), /DUPLICATE_OR_INVALID_RUN/);
  } finally { await f.cleanup(); }
});

test("altered run summaries and synchronized nonflat inventory fail independent gate checks", async () => {
  const f = await fixture();
  try {
    const reportPath = `${STUDY}/report.json`, report = await document(join(f.root, reportPath));
    report.runs[0].netPnlUsd += 1; await json(join(f.root, reportPath), report); await f.bind(reportPath);
    await assert.rejects(f.load(), /RUN_SUMMARY_MISMATCH/);
    report.runs[0].netPnlUsd -= 1;
    const runPath = `${STUDY}/full-base-trend.json`, run = await document(join(f.root, runPath));
    run.finalQuantity = 1; report.runs[0].finalQuantity = 1;
    await json(join(f.root, runPath), run); await f.bind(runPath);
    await json(join(f.root, reportPath), report); await f.bind(reportPath);
    await assert.rejects(f.load(), /INVALID_RUN_SCOPE_OR_INVENTORY/);
  } finally { await f.cleanup(); }
});

test("unsafe relative paths and source symlinks escaping the repository are rejected", async () => {
  const f = await fixture(), outside = await mkdtemp(join(tmpdir(), "spot-evidence-outside-"));
  try {
    const original = await document(join(f.root, AUDIT));
    for (const path of ["../private.json", "reports/../private.json", "/tmp/private.json", ".env", "reports/a\\b.json"]) {
      const altered = structuredClone(original); altered.fileHashes[path] = "a".repeat(64);
      await json(join(f.root, AUDIT), altered); await assert.rejects(f.load(), /UNSAFE_PATH/);
    }
    await json(join(f.root, AUDIT), original);
    const local = join(f.root, "src/spot-trend/signal.ts"), external = join(outside, "source.ts");
    await writeFile(external, await readFile(local)); await rm(local); await symlink(external, local);
    await assert.rejects(f.load(), /SYMLINK_ESCAPE/);
  } finally { await f.cleanup(); await rm(outside, { recursive: true, force: true }); }
});

test("paper economic checks cannot be satisfied by retained report booleans alone", async () => {
  const f = await fixture();
  try {
    const runPath = `${STUDY}/full-stress-trend.json`, run = await document(join(f.root, runPath));
    const reportPath = `${STUDY}/report.json`, report = await document(join(f.root, reportPath));
    run.maxWeeklyCloseDrawdownUsd = 100;
    report.runs.find((entry: Record<string, unknown>) => entry.file === "full-stress-trend.json").maxWeeklyCloseDrawdownUsd = 100;
    await json(join(f.root, runPath), run); await f.bind(runPath);
    await json(join(f.root, reportPath), report); await f.bind(reportPath);
    await assert.rejects(f.load(), /PAPER_CHECKS_MISMATCH/);
  } finally { await f.cleanup(); }
});
