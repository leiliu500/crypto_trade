import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BookState, MarketTrade } from "../core/market.js";
import type { BookDelta } from "../core/order-book.js";
import { LocalOrderBook } from "../core/order-book.js";
import { distributionBookReason } from "../distribution/market.js";
import { DISTRIBUTION_SPEC } from "../distribution/spec.js";
import { SYSTEMATIC_SPEC } from "../systematic/spec.js";
import type { ExecutionPlan } from "../execution/planner.js";
import type { PrivateOrderEvent } from "../execution/order-state.js";
import { loadPaperFundingRates, newPaperFundingState, observePaperFundingFill, observePaperFundingRates,
  paperFundingSnapshot, postPaperFunding, restorePaperFundingState, validatePaperFundingState,
  type PaperFundingPosting, type PaperFundingRate, type PaperFundingSnapshot, type PaperFundingState } from "./paper-funding.js";
import { VenueApiError, type OrderGateway, type VenueClient } from "../venue/client.js";
import type {
  ActivitiesQuery, VenueAccount, VenueAccountConfiguration, VenueActivity, VenueApiResponse, VenueAsset,
  VenueBar, VenueClock, VenueOrder, VenueOrderbook, VenuePosition, VenueSnapshot, HistoricalQuery, ListOrdersQuery,
} from "../venue/types.js";

export interface KrakenFuturesInstrumentRules {
  symbol: string;
  productId: string;
  tickSize: number;
  quantityIncrement: number;
  maximumOrderQty: number;
}

export interface KrakenPaperBrokerConfig {
  initialEquity: number;
  productsBySymbol: Readonly<Record<string, string>>;
  instruments: ReadonlyMap<string, KrakenFuturesInstrumentRules>;
  makerFeeBpsBySymbol: Readonly<Record<string, number>>;
  takerFeeBpsBySymbol: Readonly<Record<string, number>>;
  restBaseUrl?: string;
  chartsBaseUrl?: string;
  stateFile?: string;
  fundingEnabled?: boolean;
  now?: () => number;
}

interface PaperBook { bids: Map<number, number>; asks: Map<number, number>; timestampMs: number; }
interface PaperPosition { symbol: string; side: 1 | -1; qty: number; entryPx: number; }
interface PaperOrder { plan: ExecutionPlan; remote: VenueOrder; queueAhead: number; arrivalAfterSequence?: bigint; }
interface SerializedPaperOrder { plan: Omit<ExecutionPlan, "originatingSequence"> & { originatingSequence: string }; remote: VenueOrder; queueAhead: number; }
export interface KrakenPaperHistoricalOrder { plan: ExecutionPlan; remote: VenueOrder; }
export interface KrakenPaperHistory {
  orders: readonly KrakenPaperHistoricalOrder[];
  activities: readonly VenueActivity[];
  makerFeeBpsBySymbol: Readonly<Record<string, number>>;
  takerFeeBpsBySymbol: Readonly<Record<string, number>>;
  funding?: { state: PaperFundingState; snapshot: KrakenPaperFundingSnapshot; priorHistoryFundingUnknown: boolean };
}
export interface KrakenPaperFundingSnapshot extends PaperFundingSnapshot {
  priorHistoryFundingUnknown: boolean; lifetimeFundingAccountingKnown: boolean;
}
interface KrakenPaperState {
  schemaVersion: 3 | 4;
  initialEquity: number;
  productsBySymbol: Record<string, string>;
  savedAt: string;
  cashEquity: number;
  utcSessionDate: string;
  utcSessionStartingCashEquity: number;
  positions: PaperPosition[];
  orders: SerializedPaperOrder[];
  activities: VenueActivity[];
  funding?: { state: PaperFundingState; priorHistoryFundingUnknown: boolean };
}
const KRAKEN_HTTP_TIMEOUT_MS = 10_000;
const MAX_PAPER_ACTIVITIES = 10_000;
const isDistributionOrder = (plan: ExecutionPlan): boolean => plan.policy?.id.startsWith("distribution-") ?? false;
const isDelayedIoc = (plan: ExecutionPlan): boolean => isDistributionOrder(plan) || plan.systematic !== undefined;

export class KrakenPaperTradeStream extends EventEmitter {
  private heartbeatTimer: NodeJS.Timeout | undefined;
  public connect(): void {
    queueMicrotask(() => this.emit("authenticated"));
    this.heartbeatTimer = setInterval(() => this.emit("heartbeat"), 10_000);
    this.heartbeatTimer.unref();
  }
  public close(): void { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
}

/**
 * Local-only order simulator. Public Kraken data enters through onBook/onTrade;
 * this class never calls a Kraken private order endpoint.
 */
export class KrakenPaperBroker implements VenueClient, OrderGateway {
  public readonly tradeStream = new KrakenPaperTradeStream();
  private readonly books = new Map<string, PaperBook>();
  private readonly distributionBooks = new Map<string, LocalOrderBook>();
  private readonly ordersById = new Map<string, PaperOrder>();
  private readonly orderIdByClientId = new Map<string, string>();
  private readonly positions = new Map<string, PaperPosition>();
  private readonly activities: VenueActivity[] = [];
  private readonly paperFetcher: typeof fetch;
  private cashEquity: number;
  private utcSessionDate: string;
  private utcSessionStartingCashEquity: number;
  private fundingState: PaperFundingState | undefined;
  private priorHistoryFundingUnknown = false;
  private readonly now: () => number;
  private fundingSnapshotCache: { state: PaperFundingState; snapshot: KrakenPaperFundingSnapshot } | undefined;

  public constructor(private readonly paperCfg: KrakenPaperBrokerConfig, fetcher: typeof fetch = fetch) {
    if (!(paperCfg.initialEquity > 0)) throw new Error("Kraken paper initial equity must be positive");
    this.paperFetcher = fetcher;
    this.now = paperCfg.now ?? Date.now;
    this.cashEquity = paperCfg.initialEquity;
    this.utcSessionDate = utcDate(this.now());
    this.utcSessionStartingCashEquity = paperCfg.initialEquity;
    if (paperCfg.fundingEnabled) this.fundingState = newPaperFundingState({ startedAtMs: this.now(),
      productsBySymbol: paperCfg.productsBySymbol });
    this.restoreState();
  }

