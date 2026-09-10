import type { Direction } from "../core/market.js";
import { newLinearLedger, netLiquidation, recordLinearFill, requiredNetExecutionPrice,
  type LinearLedger } from "../economics/net-liquidation.js";
import type { FundingRow } from "../research/hourly-data.js";
import { RiskSizer } from "../risk/sizing.js";
import { RiskState } from "../risk/risk-state.js";
import { evaluateSystematicExit, type SystematicExitState } from "./position.js";
import { buildSystematicSignal } from "./signal.js";
import { SYSTEMATIC_SPEC as S, type SystematicBar, type SystematicSignal } from "./spec.js";

const HOUR = S.barMs, DAY = 24 * HOUR;
export const SYSTEMATIC_REPLAY_ASSUMPTIONS = Object.freeze({
  version: "systematic-hourly-economic-screen-v1", evidenceKind: "HOURLY_CANDLE_PROXY",
  initialEquityUsd: 100_000, maximumNotionalUsd: 1000, maximumEquityFraction: .01,
  maximumGrossNotionalUsd: 5000, maximumPositions: 1,
  baseRiskFraction: .001, maximumDrawdownFraction: .05, targetAtrBps: 20,
  rollingLossFraction: .0075, utcSessionLossFraction: .0075,
  lossLatch: "REALIZED_PRICE_CASH_MINUS_TIMED_FEES_PLUS_FUNDING; HALT_PERSISTS_WITHIN_EACH_RUN",
  candleFinalizationDelayMs: 60_000, entryDelayHours: 1, expirySensitivityDelayHours: 2,
  fees: { base: 5, stress: 7.5 }, adverseSlippage: { base: 1.5, stress: 3 },
  executionPriceCosts: "ADVERSE_SLIPPAGE_PLUS_HALF_OF_SPREAD_BUDGET_ON_EACH_FILL; EXTRA_ADVERSE_ALLOWANCE_AT_STOP_THRESHOLDS",
  spreadBudgetBps: 1, positiveCostErrorP95Bps: 2, fundingReserveBps: 9,
  adverseExecutionBudgetBps: 6, jumpBufferBps: 0,
  lots: { "BTC/USD": .0001, "ETH/USD": .001 }, ticks: { "BTC/USD": 1, "ETH/USD": .1 },
  selection: "LARGEST_ABSOLUTE_ATR_SCALED_TREND_THEN_SYMBOL",
  intrabar: "LOWER_TERMINAL_PNL_OF_O_L_H_C_AND_O_H_L_C_WITH_LINEAR_THIRD_HOUR_SEGMENTS",
  funding: "ABSOLUTE_USD_PER_UNIT_RATE_PRORATED_OVER_SIMULATED_HOLD_INTERVAL",
  fundingInExitRule: "UNOBSERVED_LIVE_LEDGER_PLUS_NINE_BPS_RESERVE; OBSERVED_FUNDING_SEPARATE_IN_REPORT",
  limitations: [
    "Hourly candles cannot establish available order-book depth, spread, latency, partial fills or price impact; no executable-profit claim is supported.",
    "A completed candle becomes usable after the loader's 60-second finalization delay; first eligible hourly fill is one hour after signal close.",
    "The stress scenario changes fees and adverse slippage, not signal age. A separately reported extra hour of latency expires the signal.",
    "Intrabar chronology is unknown. The lower-P&L result of two OHLC-consistent paths is a conservative proxy, not a bound over every possible tick path.",
    "Path selection compares pre-funding liquidation P&L, matching the unfunded live exit ledger; funding duration can differ between paths, so this is not a lower bound on funded net P&L.",
    "A zero-volume candle supplies no fill. Exiting inventory remains open until a positive-volume candle or causes unresolved end-of-window accounting.",
    "The current instrument lots, ticks and fee assumptions do not prove historical contract rules or account fee tiers.",
    "Funding uses archived absolute dollar rates, not relative rate times trade price. Both unverified timestamp interpretations are retained.",
    "Funding for intrabar exits is prorated using the declared synthetic path times; actual historical settlement cash flows remain unverified.",
    "The live paper ledger has no funding feed. The shared exit rule therefore uses the same reserve; replay reports historical funding separately without feeding future rates into decisions.",
    "Order-book depth and the five-second jump estimate are unavailable in this dataset; sizing is an optimistic liquidity-feasible ceiling with zero extra jump buffer, not live sizing parity.",
    "2024 and 2025 H1 were inspected in prior studies and are repeated development, not untouched holdouts. Reserved January-July 2026 is not evaluated.",
  ],
});
export type ReplayScenario = "base" | "stress";
export type ReplayFundingAssumption = "source-plus-hour" | "source-as-end";
const SYMBOLS = ["BTC/USD", "ETH/USD"] as const;
type Symbol = typeof SYMBOLS[number];

