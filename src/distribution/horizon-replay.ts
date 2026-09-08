import type { RecordedEvent } from "../backtest/replay.js";
import type { BookState, MarketTrade } from "../core/market.js";
import { LocalOrderBook } from "../core/order-book.js";
import type { AssetRules } from "../execution/planner.js";
import { policyQuantity } from "../research/trading-policy.js";
import { DistributionExecutionCase } from "./execution.js";
import { DistributionMarket, distributionBookReason, type DistributionPriceSample } from "./market.js";
import { DISTRIBUTION_SCENARIOS, DISTRIBUTION_SPEC as S } from "./spec.js";
import { buildHorizonResearchActions, HORIZON_RESEARCH_SPEC as H, type HorizonResearchAction } from "./horizon-spec.js";
import { StreamingHorizonAssessment, type HorizonResearchPanel } from "./horizon-assessment.js";

export interface HorizonReplayOptions {
  trainingStartMs: number; laterStartMs: number; cutoffMs: number; includePanels?: boolean;
}
type Costs = Readonly<Record<string, { feeBps: number; reserveBps: number }>>;
interface PendingPanel {
  symbol: string; signalAtMs: number; features: number[]; volatility30mBps: number;
  paths: Array<{ action: HorizonResearchAction; cases: DistributionExecutionCase[] }>;
  cases: DistributionExecutionCase[];
  active: DistributionExecutionCase[];
}

/** Same elapsed-time variance-rate proxy as DistributionMarket, before feature
 * clipping. Uses only observed price endpoints available at the origin. */
export function horizonVolatility30mBps(samples: readonly DistributionPriceSample[], nowMs: number, mid: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isFinite(mid) || mid <= 0
    || !samples.length || samples.some((p, i) => !Number.isSafeInteger(p.atMs) || p.atMs < 0 || p.atMs > nowMs
      || !Number.isFinite(p.mid) || p.mid <= 0 || (i > 0 && p.atMs <= samples[i - 1]!.atMs))) {
    throw new Error("INVALID_HORIZON_VOLATILITY_HISTORY");
  }
  if (!samples.some(p => p.atMs <= nowMs - H.volatilityLookbackMs)) throw new Error("HORIZON_VOLATILITY_WARMUP");
  const path = samples.filter(p => p.atMs >= nowMs - H.volatilityLookbackMs).map(p => ({ ...p }));
  if (path.at(-1)?.atMs !== nowMs) path.push({ atMs: nowMs, mid });
  else if (Math.abs(path.at(-1)!.mid - mid) > 1e-10 * mid) throw new Error("HORIZON_VOLATILITY_PRICE_MISMATCH");
  let squared = 0;
  for (let i = 1; i < path.length; i++) {
    const change = Math.log(path[i]!.mid / path[i - 1]!.mid);
    squared += change * change / (path[i]!.atMs - path[i - 1]!.atMs);
  }
  const value = Math.sqrt(squared / Math.max(1, path.length - 1) * H.volatilityLookbackMs) * 10_000;
  if (!Number.isFinite(value)) throw new Error("NONFINITE_HORIZON_VOLATILITY");
  return value;
}

/** Offline collector: each origin freezes all candidate barriers before their
 * future paths. It has no broker, live-model installation or order permission. */