  public onBook(delta: BookDelta): void {
    const distributionBook = this.distributionBooks.get(delta.symbol) ?? new LocalOrderBook(delta.symbol);
    const priorAtMs = distributionBook.snapshot().receiveTsMs;
    const update = distributionBook.apply(delta);
    this.distributionBooks.set(delta.symbol, distributionBook);
    const book = this.books.get(delta.symbol) ?? { bids: new Map(), asks: new Map(), timestampMs: 0 };
    if (delta.reset) { book.bids.clear(); book.asks.clear(); }
    applyLevels(book.bids, delta.bids);
    applyLevels(book.asks, delta.asks);
    book.timestampMs = delta.exchangeTsMs;
    this.books.set(delta.symbol, book);
    // Research IOC orders arrive on a later fresh book after measured latency;
    // a microtask fill at the decision quote would remove nonfills and adverse selection.
    for (const order of this.ordersById.values()) {
      if (order.plan.symbol !== delta.symbol || order.remote.status !== "new"
        || order.plan.timeInForce !== "ioc" || !isDelayedIoc(order.plan)) continue;
      if (!Number.isFinite(delta.receiveTsMs) || delta.receiveTsMs > order.plan.expiresMs) {
        this.cancelPaperOrder(order, Number.isFinite(delta.receiveTsMs) ? delta.receiveTsMs : undefined); continue;
      }
      if (update.duplicate) continue;
      if (!update.accepted || !update.state || distributionBookReason(update.state)
        || delta.receiveTsMs < Math.max(priorAtMs, order.plan.createdMs)
        || delta.receiveTsMs - Math.max(priorAtMs, order.plan.createdMs) > DISTRIBUTION_SPEC.maximumQuoteGapMs) {
        this.cancelPaperOrder(order, delta.receiveTsMs); continue;
      }
      const latencyMs = order.plan.systematic ? SYSTEMATIC_SPEC.entryLatencyMs : 250;
      if (delta.receiveTsMs >= order.plan.createdMs + latencyMs
        && update.state.sequence > (order.arrivalAfterSequence ?? order.plan.originatingSequence)) {
        this.executeIoc(order, delta.receiveTsMs, update.state);
      }
    }
  }

  public onTrade(trade: MarketTrade): void {
    for (const paperOrder of this.ordersById.values()) {
      if (paperOrder.plan.symbol !== trade.symbol || isTerminal(paperOrder.remote.status) || paperOrder.plan.style !== "maker") continue;
      const contra = paperOrder.plan.side === 1 ? trade.aggressor === -1 && trade.px <= paperOrder.plan.limitPx
        : trade.aggressor === 1 && trade.px >= paperOrder.plan.limitPx;
      if (!contra) continue;
      let available = trade.qty;
      if (trade.px === paperOrder.plan.limitPx && paperOrder.queueAhead > 0) {
        const consumedAhead = Math.min(paperOrder.queueAhead, available);
        paperOrder.queueAhead -= consumedAhead;
        available -= consumedAhead;
      } else if ((paperOrder.plan.side === 1 && trade.px < paperOrder.plan.limitPx)
        || (paperOrder.plan.side === -1 && trade.px > paperOrder.plan.limitPx)) paperOrder.queueAhead = 0;
      if (paperOrder.queueAhead > 0 || available <= 0) continue;
      const remaining = Number(paperOrder.remote.qty) - Number(paperOrder.remote.filled_qty);
      this.applyExecution(paperOrder, Math.min(remaining, available), paperOrder.plan.limitPx,
        this.fundingState ? trade.receiveTsMs : undefined);
    }
  }

  public async send(plan: ExecutionPlan): Promise<VenueOrder> {
    if (this.orderIdByClientId.has(plan.clientOrderId)) throw new VenueApiError("duplicate client order id", 400);
    this.validatePlan(plan);
    const now = new Date(this.now()).toISOString();
    const id = `kraken-paper-${randomUUID()}`;
    const remote: VenueOrder = {
      id, client_order_id: plan.clientOrderId, asset_id: this.paperCfg.productsBySymbol[plan.symbol] ?? plan.symbol,
      symbol: plan.symbol, asset_class: "crypto", qty: String(plan.qty), notional: null, filled_qty: "0",
      filled_avg_price: null, order_class: "simple", order_type: "limit", type: "limit",
      side: plan.side === 1 ? "buy" : "sell", time_in_force: plan.timeInForce, limit_price: String(plan.limitPx),
      stop_price: null, status: "new", created_at: now, updated_at: now, submitted_at: now,
      filled_at: null, canceled_at: null, failed_at: null, replaced_at: null, replaced_by: null, replaces: null,
    };
    const book = this.books.get(plan.symbol);
    const queueAhead = book ? (plan.side === 1 ? book.bids : book.asks).get(plan.limitPx) ?? 0 : 0;
    const paperOrder: PaperOrder = { plan, remote, queueAhead,
      arrivalAfterSequence: this.distributionBooks.get(plan.symbol)?.snapshot().sequence ?? 0n };
    this.ordersById.set(id, paperOrder);
    this.orderIdByClientId.set(plan.clientOrderId, id);
    this.persistState();
    queueMicrotask(() => {
      try {
        if (plan.timeInForce === "ioc" && paperOrder.remote.status === "new" && !isDelayedIoc(plan)) this.executeIoc(paperOrder);
      } catch (error) { this.reportExecutionFailure(error, id); }
    });
    return cloneOrder(remote);
  }

  /** Event boundaries report failed simulations instead of letting an exception
   * terminate the process. Cash and fill evidence are preserved by applyExecution's
   * rollback. Cancellation is attempted only for an order with no recorded fill. */
  public reportExecutionFailure(error: unknown, orderId?: string): void {
    this.tradeStream.emit("streamError", error);
    const order = orderId ? this.ordersById.get(orderId) : undefined;
    if (!order || isTerminal(order.remote.status) || Number(order.remote.filled_qty) > 0) return;
    try { this.cancelPaperOrder(order); }
    catch (cancelError) {
      this.tradeStream.emit("streamError", new Error(`PAPER_EXECUTION_RECOVERY_FAILED:${error instanceof Error ? error.message : String(error)}; cancellation: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`));
    }
  }

  public async cancel(orderId: string): Promise<void> {
    const paperOrder = this.ordersById.get(orderId);
    if (!paperOrder) throw new VenueApiError("paper order not found", 404);
    if (isTerminal(paperOrder.remote.status)) return;
    this.cancelPaperOrder(paperOrder);
  }

  public async cancelAll(): Promise<void> {
    for (const order of this.ordersById.values()) if (!isTerminal(order.remote.status)) this.cancelPaperOrder(order);
  }

  public async getAccount(): Promise<VenueApiResponse<VenueAccount>> {
    const equity = this.equity();
    return response({
      id: "kraken-local-paper", account_number: "LOCAL-PAPER", status: "ACTIVE", crypto_status: "ACTIVE", currency: "USD",
      cash: String(this.cashEquity), portfolio_value: String(equity), equity: String(equity), last_equity: String(this.paperCfg.initialEquity),
      buying_power: String(Math.max(0, equity)), effective_buying_power: String(Math.max(0, equity)),
      non_marginable_buying_power: String(Math.max(0, equity)), trading_blocked: false, transfers_blocked: false,
      account_blocked: false, trade_suspended_by_user: false, shorting_enabled: true, pattern_day_trader: false, daytrade_count: 0,
    });
  }

