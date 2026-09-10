import { randomUUID } from "node:crypto";
import type { SymbolConfig } from "../config.js";
import type { BookState, Features } from "../core/market.js";
import type { AssetRules, ExecutionPlan } from "../execution/planner.js";
import { estimateSweep } from "../execution/book-walk.js";
import { RiskSizer } from "../risk/sizing.js";
import type { CostEstimate } from "../strategy/cost.js";
import { SYSTEMATIC_SPEC as S, type SystematicSignal, type SystematicDecision } from "./spec.js";

/** A feasibility planner, not a forecast of profit. No Kelly edge is invented. */
export function buildSystematicPlan(input: { config: SymbolConfig; book: BookState; features: Features;
  asset: AssetRules; signal: SystematicSignal | null; equity: number; equityHighWater: number; nowMs: number;
}): { plan: ExecutionPlan | null; decision: SystematicDecision } {
  const { config: cfg, book, features: f, asset, signal: s, nowMs } = input;
  const bid = book.bids[0]?.px ?? 0, ask = book.asks[0]?.px ?? 0;
  const maximumNotional = Math.min(1_000, cfg.maximumNotional, input.equity * .01);
  const d: SystematicDecision = { version: S.version, symbol: book.symbol, atMs: book.receiveTsMs,
    quoteSequence: String(book.sequence), signal: s, reason: "HISTORY_UNAVAILABLE", paperReady: false,
    side: s?.side ?? null, qty: 0, referenceBid: bid, referenceAsk: ask, limitPx: 0,
    estimatedCostBps: null, costToStopRatio: null, maximumNotional, availableDepthQty: 0, bindingLimit: null };
  const reject = (reason: string) => ({ plan: null, decision: { ...d, reason } });
  if (!s) return reject("HISTORY_UNAVAILABLE");
  if (s.version !== S.version || s.symbol !== book.symbol || !Number.isSafeInteger(s.availableAtMs)
    || !Number.isSafeInteger(s.barCloseMs) || s.barCloseMs < 0 || ![1, -1, null].includes(s.side)
    || s.availableAtMs > nowMs || s.availableAtMs < s.barCloseMs || nowMs < s.barCloseMs
    || nowMs - s.barCloseMs > S.maximumSignalAgeMs) return reject("SIGNAL_STALE_OR_INVALID");
  if (s.side === null) return reject(s.reason);
  if (![s.close, s.atrBps, s.stopBps, s.targetBps].every(n => Number.isFinite(n) && n > 0)
    || s.stopBps >= 10_000 || Math.abs(s.stopBps - s.atrBps * S.stopAtr) > 1e-8
    || Math.abs(s.targetBps - s.atrBps * S.targetAtr) > 1e-8) return reject("SIGNAL_GEOMETRY_INVALID");
  if (!book.valid || f.stale || f.symbol !== book.symbol || asset.symbol !== book.symbol
    || f.receiveTsMs !== book.receiveTsMs || !Number.isFinite(nowMs) || nowMs < book.receiveTsMs
    || nowMs - book.receiveTsMs > S.maximumQuoteAgeMs || !(bid > 0 && ask > bid)
    || !Number.isFinite(book.exchangeTsMs) || book.receiveTsMs < book.exchangeTsMs
    || book.receiveTsMs - book.exchangeTsMs > S.maximumQuoteAgeMs
    || ![f.mid, f.sigmaHBps, asset.priceIncrement, asset.minTradeIncrement, asset.minOrderSize,
      asset.maximumOrderQty, input.equity, input.equityHighWater].every(Number.isFinite)
    || f.sigmaHBps < 0 || asset.priceIncrement <= 0 || asset.minTradeIncrement <= 0
    || asset.minOrderSize <= 0 || input.equity <= 0 || input.equityHighWater < input.equity
    || Math.abs(f.mid - (bid + ask) / 2) > 1e-8 * f.mid) return reject("QUOTE_OR_RISK_INPUT_INVALID");
  for (const [levels, side] of [[book.bids, -1], [book.asks, 1]] as const) {
    if (levels.some((l, i) => ![l.px, l.qty].every(n => Number.isFinite(n) && n > 0)
      || i > 0 && side * (l.px - levels[i - 1]!.px) <= 0)) return reject("BOOK_DEPTH_INVALID");
  }
  if (s.side === -1 && !asset.shortable) return reject("SHORT_UNAVAILABLE");
  const spreadBps = (ask - bid) / f.mid * 10_000;
  if (spreadBps > S.maximumSpreadBps) return reject("SPREAD_TOO_WIDE");
  const top = s.side === 1 ? ask : bid, levels = s.side === 1 ? book.asks : book.bids;
  // Round the collar inward: the tick must never expand the allowed slippage.
  const rawLimit = top * (1 + s.side * S.maximumEntrySlippageBps / 10_000);
  d.limitPx = Number(((s.side === 1 ? Math.floor(rawLimit / asset.priceIncrement + 1e-10)
    : Math.ceil(rawLimit / asset.priceIncrement - 1e-10)) * asset.priceIncrement).toPrecision(15));
  const executableLevels = levels.filter(l => s.side! * (l.px - d.limitPx) <= 1e-9);
  d.availableDepthQty = executableLevels.reduce((v, l) => v + l.qty, 0);
  const fundingBps = Math.max(cfg.cost.fundingBps, S.fundingReserveBpsPerDay * S.maximumHoldMs / 86_400_000);
  const feeBps = cfg.cost.takerFeeBps * 2;
  // Budget adverse execution on both legs, including the delayed entry collar.
  const adverseSelectionBps = Math.max(cfg.cost.adverseSelectionBps, 2 * S.maximumEntrySlippageBps);
  const reservedCost = spreadBps + feeBps + adverseSelectionBps + fundingBps + cfg.cost.borrowBps
    + (cfg.cost.positiveCostErrorP95Bps ?? 0);
  d.estimatedCostBps = reservedCost; d.costToStopRatio = reservedCost / s.stopBps;
  if (!Number.isFinite(reservedCost) || reservedCost < 0 || d.costToStopRatio > S.maximumCostToStopRatio)
    return reject("COST_TOO_LARGE_FOR_STOP");
  const conservativePrice = Math.max(ask, d.limitPx);
  if (maximumNotional / conservativePrice < asset.minOrderSize) return reject("NOTIONAL_BELOW_MINIMUM_ORDER");
  if (d.availableDepthQty * cfg.sizing.maximumBookParticipation < asset.minOrderSize)
    return reject("EXECUTABLE_DEPTH_BELOW_MINIMUM_ORDER");
  const risk = new RiskSizer(cfg.sizing).sizeResearch({ side: s.side, probability: .5, predictedGrossBps: 0,
    lowerBoundNetBps: 0, quality: 1, decisionTsMs: nowMs }, {
    equity: input.equity, equityHighWater: input.equityHighWater, price: conservativePrice,
    initialStopDistance: conservativePrice * s.stopBps / 10_000, estimatedExitCostBps: reservedCost,
    jumpBuffer: conservativePrice * f.sigmaHBps / 10_000 * cfg.jumpSigma,
    visibleLiquidityQty: d.availableDepthQty, maximumNotional,
    maximumExchangeQty: asset.maximumOrderQty, lotSize: asset.minTradeIncrement,
    sigmaHBps: s.atrBps, regimeScale: 1, exposureCapacityQty: maximumNotional / conservativePrice,
  }, maximumNotional);
  if (!risk || risk.qty < asset.minOrderSize) return reject("RISK_BUDGET_BELOW_MINIMUM_ORDER");
  risk.qty = Number(risk.qty.toPrecision(15)); risk.modeledMaximumLoss = risk.qty * risk.maximumLossPerUnit;
  // The shared sweep helper cannot infer bid ordering from a single level.
  // Pre-filter by the explicit order side and omit its ambiguous price cap.
  const sweep = estimateSweep(executableLevels, risk.qty);
  if (!sweep || risk.qty * conservativePrice > maximumNotional + 1e-8
    || risk.modeledMaximumLoss > risk.riskBudget + 1e-8) return reject("EXECUTION_SIZE_INVARIANT");
  const impactBps = Math.max(0, s.side * (sweep.vwap - top) / f.mid * 10_000);
  // Impact is already inside the adverse execution budget. Record its realized
  // quote component and reserve the remainder, avoiding double counting.
  const expectedCost: CostEstimate = { roundTripBps: reservedCost, spreadBps, feeBps,
    entryFeeBps: cfg.cost.takerFeeBps, exitFeeBps: cfg.cost.takerFeeBps, impactBps,
    latencyBps: 0, adverseSelectionBps: adverseSelectionBps - impactBps + (cfg.cost.positiveCostErrorP95Bps ?? 0),
    fundingBps, borrowBps: cfg.cost.borrowBps, entryVwap: sweep.vwap, worstEntryPx: sweep.worstPx };
  d.qty = risk.qty; d.bindingLimit = risk.bindingLimit; d.reason = "EXECUTABLE_RESEARCH_CANDIDATE";
  // paperReady remains false: execution feasibility does not establish profit.
  const plan: ExecutionPlan = { clientOrderId: randomUUID(), decisionId: randomUUID(), riskApprovalId: randomUUID(),
    symbol: book.symbol, side: s.side, qty: d.qty, limitPx: d.limitPx, style: "taker", timeInForce: "ioc",
    createdMs: book.receiveTsMs, expiresMs: book.receiveTsMs + S.entryTtlMs, originatingSequence: book.sequence,
    featureHash: s.inputSha256, strategyVersion: S.version, modelVersion: "unestimated-systematic-paper",
    configurationVersion: cfg.configurationVersion, edgeSource: "UNRESOLVED", researchOnly: true,
    systematic: { version: S.version, signalId: s.id, signalBarCloseMs: s.barCloseMs,
      stopBps: s.stopBps, targetBps: s.targetBps, trailingBps: s.atrBps * S.trailingAtr,
      trailActivationR: S.trailActivationR, maximumHoldMs: S.maximumHoldMs,
      feeBps: cfg.cost.takerFeeBps, fundingReserveBps: fundingBps },
    systematicDecision: structuredClone(d), expectedCost, risk, fillProbability: 0,
    expectedValue: 0, reduceOnlyIntent: false, economicHorizonMs: S.maximumHoldMs,
    entryFamily: "CONTINUATION", executionPath: "TAKER_TAKER" };
  return { plan, decision: d };
}
