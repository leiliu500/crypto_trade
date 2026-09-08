import { createHash, randomUUID } from "node:crypto";
import type { SymbolConfig } from "../config.js";
import type { BookState } from "../core/market.js";
import type { DeterministicFeatures } from "../strategy/deterministic-features.js";
import type { AssetRules, ExecutionPlan } from "../execution/planner.js";
import { estimateSweep } from "../execution/book-walk.js";
import { CostModel } from "../strategy/cost.js";
import { RiskSizer } from "../risk/sizing.js";
import { policyReserveBps } from "../research/policy-planner.js";
import { POLICY_VERSION } from "../research/trading-policy.js";
import { DISTRIBUTION_SPEC as S, DISTRIBUTION_ACTIONS, distributionEntryProfile, isDistributionEntryProfile,
  type DistributionDecision, type DistributionEntryProfile } from "./spec.js";

export function executableDistributionDecision(d: DistributionDecision | null | undefined, book: BookState, nowMs: number,
  profile: Readonly<DistributionEntryProfile> = distributionEntryProfile()) {
  if (!isDistributionEntryProfile(profile) || !d || d.version !== S.version || d.selectionPolicyVersion !== profile.selectionPolicyVersion
    || (d.entryMode ?? "VALIDATED") !== profile.entryMode
    || !S.symbols.some(s => s === d.symbol) || book.symbol !== d.symbol
    || !book.valid || !book.bids[0] || !book.asks[0] || d.atMs !== book.receiveTsMs
    || d.quoteSequence !== String(book.sequence) || !Number.isFinite(nowMs) || nowMs < d.atMs
    || nowMs - d.atMs > S.maximumQuoteAgeMs || d.referenceBid !== book.bids[0].px || d.referenceAsk !== book.asks[0].px
    || ![d.referenceBid, d.referenceAsk, d.requestedQty].every(x => Number.isFinite(x) && x > 0)
    || d.referenceAsk <= d.referenceBid || d.requestedQty * d.referenceAsk > S.maximumNotional + 1e-8
    || !Array.isArray(d.features) || d.features.length !== S.featureDimension || !d.features.every(x => Number.isFinite(x) && Math.abs(x) <= 1)
    || !Array.isArray(d.estimates) || d.estimates.length !== DISTRIBUTION_ACTIONS.length
    || new Set(d.estimates.map(e => e.actionId)).size !== DISTRIBUTION_ACTIONS.length
    || !d.paperReady || !d.validation || typeof d.validation.ready !== "boolean"
    || ![d.validation.selections, d.validation.observedDays].every(x => Number.isSafeInteger(x) && x >= 0)
    || d.validation.observedDays > d.validation.selections
    || (d.validation.lowerNetBps !== null && !Number.isFinite(d.validation.lowerNetBps))
    || (profile.requiresProspectiveValidation && !d.validation.ready)
    || (d.validation.ready && (d.validation.selections < S.minimumValidationSelections
      || d.validation.observedDays < S.minimumDays || d.validation.lowerNetBps === null
      || d.validation.lowerNetBps <= S.minimumScoreBps))
    || d.reason !== (profile.entryMode === "PAPER_TRIAL" ? "PAPER_TRIAL_NET_RETURN" : "VALIDATED_NET_RETURN")) return null;
  const action = DISTRIBUTION_ACTIONS.find(a => a.id === d.actionId);
  const estimate = d.estimates.find(e => e.actionId === d.actionId);
  if (!action || !estimate?.eligible || estimate.samples < S.minimumSamples || estimate.effectiveSamples < S.minimumEffectiveSamples
    || ![estimate.samples, estimate.observedDays].every(x => Number.isSafeInteger(x) && x >= 0)
    || !Number.isFinite(estimate.effectiveSamples) || estimate.effectiveSamples > estimate.samples + 1e-8
    || estimate.observedDays < profile.minimumTrainingDays || ![estimate.scoreBps, estimate.meanNetBps, estimate.lowerMeanNetBps,
      estimate.tailLossBps, estimate.fillProbability].every(x => x !== null && Number.isFinite(x))
    || estimate.scoreBps! <= S.minimumScoreBps || estimate.lowerMeanNetBps! <= S.minimumScoreBps
    || estimate.tailLossBps! < 0 || estimate.fillProbability <= 0 || estimate.fillProbability > 1
    || estimate.lowerMeanNetBps! > estimate.meanNetBps! + 1e-8
    || Math.abs(estimate.scoreBps! - (estimate.lowerMeanNetBps! - S.tailPenalty * estimate.tailLossBps!)) > 1e-8) return null;
  return { action, estimate };
}