  public async getAccountConfiguration(): Promise<VenueApiResponse<VenueAccountConfiguration>> {
    return response({ dtbp_check: "entry", fractional_trading: true, max_margin_multiplier: "1", no_shorting: false,
      pdt_check: "entry", suspend_trade: false, trade_confirm_email: "none" });
  }

  public async getClock(): Promise<VenueApiResponse<VenueClock>> {
    const now = new Date(this.now()).toISOString();
    return response({ timestamp: now, is_open: true, next_open: now, next_close: now });
  }

  public async listAssets(): Promise<VenueApiResponse<VenueAsset[]>> {
    return response([...this.paperCfg.instruments.values()].map((instrument) => this.asset(instrument)));
  }

  public async getAsset(symbolOrId: string): Promise<VenueApiResponse<VenueAsset>> {
    const instrument = this.paperCfg.instruments.get(symbolOrId)
      ?? [...this.paperCfg.instruments.values()].find((candidate) => candidate.productId === symbolOrId);
    if (!instrument) throw new VenueApiError("paper instrument not found", 404);
    return response(this.asset(instrument));
  }

  public async listOrders(query: ListOrdersQuery = {}): Promise<VenueApiResponse<VenueOrder[]>> {
    let orders = [...this.ordersById.values()].map(({ remote }) => cloneOrder(remote));
    if (query.status === "open") orders = orders.filter((order) => !isTerminal(order.status));
    else if (query.status === "closed") orders = orders.filter((order) => isTerminal(order.status));
    return response(orders.slice(0, query.limit ?? orders.length));
  }

  public async getOrder(orderId: string): Promise<VenueApiResponse<VenueOrder>> {
    const order = this.ordersById.get(orderId);
    if (!order) throw new VenueApiError("paper order not found", 404);
    return response(cloneOrder(order.remote));
  }

  public async getOrderByClientId(clientOrderId: string): Promise<VenueApiResponse<VenueOrder>> {
    const orderId = this.orderIdByClientId.get(clientOrderId);
    if (!orderId) throw new VenueApiError("paper order not found", 404);
    return this.getOrder(orderId);
  }

  public async listPositions(): Promise<VenueApiResponse<VenuePosition[]>> {
    return response([...this.positions.values()].map((position) => this.remotePosition(position)));
  }

  public async getPortfolioHistory(): Promise<VenueApiResponse<unknown>> {
    if (this.rollUtcCashSession(this.now())) this.persistState();
    return response({
      equity: [this.utcSessionStartingCashEquity, this.cashEquity],
      profit_loss: [0, this.cashEquity - this.utcSessionStartingCashEquity],
    });
  }

  public async getActivities(_query: ActivitiesQuery = {}): Promise<VenueApiResponse<VenueActivity[]>> {
    return response(this.activities.map((activity) => ({ ...activity })));
  }

  /** Read-only durable history used to repair an empty telemetry database after a restart. */
  public history(): KrakenPaperHistory {
    const snapshot = this.fundingSnapshot();
    return {
      orders: [...this.ordersById.values()].map(({ plan, remote }) => ({
        plan: clonePlan(plan), remote: cloneOrder(remote),
      })),
      activities: this.activities.map((activity) => ({ ...activity })),
      makerFeeBpsBySymbol: { ...this.paperCfg.makerFeeBpsBySymbol },
      takerFeeBpsBySymbol: { ...this.paperCfg.takerFeeBpsBySymbol },
      ...(this.fundingState && snapshot ? { funding: { state: this.fundingState, snapshot,
        priorHistoryFundingUnknown: this.priorHistoryFundingUnknown } } : {}),
    };
  }

  /** Funding evidence is separate from strict FILL activities. Legacy history
   * remains unchanged; this model can only account from its declared epoch. */
  public fundingSnapshot(asOfMs?: number): KrakenPaperFundingSnapshot | undefined {
    if (!this.fundingState) return undefined;
    const atMs = asOfMs ?? Math.max(this.now(), this.fundingState.lastObservedAtMs);
    const cached = this.fundingSnapshotCache;
    if (cached?.state === this.fundingState
      && atMs >= cached.snapshot.asOfMs && atMs - cached.snapshot.asOfMs < 1_000
      && Math.floor(atMs / 3_600_000) === Math.floor(cached.snapshot.asOfMs / 3_600_000)) return cached.snapshot;
    const snapshot = paperFundingSnapshot(this.fundingState, atMs);
    const result = freezeSnapshot({ ...snapshot, priorHistoryFundingUnknown: this.priorHistoryFundingUnknown,
      lifetimeFundingAccountingKnown: snapshot.fundingAccountingKnown && !this.priorHistoryFundingUnknown });
    this.fundingSnapshotCache = { state: this.fundingState, snapshot: result };
    return result;
  }

  public fundingHistory(asOfMs?: number): KrakenPaperHistory["funding"] {
    const snapshot = this.fundingSnapshot(asOfMs);
    return this.fundingState && snapshot ? Object.freeze({ state: this.fundingState, snapshot,
      priorHistoryFundingUnknown: this.priorHistoryFundingUnknown }) : undefined;
  }

  public applyFundingRates(rates: readonly PaperFundingRate[], observedAtMs?: number): PaperFundingPosting[] {
    if (!this.fundingState) throw new Error("KRAKEN_PAPER_FUNDING_NOT_ENABLED");
    const atMs = observedAtMs ?? Math.max(this.now(), this.fundingState.lastObservedAtMs);
    const state = observePaperFundingRates(this.fundingState, rates, atMs);
    return this.commitFunding(state, atMs);
  }

  public settleFunding(asOfMs?: number): PaperFundingPosting[] {
    if (!this.fundingState) return [];
    return this.commitFunding(this.fundingState, asOfMs ?? Math.max(this.now(), this.fundingState.lastObservedAtMs));
  }

  public async refreshFunding() {
    if (!this.fundingState) throw new Error("KRAKEN_PAPER_FUNDING_NOT_ENABLED");
    const data = await loadPaperFundingRates({ productsBySymbol: this.paperCfg.productsBySymbol,
      fromMs: this.fundingState.config.startedAtMs }, { fetcher: this.paperFetcher, now: this.now });
    const observedAtMs = Math.max(data.observedAtMs, this.now(), this.fundingState.lastObservedAtMs);
    const postings = this.applyFundingRates(data.rates, observedAtMs);
    return { postings, sources: data.sources, snapshot: this.fundingSnapshot(observedAtMs)! };
  }

  private commitFunding(observed: PaperFundingState, asOfMs: number): PaperFundingPosting[] {
    const result = postPaperFunding(observed, asOfMs), oldState = this.fundingState, oldCash = this.cashEquity;
    if (result.state === oldState && result.postings.length === 0) return [];
    const oldSessionDate = this.utcSessionDate, oldSessionCash = this.utcSessionStartingCashEquity;
    this.rollUtcCashSession(asOfMs);
    this.fundingState = result.state;
    this.fundingSnapshotCache = undefined;
    this.cashEquity += result.postings.reduce((total, posting) => total + posting.cashDeltaUsd, 0);
    try { this.persistState(); }
    catch (error) {
      this.fundingState = oldState; this.cashEquity = oldCash;
      this.utcSessionDate = oldSessionDate; this.utcSessionStartingCashEquity = oldSessionCash; throw error;
    }
    for (const posting of result.postings) this.tradeStream.emit("funding", { ...posting });
    return result.postings;
  }

