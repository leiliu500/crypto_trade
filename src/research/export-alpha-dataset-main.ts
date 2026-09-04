import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { AlphaResearchStore } from "./alpha-research-store.js";

loadLocalEnv();
const cfg = loadConfig(process.env);
const requestedVersion = argumentValue(process.argv, "--configuration-version")
  ?? process.env.ALPHA_CONFIGURATION_VERSION ?? cfg.configurationVersion;
const includeAllVersions = process.argv.includes("--all-versions");
const store = new AlphaResearchStore(cfg.databaseUrl);

try {
  const observations = await store.loadObservations(includeAllVersions ? undefined : requestedVersion);
  for (const observation of observations) process.stdout.write(`${JSON.stringify(observation)}\n`);
} finally {
  await store.close();
}

function argumentValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
}