export function buildDistributionPlan(input: { config: SymbolConfig; book: BookState; features: DeterministicFeatures;
  asset: AssetRules; decision: DistributionDecision; paperAllowed: boolean; equity: number; equityHighWater: number; nowMs: number;
  profile?: Readonly<DistributionEntryProfile> }):
  { plan: ExecutionPlan | null; reason: string } {
  const { config: cfg, book, features: f, asset, decision: d, nowMs } = input;
  const selected = executableDistributionDecision(d, book, nowMs, input.profile);
  if (!input.paperAllowed || !selected) return { plan: null, reason: "DISTRIBUTION_NOT_VALIDATED" };
  const { action, estimate } = selected;
  if (f.stale || f.symbol !== book.symbol || f.receiveTsMs !== book.receiveTsMs || asset.symbol !== book.symbol
    || ![f.mid, f.sigmaHBps].every(Number.isFinite) || f.sigmaHBps < 0
    || Math.abs(f.mid - (d.referenceBid + d.referenceAsk) / 2) > 1e-8 * f.mid
    || action.side === -1 && !asset.shortable) return { plan: null, reason: "DISTRIBUTION_QUOTE_INVALID" };
  if (d.feeBps !== cfg.cost.takerFeeBps || d.reserveBps !== policyReserveBps(cfg)) {
    return { plan: null, reason: "DISTRIBUTION_COST_CONFIGURATION_CHANGED" };
  }
  const levels = action.side === 1 ? book.asks : book.bids, price = levels[0]!.px;
  const cost = new CostModel(cfg.cost).estimate(f, book, action.side, d.requestedQty, false);
  if (!cost) return { plan: null, reason: "DISTRIBUTION_COST_UNAVAILABLE" };
  const risk = new RiskSizer(cfg.sizing).sizeResearch({ side: action.side, probability: .5, predictedGrossBps: 0,
    lowerBoundNetBps: estimate.scoreBps!, quality: 1, decisionTsMs: nowMs }, {
    equity: input.equity, equityHighWater: input.equityHighWater, price,
    initialStopDistance: price * action.stopLossBps / 10_000,
    estimatedExitCostBps: cost.roundTripBps + (cfg.cost.positiveCostErrorP95Bps ?? 0),
    jumpBuffer: price * f.sigmaHBps / 10_000 * cfg.jumpSigma,
    visibleLiquidityQty: levels[0]!.qty, maximumNotional: Math.min(S.maximumNotional, cfg.maximumNotional),
    maximumExchangeQty: Math.min(d.requestedQty, asset.maximumOrderQty), lotSize: asset.minTradeIncrement,
    sigmaHBps: f.sigmaHBps, regimeScale: 1, exposureCapacityQty: d.requestedQty,
  }, S.maximumNotional);
  // The fitted target includes partial fills at this exact requested size. A
  // risk reduction cannot silently change its fill-fraction denominator.
  if (!risk || risk.qty < asset.minOrderSize || Math.abs(risk.qty - d.requestedQty) > 1e-10) {
    return { plan: null, reason: "DISTRIBUTION_RESEARCH_SIZE_UNAVAILABLE" };
  }
  const sweep = estimateSweep(levels, risk.qty);
  if (!sweep || action.side * (sweep.worstPx - price) > 1e-9) return { plan: null, reason: "DISTRIBUTION_ENTRY_DEPTH" };
  const rewardRiskRatio = estimate.scoreBps! / (risk.maximumLossPerUnit / price * 10_000);
  if (estimate.scoreBps! <= cfg.planner.minimumExpectedValueBps || rewardRiskRatio < cfg.planner.minimumRewardRiskRatio) {
    return { plan: null, reason: "DISTRIBUTION_RETURN_RISK_BLOCK" };
  }
  return { reason: d.entryMode === "PAPER_TRIAL" ? "DISTRIBUTION_PAPER_TRIAL" : "DISTRIBUTION_VALIDATED_PAPER", plan: {
    clientOrderId: randomUUID(), decisionId: randomUUID(), riskApprovalId: randomUUID(), symbol: book.symbol,
    side: action.side, qty: risk.qty, limitPx: price, style: "taker", timeInForce: "ioc",
    createdMs: d.atMs, expiresMs: d.atMs + S.maximumQuoteAgeMs, originatingSequence: book.sequence,
    featureHash: createHash("sha256").update(JSON.stringify(d.features)).digest("hex"),
    strategyVersion: S.version, modelVersion: S.version, configurationVersion: cfg.configurationVersion,
    regime: S.version, edgeSource: "ANALYTIC", edgeEffectiveSampleCount: estimate.effectiveSamples,
    researchOnly: true, distributionDecision: structuredClone(d), expectedCost: cost, risk,
    fillProbability: estimate.fillProbability, conservativeNetEdgeBps: estimate.scoreBps!,
    conservativeExpectedValueBps: estimate.scoreBps!, rewardRiskRatio,
    // Net targets already include both fees, reserve, spread, impact, and nonfills.
    expectedValue: risk.qty * price * estimate.meanNetBps! / 10_000,
    reduceOnlyIntent: false, economicHorizonMs: action.horizonMs, entryFamily: "CONTINUATION", executionPath: "TAKER_TAKER",
    policy: { version: POLICY_VERSION, id: action.policyId, feeBps: d.feeBps, reserveBps: d.reserveBps,
      feeSource: "PAPER_CONFIG", fundingSource: "RESERVE_ONLY" },
  } };
}
