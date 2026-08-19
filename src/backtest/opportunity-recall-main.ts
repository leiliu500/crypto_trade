import { analyzeOpportunityRecall } from "./opportunity-recall.js";
import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";

loadLocalEnv();
const cfg = loadConfig(process.env, "replay");
const recordingPath = process.argv[2] ?? cfg.replayFile;
const report = await analyzeOpportunityRecall(recordingPath, cfg);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
