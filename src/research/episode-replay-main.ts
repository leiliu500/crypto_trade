import { createInterface } from "node:readline";
import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { readRecordedEvents, type RecordedEvent } from "../backtest/replay.js";
import { EpisodeResearchStore } from "./episode-store.js";
import { replayEpisodeExecutions } from "./episode-replay.js";
import { buildEpisodeReport } from "./episode-report.js";

const args = process.argv.slice(2);
const known = new Set(["--stdin", "--episodes", "--export", "--require-qualified"]);
if (args.some((arg) => arg.startsWith("--") && !known.has(arg))) throw new Error("Unknown replay option");
const paths = args.filter((arg) => !arg.startsWith("--"));
if ((args.includes("--stdin") ? 1 : 0) + (paths.length ? 1 : 0) !== 1) {
  throw new Error("Usage: research:replay -- [--episodes] [--export] capture.jsonl.gz [more captures...] OR --stdin");
}
loadLocalEnv();
const cfg = loadConfig(process.env, "replay");
const store = new EpisodeResearchStore(cfg.databaseUrl);
const sources = await (async () => {
  try {
    return args.includes("--episodes")
      ? (await store.loadEpisodes(cfg.configurationVersion)).filter((o) => o.scenario.id === "base-250ms")
      : await store.loadEntries(cfg.configurationVersion);
  } finally { await store.close(); }
})();
async function* events(): AsyncGenerator<RecordedEvent> {
  if (args.includes("--stdin")) {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      if (line.trim()) yield JSON.parse(line) as RecordedEvent;
    }
  } else for (const path of paths) yield* readRecordedEvents(path);
}
const { observations, ...audit } = await replayEpisodeExecutions(events(), sources);
const report = buildEpisodeReport(observations);
if (args.includes("--export")) for (const row of observations) process.stdout.write(`${JSON.stringify(row)}\n`);
else process.stdout.write(`${JSON.stringify({ ...audit, report }, null, 2)}\n`);
if (audit.baselineParity.mismatches.length || observations.some((o) => o.status !== "COMPLETE")) process.exitCode = 2;
else if (args.includes("--require-qualified") && !report.cohorts.some((c) => c.researchQualified)) process.exitCode = 3;
