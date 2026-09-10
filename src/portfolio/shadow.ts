import { createHash } from "node:crypto";
import { applyPortfolioFill, applyPortfolioFunding, cancelPortfolioOrder, newPortfolioState, planPortfolioAdjustment,
  portfolioEquity, reservePortfolioOrders, validatePortfolioState } from "./kernel.js";
import { PORTFOLIO_DAY_MS as DAY, PORTFOLIO_HOUR_MS as HOUR, PORTFOLIO_SPEC, PORTFOLIO_SYMBOLS as SYMBOLS,
  PORTFOLIO_VERSION, type AssetRules, type Pair, type PortfolioFill, type PortfolioPlan, type PortfolioQuote,
  type PortfolioState, type PortfolioTarget } from "./types.js";

export const PORTFOLIO_SHADOW_SPEC = Object.freeze({ version: "btc-eth-target-portfolio-shadow-v1", shadowOnly: true,
  execution: "SHADOW_VIRTUAL_FILLS", minimumActivationDelayMs: HOUR, minimumQuoteAfterReservationMs: 250,
  pendingExpiryMs: 5_000, adjustmentIntervalMs: HOUR, fullyCostedProfitAvailable: false,
  funding: "UNOBSERVED_UNLESS_EXPLICIT_RECEIPTS;COVERAGE_NOT_INFERRED", expiredTarget: "REDUCE_TO_FLAT_ON_FRESH_QUOTES" });
export interface PortfolioShadowEvent {
  type: "TARGET_ACCEPTED" | "TARGET_INVALID" | "PLAN" | "VIRTUAL_FILL" | "VIRTUAL_CANCEL" | "QUOTES_INVALID" | "FUNDING_RECEIPT";
  atMs: number; reason: string; orderId?: string; fill?: PortfolioFill; plan?: PortfolioPlan;
}
interface Counters { targets: number; plans: number; cancellations: number; invalidations: number; quoteUpdates: number }
interface TargetInvalidation { reason: string; atMs: number; targetDecisionMs: number | null }
interface CheckpointBody {
  version: typeof PORTFOLIO_SHADOW_SPEC.version; configurationSha256: string; shadowOnly: true;
  state: PortfolioState; target: PortfolioTarget | null; lastNowMs: number;
  lastPhaseHourMs: number | null; counters: Counters; targetInvalidation: TargetInvalidation | null;
}
export interface PortfolioShadowCheckpoint extends CheckpointBody { contentSha256: string }
const copy = <T>(value: T): T => structuredClone(value);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const policies = ["multiscale-trend", "sign-trend-90d", "constant-btc", "constant-eth", "flat"];

function validateTarget(target: PortfolioTarget, nowMs: number): void {
  if (!target || target.version !== PORTFOLIO_VERSION || !policies.includes(target.policy)
    || !time(target.decisionMs) || target.decisionMs % DAY !== 0 || !time(target.availableAtMs)
    || target.availableAtMs < target.decisionMs || target.availableAtMs > nowMs
    || !time(target.validUntilMs) || target.validUntilMs !== target.decisionMs + PORTFOLIO_SPEC.targetValidityMs
    || target.validUntilMs <= target.availableAtMs || !/^[a-f0-9]{64}$/.test(target.inputSha256)
    || SYMBOLS.some(s => !finite(target.targetUsd?.[s]))
    || SYMBOLS.reduce((sum, s) => sum + Math.abs(target.targetUsd[s]), 0) > PORTFOLIO_SPEC.maximumGrossNotionalUsd + 1e-10
    || !Array.isArray(target.signals) || target.signals.length !== 2
    || new Set(target.signals.map(s => s.symbol)).size !== 2
    || target.signals.some(s => !SYMBOLS.includes(s.symbol) || !positive(s.close)
      || !finite(s.dailyVolatility) || s.dailyVolatility < PORTFOLIO_SPEC.minimumDailyVolatility
      || !finite(s.score) || Math.abs(s.score) > 1 || !finite(s.relativeRiskWeight)
      || s.relativeRiskWeight < 0 || s.relativeRiskWeight > 1 || !Array.isArray(s.trendScores)
      || s.trendScores.length !== 3 || s.trendScores.some(v => !finite(v) || Math.abs(v) > 1))
    || Math.abs(target.signals.reduce((sum, s) => sum + s.relativeRiskWeight, 0) - 1) > 1e-10)
    throw new Error("PORTFOLIO_SHADOW_INVALID_TARGET");
}
function validQuote(q: PortfolioQuote | undefined, symbol: typeof SYMBOLS[number], nowMs: number): q is PortfolioQuote {
  return !!q && q.symbol === symbol && time(q.atMs) && q.atMs <= nowMs && nowMs - q.atMs <= PORTFOLIO_SPEC.maximumQuoteAgeMs
    && positive(q.bid) && positive(q.ask) && q.ask >= q.bid && finite(q.bidQty) && q.bidQty >= 0 && finite(q.askQty) && q.askQty >= 0;
}
function lotFloor(qty: number, increment: number): number {
  const units = qty / increment, nearest = Math.round(units);
  return Math.max(0, (Math.abs(units - nearest) < 1e-10 ? nearest : Math.floor(units)) * increment);
}