  public async latestOrderbooks(symbols: readonly string[]): Promise<VenueApiResponse<{ orderbooks: Record<string, VenueOrderbook> }>> {
    const orderbooks: Record<string, VenueOrderbook> = {};
    await Promise.all(symbols.map(async (symbol) => {
      const book = this.books.get(symbol);
      if (book) {
        orderbooks[symbol] = { t: new Date(book.timestampMs).toISOString(), b: sorted(book.bids, true).map(([p, s]) => ({ p, s })),
          a: sorted(book.asks, false).map(([p, s]) => ({ p, s })), r: true };
        return;
      }
      const product = this.paperCfg.productsBySymbol[symbol];
      if (!product) return;
      const base = this.paperCfg.restBaseUrl ?? "https://futures.kraken.com/derivatives/api/v3";
      const result = await this.paperFetcher(`${base}/orderbook?symbol=${encodeURIComponent(product)}`, {
        signal: AbortSignal.timeout(KRAKEN_HTTP_TIMEOUT_MS),
      });
      if (!result.ok) throw new Error(`Kraken Futures order book returned HTTP ${result.status}`);
      const payload = await result.json() as { result?: string; serverTime?: string; orderBook?: { bids?: unknown; asks?: unknown } };
      const timestampMs = Date.parse(payload.serverTime ?? "");
      const bids = parseRestLevels(payload.orderBook?.bids, true), asks = parseRestLevels(payload.orderBook?.asks, false);
      if (payload.result !== "success" || !Number.isFinite(timestampMs) || !bids[0] || !asks[0] || bids[0].p >= asks[0].p) {
        throw new Error(`Kraken Futures order book response was invalid for ${product}`);
      }
      orderbooks[symbol] = { t: new Date(timestampMs).toISOString(), b: bids, a: asks, r: true };
    }));
    return response({ orderbooks });
  }

  public async snapshots(symbols: readonly string[]): Promise<VenueApiResponse<{ snapshots: Record<string, VenueSnapshot> }>> {
    const snapshots: Record<string, VenueSnapshot> = {};
    for (const symbol of symbols) {
      const book = this.books.get(symbol);
      const bid = book ? sorted(book.bids, true)[0] : undefined, ask = book ? sorted(book.asks, false)[0] : undefined;
      if (book && bid && ask) snapshots[symbol] = { latestQuote: { t: new Date(book.timestampMs).toISOString(), bp: bid[0], bs: bid[1], ap: ask[0], as: ask[1] } };
    }
    return response({ snapshots });
  }

  public async latestQuotes(symbols: readonly string[]): Promise<VenueApiResponse<unknown>> { return response((await this.snapshots(symbols)).data); }
  public async latestTrades(_symbols: readonly string[]): Promise<VenueApiResponse<unknown>> { return response({ trades: {} }); }
  public async latestBars(_symbols: readonly string[]): Promise<VenueApiResponse<unknown>> { return response({ bars: {} }); }

  public async bars(query: HistoricalQuery): Promise<VenueApiResponse<unknown>> {
    const symbols = query.symbols.split(",").map((value) => value.trim()).filter(Boolean);
    const from = query.start ? Math.floor(Date.parse(query.start) / 1_000) : undefined;
    const to = query.end ? Math.floor(Date.parse(query.end) / 1_000) : undefined;
    const bars: Record<string, VenueBar[]> = {};
    await Promise.all(symbols.map(async (symbol) => {
      const product = this.paperCfg.productsBySymbol[symbol];
      if (!product) { bars[symbol] = []; return; }
      const params = new URLSearchParams();
      if (Number.isFinite(from)) params.set("from", String(from));
      if (Number.isFinite(to)) params.set("to", String(to));
      const base = this.paperCfg.chartsBaseUrl ?? "https://futures.kraken.com/api/charts/v1";
      const result = await this.paperFetcher(`${base}/trade/${encodeURIComponent(product)}/1m?${params}`, {
        signal: AbortSignal.timeout(KRAKEN_HTTP_TIMEOUT_MS),
      });
      if (!result.ok) throw new Error(`Kraken Futures candles returned HTTP ${result.status}`);
      const payload = await result.json() as { candles?: Array<{ time: number; open: string; high: string; low: string; close: string; volume: number }> };
      bars[symbol] = (payload.candles ?? []).map((candle) => ({ t: new Date(Number(candle.time)).toISOString(),
        o: Number(candle.open), h: Number(candle.high), l: Number(candle.low), c: Number(candle.close), v: Number(candle.volume) }));
    }));
    return response({ bars });
  }

  private validatePlan(plan: ExecutionPlan): void {
    if (plan.systematic !== undefined && (plan.timeInForce !== "ioc" || plan.style !== "taker"
      || !Number.isFinite(plan.createdMs) || !Number.isFinite(plan.expiresMs) || plan.createdMs < 0
      || plan.expiresMs < plan.createdMs + SYSTEMATIC_SPEC.entryLatencyMs
      || plan.expiresMs > plan.createdMs + SYSTEMATIC_SPEC.entryTtlMs)) {
      throw new VenueApiError("invalid systematic paper arrival window", 400);
    }
    if (isDistributionOrder(plan) && (!Number.isFinite(plan.createdMs) || !Number.isFinite(plan.expiresMs)
      || plan.createdMs < 0 || plan.expiresMs < plan.createdMs + 250
      || plan.expiresMs > plan.createdMs + DISTRIBUTION_SPEC.maximumQuoteAgeMs)) {
      throw new VenueApiError("invalid distribution paper arrival window", 400);
    }
    const instrument = this.paperCfg.instruments.get(plan.symbol);
    if (!instrument) throw new VenueApiError(`unsupported Kraken paper symbol ${plan.symbol}`, 400);
    if (!(plan.qty > 0) || plan.qty > instrument.maximumOrderQty || !multipleOf(plan.qty, instrument.quantityIncrement)) {
      throw new VenueApiError("invalid paper order quantity", 400);
    }
    if (!(plan.limitPx > 0) || !multipleOf(plan.limitPx, instrument.tickSize)) throw new VenueApiError("invalid paper limit price", 400);
    const current = this.positions.get(plan.symbol);
    if (plan.reduceOnlyIntent && (!current || current.side === plan.side)) throw new VenueApiError("reduce-only paper order would increase exposure", 422);
    if (!plan.reduceOnlyIntent && current) throw new VenueApiError("paper position already exists", 422);
  }