export interface ReplayPosition extends SystematicExitState {
  symbol: Symbol; ledger: LinearLedger; systematic: NonNullable<SystematicExitState["systematic"]>;
  signalId: string; signalCloseMs: number; entryRawPx: number;
  initialStressedLossUsd?: number;
}
export interface ReplayTrade {
  symbol: Symbol; side: Direction; signalId: string; signalCloseMs: number;
  entryMs: number; exitMs: number; qty: number; entryPx: number; exitPx: number;
  reason: string; grossPnlUsd: number; feeUsd: number; fundingCashUsd: number | null;
  netPnlUsd: number | null; turnoverUsd: number;
}
export interface ReplayBarOutcome {
  position: ReplayPosition; exit?: { atMs: number; price: number; reason: string };
  liquidationPnlUsd: number; minimumLiquidationPnlUsd: number; ambiguous: boolean;
  liquidationMarks: Array<{ atMs: number; netPnlUsd: number }>;
}
const roundAdverse = (px: number, side: Direction, tick: number) => Number(((side === 1
  ? Math.ceil(px / tick - 1e-10) : Math.floor(px / tick + 1e-10)) * tick).toPrecision(15));
const executable = (rawPx: number, orderSide: Direction, slipBps: number, tick: number) =>
  roundAdverse(rawPx * (1 + orderSide * slipBps / 10_000), orderSide, tick);
const liquidation = (p: ReplayPosition, price: number) => netLiquidation(p.ledger, price, p.systematic.feeBps);

/** Uses the identical cash-aware exit evaluator as paper execution. No new
 * alpha or parameter search lives in this OHLC execution approximation. */
