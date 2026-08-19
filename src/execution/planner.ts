import { randomUUID, createHash } from "node:crypto";
import type { BookState, Direction, Features } from "../core/market.js";
import type { CostEstimate, CostModel } from "../strategy/cost.js";
import type { TradeIntent } from "../strategy/signal.js";
import type { RiskApproval, RiskContext, RiskSizer } from "../risk/sizing.js";
import { estimateSweep } from "./book-walk.js";

export type ExecutionStyle = "maker" | "taker";
export interface AssetRules { symbol: string; minOrderSize: number; minTradeIncrement: number; priceIncrement: number; maximumOrderQty: number; shortable: boolean; }
export interface PlannerConfig {
  makerTtlMs: number;
  alphaHalfLifeMs: number;
  minimumFillProbability: number;
  cancelAheadFraction: number;
  fillHazardIntercept: number;
  fillHazardAggressiveWeight: number;
  fillHazardFlowWeight: number;
  fillHazardImbalanceWeight: number;
  fillHazardSpreadWeight: number;
  makerOpportunityCostBps: number;
  staleOrderCostBps: number;
  maximumImpactBps: number;
  maximumIterations: number;
}
export interface ExecutionPlan {
  clientOrderId: string;
  decisionId: string;
  riskApprovalId: string;
  symbol: string;
  side: Direction;
  qty: number;
  limitPx: number;
  style: ExecutionStyle;
  timeInForce: "gtc" | "ioc";
  createdMs: number;
  expiresMs: number;
  originatingSequence: bigint;
  featureHash: string;
  strategyVersion: string;
  modelVersion: string;
  expectedCost: CostEstimate;
  risk: RiskApproval;
  fillProbability: number;
  expectedValue: number;
  reduceOnlyIntent: boolean;
}
export interface PlannerBuildOptions {
  /** Re-runs the deterministic net-edge gate against the cost at the current candidate quantity. */
  revalidateCost?: (cost: CostEstimate) => TradeIntent | null;
  /** Optional overlays may reduce, but never increase, deterministic quantity. */
  quantityMultiplier?: number;
  decisionId?: string;
  createdMs?: number;
}

interface ExecutionCandidate {
  style: ExecutionStyle;
  qty: number;
  cost: CostEstimate;
  risk: RiskApproval;
  intent: TradeIntent;
  fillProbability: number;
  expectedValue: number;
  worstPx: number | undefined;
}

export class ExecutionPlanner {
  public constructor(
    private readonly cfg: PlannerConfig,
    private readonly riskSizer: RiskSizer,
    private readonly costModel: CostModel,
    private readonly strategyVersion: string,
    private readonly modelVersion: string,
  ) {}

  public build(intent: TradeIntent, features: Features, book: BookState, asset: AssetRules, baseRisk: Omit<RiskContext, "price" | "visibleLiquidityQty" | "sigmaHBps" | "estimatedExitCostBps" | "maximumExchangeQty">, closingExistingLong = false, options: PlannerBuildOptions = {}): ExecutionPlan | null {
    if (!book.valid || features.stale) return null;
    if (intent.side === -1 && !asset.shortable && !closingExistingLong) return null;
    const quantityMultiplier = Math.max(0, Math.min(1, options.quantityMultiplier ?? 1));
    if (!(quantityMultiplier > 0)) return null;
    const taker = this.buildCandidate("taker", intent, features, book, asset, baseRisk, quantityMultiplier, options);
    const makerCandidate = this.buildCandidate("maker", intent, features, book, asset, baseRisk, quantityMultiplier, options);
    const maker = makerCandidate && makerCandidate.fillProbability >= this.cfg.minimumFillProbability ? makerCandidate : null;
    const selected = maker && (!taker || maker.expectedValue > taker.expectedValue) ? maker : taker;
    if (!selected) return null;
    const limitRaw = selected.style === "maker"
      ? (intent.side === 1 ? book.bids[0]!.px : book.asks[0]!.px)
      : selected.worstPx!;
    const limitPx = this.roundPrice(limitRaw, asset.priceIncrement, intent.side, selected.style === "taker");
    const createdMs = options.createdMs ?? Date.now();
    const ttl = selected.style === "maker" ? Math.min(this.cfg.makerTtlMs, this.cfg.alphaHalfLifeMs / 2) : 1_000;
    const decisionId = options.decisionId ?? randomUUID();
    return {
      clientOrderId: `mlce-${createdMs}-${randomUUID().slice(0, 12)}`,
      decisionId, riskApprovalId: randomUUID(), symbol: book.symbol, side: intent.side, qty: selected.qty, limitPx, style: selected.style,
      timeInForce: selected.style === "maker" ? "gtc" : "ioc", createdMs, expiresMs: createdMs + ttl,
      originatingSequence: book.sequence,
      featureHash: createHash("sha256").update(JSON.stringify(features)).digest("hex").slice(0, 24),
      strategyVersion: this.strategyVersion, modelVersion: this.modelVersion,
      expectedCost: selected.cost, risk: selected.risk, fillProbability: selected.fillProbability,
      expectedValue: selected.expectedValue, reduceOnlyIntent: closingExistingLong,
    };
  }

