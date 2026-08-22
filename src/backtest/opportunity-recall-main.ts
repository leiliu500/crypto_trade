import { analyzeOpportunityRecall } from "./opportunity-recall.js";
import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";

loadLocalEnv();
const cfg = loadConfig(process.env, "replay");
const recordingPath = process.argv[2] ?? cfg.replayFile;
const report = await analyzeOpportunityRecall(recordingPath, cfg, { economicOnly: process.env.RECALL_ECONOMIC_ONLY === "true" });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (process.env.RECALL_REQUIRE_PROFITABLE_LONG === "true" && !report.acceptance.passed) process.exitCode = 1;
