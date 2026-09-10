import { createHash, randomUUID } from "node:crypto";
import type { SymbolConfig } from "../config.js";
import type { BookState, Features } from "../core/market.js";
import type { AssetRules, ExecutionPlan } from "../execution/planner.js";
import { estimateSweep } from "../execution/book-walk.js";
import type { RiskApproval } from "../risk/sizing.js";
import type { HourlySymbol } from "../research/hourly-data.js";
import { CHANNEL_SPEC as S, CHANNEL_STUDY_SPEC as D, CHANNEL_PRICE_PROTECTED_SPEC as P } from "./spec.js";
import { evaluatePriceProtectedChannelEntry, type ChannelEntryProtection, type ChannelSignal } from "./replay.js";

export const CHANNEL_PLANNER_SPEC = Object.freeze({ version: "channel-v2-verified-paper-l2-planner-v1",
  maximumQuoteAgeMs: 1000, maximumAccountAgeMs: 1000, maximumSpreadBps: 5,
  maximumBookParticipation: .01, entryLatencyMs: 250, entryTtlMs: 2000,
  entrySlippageBps: S.adverseSlippageBps.base,
  riskAccounting: "MAX_FROZEN_COST_RESERVE_AND_ACTUAL_TICK_ALIGNED_STOP_EXIT_LOSS_PLUS_OBSERVED_SPREAD_RESERVE;RUNTIME_CONSTRAINTS_ONLY_REDUCE_SIZE",
  signalTiming: "NOT_BEFORE_BASE_REPLAY_HOUR_01_UTC;EXPIRES_NEXT_DAILY_CLOSE",
  signalConsumption: "OWNER_MUST_ATOMICALLY_CONSUME_SIGNAL_ON_PLAN_RESERVATION_OR_PRICE_PROTECTION_REJECTION",
  mode: "paper", activationInstalled: false,
});
const HASH = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => {
  if (v && typeof v === "object" && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)));
  return v;
});
export const channelSourceIdentity = (hashes: Readonly<Record<string, string>>) => HASH(canonical(hashes));
const hashLike = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
type Plain = Record<string, unknown>;
const plain = (v: unknown): Plain | null => v && typeof v === "object" && !Array.isArray(v) ? v as Plain : null;
export interface ChannelPlannerContext { config: SymbolConfig; asset: AssetRules; sourceIdentitySha256: string;
  portfolio: { maximumGrossNotional: number; maximumClusterPositions: number; rollingLossFraction: number; sessionLossFraction: number } }
export function channelPlannerContextSha256(input: ChannelPlannerContext): string {
  return HASH(canonical({ planner: CHANNEL_PLANNER_SPEC, strategyVersion: P.version, mode: "paper",
    configurationVersion: input.config.configurationVersion, symbol: input.config.symbol,
    takerFeeBps: input.config.cost.takerFeeBps, borrowBps: input.config.cost.borrowBps,
    maximumNotional: input.config.maximumNotional, sizing: input.config.sizing,
    venueRules: input.asset, portfolio: input.portfolio, sourceIdentitySha256: input.sourceIdentitySha256 }));
}
export interface ChannelQualification {
  schemaVersion: 1; status: "VERIFIED"; mode: "paper"; strategyVersion: string;
  reportSha256: string; protocolSha256: string; sourceIdentitySha256: string; runtimeContextSha256: string;
  checkedAtMs: number; expiresAtMs: number; currentAccountFeesAndRulesVerified: true;
}
export interface VerifiedChannelEligibility {
  readonly status: "VERIFIED"; readonly strategyVersion: string; readonly sourceIdentitySha256: string;
  readonly reportSha256: string; readonly protocolSha256: string; readonly runtimeContextSha256: string;
  readonly qualificationSha256: string; readonly checkedAtMs: number; readonly expiresAtMs: number;
}
const verifiedTokens = new WeakSet<object>();
/** The trusted hashes come from a separately reviewed deployment allowlist.
 * Parsing a report or asserting status=VERIFIED alone never creates permission. */
