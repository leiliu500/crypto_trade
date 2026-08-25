import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { AlpacaOptionStream, type AlpacaOptionStreamQuote } from "../alpaca/option-stream.js";
import { AlpacaApiError, AlpacaRestClient } from "../alpaca/rest.js";
import { AlpacaStockStream, type AlpacaStockStreamQuote } from "../alpaca/stock-stream.js";
import type { AlpacaAccount, AlpacaCredentials, AlpacaOptionContract, AlpacaOrder, AlpacaPosition } from "../alpaca/types.js";

const OPTION_ORDER_PREFIX = "mlce-opt";
const NEW_YORK_TIME_ZONE = "America/New_York";
const FINAL_ORDER_STATUSES = new Set(["filled", "canceled", "expired", "rejected", "replaced", "done_for_day", "calculated"]);

export interface CryptoOptionShortConfig {
  enabled: boolean;
  proxyByCryptoSymbol: Readonly<Record<string, string>>;
  dataFeed: "opra" | "indicative";
  stockDataFeed: "iex" | "sip";
  targetMoneyness: number;
  maximumMoneynessDistance: number;
  maximumQuoteAgeMs: number;
  maximumSpreadBps: number;
  maximumPremiumDollars: number;
  maximumContracts: number;
  maximumStreamContracts: number;
  entryStartEtMinute: number;
  entryCutoffEtMinute: number;
  forceExitEtMinute: number;
  emergencyExitEtMinute: number;
  maximumHoldMs: number;
  stopLossUnderlyingBps: number;
  takeProfitUnderlyingBps: number;
  entryLimitBufferBps: number;
  exitLimitBufferBps: number;
  orderTtlMs: number;
}

export interface CryptoOptionShortPlan {
  cryptoSymbol: string;
  proxySymbol: string;
  contractSymbol: string;
  expirationDate: string;
  purpose: "OPEN_SHORT" | "CLOSE_SHORT";
  side: "buy" | "sell";
  positionIntent: "buy_to_open" | "sell_to_close";
  qty: number;
  orderType: "limit" | "market";
  limitPrice?: number;
  maximumPremiumRiskDollars: number;
  clientOrderId: string;
  decisionId: string;
  reason: string;
  createdMs: number;
  expiresMs: number;
  marketData: "ALPACA_WEBSOCKET";
}

export interface CryptoOptionShortExposure {
  cryptoSymbol: string;
  proxySymbol: string;
  contractSymbol: string;
  expirationDate: string;
  qty: number;
  averageEntryPremium: number;
  openedMs: number;
  entryCryptoPrice?: number;
}

export interface CryptoOptionShortExposureSnapshot extends CryptoOptionShortExposure {
  markPremium?: number;
  markBidPremium?: number;
  markAskPremium?: number;
  markTimestampMs?: number;
}

interface PendingOptionOrder {
  cryptoSymbol: string;
  contractSymbol: string;
  clientOrderId: string;
  purpose: "OPEN_SHORT" | "CLOSE_SHORT";
  alpacaOrderId?: string;
  status: string;
  filledQty: number;
  expiresMs: number;
}

export interface CryptoOptionShortSnapshot {
  enabled: boolean;
  accountReady: boolean;
  stockStreamReady: boolean;
  optionStreamReady: boolean;
  subscribedContracts: number;
  exposures: readonly CryptoOptionShortExposureSnapshot[];
  pendingOrders: readonly PendingOptionOrder[];
}

export interface CryptoOptionShortDependencies {
  stockStream?: StockQuoteStream;
  optionStream?: OptionQuoteStream;
  now?: () => number;
}

export interface StockQuoteStream {
  connect(): void;
  close(): void;
  ready(): boolean;
  on(event: string, listener: (...args: any[]) => void): this;
}
export interface OptionQuoteStream extends StockQuoteStream { setSymbols(symbols: readonly string[]): void; }

type TradingMode = "record" | "replay" | "shadow" | "paper" | "live";

/**
 * Converts bearish crypto intents into finite-risk, same-day long puts on a
 * configured ETF proxy. Static contract discovery is REST; every price that
 * authorizes selection, entry, or a capped exit comes from Alpaca WebSockets.
 */
export class CryptoOptionShortController extends EventEmitter {
  private readonly stockStream: StockQuoteStream;
  private readonly optionStream: OptionQuoteStream;
  private readonly now: () => number;
  private readonly stockQuotes = new Map<string, AlpacaStockStreamQuote>();
  private readonly optionQuotes = new Map<string, AlpacaOptionStreamQuote>();
  private readonly contracts = new Map<string, AlpacaOptionContract>();
  private readonly exposures = new Map<string, CryptoOptionShortExposure>();
  private readonly pending = new Map<string, PendingOptionOrder>();
  private readonly entryCryptoPriceByContract = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly openEvaluationInFlight = new Set<string>();
  private readonly orderTimers = new Map<string, NodeJS.Timeout>();
  private readonly reportedOrderStates = new Map<string, string>();
  private accountReady = false;
  private optionsBuyingPower = 0;
  private stockReady = false;
  private optionReady = false;
  private subscribedContracts = new Set<string>();
  private lastUniverseRefreshMs = 0;
  private universeRefreshInFlight = false;
  private maintenanceInFlight = false;
  private reconciliationTail: Promise<void> = Promise.resolve();
  private maintenanceTimer?: NodeJS.Timeout;