  private executeIoc(paperOrder: PaperOrder, executionAtMs?: number, acceptedBook?: BookState): void {
    const book = this.books.get(paperOrder.plan.symbol);
    if (!book) { this.cancelPaperOrder(paperOrder, executionAtMs); return; }
    let remaining = Number(paperOrder.remote.qty);
    if (paperOrder.plan.reduceOnlyIntent) remaining = Math.min(remaining, this.positions.get(paperOrder.plan.symbol)?.qty ?? 0);
    // A rejected duplicate can differ from its first payload. Research fills
    // use only the validated snapshot, never raw levels from an ignored event.
    const levels: Array<readonly [number, number]> = acceptedBook
      ? (paperOrder.plan.side === 1 ? acceptedBook.asks : acceptedBook.bids).map(level => [level.px, level.qty] as const)
      : sorted(paperOrder.plan.side === 1 ? book.asks : book.bids, paperOrder.plan.side === -1);
    let filled = 0, value = 0;
    for (const [price, quantity] of levels) {
      const protectedByLimit = paperOrder.plan.side === 1 ? price <= paperOrder.plan.limitPx : price >= paperOrder.plan.limitPx;
      if (!protectedByLimit || remaining <= 0) break;
      const take = Math.min(remaining, quantity);
      filled += take; value += take * price; remaining -= take;
    }
    if (filled > 0) this.applyExecution(paperOrder, filled, value / filled, executionAtMs);
    if (!isTerminal(paperOrder.remote.status)) this.cancelPaperOrder(paperOrder, executionAtMs);
  }

  private applyExecution(paperOrder: PaperOrder, requestedQty: number, price: number, executionAtMs?: number): void {
    if (!(requestedQty > 0) || isTerminal(paperOrder.remote.status)) return;
    const plan = paperOrder.plan;
    const oldPosition = this.positions.get(plan.symbol);
    const remainingOrder = Number(paperOrder.remote.qty) - Number(paperOrder.remote.filled_qty);
    const reducible = plan.reduceOnlyIntent ? oldPosition?.qty ?? 0 : requestedQty;
    const qty = Math.min(requestedQty, remainingOrder, reducible);
    if (!(qty > 0)) return;
    const fillId = randomUUID(), filledAtMs = executionAtMs ?? this.now();
    const observedAtMs = Math.max(this.now(), this.fundingState?.lastObservedAtMs ?? 0);
    // Prepare funding before changing order, position or cash. One checkpoint
    // commits the fill, its exact inventory consequence and any cash settlement.
    const funding = this.fundingState ? postPaperFunding(observePaperFundingFill(this.fundingState,
      { id: fillId, symbol: plan.symbol, occurredAtMs: filledAtMs, side: plan.side, qty }, observedAtMs), observedAtMs) : undefined;
    const priorRemote = cloneOrder(paperOrder.remote), priorPosition = oldPosition ? { ...oldPosition } : undefined;
    const priorCash = this.cashEquity, priorSessionDate = this.utcSessionDate;
    const priorSessionCash = this.utcSessionStartingCashEquity, priorFunding = this.fundingState;
    const removedActivity = this.activities.length >= MAX_PAPER_ACTIVITIES ? this.activities.at(-1) : undefined;
    const oldFilled = Number(paperOrder.remote.filled_qty);
    const totalFilled = oldFilled + qty;
    const oldAverage = Number(paperOrder.remote.filled_avg_price ?? 0);
    const average = (oldAverage * oldFilled + price * qty) / totalFilled;
    paperOrder.remote.filled_qty = String(totalFilled);
    paperOrder.remote.filled_avg_price = String(average);
    paperOrder.remote.updated_at = new Date(filledAtMs).toISOString();
    this.rollUtcCashSession(this.fundingState ? observedAtMs : filledAtMs);
    const final = totalFilled >= Number(paperOrder.remote.qty) - 1e-12;
    paperOrder.remote.status = final ? "filled" : "partially_filled";
    if (final) paperOrder.remote.filled_at = paperOrder.remote.updated_at;

    if (plan.reduceOnlyIntent && oldPosition) {
      const closeQty = Math.min(qty, oldPosition.qty);
      this.cashEquity += oldPosition.side * (price - oldPosition.entryPx) * closeQty;
      oldPosition.qty -= closeQty;
      if (oldPosition.qty <= 1e-12) this.positions.delete(plan.symbol);
    } else if (!oldPosition) this.positions.set(plan.symbol, { symbol: plan.symbol, side: plan.side, qty, entryPx: price });
    else if (oldPosition.side === plan.side) {
      oldPosition.entryPx = (oldPosition.entryPx * oldPosition.qty + price * qty) / (oldPosition.qty + qty);
      oldPosition.qty += qty;
    }
    const feeBps = plan.style === "maker" ? this.paperCfg.makerFeeBpsBySymbol[plan.symbol] ?? 0
      : this.paperCfg.takerFeeBpsBySymbol[plan.symbol] ?? 0;
    this.cashEquity -= qty * price * feeBps / 10_000;
    const positionQty = this.positions.get(plan.symbol)?.qty ?? 0;
    this.activities.unshift({ id: fillId, activity_type: "FILL", transaction_time: paperOrder.remote.updated_at,
      symbol: plan.symbol, qty: String(qty), price: String(price), order_id: paperOrder.remote.id,
      fee_usd: String(qty * price * feeBps / 10_000) });
    if (this.activities.length > MAX_PAPER_ACTIVITIES) this.activities.length = MAX_PAPER_ACTIVITIES;
    if (funding) {
      this.fundingState = funding.state;
      this.cashEquity += funding.postings.reduce((total, posting) => total + posting.cashDeltaUsd, 0);
      this.fundingSnapshotCache = undefined;
    }
    try { this.persistState(); }
    catch (error) {
      paperOrder.remote = priorRemote;
      if (priorPosition) this.positions.set(plan.symbol, priorPosition); else this.positions.delete(plan.symbol);
      this.cashEquity = priorCash; this.utcSessionDate = priorSessionDate;
      this.utcSessionStartingCashEquity = priorSessionCash; this.fundingState = priorFunding;
      this.fundingSnapshotCache = undefined; this.activities.shift();
      if (removedActivity) this.activities.push(removedActivity);
      throw error;
    }
    this.tradeStream.emit("order", { ...this.privateEvent(paperOrder, final ? "fill" : "partial_fill", qty, price, positionQty),
      feeUsd: qty * price * feeBps / 10_000 });
    for (const posting of funding?.postings ?? []) this.tradeStream.emit("funding", { ...posting });
  }

  private cancelPaperOrder(paperOrder: PaperOrder, executionAtMs?: number): void {
    if (isTerminal(paperOrder.remote.status)) return;
    const priorRemote = cloneOrder(paperOrder.remote);
    paperOrder.remote.status = "canceled";
    paperOrder.remote.updated_at = new Date(executionAtMs ?? this.now()).toISOString();
    paperOrder.remote.canceled_at = paperOrder.remote.updated_at;
    try { this.persistState(); }
    catch (error) { paperOrder.remote = priorRemote; throw error; }
    this.tradeStream.emit("order", this.privateEvent(paperOrder, "canceled", 0,
      Number(paperOrder.remote.filled_avg_price ?? 0), this.positions.get(paperOrder.plan.symbol)?.qty ?? 0));
  }

