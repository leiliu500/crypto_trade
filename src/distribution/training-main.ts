import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { loadKrakenFuturesInstruments } from "../kraken/paper-broker.js";
import { policyReserveBps } from "../research/policy-planner.js";
import type { AssetRules } from "../execution/planner.js";
import { DISTRIBUTION_SPEC } from "./spec.js";
import { prepareDistributionTraining } from "./training-backfill.js";

loadLocalEnv();
const args = process.argv.slice(2), paths = args.filter(arg => !arg.startsWith("--"));
const flags = new Map<string, string>(), allowed = ["state-out", "state-in", "assets", "cutoff"];
for (const arg of args.filter(arg => arg.startsWith("--"))) {
  const index = arg.indexOf("="), key = arg.slice(2, index), value = arg.slice(index + 1);
  if (index < 3 || !allowed.includes(key) || !value || flags.has(key)) throw new Error(`Invalid or duplicate option ${arg}`);
  flags.set(key, value);
}
const cutoffMs = flags.has("cutoff") ? Date.parse(flags.get("cutoff")!) : Date.now();
if (!paths.length || !flags.has("state-out") || !Number.isSafeInteger(cutoffMs) || cutoffMs < 0)
  throw new Error("Usage: research:distribution:train --state-out=new-training.json [--state-in=earlier-training.json] [--assets=rules.json] [--cutoff=ISO] chronological-recording.jsonl[.gz] ...");
const cfg = loadConfig(process.env, "replay");
let assets: Record<string, AssetRules>;
if (flags.has("assets")) assets = JSON.parse(await readFile(flags.get("assets")!, "utf8")) as Record<string, AssetRules>;
else {
  const instruments = await loadKrakenFuturesInstruments(cfg.krakenFutures.productsBySymbol);
  assets = Object.fromEntries([...instruments].map(([symbol, instrument]) => [symbol, { symbol,
    minOrderSize: instrument.quantityIncrement, minTradeIncrement: instrument.quantityIncrement,
    priceIncrement: instrument.tickSize, maximumOrderQty: instrument.maximumOrderQty, shortable: true }]));
}
const costs = Object.fromEntries(DISTRIBUTION_SPEC.symbols.map(symbol => {
  const config = cfg.symbolConfigs[symbol];
  if (!config) throw new Error(`Missing cost configuration for ${symbol}`);
  return [symbol, { feeBps: config.cost.takerFeeBps, reserveBps: policyReserveBps(config) }];
}));
const prepared = await prepareDistributionTraining(paths, flags.get("state-out")!, costs, assets, {
  cutoffMs, ...(flags.has("state-in") ? { stateIn: flags.get("state-in")! } : {}),
  instrumentRuleSource: flags.get("assets") ?? "Current Kraken public instruments endpoint; not historical rules",
  onProgress: ({ events, atMs, file }) => process.stderr.write(`Training replay: ${events} events${atMs === null ? "" : ` through ${new Date(atMs).toISOString()}`} (${file})\n`),
});
process.stdout.write(`${JSON.stringify(prepared.report, null, 2)}\n`);