export function verifyChannelEligibility(input: { reportJson: string; protocolJson: string; qualificationJson: string;
  trusted: { reportSha256: string; protocolSha256: string; qualificationSha256: string; sourceIdentitySha256: string };
  currentSources: Readonly<Record<string, string | Buffer>>; context: ChannelPlannerContext; nowMs: number;
}): { eligibility: VerifiedChannelEligibility | null; reason: string } {
  const deny = (reason: string) => ({ eligibility: null, reason });
  try {
    const r = plain(JSON.parse(input.reportJson)), p = plain(JSON.parse(input.protocolJson));
    const q = plain(JSON.parse(input.qualificationJson)) as ChannelQualification | null;
    if (!r || !p || !q || !Number.isSafeInteger(input.nowMs)) return deny("CHANNEL_INVALID_VALIDATION_ARTIFACT");
    if (!Object.values(input.trusted).every(hashLike) || HASH(input.reportJson) !== input.trusted.reportSha256
      || HASH(input.protocolJson) !== input.trusted.protocolSha256 || HASH(input.qualificationJson) !== input.trusted.qualificationSha256)
      return deny("CHANNEL_VALIDATION_HASH_MISMATCH");
    const strategy = plain(p.strategy), hashes = plain(p.sourceHashes), reportHashes = plain(r.sourceHashes);
    if (!strategy || !hashes || !reportHashes || canonical(strategy) !== canonical(P)
      || r.strategyVersion !== P.version || q.strategyVersion !== P.version
      || canonical(hashes) !== canonical(reportHashes) || !Object.values(hashes).every(hashLike)
      || channelSourceIdentity(hashes as Record<string, string>) !== input.trusted.sourceIdentitySha256)
      return deny("CHANNEL_STRATEGY_SOURCE_IDENTITY_MISMATCH");
    for (const [path, hash] of Object.entries(hashes)) {
      const source = input.currentSources[path];
      if (source === undefined || HASH(source) !== hash) return deny("CHANNEL_CURRENT_SOURCE_NOT_VALIDATED");
    }
    const checks = plain(r.checks), bootstrap = plain(r.bootstrap), runs = r.runs;
    if (r.historicalDevelopmentEligible !== true || !checks || !bootstrap
      || ["allRunsAccounted", "bothPeriodsPositiveBaseAndStress", "enoughEpisodes", "lowerBootstrapWeeklyNetPositive"].some(key => checks[key] !== true)
      || !Number.isFinite(bootstrap.lowerMeanWeeklyNetUsd) || !(Number(bootstrap.lowerMeanWeeklyNetUsd) > 0)
      || !Number.isSafeInteger(r.baseEpisodes) || Number(r.baseEpisodes) < D.minimumClosedEpisodesTotal
      || !Array.isArray(runs) || runs.length !== 4) return deny("CHANNEL_PROFITABILITY_NOT_VERIFIED");
    const seen = new Set<string>();
    for (const raw of runs) {
      const run = plain(raw), window = D.windows.find(w => w.startMs === run?.startMs && w.endMs === run?.endMs);
      const key = `${run?.startMs}:${run?.scenario}`;
      if (!run || !window || !["base", "stress"].includes(String(run.scenario)) || seen.has(key)
        || run.policy !== "channel" || run.accountingKnown !== true || !Number.isFinite(run.netPnlUsd) || !(Number(run.netPnlUsd) > 0)
        || !Array.isArray(run.unresolved) || run.unresolved.length) return deny("CHANNEL_PROFITABILITY_NOT_VERIFIED");
      seen.add(key);
    }
    const contextHash = channelPlannerContextSha256(input.context);
    if (q.schemaVersion !== 1 || q.status !== "VERIFIED" || q.mode !== "paper" || q.currentAccountFeesAndRulesVerified !== true
      || q.reportSha256 !== input.trusted.reportSha256 || q.protocolSha256 !== input.trusted.protocolSha256
      || q.sourceIdentitySha256 !== input.trusted.sourceIdentitySha256 || input.context.sourceIdentitySha256 !== q.sourceIdentitySha256
      || q.runtimeContextSha256 !== contextHash || !Number.isSafeInteger(q.checkedAtMs) || !Number.isSafeInteger(q.expiresAtMs)
      || q.checkedAtMs > input.nowMs || q.expiresAtMs <= input.nowMs || q.checkedAtMs >= q.expiresAtMs)
      return deny("CHANNEL_PAPER_QUALIFICATION_CONTEXT_MISMATCH");
    const eligibility = Object.freeze({ status: "VERIFIED" as const, strategyVersion: P.version,
      sourceIdentitySha256: q.sourceIdentitySha256, reportSha256: q.reportSha256, protocolSha256: q.protocolSha256,
      qualificationSha256: input.trusted.qualificationSha256, runtimeContextSha256: contextHash,
      checkedAtMs: q.checkedAtMs, expiresAtMs: q.expiresAtMs });
    verifiedTokens.add(eligibility); return { eligibility, reason: "VERIFIED_PAPER_ELIGIBILITY" };
  } catch { return deny("CHANNEL_INVALID_VALIDATION_ARTIFACT"); }
}
export interface ChannelOpenRisk { symbol: HourlySymbol; side: 1 | -1; qty: number; markPx: number; protectiveStopPx: number;
  /** Already includes fees, adverse exit and any pending-order reservation. */
  modeledRemainingRiskUsd: number; grossNotionalUsd: number }
