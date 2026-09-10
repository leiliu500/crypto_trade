import { HOURLY_SYMBOLS, type HourlyBar, type HourlySymbol } from "./hourly-data.js";
import { HOURLY_MS as HOUR, HOURLY_EXIT_RETRY_HOURS, HOURLY_SCENARIOS } from "./hourly-retry-simulator.js";
import type { AssetRules } from "../execution/planner.js";
export type { HourlyBar, HourlySymbol, AssetRules };

export const HOURLY_NET_LABEL_SPEC = Object.freeze({
  version: "kraken-hourly-counterfactual-net-labels-v1", horizonHours: 24, capacityUsd: 12,
  maximumCompletionHours: 51, maximumExitRetryHours: HOURLY_EXIT_RETRY_HOURS,
  normalization: "NET_USD_DIVIDED_BY_FIXED_12_USD_CAPACITY_TIMES_10000",
  accounting: "ADVERSE_FUNDING_RESERVE_SCENARIO_NOT_VERIFIED_HISTORICAL_FUNDING",
  completion: "COMPLETE_EXIT_CANDLE_CLOSE;_UNFILLED_ENTRY_RECEIPT;_UNKNOWN_EXCLUDED",
});
export type HourlyNetLabelScenario = "base" | "stress";
export interface HourlyNetLabel {
  symbol: HourlySymbol; decisionMs: number; side: 1 | -1; scenario: HourlyNetLabelScenario;
  status: "COMPLETE" | "UNFILLED" | "UNKNOWN"; completedAtMs: number;
  horizonHours: 24; capacityUsd: 12; netBps: number | null; netPnlUsd: number | null;
  scheduledEntryMs: number; scheduledExitMs: number; entryMs: number | null; exitMs: number | null;
  qty: number | null; entryNotionalUsd: number | null;
  entryReferencePx: number | null; exitReferencePx: number | null; entryPx: number | null; exitPx: number | null;
  grossPnlUsd: number | null; feesUsd: number; slippageUsd: number; fundingUsd: number; fundingReserveUsd: number;
  fundingHours: number; staleMarkHours: number;
  noFillReason: "ZERO_VOLUME" | "BELOW_MINIMUM_QUANTITY" | null;
  invalidReasons: Array<{atMs: number; reason: string}>;
  exitAttempts: Array<{attemptMs: number; knownAtMs: number; status: "FILLED" | "ZERO_VOLUME_UNFILLED" | "MISSING_BAR"}>;
  exitRetryCount: number; exitDelayHours: number | null; exitRetryExhausted: boolean;
}
const aligned = (n: number) => Number.isSafeInteger(n) && n >= 0 && n % HOUR === 0;
const validSymbol = (s: string): s is HourlySymbol => (HOURLY_SYMBOLS as readonly string[]).includes(s);
const key = (s: HourlySymbol, at: number) => `${s}:${at}`;
const nonnegative = (n: number) => Number.isFinite(n) && n >= 0;
function decimalPlaces(value: number): number {
  const [coefficient, exponent = "0"] = String(value).split("e");
  return Math.max(0, (coefficient!.split(".")[1]?.length ?? 0) - Number(exponent));
}
const gridValue = (units: number, increment: number) => Number((units * increment).toFixed(decimalPlaces(increment)));
// These private operations deliberately preserve the sealed retry simulator's
// arithmetic. Synthetic parity tests guard both directions and cost scenarios.
function adversePrice(reference: number, side: 1 | -1, slippage: number, tick: number): number {
  const raw = reference * (1 + side * slippage), units = raw / tick, nearest = Math.round(units);
  const exact = Math.abs(units - nearest) <= Number.EPSILON * 4 * Math.max(1, Math.abs(units));
  const rounded = gridValue(exact ? nearest : side === 1 ? Math.ceil(units) : Math.floor(units), tick);
  if (!Number.isFinite(rounded) || rounded <= 0) throw new Error("HOURLY_NET_LABEL_ROUNDED_PRICE");
  return rounded;
}
function entryQuantity(price: number, rules: AssetRules): number {
  let units = Math.floor(Math.min(12 / price, rules.maximumOrderQty) / rules.minTradeIncrement);
  let qty = gridValue(units, rules.minTradeIncrement);
  while (units > 0 && (qty * price > 12 || qty > rules.maximumOrderQty)) {
    units--; qty = gridValue(units, rules.minTradeIncrement);
  }
  return qty >= rules.minOrderSize ? qty : 0;
}

