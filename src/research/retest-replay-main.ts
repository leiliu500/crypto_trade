import { loadLocalEnv } from "../env.js";
import { loadConfig } from "../config.js";
import { readRecordedEvents } from "../backtest/replay.js";
import { loadKrakenFuturesInstruments } from "../kraken/paper-broker.js";
import { replayRetest } from "./retest-replay.js";
import { policyReserveBps } from "./policy-planner.js";
loadLocalEnv();
const args = process.argv.slice(2);
const rangeOptions = args.filter(a => a.startsWith("--range-minutes="));
if (rangeOptions.length > 1) throw new Error("Supply only one range option");
const rangeMinutes = rangeOptions.length ? Number(rangeOptions[0]!.split("=")[1]) : 1;
if (![1, 5, 15].includes(rangeMinutes)) throw new Error("Range minutes must be 1, 5, or 15");
const paths = args.filter(a => !a.startsWith("--range-minutes="));
if (!paths.length || paths.some((p) => p.startsWith("--"))) throw new Error("Supply chronological recording paths");
const cfg = loadConfig(process.env, "replay");
const instruments = await loadKrakenFuturesInstruments(cfg.krakenFutures.productsBySymbol);
const rules = new Map([...instruments].map(([symbol, i]) => [symbol, {
  asset: { symbol, minOrderSize: i.quantityIncrement, minTradeIncrement: i.quantityIncrement,
    priceIncrement: i.tickSize, maximumOrderQty: i.maximumOrderQty, shortable: true },
  feeBps: cfg.symbolConfigs[symbol]!.cost.takerFeeBps, reserveBps: policyReserveBps(cfg.symbolConfigs[symbol]!) }]));
async function* events() { for (const path of paths) yield* readRecordedEvents(path); }
const report = await replayRetest(events(), rules, rangeMinutes * 60_000);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.quality.gaps || report.quality.invalidBooks || report.cohorts.some((c) => c.invalid)) process.exitCode = 2;
