import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { EpisodeResearchStore } from "./episode-store.js";
import { buildEpisodeReport } from "./episode-report.js";

loadLocalEnv();
if (process.argv.slice(2).some((arg) => !["--export", "--require-qualified"].includes(arg))) throw new Error("Unknown episode report option");
const cfg = loadConfig(process.env, "replay");
const store = new EpisodeResearchStore(cfg.databaseUrl);
try {
  const rows = await store.loadEpisodes(cfg.configurationVersion);
  const report = buildEpisodeReport(rows);
  if (process.argv.includes("--export")) for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (process.argv.includes("--require-qualified") && !report.cohorts.some((c) => c.researchQualified)) process.exitCode = 3;
} finally { await store.close(); }