  public constructor(
    private readonly cfg: CryptoOptionShortConfig,
    credentials: AlpacaCredentials,
    private readonly mode: TradingMode,
    private readonly rest: AlpacaRestClient,
    dependencies: CryptoOptionShortDependencies = {},
  ) {
    super();
    this.now = dependencies.now ?? Date.now;
    const proxies = [...new Set(Object.values(cfg.proxyByCryptoSymbol))];
    this.stockStream = dependencies.stockStream ?? new AlpacaStockStream({ credentials, symbols: proxies, feed: cfg.stockDataFeed });
    this.optionStream = dependencies.optionStream ?? new AlpacaOptionStream({ credentials, feed: cfg.dataFeed });
    this.bindStreams();
  }

  public start(): void {
    if (!this.cfg.enabled || ["record", "replay"].includes(this.mode)) return;
    this.stockStream.connect();
    this.optionStream.connect();
    this.maintenanceTimer = setInterval(() => { void this.maintain(); }, 5_000);
    this.maintenanceTimer.unref();
  }

  public stop(): void {
    this.stockStream.close();
    this.optionStream.close();
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    for (const timer of this.orderTimers.values()) clearTimeout(timer);
    this.orderTimers.clear();
  }

  public canRoute(cryptoSymbol: string): boolean {
    return this.cfg.enabled && this.cfg.proxyByCryptoSymbol[cryptoSymbol] !== undefined;
  }
  public hasExposure(cryptoSymbol: string): boolean { return this.exposures.has(cryptoSymbol); }
  public hasPending(cryptoSymbol: string): boolean { return this.pending.has(cryptoSymbol); }
  public ownsOrder(clientOrderId: string): boolean { return parseOwnedClientOrderId(clientOrderId, this.cfg.proxyByCryptoSymbol) !== null; }

  public snapshot(): CryptoOptionShortSnapshot {
    const nowMs = this.now();
    return {
      enabled: this.cfg.enabled, accountReady: this.accountReady,
      stockStreamReady: this.stockReady, optionStreamReady: this.optionReady,
      subscribedContracts: this.subscribedContracts.size,
      exposures: [...this.exposures.values()].map((value) => {
        const quote = this.optionQuotes.get(value.contractSymbol);
        const quoteAgeMs = quote ? nowMs - quote.timestampMs : Number.POSITIVE_INFINITY;
        const usable = quote && quoteAgeMs >= -1_000 && quoteAgeMs <= this.cfg.maximumQuoteAgeMs && quote.bidPrice > 0;
        return { ...value, ...(usable ? {
          markPremium: quote.bidPrice,
          markBidPremium: quote.bidPrice,
          markAskPremium: quote.askPrice,
          markTimestampMs: quote.timestampMs,
        } : {}) };
      }),
      pendingOrders: [...this.pending.values()].map((value) => ({ ...value })),
    };
  }

  public reconcile(account: AlpacaAccount, positions: readonly AlpacaPosition[], orders: readonly AlpacaOrder[]): Promise<void> {
    const operation = this.reconciliationTail.then(() => this.reconcileExclusive(account, positions, orders));
    this.reconciliationTail = operation.catch(() => undefined);
    return operation;
  }

