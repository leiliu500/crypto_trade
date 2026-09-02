import type { BookState, Direction, Features } from "../core/market.js";
import { estimateSweep } from "../execution/book-walk.js";
import { validateFeeBps } from "../economics/fee-validation.js";
import type { CostBreakdown, ExecutionPath } from "../economics/types.js";

export interface CostConfig {
  makerFeeBps: number;
  takerFeeBps: number;
  /** Probability that a bounded resting exit fills before its taker fallback. */
  makerExitFillProbability: number;
  /** Additional adverse move expected only on the unfilled maker-exit branch. */
  makerExitFallbackAdverseBps: number;
  latencyAdverseFraction: number;
  adverseSelectionBps: number;
  fundingBps: number;
  borrowBps: number;
  positiveCostErrorP95Bps?: number;
}
export interface CostEstimate {
  roundTripBps: number;
  spreadBps: number;
  feeBps: number;
  impactBps: number;
  latencyBps: number;
  adverseSelectionBps: number;
  fundingBps: number;
  borrowBps: number;
  entryVwap?: number;
  worstEntryPx?: number;
}

/** Costs added by waiting one more hold interval; unavoidable entry/exit costs are excluded. */
export function incrementalHoldCostBps(cost: CostEstimate): number {
  return cost.latencyBps + cost.fundingBps + cost.borrowBps;
}

export class CostModel {
  public constructor(private readonly cfg: CostConfig) {
    validateFeeBps(cfg.makerFeeBps, "makerFeeBps");
    validateFeeBps(cfg.takerFeeBps, "takerFeeBps");
    if (!(cfg.makerExitFillProbability >= 0 && cfg.makerExitFillProbability <= 1)) {
      throw new Error("makerExitFillProbability must be in [0,1]");
    }
    if (!Number.isFinite(cfg.makerExitFallbackAdverseBps) || cfg.makerExitFallbackAdverseBps < 0) {
      throw new Error("makerExitFallbackAdverseBps must be finite and non-negative");
    }
  }
  public estimate(features: Features, book: BookState, direction: Direction, qty: number, makerEntry = false): CostEstimate | null {
    const levels = direction === 1 ? book.asks : book.bids;
    const sweep = qty > 0 ? estimateSweep(levels, qty) : undefined;
    if (qty > 0 && !sweep) return null;
    const reference = features.mid;
    const top = direction === 1 ? book.asks[0]!.px : book.bids[0]!.px;
    const oneWayCrossBps = Math.max(0, direction * (top - reference) / reference * 10_000);
    // Entry qualification must remain solvent when a risk/evidence exit cannot
    // rest. Price every maker entry with a full taker exit; a later maker exit
    // is an execution improvement, never a prerequisite for positive edge.
    const makerFirstExit = makerEntry;
    const expectedExitSpreadBps = features.spreadBps / 2;
    const spreadBps = (makerEntry ? 0 : oneWayCrossBps) + expectedExitSpreadBps;
    const entryFee = makerEntry ? this.cfg.makerFeeBps : this.cfg.takerFeeBps;
    const exitFee = this.cfg.takerFeeBps;
    const feeBps = entryFee + exitFee;
    const impactBps = sweep ? Math.max(0, direction * (sweep.vwap - top) / reference * 10_000) : 0;
    const latencyBps = Math.max(0, Math.abs(features.velocityZ) * features.sigmaHBps * this.cfg.latencyAdverseFraction);
    const fallbackPremiumBps = makerFirstExit ? this.cfg.makerExitFallbackAdverseBps : 0;
    const adverseSelectionBps = this.cfg.adverseSelectionBps + fallbackPremiumBps;
    const roundTripBps = spreadBps + feeBps + impactBps + latencyBps + adverseSelectionBps + this.cfg.fundingBps + this.cfg.borrowBps;
    const result: CostEstimate = {
      roundTripBps, spreadBps, feeBps, impactBps, latencyBps,
      adverseSelectionBps,
      fundingBps: this.cfg.fundingBps, borrowBps: this.cfg.borrowBps,
    };
    if (sweep) { result.entryVwap = sweep.vwap; result.worstEntryPx = sweep.worstPx; }
    return result;
  }

  public makerExitFillProbability(): number { return this.cfg.makerExitFillProbability; }

