import { loadLocalEnv } from "../env.js";
import { loadConfig } from "../config.js";
import { readRecordedEvents } from "../backtest/replay.js";
import { loadKrakenFuturesInstruments } from "../kraken/paper-broker.js";
import { replayRetest } from "./retest-replay.js";
import { policyReserveBps } from "./policy-planner.js";
loadLocalEnv();
const paths = process.argv.slice(2);
if (!paths.length || paths.some((p) => p.startsWith("--"))) throw new Error("Supply chronological recording paths");
const cfg = loadConfig(process.env, "replay");
const instruments = await loadKrakenFuturesInstruments(cfg.krakenFutures.productsBySymbol);
const rules = new Map([...instruments].map(([symbol, i]) => [symbol, {
  asset: { symbol, minOrderSize: i.quantityIncrement, minTradeIncrement: i.quantityIncrement,
    priceIncrement: i.tickSize, maximumOrderQty: i.maximumOrderQty, shortable: true },
  feeBps: cfg.symbolConfigs[symbol]!.cost.takerFeeBps, reserveBps: policyReserveBps(cfg.symbolConfigs[symbol]!) }]));
async function* events() { for (const path of paths) yield* readRecordedEvents(path); }
const report = await replayRetest(events(), rules);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.quality.gaps || report.quality.invalidBooks || report.cohorts.some((c) => c.invalid)) process.exitCode = 2;