  private async reconcileExclusive(account: AlpacaAccount, positions: readonly AlpacaPosition[],
    orders: readonly AlpacaOrder[]): Promise<void> {
    if (!this.cfg.enabled) return;
    const level = Number(account.options_trading_level ?? 0);
    const buyingPower = Number(account.options_buying_power ?? 0);
    if (level < 2) {
      this.accountReady = false;
      throw new Error(`Crypto option shorts require Alpaca options trading level 2; account reports level ${level}`);
    }
    if (!Number.isFinite(buyingPower) || buyingPower < 0) {
      this.accountReady = false;
      throw new Error("Alpaca options buying power is unavailable");
    }
    this.optionsBuyingPower = buyingPower;
    this.accountReady = true;

    // The list endpoint and position endpoint are not an atomic snapshot. Resolve
    // locally tracked orders exactly before rebuilding exposure so a briefly
    // stale list response cannot release an entry/exit interlock.
    const resolvedOrders = [...orders];
    const resolvedClientIds = new Set(resolvedOrders.map((order) => order.client_order_id));
    for (const local of this.pending.values()) {
      if (resolvedClientIds.has(local.clientOrderId)) continue;
      try {
        const response = local.alpacaOrderId
          ? await this.rest.getOrder(local.alpacaOrderId)
          : await this.rest.getOrderByClientId(local.clientOrderId);
        resolvedOrders.push(response.data);
        resolvedClientIds.add(response.data.client_order_id);
      } catch (error) {
        if (!(error instanceof AlpacaApiError && error.status === 404)) {
          this.emit("orderError", { order: { ...local }, error });
        }
      }
    }

    const owned = resolvedOrders.flatMap((order) => {
      const metadata = parseOwnedClientOrderId(order.client_order_id, this.cfg.proxyByCryptoSymbol);
      return metadata ? [{ order, metadata }] : [];
    });
    for (const { order, metadata } of owned) {
      const signature = `${order.status}:${order.filled_qty ?? "0"}:${order.filled_avg_price ?? ""}:${order.updated_at}`;
      if (this.reportedOrderStates.get(order.client_order_id) === signature) continue;
      this.reportedOrderStates.set(order.client_order_id, signature);
      this.emit("orderReconciled", { cryptoSymbol: metadata.cryptoSymbol, purpose: metadata.purpose, order });
    }
    const ownedQuantity = new Map<string, {
      cryptoSymbol: string; qty: number; openedMs: number; entryCryptoPrice?: number;
    }>();
    for (const { order, metadata } of owned) {
      const filled = Number(order.filled_qty ?? 0);
      if (!(filled > 0)) continue;
      const previous = ownedQuantity.get(order.symbol);
      const signed = metadata.purpose === "OPEN_SHORT" ? filled : -filled;
      const submitted = Date.parse(order.submitted_at ?? order.created_at);
      ownedQuantity.set(order.symbol, {
        cryptoSymbol: metadata.cryptoSymbol,
        qty: (previous?.qty ?? 0) + signed,
        openedMs: Math.min(previous?.openedMs ?? Number.POSITIVE_INFINITY, Number.isFinite(submitted) ? submitted : this.now()),
        ...(previous?.entryCryptoPrice !== undefined
          ? { entryCryptoPrice: previous.entryCryptoPrice }
          : metadata.entryCryptoPrice !== undefined ? { entryCryptoPrice: metadata.entryCryptoPrice } : {}),
      });
    }
    const optionPositions = new Map(positions.filter((position) => position.asset_class === "us_option" && position.side === "long")
      .map((position) => [position.symbol, position]));
    const nextExposures = new Map<string, CryptoOptionShortExposure>();
    for (const [contractSymbol, ownedPosition] of ownedQuantity) {
      const remote = optionPositions.get(contractSymbol);
      const qty = Math.min(ownedPosition.qty, Number(remote?.qty ?? 0));
      if (!(qty > 0) || !remote) continue;
      const contract = this.contracts.get(contractSymbol) ?? (await this.rest.getOptionContract(contractSymbol)).data;
      this.contracts.set(contract.symbol, contract);
      if (contract.type !== "put" || contract.underlying_symbol !== this.cfg.proxyByCryptoSymbol[ownedPosition.cryptoSymbol]) continue;
      const previous = this.exposures.get(ownedPosition.cryptoSymbol);
      nextExposures.set(ownedPosition.cryptoSymbol, {
        cryptoSymbol: ownedPosition.cryptoSymbol, proxySymbol: contract.underlying_symbol,
        contractSymbol, expirationDate: contract.expiration_date, qty,
        averageEntryPremium: Number(remote.avg_entry_price), openedMs: ownedPosition.openedMs,
        ...(previous?.contractSymbol === contractSymbol && previous.entryCryptoPrice !== undefined
          ? { entryCryptoPrice: previous.entryCryptoPrice }
          : this.entryCryptoPriceByContract.has(contractSymbol)
            ? { entryCryptoPrice: this.entryCryptoPriceByContract.get(contractSymbol)! }
            : ownedPosition.entryCryptoPrice !== undefined ? { entryCryptoPrice: ownedPosition.entryCryptoPrice } : {}),
      });
    }

    const nextPending = new Map<string, PendingOptionOrder>();
    for (const { order, metadata } of owned) {
      const local = this.pending.get(metadata.cryptoSymbol);
      const submitted = Date.parse(order.submitted_at ?? order.created_at);
      const pending: PendingOptionOrder = {
        cryptoSymbol: metadata.cryptoSymbol, contractSymbol: order.symbol, clientOrderId: order.client_order_id,
        purpose: metadata.purpose, alpacaOrderId: order.id, status: order.status,
        filledQty: Number(order.filled_qty ?? 0),
        expiresMs: local?.clientOrderId === order.client_order_id ? local.expiresMs
          : (Number.isFinite(submitted) ? submitted : this.now()) + this.cfg.orderTtlMs,
      };
      if (!FINAL_ORDER_STATUSES.has(order.status)) {
        nextPending.set(metadata.cryptoSymbol, pending);
        continue;
      }
      // A terminal opening order is still settling until the corresponding
      // position is visible. Otherwise a concurrent order/position snapshot
      // could authorize a duplicate opening order.
      if (metadata.purpose === "OPEN_SHORT" && pending.filledQty > 0) {
        const expectedQty = Math.max(0, ownedQuantity.get(order.symbol)?.qty ?? 0);
        const visibleQty = nextExposures.get(metadata.cryptoSymbol)?.contractSymbol === order.symbol
          ? nextExposures.get(metadata.cryptoSymbol)!.qty : 0;
        if (expectedQty > visibleQty + 1e-9 && !nextPending.has(metadata.cryptoSymbol)) {
          nextPending.set(metadata.cryptoSymbol, { ...pending, status: "SETTLING" });
        }
      }
    }
    for (const [symbol, local] of this.pending) {
      if (nextPending.has(symbol) || resolvedClientIds.has(local.clientOrderId)) continue;
      // An order absent from both list and exact lookup remains interlocked;
      // absence is not proof that an ambiguous POST failed.
      nextPending.set(symbol, { ...local, status: local.status === "UNKNOWN" ? "UNKNOWN" : "SETTLING" });
    }

    this.exposures.clear();
    for (const [symbol, value] of nextExposures) this.exposures.set(symbol, value);
    this.replacePending(nextPending);
    if (this.exposures.size) void this.refreshUniverse(true);
    this.emit("reconciled", this.snapshot());
  }