export interface ChannelPlannerAccount { known: boolean; fundingKnown: boolean; entriesAllowed: boolean; reconciledAtMs: number;
  equity: number; equityHighWater: number; sessionStartingEquity: number; rolling24HourStartingEquity: number;
  sessionStartMs: number; rolling24HourReferenceAtMs: number;
  positions: readonly ChannelOpenRisk[]; pendingGrossNotionalUsd: number; pendingRiskUsd: number; pendingSymbols: readonly HourlySymbol[];
  lastConsumedSignalEndMsBySymbol: Partial<Record<HourlySymbol, number>> }
export interface ChannelPlannerDecision { strategyVersion: string; plannerVersion: string; symbol: string; atMs: number;
  reason: string; paperReady: boolean; consumeSignal: boolean; qty: number; limitPx: number; visibleExecutableQty: number;
  maximumNotionalUsd: number; riskBudgetUsd: number; maximumLossPerUnit: number; additionalRuntimeRiskReservePerUnit: number;
  bindingLimit: RiskApproval["bindingLimit"] | null; entryProtection: ChannelEntryProtection | null;
  interpretation: "VERIFIED_ELIGIBILITY_PLUS_EXECUTION_FEASIBILITY_IS_NOT_A_PROFIT_GUARANTEE" }
export interface ChannelExecutionPlan extends ExecutionPlan {
  channel: { strategyVersion: string; signalInputSha256: string; signal: ChannelSignal;
    entryProtection: ChannelEntryProtection; qualificationSha256: string; reportSha256: string; sourceIdentitySha256: string;
    entryLatencyMs: number; maximumLossPerUnit: number; decision: ChannelPlannerDecision;
    requiresPreFillRevalidation: true; minimumFillPx: number; maximumFillPx: number;
    costInterpretation: "EXECUTION_RESERVE_WITH_ADDITIONAL_QUOTED_SPREAD;FUTURE_FUNDING_UNESTIMATED_REQUIRES_LIVE_LEDGER" };
}
export function buildChannelPlan(input: ChannelPlannerContext & { mode: string; book: BookState; features: Features;
  signal: { strategyVersion: string; inputSha256: string; value: ChannelSignal } | null;
  account: ChannelPlannerAccount; eligibility: VerifiedChannelEligibility | null; nowMs: number;
}): { plan: ChannelExecutionPlan | null; decision: ChannelPlannerDecision } {
  const { config: cfg, book, asset, signal: envelope, account: a, nowMs, eligibility: e } = input;
  const decision: ChannelPlannerDecision = { strategyVersion: P.version, plannerVersion: CHANNEL_PLANNER_SPEC.version,
    symbol: book.symbol, atMs: nowMs, reason: "CHANNEL_PROFITABILITY_NOT_VERIFIED", paperReady: false, consumeSignal: false,
    qty: 0, limitPx: 0, visibleExecutableQty: 0, maximumNotionalUsd: 0, riskBudgetUsd: 0,
    maximumLossPerUnit: 0, additionalRuntimeRiskReservePerUnit: 0, bindingLimit: null, entryProtection: null,
    interpretation: "VERIFIED_ELIGIBILITY_PLUS_EXECUTION_FEASIBILITY_IS_NOT_A_PROFIT_GUARANTEE" };
  const deny = (reason: string, consumeSignal = false) => ({ plan: null, decision: { ...decision, reason, consumeSignal } });
  if (input.mode !== "paper") return deny("CHANNEL_PAPER_ONLY");
  if (!e || !verifiedTokens.has(e) || e.status !== "VERIFIED") return deny("CHANNEL_PROFITABILITY_NOT_VERIFIED");
  if (!Number.isSafeInteger(nowMs) || nowMs < e.checkedAtMs || nowMs + CHANNEL_PLANNER_SPEC.entryTtlMs >= e.expiresAtMs
    || e.strategyVersion !== P.version || e.sourceIdentitySha256 !== input.sourceIdentitySha256
    || e.runtimeContextSha256 !== channelPlannerContextSha256(input)) return deny("CHANNEL_VALIDATED_CONTEXT_CHANGED");
  if (!envelope || !envelope.value || envelope.strategyVersion !== P.version || !hashLike(envelope.inputSha256)) return deny("CHANNEL_SIGNAL_UNAVAILABLE_OR_UNVERIFIED");
  const s = envelope.value, symbol = s.symbol;
  if (!S.symbols.includes(symbol) || symbol !== book.symbol || cfg.symbol !== symbol || asset.symbol !== symbol
    || !Number.isSafeInteger(s.endMs) || s.endMs % S.dayMs || s.endMs !== Math.floor(nowMs / S.dayMs) * S.dayMs
    || nowMs < s.endMs + S.executionDelayHoursAfterDayClose.base * S.hourMs)
    return deny("CHANNEL_SIGNAL_CLOCK_OR_IDENTITY_INVALID");
  if (s.entrySide === null) return deny("CHANNEL_NO_BREAKOUT");
  if (nowMs + CHANNEL_PLANNER_SPEC.entryTtlMs > s.endMs + S.dayMs) return deny("CHANNEL_SIGNAL_EXPIRES_BEFORE_IOC_BUDGET");
  if (![1, -1].includes(s.entrySide) || ![s.close, s.atr].every(v => Number.isFinite(v) && v > 0)) return deny("CHANNEL_SIGNAL_GEOMETRY_INVALID");
  if ((a.lastConsumedSignalEndMsBySymbol[symbol] ?? -Infinity) >= s.endMs) return deny("CHANNEL_DAILY_SIGNAL_ALREADY_CONSUMED");
  if (!a.known || !a.fundingKnown || !a.entriesAllowed || !Number.isSafeInteger(a.reconciledAtMs)
    || a.reconciledAtMs > nowMs || nowMs - a.reconciledAtMs > CHANNEL_PLANNER_SPEC.maximumAccountAgeMs)
    return deny("CHANNEL_ACCOUNT_NOT_READY");
  if (a.sessionStartMs !== Math.floor(nowMs / S.dayMs) * S.dayMs || !Number.isSafeInteger(a.rolling24HourReferenceAtMs)
    || Math.abs(nowMs - S.dayMs - a.rolling24HourReferenceAtMs) > CHANNEL_PLANNER_SPEC.maximumAccountAgeMs)
    return deny("CHANNEL_ACCOUNT_LOSS_CLOCK_INVALID");
  const riskNumbers = [a.equity, a.equityHighWater, a.sessionStartingEquity, a.rolling24HourStartingEquity];
  if (!riskNumbers.every(v => Number.isFinite(v) && v > 0) || a.equityHighWater < a.equity
    || ![a.pendingGrossNotionalUsd, a.pendingRiskUsd].every(v => Number.isFinite(v) && v >= 0)
    || a.positions.some(p => !S.symbols.includes(p.symbol) || ![1, -1].includes(p.side)
      || ![p.qty, p.markPx, p.protectiveStopPx].every(v => Number.isFinite(v) && v > 0)
      || ![p.modeledRemainingRiskUsd, p.grossNotionalUsd].every(v => Number.isFinite(v) && v >= 0)
      || p.side * (p.markPx - p.protectiveStopPx) <= 0
      || p.grossNotionalUsd + 1e-8 < p.qty * p.markPx
      || p.modeledRemainingRiskUsd + 1e-8 < p.qty * Math.max(0, p.side * (p.markPx - p.protectiveStopPx)))
    || new Set(a.positions.map(p => p.symbol)).size !== a.positions.length
    || a.pendingSymbols.some(symbol => !S.symbols.includes(symbol))) return deny("CHANNEL_ACCOUNT_RISK_INVALID");
  if (a.positions.some(p => p.symbol === symbol) || a.pendingSymbols.includes(symbol)) return deny("CHANNEL_SYMBOL_ALREADY_RESERVED");
  const portfolio = input.portfolio;
  if (!Number.isInteger(portfolio.maximumClusterPositions) || portfolio.maximumClusterPositions <= 0
    || ![portfolio.maximumGrossNotional, portfolio.rollingLossFraction, portfolio.sessionLossFraction].every(v => Number.isFinite(v) && v > 0)
    || a.positions.length + new Set(a.pendingSymbols).size >= Math.min(2, portfolio.maximumClusterPositions)) return deny("CHANNEL_CLUSTER_CAPACITY_UNAVAILABLE");
  if (cfg.cost.takerFeeBps !== S.feesBps.base || cfg.cost.borrowBps !== 0 || asset.priceIncrement !== S.ticks[symbol]
    || asset.minTradeIncrement !== S.lots[symbol] || asset.minOrderSize !== S.lots[symbol]
    || ![asset.maximumOrderQty, cfg.maximumNotional, cfg.sizing.baseRiskFraction, cfg.sizing.maximumBookParticipation,
      cfg.sizing.maximumDrawdown].every(v => Number.isFinite(v) && v > 0)) return deny("CHANNEL_FROZEN_FEES_OR_RULES_MISMATCH");
  if (s.entrySide === -1 && !asset.shortable) return deny("CHANNEL_SHORT_UNAVAILABLE");
  const f = input.features, bid = book.bids[0]?.px ?? 0, ask = book.asks[0]?.px ?? 0, mid = (bid + ask) / 2;
  if (!book.valid || f.stale || f.symbol !== symbol || f.receiveTsMs !== book.receiveTsMs
    || typeof book.sequence !== "bigint" || book.sequence < 0n || ![book.exchangeTsMs, book.receiveTsMs].every(Number.isSafeInteger)
    || book.exchangeTsMs > book.receiveTsMs || book.receiveTsMs > nowMs
    || nowMs - book.exchangeTsMs > CHANNEL_PLANNER_SPEC.maximumQuoteAgeMs
    || !(bid > 0 && ask > bid) || !Number.isFinite(f.mid) || Math.abs(f.mid - mid) > mid * 1e-10)
    return deny("CHANNEL_QUOTE_STALE_OR_INVALID");
  for (const [levels, direction] of [[book.bids, -1], [book.asks, 1]] as const)
    if (levels.some((level, i) => ![level.px, level.qty].every(v => Number.isFinite(v) && v > 0)
      || Math.abs(level.px / asset.priceIncrement - Math.round(level.px / asset.priceIncrement)) > 1e-7
      || i > 0 && direction * (level.px - levels[i - 1]!.px) <= 0)) return deny("CHANNEL_BOOK_DEPTH_INVALID");
  const spreadBps = (ask - bid) / mid * 10000;
  if (spreadBps > CHANNEL_PLANNER_SPEC.maximumSpreadBps) return deny("CHANNEL_SPREAD_TOO_WIDE");
  const side = s.entrySide, top = side === 1 ? ask : bid, slip = CHANNEL_PLANNER_SPEC.entrySlippageBps / 10000;
  const topProtection = evaluatePriceProtectedChannelEntry(s, top);
  if (!topProtection.eligible) return deny(`CHANNEL_${topProtection.reason}`, true);
  const rawCollar = top * (1 + side * slip), signalCollar = s.close + side * P.maximumEntryDisplacementAtr * s.atr;
  const rawLimit = side === 1 ? Math.min(rawCollar, signalCollar) : Math.max(rawCollar, signalCollar);
  const tick = asset.priceIncrement, limitPx = Number(((side === 1 ? Math.floor(rawLimit / tick + 1e-10)
    : Math.ceil(rawLimit / tick - 1e-10)) * tick).toPrecision(15));
  if (side * (limitPx - top) < -1e-8) return deny("CHANNEL_NO_EXECUTABLE_PRICE_WITHIN_COLLAR", true);
  const protectedLimit = evaluatePriceProtectedChannelEntry(s, limitPx);
  if (!protectedLimit.eligible) return deny(`CHANNEL_${protectedLimit.reason}`, true);
  const protection = protectedLimit.protection, levels = (side === 1 ? book.asks : book.bids).filter(level => side * (level.px - limitPx) <= 1e-8);
  const visible = levels.reduce((n, l) => n + l.qty, 0), fee = cfg.cost.takerFeeBps / 10000;
  const stopExitRaw = protection.fixedStopPx * (1 - side * slip);
  const stopExitPx = Number(((side === 1 ? Math.floor(stopExitRaw / tick + 1e-10) : Math.ceil(stopExitRaw / tick - 1e-10)) * tick).toPrecision(15));
  if (!(stopExitPx > 0)) return deny("CHANNEL_STOP_EXIT_PRICE_INVALID");
  const frozenUnitRisk = protection.actualEntryStopDistance + limitPx * 2 * (fee + slip);
  const actualStopLoss = side * (limitPx - stopExitPx) + limitPx * fee + stopExitPx * fee;
  const unitRisk = Math.max(frozenUnitRisk, actualStopLoss) + limitPx * spreadBps / 10000;
  const existingRisk = a.pendingRiskUsd + a.positions.reduce((n, p) => n + Math.max(p.modeledRemainingRiskUsd,
    p.qty * (Math.max(0, p.side * (p.markPx - p.protectiveStopPx)) + p.markPx * 2 * (fee + slip))), 0);
  const gross = a.pendingGrossNotionalUsd + a.positions.reduce((n, p) => n + p.grossNotionalUsd, 0);
  const maximumNotional = Math.min(S.maximumLegNotionalUsd, cfg.maximumNotional, a.equity * S.maximumLegEquityFraction);
  const lossHeadroom = Math.max(0, Math.min(a.equity - a.sessionStartingEquity * (1 - Math.min(S.sessionLossFraction, portfolio.sessionLossFraction)),
    a.equity - a.rolling24HourStartingEquity * (1 - Math.min(S.rolling24HourLossFraction, portfolio.rollingLossFraction)),
    a.equity - a.equityHighWater * (1 - Math.min(S.maximumAccountDrawdownFraction, cfg.sizing.maximumDrawdown))) - existingRisk);
  const riskBudget = Math.max(0, Math.min(a.equity * Math.min(S.riskFractionPerAsset, cfg.sizing.baseRiskFraction),
    a.equity * S.maximumClusterRiskFraction - existingRisk, lossHeadroom));
  const capPrice = Math.max(ask, limitPx), participation = Math.min(CHANNEL_PLANNER_SPEC.maximumBookParticipation, cfg.sizing.maximumBookParticipation);
  const capacities: Array<[RiskApproval["bindingLimit"], number]> = [["risk", riskBudget / unitRisk],
    ["liquidity", visible * participation], ["notional", maximumNotional / capPrice], ["exchange", asset.maximumOrderQty],
    ["exposure", Math.max(0, Math.min(S.maximumGrossUsd, portfolio.maximumGrossNotional) - gross) / capPrice]];
  const [bindingLimit, rawQty] = capacities.reduce((best, candidate) => candidate[1] < best[1] ? candidate : best);
  const qty = Number((Math.floor(rawQty / asset.minTradeIncrement + 1e-10) * asset.minTradeIncrement).toPrecision(15));
  Object.assign(decision, { limitPx, visibleExecutableQty: visible, maximumNotionalUsd: maximumNotional,
    riskBudgetUsd: riskBudget, maximumLossPerUnit: unitRisk, additionalRuntimeRiskReservePerUnit: unitRisk - frozenUnitRisk,
    bindingLimit, entryProtection: protection });
  if (qty < asset.minOrderSize) return deny(`CHANNEL_MINIMUM_ORDER_BLOCKED_BY_${bindingLimit.toUpperCase()}`);
  const sweep = estimateSweep(levels, qty);
  if (!sweep || qty * unitRisk > riskBudget + 1e-8 || qty * capPrice > maximumNotional + 1e-8
    || qty > visible * participation + 1e-10 || qty > asset.maximumOrderQty + 1e-10) return deny("CHANNEL_SIZE_INVARIANT_FAILED");
  const sweepProtection = evaluatePriceProtectedChannelEntry(s, sweep.vwap);
  if (!sweepProtection.eligible) return deny("CHANNEL_SWEEP_PRICE_PROTECTION_FAILED", true);
  const risk: RiskApproval = { qty, riskBudget, maximumLossPerUnit: unitRisk, modeledMaximumLoss: qty * unitRisk,
    drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit };
  const impactBps = Math.max(0, side * (sweep.vwap - top) / mid * 10000), feeBps = cfg.cost.takerFeeBps * 2;
  Object.assign(decision, { reason: "CHANNEL_VERIFIED_PAPER_PLAN", paperReady: true, consumeSignal: true, qty });
  const plan: ChannelExecutionPlan = { clientOrderId: randomUUID(), decisionId: randomUUID(), riskApprovalId: randomUUID(),
    symbol, side, qty, limitPx, style: "taker", timeInForce: "ioc", createdMs: nowMs,
    expiresMs: Math.min(nowMs + CHANNEL_PLANNER_SPEC.entryTtlMs, s.endMs + S.dayMs), originatingSequence: book.sequence,
    featureHash: envelope.inputSha256, strategyVersion: P.version, modelVersion: P.version,
    configurationVersion: cfg.configurationVersion, edgeSource: "UNRESOLVED", researchOnly: true,
    expectedCost: { roundTripBps: spreadBps + feeBps + 2 * CHANNEL_PLANNER_SPEC.entrySlippageBps,
      spreadBps, feeBps, entryFeeBps: cfg.cost.takerFeeBps, exitFeeBps: cfg.cost.takerFeeBps,
      impactBps, latencyBps: 0, adverseSelectionBps: 2 * CHANNEL_PLANNER_SPEC.entrySlippageBps - impactBps,
      fundingBps: 0, borrowBps: 0, entryVwap: sweep.vwap, worstEntryPx: sweep.worstPx },
    risk, fillProbability: 0, expectedValue: 0, reduceOnlyIntent: false, entryFamily: "CONTINUATION", executionPath: "TAKER_TAKER",
    channel: { strategyVersion: P.version, signalInputSha256: envelope.inputSha256, signal: structuredClone(s),
      entryProtection: protection, qualificationSha256: e.qualificationSha256, reportSha256: e.reportSha256,
      sourceIdentitySha256: e.sourceIdentitySha256, entryLatencyMs: CHANNEL_PLANNER_SPEC.entryLatencyMs,
      maximumLossPerUnit: unitRisk, decision: structuredClone(decision), requiresPreFillRevalidation: true,
      minimumFillPx: s.close - P.maximumEntryDisplacementAtr * s.atr, maximumFillPx: s.close + P.maximumEntryDisplacementAtr * s.atr,
      costInterpretation: "EXECUTION_RESERVE_WITH_ADDITIONAL_QUOTED_SPREAD;FUTURE_FUNDING_UNESTIMATED_REQUIRES_LIVE_LEDGER" } };
  return { plan, decision };
}