/** Virtual execution only. No broker, gateway, environment or filesystem access.
 * Caller serializes callbacks and durably saves checkpoint() after each change.
 * Actual source receipt times govern quote fills; elapsed timers cannot fill.
 */
export class PortfolioShadowController {
  private readonly rules: Pair<AssetRules>;
  private readonly feeBps: number;
  private readonly initialEquityUsd: number;
  private readonly configurationSha256: string;
  private state: PortfolioState;
  private target: PortfolioTarget | null = null;
  private targetInvalidation: TargetInvalidation | null = null;
  private quotes: Pair<PortfolioQuote> | null = null;
  private lastNowMs = 0;
  private quoteFloorMs = 0;
  private lastPhaseHourMs: number | null = null;
  private lastPlan: PortfolioPlan | null = null;
  private quoteReason = "WAITING_FOR_PUBLIC_QUOTES";
  private counters: Counters = { targets: 0, plans: 0, cancellations: 0, invalidations: 0, quoteUpdates: 0 };

  public constructor(options: { rules: Pair<AssetRules>; feeBps?: number; initialEquityUsd?: number }) {
    this.feeBps = options.feeBps ?? 5; this.initialEquityUsd = options.initialEquityUsd ?? 100_000;
    if (!finite(this.feeBps) || this.feeBps < 0 || !positive(this.initialEquityUsd)
      || SYMBOLS.some(s => { const r = options.rules?.[s]; return !r || r.symbol !== s || typeof r.shortable !== "boolean"
        || ![r.minOrderSize, r.minTradeIncrement, r.priceIncrement, r.maximumOrderQty].every(positive)
        || r.maximumOrderQty < r.minOrderSize; })) throw new Error("PORTFOLIO_SHADOW_INVALID_CONFIG");
    this.rules = { "BTC/USD": copy(options.rules["BTC/USD"]), "ETH/USD": copy(options.rules["ETH/USD"]) };
    this.state = newPortfolioState(this.initialEquityUsd);
    this.configurationSha256 = hash({ version: PORTFOLIO_SHADOW_SPEC.version, strategy: PORTFOLIO_SPEC,
      execution: PORTFOLIO_SHADOW_SPEC, feeBps: this.feeBps, initialEquityUsd: this.initialEquityUsd,
      rules: SYMBOLS.map(s => { const r = this.rules[s]; return { symbol: s, minOrderSize: r.minOrderSize,
        minTradeIncrement: r.minTradeIncrement, priceIncrement: r.priceIncrement,
        maximumOrderQty: r.maximumOrderQty, shortable: r.shortable }; }) });
  }

  public setTarget(target: PortfolioTarget, nowMs: number): PortfolioShadowEvent[] {
    this.checkClock(nowMs); validateTarget(target, nowMs);
    if (this.target && target.decisionMs < this.target.decisionMs) throw new Error("PORTFOLIO_SHADOW_REVERSED_TARGET");
    if (this.target?.decisionMs === target.decisionMs && hash(this.target) !== hash(target))
      throw new Error("PORTFOLIO_SHADOW_CONFLICTING_TARGET");
    this.lastNowMs = nowMs;
    if (this.target?.decisionMs === target.decisionMs) return [];
    const events = this.cancelAll("TARGET_SUPERSEDED", nowMs);
    this.target = copy(target); this.targetInvalidation = null; this.counters.targets++;
    events.push({ type: "TARGET_ACCEPTED", atMs: nowMs, reason: "WAIT_FOR_DECISION_PLUS_ONE_HOUR_AND_FRESH_QUOTES" });
    return events;
  }

