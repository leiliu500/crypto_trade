import { analyzeOpportunityRecall } from "./opportunity-recall.js";
import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";

loadLocalEnv();
const cfg = loadConfig(process.env, "replay");
const recordingPaths = process.argv.slice(2);
const report = await analyzeOpportunityRecall(recordingPaths.length > 0 ? recordingPaths : cfg.replayFile, cfg,
  { economicOnly: process.env.RECALL_ECONOMIC_ONLY === "true" });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (process.env.RECALL_REQUIRE_PROFITABLE_LONG === "true"
  && report.acceptance.profitableAfterCostLongSignals === 0) process.exitCode = 1;
if (process.env.RECALL_REQUIRE_PROFITABLE_ENTRY === "true" && !report.acceptance.passed) process.exitCode = 1;
