import { randomUUID, createHash } from "node:crypto";
import type { BookState, Direction, Features } from "../core/market.js";
import type { CostEstimate, CostModel } from "../strategy/cost.js";
import type { TradeIntent } from "../strategy/signal.js";
import type { RiskApproval, RiskContext, RiskSizer } from "../risk/sizing.js";
import { estimateSweep } from "./book-walk.js";
import type { CostBreakdown, EntryFamily, ExecutionPath } from "../economics/types.js";

export type ExecutionStyle = "maker" | "taker";
export interface AssetRules { symbol: string; minOrderSize: number; minTradeIncrement: number; priceIncrement: number; maximumOrderQty: number; shortable: boolean; }
export interface PlannerConfig {
  makerTtlMs: number;
  alphaHalfLifeMs: number;
  pullbackMakerTtlMs: number;
  pullbackKinematicsGraceMs: number;
  pullbackKinematicsGraceEvents: number;
  pullbackSignalInvalidationGraceMs: number;
  pullbackSignalInvalidationGraceEvents: number;
  continuationSignalInvalidationGraceMs: number;
  continuationSignalInvalidationGraceEvents: number;
  continuationAdverseFlowConfirmationMs: number;
  continuationAdverseFlowConfirmationEvents: number;
  adverseFlowConfirmationMs: number;
  adverseFlowConfirmationEvents: number;
  adverseOfiThreshold: number;
  adverseTfiThreshold: number;
  minimumFillProbability: number;
  /** Minimum order-level expected value, expressed in bps of requested notional. */
  minimumExpectedValueBps: number;
  /** Conservative net edge divided by modeled maximum loss per unit. */
  minimumRewardRiskRatio: number;
  /** Extra limit-price protection for marketable IOC orders. Zero preserves exact book-walk pricing. */
  takerLimitBufferBps: number;
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
  economicHorizonMs?: number;
  entryFamily?: EntryFamily;
  executionPath?: ExecutionPath;
  exitReason?: string;
  fallbackFromClientOrderId?: string;
}
export interface PlannerBuildOptions {
  /** Re-runs the deterministic net-edge gate against the cost at the current candidate quantity. */
  revalidateCost?: (cost: CostEstimate) => TradeIntent | null;
  /** Optional overlays may reduce, but never increase, deterministic quantity. */
  quantityMultiplier?: number;
  decisionId?: string;
  createdMs?: number;
  executionPath?: ExecutionPath;
  economicHorizonMs?: number;
  entryFamily?: EntryFamily;
  /** Slow-horizon volatility used only for risk sizing; execution latency retains fast feature volatility. */
  riskSigmaHBps?: number;
}

export interface PlannerBuildRejection {
  reason: string;
  values: Readonly<Record<string, number | string | boolean | null>>;
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
interface CandidateBuildResult {
  candidate: ExecutionCandidate | null;
  rejection: PlannerBuildRejection | null;
}

export class ExecutionPlanner {
  private lastBuildRejectionValue: PlannerBuildRejection | null = null;