export class HorizonResearchCollector {
  private readonly market = new DistributionMarket();
  private readonly pending = new Map<string, PendingPanel>();
  private readonly nextOrigin = new Map<string, number>();
  private readonly lastOrigin = new Map<string, number>();
  private origins = 0;
  private maximumPendingCases = 0;
  public constructor(private readonly costs: Costs, private readonly assets: Readonly<Record<string, AssetRules>>,
    private readonly trainingStartMs: number, private readonly accept: (panel: HorizonResearchPanel) => void) {}
  public onTrade(trade: MarketTrade): void { this.market.onTrade(trade); }
  public onBook(book: BookState): void {
    const pending = this.pending.get(book.symbol);
    if (pending) {
      DistributionExecutionCase.observeAll(pending.active, book);
      pending.active = pending.active.filter(c => c.snapshot().outcome === null);
      if (!pending.active.length) this.complete(pending, book.receiveTsMs);
    }
    const due = book.receiveTsMs >= this.trainingStartMs && !this.pending.has(book.symbol)
      && book.receiveTsMs >= (this.nextOrigin.get(book.symbol) ?? -Infinity)
      && book.receiveTsMs > (this.lastOrigin.get(book.symbol) ?? -Infinity);
    const context = this.market.onBook(book, due);
    if (!due || !context?.ready || distributionBookReason(book)) return;
    const rules = this.assets[book.symbol]!;
    const qty = policyQuantity(book.asks[0]!.px, rules);
    if (!(qty > 0)) return;
    const history = this.market.exportHistory().symbols.find(s => s.symbol === book.symbol)!;
    const volatility = horizonVolatility30mBps(history.samples, book.receiveTsMs,
      (book.bids[0]!.px + book.asks[0]!.px) / 2);
    const paths = buildHorizonResearchActions(volatility).map(action => ({ action: { ...action },
      cases: DISTRIBUTION_SCENARIOS.map(scenario => new DistributionExecutionCase(action, scenario, book,
        qty, this.costs[book.symbol]!, rules.priceIncrement)) }));
    const cases = paths.flatMap(p => p.cases);
    const panel: PendingPanel = { symbol: book.symbol, signalAtMs: book.receiveTsMs, features: [...context.features],
      volatility30mBps: volatility, paths, cases, active: [...cases] };
    this.pending.set(book.symbol, panel); this.origins++;
    this.nextOrigin.set(book.symbol, book.receiveTsMs + H.proposalIntervalMs);
    this.lastOrigin.set(book.symbol, book.receiveTsMs);
    this.maximumPendingCases = Math.max(this.maximumPendingCases, [...this.pending.values()].reduce((n, p) => n + p.cases.length, 0));
  }
  public invalidate(nowMs: number, reason: string): void {
    this.finishPending(nowMs, reason); this.market.invalidate();
  }
  public boundary(nowMs: number): void {
    // Preserve preceding feature history and the sampling clock, but no
    // training outcome may use a later-period quote.
    this.finishPending(nowMs, "TRAINING_BOUNDARY");
  }
  public finishPending(nowMs: number, reason: string): void {
    for (const panel of [...this.pending.values()]) {
      for (const c of panel.cases) c.invalidate(nowMs, reason);
      this.complete(panel, Math.max(nowMs, panel.signalAtMs));
    }
  }
  public stats() { return { origins: this.origins, maximumPendingCases: this.maximumPendingCases, pendingPanels: this.pending.size }; }
  private complete(panel: PendingPanel, completedAtMs: number): void {
    this.pending.delete(panel.symbol);
    const paths = panel.paths.map(path => ({ action: path.action, outcomes: path.cases.map(c => c.snapshot().outcome!) }));
    // Disconnect receipt timestamps can interleave across streams. Previously
    // observed completed outcomes must not lie after the panel completion.
    completedAtMs = Math.max(completedAtMs, ...paths.flatMap(p => p.outcomes.map(o => o.exitAtMs)));
    this.accept({ symbol: panel.symbol, signalAtMs: panel.signalAtMs, completedAtMs,
      volatility30mBps: panel.volatility30mBps, features: panel.features,
      paths });
  }
}

/** Original recorder order is causal. Buffered cross-stream timestamp
 * interleavings are retained; true reversals within one stream invalidate. */