  public async tryOpen(request: {
    cryptoSymbol: string; cryptoPrice: number; decisionId: string; reason: string; sizeMultiplier?: number;
  }): Promise<CryptoOptionShortPlan | null> {
    const { cryptoSymbol } = request;
    if (this.openEvaluationInFlight.size > 0) return this.block(cryptoSymbol, "OPTION_SELECTION_ALREADY_IN_PROGRESS");
    this.openEvaluationInFlight.add(cryptoSymbol);
    try { return await this.tryOpenExclusive(request); }
    finally { this.openEvaluationInFlight.delete(cryptoSymbol); }
  }

  private async tryOpenExclusive(request: {
    cryptoSymbol: string; cryptoPrice: number; decisionId: string; reason: string; sizeMultiplier?: number;
  }): Promise<CryptoOptionShortPlan | null> {
    const { cryptoSymbol } = request;
    if (!this.canRoute(cryptoSymbol)) return this.block(cryptoSymbol, "NO_CONFIGURED_OPTION_PROXY");
    if (this.inFlight.has(cryptoSymbol) || this.hasExposure(cryptoSymbol) || this.hasPending(cryptoSymbol)) {
      return this.block(cryptoSymbol, "OPTION_EXPOSURE_OR_ORDER_EXISTS");
    }
    if (this.exposures.size > 0 || this.pending.size > 0 || this.inFlight.size > 0) {
      return this.block(cryptoSymbol, "CORRELATED_OPTION_EXPOSURE_EXISTS");
    }
    if (!this.accountReady) return this.block(cryptoSymbol, "OPTIONS_ACCOUNT_NOT_READY");
    if (!this.stockReady || !this.optionReady) return this.block(cryptoSymbol, "OPTIONS_WEBSOCKET_NOT_READY");
    const session = newYorkSession(this.now());
    if (session.minute < this.cfg.entryStartEtMinute || session.minute >= this.cfg.entryCutoffEtMinute) {
      return this.block(cryptoSymbol, "OUTSIDE_0DTE_ENTRY_WINDOW", { session });
    }
    const clock = await this.rest.getClock();
    if (!clock.data.is_open) return this.block(cryptoSymbol, "US_OPTIONS_MARKET_CLOSED");
    const proxySymbol = this.cfg.proxyByCryptoSymbol[cryptoSymbol]!;
    const proxyQuote = this.freshStockQuote(proxySymbol);
    if (!proxyQuote) return this.block(cryptoSymbol, "PROXY_WEBSOCKET_QUOTE_UNAVAILABLE");
    await this.refreshUniverse();
    const selection = selectZeroDtePut({
      contracts: [...this.contracts.values()].filter((contract) => contract.underlying_symbol === proxySymbol),
      quotes: this.optionQuotes, proxyMid: (proxyQuote.bidPrice + proxyQuote.askPrice) / 2,
      expirationDate: session.date, nowMs: this.now(), cfg: this.cfg,
    });
    if (!selection) return this.block(cryptoSymbol, "NO_LIQUID_STREAMED_0DTE_PUT");
    const tick = optionPriceIncrement(selection.contract, selection.quote.askPrice);
    const limitPrice = roundUp(selection.quote.askPrice * (1 + this.cfg.entryLimitBufferBps / 10_000), tick);
    const contractMultiplier = Number(selection.contract.size);
    const premiumPerContract = limitPrice * contractMultiplier;
    const sizeMultiplier = request.sizeMultiplier ?? 1;
    if (!Number.isFinite(sizeMultiplier) || !(sizeMultiplier > 0 && sizeMultiplier <= 1)) {
      return this.block(cryptoSymbol, "INVALID_OPTION_SIZE_MULTIPLIER", { sizeMultiplier });
    }
    const premiumBudget = this.cfg.maximumPremiumDollars * sizeMultiplier;
    const qty = Math.floor(Math.min(this.cfg.maximumContracts, premiumBudget / premiumPerContract,
      this.optionsBuyingPower / premiumPerContract));
    if (!(qty >= 1)) return this.block(cryptoSymbol, "PREMIUM_BUDGET_TOO_SMALL", { premiumPerContract });
    const createdMs = this.now();
    const plan: CryptoOptionShortPlan = {
      cryptoSymbol, proxySymbol, contractSymbol: selection.contract.symbol, expirationDate: selection.contract.expiration_date,
      purpose: "OPEN_SHORT", side: "buy", positionIntent: "buy_to_open", qty, orderType: "limit", limitPrice,
      maximumPremiumRiskDollars: premiumPerContract * qty,
      clientOrderId: ownedClientOrderId("OPEN_SHORT", cryptoSymbol, createdMs, request.cryptoPrice), decisionId: request.decisionId,
      reason: request.reason, createdMs, expiresMs: createdMs + this.cfg.orderTtlMs, marketData: "ALPACA_WEBSOCKET",
    };
    this.emit("decision", plan);
    if (this.mode === "shadow") return plan;
    if (!["paper", "live"].includes(this.mode)) return this.block(cryptoSymbol, "MODE_DOES_NOT_ALLOW_OPTION_ORDERS");
    this.entryCryptoPriceByContract.set(plan.contractSymbol, request.cryptoPrice);
    return await this.submit(plan);
  }