  /** Evaluates all execution paths using one component ledger. Pure maker/maker has no bounded completion and remains unsupported. */
  public pathEstimates(features: Features, book: BookState, direction: Direction, qty: number,
    makerFillProbability: number): CostBreakdown[] {
    const result: CostBreakdown[] = [];
    for (const path of ["MAKER_MAKER", "MAKER_TAKER", "MAKER_MAKER_TAKER_FALLBACK", "TAKER_TAKER"] as const) {
      const estimate = this.estimatePath(features, book, direction, qty, path, makerFillProbability);
      if (estimate) result.push(estimate);
    }
    return result;
  }

  public estimatePath(features: Features, book: BookState, direction: Direction, qty: number,
    path: ExecutionPath, makerFillProbability: number): CostBreakdown | null {
    const entryMaker = path !== "TAKER_TAKER";
    const exitMaker = path === "MAKER_MAKER";
    const makerExitWithFallback = path === "MAKER_MAKER_TAKER_FALLBACK";
    // The entry gate prices the fallback branch at probability one. A maker
    // exit may improve realized cost, but forced risk exits are normally taker.
    const fallbackProbability = makerExitWithFallback ? 1 : 0;
    const levels = direction === 1 ? book.asks : book.bids;
    const sweep = !entryMaker && qty > 0 ? estimateSweep(levels, qty) : undefined;
    if (!entryMaker && qty > 0 && !sweep) return null;
    const top = direction === 1 ? book.asks[0]!.px : book.bids[0]!.px;
    const entryExecutionBps = entryMaker ? 0 : Math.max(0, direction * (top - features.mid) / features.mid * 10_000);
    const exitExecutionBps = exitMaker ? 0 : makerExitWithFallback ? fallbackProbability * features.spreadBps / 2 : features.spreadBps / 2;
    const marketImpactBps = sweep ? Math.max(0, direction * (sweep.vwap - top) / features.mid * 10_000) : 0;
    const latencyBps = Math.max(0, Math.abs(features.velocityZ) * features.sigmaHBps * this.cfg.latencyAdverseFraction);
    const entryFeeBps = entryMaker ? this.cfg.makerFeeBps : this.cfg.takerFeeBps;
    const exitFeeBps = exitMaker ? this.cfg.makerFeeBps : this.cfg.takerFeeBps;
    const adverseSelectionBps = this.cfg.adverseSelectionBps
      + (makerExitWithFallback ? this.cfg.makerExitFallbackAdverseBps : 0);
    const components = [entryExecutionBps, exitExecutionBps, entryFeeBps, exitFeeBps, marketImpactBps,
      latencyBps, adverseSelectionBps, this.cfg.fundingBps, this.cfg.borrowBps];
    const estimatedCostBps = components.reduce((sum, value) => sum + value, 0);
    return {
      path, supported: path !== "MAKER_MAKER", entryExecutionBps, exitExecutionBps,
      entryFeeBps, exitFeeBps, marketImpactBps, latencyBps,
      adverseSelectionBps, fundingBps: this.cfg.fundingBps, borrowBps: this.cfg.borrowBps,
      estimatedCostBps, positiveCostErrorP95Bps: this.cfg.positiveCostErrorP95Bps ?? 0,
      fillProbability: path === "TAKER_TAKER" ? 1 : makerFillProbability,
    };
  }
}

/** Converts the final quantity-specific planner cost without adding any component a second time. */
export function exactCostBreakdown(cost: CostEstimate, path: ExecutionPath, fillProbability: number,
  positiveCostErrorP95Bps = 0): CostBreakdown {
  const entryFeeBps = path === "TAKER_TAKER" ? cost.feeBps / 2 : Math.max(0, cost.feeBps - cost.feeBps / 2);
  const exitFeeBps = cost.feeBps - entryFeeBps;
  const otherComponents = cost.feeBps + cost.impactBps + cost.latencyBps + cost.adverseSelectionBps
    + cost.fundingBps + cost.borrowBps;
  const combinedExecutionBps = Math.max(0, cost.roundTripBps - otherComponents);
  return {
    path, supported: path !== "MAKER_MAKER", entryExecutionBps: combinedExecutionBps, exitExecutionBps: 0,
    entryFeeBps, exitFeeBps, marketImpactBps: cost.impactBps, latencyBps: cost.latencyBps,
    adverseSelectionBps: cost.adverseSelectionBps, fundingBps: cost.fundingBps, borrowBps: cost.borrowBps,
    estimatedCostBps: cost.roundTripBps, positiveCostErrorP95Bps,
    fillProbability: path === "TAKER_TAKER" ? 1 : fillProbability,
  };
}