  public onQuotes(quotes: Pair<PortfolioQuote>, nowMs: number): PortfolioShadowEvent[] {
    this.checkClock(nowMs); this.lastNowMs = nowMs;
    if (SYMBOLS.some(s => !validQuote(quotes?.[s], s, nowMs) || quotes[s].atMs < this.quoteFloorMs
      || this.quotes && (quotes[s].atMs < this.quotes[s].atMs
        || quotes[s].atMs === this.quotes[s].atMs && hash(quotes[s]) !== hash(this.quotes[s]))))
      return this.invalidateQuotes("STALE_INVALID_OR_REVERSED_PUBLIC_QUOTE");
    const advanced = !this.quotes || SYMBOLS.some(s => quotes[s].atMs > this.quotes![s].atMs);
    this.quotes = copy(quotes); this.quoteReason = "READY";
    if (advanced) this.counters.quoteUpdates++;
    const events: PortfolioShadowEvent[] = [];
    for (const order of [...this.state.pending]) {
      const expiredTarget = this.target !== null && nowMs >= this.target.validUntilMs;
      if (nowMs - order.createdAtMs >= PORTFOLIO_SHADOW_SPEC.pendingExpiryMs || (expiredTarget || this.targetInvalidation) && !order.reduceOnly) {
        events.push(...this.cancel(order.id, this.targetInvalidation ? "TARGET_INVALIDATED"
          : expiredTarget ? "TARGET_EXPIRED" : "VIRTUAL_IOC_EXPIRED", nowMs)); continue;
      }
      const quote = quotes[order.symbol];
      if (!advanced || quote.atMs < order.createdAtMs + PORTFOLIO_SHADOW_SPEC.minimumQuoteAfterReservationMs) continue;
      const buy = order.signedQty > 0, price = buy ? quote.ask : quote.bid;
      const inLimit = buy ? price <= order.limitPrice + 1e-10 : price >= order.limitPrice - 1e-10;
      let availableQty = Math.min(order.remainingQty, buy ? quote.askQty : quote.bidQty);
      if (!order.reduceOnly) {
        const otherGross = SYMBOLS.reduce((sum, s) => sum + Math.abs(this.state.positions[s].qty) * quotes[s].ask, 0)
          + this.state.pending.filter(o => o.id !== order.id && !o.reduceOnly)
            .reduce((sum, o) => sum + o.remainingQty * quotes[o.symbol].ask, 0);
        availableQty = Math.min(availableQty, Math.max(0, PORTFOLIO_SPEC.maximumGrossNotionalUsd - otherGross) / quote.ask);
      }
      const qty = inLimit ? lotFloor(availableQty, this.rules[order.symbol].minTradeIncrement) : 0;
      if (qty > 0) {
        const fill: PortfolioFill = { id: `${order.id}:shadow-ioc`, orderId: order.id, symbol: order.symbol,
          atMs: nowMs, signedQty: Math.sign(order.signedQty) * qty, price, feeUsd: qty * price * this.feeBps / 10_000 };
        this.state = applyPortfolioFill(this.state, fill);
        events.push({ type: "VIRTUAL_FILL", atMs: nowMs, reason: "SHADOW_VIRTUAL_FILLS", orderId: order.id, fill: copy(fill) });
      }
      events.push(...this.cancel(order.id, qty > 0 ? "VIRTUAL_IOC_REMAINDER_CANCELED" : "VIRTUAL_IOC_UNFILLED", nowMs));
    }
    if (!advanced || this.state.pending.length || !this.target
      || !this.targetInvalidation && nowMs < Math.max(this.target.availableAtMs, this.target.decisionMs + HOUR)) return events;
    const hour = Math.floor(nowMs / HOUR) * HOUR;
    if (this.lastPhaseHourMs === hour) return events;
    const plan = planPortfolioAdjustment({ state: this.state, target: this.target, quotes, rules: this.rules,
      atMs: nowMs, feeBps: this.feeBps, forceFlat: this.targetInvalidation !== null || nowMs >= this.target.validUntilMs });
    this.state = reservePortfolioOrders(this.state, plan);
    this.lastPhaseHourMs = hour; this.lastPlan = copy(plan); this.counters.plans++;
    events.push({ type: "PLAN", atMs: nowMs, reason: plan.reason, plan: copy(plan) });
    return events;
  }

  public invalidateQuotes(reason: string): PortfolioShadowEvent[] {
    if (typeof reason !== "string" || !reason.trim()) throw new Error("PORTFOLIO_SHADOW_INVALID_REASON");
    this.quotes = null; this.quoteFloorMs = this.lastNowMs; this.quoteReason = reason; this.counters.invalidations++;
    return [...this.cancelAll("PUBLIC_QUOTES_UNAVAILABLE", this.lastNowMs),
      { type: "QUOTES_INVALID", atMs: this.lastNowMs, reason }];
  }

