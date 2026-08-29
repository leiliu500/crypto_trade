import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MarketTrade } from "../core/market.js";
import type { BookDelta } from "../core/order-book.js";
import type { ExecutionPlan } from "../execution/planner.js";
import type { PrivateOrderEvent } from "../execution/order-state.js";
import type { OrderGateway } from "../alpaca/gateway.js";
import { AlpacaApiError, AlpacaRestClient } from "../alpaca/rest.js";
import type {
  ActivitiesQuery, AlpacaAccount, AlpacaAccountConfiguration, AlpacaActivity, AlpacaApiResponse, AlpacaAsset,
  AlpacaBar, AlpacaClock, AlpacaOrder, AlpacaOrderbook, AlpacaPosition, AlpacaSnapshot, HistoricalQuery, ListOrdersQuery,
} from "../alpaca/types.js";

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
}

interface PaperBook { bids: Map<number, number>; asks: Map<number, number>; timestampMs: number; }
interface PaperPosition { symbol: string; side: 1 | -1; qty: number; entryPx: number; }
interface PaperOrder { plan: ExecutionPlan; remote: AlpacaOrder; queueAhead: number; }
interface SerializedPaperOrder { plan: Omit<ExecutionPlan, "originatingSequence"> & { originatingSequence: string }; remote: AlpacaOrder; queueAhead: number; }
export interface KrakenPaperHistoricalOrder { plan: ExecutionPlan; remote: AlpacaOrder; }
export interface KrakenPaperHistory {
  orders: readonly KrakenPaperHistoricalOrder[];
  activities: readonly AlpacaActivity[];
  makerFeeBpsBySymbol: Readonly<Record<string, number>>;
  takerFeeBpsBySymbol: Readonly<Record<string, number>>;
}
interface KrakenPaperState {
  schemaVersion: 3;
  initialEquity: number;
  productsBySymbol: Record<string, string>;
  savedAt: string;
  cashEquity: number;
  utcSessionDate: string;
  utcSessionStartingCashEquity: number;
  positions: PaperPosition[];
  orders: SerializedPaperOrder[];
  activities: AlpacaActivity[];
}
const KRAKEN_HTTP_TIMEOUT_MS = 10_000;
const MAX_PAPER_ACTIVITIES = 10_000;

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
export class KrakenPaperBroker extends AlpacaRestClient implements OrderGateway {
  public readonly tradeStream = new KrakenPaperTradeStream();
  private readonly books = new Map<string, PaperBook>();
  private readonly ordersById = new Map<string, PaperOrder>();
  private readonly orderIdByClientId = new Map<string, string>();
  private readonly positions = new Map<string, PaperPosition>();
  private readonly activities: AlpacaActivity[] = [];
  private readonly paperFetcher: typeof fetch;
  private cashEquity: number;
  private utcSessionDate: string;
  private utcSessionStartingCashEquity: number;

  public constructor(private readonly paperCfg: KrakenPaperBrokerConfig, fetcher: typeof fetch = fetch) {
    super({ credentials: { keyId: "local-paper", secretKey: "local-paper" }, paper: true });
    if (!(paperCfg.initialEquity > 0)) throw new Error("Kraken paper initial equity must be positive");
    this.paperFetcher = fetcher;
    this.cashEquity = paperCfg.initialEquity;
    this.utcSessionDate = utcDate(Date.now());
    this.utcSessionStartingCashEquity = paperCfg.initialEquity;
    this.restoreState();
  }

