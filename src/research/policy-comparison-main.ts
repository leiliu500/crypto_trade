import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { EpisodeResearchStore } from "./episode-store.js";
import { comparePolicyExits } from "./policy-comparison.js";

loadLocalEnv();
if (process.argv.length > 2) throw new Error("This report takes no options");
const cfg = loadConfig(process.env, "replay");
const store = new EpisodeResearchStore(cfg.databaseUrl);
try {
  const entries = await store.loadEntries(cfg.configurationVersion);
  const episodes = await store.loadEpisodes(cfg.configurationVersion);
  process.stdout.write(`${JSON.stringify(comparePolicyExits([...entries, ...episodes]), null, 2)}\n`);
} finally { await store.close(); }
