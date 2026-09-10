import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readRecordedEvents } from "../backtest/replay.js";
import { loadConfig } from "../config.js";
import { LocalOrderBook } from "../core/order-book.js";
import { FeatureEngine } from "../core/features.js";
import { KrakenPaperBroker, loadKrakenFuturesInstruments } from "../kraken/paper-broker.js";
import { buildSystematicSignal } from "./signal.js";
import { loadSystematicHistory } from "./history.js";
import { buildSystematicPlan } from "./planner.js";
import { SYSTEMATIC_SPEC as S } from "./spec.js";

/** Real recorded books, in-memory broker only. This is a plumbing audit. A
 * five-minute archive cannot resolve hourly trade expectancy or funded P&L. */
async function main() {
  const recording = process.argv[2], output = process.argv[3];
  if (!recording || !output) throw new Error("Usage: execution-audit-main.ts RECORDING OUTPUT_DIRECTORY");
  const out = resolve(output); await mkdir(out, { recursive: true });
  const cfg = loadConfig({ TRADING_MODE: "paper" });
  let firstMs: number | undefined;
  for await (const event of readRecordedEvents(recording)) {
    if (event.kind === "BOOK") { firstMs = event.delta.receiveTsMs; break; }
  }
  if (firstMs === undefined) throw new Error("RECORDING_HAS_NO_BOOKS");
  const [bars, instruments] = await Promise.all([
    loadSystematicHistory(cfg.krakenFutures.productsBySymbol, firstMs),
    loadKrakenFuturesInstruments(cfg.krakenFutures.productsBySymbol),
  ]);
  const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
  const input = { spec: S, recording: resolve(recording), recordingSha256: sha(await readFile(recording)),
    asOfMs: firstMs, retrievedAtMs: Date.now(), bars, instruments: [...instruments.values()],
    configuration: cfg.symbolConfigs,
    limitations: ["Retrospectively retrieved closed candles; actual historical arrival time is unknown",
      "Current venue lot rules; no historical instrument metadata claim",
      "In-memory paper broker; no orders sent to the running engine or venue",
      "Entry plumbing only; positions left open are not profits or completed trades"] };
  await writeFile(`${out}/execution-input.json`, JSON.stringify(input), { flag: "wx" });
  const broker = new KrakenPaperBroker({ initialEquity: 100_000, productsBySymbol: cfg.krakenFutures.productsBySymbol,
    instruments, makerFeeBpsBySymbol: Object.fromEntries(cfg.symbols.map(s => [s, cfg.symbolConfigs[s]!.cost.makerFeeBps])),
    takerFeeBpsBySymbol: Object.fromEntries(cfg.symbols.map(s => [s, cfg.symbolConfigs[s]!.cost.takerFeeBps])) });
  const books = new Map(cfg.symbols.map(s => [s, new LocalOrderBook(s)]));
  const features = new Map(cfg.symbols.map(s => [s, new FeatureEngine(cfg.symbolConfigs[s]!.feature)]));
  const signals = new Map(cfg.symbols.map(s => [s, buildSystematicSignal(bars, s, firstMs!, firstMs!)]));
  const reasons: Record<string, Record<string, number>> = {};
  const attempts = new Map<string, { count: number; atMs: number }>();
  const firstCandidates: unknown[] = [];
  let events = 0, acceptedBooks = 0, invalidBooks = 0, disconnects = 0, lastMs = firstMs;
  for await (const event of readRecordedEvents(recording)) {
    events++;
    if (event.kind === "PRIVATE") continue;
    if (event.kind === "DISCONNECT" || event.kind === "RECORDER_GAP") {
      if (event.kind === "DISCONNECT" && event.stream === "private") continue;
      disconnects++; await broker.cancelAll(); for (const b of books.values()) b.invalidate(); continue;
    }
    if (event.kind === "TRADE") { features.get(event.trade.symbol)?.onTrade(event.trade); continue; }
    const local = books.get(event.delta.symbol), feature = features.get(event.delta.symbol);
    if (!local || !feature) continue;
    const update = local.apply(event.delta);
    if (update.duplicate) continue;
    if (!update.accepted || !update.state) { invalidBooks++; await broker.cancelAll(); continue; }
    acceptedBooks++; lastMs = Math.max(lastMs, event.delta.receiveTsMs);
    broker.onBook(event.delta);
    const f = feature.onBook(update.state, update.flow);
    if (!f) continue;
    const symbol = event.delta.symbol, instrument = instruments.get(symbol)!;
    const result = buildSystematicPlan({ config: cfg.symbolConfigs[symbol]!, book: update.state, features: f,
      signal: signals.get(symbol) ?? null, equity: 100_000, equityHighWater: 100_000, nowMs: event.delta.receiveTsMs,
      asset: { symbol, minOrderSize: instrument.quantityIncrement, minTradeIncrement: instrument.quantityIncrement,
        priceIncrement: instrument.tickSize, maximumOrderQty: instrument.maximumOrderQty, shortable: true } });
    const counts = reasons[symbol] ??= {}; counts[result.decision.reason] = (counts[result.decision.reason] ?? 0) + 1;
    if (!result.plan) continue;
    if (!firstCandidates.some(x => (x as { symbol: string }).symbol === symbol)) firstCandidates.push(result.decision);
    const history = broker.history();
    if (history.orders.some(o => Number(o.remote.filled_qty) > 0 || ["new", "partially_filled"].includes(o.remote.status))) continue;
    const key = result.plan.systematic!.signalId, previous = attempts.get(key);
    if (previous && (previous.count >= S.maximumPendingAttemptsPerSignal || event.delta.receiveTsMs - previous.atMs < S.retryMs)) continue;
    attempts.set(key, { count: (previous?.count ?? 0) + 1, atMs: event.delta.receiveTsMs });
    await broker.send(result.plan);
  }
  await broker.cancelAll();
  const history = broker.history();
  const fills = history.orders.filter(o => Number(o.remote.filled_qty) > 0).map(o => ({ symbol: o.plan.symbol,
    side: o.plan.side, qty: Number(o.remote.filled_qty), price: Number(o.remote.filled_avg_price),
    decisionAtMs: o.plan.createdMs, fillAtMs: Date.parse(o.remote.filled_at!),
    latencyMs: Date.parse(o.remote.filled_at!) - o.plan.createdMs, limitPx: o.plan.limitPx }));
  if (fills.some(f => f.latencyMs < S.entryLatencyMs || f.side * (f.price - f.limitPx) > 1e-8))
    throw new Error("RECORDED_BOOK_EXECUTION_INVARIANT");
  const report = { version: S.version, inputSha256: sha(JSON.stringify(input)), events, acceptedBooks, invalidBooks,
    disconnects, firstMs, lastMs, signals: Object.fromEntries(signals), reasons, firstCandidates,
    attempts: history.orders.length, fills, completedTrades: 0, fundedNetProfit: null,
    profitabilityEvidence: "UNAVAILABLE_SHORT_ENTRY_PLUMBING_AUDIT", activeEngineOrdersSent: 0 };
  await writeFile(`${out}/execution-audit.json`, JSON.stringify(report, null, 2), { flag: "wx" });
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
main().catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