  public onBook(delta: BookDelta): void {
    const book = this.books.get(delta.symbol) ?? { bids: new Map(), asks: new Map(), timestampMs: 0 };
    if (delta.reset) { book.bids.clear(); book.asks.clear(); }
    applyLevels(book.bids, delta.bids);
    applyLevels(book.asks, delta.asks);
    book.timestampMs = delta.exchangeTsMs;
    this.books.set(delta.symbol, book);
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
      this.applyExecution(paperOrder, Math.min(remaining, available), paperOrder.plan.limitPx);
    }
  }

  public async send(plan: ExecutionPlan): Promise<AlpacaOrder> {
    if (this.orderIdByClientId.has(plan.clientOrderId)) throw new AlpacaApiError("duplicate client order id", 400);
    this.validatePlan(plan);
    const now = new Date().toISOString();
    const id = `kraken-paper-${randomUUID()}`;
    const remote: AlpacaOrder = {
      id, client_order_id: plan.clientOrderId, asset_id: this.paperCfg.productsBySymbol[plan.symbol] ?? plan.symbol,
      symbol: plan.symbol, asset_class: "crypto", qty: String(plan.qty), notional: null, filled_qty: "0",
      filled_avg_price: null, order_class: "simple", order_type: "limit", type: "limit",
      side: plan.side === 1 ? "buy" : "sell", time_in_force: plan.timeInForce, limit_price: String(plan.limitPx),
      stop_price: null, status: "new", created_at: now, updated_at: now, submitted_at: now,
      filled_at: null, canceled_at: null, failed_at: null, replaced_at: null, replaced_by: null, replaces: null,
    };
    const book = this.books.get(plan.symbol);
    const queueAhead = book ? (plan.side === 1 ? book.bids : book.asks).get(plan.limitPx) ?? 0 : 0;
    const paperOrder = { plan, remote, queueAhead };
    this.ordersById.set(id, paperOrder);
    this.orderIdByClientId.set(plan.clientOrderId, id);
    this.persistState();
    queueMicrotask(() => {
      if (plan.timeInForce === "ioc" && paperOrder.remote.status === "new") this.executeIoc(paperOrder);
    });
    return cloneOrder(remote);
  }

  public async cancel(orderId: string): Promise<void> {
    const paperOrder = this.ordersById.get(orderId);
    if (!paperOrder) throw new AlpacaApiError("paper order not found", 404);
    if (isTerminal(paperOrder.remote.status)) return;
    this.cancelPaperOrder(paperOrder);
  }

  public async cancelAll(): Promise<void> {
    for (const order of this.ordersById.values()) if (!isTerminal(order.remote.status)) this.cancelPaperOrder(order);
  }

  public override async getAccount(): Promise<AlpacaApiResponse<AlpacaAccount>> {
    const equity = this.equity();
    return response({
      id: "kraken-local-paper", account_number: "LOCAL-PAPER", status: "ACTIVE", crypto_status: "ACTIVE", currency: "USD",
      cash: String(this.cashEquity), portfolio_value: String(equity), equity: String(equity), last_equity: String(this.paperCfg.initialEquity),
      buying_power: String(Math.max(0, equity)), effective_buying_power: String(Math.max(0, equity)),
      non_marginable_buying_power: String(Math.max(0, equity)), trading_blocked: false, transfers_blocked: false,
      account_blocked: false, trade_suspended_by_user: false, shorting_enabled: true, pattern_day_trader: false, daytrade_count: 0,
    });
  }

  public override async getAccountConfiguration(): Promise<AlpacaApiResponse<AlpacaAccountConfiguration>> {
    return response({ dtbp_check: "entry", fractional_trading: true, max_margin_multiplier: "1", no_shorting: false,
      pdt_check: "entry", suspend_trade: false, trade_confirm_email: "none" });
  }

  public override async getClock(): Promise<AlpacaApiResponse<AlpacaClock>> {
    const now = new Date().toISOString();
    return response({ timestamp: now, is_open: true, next_open: now, next_close: now });
  }

  public override async listAssets(): Promise<AlpacaApiResponse<AlpacaAsset[]>> {
    return response([...this.paperCfg.instruments.values()].map((instrument) => this.asset(instrument)));
  }

  public override async getAsset(symbolOrId: string): Promise<AlpacaApiResponse<AlpacaAsset>> {
    const instrument = this.paperCfg.instruments.get(symbolOrId)
      ?? [...this.paperCfg.instruments.values()].find((candidate) => candidate.productId === symbolOrId);
    if (!instrument) throw new AlpacaApiError("paper instrument not found", 404);
    return response(this.asset(instrument));
  }

  public override async listOrders(query: ListOrdersQuery = {}): Promise<AlpacaApiResponse<AlpacaOrder[]>> {
    if (query.asset_class === "us_option") return response([]);
    let orders = [...this.ordersById.values()].map(({ remote }) => cloneOrder(remote));
    if (query.status === "open") orders = orders.filter((order) => !isTerminal(order.status));
    else if (query.status === "closed") orders = orders.filter((order) => isTerminal(order.status));
    return response(orders.slice(0, query.limit ?? orders.length));
  }

  public override async getOrder(orderId: string): Promise<AlpacaApiResponse<AlpacaOrder>> {
    const order = this.ordersById.get(orderId);
    if (!order) throw new AlpacaApiError("paper order not found", 404);
    return response(cloneOrder(order.remote));
  }

  public override async getOrderByClientId(clientOrderId: string): Promise<AlpacaApiResponse<AlpacaOrder>> {
    const orderId = this.orderIdByClientId.get(clientOrderId);
    if (!orderId) throw new AlpacaApiError("paper order not found", 404);
    return this.getOrder(orderId);
  }

  public override async listPositions(): Promise<AlpacaApiResponse<AlpacaPosition[]>> {
    return response([...this.positions.values()].map((position) => this.remotePosition(position)));
  }

  public override async getPortfolioHistory(): Promise<AlpacaApiResponse<unknown>> {
    if (this.rollUtcCashSession(Date.now())) this.persistState();
    return response({
      equity: [this.utcSessionStartingCashEquity, this.cashEquity],
      profit_loss: [0, this.cashEquity - this.utcSessionStartingCashEquity],
    });
  }

  public override async getActivities(_query: ActivitiesQuery = {}): Promise<AlpacaApiResponse<AlpacaActivity[]>> {
    return response(this.activities.map((activity) => ({ ...activity })));
  }

  /** Read-only durable history used to repair an empty telemetry database after a restart. */
  public history(): KrakenPaperHistory {
    return {
      orders: [...this.ordersById.values()].map(({ plan, remote }) => ({
        plan: clonePlan(plan), remote: cloneOrder(remote),
      })),
      activities: this.activities.map((activity) => ({ ...activity })),
      makerFeeBpsBySymbol: { ...this.paperCfg.makerFeeBpsBySymbol },
      takerFeeBpsBySymbol: { ...this.paperCfg.takerFeeBpsBySymbol },
    };
  }

  public override async latestOrderbooks(symbols: readonly string[]): Promise<AlpacaApiResponse<{ orderbooks: Record<string, AlpacaOrderbook> }>> {
    const orderbooks: Record<string, AlpacaOrderbook> = {};
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

  public override async snapshots(symbols: readonly string[]): Promise<AlpacaApiResponse<{ snapshots: Record<string, AlpacaSnapshot> }>> {
    const snapshots: Record<string, AlpacaSnapshot> = {};
    for (const symbol of symbols) {
      const book = this.books.get(symbol);
      const bid = book ? sorted(book.bids, true)[0] : undefined, ask = book ? sorted(book.asks, false)[0] : undefined;
      if (book && bid && ask) snapshots[symbol] = { latestQuote: { t: new Date(book.timestampMs).toISOString(), bp: bid[0], bs: bid[1], ap: ask[0], as: ask[1] } };
    }
    return response({ snapshots });
  }

  public override async latestQuotes(symbols: readonly string[]): Promise<AlpacaApiResponse<unknown>> { return response((await this.snapshots(symbols)).data); }
  public override async latestTrades(_symbols: readonly string[]): Promise<AlpacaApiResponse<unknown>> { return response({ trades: {} }); }
  public override async latestBars(_symbols: readonly string[]): Promise<AlpacaApiResponse<unknown>> { return response({ bars: {} }); }

  public override async bars(query: HistoricalQuery): Promise<AlpacaApiResponse<unknown>> {
    const symbols = query.symbols.split(",").map((value) => value.trim()).filter(Boolean);
    const from = query.start ? Math.floor(Date.parse(query.start) / 1_000) : undefined;
    const to = query.end ? Math.floor(Date.parse(query.end) / 1_000) : undefined;
    const bars: Record<string, AlpacaBar[]> = {};
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
    const instrument = this.paperCfg.instruments.get(plan.symbol);
    if (!instrument) throw new AlpacaApiError(`unsupported Kraken paper symbol ${plan.symbol}`, 400);
    if (!(plan.qty > 0) || plan.qty > instrument.maximumOrderQty || !multipleOf(plan.qty, instrument.quantityIncrement)) {
      throw new AlpacaApiError("invalid paper order quantity", 400);
    }
    if (!(plan.limitPx > 0) || !multipleOf(plan.limitPx, instrument.tickSize)) throw new AlpacaApiError("invalid paper limit price", 400);
    const current = this.positions.get(plan.symbol);
    if (plan.reduceOnlyIntent && (!current || current.side === plan.side)) throw new AlpacaApiError("reduce-only paper order would increase exposure", 422);
    if (!plan.reduceOnlyIntent && current) throw new AlpacaApiError("paper position already exists", 422);
  }

  private executeIoc(paperOrder: PaperOrder): void {
    const book = this.books.get(paperOrder.plan.symbol);
    if (!book) { this.cancelPaperOrder(paperOrder); return; }
    let remaining = Number(paperOrder.remote.qty);
    if (paperOrder.plan.reduceOnlyIntent) remaining = Math.min(remaining, this.positions.get(paperOrder.plan.symbol)?.qty ?? 0);
    const levels = sorted(paperOrder.plan.side === 1 ? book.asks : book.bids, paperOrder.plan.side === -1);
    let filled = 0, value = 0;
    for (const [price, quantity] of levels) {
      const protectedByLimit = paperOrder.plan.side === 1 ? price <= paperOrder.plan.limitPx : price >= paperOrder.plan.limitPx;
      if (!protectedByLimit || remaining <= 0) break;
      const take = Math.min(remaining, quantity);
      filled += take; value += take * price; remaining -= take;
    }
    if (filled > 0) this.applyExecution(paperOrder, filled, value / filled);
    if (!isTerminal(paperOrder.remote.status)) this.cancelPaperOrder(paperOrder);
  }

  private applyExecution(paperOrder: PaperOrder, requestedQty: number, price: number): void {
    if (!(requestedQty > 0) || isTerminal(paperOrder.remote.status)) return;
    const plan = paperOrder.plan;
    const oldPosition = this.positions.get(plan.symbol);
    const remainingOrder = Number(paperOrder.remote.qty) - Number(paperOrder.remote.filled_qty);
    const reducible = plan.reduceOnlyIntent ? oldPosition?.qty ?? 0 : requestedQty;
    const qty = Math.min(requestedQty, remainingOrder, reducible);
    if (!(qty > 0)) return;
    const oldFilled = Number(paperOrder.remote.filled_qty);
    const totalFilled = oldFilled + qty;
    const oldAverage = Number(paperOrder.remote.filled_avg_price ?? 0);
    const average = (oldAverage * oldFilled + price * qty) / totalFilled;
    paperOrder.remote.filled_qty = String(totalFilled);
    paperOrder.remote.filled_avg_price = String(average);
    paperOrder.remote.updated_at = new Date().toISOString();
    this.rollUtcCashSession(Date.parse(paperOrder.remote.updated_at));
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
    this.activities.unshift({ id: randomUUID(), activity_type: "FILL", transaction_time: paperOrder.remote.updated_at,
      symbol: plan.symbol, qty: String(qty), price: String(price), order_id: paperOrder.remote.id });
    if (this.activities.length > MAX_PAPER_ACTIVITIES) this.activities.length = MAX_PAPER_ACTIVITIES;
    this.persistState();
    this.tradeStream.emit("order", this.privateEvent(paperOrder, final ? "fill" : "partial_fill", qty, price, positionQty));
  }

  private cancelPaperOrder(paperOrder: PaperOrder): void {
    if (isTerminal(paperOrder.remote.status)) return;
    paperOrder.remote.status = "canceled";
    paperOrder.remote.updated_at = new Date().toISOString();
    paperOrder.remote.canceled_at = paperOrder.remote.updated_at;
    this.persistState();
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

    // Local maker orders cannot be simulated while the process is down. Keep
    // their history, but never assume that an unobserved resting order survived.
    const restoredAt = new Date().toISOString();
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
      schemaVersion: 3,
      initialEquity: this.paperCfg.initialEquity,
      productsBySymbol: sortedRecord(this.paperCfg.productsBySymbol),
      savedAt: new Date().toISOString(),
      cashEquity: this.cashEquity,
      utcSessionDate: this.utcSessionDate,
      utcSessionStartingCashEquity: this.utcSessionStartingCashEquity,
      positions: [...this.positions.values()].map((position) => ({ ...position })),
      orders: [...this.ordersById.values()].map(({ plan, remote, queueAhead }) => ({
        plan: { ...plan, originatingSequence: plan.originatingSequence.toString() },
        remote: cloneOrder(remote), queueAhead,
      })),
      activities: this.activities.map((activity) => ({ ...activity })),
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

  private asset(instrument: KrakenFuturesInstrumentRules): AlpacaAsset {
    return { id: instrument.productId, class: "crypto", asset_class: "crypto", exchange: "KRAKEN_FUTURES",
      symbol: instrument.symbol, name: instrument.productId, status: "active", tradable: true, marginable: true,
      shortable: true, easy_to_borrow: true, fractionable: true, min_order_size: String(instrument.quantityIncrement),
      min_trade_increment: String(instrument.quantityIncrement), price_increment: String(instrument.tickSize) };
  }

  private remotePosition(position: PaperPosition): AlpacaPosition {
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
    resolved.set(symbol, { symbol, productId, tickSize, quantityIncrement: 10 ** -precision, maximumOrderQty });
  }
  return resolved;
}

function response<T>(data: T): AlpacaApiResponse<T> { return { data, status: 200, requestId: `kraken-paper-${randomUUID()}` }; }
function cloneOrder(order: AlpacaOrder): AlpacaOrder { return { ...order }; }
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
  if (state.schemaVersion !== 1 && state.schemaVersion !== 2 && state.schemaVersion !== 3) {
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
  const today = utcDate(Date.now());
  let utcSessionDate = today;
  let utcSessionStartingCashEquity = cashEquity;
  if (state.schemaVersion === 3) {
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
      cfg.initialEquity, cashEquity, orders, activityRecords as AlpacaActivity[], cfg, Date.parse(`${today}T00:00:00.000Z`),
    ) ?? cashEquity;
  }
  return { schemaVersion: 3, initialEquity: cfg.initialEquity, productsBySymbol: sortedRecord(cfg.productsBySymbol),
    savedAt: typeof state.savedAt === "string" ? state.savedAt : "", cashEquity,
    utcSessionDate, utcSessionStartingCashEquity,
    positions, orders, activities: activityRecords as AlpacaActivity[] };
}

function replayUtcSessionStartingCashEquity(initialEquity: number, persistedCashEquity: number,
  orders: readonly SerializedPaperOrder[], activities: readonly AlpacaActivity[], cfg: KrakenPaperBrokerConfig,
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
    cashEquity -= qty * price * feeBps / 10_000;
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
