import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { DEFAULT_ALPHA_PROMOTION_POLICY, evaluateAlphaResearch } from "./alpha-research.js";
import { AlphaResearchStore } from "./alpha-research-store.js";

loadLocalEnv();
const cfg = loadConfig(process.env);
const requestedVersion = argumentValue(process.argv, "--configuration-version")
  ?? process.env.ALPHA_CONFIGURATION_VERSION ?? cfg.configurationVersion;
const includeAllVersions = process.argv.includes("--all-versions");
const persist = !process.argv.includes("--no-save");
const summaryOnly = process.argv.includes("--summary");
const store = new AlphaResearchStore(cfg.databaseUrl);

try {
  const observations = await store.loadObservations(includeAllVersions ? undefined : requestedVersion);
  const report = evaluateAlphaResearch(observations, DEFAULT_ALPHA_PROMOTION_POLICY);
  if (persist) await store.saveReport(report, includeAllVersions ? report.configurationVersions : [requestedVersion]);
  const output = summaryOnly ? {
    generatedAtMs: report.generatedAtMs,
    policy: report.policy,
    observations: report.observations,
    configurationVersions: report.configurationVersions,
    cohorts: report.cohorts.length,
    promotedCohorts: report.promotedCohorts,
    rejectedCohorts: report.rejectedCohorts,
    rejectionCounts: rejectionCounts(report.cohorts.flatMap((cohort) => cohort.rejectionReasons)),
    persisted: persist,
  } : { ...report, persisted: persist };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  await store.close();
}

function argumentValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function rejectionCounts(reasons: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
}
