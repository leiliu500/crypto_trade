import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { loadLocalEnv } from "../env.js";
import { loadConfig } from "../config.js";
import { policyReserveBps } from "./policy-planner.js";
import { CROSS_ASSET_SYMBOLS, type CrossAssetQuote } from "./cross-asset-model.js";
import { compareModelExperiments } from "./model-experiment.js";

loadLocalEnv();
const args = process.argv.slice(2), path = args[0];
if (!path || path.startsWith("--") || args.length !== 3
  || args.filter(a => a.startsWith("--start=")).length !== 1
  || args.filter(a => a.startsWith("--holdout=")).length !== 1) {
  throw new Error("Supply quotes.jsonl --start=ISO_TIMESTAMP --holdout=ISO_TIMESTAMP");
}
const entryStartMs = Date.parse(args.find(a => a.startsWith("--start="))!.slice(8));
const holdoutStartMs = Date.parse(args.find(a => a.startsWith("--holdout="))!.slice(10));
const cfg = loadConfig(process.env, "replay");
const costs = Object.fromEntries(CROSS_ASSET_SYMBOLS.map(symbol => {
  const c = cfg.symbolConfigs[symbol]; if (!c) throw new Error(`Missing configuration for ${symbol}`);
  return [symbol, { feeBps: c.cost.takerFeeBps, reserveBps: policyReserveBps(c) }];
}));
async function* source(): AsyncGenerator<CrossAssetQuote> {
  for await (const line of createInterface({ input: createReadStream(path!), crlfDelay: Infinity })) {
    if (line.trim()) yield JSON.parse(line) as CrossAssetQuote;
  }
}
process.stdout.write(`${JSON.stringify(await compareModelExperiments(source, costs, entryStartMs, holdoutStartMs), null, 2)}\n`);