  private restoreState(): void {
    const stateFile = this.paperCfg.stateFile;
    if (!stateFile) return;
    if (!existsSync(stateFile)) {
      this.persistState();
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(stateFile, "utf8"));
    } catch (error) {
      throw new Error(`Kraken paper state could not be read from ${stateFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const state = validatePaperState(raw, this.paperCfg, stateFile);
    this.cashEquity = state.cashEquity;
    this.utcSessionDate = state.utcSessionDate;
    this.utcSessionStartingCashEquity = state.utcSessionStartingCashEquity;
    for (const position of state.positions) this.positions.set(position.symbol, { ...position });
    for (const stored of state.orders) {
      const plan: ExecutionPlan = { ...stored.plan, originatingSequence: BigInt(stored.plan.originatingSequence) };
      const paperOrder: PaperOrder = { plan, remote: cloneOrder(stored.remote), queueAhead: stored.queueAhead };
      this.ordersById.set(paperOrder.remote.id, paperOrder);
      this.orderIdByClientId.set(paperOrder.remote.client_order_id, paperOrder.remote.id);
    }
    this.activities.push(...state.activities.map((activity) => ({ ...activity })));
    if (state.funding) {
      this.fundingState = restorePaperFundingState(state.funding.state, this.now());
      this.priorHistoryFundingUnknown = state.funding.priorHistoryFundingUnknown;
    } else if (this.paperCfg.fundingEnabled) {
      this.fundingState = newPaperFundingState({ startedAtMs: this.now(), productsBySymbol: this.paperCfg.productsBySymbol,
        initialSignedQtyBySymbol: Object.fromEntries(state.positions.map(position => [position.symbol, position.side * position.qty])) });
      this.priorHistoryFundingUnknown = state.positions.length > 0 || state.activities.length > 0
        || state.cashEquity !== state.initialEquity;
    }

    // Local maker orders cannot be simulated while the process is down. Keep
    // their history, but never assume that an unobserved resting order survived.
    const restoredAt = new Date(this.now()).toISOString();
    for (const order of this.ordersById.values()) {
      if (isTerminal(order.remote.status)) continue;
      order.remote.status = "canceled";
      order.remote.updated_at = restoredAt;
      order.remote.canceled_at = restoredAt;
    }
    this.persistState();
  }

  private persistState(): void {
    const stateFile = this.paperCfg.stateFile;
    if (!stateFile) return;
    const state: KrakenPaperState = {
      schemaVersion: this.fundingState ? 4 : 3,
      initialEquity: this.paperCfg.initialEquity,
      productsBySymbol: sortedRecord(this.paperCfg.productsBySymbol),
      savedAt: new Date(this.now()).toISOString(),
      cashEquity: this.cashEquity,
      utcSessionDate: this.utcSessionDate,
      utcSessionStartingCashEquity: this.utcSessionStartingCashEquity,
      positions: [...this.positions.values()].map((position) => ({ ...position })),
      orders: [...this.ordersById.values()].map(({ plan, remote, queueAhead }) => ({
        plan: { ...plan, originatingSequence: plan.originatingSequence.toString() },
        remote: cloneOrder(remote), queueAhead,
      })),
      activities: this.activities.map((activity) => ({ ...activity })),
      ...(this.fundingState ? { funding: { state: this.fundingState,
        priorHistoryFundingUnknown: this.priorHistoryFundingUnknown } } : {}),
    };
    mkdirSync(dirname(stateFile), { recursive: true });
    const temporaryFile = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(temporaryFile, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryFile, stateFile);
  }

  private rollUtcCashSession(nowMs: number): boolean {
    const date = utcDate(nowMs);
    if (date === this.utcSessionDate) return false;
    this.utcSessionDate = date;
    this.utcSessionStartingCashEquity = this.cashEquity;
    return true;
  }

  private privateEvent(paperOrder: PaperOrder, event: string, eventQty: number, eventPx: number, positionQty: number): PrivateOrderEvent {
    return { id: randomUUID(), event, orderId: paperOrder.remote.id, clientOrderId: paperOrder.remote.client_order_id,
      symbol: paperOrder.plan.symbol, filledQty: Number(paperOrder.remote.filled_qty), eventQty, eventPx,
      timestampMs: Date.parse(paperOrder.remote.updated_at), positionQty };
  }

  private asset(instrument: KrakenFuturesInstrumentRules): VenueAsset {
    return { id: instrument.productId, class: "crypto", asset_class: "crypto", exchange: "KRAKEN_FUTURES",
      symbol: instrument.symbol, name: instrument.productId, status: "active", tradable: true, marginable: true,
      shortable: true, easy_to_borrow: true, fractionable: true, min_order_size: String(instrument.quantityIncrement),
      min_trade_increment: String(instrument.quantityIncrement), price_increment: String(instrument.tickSize),
      maximum_order_qty: String(instrument.maximumOrderQty) };
  }

  private remotePosition(position: PaperPosition): VenuePosition {
    const current = this.mark(position.symbol) ?? position.entryPx;
    const unrealized = position.side * (current - position.entryPx) * position.qty;
    return { asset_id: this.paperCfg.productsBySymbol[position.symbol] ?? position.symbol, symbol: position.symbol,
      exchange: "KRAKEN_FUTURES", asset_class: "crypto", qty: String(position.qty), avg_entry_price: String(position.entryPx),
      side: position.side === 1 ? "long" : "short", market_value: String(position.side * current * position.qty),
      cost_basis: String(position.entryPx * position.qty), unrealized_pl: String(unrealized),
      unrealized_plpc: String(unrealized / Math.max(position.entryPx * position.qty, 1e-12)), current_price: String(current), lastday_price: String(current) };
  }

  private mark(symbol: string): number | undefined {
    const book = this.books.get(symbol);
    const bid = book ? sorted(book.bids, true)[0]?.[0] : undefined, ask = book ? sorted(book.asks, false)[0]?.[0] : undefined;
    return bid !== undefined && ask !== undefined ? (bid + ask) / 2 : undefined;
  }

  private equity(): number {
    return this.cashEquity + [...this.positions.values()].reduce((sum, position) => {
      const mark = this.mark(position.symbol) ?? position.entryPx;
      return sum + position.side * (mark - position.entryPx) * position.qty;
    }, 0);
  }
}

export async function loadKrakenFuturesInstruments(productsBySymbol: Readonly<Record<string, string>>,
  fetcher: typeof fetch = fetch, baseUrl = "https://futures.kraken.com/derivatives/api/v3"): Promise<ReadonlyMap<string, KrakenFuturesInstrumentRules>> {
  const result = await fetcher(`${baseUrl}/instruments`, { signal: AbortSignal.timeout(KRAKEN_HTTP_TIMEOUT_MS) });
  if (!result.ok) throw new Error(`Kraken Futures instruments returned HTTP ${result.status}`);
  const payload = await result.json() as { result?: string; instruments?: Array<Record<string, unknown>> };
  if (payload.result !== "success" || !Array.isArray(payload.instruments)) throw new Error("Kraken Futures instruments response was invalid");
  const byProduct = new Map(payload.instruments.map((instrument) => [String(instrument.symbol), instrument]));
  const resolved = new Map<string, KrakenFuturesInstrumentRules>();
  for (const [symbol, productId] of Object.entries(productsBySymbol)) {
    const instrument = byProduct.get(productId);
    const tickSize = Number(instrument?.tickSize), precision = Number(instrument?.contractValueTradePrecision);
    const maximumOrderQty = Number(instrument?.maxPositionSize);
    if (!instrument || instrument.type !== "flexible_futures" || instrument.tradeable !== true
      || !(tickSize > 0) || !Number.isInteger(precision) || precision < 0 || precision > 12 || !(maximumOrderQty > 0)) {
      throw new Error(`Kraken product ${productId} is not a valid tradeable linear perpetual`);
    }
    // Parse the exchange's decimal quantum directly. Math.pow can round 10^-4
    // one ULP below the JSON/literal value 0.0001, breaking rule fingerprints.
    resolved.set(symbol, { symbol, productId, tickSize, quantityIncrement: Number(`1e-${precision}`), maximumOrderQty });
  }
  return resolved;
}

function response<T>(data: T): VenueApiResponse<T> { return { data, status: 200, requestId: `kraken-paper-${randomUUID()}` }; }
function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
function cloneOrder(order: VenueOrder): VenueOrder { return { ...order }; }
function clonePlan(plan: ExecutionPlan): ExecutionPlan {
  return {
    ...plan,
    expectedCost: { ...plan.expectedCost },
    risk: { ...plan.risk },
  };
}
function isTerminal(status: string): boolean { return ["filled", "canceled", "rejected", "expired"].includes(status); }
function applyLevels(target: Map<number, number>, levels: readonly { px: number; qty: number }[]): void {
  for (const level of levels) { if (level.qty === 0) target.delete(level.px); else target.set(level.px, level.qty); }
}
function sorted(levels: Map<number, number>, descending: boolean): Array<[number, number]> {
  return [...levels.entries()].sort((left, right) => descending ? right[0] - left[0] : left[0] - right[0]);
}
function multipleOf(value: number, increment: number): boolean {
  const units = value / increment;
  return Number.isFinite(units) && Math.abs(units - Math.round(units)) <= 1e-8;
}
function parseRestLevels(value: unknown, descending: boolean): Array<{ p: number; s: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!Array.isArray(candidate) || candidate.length < 2) return [];
    const p = Number(candidate[0]), s = Number(candidate[1]);
    return p > 0 && s > 0 ? [{ p, s }] : [];
  }).sort((left, right) => descending ? right.p - left.p : left.p - right.p).slice(0, 200);
}

function validatePaperState(raw: unknown, cfg: KrakenPaperBrokerConfig, stateFile: string): KrakenPaperState {
  const invalid = (reason: string): never => { throw new Error(`Invalid Kraken paper state in ${stateFile}: ${reason}`); };
  const state = isRecord(raw) ? raw : invalid("root must be an object");
  if (state.schemaVersion !== 1 && state.schemaVersion !== 2 && state.schemaVersion !== 3 && state.schemaVersion !== 4) {
    invalid(`unsupported schema version ${String(state.schemaVersion)}`);
  }
  if (state.initialEquity !== cfg.initialEquity) invalid("initial equity does not match KRAKEN_PAPER_INITIAL_EQUITY");
  if (!sameRecord(state.productsBySymbol, cfg.productsBySymbol)) invalid("symbol/product mapping does not match configuration");
  const cashEquity = isFiniteNumber(state.cashEquity) ? state.cashEquity : invalid("cashEquity must be finite");
  const positionRecords = Array.isArray(state.positions) ? state.positions : invalid("positions must be an array");
  const orderRecords = Array.isArray(state.orders) ? state.orders : invalid("orders must be an array");
  const activityRecords = Array.isArray(state.activities) ? state.activities : invalid("activities must be an array");

  const positions: PaperPosition[] = [];
  const positionSymbols = new Set<string>();
  for (const candidate of positionRecords) {
    if (!isRecord(candidate) || typeof candidate.symbol !== "string" || !cfg.productsBySymbol[candidate.symbol]
      || (candidate.side !== 1 && candidate.side !== -1) || !isPositiveNumber(candidate.qty) || !isPositiveNumber(candidate.entryPx)
      || positionSymbols.has(candidate.symbol)) invalid("position record is invalid or duplicated");
    positionSymbols.add(candidate.symbol);
    positions.push({ symbol: candidate.symbol, side: candidate.side, qty: candidate.qty, entryPx: candidate.entryPx });
  }

  const orders: SerializedPaperOrder[] = [];
  const orderIds = new Set<string>(), clientOrderIds = new Set<string>();
  for (const candidate of orderRecords) {
    if (!isRecord(candidate) || !isRecord(candidate.plan) || !isRecord(candidate.remote)
      || typeof candidate.plan.symbol !== "string" || !cfg.productsBySymbol[candidate.plan.symbol]
      || (candidate.plan.side !== 1 && candidate.plan.side !== -1)
      || !isPositiveNumber(candidate.plan.qty) || !isPositiveNumber(candidate.plan.limitPx)
      || typeof candidate.plan.clientOrderId !== "string" || !candidate.plan.clientOrderId
      || typeof candidate.plan.originatingSequence !== "string" || !/^\d+$/.test(candidate.plan.originatingSequence)
      || typeof candidate.remote.id !== "string" || !candidate.remote.id
      || candidate.remote.client_order_id !== candidate.plan.clientOrderId
      || candidate.remote.symbol !== candidate.plan.symbol
      || typeof candidate.remote.status !== "string" || !["new", "partially_filled", "filled", "canceled", "rejected", "expired"].includes(candidate.remote.status)
      || !isPositiveNumber(Number(candidate.remote.qty)) || !isFiniteNumber(Number(candidate.remote.filled_qty))
      || Number(candidate.remote.filled_qty) < 0 || Number(candidate.remote.filled_qty) > Number(candidate.remote.qty) + 1e-12
      || !isFiniteNumber(candidate.queueAhead) || candidate.queueAhead < 0
      || orderIds.has(candidate.remote.id) || clientOrderIds.has(candidate.plan.clientOrderId)) invalid("order record is invalid or duplicated");
    orderIds.add(candidate.remote.id);
    clientOrderIds.add(candidate.plan.clientOrderId);
    orders.push(candidate as unknown as SerializedPaperOrder);
  }
  if (activityRecords.length > MAX_PAPER_ACTIVITIES || activityRecords.some((activity) => !isRecord(activity))) {
    invalid("activities are invalid or exceed the retention limit");
  }
  const nowMs = (cfg.now ?? Date.now)();
  let funding: KrakenPaperState["funding"];
  if (state.schemaVersion === 4) {
    const fundingRecord = isRecord(state.funding) ? state.funding : invalid("funding checkpoint must be an object");
    if (typeof fundingRecord.priorHistoryFundingUnknown !== "boolean"
      || !validatePaperFundingState(fundingRecord.state, nowMs)) invalid("funding checkpoint is invalid");
    const fundingState = fundingRecord.state as PaperFundingState;
    if (!sameRecord(fundingState.config.productsBySymbol, cfg.productsBySymbol)) invalid("funding products do not match configuration");
    const snapshot = paperFundingSnapshot(fundingState, nowMs);
    for (const row of snapshot.perSymbol) {
      const position = positions.find(item => item.symbol === row.symbol);
      const signedQty = position ? position.side * position.qty : 0;
      if (Math.abs(row.signedBaseQty - signedQty) > 64 * Number.EPSILON * Math.max(1, Math.abs(signedQty)))
        invalid("funding inventory does not match account positions");
    }
    const fundingFills = new Map(fundingState.events.flatMap(event => event.type === "FILL" ? [[event.fill.id, event.fill] as const] : []));
    const ordersById = new Map(orders.map(order => [order.remote.id, order]));
    for (const activity of activityRecords as VenueActivity[]) {
      if (activity.activity_type !== "FILL" || Date.parse(activity.transaction_time ?? "") < fundingState.config.startedAtMs) continue;
      const fill = fundingFills.get(activity.id), order = activity.order_id ? ordersById.get(activity.order_id) : undefined;
      if (!fill || !order || fill.symbol !== activity.symbol || fill.side !== order.plan.side
        || fill.qty !== Number(activity.qty) || fill.occurredAtMs !== Date.parse(activity.transaction_time ?? ""))
        invalid("funding fill evidence does not match activities");
    }
    funding = { state: fundingState, priorHistoryFundingUnknown: fundingRecord.priorHistoryFundingUnknown as boolean };
  } else if (state.funding !== undefined) invalid("funding requires schema version 4");
  const today = utcDate(nowMs);
  let utcSessionDate = today;
  let utcSessionStartingCashEquity = cashEquity;
  if (state.schemaVersion === 3 || state.schemaVersion === 4) {
    const sessionDate = state.utcSessionDate;
    const sessionStartingCashEquity = state.utcSessionStartingCashEquity;
    if (typeof sessionDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)
      || !isFiniteNumber(sessionStartingCashEquity)) invalid("UTC session state is invalid");
    if (sessionDate === today) {
      utcSessionDate = sessionDate;
      utcSessionStartingCashEquity = Number(sessionStartingCashEquity);
    }
  } else {
    utcSessionStartingCashEquity = replayUtcSessionStartingCashEquity(
      cfg.initialEquity, cashEquity, orders, activityRecords as VenueActivity[], cfg, Date.parse(`${today}T00:00:00.000Z`),
    ) ?? cashEquity;
  }
  return { schemaVersion: funding ? 4 : 3, initialEquity: cfg.initialEquity, productsBySymbol: sortedRecord(cfg.productsBySymbol),
    savedAt: typeof state.savedAt === "string" ? state.savedAt : "", cashEquity,
    utcSessionDate, utcSessionStartingCashEquity,
    positions, orders, activities: activityRecords as VenueActivity[], ...(funding ? { funding } : {}) };
}

function replayUtcSessionStartingCashEquity(initialEquity: number, persistedCashEquity: number,
  orders: readonly SerializedPaperOrder[], activities: readonly VenueActivity[], cfg: KrakenPaperBrokerConfig,
  dayStartMs: number): number | null {
  const ordersById = new Map(orders.map((order) => [order.remote.id, order]));
  const positions = new Map<string, PaperPosition>();
  let cashEquity = initialEquity;
  let startingCashEquity: number | null = null;
  const fills = activities.filter((activity) => activity.activity_type === "FILL").sort((left, right) =>
    Date.parse(left.transaction_time ?? "") - Date.parse(right.transaction_time ?? ""));
  for (const activity of fills) {
    const atMs = Date.parse(activity.transaction_time ?? "");
    const qty = Number(activity.qty), price = Number(activity.price);
    const order = activity.order_id ? ordersById.get(activity.order_id) : undefined;
    if (!Number.isFinite(atMs) || !(qty > 0) || !(price > 0) || !order) return null;
    if (startingCashEquity === null && atMs >= dayStartMs) startingCashEquity = cashEquity;
    const plan = order.plan;
    const oldPosition = positions.get(plan.symbol);
    if (plan.reduceOnlyIntent) {
      if (!oldPosition || oldPosition.side === plan.side) return null;
      const closeQty = Math.min(qty, oldPosition.qty);
      cashEquity += oldPosition.side * (price - oldPosition.entryPx) * closeQty;
      oldPosition.qty -= closeQty;
      if (oldPosition.qty <= 1e-12) positions.delete(plan.symbol);
    } else if (!oldPosition) {
      positions.set(plan.symbol, { symbol: plan.symbol, side: plan.side, qty, entryPx: price });
    } else if (oldPosition.side === plan.side) {
      oldPosition.entryPx = (oldPosition.entryPx * oldPosition.qty + price * qty) / (oldPosition.qty + qty);
      oldPosition.qty += qty;
    } else return null;
    const feeBps = plan.style === "maker" ? cfg.makerFeeBpsBySymbol[plan.symbol] ?? 0
      : cfg.takerFeeBpsBySymbol[plan.symbol] ?? 0;
    const recordedFee = activity.fee_usd === undefined ? NaN : Number(activity.fee_usd);
    cashEquity -= Number.isFinite(recordedFee) ? recordedFee : qty * price * feeBps / 10_000;
  }
  const replayStartingCashEquity = startingCashEquity ?? cashEquity;
  const replaySessionPnl = cashEquity - replayStartingCashEquity;
  // Legacy files can contain older fills produced under different fee settings.
  // Anchor the replayed current-day delta to authoritative persisted cash so
  // pre-session discrepancies cannot leak into today's P&L.
  return persistedCashEquity - replaySessionPnl;
}

function utcDate(atMs: number): string { return new Date(atMs).toISOString().slice(0, 10); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isPositiveNumber(value: unknown): value is number { return isFiniteNumber(value) && value > 0; }
function sortedRecord(value: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}
function sameRecord(left: unknown, right: Readonly<Record<string, string>>): boolean {
  if (!isRecord(left) || Object.values(left).some((value) => typeof value !== "string")) return false;
  return JSON.stringify(sortedRecord(left as Record<string, string>)) === JSON.stringify(sortedRecord(right));
}