  public async manage(request: { cryptoSymbol: string; cryptoPrice: number; bullishReversal: boolean }): Promise<boolean> {
    const pending = this.pending.get(request.cryptoSymbol);
    if (!this.exposures.has(request.cryptoSymbol)) {
      if (pending?.purpose === "OPEN_SHORT" && request.bullishReversal) await this.cancelPending(pending, "BULLISH_REVERSAL");
      return Boolean(pending);
    }
    const exposure = this.exposures.get(request.cryptoSymbol)!;
    const session = newYorkSession(this.now());
    const underlyingMoveBps = exposure.entryCryptoPrice === undefined ? 0
      : (request.cryptoPrice / exposure.entryCryptoPrice - 1) * 10_000;
    const reason = session.date !== exposure.expirationDate ? "NON_CURRENT_DAY_POSITION"
      : session.minute >= this.cfg.forceExitEtMinute ? "MANDATORY_0DTE_SESSION_EXIT"
        : this.now() - exposure.openedMs >= this.cfg.maximumHoldMs ? "MAXIMUM_INTRADAY_HOLD"
          : exposure.entryCryptoPrice !== undefined && underlyingMoveBps >= this.cfg.stopLossUnderlyingBps ? "UNDERLYING_STOP"
            : exposure.entryCryptoPrice !== undefined && underlyingMoveBps <= -this.cfg.takeProfitUnderlyingBps ? "UNDERLYING_TARGET"
              : request.bullishReversal ? "BULLISH_REVERSAL" : null;
    if (reason) await this.closeExposure(exposure, reason, session.minute >= this.cfg.emergencyExitEtMinute);
    return true;
  }

  private bindStreams(): void {
    this.stockStream.on("authenticated", () => { this.stockReady = true; this.emit("stockStreamReady"); });
    this.stockStream.on("disconnect", () => { this.stockReady = false; this.emit("stockStreamDown"); });
    this.stockStream.on("quote", (quote: AlpacaStockStreamQuote) => {
      this.stockQuotes.set(quote.symbol, quote);
      if (this.now() - this.lastUniverseRefreshMs >= 60_000) void this.refreshUniverse();
    });
    this.stockStream.on("streamError", (error) => this.emit("streamError", error));
    this.optionStream.on("authenticated", () => { this.optionReady = true; this.emit("optionStreamReady"); });
    this.optionStream.on("disconnect", () => { this.optionReady = false; this.emit("optionStreamDown"); });
    this.optionStream.on("subscription", (event: { symbols: string[] }) => {
      this.subscribedContracts = new Set(event.symbols);
      this.emit("optionSubscription", event);
    });
    this.optionStream.on("quote", (quote: AlpacaOptionStreamQuote) => {
      this.optionQuotes.set(quote.symbol, quote);
      const exposure = [...this.exposures.values()].find((item) => item.contractSymbol === quote.symbol);
      if (exposure) this.emit("mark", { cryptoSymbol: exposure.cryptoSymbol, contractSymbol: quote.symbol,
        bidPrice: quote.bidPrice, askPrice: quote.askPrice, timestampMs: quote.timestampMs });
    });
    this.optionStream.on("streamError", (error) => this.emit("streamError", error));
  }