  public invalidateTarget(reason: string, nowMs: number): PortfolioShadowEvent[] {
    this.checkClock(nowMs);
    if (typeof reason !== "string" || !reason.trim()) throw new Error("PORTFOLIO_SHADOW_INVALID_REASON");
    this.lastNowMs = nowMs;
    this.targetInvalidation = { reason, atMs: nowMs, targetDecisionMs: this.target?.decisionMs ?? null };
    const events = this.state.pending.filter(order => !order.reduceOnly)
      .flatMap(order => this.cancel(order.id, "TARGET_INVALIDATED", nowMs));
    return [...events, { type: "TARGET_INVALID", atMs: nowMs, reason }];
  }

  public onFunding(receipt: { id: string; atMs: number; costUsd: number }, nowMs: number): PortfolioShadowEvent[] {
    this.checkClock(nowMs);
    if (!receipt || !time(receipt.atMs) || receipt.atMs > nowMs) throw new Error("PORTFOLIO_SHADOW_FUTURE_FUNDING");
    const previous = this.state.fundingReceipts.length;
    const next = applyPortfolioFunding(this.state, receipt);
    this.state = next; this.lastNowMs = nowMs;
    return previous === next.fundingReceipts.length ? [] : [{ type: "FUNDING_RECEIPT", atMs: nowMs,
      reason: "EXPLICIT_FUNDING_RECEIPT_COVERAGE_STILL_UNVERIFIED" }];
  }

  public snapshot(asOfMs = this.lastNowMs) {
    this.checkClock(asOfMs);
    const quoteReady = this.quotes !== null && SYMBOLS.every(s => validQuote(this.quotes![s], s, asOfMs));
    const hasInventory = SYMBOLS.some(s => this.state.positions[s].qty !== 0);
    const equity = quoteReady ? portfolioEquity(this.state, {
      "BTC/USD": (this.quotes!["BTC/USD"].bid + this.quotes!["BTC/USD"].ask) / 2,
      "ETH/USD": (this.quotes!["ETH/USD"].bid + this.quotes!["ETH/USD"].ask) / 2 })
      : !hasInventory ? { equityUsd: this.state.cashUsd, unrealizedPnlUsd: 0, grossNotionalUsd: 0 } : null;
    const dataReady = this.targetInvalidation === null && this.target !== null && asOfMs >= Math.max(this.target.availableAtMs, this.target.decisionMs + HOUR)
      && asOfMs < this.target.validUntilMs;
    return { version: PORTFOLIO_SHADOW_SPEC.version, strategyVersion: PORTFOLIO_VERSION, shadowOnly: true,
      execution: "SHADOW_VIRTUAL_FILLS", realOrdersAllowed: false, configurationSha256: this.configurationSha256,
      atMs: asOfMs, generatedAtMs: asOfMs, lastEventAtMs: this.lastNowMs,
      target: copy(this.target), actual: copy(this.state.positions), pending: copy(this.state.pending),
      quoteReady, quoteReason: quoteReady ? "READY" : this.quoteReason === "READY" ? "STALE_PUBLIC_QUOTES" : this.quoteReason,
      targetInvalidation: copy(this.targetInvalidation),
      dataReady, dataReason: this.targetInvalidation ? "TARGET_INVALIDATED_REDUCE_TO_FLAT" : !this.target ? "WAITING_TARGET" : asOfMs >= this.target.validUntilMs ? "TARGET_EXPIRED_REDUCE_TO_FLAT"
        : !dataReady ? "WAITING_TARGET_ACTIVATION" : "READY",
      lastPhaseHourMs: this.lastPhaseHourMs, lastPlan: copy(this.lastPlan), counters: { ...this.counters,
        reservedOrders: this.state.nextOrderSequence, fills: this.state.fillReceipts.length, fundingReceipts: this.state.fundingReceipts.length },
      initialEquityUsd: this.initialEquityUsd, cashUsd: this.state.cashUsd, totalFeesUsd: this.state.totalFeesUsd,
      totalTurnoverUsd: this.state.totalTurnoverUsd, realizedPricePnlUsd: this.state.realizedPricePnlUsd,
      executionOnlyEquityUsd: equity === null ? null : equity.equityUsd + this.state.totalFundingCostUsd,
      equityMarkBasis: "FRESH_MIDPOINT;UNPAID_EXIT_FEES_EXCLUDED",
      equityIncludingObservedFundingUsd: equity?.equityUsd ?? null, unrealizedPnlUsd: equity?.unrealizedPnlUsd ?? null,
      grossNotionalUsd: equity?.grossNotionalUsd ?? null, totalObservedFundingCostUsd: this.state.totalFundingCostUsd,
      fundingEvidence: this.state.fundingReceipts.length ? "PARTIAL_FUNDING_RECEIPTS_COVERAGE_UNVERIFIED" : "FUNDING_UNOBSERVED",
      fullyCostedNetPnlUsd: null };
  }

