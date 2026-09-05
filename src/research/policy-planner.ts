import { createHash, randomUUID } from "node:crypto";
import type { SymbolConfig } from "../config.js";
import type { BookState } from "../core/market.js";
import type { DeterministicFeatures } from "../strategy/deterministic-features.js";
import { CostModel } from "../strategy/cost.js";
import type { TradeIntent } from "../strategy/signal.js";
import { RiskSizer } from "../risk/sizing.js";
import type { AssetRules, ExecutionPlan } from "../execution/planner.js";
import { estimateSweep } from "../execution/book-walk.js";
import { validPolicyModel, type PolicyModel } from "./policy-validation.js";
import { findPolicy, policyCandidates, policyQuantity, POLICY_NOTIONAL, POLICY_VERSION,
  POLICY_MAX_ENTRY_DELAY_MS, POLICY_ENTRY_LATENCY_MS, type PolicyCandidate } from "./trading-policy.js";

export function policyReserveBps(cfg: SymbolConfig): number {
  return cfg.cost.adverseSelectionBps + cfg.cost.fundingBps + cfg.cost.borrowBps
    + (cfg.cost.positiveCostErrorP95Bps ?? 0);
}

/** New entry path: measured net returns or an explicitly unscored paper experiment. */
export function buildPolicyPlan(input: {
  config: SymbolConfig; book: BookState; features: DeterministicFeatures; asset: AssetRules;
  candidate: PolicyCandidate; policyId: string; model?: PolicyModel;
  allowPaperResearch: boolean; equity: number; equityHighWater: number; nowMs: number;
}): { plan: ExecutionPlan | null; reason: string } {
  const { config: cfg, book, features: f, asset, candidate, model, nowMs } = input;
  const policy = findPolicy(input.policyId);
  if (!policy || policy.family !== candidate.family || !book.valid || f.stale
    || !policyCandidates(f).some((c) => c.family === candidate.family && c.side === candidate.side && c.regime === candidate.regime)) {
    return { plan: null, reason: "POLICY_SIGNAL_INVALID" };
  }
  if (candidate.side === -1 && !asset.shortable) return { plan: null, reason: "SHORT_UNAVAILABLE" };
  const reserveBps = policyReserveBps(cfg);
  if (model && (!validPolicyModel(model, cfg.configurationVersion, nowMs)
    || model.symbol !== book.symbol || model.policyId !== policy.id || model.side !== candidate.side
    || model.regime !== candidate.regime || model.feeBps !== cfg.cost.takerFeeBps
    || model.reserveBps !== reserveBps || f.spreadBps > model.maximumSpreadBps)) {
    return { plan: null, reason: "POLICY_MODEL_OUT_OF_SCOPE" };
  }
  if (!model && !input.allowPaperResearch) return { plan: null, reason: "POLICY_NOT_PROMOTED" };
  const levels = candidate.side === 1 ? book.asks : book.bids;
  const price = levels[0]?.px ?? 0;
  const requestedQty = policyQuantity(price, asset);
  const cost = new CostModel(cfg.cost).estimate(f, book, candidate.side, requestedQty, false);
  if (!(requestedQty > 0) || !cost) return { plan: null, reason: "POLICY_NOT_EXECUTABLE" };
  // Executable labels already contain spread, depth, and both fees. Never
  // subtract that ledger twice. Reserve only extra current latency/impact risk.
  const extraCostBps = cost.latencyBps + cost.impactBps;
  const lowerNetBps = model ? model.lowerNetBps - extraCostBps : 0;
  if (model && lowerNetBps <= cfg.planner.minimumExpectedValueBps) return { plan: null, reason: "POLICY_NET_RETURN_TOO_LOW" };
  const intent: TradeIntent = { side: candidate.side, probability: .5, predictedGrossBps: 0,
    lowerBoundNetBps: lowerNetBps, quality: model ? 1 : cfg.sizing.minimumQualityScale, decisionTsMs: nowMs };
  const context = {
    equity: input.equity, equityHighWater: input.equityHighWater, price,
    initialStopDistance: price * policy.stopLossBps / 10_000,
    estimatedExitCostBps: cost.roundTripBps + reserveBps,
    jumpBuffer: price * f.sigmaHBps / 10_000 * cfg.jumpSigma,
    visibleLiquidityQty: levels[0]!.qty, maximumNotional: Math.min(POLICY_NOTIONAL, cfg.maximumNotional),
    maximumExchangeQty: Math.min(requestedQty, asset.maximumOrderQty), lotSize: asset.minTradeIncrement,
    sigmaHBps: f.sigmaHBps, regimeScale: 1, exposureCapacityQty: requestedQty,
  };
  const sizer = new RiskSizer(cfg.sizing);
  const risk = model ? sizer.size(intent, context) : sizer.sizeResearch(intent, context, POLICY_NOTIONAL);
  if (!risk || risk.qty < asset.minOrderSize) return { plan: null, reason: "POLICY_RISK_SIZE_BLOCK" };
  const sweep = estimateSweep(levels, risk.qty);
  if (!sweep || candidate.side * (sweep.worstPx - price) > 1e-9) return { plan: null, reason: "POLICY_ENTRY_CAP_DEPTH" };
  const exactCost = new CostModel(cfg.cost).estimate(f, book, candidate.side, risk.qty, false)!;
  const rewardRiskRatio = lowerNetBps / (risk.maximumLossPerUnit / price * 10_000);
  if (model && rewardRiskRatio < cfg.planner.minimumRewardRiskRatio) return { plan: null, reason: "POLICY_REWARD_RISK_BLOCK" };
  return { reason: model ? "POLICY_PROMOTED_PAPER" : "POLICY_PAPER_EXPERIMENT", plan: {
    clientOrderId: randomUUID(), decisionId: randomUUID(), riskApprovalId: randomUUID(),
    symbol: book.symbol, side: candidate.side, qty: risk.qty, limitPx: price,
    style: "taker", timeInForce: "ioc", createdMs: nowMs,
    expiresMs: nowMs + POLICY_ENTRY_LATENCY_MS + POLICY_MAX_ENTRY_DELAY_MS,
    originatingSequence: book.sequence, featureHash: createHash("sha256").update(JSON.stringify(f)).digest("hex"),
    strategyVersion: POLICY_VERSION, modelVersion: model?.key ?? "unscored-paper-experiment",
    configurationVersion: cfg.configurationVersion, regime: candidate.regime,
    edgeSource: model ? "CALIBRATED" : "UNRESOLVED", edgeEffectiveSampleCount: model?.independentSamples ?? 0,
    researchOnly: true, expectedCost: exactCost, risk, fillProbability: 1,
    ...(model ? { conservativeNetEdgeBps: lowerNetBps, conservativeExpectedValueBps: lowerNetBps, rewardRiskRatio } : {}),
    expectedValue: model ? risk.qty * price * (model.fittedMeanNetBps - extraCostBps) / 10_000 : 0,
    reduceOnlyIntent: false, economicHorizonMs: policy.horizonMs, entryFamily: policy.family,
    executionPath: "TAKER_TAKER",
    policy: { version: POLICY_VERSION, id: policy.id, feeBps: cfg.cost.takerFeeBps, reserveBps, feeSource: "PAPER_CONFIG", fundingSource: "RESERVE_ONLY",
      ...(f.retestCandidate ? { invalidationPx: f.retestCandidate.invalidationPx,
        volatilityBps: f.retestCandidate.volatilityBps } : {}) },
  } };
}