export async function replayHorizonResearch(events: AsyncIterable<RecordedEvent> | Iterable<RecordedEvent>,
  costs: Costs, assets: Readonly<Record<string, AssetRules>>, options: HorizonReplayOptions) {
  if (![options.trainingStartMs, options.laterStartMs, options.cutoffMs].every(n => Number.isSafeInteger(n) && n >= 0)
    || options.trainingStartMs >= options.laterStartMs || options.laterStartMs >= options.cutoffMs) {
    throw new Error("INVALID_HORIZON_BOUNDARIES");
  }
  for (const symbol of S.symbols) {
    const r = assets[symbol], c = costs[symbol];
    if (!r || r.symbol !== symbol || !c || ![r.minOrderSize, r.minTradeIncrement, r.priceIncrement, r.maximumOrderQty].every(n => Number.isFinite(n) && n > 0)
      || r.shortable !== true || ![c.feeBps, c.reserveBps].every(n => Number.isFinite(n) && n >= 0)) throw new Error(`INVALID_HORIZON_RULES:${symbol}`);
  }
  const assessment = new StreamingHorizonAssessment(options), panels: HorizonResearchPanel[] = [];
  const collector = new HorizonResearchCollector(costs, assets, options.trainingStartMs, panel => {
    assessment.observePanel(panel); if (options.includePanels) panels.push(structuredClone(panel));
  });
  const books = new Map<string, LocalOrderBook>(), streamTimes = new Map<string, number>();
  let locked = false;
  const quality = { events: 0, books: 0, trades: 0, ignoredPrivate: 0, unsupportedSymbols: 0, futureExcluded: 0,
    acceptedBooks: 0, duplicates: 0, invalidBooks: 0, timestampReversals: 0, crossStreamReceiveRegressions: 0,
    latePreBoundaryEvents: 0, disconnects: 0, recorderGaps: 0, recorderDroppedEvents: 0,
    firstMs: null as number | null, lastMs: null as number | null, invalidReasons: {} as Record<string, number> };
  const invalidate = (now: number, reason: string) => {
    quality.invalidReasons[reason] = (quality.invalidReasons[reason] ?? 0) + 1;
    collector.invalidate(now, reason); for (const b of books.values()) b.invalidate();
  };
  for await (const event of events) {
    quality.events++;
    if (!event || typeof event !== "object") throw new Error("INVALID_HORIZON_EVENT");
    if (event.kind === "PRIVATE" || (event.kind === "DISCONNECT" && event.stream === "private")) { quality.ignoredPrivate++; continue; }
    if (!["BOOK", "TRADE", "DISCONNECT", "RECORDER_GAP"].includes(event.kind)) throw new Error("INVALID_HORIZON_EVENT_KIND");
    const now = event.kind === "BOOK" ? event.delta?.receiveTsMs : event.kind === "TRADE" ? event.trade?.receiveTsMs : event.receiveTsMs;
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_HORIZON_TIMESTAMP");
    if (now > options.cutoffMs) { quality.futureExcluded++; continue; }
    if (!locked && now >= options.laterStartMs) {
      collector.boundary(options.laterStartMs); assessment.lockSelection(); locked = true;
    }
    if (locked && now < options.laterStartMs) { quality.latePreBoundaryEvents++; continue; }
    const key = event.kind === "BOOK" ? `BOOK:${event.delta.symbol}` : event.kind === "TRADE" ? `TRADE:${event.trade.symbol}` : null;
    if (key && now < (streamTimes.get(key) ?? -Infinity)) {
      quality.timestampReversals++; invalidate(quality.lastMs ?? now, "RECEIVE_TIMESTAMP_REVERSAL"); continue;
    }
    if (key) streamTimes.set(key, now);
    if (quality.lastMs !== null) quality.crossStreamReceiveRegressions += Number(now < quality.lastMs);
    quality.firstMs ??= now; quality.lastMs = Math.max(quality.lastMs ?? now, now);
    if (event.kind === "DISCONNECT" || event.kind === "RECORDER_GAP") {
      if (event.kind === "DISCONNECT") {
        if (event.stream !== "public") throw new Error("INVALID_HORIZON_DISCONNECT");
        quality.disconnects++;
      } else {
        if (!Number.isSafeInteger(event.droppedEvents) || event.droppedEvents < 0) throw new Error("INVALID_HORIZON_RECORDER_GAP");
        quality.recorderGaps++; quality.recorderDroppedEvents += event.droppedEvents;
      }
      invalidate(now, event.kind); continue;
    }
    const symbol = event.kind === "BOOK" ? event.delta.symbol : event.trade.symbol;
    if (!(S.symbols as readonly string[]).includes(symbol)) { quality.unsupportedSymbols++; continue; }
    if (event.kind === "TRADE") { quality.trades++; collector.onTrade(event.trade); continue; }
    quality.books++;
    if (!Number.isSafeInteger(event.delta.exchangeTsMs) || event.delta.exchangeTsMs < 0) throw new Error("INVALID_HORIZON_EXCHANGE_TIMESTAMP");
    const local = books.get(symbol) ?? new LocalOrderBook(symbol); books.set(symbol, local);
    const update = local.apply(event.delta);
    if (update.duplicate) { quality.duplicates++; continue; }
    if (!update.accepted || !update.state) { quality.invalidBooks++; invalidate(now, `INVALID_BOOK:${update.reason ?? "UNKNOWN"}`); continue; }
    quality.acceptedBooks++; collector.onBook(update.state);
  }
  collector.finishPending(quality.lastMs ?? options.cutoffMs, "REPLAY_END");
  const result = assessment.finish();
  return { version: H.version, spec: H, executionSpec: S, scenarios: DISTRIBUTION_SCENARIOS, costs, assets,
    boundaries: { trainingStartMs: options.trainingStartMs, laterStartMs: options.laterStartMs, cutoffMs: options.cutoffMs },
    quality, collection: collector.stats(), assessment: result,
    ...(options.includePanels ? { panels } : {}), brokerOrdersSubmitted: 0, deploymentReady: false, profitabilityEstablished: false,
    assumptions: [
      "Offline policy comparison; no live engine, broker or model installation",
      "Full recorded depth and trade events in original order; no event resampling or artificial microsecond observations",
      "26 frozen candidate policies share each origin and the existing three execution stresses",
      "One common origin every 31 minutes per asset avoids overlapping maximum-horizon paths; this is research sampling, not the live entry schedule",
      "Volatility is estimated from observed preceding 30-minute price history before feature clipping; square-root-of-time scaling is a fixed hypothesis",
      "Fixed-control actions isolate deadlines; legacy and volatility actions also change their stop and net target",
      "Training paths crossing the later boundary are purged before training-only selections are locked",
      "The locked action benchmark is unconditional per asset and is not the current conditional trading engine",
      "Hypothetical returns include fees, spread, reserve, latency, partial fills and nonfills; invalid outcomes remain unknown",
      "Normalized dollars, if shown, standardize net basis points at 12 USD and are not exact cash-account P&L",
      "Recorded data was previously inspected; the later period is chronological assessment, not an untouched holdout",
      "Archived feed timestamps and buffered books cannot establish microsecond execution feasibility",
    ] };
}