  private async refreshUniverse(force = false): Promise<void> {
    const nowMs = this.now();
    if (this.universeRefreshInFlight || (!force && nowMs - this.lastUniverseRefreshMs < 60_000)) return;
    this.universeRefreshInFlight = true;
    try {
      const session = newYorkSession(nowMs);
      const proxies = [...new Set(Object.values(this.cfg.proxyByCryptoSymbol))];
      const perProxyLimit = Math.max(1, Math.floor(this.cfg.maximumStreamContracts / Math.max(proxies.length, 1)));
      const selected: AlpacaOptionContract[] = [];
      for (const proxy of proxies) {
        const quote = this.freshStockQuote(proxy);
        if (!quote) continue;
        const mid = (quote.bidPrice + quote.askPrice) / 2;
        const lower = mid * (this.cfg.targetMoneyness - this.cfg.maximumMoneynessDistance);
        const upper = mid * (this.cfg.targetMoneyness + this.cfg.maximumMoneynessDistance);
        const response = await this.rest.listOptionContracts({
          underlying_symbols: proxy, status: "active", expiration_date: session.date, type: "put", style: "american",
          strike_price_gte: lower, strike_price_lte: upper, limit: 1_000,
        });
        const candidates = response.data.option_contracts.filter((contract) => contract.tradable && contract.type === "put"
          && contract.expiration_date === session.date && Number(contract.size) === 100)
          .sort((a, b) => Math.abs(Number(a.strike_price) / mid - this.cfg.targetMoneyness)
            - Math.abs(Number(b.strike_price) / mid - this.cfg.targetMoneyness))
          .slice(0, perProxyLimit);
        selected.push(...candidates);
      }
      const mandatory: AlpacaOptionContract[] = [];
      for (const exposure of this.exposures.values()) {
        const contract = this.contracts.get(exposure.contractSymbol) ?? (await this.rest.getOptionContract(exposure.contractSymbol)).data;
        mandatory.push(contract);
      }
      for (const order of this.pending.values()) {
        const contract = this.contracts.get(order.contractSymbol) ?? (await this.rest.getOptionContract(order.contractSymbol)).data;
        if (!mandatory.some((candidate) => candidate.symbol === contract.symbol)) mandatory.push(contract);
      }
      const prioritized = [...mandatory, ...selected.filter((candidate) => !mandatory.some((item) => item.symbol === candidate.symbol))];
      for (const contract of prioritized) this.contracts.set(contract.symbol, contract);
      const symbols = prioritized.map((contract) => contract.symbol).slice(0, this.cfg.maximumStreamContracts);
      this.optionStream.setSymbols(symbols);
      this.lastUniverseRefreshMs = nowMs;
      this.emit("universe", { expirationDate: session.date, symbols });
    } catch (error) { this.emit("streamError", error); }
    finally { this.universeRefreshInFlight = false; }
  }

  private freshStockQuote(symbol: string): AlpacaStockStreamQuote | undefined {
    const quote = this.stockQuotes.get(symbol);
    if (!quote) return undefined;
    const age = this.now() - quote.timestampMs;
    return age >= -1_000 && age <= this.cfg.maximumQuoteAgeMs ? quote : undefined;
  }

  private async submit(plan: CryptoOptionShortPlan): Promise<CryptoOptionShortPlan | null> {
    const symbol = plan.cryptoSymbol;
    if (this.inFlight.has(symbol) || this.pending.has(symbol)) return this.block(symbol, "OPTION_ORDER_ALREADY_SENDING");
    this.inFlight.add(symbol);
    this.pending.set(symbol, {
      cryptoSymbol: symbol, contractSymbol: plan.contractSymbol, clientOrderId: plan.clientOrderId,
      purpose: plan.purpose, status: "SENDING", filledQty: 0, expiresMs: plan.expiresMs,
    });
    try {
      const response = await this.rest.createOrder({
        symbol: plan.contractSymbol, qty: String(plan.qty), side: plan.side, type: plan.orderType,
        time_in_force: "day", ...(plan.limitPrice === undefined ? {} : { limit_price: decimalPrice(plan.limitPrice) }),
        client_order_id: plan.clientOrderId, order_class: "simple", position_intent: plan.positionIntent,
      });
      this.pending.set(symbol, {
        cryptoSymbol: symbol, contractSymbol: plan.contractSymbol, clientOrderId: plan.clientOrderId,
        purpose: plan.purpose, alpacaOrderId: response.data.id, status: response.data.status,
        filledQty: Number(response.data.filled_qty ?? 0), expiresMs: plan.expiresMs,
      });
      const accepted = this.pending.get(symbol)!;
      if (orderCanScheduleExpiry(accepted.status)) this.schedulePendingExpiry(accepted);
      this.emit("orderAccepted", { plan, order: response.data, requestId: response.requestId });
      if (FINAL_ORDER_STATUSES.has(response.data.status)) this.emit("reconcileRequested");
      return plan;
    } catch (error) {
      const local = this.pending.get(symbol);
      // A venue HTTP error is an explicit rejection, so it is safe to release
      // the local interlock. Network/timeout failures remain UNKNOWN until a
      // reconciliation proves whether Alpaca accepted the order.
      if (error instanceof AlpacaApiError && error.status >= 400) this.pending.delete(symbol);
      else if (local) local.status = "UNKNOWN";
      this.emit("orderError", { plan, error });
      return null;
    } finally { this.inFlight.delete(symbol); }
  }

