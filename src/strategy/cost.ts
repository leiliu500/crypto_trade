import type { BookState, Direction, Features } from "../core/market.js";
import { estimateSweep } from "../execution/book-walk.js";

export interface CostConfig {
  makerFeeBps: number;
  takerFeeBps: number;
  expectedExitTaker: boolean;
  latencyAdverseFraction: number;
  adverseSelectionBps: number;
  fundingBps: number;
  borrowBps: number;
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

export class CostModel {
  public constructor(private readonly cfg: CostConfig) {}
  public estimate(features: Features, book: BookState, direction: Direction, qty: number, makerEntry = false): CostEstimate | null {
    const levels = direction === 1 ? book.asks : book.bids;
    const sweep = qty > 0 ? estimateSweep(levels, qty) : undefined;
    if (qty > 0 && !sweep) return null;
    const reference = features.mid;
    const executable = sweep?.vwap ?? (direction === 1 ? book.asks[0]!.px : book.bids[0]!.px);
    const oneWayCrossBps = Math.max(0, direction * (executable - reference) / reference * 10_000);
    const expectedExitSpreadBps = features.spreadBps / 2;
    const spreadBps = makerEntry ? expectedExitSpreadBps : oneWayCrossBps + expectedExitSpreadBps;
    const entryFee = makerEntry ? this.cfg.makerFeeBps : this.cfg.takerFeeBps;
    const exitFee = this.cfg.expectedExitTaker ? this.cfg.takerFeeBps : this.cfg.makerFeeBps;
    const feeBps = entryFee + exitFee;
    const top = direction === 1 ? book.asks[0]!.px : book.bids[0]!.px;
    const impactBps = sweep ? Math.max(0, direction * (sweep.vwap - top) / reference * 10_000) : 0;
    const latencyBps = Math.max(0, Math.abs(features.velocityZ) * features.sigmaHBps * this.cfg.latencyAdverseFraction);
    const roundTripBps = spreadBps + feeBps + impactBps + latencyBps + this.cfg.adverseSelectionBps + this.cfg.fundingBps + this.cfg.borrowBps;
    const result: CostEstimate = {
      roundTripBps, spreadBps, feeBps, impactBps, latencyBps,
      adverseSelectionBps: this.cfg.adverseSelectionBps,
      fundingBps: this.cfg.fundingBps, borrowBps: this.cfg.borrowBps,
    };
    if (sweep) { result.entryVwap = sweep.vwap; result.worstEntryPx = sweep.worstPx; }
    return result;
  }
}