  public constructor(
    private readonly cfg: PlannerConfig,
    private readonly riskSizer: RiskSizer,
    private readonly costModel: CostModel,
    private readonly strategyVersion: string,
    private readonly modelVersion: string,
  ) {
    if (!Number.isFinite(cfg.takerLimitBufferBps) || cfg.takerLimitBufferBps < 0) {
      throw new Error("Planner takerLimitBufferBps must be finite and non-negative");
    }
    const positiveDurations = [cfg.makerTtlMs, cfg.alphaHalfLifeMs, cfg.pullbackMakerTtlMs,
      cfg.pullbackKinematicsGraceMs, cfg.pullbackSignalInvalidationGraceMs,
      cfg.continuationSignalInvalidationGraceMs, cfg.adverseFlowConfirmationMs];
    if (positiveDurations.some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new Error("Planner order lifetimes and kinematics grace must be finite and positive");
    }
    if (!Number.isInteger(cfg.pullbackKinematicsGraceEvents) || cfg.pullbackKinematicsGraceEvents < 2) {
      throw new Error("Planner pullbackKinematicsGraceEvents must be an integer of at least two");
    }
    if (!Number.isInteger(cfg.pullbackSignalInvalidationGraceEvents) || cfg.pullbackSignalInvalidationGraceEvents < 2) {
      throw new Error("Planner pullbackSignalInvalidationGraceEvents must be an integer of at least two");
    }
    if (!Number.isInteger(cfg.continuationSignalInvalidationGraceEvents)
      || cfg.continuationSignalInvalidationGraceEvents < 2) {
      throw new Error("Planner continuationSignalInvalidationGraceEvents must be an integer of at least two");
    }
    if (!Number.isInteger(cfg.adverseFlowConfirmationEvents) || cfg.adverseFlowConfirmationEvents < 2) {
      throw new Error("Planner adverseFlowConfirmationEvents must be an integer of at least two");
    }
    if (!Number.isInteger(cfg.continuationAdverseFlowConfirmationEvents)
      || cfg.continuationAdverseFlowConfirmationEvents < 2) {
      throw new Error("Planner continuationAdverseFlowConfirmationEvents must be an integer of at least two");
    }
    if (!(cfg.continuationAdverseFlowConfirmationMs > 0)
      || cfg.continuationAdverseFlowConfirmationMs >= Math.min(cfg.makerTtlMs, cfg.alphaHalfLifeMs / 2)) {
      throw new Error("Planner continuation adverse-flow confirmation must be positive and shorter than its maker TTL");
    }
    if (!(cfg.adverseOfiThreshold > 0) || !(cfg.adverseTfiThreshold > 0)) {
      throw new Error("Planner adverse-flow thresholds must be positive");
    }
    if (!Number.isFinite(cfg.minimumExpectedValueBps) || cfg.minimumExpectedValueBps < 0) {
      throw new Error("Planner minimumExpectedValueBps must be finite and non-negative");
    }
    if (!Number.isFinite(cfg.minimumRewardRiskRatio) || cfg.minimumRewardRiskRatio < 0) {
      throw new Error("Planner minimumRewardRiskRatio must be finite and non-negative");
    }
    if (cfg.pullbackKinematicsGraceMs >= cfg.pullbackMakerTtlMs
      || cfg.pullbackSignalInvalidationGraceMs >= cfg.pullbackMakerTtlMs
      || cfg.adverseFlowConfirmationMs >= cfg.pullbackMakerTtlMs) {
      throw new Error("Planner pullback grace periods must be shorter than its maker TTL");
    }
    if (cfg.continuationSignalInvalidationGraceMs >= Math.min(cfg.makerTtlMs, cfg.alphaHalfLifeMs / 2)) {
      throw new Error("Planner continuation signal grace must be shorter than its maker TTL");
    }
  }