  /** Cheapest execution style that is currently eligible for a preliminary deterministic cost gate. */
  public preliminaryCost(features: Features, book: BookState, side: Direction, qty: number): CostEstimate | null {
    const taker = this.costModel.estimate(features, book, side, qty, false);
    const maker = this.fillProbability(features, book, side) >= this.cfg.minimumFillProbability
      ? this.costModel.estimate(features, book, side, qty, true) : null;
    if (!taker) return maker;
    if (!maker) return taker;
    return maker.roundTripBps < taker.roundTripBps ? maker : taker;
  }

  private buildCandidate(style: ExecutionStyle, intent: TradeIntent, features: Features, book: BookState, asset: AssetRules,
    baseRisk: Omit<RiskContext, "price" | "visibleLiquidityQty" | "sigmaHBps" | "estimatedExitCostBps" | "maximumExchangeQty">,
    quantityMultiplier: number, options: PlannerBuildOptions): ExecutionCandidate | null {
    const makerEntry = style === "maker";
    let qty = asset.minOrderSize;
    let cost: CostEstimate | null = null;
    let risk: RiskApproval | null = null;
    let exactIntent: TradeIntent | null = null;
    for (let iteration = 0; iteration < this.cfg.maximumIterations; iteration += 1) {
      cost = this.costModel.estimate(features, book, intent.side, qty, makerEntry);
      if (!cost || cost.impactBps > this.cfg.maximumImpactBps) return null;
      exactIntent = options.revalidateCost ? options.revalidateCost(cost) : intent;
      if (!exactIntent) return null;
      const approval = this.riskSizer.size(exactIntent, {
        ...baseRisk, price: features.mid, visibleLiquidityQty: this.relevantDepth(book, intent.side),
        sigmaHBps: features.sigmaHBps, estimatedExitCostBps: cost.spreadBps / 2 + cost.feeBps / 2,
        maximumExchangeQty: asset.maximumOrderQty,
      });
      if (!approval) return null;
      const nextQty = Math.floor(approval.qty * quantityMultiplier / asset.minTradeIncrement + 1e-12) * asset.minTradeIncrement;
      risk = { ...approval, qty: nextQty, modeledMaximumLoss: nextQty * approval.maximumLossPerUnit };
      if (Math.abs(nextQty - qty) <= asset.minTradeIncrement / 2) { qty = nextQty; break; }
      qty = nextQty;
    }
    if (!risk || qty < asset.minOrderSize) return null;
    cost = this.costModel.estimate(features, book, intent.side, qty, makerEntry);
    if (!cost || cost.impactBps > this.cfg.maximumImpactBps) return null;
    exactIntent = options.revalidateCost ? options.revalidateCost(cost) : intent;
    if (!exactIntent) return null;
    const sweep = style === "taker" ? estimateSweep(intent.side === 1 ? book.asks : book.bids, qty) : null;
    if (style === "taker" && !sweep) return null;
    const fillProbability = makerEntry ? this.fillProbability(features, book, intent.side) : 1;
    const grossValue = qty * features.mid * (exactIntent.predictedGrossBps - cost.roundTripBps) / 10_000;
    const expectedValue = makerEntry
      ? fillProbability * grossValue
        - (1 - fillProbability) * qty * features.mid * this.cfg.makerOpportunityCostBps / 10_000
        - qty * features.mid * this.cfg.staleOrderCostBps / 10_000
      : grossValue;
    return { style, qty, cost, risk, intent: exactIntent, fillProbability, expectedValue, worstPx: sweep?.worstPx };
  }

  private relevantDepth(book: BookState, side: Direction): number {
    return (side === 1 ? book.asks : book.bids).slice(0, 10).reduce((sum, level) => sum + level.qty, 0);
  }
  private fillProbability(f: Features, book: BookState, side: Direction): number {
    const ahead = side === 1 ? book.bids[0]!.qty : book.asks[0]!.qty;
    const aggressiveRatio = Math.max(0, side * f.tfi) / Math.max(ahead, 1e-12);
    const logHazard = this.cfg.fillHazardIntercept + this.cfg.fillHazardAggressiveWeight * aggressiveRatio
      + this.cfg.fillHazardFlowWeight * side * f.tfi + this.cfg.fillHazardImbalanceWeight * side * f.qi1
      - this.cfg.fillHazardSpreadWeight * f.spreadBps;
    const hazardPerSecond = Math.exp(Math.max(-20, Math.min(20, logHazard)));
    return 1 - Math.exp(-hazardPerSecond * this.cfg.makerTtlMs / 1000);
  }
  private roundPrice(price: number, increment: number, side: Direction, marketable: boolean): number {
    const units = price / increment;
    return (side === 1 ? (marketable ? Math.ceil(units) : Math.floor(units)) : (marketable ? Math.floor(units) : Math.ceil(units))) * increment;
  }
}