export function replaySystematicBar(position: ReplayPosition, bar: SystematicBar,
  slippageBps: number, tickSize: number): ReplayBarOutcome {
  if (bar.symbol !== position.symbol || bar.openMs < position.openedMs
    || !Number.isFinite(slippageBps) || slippageBps < 0 || !(tickSize > 0))
    throw new Error("INVALID_SYSTEMATIC_REPLAY_BAR");
  const exitSide = -position.side as Direction;
  const openPx = executable(bar.open, exitSide, slippageBps, tickSize);
  if (bar.volume === 0) {
    const p = structuredClone(position), q = liquidation(p, openPx);
    if (bar.openMs + HOUR - p.openedMs >= S.maximumHoldMs) p.phase = "EXITING";
    return { position: p, liquidationPnlUsd: q, minimumLiquidationPnlUsd: q, ambiguous: false,
      liquidationMarks: [{ atMs: bar.openMs, netPnlUsd: q }, { atMs: bar.openMs + HOUR, netPnlUsd: q }] };
  }
  const walk = (middle: [number, number]): ReplayBarOutcome => {
    const p = structuredClone(position), points = [bar.open, ...middle, bar.close];
    let minimum = Infinity, lastRaw = bar.open, lastAt = bar.openMs;
    const liquidationMarks: ReplayBarOutcome["liquidationMarks"] = [];
    for (let i = 0; i < points.length; i++) {
      const raw = points[i]!, atMs = bar.openMs + i * HOUR / 3;
      const px = executable(raw, exitSide, slippageBps, tickSize);
      const result = evaluateSystematicExit(p, px, atMs);
      if (result.protection) p.systematicProtection = result.protection;
      if (result.action === "EXIT") {
        let fillPx = px, fillMs = atMs;
        if (i > 0 && ["SYSTEMATIC_STOP", "SYSTEMATIC_TRAIL", "SYSTEMATIC_TARGET"].includes(result.reason!)) {
          const target = result.reason === "SYSTEMATIC_TARGET"
            ? requiredNetExecutionPrice(p.ledger, p.ledger.entryNotional * p.systematic.targetBps / 10_000,
              p.systematic.feeBps, p.ledger.entryNotional * p.systematic.fundingReserveBps / 10_000)
            : result.stopPx ?? null;
          if (target !== null) {
            const rawTrigger = target / (1 + exitSide * slippageBps / 10_000);
            const fraction = Math.max(0, Math.min(1, (rawTrigger - lastRaw) / (raw - lastRaw)));
            if (Number.isFinite(fraction)) fillMs = Math.round(lastAt + fraction * (atMs - lastAt));
            // Stop/trail fills charge an additional adverse gap allowance at
            // the threshold. Target thresholds already use executable prices.
            fillPx = result.reason === "SYSTEMATIC_TARGET" ? roundAdverse(target, exitSide, tickSize)
              : executable(target, exitSide, slippageBps, tickSize);
          }
        }
        minimum = Math.min(minimum, liquidation(p, fillPx));
        liquidationMarks.push({ atMs: fillMs, netPnlUsd: liquidation(p, fillPx) });
        return { position: p, exit: { atMs: fillMs, price: fillPx, reason: result.reason! },
          liquidationPnlUsd: liquidation(p, fillPx), minimumLiquidationPnlUsd: minimum, ambiguous: false, liquidationMarks };
      }
      liquidationMarks.push({ atMs, netPnlUsd: liquidation(p, px) });
      minimum = Math.min(minimum, liquidation(p, px)); lastRaw = raw; lastAt = atMs;
    }
    return { position: p, liquidationPnlUsd: liquidation(p, executable(bar.close, exitSide, slippageBps, tickSize)),
      minimumLiquidationPnlUsd: minimum, ambiguous: false, liquidationMarks };
  };
  const lowFirst = walk([bar.low, bar.high]), highFirst = walk([bar.high, bar.low]);
  const chosen = lowFirst.liquidationPnlUsd <= highFirst.liquidationPnlUsd ? lowFirst : highFirst;
  chosen.ambiguous = Math.abs(lowFirst.liquidationPnlUsd - highFirst.liquidationPnlUsd) > 1e-8
    || lowFirst.exit?.reason !== highFirst.exit?.reason;
  return chosen;
}

export function systematicFundingCash(side: Direction, qty: number, absoluteRate: number,
  elapsedMs: number): number {
  if (![1, -1].includes(side) || ![qty, absoluteRate, elapsedMs].every(Number.isFinite)
    || qty <= 0 || elapsedMs < 0 || elapsedMs > HOUR) throw new Error("INVALID_SYSTEMATIC_REPLAY_FUNDING");
  return -side * qty * absoluteRate * elapsedMs / HOUR;
}

export function prepareSystematicSignals(bars: readonly SystematicBar[], startMs: number,
  endMs: number, delayHours: number = SYSTEMATIC_REPLAY_ASSUMPTIONS.entryDelayHours): Map<number, SystematicSignal[]> {
  const result = new Map<number, SystematicSignal[]>();
  for (const symbol of SYMBOLS) {
    const own = bars.filter(bar => bar.symbol === symbol && bar.openMs < endMs).sort((a, b) => a.openMs - b.openMs);
    let end = 0;
    for (let atMs = startMs; atMs < endMs; atMs += HOUR) {
      const signalClose = atMs - delayHours * HOUR;
      while (end < own.length && own[end]!.openMs + HOUR <= signalClose) end++;
      const signal = buildSystematicSignal(own.slice(Math.max(0, end - S.minimumBars), end), symbol,
        signalClose + SYSTEMATIC_REPLAY_ASSUMPTIONS.candleFinalizationDelayMs,
        signalClose + SYSTEMATIC_REPLAY_ASSUMPTIONS.candleFinalizationDelayMs);
      if (signal) result.set(atMs, [...result.get(atMs) ?? [], signal]);
    }
  }
  return result;
}