  public build(intent: TradeIntent, features: Features, book: BookState, asset: AssetRules, baseRisk: Omit<RiskContext, "price" | "visibleLiquidityQty" | "sigmaHBps" | "estimatedExitCostBps" | "maximumExchangeQty">, closingExistingLong = false, options: PlannerBuildOptions = {}): ExecutionPlan | null {
    this.lastBuildRejectionValue = null;
    if (!book.valid) return this.rejectBuild("BOOK_INVALID");
    if (features.stale) return this.rejectBuild("FEATURES_STALE");
    if (intent.side === -1 && !asset.shortable && !closingExistingLong) return this.rejectBuild("SHORT_UNAVAILABLE");
    const quantityMultiplier = Math.max(0, Math.min(1, options.quantityMultiplier ?? 1));
    if (!(quantityMultiplier > 0)) return this.rejectBuild("QUANTITY_MULTIPLIER_ZERO");
    if (options.executionPath === "MAKER_MAKER") {
      return this.rejectBuild("UNSUPPORTED_ENTRY_EXECUTION_PATH", { executionPath: options.executionPath });
    }
    const allowTaker = options.executionPath === undefined || options.executionPath === "TAKER_TAKER";
    const allowMaker = options.executionPath === undefined || options.executionPath === "MAKER_TAKER"
      || options.executionPath === "MAKER_MAKER_TAKER_FALLBACK";
    const makerTtlMs = this.makerEntryTtlMs(options.entryFamily);
    const takerResult = allowTaker
      ? this.buildCandidate("taker", intent, features, book, asset, baseRisk, quantityMultiplier, options, makerTtlMs) : null;
    const makerResult = allowMaker
      ? this.buildCandidate("maker", intent, features, book, asset, baseRisk, quantityMultiplier, options, makerTtlMs) : null;
    const taker = takerResult?.candidate ?? null;
    const makerCandidate = makerResult?.candidate ?? null;
    const maker = makerCandidate && makerCandidate.fillProbability >= this.cfg.minimumFillProbability ? makerCandidate : null;
    const selected = maker && (!taker || maker.expectedValue > taker.expectedValue) ? maker : taker;
    if (!selected) {
      if (makerCandidate && makerCandidate.fillProbability < this.cfg.minimumFillProbability) {
        return this.rejectBuild("MAKER_FILL_PROBABILITY_BELOW_MINIMUM", {
          fillProbability: makerCandidate.fillProbability,
          minimumFillProbability: this.cfg.minimumFillProbability,
          ttlMs: makerTtlMs,
        });
      }
      const rejection = makerResult?.rejection ?? takerResult?.rejection;
      return this.rejectBuild(rejection?.reason ?? "NO_ELIGIBLE_EXECUTION_CANDIDATE", rejection?.values);
    }
    const limitPx = selected.style === "maker"
      ? this.roundPrice(intent.side === 1 ? book.bids[0]!.px : book.asks[0]!.px, asset.priceIncrement, intent.side, false)
      : bufferedTakerLimitPrice(selected.worstPx!, asset.priceIncrement, intent.side, this.cfg.takerLimitBufferBps);
    const createdMs = options.createdMs ?? Date.now();
    const ttl = selected.style === "maker" ? makerTtlMs : 1_000;
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
      ...(options.economicHorizonMs === undefined ? {} : { economicHorizonMs: options.economicHorizonMs }),
      ...(options.entryFamily === undefined ? {} : { entryFamily: options.entryFamily }),
      ...(options.executionPath === undefined ? {} : { executionPath: options.executionPath }),
    };
  }

  public latestBuildRejection(): PlannerBuildRejection | null {
    return this.lastBuildRejectionValue
      ? { reason: this.lastBuildRejectionValue.reason, values: { ...this.lastBuildRejectionValue.values } } : null;
  }

  /** Cheapest execution style that is currently eligible for a preliminary deterministic cost gate. */
  public preliminaryCost(features: Features, book: BookState, side: Direction, qty: number,
    entryFamily?: EntryFamily): CostEstimate | null {
    const taker = this.costModel.estimate(features, book, side, qty, false);
    const maker = this.fillProbability(features, book, side, this.makerEntryTtlMs(entryFamily)) >= this.cfg.minimumFillProbability
      ? this.costModel.estimate(features, book, side, qty, true) : null;
    if (!taker) return maker;
    if (!maker) return taker;
    return maker.roundTripBps < taker.roundTripBps ? maker : taker;
  }

  public economicCosts(features: Features, book: BookState, side: Direction, qty: number,
    entryFamily?: EntryFamily): CostBreakdown[] {
    return this.costModel.pathEstimates(features, book, side, qty, this.makerFillProbability(features, book, side, entryFamily));
  }

  public makerFillProbability(features: Features, book: BookState, side: Direction, entryFamily?: EntryFamily): number {
    return this.fillProbability(features, book, side, this.makerEntryTtlMs(entryFamily));
  }

