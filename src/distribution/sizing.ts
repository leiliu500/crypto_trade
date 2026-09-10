import { createHash } from "node:crypto";
import type { SymbolConfig } from "../config.js";
import type { BookState } from "../core/market.js";
import type { AssetRules } from "../execution/planner.js";
import { RiskSizer, type RiskConfig } from "../risk/sizing.js";
import { CostModel, type CostConfig } from "../strategy/cost.js";
import type { DeterministicFeatures } from "../strategy/deterministic-features.js";

const VERSION = "distribution-risk-bounded-sizing-v1";
export const LEGACY_SIZING_ID = "distribution-fixed-12-usd-v1";
export interface DistributionSizingPolicy {
  version: typeof VERSION;
  maximumNotional: number;
  maximumEquityFraction: number;
  symbols: Record<string, { maximumNotional: number; risk: RiskConfig; cost: CostConfig; jumpSigma: number }>;
}
export interface DistributionSizingContext {
  equity: number; equityHighWater: number; features: DeterministicFeatures;
}
export interface DistributionSize {
  qty: number; maximumNotional: number; minimumOrderNotional: number | null;
  reason: string; bindingLimit: string | null;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function distributionSizingId(policy?: DistributionSizingPolicy): string {
  return policy ? createHash("sha256").update(canonical(policy)).digest("hex") : LEGACY_SIZING_ID;
}
export function createDistributionSizingPolicy(configs: Readonly<Record<string, SymbolConfig>>,
  maximumNotional: number, maximumEquityFraction: number): DistributionSizingPolicy {
  const policy: DistributionSizingPolicy = { version: VERSION, maximumNotional, maximumEquityFraction,
    symbols: Object.fromEntries(Object.entries(configs).map(([symbol, cfg]) => [symbol, {
      maximumNotional: Math.min(maximumNotional, cfg.maximumNotional), risk: { ...cfg.sizing },
      cost: { ...cfg.cost }, jumpSigma: cfg.jumpSigma,
    }])) };
  assertDistributionSizingPolicy(policy);
  return policy;
}
export function assertDistributionSizingPolicy(policy: DistributionSizingPolicy): void {
  const positive = (n: number) => Number.isFinite(n) && n > 0;
  const fraction = (n: number) => positive(n) && n <= 1;
  if (!policy || policy.version !== VERSION || !positive(policy.maximumNotional)
    || !fraction(policy.maximumEquityFraction) || !policy.symbols || !Object.keys(policy.symbols).length)
    throw new Error("INVALID_DISTRIBUTION_SIZING_POLICY");
  for (const cfg of Object.values(policy.symbols)) {
    if (!cfg || !positive(cfg.maximumNotional) || cfg.maximumNotional > policy.maximumNotional
      || !positive(cfg.jumpSigma) || !cfg.risk || !cfg.cost
      || !Object.values(cfg.risk).every(positive)
      || ![cfg.risk.baseRiskFraction, cfg.risk.maximumDrawdown, cfg.risk.maximumBookParticipation,
        cfg.risk.fractionalKelly, cfg.risk.maximumKellyFraction, cfg.risk.minimumQualityScale].every(fraction)
      || !Object.values(cfg.cost).every(n => Number.isFinite(n) && n >= 0))
      throw new Error("INVALID_DISTRIBUTION_SIZING_POLICY");
    new CostModel(cfg.cost);
  }
}
/** Separate files prevent changing size from overwriting or relabelling $12 evidence. */
export function distributionSizingStateFile(path: string, policy?: DistributionSizingPolicy): string {
  return policy ? `${path}.sizing-${distributionSizingId(policy)}.json` : path;
}
export function distributionNotionalLimit(policy: DistributionSizingPolicy | undefined, symbol: string, equity?: number): number {
  if (!policy) return 12;
  const limit = policy.symbols[symbol]?.maximumNotional ?? 0;
  return equity === undefined ? limit : Number.isFinite(equity) && equity > 0
    ? Math.min(limit, equity * policy.maximumEquityFraction) : 0;
}
function floorLot(qty: number, increment: number): number {
  // A tiny upward floating-point tolerance may only repair an exact grid point;
  // the caller rechecks every dollar and quantity ceiling after rounding.
  const units = Math.floor(qty / increment + 1e-12);
  if (!Number.isSafeInteger(units)) return 0;
  const [mantissa, exponent = "0"] = String(increment).split("e");
  const decimals = Math.max(0, (mantissa!.split(".")[1]?.length ?? 0) - Number(exponent));
  return decimals <= 12 ? Number((units * increment).toFixed(decimals)) : 0;
}
/** A shared context must be affordable for both directions and every action.
 * Use the widest declared stop, complete costs, and the existing risk sizer.
 * Training simulations and a selected paper order receive this exact quantity.
 */
export function sizeDistributionContext(policy: DistributionSizingPolicy, book: BookState,
  asset: AssetRules, context: DistributionSizingContext | undefined, maximumStopBps: number): DistributionSize {
  const cfg = policy.symbols[book.symbol], bid = book.bids[0], ask = book.asks[0], f = context?.features;
  const maximumNotional = distributionNotionalLimit(policy, book.symbol, context?.equity ?? 0);
  const minimumOrderNotional = ask && asset ? ask.px * asset.minOrderSize : null;
  const blocked = (reason: string): DistributionSize => ({ qty: 0, maximumNotional,
    minimumOrderNotional, reason, bindingLimit: null });
  if (!cfg || !context || !f || !book.valid || !bid || !ask || asset.symbol !== book.symbol
    || ![bid.px, ask.px, bid.qty, ask.qty, asset.minOrderSize, asset.minTradeIncrement,
      asset.maximumOrderQty, context.equity, context.equityHighWater, maximumStopBps].every(n => Number.isFinite(n) && n > 0)
    || ask.px <= bid.px || f.stale || f.symbol !== book.symbol || f.receiveTsMs !== book.receiveTsMs
    || ![f.mid, f.spreadBps, f.sigmaHBps, f.velocityZ].every(Number.isFinite)
    || f.sigmaHBps < 0 || f.spreadBps < 0
    || Math.abs(f.mid - (bid.px + ask.px) / 2) > 1e-8 * ask.px) return blocked("SIZING_CONTEXT_UNAVAILABLE");
  if (minimumOrderNotional! > maximumNotional) return blocked("NOTIONAL_BELOW_MINIMUM_ORDER");
  const liquidityQty = Math.min(bid.qty, ask.qty) * cfg.risk.maximumBookParticipation;
  const upper = Math.min(maximumNotional / ask.px, asset.maximumOrderQty, liquidityQty);
  let qty = floorLot(upper, asset.minTradeIncrement);
  if (qty < asset.minOrderSize) return blocked("LIQUIDITY_BELOW_MINIMUM_ORDER");
  let bindingLimit = upper === liquidityQty ? "liquidity" : upper === asset.maximumOrderQty ? "exchange" : "notional";
  for (const side of [1, -1] as const) {
    const price = side === 1 ? ask.px : bid.px;
    const cost = new CostModel(cfg.cost).estimate(f, book, side, qty, false);
    if (!cost || !Number.isFinite(cost.roundTripBps)) return blocked("SIZING_COST_UNAVAILABLE");
    const risk = new RiskSizer(cfg.risk).sizeResearch({ side, probability: .5, predictedGrossBps: 0,
      lowerBoundNetBps: 0, quality: 1, decisionTsMs: book.receiveTsMs }, {
      equity: context.equity, equityHighWater: context.equityHighWater, price,
      initialStopDistance: price * maximumStopBps / 10_000,
      estimatedExitCostBps: cost.roundTripBps + (cfg.cost.positiveCostErrorP95Bps ?? 0),
      jumpBuffer: price * f.sigmaHBps / 10_000 * cfg.jumpSigma,
      visibleLiquidityQty: Math.min(bid.qty, ask.qty), maximumNotional,
      maximumExchangeQty: asset.maximumOrderQty, lotSize: asset.minTradeIncrement,
      sigmaHBps: f.sigmaHBps, regimeScale: 1, exposureCapacityQty: qty,
    }, maximumNotional);
    if (!risk || risk.qty < asset.minOrderSize) return blocked("RISK_BELOW_MINIMUM_ORDER");
    if (risk.qty < qty) { qty = floorLot(risk.qty, asset.minTradeIncrement); bindingLimit = risk.bindingLimit; }
  }
  if (!(qty >= asset.minOrderSize) || qty > upper + 1e-12 || qty * ask.px > maximumNotional + 1e-8)
    return blocked("SIZING_ROUNDING_LIMIT");
  return { qty, maximumNotional, minimumOrderNotional, reason: "RISK_BOUNDED_SIZE_READY", bindingLimit };
}