export function replaySystematic(input: { bars: readonly SystematicBar[]; funding: readonly FundingRow[];
  startMs: number; endMs: number; scenario: ReplayScenario; fundingAssumption: ReplayFundingAssumption;
  delayHours?: number; signals?: ReadonlyMap<number, readonly SystematicSignal[]> }) {
  const A = SYSTEMATIC_REPLAY_ASSUMPTIONS;
  if (!Number.isSafeInteger(input.startMs) || !Number.isSafeInteger(input.endMs)
    || input.startMs % DAY || input.endMs % DAY || input.endMs <= input.startMs
    || !["base", "stress"].includes(input.scenario)
    || !["source-plus-hour", "source-as-end"].includes(input.fundingAssumption)) throw new Error("INVALID_SYSTEMATIC_REPLAY_INPUT");
  const feeBps = A.fees[input.scenario], slip = A.adverseSlippage[input.scenario] + A.spreadBudgetBps / 2;
  const signals = input.signals ?? prepareSystematicSignals(input.bars, input.startMs, input.endMs, input.delayHours);
  const byHour = new Map<number, Map<string, SystematicBar>>();
  for (const bar of input.bars) if (bar.openMs >= input.startMs && bar.openMs < input.endMs) {
    let row = byHour.get(bar.openMs); if (!row) { row = new Map(); byHour.set(bar.openMs, row); }
    if (row.has(bar.symbol)) throw new Error("DUPLICATE_SYSTEMATIC_REPLAY_BAR"); row.set(bar.symbol, bar);
  }
  const funding = new Map<string, FundingRow>();
  for (const row of input.funding) {
    const timestamp = row.timestampMs - (input.fundingAssumption === "source-as-end" ? HOUR : 0);
    const key = `${row.symbol}:${timestamp}`;
    if (funding.has(key)) throw new Error("DUPLICATE_SYSTEMATIC_REPLAY_FUNDING"); funding.set(key, row);
  }
  const trades: ReplayTrade[] = [], reasons: Record<string, number> = {}, consumed = new Set<string>();
  const cashFlows: Array<{ atMs: number; cash: number }> = [];
  const riskState = new RiskState(A.rollingLossFraction, A.utcSessionLossFraction, A.maximumDrawdownFraction);
  riskState.setHealth({ publicStream: true, privateStream: true, accountReconciled: true, bookValid: true,
    clockValid: true, riskRecomputed: true, persistenceReady: true });
  riskState.updateEquity(A.initialEquityUsd);
  const block = (reason: string) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
  const perAsset = SYMBOLS.map(symbol => ({ symbol, completedTrades: 0, grossPnlUsd: 0, feeUsd: 0,
    fundingCashUsd: 0, netPnlUsd: 0 as number | null, turnoverUsd: 0 }));
  const daily = Array.from({ length: (input.endMs - input.startMs) / DAY }, (_, i) => ({
    date: new Date(input.startMs + i * DAY).toISOString().slice(0, 10), netPnlUsd: 0 as number | null, completedTrades: 0 }));
  let p: ReplayPosition | undefined, pFunding = 0, pFundingKnown = true;
  let realized = 0, markPnl = 0, previousDailyPnl = 0, highWater: number = A.initialEquityUsd, maxDrawdown = 0;
  let accountingKnown = true, required = 0, observed = 0, missing = 0, ambiguousBars = 0;
  let maximumEntryNotionalUsd = 0, maximumRiskBudgetUsd = 0, riskBreachCount = 0, signalsEvaluated = 0;
  const cooldown = new Map<string, number>();
  const losses = (atMs: number) => {
    const sessionStart = Math.floor(atMs / DAY) * DAY;
    let rolling = 0, session = 0;
    for (let i = cashFlows.length - 1; i >= 0; i--) {
      const flow = cashFlows[i]!;
      if (flow.atMs <= atMs - DAY) break;
      if (flow.atMs <= atMs) { rolling += flow.cash; if (flow.atMs >= sessionStart) session += flow.cash; }
    }
    return { rolling: Math.max(0, -rolling), session: Math.max(0, -session) };
  };
  const mark = (totalPnl: number) => {
    const equity = A.initialEquityUsd + totalPnl; highWater = Math.max(highWater, equity);
    riskState.updateEquity(equity);
    maxDrawdown = Math.max(maxDrawdown, highWater - equity); markPnl = totalPnl;
  };
  const close = (exitPx: number, exitMs: number, reason: string) => {
    if (!p) throw new Error("SYSTEMATIC_REPLAY_NO_POSITION");
    const gross = p.side * p.qty * (exitPx - p.entryPx), fee = p.ledger.entryFees + p.qty * exitPx * feeBps / 10_000;
    const net = gross - fee + pFunding, turnover = p.qty * (p.entryPx + exitPx);
    cashFlows.push({ atMs: exitMs, cash: gross - p.qty * exitPx * feeBps / 10_000 });
    trades.push({ symbol: p.symbol, side: p.side, signalId: p.signalId, signalCloseMs: p.signalCloseMs,
      entryMs: p.openedMs, exitMs, qty: p.qty, entryPx: p.entryPx, exitPx, reason, grossPnlUsd: gross,
      feeUsd: fee, fundingCashUsd: pFundingKnown ? pFunding : null, netPnlUsd: pFundingKnown ? net : null, turnoverUsd: turnover });
    const asset = perAsset.find(row => row.symbol === p!.symbol)!;
    asset.completedTrades++; asset.grossPnlUsd += gross; asset.feeUsd += fee;
    asset.fundingCashUsd += pFunding; asset.turnoverUsd += turnover;
    if (asset.netPnlUsd !== null) asset.netPnlUsd = pFundingKnown ? asset.netPnlUsd + net : null;
    realized += net;
    daily[Math.min(daily.length - 1, Math.floor((exitMs - input.startMs) / DAY))]!.completedTrades++;
    cooldown.set(p.symbol, exitMs + S.reentryCooldownMs); p = undefined; pFunding = 0; pFundingKnown = true;
    mark(realized);
  };
  for (let atMs = input.startMs; atMs < input.endMs; atMs += HOUR) {
    const hour = byHour.get(atMs);
    if (!hour || SYMBOLS.some(symbol => !hour.has(symbol))) throw new Error(`SYSTEMATIC_REPLAY_CANDLE_GAP:${atMs}`);
    const realizedLosses = losses(atMs);
    riskState.updateLosses(realizedLosses.rolling, realizedLosses.session, p?.initialStressedLossUsd ?? 0);
    if (!p) {
      const candidates = [...signals.get(atMs) ?? []].sort((a, b) => Math.abs(b.trendStrength) - Math.abs(a.trendStrength)
        || a.symbol.localeCompare(b.symbol));
      if (!candidates.length) block("HISTORY_UNAVAILABLE");
      for (const signal of candidates) {
        signalsEvaluated++;
        if (signal.version !== S.version || !SYMBOLS.includes(signal.symbol as Symbol)
          || ![signal.barCloseMs, signal.availableAtMs].every(Number.isSafeInteger)
          || signal.barCloseMs < 0 || signal.barCloseMs > atMs || signal.availableAtMs < signal.barCloseMs
          || atMs - signal.barCloseMs > S.maximumSignalAgeMs || signal.availableAtMs > atMs
          || ![1, -1, null].includes(signal.side)) { block("SIGNAL_STALE_OR_UNAVAILABLE"); continue; }
        if (signal.side === null) { block(signal.reason); continue; }
        if (![signal.atrBps, signal.stopBps, signal.targetBps, signal.trendStrength].every(Number.isFinite)
          || signal.atrBps <= 0 || signal.stopBps <= 0 || signal.stopBps >= 10_000
          || Math.abs(signal.stopBps - signal.atrBps * S.stopAtr) > 1e-8
          || Math.abs(signal.targetBps - signal.atrBps * S.targetAtr) > 1e-8) { block("SIGNAL_GEOMETRY_INVALID"); continue; }
        if (!riskState.entriesAllowed()) { block(`RISK_HALT:${riskState.reasons().join(",")}`); continue; }
        if (consumed.has(signal.id)) { block("SIGNAL_ALREADY_FILLED"); continue; }
        if (atMs < (cooldown.get(signal.symbol) ?? 0)) { block("REENTRY_COOLDOWN"); continue; }
        if (!accountingKnown) { block("ACCOUNTING_UNKNOWN"); continue; }
        const symbol = signal.symbol as Symbol, bar = hour.get(symbol)!;
        // Volume is unknowable at the open. A selected zero-volume order holds
        // the one pending slot for this entire candle and cannot fall back to a
        // peer using its retrospectively observed volume.
        const reservedCost = A.spreadBudgetBps + 2 * feeBps + A.adverseExecutionBudgetBps
          + A.fundingReserveBps + A.positiveCostErrorP95Bps;
        if (reservedCost / signal.stopBps > S.maximumCostToStopRatio) { block("COST_TOO_LARGE_FOR_STOP"); continue; }
        const px = executable(bar.open, signal.side, slip, A.ticks[symbol]);
        const equity = A.initialEquityUsd + realized, maximumNotional = Math.min(A.maximumNotionalUsd, equity * A.maximumEquityFraction);
        const risk = new RiskSizer({ baseRiskFraction: A.baseRiskFraction, maximumDrawdown: A.maximumDrawdownFraction,
          maximumBookParticipation: 1, fractionalKelly: 0, maximumKellyFraction: 0,
          targetSigmaHBps: A.targetAtrBps, minimumQualityScale: 1 }).sizeResearch({ side: signal.side,
          probability: .5, predictedGrossBps: 0, lowerBoundNetBps: 0, quality: 1, decisionTsMs: atMs }, {
          equity, equityHighWater: highWater, price: px, initialStopDistance: px * signal.stopBps / 10_000,
          estimatedExitCostBps: reservedCost, jumpBuffer: px * A.jumpBufferBps / 10_000,
          visibleLiquidityQty: maximumNotional / px, maximumNotional, maximumExchangeQty: 1e9,
          lotSize: A.lots[symbol], sigmaHBps: signal.atrBps, regimeScale: 1, exposureCapacityQty: maximumNotional / px,
        }, maximumNotional);
        if (!risk) { block("RISK_OR_MINIMUM_LOT"); continue; }
        if (realizedLosses.rolling + risk.modeledMaximumLoss >= equity * A.rollingLossFraction
          || realizedLosses.session + risk.modeledMaximumLoss >= equity * A.utcSessionLossFraction) {
          block("ROLLING_OR_SESSION_LOSS_CAPACITY"); continue;
        }
        const qty = Number(risk.qty.toPrecision(15));
        if (qty * px > maximumNotional + 1e-8 || qty * risk.maximumLossPerUnit > risk.riskBudget + 1e-8) {
          riskBreachCount++; throw new Error("SYSTEMATIC_REPLAY_RISK_INVARIANT");
        }
        if (bar.volume === 0) { block("ZERO_VOLUME_ENTRY_NO_FILL"); break; }
        const ledger = newLinearLedger(signal.side); recordLinearFill(ledger, qty, px, qty * px * feeBps / 10_000, false);
        cashFlows.push({ atMs, cash: -ledger.entryFees });
        p = { symbol, side: signal.side, qty, entryPx: px, openedMs: atMs, phase: "OPEN", ledger,
          signalId: signal.id, signalCloseMs: signal.barCloseMs, entryRawPx: bar.open, initialStressedLossUsd: risk.modeledMaximumLoss,
          systematic: { version: S.version, signalId: signal.id, signalBarCloseMs: signal.barCloseMs,
            stopBps: signal.stopBps, targetBps: signal.targetBps, trailingBps: signal.atrBps * S.trailingAtr,
            trailActivationR: S.trailActivationR, maximumHoldMs: S.maximumHoldMs, feeBps, fundingReserveBps: A.fundingReserveBps } };
        consumed.add(signal.id); maximumEntryNotionalUsd = Math.max(maximumEntryNotionalUsd, qty * px);
        maximumRiskBudgetUsd = Math.max(maximumRiskBudgetUsd, risk.riskBudget); block("ENTRY_FILLED_PROXY"); break;
      }
    } else block("PORTFOLIO_POSITION_SLOT_OCCUPIED");
    if (p) {
      const bar = hour.get(p.symbol)!;
      const outcome = replaySystematicBar(p, bar, slip, A.ticks[p.symbol]);
      p = outcome.position; if (outcome.ambiguous) ambiguousBars++;
      const heldMs = (outcome.exit?.atMs ?? atMs + HOUR) - Math.max(atMs, p.openedMs);
      const priorFunding = pFunding;
      if (heldMs > 0) {
        required++;
        const row = funding.get(`${p.symbol}:${atMs + HOUR}`);
        if (!row || !Number.isFinite(row.absoluteRate)) { missing++; accountingKnown = false; pFundingKnown = false; }
        else {
          observed++; const cash = systematicFundingCash(p.side, p.qty, row.absoluteRate!, heldMs); pFunding += cash;
          cashFlows.push({ atMs: atMs + heldMs, cash });
        }
      }
      // Preserve the actual order of the selected proxy path: an intrabar gain
      // followed by a trailing exit must contribute peak-to-trough drawdown and
      // the next order's high-water-based risk scale.
      for (const point of outcome.liquidationMarks) {
        const fraction = heldMs > 0 ? Math.max(0, Math.min(1, (point.atMs - atMs) / heldMs)) : 0;
        mark(realized + point.netPnlUsd + priorFunding + (pFunding - priorFunding) * fraction);
      }
      if (outcome.exit) close(outcome.exit.price, outcome.exit.atMs, outcome.exit.reason);
      else {
        if (bar.volume === 0) block("ZERO_VOLUME_EXIT_UNAVAILABLE");
        mark(realized + outcome.liquidationPnlUsd + pFunding);
        if (atMs + HOUR === input.endMs) {
          if (bar.volume > 0) close(executable(bar.close, -p.side as Direction, slip, A.ticks[p.symbol]), input.endMs, "WINDOW_END_LIQUIDATION");
          else { accountingKnown = false; block("WINDOW_END_UNRESOLVED_INVENTORY"); }
        }
      }
    } else mark(realized);
    const latestLosses = losses(atMs + HOUR);
    riskState.updateLosses(latestLosses.rolling, latestLosses.session, p?.initialStressedLossUsd ?? 0);
    if ((atMs + HOUR - input.startMs) % DAY === 0) {
      const row = daily[Math.floor((atMs - input.startMs) / DAY)]!;
      row.netPnlUsd = accountingKnown ? markPnl - previousDailyPnl : null; previousDailyPnl = markPnl;
    }
  }
  if (!accountingKnown) for (const row of daily) row.netPnlUsd = null;
  const grossPnlUsd = perAsset.reduce((sum, row) => sum + row.grossPnlUsd, 0);
  const feeUsd = perAsset.reduce((sum, row) => sum + row.feeUsd, 0);
  const fundingCashUsd = perAsset.reduce((sum, row) => sum + row.fundingCashUsd, 0);
  return { scenario: input.scenario, fundingAssumption: input.fundingAssumption, startMs: input.startMs, endMs: input.endMs,
    evidenceKind: "HOURLY_CANDLE_PROXY" as const, accountingKnown, synthetic: false,
    fundingTimestampVerified: false, completedTrades: trades.length, grossPnlUsd, feeUsd,
    fundingCashUsd: accountingKnown ? fundingCashUsd : null, netPnlUsd: accountingKnown ? realized : null,
    netReturnOnInitialEquity: accountingKnown ? realized / A.initialEquityUsd : null,
    maxDrawdownUsd: accountingKnown ? maxDrawdown : null,
    fundingRequiredHours: required, fundingObservedHours: observed, missingFundingHours: missing,
    dailyNetPnlUsd: daily, perAsset: perAsset.map(row => ({ ...row, netPnlUsd: accountingKnown ? row.netPnlUsd : null })),
    trades, signalsEvaluated, blockReasons: reasons, ambiguousBars, unresolvedPosition: p ?? null,
    maximumEntryNotionalUsd, maximumRiskBudgetUsd, riskBreachCount, riskHaltReasons: riskState.reasons(),
    turnoverUsd: perAsset.reduce((sum, row) => sum + row.turnoverUsd, 0),
    flatBenchmark: { completedTrades: 0, netPnlUsd: 0, maxDrawdownUsd: 0 },
    limitations: A.limitations,
  };
}