  public checkpoint(): PortfolioShadowCheckpoint {
    const body: CheckpointBody = { version: PORTFOLIO_SHADOW_SPEC.version, configurationSha256: this.configurationSha256,
      shadowOnly: true, state: copy(this.state), target: copy(this.target), lastNowMs: this.lastNowMs,
      lastPhaseHourMs: this.lastPhaseHourMs, counters: { ...this.counters }, targetInvalidation: copy(this.targetInvalidation) };
    return { ...body, contentSha256: hash(body) };
  }

  public restore(value: unknown, nowMs: number): PortfolioShadowEvent[] {
    this.checkClock(nowMs);
    const candidate = copy(value) as PortfolioShadowCheckpoint;
    if (!candidate || candidate.version !== PORTFOLIO_SHADOW_SPEC.version || candidate.shadowOnly !== true
      || candidate.configurationSha256 !== this.configurationSha256) throw new Error("PORTFOLIO_SHADOW_CHECKPOINT_CONFIG");
    const { contentSha256, ...body } = candidate;
    if (hash(body) !== contentSha256 || !validatePortfolioState(candidate.state)
      || candidate.state.initialEquityUsd !== this.initialEquityUsd || !time(candidate.lastNowMs) || candidate.lastNowMs > nowMs
      || candidate.lastPhaseHourMs !== null && (!time(candidate.lastPhaseHourMs) || candidate.lastPhaseHourMs % HOUR !== 0
        || candidate.lastPhaseHourMs > candidate.lastNowMs)
      || !candidate.counters || ["targets", "plans", "cancellations", "invalidations", "quoteUpdates"]
        .some(k => !time(candidate.counters[k as keyof Counters]))
      || candidate.state.fillReceipts.some(f => f.atMs > candidate.lastNowMs)
      || candidate.state.fundingReceipts.some(f => f.atMs > candidate.lastNowMs)
      || candidate.state.pending.some(o => o.createdAtMs > candidate.lastNowMs || !candidate.target
        || o.targetDecisionMs !== candidate.target.decisionMs || o.createdAtMs < Math.max(candidate.target.availableAtMs, candidate.target.decisionMs + HOUR)))
      throw new Error("PORTFOLIO_SHADOW_INVALID_CHECKPOINT");
    if (candidate.target !== null) validateTarget(candidate.target, candidate.lastNowMs);
    const invalid = candidate.targetInvalidation;
    if (invalid !== null && (!invalid || typeof invalid.reason !== "string" || !invalid.reason.trim()
      || !time(invalid.atMs) || invalid.atMs > candidate.lastNowMs
      || invalid.targetDecisionMs !== (candidate.target?.decisionMs ?? null))) throw new Error("PORTFOLIO_SHADOW_INVALID_TARGET_INVALIDATION");
    this.state = candidate.state; this.target = candidate.target; this.lastNowMs = nowMs;
    this.targetInvalidation = invalid;
    this.lastPhaseHourMs = candidate.lastPhaseHourMs; this.counters = candidate.counters;
    this.quotes = null; this.quoteFloorMs = nowMs; this.quoteReason = "RESTORED_AWAITING_FRESH_QUOTES"; this.lastPlan = null;
    return this.cancelAll("SHADOW_RESTART_PENDING_CANCELED", nowMs);
  }

  private checkClock(nowMs: number): void {
    if (!time(nowMs) || nowMs < this.lastNowMs) throw new Error("PORTFOLIO_SHADOW_INVALID_OR_REVERSED_CLOCK");
  }
  private cancel(id: string, reason: string, atMs: number): PortfolioShadowEvent[] {
    if (!this.state.pending.some(o => o.id === id)) return [];
    this.state = cancelPortfolioOrder(this.state, id); this.counters.cancellations++;
    return [{ type: "VIRTUAL_CANCEL", atMs, reason, orderId: id }];
  }
  private cancelAll(reason: string, atMs: number): PortfolioShadowEvent[] {
    return [...this.state.pending].flatMap(order => this.cancel(order.id, reason, atMs));
  }
}
