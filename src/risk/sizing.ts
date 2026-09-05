import { clamp } from "../core/market.js";
import type { TradeIntent } from "../strategy/signal.js";

export interface RiskContext {
  equity: number;
  equityHighWater: number;
  price: number;
  initialStopDistance: number;
  estimatedExitCostBps: number;
  jumpBuffer: number;
  visibleLiquidityQty: number;
  maximumNotional: number;
  maximumExchangeQty: number;
  lotSize: number;
  sigmaHBps: number;
  regimeScale: number;
  exposureCapacityQty: number;
}
export interface RiskConfig {
  baseRiskFraction: number;
  maximumDrawdown: number;
  maximumBookParticipation: number;
  fractionalKelly: number;
  maximumKellyFraction: number;
  targetSigmaHBps: number;
  minimumQualityScale: number;
}
export interface RiskApproval {
  qty: number;
  riskBudget: number;
  maximumLossPerUnit: number;
  modeledMaximumLoss: number;
  drawdownScale: number;
  qualityScale: number;
  volatilityScale: number;
  bindingLimit: "risk" | "liquidity" | "kelly" | "notional" | "exchange" | "exposure";
}

/**
 * Converts slow sampled variance to the volatility used for entry loss sizing.
 * The economic forecast may span hours, but an entry that makes no progress is
 * removed at the unproductive-exit deadline. Capping the risk horizon there
 * prevents a long alpha horizon from manufacturing an unnecessarily wide stop.
 */
export function entryRiskSigmaBps(slowVarianceRate: number, economicHorizonMs: number,
  unproductiveExitMs: number): number {
  if (!Number.isFinite(slowVarianceRate) || slowVarianceRate < 0
    || !Number.isFinite(economicHorizonMs) || economicHorizonMs <= 0
    || !Number.isFinite(unproductiveExitMs) || unproductiveExitMs <= 0) {
    throw new Error("Invalid entry risk horizon inputs");
  }
  const riskHorizonMs = Math.min(economicHorizonMs, unproductiveExitMs);
  return 10_000 * Math.sqrt(Math.max(slowVarianceRate, 1e-16) * riskHorizonMs / 1_000);
}

export class RiskSizer {
  public constructor(private readonly cfg: RiskConfig) {}
  public size(intent: TradeIntent, ctx: RiskContext): RiskApproval | null {
    return this.sizeWithBudget(intent, ctx);
  }

  /** Explicitly budgeted PAPER experiment: no invented edge to pass Kelly sizing. */
  public sizeResearch(intent: TradeIntent, ctx: RiskContext, experimentNotional: number): RiskApproval | null {
    if (!(experimentNotional > 0) || !Number.isFinite(experimentNotional)) return null;
    return this.sizeWithBudget(intent, ctx, experimentNotional);
  }

  private sizeWithBudget(intent: TradeIntent, ctx: RiskContext, experimentNotional?: number): RiskApproval | null {
    if (!(ctx.equity > 0) || !(ctx.price > 0) || !(ctx.lotSize > 0)) return null;
    const drawdown = Math.max(0, 1 - ctx.equity / Math.max(ctx.equityHighWater, ctx.equity));
    if (drawdown >= this.cfg.maximumDrawdown) return null;
    const drawdownScale = Math.pow(1 - drawdown / this.cfg.maximumDrawdown, 2);
    const qualityScale = clamp(intent.quality, this.cfg.minimumQualityScale, 1);
    const volatilityScale = Math.min(1, this.cfg.targetSigmaHBps / Math.max(ctx.sigmaHBps, 1e-6));
    const riskBudget = ctx.equity * this.cfg.baseRiskFraction * drawdownScale * qualityScale * volatilityScale * clamp(ctx.regimeScale, 0, 1);
    const maximumLossPerUnit = ctx.initialStopDistance + ctx.price * ctx.estimatedExitCostBps / 10_000 + ctx.jumpBuffer;
    if (!(maximumLossPerUnit > 0) || !(riskBudget > 0)) return null;

    const candidates = {
      risk: riskBudget / maximumLossPerUnit,
      liquidity: ctx.visibleLiquidityQty * this.cfg.maximumBookParticipation,
      kelly: experimentNotional === undefined ? ctx.equity * (this.cfg.fractionalKelly * clamp(
        Math.max(0, intent.lowerBoundNetBps / 10_000) / Math.max(Math.pow(Math.max(ctx.sigmaHBps, 1e-6) / 10_000, 2), 1e-12),
        0, this.cfg.maximumKellyFraction,
      )) / ctx.price : experimentNotional / ctx.price,
      notional: ctx.maximumNotional / ctx.price,
      exchange: ctx.maximumExchangeQty,
      exposure: ctx.exposureCapacityQty,
    };
    const entries = Object.entries(candidates) as Array<[RiskApproval["bindingLimit"], number]>;
    const [bindingLimit, rawQty] = entries.reduce((best, current) => current[1] < best[1] ? current : best);
    const qty = Math.floor(rawQty / ctx.lotSize + 1e-12) * ctx.lotSize;
    if (!(qty > 0)) return null;
    const modeledMaximumLoss = qty * maximumLossPerUnit;
    if (modeledMaximumLoss > riskBudget + Math.max(1e-8, riskBudget * 1e-9)) throw new Error("RISK_BUDGET_INVARIANT");
    return { qty, riskBudget, maximumLossPerUnit, modeledMaximumLoss, drawdownScale, qualityScale, volatilityScale, bindingLimit };
  }
}