  private async closeExposure(exposure: CryptoOptionShortExposure, reason: string, emergency: boolean): Promise<void> {
    if (this.inFlight.has(exposure.cryptoSymbol) || this.pending.has(exposure.cryptoSymbol)) return;
    const nowMs = this.now();
    const contract = this.contracts.get(exposure.contractSymbol) ?? (await this.rest.getOptionContract(exposure.contractSymbol)).data;
    this.contracts.set(contract.symbol, contract);
    let limitPrice: number | undefined;
    if (!emergency) {
      const quote = this.optionQuotes.get(exposure.contractSymbol);
      const age = quote ? nowMs - quote.timestampMs : Number.POSITIVE_INFINITY;
      if (!quote || age < -1_000 || age > this.cfg.maximumQuoteAgeMs || !(quote.bidPrice > 0)) {
        this.block(exposure.cryptoSymbol, "EXIT_WEBSOCKET_QUOTE_UNAVAILABLE", { reason });
        return;
      }
      limitPrice = roundDown(quote.bidPrice * (1 - this.cfg.exitLimitBufferBps / 10_000),
        optionPriceIncrement(contract, quote.bidPrice));
      if (!(limitPrice > 0)) return;
    }
    const plan: CryptoOptionShortPlan = {
      cryptoSymbol: exposure.cryptoSymbol, proxySymbol: exposure.proxySymbol, contractSymbol: exposure.contractSymbol,
      expirationDate: exposure.expirationDate, purpose: "CLOSE_SHORT", side: "sell", positionIntent: "sell_to_close",
      qty: Math.floor(exposure.qty), orderType: emergency ? "market" : "limit", ...(limitPrice === undefined ? {} : { limitPrice }),
      maximumPremiumRiskDollars: 0, clientOrderId: ownedClientOrderId("CLOSE_SHORT", exposure.cryptoSymbol, nowMs),
      decisionId: randomUUID(), reason, createdMs: nowMs, expiresMs: nowMs + this.cfg.orderTtlMs,
      marketData: "ALPACA_WEBSOCKET",
    };
    this.emit("decision", plan);
    if (this.mode !== "shadow") await this.submit(plan);
  }

  private replacePending(nextPending: ReadonlyMap<string, PendingOptionOrder>): void {
    const retainedClientIds = new Set([...nextPending.values()].map((order) => order.clientOrderId));
    for (const [clientOrderId, timer] of this.orderTimers) {
      if (retainedClientIds.has(clientOrderId)) continue;
      clearTimeout(timer);
      this.orderTimers.delete(clientOrderId);
    }
    this.pending.clear();
    for (const [symbol, order] of nextPending) {
      this.pending.set(symbol, order);
      if (orderCanScheduleExpiry(order.status)) this.schedulePendingExpiry(order);
    }
  }

  private schedulePendingExpiry(order: PendingOptionOrder): void {
    const old = this.orderTimers.get(order.clientOrderId);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      this.orderTimers.delete(order.clientOrderId);
      const pending = this.pending.get(order.cryptoSymbol);
      if (pending?.clientOrderId === order.clientOrderId && orderCanScheduleExpiry(pending.status)) {
        void this.cancelPending(pending, "OPTION_ORDER_TTL");
      }
    }, Math.max(0, order.expiresMs - this.now()));
    timer.unref();
    this.orderTimers.set(order.clientOrderId, timer);
  }

  private async cancelPending(order: PendingOptionOrder, reason: string): Promise<void> {
    if (!order.alpacaOrderId) {
      order.status = "UNKNOWN";
      this.emit("orderCancelUnknown", { order: { ...order }, reason });
      return;
    }
    try {
      await this.rest.cancelOrder(order.alpacaOrderId);
      order.status = "pending_cancel";
      this.emit("orderCancelRequested", { order: { ...order }, reason });
    } catch (error) { this.emit("orderError", { order: { ...order }, reason, error }); }
  }

  private async maintain(): Promise<void> {
    if (!this.cfg.enabled || this.maintenanceInFlight) return;
    this.maintenanceInFlight = true;
    try {
      for (const order of [...this.pending.values()]) {
        try {
          const remote = order.alpacaOrderId
            ? (await this.rest.getOrder(order.alpacaOrderId)).data
            : (await this.rest.getOrderByClientId(order.clientOrderId)).data;
          order.alpacaOrderId = remote.id;
          order.status = remote.status;
          order.filledQty = Number(remote.filled_qty ?? 0);
          if (FINAL_ORDER_STATUSES.has(remote.status)) {
            // Keep the interlock until reconciliation atomically rebuilds
            // owned exposure from both cumulative fills and positions.
            this.emit("reconcileRequested");
          } else if (this.now() >= order.expiresMs && order.status !== "pending_cancel") {
            await this.cancelPending(order, "OPTION_ORDER_TTL");
          }
        } catch (error) {
          if (!(error instanceof AlpacaApiError && error.status === 404 && !order.alpacaOrderId)) {
            this.emit("orderError", { order: { ...order }, error });
          }
        }
      }
      if (this.now() - this.lastUniverseRefreshMs >= 60_000) await this.refreshUniverse();
      const session = newYorkSession(this.now());
      if (session.minute < this.cfg.forceExitEtMinute) return;
      for (const exposure of this.exposures.values()) {
        await this.closeExposure(exposure, "MANDATORY_0DTE_SESSION_EXIT", session.minute >= this.cfg.emergencyExitEtMinute);
      }
    } finally { this.maintenanceInFlight = false; }
  }

  private block(cryptoSymbol: string, reason: string, details: Record<string, unknown> = {}): null {
    this.emit("blocked", { cryptoSymbol, reason, details, atMs: this.now() });
    return null;
  }
}

