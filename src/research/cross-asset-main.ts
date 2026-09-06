import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { policyReserveBps } from "./policy-planner.js";
import { CROSS_ASSET_SYMBOLS, type CrossAssetQuote } from "./cross-asset-model.js";
import { replayCrossAsset } from "./cross-asset-replay.js";

loadLocalEnv();
const args = process.argv.slice(2);
if (args.length !== 1 || args[0]!.startsWith("--")) throw new Error("Supply a chronological BTC/ETH quote JSONL file");
const cfg = loadConfig(process.env, "replay");
const costs = Object.fromEntries(CROSS_ASSET_SYMBOLS.map((s) => {
  const c = cfg.symbolConfigs[s]; if (!c) throw new Error(`Missing configuration for ${s}`);
  return [s, { feeBps: c.cost.takerFeeBps, reserveBps: policyReserveBps(c) }];
}));
async function* quotes(): AsyncGenerator<CrossAssetQuote> {
  for await (const line of createInterface({ input: createReadStream(args[0]!), crlfDelay: Infinity })) {
    if (line.trim()) yield JSON.parse(line) as CrossAssetQuote;
  }
}
process.stdout.write(`${JSON.stringify(await replayCrossAsset(quotes(), costs), null, 2)}\n`);