  private buildCandidate(style: ExecutionStyle, intent: TradeIntent, features: Features, book: BookState, asset: AssetRules,
    baseRisk: Omit<RiskContext, "price" | "visibleLiquidityQty" | "sigmaHBps" | "estimatedExitCostBps" | "maximumExchangeQty">,
    quantityMultiplier: number, options: PlannerBuildOptions, makerTtlMs: number): CandidateBuildResult {
    const makerEntry = style === "maker";
    let qty = asset.minOrderSize;
    let cost: CostEstimate | null = null;
    let risk: RiskApproval | null = null;
    let exactIntent: TradeIntent | null = null;
    for (let iteration = 0; iteration < this.cfg.maximumIterations; iteration += 1) {
      cost = this.costModel.estimate(features, book, intent.side, qty, makerEntry);
      if (!cost) return candidateRejected("COST_ESTIMATE_UNAVAILABLE", { style, iteration, qty });
      if (cost.impactBps > this.cfg.maximumImpactBps) return candidateRejected("IMPACT_ABOVE_MAXIMUM", {
        style, iteration, qty, impactBps: cost.impactBps, maximumImpactBps: this.cfg.maximumImpactBps,
      });
      exactIntent = options.revalidateCost ? options.revalidateCost(cost) : intent;
      if (!exactIntent) return candidateRejected("EXACT_COST_REVALIDATION_FAILED", {
        style, iteration, qty, roundTripCostBps: cost.roundTripBps,
      });
      const approval = this.riskSizer.size(exactIntent, {
        ...baseRisk, price: features.mid, visibleLiquidityQty: this.relevantDepth(book, intent.side),
        sigmaHBps: options.riskSigmaHBps ?? features.sigmaHBps,
        estimatedExitCostBps: cost.spreadBps / 2 + cost.feeBps / 2,
        maximumExchangeQty: asset.maximumOrderQty,
      });
      if (!approval) return candidateRejected("RISK_SIZE_UNAVAILABLE", { style, iteration, qty });
      const nextQty = Math.floor(approval.qty * quantityMultiplier / asset.minTradeIncrement + 1e-12) * asset.minTradeIncrement;
      risk = { ...approval, qty: nextQty, modeledMaximumLoss: nextQty * approval.maximumLossPerUnit };
      if (Math.abs(nextQty - qty) <= asset.minTradeIncrement / 2) { qty = nextQty; break; }
      qty = nextQty;
    }
    if (!risk || qty < asset.minOrderSize) return candidateRejected("BELOW_MINIMUM_ORDER_SIZE", {
      style, qty, minimumOrderSize: asset.minOrderSize,
    });
    cost = this.costModel.estimate(features, book, intent.side, qty, makerEntry);
    if (!cost) return candidateRejected("COST_ESTIMATE_UNAVAILABLE", { style, qty });
    if (cost.impactBps > this.cfg.maximumImpactBps) return candidateRejected("IMPACT_ABOVE_MAXIMUM", {
      style, qty, impactBps: cost.impactBps, maximumImpactBps: this.cfg.maximumImpactBps,
    });
    exactIntent = options.revalidateCost ? options.revalidateCost(cost) : intent;
    if (!exactIntent) return candidateRejected("EXACT_COST_REVALIDATION_FAILED", {
      style, qty, roundTripCostBps: cost.roundTripBps,
    });
    const maximumLossBps = 10_000 * risk.maximumLossPerUnit / features.mid;
    const rewardRiskRatio = maximumLossBps > 0 ? exactIntent.lowerBoundNetBps / maximumLossBps : 0;
    if (rewardRiskRatio < this.cfg.minimumRewardRiskRatio) {
      return candidateRejected("REWARD_RISK_BELOW_MINIMUM", {
        style, qty, lowerBoundNetBps: exactIntent.lowerBoundNetBps, maximumLossBps,
        rewardRiskRatio, minimumRewardRiskRatio: this.cfg.minimumRewardRiskRatio,
      });
    }
    const sweep = style === "taker" ? estimateSweep(intent.side === 1 ? book.asks : book.bids, qty) : null;
    if (style === "taker" && !sweep) return candidateRejected("BOOK_SWEEP_UNAVAILABLE", { style, qty });
    const fillProbability = makerEntry ? this.fillProbability(features, book, intent.side, makerTtlMs) : 1;
    const grossValue = qty * features.mid * (exactIntent.predictedGrossBps - cost.roundTripBps) / 10_000;
    const expectedValue = makerEntry
      ? fillProbability * grossValue
        - (1 - fillProbability) * qty * features.mid * this.cfg.makerOpportunityCostBps / 10_000
        - qty * features.mid * this.cfg.staleOrderCostBps / 10_000
      : grossValue;
    const expectedValueBps = 10_000 * expectedValue / (qty * features.mid);
    if ((!makerEntry || fillProbability >= this.cfg.minimumFillProbability)
      && expectedValueBps < this.cfg.minimumExpectedValueBps) {
      return candidateRejected("EXPECTED_VALUE_BELOW_MINIMUM", {
        style, qty, fillProbability, expectedValue, expectedValueBps,
        minimumExpectedValueBps: this.cfg.minimumExpectedValueBps,
      });
    }
    return { candidate: { style, qty, cost, risk, intent: exactIntent, fillProbability, expectedValue,
      worstPx: sweep?.worstPx }, rejection: null };
  }

