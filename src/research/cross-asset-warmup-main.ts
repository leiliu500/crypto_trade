import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { policyReserveBps } from "./policy-planner.js";
import { CROSS_ASSET_SYMBOLS } from "./cross-asset-model.js";
import { readCrossAssetHistory } from "./cross-asset-history.js";
import { warmCrossAssetHistory } from "./cross-asset-warmup.js";

loadLocalEnv();
if (process.argv.length > 2) throw new Error("Historical warmup takes no arguments");
const cfg = loadConfig(process.env, "replay"), cutoffMs = Date.now();
const costs = Object.fromEntries(CROSS_ASSET_SYMBOLS.map((symbol) => {
  const c = cfg.symbolConfigs[symbol]; if (!c) throw new Error(`Missing configuration for ${symbol}`);
  return [symbol, { feeBps: c.cost.takerFeeBps, reserveBps: policyReserveBps(c) }];
}));
const { model, bootstrap } = await warmCrossAssetHistory(readCrossAssetHistory(cfg.databaseUrl, cutoffMs), costs, cutoffMs);
process.stdout.write(`${JSON.stringify({ ...bootstrap, learning: model.stats(), ordersSubmitted: 0,
  purpose: "HISTORICAL_TRAINING_CHECK_ONLY", profitabilityEstablished: false }, null, 2)}\n`);
if (!bootstrap.trainingReady) process.exitCode = 2;
