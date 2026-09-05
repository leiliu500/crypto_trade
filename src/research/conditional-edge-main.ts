import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { EpisodeResearchStore } from "./episode-store.js";
import { analyzeConditionalEdge } from "./conditional-edge.js";

loadLocalEnv();
if (process.argv.slice(2).some((arg) => arg !== "--summary")) throw new Error("Unknown conditional-edge option");
const cfg = loadConfig(process.env, "replay");
const store = new EpisodeResearchStore(cfg.databaseUrl);
try {
  const entries = await store.loadEntries(cfg.configurationVersion);
  const episodes = await store.loadEpisodes(cfg.configurationVersion);
  const report = analyzeConditionalEdge([...entries, ...episodes]);
  const output = process.argv.includes("--summary") ? { ...report,
    cohorts: report.cohorts.map(({ forecasts, ...cohort }) => cohort) } : report;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally { await store.close(); }