  private rejectBuild(reason: string,
    values: Readonly<Record<string, number | string | boolean | null>> = {}): null {
    this.lastBuildRejectionValue = { reason, values: { ...values } };
    return null;
  }

  private relevantDepth(book: BookState, side: Direction): number {
    return (side === 1 ? book.asks : book.bids).slice(0, 10).reduce((sum, level) => sum + level.qty, 0);
  }
  private makerEntryTtlMs(entryFamily?: EntryFamily): number {
    return entryFamily === "PULLBACK_RECOVERY"
      ? this.cfg.pullbackMakerTtlMs : Math.min(this.cfg.makerTtlMs, this.cfg.alphaHalfLifeMs / 2);
  }
  private fillProbability(f: Features, book: BookState, side: Direction, ttlMs: number): number {
    const restingLevels = side === 1 ? book.bids : book.asks;
    const ahead = restingLevels[0]!.qty;
    // A resting order fills when contra-side aggressors consume its queue. Same-side
    // flow may support the price, but it cannot trade against the resting order.
    const contraFlow = -side * f.tfi;
    const opposingImbalance = -side * f.qi1;
    // TFI is a unitless [-1,1] ratio, so dividing it by base-asset quantity makes
    // probabilities depend on an asset's denomination and saturate for small queues.
    // Queue share is dimensionless and preserves the intended depth relationship.
    const displayedRestingDepth = restingLevels.slice(0, 10).reduce((sum, level) => sum + level.qty, 0);
    const queueShare = Math.max(0, Math.min(1, ahead / Math.max(displayedRestingDepth, 1e-12)));
    const normalizedAggression = Math.max(0, contraFlow) * (1 - queueShare);
    const logHazard = this.cfg.fillHazardIntercept + this.cfg.fillHazardAggressiveWeight * normalizedAggression
      + this.cfg.fillHazardFlowWeight * contraFlow + this.cfg.fillHazardImbalanceWeight * opposingImbalance
      - this.cfg.fillHazardSpreadWeight * f.spreadBps;
    const fillHazardPerSecond = Math.exp(Math.max(-20, Math.min(20, logHazard)));
    // Fill and signal decay are competing risks. Reporting only the full-TTL fill
    // hazard overstated orders that usually lose their alpha and cancel first.
    const signalCancellationHazardPerSecond = Math.log(2) / (this.cfg.alphaHalfLifeMs / 1_000);
    const totalHazardPerSecond = fillHazardPerSecond + signalCancellationHazardPerSecond;
    return fillHazardPerSecond / totalHazardPerSecond
      * (1 - Math.exp(-totalHazardPerSecond * ttlMs / 1_000));
  }
  private roundPrice(price: number, increment: number, side: Direction, marketable: boolean): number {
    const units = price / increment;
    return (side === 1 ? (marketable ? Math.ceil(units) : Math.floor(units)) : (marketable ? Math.floor(units) : Math.ceil(units))) * increment;
  }
}

function candidateRejected(reason: string,
  values: Readonly<Record<string, number | string | boolean | null>>): CandidateBuildResult {
  return { candidate: null, rejection: { reason, values: { ...values } } };
}

/** Produces a directionally marketable, price-capped IOC limit with an explicit latency buffer. */
export function bufferedTakerLimitPrice(worstPx: number, increment: number, side: Direction, bufferBps: number): number {
  if (!(worstPx > 0) || !(increment > 0) || !Number.isFinite(bufferBps) || bufferBps < 0) {
    throw new Error("Buffered taker limit inputs must be positive with a finite non-negative buffer");
  }
  const raw = worstPx * (1 + side * bufferBps / 10_000);
  const units = raw / increment;
  return (side === 1 ? Math.ceil(units) : Math.floor(units)) * increment;
}