export function selectZeroDtePut(input: {
  contracts: readonly AlpacaOptionContract[];
  quotes: ReadonlyMap<string, AlpacaOptionStreamQuote>;
  proxyMid: number;
  expirationDate: string;
  nowMs: number;
  cfg: Pick<CryptoOptionShortConfig, "targetMoneyness" | "maximumMoneynessDistance" | "maximumQuoteAgeMs" | "maximumSpreadBps">;
}): { contract: AlpacaOptionContract; quote: AlpacaOptionStreamQuote; spreadBps: number; moneyness: number } | null {
  const eligible = input.contracts.flatMap((contract) => {
    const quote = input.quotes.get(contract.symbol);
    const strike = Number(contract.strike_price);
    const moneyness = strike / input.proxyMid;
    const age = quote ? input.nowMs - quote.timestampMs : Number.POSITIVE_INFINITY;
    const mid = quote ? (quote.bidPrice + quote.askPrice) / 2 : 0;
    const spreadBps = quote && mid > 0 ? (quote.askPrice - quote.bidPrice) / mid * 10_000 : Number.POSITIVE_INFINITY;
    if (!contract.tradable || contract.status !== "active" || contract.type !== "put" || contract.style !== "american"
      || contract.expiration_date !== input.expirationDate || Number(contract.size) !== 100
      || !quote || age < -1_000 || age > input.cfg.maximumQuoteAgeMs || !(quote.bidPrice > 0)
      || !(quote.askPrice > quote.bidPrice) || !(quote.bidSize > 0) || !(quote.askSize > 0)
      || Math.abs(moneyness - input.cfg.targetMoneyness) > input.cfg.maximumMoneynessDistance
      || spreadBps > input.cfg.maximumSpreadBps) return [];
    return [{ contract, quote, spreadBps, moneyness }];
  });
  eligible.sort((a, b) => Math.abs(a.moneyness - input.cfg.targetMoneyness) - Math.abs(b.moneyness - input.cfg.targetMoneyness)
    || a.spreadBps - b.spreadBps || Number(b.contract.open_interest ?? 0) - Number(a.contract.open_interest ?? 0));
  return eligible[0] ?? null;
}

export function newYorkSession(atMs: number): { date: string; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(atMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, minute: Number(values.hour) * 60 + Number(values.minute) };
}

function ownedClientOrderId(purpose: PendingOptionOrder["purpose"], cryptoSymbol: string, atMs: number,
  entryCryptoPrice?: number): string {
  const reference = purpose === "OPEN_SHORT" && Number.isFinite(entryCryptoPrice) && entryCryptoPrice! > 0
    ? `-p${Math.round(entryCryptoPrice! * 1_000_000).toString(36)}` : "";
  return `${OPTION_ORDER_PREFIX}-${purpose === "OPEN_SHORT" ? "o" : "c"}-${symbolToken(cryptoSymbol)}-${atMs}-${randomUUID().slice(0, 8)}${reference}`;
}

function parseOwnedClientOrderId(clientOrderId: string, proxies: Readonly<Record<string, string>>): {
  purpose: PendingOptionOrder["purpose"]; cryptoSymbol: string; entryCryptoPrice?: number;
} | null {
  const match = /^mlce-opt-([oc])-([a-z0-9]+)-/.exec(clientOrderId);
  if (!match) return null;
  const cryptoSymbol = Object.keys(proxies).find((symbol) => symbolToken(symbol) === match[2]);
  if (!cryptoSymbol) return null;
  const encodedPrice = /-p([a-z0-9]+)$/.exec(clientOrderId)?.[1];
  const decodedPrice = encodedPrice ? Number.parseInt(encodedPrice, 36) / 1_000_000 : undefined;
  return {
    purpose: match[1] === "o" ? "OPEN_SHORT" : "CLOSE_SHORT", cryptoSymbol,
    ...(decodedPrice !== undefined && Number.isFinite(decodedPrice) && decodedPrice > 0
      ? { entryCryptoPrice: decodedPrice } : {}),
  };
}

function symbolToken(symbol: string): string { return symbol.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function orderCanScheduleExpiry(status: string): boolean {
  return !FINAL_ORDER_STATUSES.has(status) && !["SETTLING", "UNKNOWN", "SENDING", "RESERVED", "pending_cancel"].includes(status);
}
function optionPriceIncrement(contract: AlpacaOptionContract, price: number): number { return contract.ppind ? .01 : price < 3 ? .05 : .1; }
function roundUp(value: number, increment: number): number { return Math.ceil(value / increment - 1e-12) * increment; }
function roundDown(value: number, increment: number): number { return Math.floor(value / increment + 1e-12) * increment; }
function decimalPrice(value: number): string { return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1"); }

export function optionOrderIsFinal(status: string): boolean { return FINAL_ORDER_STATUSES.has(status); }
