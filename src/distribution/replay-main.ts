import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { readRecordedEvents } from "../backtest/replay.js";
import { loadKrakenFuturesInstruments } from "../kraken/paper-broker.js";
import { policyReserveBps } from "../research/policy-planner.js";
import type { AssetRules } from "../execution/planner.js";
import { DistributionController } from "./controller.js";
import { replayDistribution } from "./replay.js";
import { DISTRIBUTION_SPEC } from "./spec.js";

loadLocalEnv();
const args = process.argv.slice(2), paths = args.filter(a => !a.startsWith("--"));
const allowed = ["validation-start", "later-start", "assets", "state-out"];
const flags = new Map<string, string>();
let includeOutcomes = false;
for (const arg of args.filter(a => a.startsWith("--"))) {
  if (arg === "--include-outcomes" && !includeOutcomes) { includeOutcomes = true; continue; }
  const index = arg.indexOf("="), key = arg.slice(2, index), value = arg.slice(index + 1);
  if (index < 3 || !allowed.includes(key) || !value || flags.has(key)) throw new Error(`Invalid or duplicate option ${arg}`);
  flags.set(key, value);
}
const validationStartMs = Date.parse(flags.get("validation-start") ?? ""), laterStartMs = Date.parse(flags.get("later-start") ?? "");
if (!paths.length || !Number.isFinite(validationStartMs) || !Number.isFinite(laterStartMs) || validationStartMs >= laterStartMs) {
  throw new Error("Usage: research:distribution --validation-start=ISO --later-start=ISO [--assets=rules.json] [--include-outcomes] [--state-out=model.json] chronological-recording.jsonl[.gz] ...");
}
const cfg = loadConfig(process.env, "replay");
let assets: Record<string, AssetRules>;
if (flags.has("assets")) assets = JSON.parse(await readFile(flags.get("assets")!, "utf8")) as Record<string, AssetRules>;
else {
  const instruments = await loadKrakenFuturesInstruments(cfg.krakenFutures.productsBySymbol);
  assets = Object.fromEntries([...instruments].map(([symbol, i]) => [symbol, { symbol,
    minOrderSize: i.quantityIncrement, minTradeIncrement: i.quantityIncrement, priceIncrement: i.tickSize,
    maximumOrderQty: i.maximumOrderQty, shortable: true }]));
}
const costs = Object.fromEntries(DISTRIBUTION_SPEC.symbols.map(symbol => {
  const config = cfg.symbolConfigs[symbol], asset = assets[symbol];
  if (!config || !asset || asset.symbol !== symbol || ![asset.minOrderSize, asset.minTradeIncrement, asset.priceIncrement,
    asset.maximumOrderQty].every(n => Number.isFinite(n) && n > 0) || typeof asset.shortable !== "boolean") {
    throw new Error(`Missing or invalid costs/instrument rules for ${symbol}`);
  }
  return [symbol, { feeBps: config.cost.takerFeeBps, reserveBps: policyReserveBps(config) }];
}));
const inputFiles = [];
for (const path of paths) {
  const info = await stat(path), hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  inputFiles.push({ path, bytes: info.size, modifiedMs: info.mtimeMs, sha256: hash.digest("hex") });
}
async function* events() {
  let count = 0, lastProgressMs = Date.now();
  for (const path of paths) for await (const event of readRecordedEvents(path)) {
    count++;
    if (count % 10_000 === 0 && Date.now() - lastProgressMs >= 60_000) {
      const atMs = event.kind === "BOOK" ? event.delta.receiveTsMs : event.kind === "TRADE" ? event.trade.receiveTsMs
        : event.kind === "PRIVATE" ? null : event.receiveTsMs;
      process.stderr.write(`Replayed ${count} raw events${atMs !== null && Number.isFinite(atMs) ? ` through ${new Date(atMs).toISOString()}` : ""}\n`);
      lastProgressMs = Date.now();
    }
    yield event;
  }
}
const controller = new DistributionController(costs, assets);
const report = await replayDistribution(events(), costs, assets, { validationStartMs, laterStartMs, includeOutcomes }, controller);
for (const file of inputFiles) {
  const after = await stat(file.path);
  if (after.size !== file.bytes || after.mtimeMs !== file.modifiedMs) throw new Error(`Recording changed while replaying: ${file.path}`);
}
if (flags.has("state-out")) await writeFile(flags.get("state-out")!, `${JSON.stringify(controller.exportState())}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ ...report, inputFiles,
  instrumentRuleSource: flags.get("assets") ?? "Current Kraken instruments endpoint; not historical rule snapshots" }, null, 2)}\n`);