/** Independent, one-position counterfactual labels. The caller must restrict
 * origins and require completedAtMs strictly before its training cutoff. No
 * future gap is used to prefilter an origin or turn an unknown return into zero.
 * Funding reserves must already have been fixed from causal training data. */
export class HourlyNetLabelIndex {
  private readonly bars = new Map<string, Readonly<HourlyBar>>();
  private readonly rules: Readonly<Record<HourlySymbol, AssetRules>>;
  private readonly reserves: Readonly<Record<HourlyNetLabelScenario, Readonly<Record<HourlySymbol, number>>>>;
  constructor(bars: readonly HourlyBar[], assetRules: Readonly<Record<HourlySymbol, AssetRules>>,
    baseReserve: Readonly<Record<HourlySymbol, number>>, stressReserve: Readonly<Record<HourlySymbol, number>>) {
    if (!Array.isArray(bars)) throw new Error("HOURLY_NET_LABEL_BARS");
    for (const symbol of HOURLY_SYMBOLS) {
      const r = assetRules?.[symbol];
      if (!r || r.symbol !== symbol || typeof r.shortable !== "boolean"
        || ![r.minOrderSize, r.minTradeIncrement, r.priceIncrement, r.maximumOrderQty].every(n => Number.isFinite(n) && n > 0)
        || decimalPlaces(r.minTradeIncrement) > 12 || decimalPlaces(r.priceIncrement) > 12
        || r.maximumOrderQty < r.minOrderSize) throw new Error("HOURLY_NET_LABEL_RULES");
      if (!nonnegative(baseReserve?.[symbol]) || !nonnegative(stressReserve?.[symbol])) throw new Error("HOURLY_NET_LABEL_RESERVE");
    }
    this.rules = structuredClone(assetRules);
    this.reserves = {base: {...baseReserve}, stress: {...stressReserve}};
    for (const b of bars) {
      if (!b || !validSymbol(b.symbol) || !aligned(b.openMs)
        || ![b.open, b.high, b.low, b.close].every(n => Number.isFinite(n) && n > 0)
        || !nonnegative(b.volume) || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close)
        || b.high < b.low || this.bars.has(key(b.symbol, b.openMs))) throw new Error("HOURLY_NET_LABEL_BAR");
      this.bars.set(key(b.symbol, b.openMs), Object.freeze({...b}));
    }
  }

  label(symbol: HourlySymbol, decisionMs: number, side: 1 | -1, scenario: HourlyNetLabelScenario): HourlyNetLabel {
    if (!validSymbol(symbol) || !aligned(decisionMs) || !aligned(decisionMs + 51 * HOUR)
      || (side !== 1 && side !== -1) || (scenario !== "base" && scenario !== "stress")) throw new Error("HOURLY_NET_LABEL_QUERY");
    if (side === -1 && !this.rules[symbol].shortable) throw new Error("HOURLY_NET_LABEL_SHORT_DISABLED");
    const execution = HOURLY_SCENARIOS[scenario], rules = this.rules[symbol];
    const scheduledEntryMs = decisionMs + execution.delayHours * HOUR, scheduledExitMs = scheduledEntryMs + 24 * HOUR;
    const latestAttemptMs = scheduledExitMs + HOURLY_EXIT_RETRY_HOURS * HOUR;
    const r: HourlyNetLabel = {symbol, decisionMs, side, scenario, status: "UNKNOWN", completedAtMs: latestAttemptMs + HOUR,
      horizonHours: 24, capacityUsd: 12, netBps: null, netPnlUsd: null, scheduledEntryMs, scheduledExitMs,
      entryMs: null, exitMs: null, qty: null, entryNotionalUsd: null,
      entryReferencePx: null, exitReferencePx: null, entryPx: null, exitPx: null,
      grossPnlUsd: null, feesUsd: 0, slippageUsd: 0, fundingUsd: 0, fundingReserveUsd: 0,
      fundingHours: 0, staleMarkHours: 0, noFillReason: null, invalidReasons: [], exitAttempts: [],
      exitRetryCount: 0, exitDelayHours: null, exitRetryExhausted: false};
    const invalidate = (atMs: number, reason: string) => {r.invalidReasons.push({atMs, reason});};
    const unfilled = (atMs: number, reason: HourlyNetLabel["noFillReason"]) => {
      r.status = "UNFILLED"; r.completedAtMs = atMs; r.exitMs = atMs; r.noFillReason = reason;
      r.netBps = 0; r.netPnlUsd = 0; r.grossPnlUsd = 0; return r;
    };
    const entry = this.bars.get(key(symbol, scheduledEntryMs));
    if (!entry) {invalidate(scheduledEntryMs, "MISSING_ENTRY_BAR"); r.completedAtMs = scheduledEntryMs + HOUR; return r;}
    if (entry.volume === 0) return unfilled(scheduledEntryMs + HOUR, "ZERO_VOLUME");
    const slipRate = execution.slippageBpsPerSide / 10000, feeRate = execution.feeBpsPerSide / 10000;
    const entryPx = adversePrice(entry.open, side, slipRate, rules.priceIncrement), qty = entryQuantity(entryPx, rules);
    if (qty === 0) return unfilled(scheduledEntryMs, "BELOW_MINIMUM_QUANTITY");
    r.entryMs = scheduledEntryMs; r.entryReferencePx = entry.open; r.entryPx = entryPx; r.qty = qty;
    r.entryNotionalUsd = qty * entryPx; r.feesUsd = qty * entryPx * feeRate; r.slippageUsd = qty * side * (entryPx - entry.open);
    for (let atMs = scheduledEntryMs + HOUR; atMs <= latestAttemptMs; atMs += HOUR) {
      const mark = this.bars.get(key(symbol, atMs));
      if (!mark) invalidate(atMs, "MISSING_MARK_BAR");
      else {
        if (mark.volume === 0) r.staleMarkHours++;
        r.fundingUsd += qty * mark.open * this.reserves[scenario][symbol] / 10000;
        r.fundingReserveUsd += qty * mark.open * execution.extraAdverseFundingBpsPer24h / 10000 / 24;
        r.fundingHours++;
      }
      if (atMs < scheduledExitMs) continue;
      r.exitRetryCount = (atMs - scheduledExitMs) / HOUR;
      if (!mark) {
        invalidate(atMs, "MISSING_EXIT_BAR");
        r.exitAttempts.push({attemptMs: atMs, knownAtMs: atMs + HOUR, status: "MISSING_BAR"});
      } else if (mark.volume === 0) {
        r.exitAttempts.push({attemptMs: atMs, knownAtMs: atMs + HOUR, status: "ZERO_VOLUME_UNFILLED"});
      } else {
        const exitPx = adversePrice(mark.open, side === 1 ? -1 : 1, slipRate, rules.priceIncrement);
        r.exitMs = atMs; r.completedAtMs = atMs + HOUR; r.exitReferencePx = mark.open; r.exitPx = exitPx;
        r.feesUsd += qty * exitPx * feeRate; r.slippageUsd += qty * side * (mark.open - exitPx);
        r.grossPnlUsd = side * qty * (mark.open - entry.open);
        r.exitDelayHours = (atMs - scheduledExitMs) / HOUR;
        r.exitAttempts.push({attemptMs: atMs, knownAtMs: atMs + HOUR, status: "FILLED"});
        if (!r.invalidReasons.length) {
          r.status = "COMPLETE";
          r.netPnlUsd = r.grossPnlUsd - r.feesUsd - r.slippageUsd - r.fundingUsd - r.fundingReserveUsd;
          r.netBps = r.netPnlUsd / 12 * 10000;
        }
        return r;
      }
    }
    // The final zero-volume attempt owns inventory until its no-fill receipt
    // one hour later. Include that last known carry hour, although the label's
    // total return remains unknown and must never enter supervised fitting.
    const finalMark = this.bars.get(key(symbol, r.completedAtMs));
    if (!finalMark) invalidate(r.completedAtMs, "MISSING_MARK_BAR");
    else {
      if (finalMark.volume === 0) r.staleMarkHours++;
      r.fundingUsd += qty * finalMark.open * this.reserves[scenario][symbol] / 10000;
      r.fundingReserveUsd += qty * finalMark.open * execution.extraAdverseFundingBpsPer24h / 10000 / 24;
      r.fundingHours++;
    }
    r.exitRetryExhausted = true; invalidate(r.completedAtMs, "EXIT_RETRY_LIMIT_EXCEEDED");
    return r;
  }
}
