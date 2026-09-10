import type { Direction } from "../core/market.js";
import type { FundingRow } from "../research/hourly-data.js";
import { RiskState } from "../risk/risk-state.js";
import type { ProfitBar, ProfitForecast, ProfitSymbol } from "./model.js";
import { PROFIT_SPEC as S } from "./spec.js";

const HOUR = S.hourMs, DAY = S.dayMs;
export const PROFIT_REPLAY_ASSUMPTIONS = Object.freeze({
  version: "weekly-inventory-hourly-proxy-v1", initialEquityUsd: 100_000,
  evidenceKind: "HOURLY_CANDLE_PROXY", fees: { base: 5, stress: 7.5 },
  adverseSlippage: { base: 1.5, stress: 3 }, spreadBps: 1,
  fillHourAfterMondayMidnight: { base: 1, stress: 2 },
  fundingReserveBps: S.fundingReserveBpsPerDay * S.forecastHorizonDays,
  lots: { "BTC/USD": .0001, "ETH/USD": .001 }, ticks: { "BTC/USD": 1, "ETH/USD": .1 },
  flattenLeadHours: 48,
  intrabar: "FAVORABLE_EXTREME_THEN_ADVERSE_EXTREME_THEN_CLOSE; STOP_FIRST_EXIT_WITH_ADVERSE_ALLOWANCE",
  limitations: [
    "Hourly candles do not establish executable depth, latency, spread, partial fills or impact; this is not executable-profit evidence.",
    "Positive full-hour volume is used only as a fill-availability proxy; future candle volume never permits fallback to a second symbol at the same open.",
    "Within-hour chronology is synthetic. Favorable-before-adverse marks retain peak-to-trough drawdown; stops receive an extra adverse execution allowance.",
    "Funding uses archived absolute USD-per-unit rates prorated over synthetic holding intervals. FundingRow timestamps are normalized interval ends; source-plus-hour assigns [end-1h,end), while source-as-end shifts that interval one hour earlier. Actual settlement timing is unverified.",
    "Missing held funding makes total funded P&L and drawdown unknown and permanently blocks later entries in that run.",
    "Current lots, ticks and fixed fee assumptions do not establish historical contract specifications or account fee tiers.",
    "Sizing reserves current rolling-loss, UTC-session-loss and drawdown dollar headroom. The notional cap is enforced at entry and hourly trims; intrabar price moves and zero-volume hours can exceed it before an executable reduction.",
    "Depth is unavailable. Quantities are optimistic liquidity-feasible ceilings, with no claim of live depth participation parity.",
    "Weekly forecast confidence bounds concern parameter uncertainty of a conditional mean; they are not predictive intervals or profit guarantees.",
    "Flat orders are requested 48 hours before each window ends. Unfilled inventory is reported unresolved, never silently assigned a closing fill.",
  ],
});
export type ProfitReplayScenario = "base" | "stress";
export type ProfitFundingAssumption = "source-plus-hour" | "source-as-end";
export type ProfitReplayPolicy = "weekly-forecast" | "risk-managed-long-btc" | "risk-managed-long-eth";
interface Candidate { forecast: ProfitForecast; side: Direction; netLowerBps: number; score: number }
export interface ProfitReplayOrder {
  symbol: ProfitSymbol; side: Direction; atMs: number; qty: number; price: number;
  reduceOnly: boolean; reason: string; forecastId: string; feeUsd: number; grossPnlUsd: number;
}
export interface ProfitReplayTrade {
  symbol: ProfitSymbol; side: Direction; entryMs: number; exitMs: number;
  entryQty: number; entryPx: number; exitPx: number; reason: string; forecastId: string;
  grossPnlUsd: number; feeUsd: number; fundingCashUsd: number | null; netPnlUsd: number | null;
  turnoverUsd: number; reductions: number;
}
interface Position {
  symbol: ProfitSymbol; side: Direction; qty: number; entryQty: number; entryPx: number;
  entryMs: number; stopPx: number; initialStopFraction: number; forecast: ProfitForecast;
  entryForecastId: string;
  gross: number; fee: number; funding: number; fundingKnown: boolean; turnover: number; reductions: number;
}
const finite = (v: number) => Number.isFinite(v);
const floorQty = (qty: number, symbol: ProfitSymbol) => {
  const lot = PROFIT_REPLAY_ASSUMPTIONS.lots[symbol];
  return Number((Math.floor(qty / lot + 1e-10) * lot).toPrecision(15));
};
const tickRound = (px: number, side: Direction, symbol: ProfitSymbol) => {
  const tick = PROFIT_REPLAY_ASSUMPTIONS.ticks[symbol];
  return Number(((side === 1 ? Math.ceil(px / tick - 1e-10) : Math.floor(px / tick + 1e-10)) * tick).toPrecision(15));
};
function validForecast(f: ProfitForecast, decisionMs: number): boolean {
  return f.version === S.version && S.symbols.includes(f.symbol) && f.decisionMs === decisionMs
    && f.availableAtMs === decisionMs && f.expiresAtMs === decisionMs + S.maximumSignalAgeMs
    && Number.isSafeInteger(f.fitAtMs) && f.fitAtMs <= decisionMs
    && f.maximumLabelAvailableAtMs <= f.fitAtMs && f.maximumLabelEndMs <= f.fitAtMs
    && typeof f.id === "string" && f.id.length > 0 && typeof f.modelId === "string" && f.modelId.length > 0
    && [f.close, f.sigmaDay].every(v => finite(v) && v > 0)
    && f.sigmaDay >= S.minimumDailyVolatility && S.initialStopDailySigma * f.sigmaDay < 1
    && [f.meanGrossBps, f.lowerGrossBps, f.upperGrossBps].every(finite)
    && f.lowerGrossBps <= f.upperGrossBps && Number.isInteger(f.nWeeks) && f.nWeeks >= S.minimumTrainingWeeks;
}

/** Deterministic economic replay. Forecasts must be fitted outside this function
 * before evaluating any outcomes. No training, optimization or fallback alpha. */
export function replayProfit(input: {
  bars: readonly ProfitBar[]; funding: readonly FundingRow[]; forecasts: readonly ProfitForecast[];
  startMs: number; endMs: number; scenario: ProfitReplayScenario; fundingAssumption: ProfitFundingAssumption;
  policy?: ProfitReplayPolicy;
}) {
  const A = PROFIT_REPLAY_ASSUMPTIONS;
  const policy = input.policy ?? "weekly-forecast";
  if (![input.startMs, input.endMs].every(v => Number.isSafeInteger(v) && v >= 0 && v % DAY === 0)
    || input.endMs <= input.startMs || !["base", "stress"].includes(input.scenario)
    || !["source-plus-hour", "source-as-end"].includes(input.fundingAssumption)
    || !["weekly-forecast", "risk-managed-long-btc", "risk-managed-long-eth"].includes(policy)) throw new Error("INVALID_PROFIT_REPLAY_INPUT");
  const feeBps = A.fees[input.scenario], slipBps = A.adverseSlippage[input.scenario] + A.spreadBps / 2;
  const hurdleBps = 2 * feeBps + 2 * A.adverseSlippage[input.scenario] + A.spreadBps
    + S.costErrorReserveBps + A.fundingReserveBps;
  const price = (raw: number, side: Direction, symbol: ProfitSymbol) => tickRound(raw * (1 + side * slipBps / 10_000), side, symbol);
  const byHour = new Map<number, Map<ProfitSymbol, ProfitBar>>();
  for (const b of input.bars) if (b.openMs >= input.startMs && b.openMs < input.endMs) {
    if (!S.symbols.includes(b.symbol as ProfitSymbol) || !Number.isSafeInteger(b.openMs) || b.openMs % HOUR
      || ![b.open, b.high, b.low, b.close].every(v => finite(v) && v > 0)
      || !finite(b.volume) || b.volume < 0 || b.low > Math.min(b.open, b.close)
      || b.high < Math.max(b.open, b.close) || b.low > b.high) throw new Error("INVALID_PROFIT_REPLAY_BAR");
    const row = byHour.get(b.openMs) ?? new Map<ProfitSymbol, ProfitBar>();
    if (row.has(b.symbol as ProfitSymbol)) throw new Error("DUPLICATE_PROFIT_REPLAY_BAR");
    row.set(b.symbol as ProfitSymbol, b); byHour.set(b.openMs, row);
  }
  const forecastMap = new Map<number, ProfitForecast[]>();
  for (const f of input.forecasts) {
    if (!Number.isSafeInteger(f.decisionMs) || f.decisionMs % DAY !== S.candleFinalizationDelayMs
      || new Date(f.decisionMs).getUTCDay() !== 1) throw new Error("INVALID_PROFIT_FORECAST_TIME");
    const group = forecastMap.get(f.decisionMs) ?? [];
    if (group.some(other => other.symbol === f.symbol)) throw new Error("DUPLICATE_PROFIT_FORECAST");
    group.push(f); forecastMap.set(f.decisionMs, group);
  }
  const fundingMap = new Map<string, FundingRow>();
  for (const f of input.funding) {
    const hour = f.timestampMs - HOUR - (input.fundingAssumption === "source-as-end" ? HOUR : 0);
    if (hour < input.startMs || hour >= input.endMs) continue;
    if (!S.symbols.includes(f.symbol as ProfitSymbol) || !Number.isSafeInteger(hour) || hour % HOUR
      || !finite(f.rate) || Math.abs(f.rate) > 1
      || (f.absoluteRate !== undefined && (!finite(f.absoluteRate) || f.rate * f.absoluteRate < 0))) throw new Error("INVALID_PROFIT_FUNDING");
    if (f.absoluteRate === undefined) continue;
    const key = `${f.symbol}:${hour}`;
    if (fundingMap.has(key)) throw new Error("DUPLICATE_PROFIT_FUNDING"); fundingMap.set(key, f);
  }
  const risk = new RiskState(S.rollingLossFraction, S.sessionLossFraction, S.maximumDrawdownFraction);
  risk.setHealth({ publicStream: true, privateStream: true, accountReconciled: true, bookValid: true,
    clockValid: true, riskRecomputed: true, persistenceReady: true });
  const orders: ProfitReplayOrder[] = [], trades: ProfitReplayTrade[] = [];
  const flows: Array<{ atMs: number; cash: number }> = [];
  const reasons: Record<string, number> = {}, stopBlocked = new Map<ProfitSymbol, number>();
  const daily = Array.from({ length: (input.endMs - input.startMs) / DAY }, (_, i) => ({
    date: new Date(input.startMs + i * DAY).toISOString().slice(0, 10), netPnlUsd: 0 as number | null,
    knownCashPnlUsd: 0, exposureNotionalHours: 0, completedTrades: 0, orders: 0 }));
  const perAsset = S.symbols.map(symbol => ({ symbol, grossPnlUsd: 0, feeUsd: 0, knownFundingCashUsd: 0,
    fundingCashUsd: 0 as number | null, netPnlUsd: 0 as number | null, turnoverUsd: 0,
    completedTrades: 0, orders: 0, exposureNotionalHours: 0, fundingRequiredHours: 0, missingFundingHours: 0 }));
  let p: Position | undefined, target: Candidate | undefined, exitReason: string | undefined;
  let entryAfterMs = input.startMs, cash = 0, accountingKnown = true, peak: number = A.initialEquityUsd;
  let maxDrawdown = 0, maxDrawdownFraction = 0, maxEntryNotional = 0, maxMarkedNotional = 0, maxRiskBudget = 0;
  let fundingRequiredHours = 0, fundingObservedHours = 0, missingFundingHours = 0, previousDailyPnl = 0;
  let lastTotal = 0, riskBreachCount = 0, zeroVolumeHeldHours = 0, weeklyDecisions = 0;
  let currentRollingLoss = 0, currentSessionLoss = 0;
  const block = (reason: string) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
  const asset = (symbol: ProfitSymbol) => perAsset.find(a => a.symbol === symbol)!;
  const day = (atMs: number) => daily[Math.min(daily.length - 1, Math.max(0, Math.floor((atMs - input.startMs) / DAY)))]!;
  const addCash = (atMs: number, amount: number) => {
    cash += amount; flows.push({ atMs, cash: amount }); day(atMs).knownCashPnlUsd += amount;
  };
  const liquidation = (raw: number) => p ? p.side * p.qty * (price(raw, -p.side as Direction, p.symbol) - p.entryPx)
    - p.qty * price(raw, -p.side as Direction, p.symbol) * feeBps / 10_000 : 0;
  const mark = (raw?: number, accruedFunding = 0) => {
    lastTotal = cash + accruedFunding + (p && raw !== undefined ? liquidation(raw) : 0);
    const equity = A.initialEquityUsd + lastTotal; peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity); risk.updateEquity(equity);
    maxDrawdownFraction = Math.max(maxDrawdownFraction, 1 - equity / peak);
    if (p && raw !== undefined) maxMarkedNotional = Math.max(maxMarkedNotional, p.qty * raw);
  };
  const lossState = (atMs: number, raw?: number) => {
    const start = Math.floor(atMs / DAY) * DAY;
    let rolling = 0, session = 0;
    for (let i = flows.length - 1; i >= 0; i--) {
      const flow = flows[i]!; if (flow.atMs <= atMs - DAY) break;
      if (flow.atMs <= atMs) { rolling += flow.cash; if (flow.atMs >= start) session += flow.cash; }
    }
    const stressed = p ? p.qty * (Math.max(0, p.side * ((raw ?? p.entryPx) - p.stopPx))
      + (raw ?? p.entryPx) * hurdleBps / 10_000) : 0;
    currentRollingLoss = Math.max(0, -rolling); currentSessionLoss = Math.max(0, -session);
    risk.updateLosses(currentRollingLoss, currentSessionLoss, stressed);
  };
  const reduce = (qty: number, px: number, atMs: number, reason: string) => {
    if (!p || !(qty > 0) || qty > p.qty + 1e-10) throw new Error("INVALID_PROFIT_REDUCTION");
    qty = Math.min(qty, p.qty);
    const gross = p.side * qty * (px - p.entryPx), fee = qty * px * feeBps / 10_000;
    const own = asset(p.symbol);
    orders.push({ symbol: p.symbol, side: -p.side as Direction, atMs, qty, price: px, reduceOnly: true,
      reason, forecastId: p.forecast.id, feeUsd: fee, grossPnlUsd: gross });
    own.orders++; day(atMs).orders++; own.grossPnlUsd += gross; own.feeUsd += fee; own.turnoverUsd += qty * px;
    p.gross += gross; p.fee += fee; p.turnover += qty * px; p.reductions++;
    addCash(atMs, gross - fee); p.qty = Number((p.qty - qty).toPrecision(15));
    if (p.qty < A.lots[p.symbol] / 2) {
      trades.push({ symbol: p.symbol, side: p.side, entryMs: p.entryMs, exitMs: atMs,
        entryQty: p.entryQty, entryPx: p.entryPx, exitPx: px, reason, forecastId: p.entryForecastId,
        grossPnlUsd: p.gross, feeUsd: p.fee, fundingCashUsd: p.fundingKnown ? p.funding : null,
        netPnlUsd: p.fundingKnown ? p.gross - p.fee + p.funding : null, turnoverUsd: p.turnover, reductions: p.reductions });
      own.completedTrades++; day(atMs).completedTrades++; p = undefined; exitReason = undefined;
      entryAfterMs = Math.floor(atMs / HOUR) * HOUR + HOUR;
    }
  };
  const fund = (position: Position, hourMs: number, elapsedMs: number) => {
    if (elapsedMs <= 0) return;
    const own = asset(position.symbol), notionalHours = position.qty * position.entryPx * elapsedMs / HOUR;
    own.exposureNotionalHours += notionalHours; day(hourMs).exposureNotionalHours += notionalHours;
    fundingRequiredHours++; own.fundingRequiredHours++;
    const row = fundingMap.get(`${position.symbol}:${hourMs}`);
    if (!row || row.absoluteRate === undefined) {
      missingFundingHours++; own.missingFundingHours++; position.fundingKnown = false;
      accountingKnown = false; risk.halt("ACCOUNT_UNKNOWN"); block("FUNDING_ACCOUNTING_UNKNOWN"); return;
    }
    fundingObservedHours++;
    const amount = -position.side * position.qty * row.absoluteRate * elapsedMs / HOUR;
    position.funding += amount; own.knownFundingCashUsd += amount; addCash(hourMs + elapsedMs, amount);
  };
  // Cash posts once at the end of the held interval. Intrabar liquidation marks
  // include accrued funding at their own synthetic time so the drawdown path
  // cannot omit costs until after a favorable or adverse price mark.
  const accruedFunding = (position: Position, hourMs: number, elapsedMs: number) => {
    const absoluteRate = fundingMap.get(`${position.symbol}:${hourMs}`)?.absoluteRate;
    return absoluteRate === undefined ? 0 : -position.side * position.qty * absoluteRate * elapsedMs / HOUR;
  };
  const candidatesAt = (decisionMs: number): Candidate[] => {
    const candidates: Candidate[] = [];
    const group = forecastMap.get(decisionMs) ?? [];
    if (group.length !== S.symbols.length) { block("FORECAST_UNAVAILABLE"); return []; }
    for (const f of group) {
      if (!validForecast(f, decisionMs)) { block("FORECAST_INVALID_OR_UNMATURED"); continue; }
      if (policy !== "weekly-forecast") {
        const symbol = policy === "risk-managed-long-btc" ? "BTC/USD" : "ETH/USD";
        if (f.symbol === symbol) candidates.push({ forecast: f, side: 1, netLowerBps: 0, score: 1 });
        continue;
      }
      const long = f.lowerGrossBps - hurdleBps, short = -f.upperGrossBps - hurdleBps;
      if (Math.max(long, short) <= 0) { block("NO_POSITIVE_CONSERVATIVE_NET_MEAN"); continue; }
      const side: Direction = long >= short ? 1 : -1, netLowerBps = Math.max(long, short);
      candidates.push({ forecast: f, side, netLowerBps,
        score: netLowerBps / (f.sigmaDay * Math.sqrt(S.forecastHorizonDays) * 10_000) });
    }
    return candidates.sort((a, b) => b.score - a.score || a.forecast.symbol.localeCompare(b.forecast.symbol));
  };
  mark();
  for (let atMs = input.startMs; atMs < input.endMs; atMs += HOUR) {
    const hour = byHour.get(atMs);
    if (!hour || S.symbols.some(symbol => !hour.has(symbol))) throw new Error(`PROFIT_REPLAY_CANDLE_GAP:${atMs}`);
    if (p) mark(hour.get(p.symbol)!.open); else mark();
    lossState(atMs, p ? hour.get(p.symbol)!.open : undefined);
    const date = new Date(atMs), weeklyHour = A.fillHourAfterMondayMidnight[input.scenario];
    if (date.getUTCDay() === 1 && date.getUTCHours() === weeklyHour) {
      weeklyDecisions++;
      const decisionMs = Math.floor(atMs / DAY) * DAY + S.candleFinalizationDelayMs;
      const candidates = candidatesAt(decisionMs), incumbent = p
        ? candidates.find(c => c.forecast.symbol === p!.symbol && c.side === p!.side) : undefined;
      const best = candidates[0];
      target = incumbent && (!best || best.score < incumbent.score * (1 + S.switchImprovementFraction)) ? incumbent : best;
      if (p && (!target || target.forecast.symbol !== p.symbol || target.side !== p.side))
        exitReason = target ? "WEEKLY_SWITCH" : "WEEKLY_FORECAST_INELIGIBLE";
      else if (p && target) p.forecast = target.forecast;
    }
    if (atMs >= input.endMs - A.flattenLeadHours * HOUR) { target = undefined; if (p) exitReason = "WINDOW_FLATTEN"; }
    if (p && exitReason) {
      const bar = hour.get(p.symbol)!;
      if (bar.volume > 0) reduce(p.qty, price(bar.open, -p.side as Direction, p.symbol), atMs, exitReason);
      else block("ZERO_VOLUME_REDUCTION_NO_FILL");
    }
    // Hard cap/risk trims precede entries and never add to existing inventory.
    if (p && !exitReason) {
      const bar = hour.get(p.symbol)!, equity = A.initialEquityUsd + lastTotal;
      const capQty = floorQty(Math.min(S.maximumNotionalUsd, Math.max(0, equity) * S.maximumEquityFraction) / bar.open, p.symbol);
      const lossPerUnit = Math.max(0, p.side * (bar.open - p.stopPx)) + bar.open * hurdleBps / 10_000;
      const riskQty = floorQty(Math.max(0, equity) * S.baseRiskFraction / Math.max(lossPerUnit, Number.EPSILON), p.symbol);
      let desired = Math.min(p.qty, capQty, riskQty);
      if (target && target.forecast.symbol === p.symbol && target.side === p.side) {
        const desiredRiskQty = floorQty(Math.max(0, equity) * S.baseRiskFraction
          / (bar.open * (S.initialStopDailySigma * target.forecast.sigmaDay + hurdleBps / 10_000)), p.symbol);
        if (desiredRiskQty < p.qty * (1 - S.quantityDeadbandFraction)) desired = Math.min(desired, desiredRiskQty);
      }
      const reduceQty = floorQty(p.qty - desired, p.symbol);
      if (reduceQty > 0) {
        if (bar.volume > 0) reduce(reduceQty, price(bar.open, -p.side as Direction, p.symbol), atMs, "CAP_OR_RISK_REDUCTION");
        else block("ZERO_VOLUME_CAP_TRIM_NO_FILL");
        if (!p) { target = undefined; block("RISK_REDUCTION_WAIT_FOR_NEXT_WEEKLY_FORECAST"); }
      }
    }
    if (!p && target && atMs >= entryAfterMs) {
      const f = target.forecast, age = atMs - f.decisionMs;
      if (age < 0 || age > S.maximumSignalAgeMs) { block("FORECAST_EXPIRED"); target = undefined; }
      else if ((stopBlocked.get(f.symbol) ?? -1) >= f.decisionMs) { block("STOP_WAIT_FOR_NEXT_WEEKLY_FORECAST"); target = undefined; }
      else if (!accountingKnown || !risk.entriesAllowed()) { block(`RISK_HALT:${risk.reasons().join(",")}`); target = undefined; }
      else {
        const bar = hour.get(f.symbol)!, px = price(bar.open, target.side, f.symbol);
        const equity = A.initialEquityUsd + cash, cap = Math.min(S.maximumNotionalUsd, equity * S.maximumEquityFraction);
        const stopFraction = S.initialStopDailySigma * f.sigmaDay;
        const riskBudget = Math.max(0, Math.min(equity * S.baseRiskFraction,
          equity * S.rollingLossFraction - currentRollingLoss,
          equity * S.sessionLossFraction - currentSessionLoss,
          equity - peak * (1 - S.maximumDrawdownFraction)));
        const qty = floorQty(Math.min(cap / px, riskBudget / (px * (stopFraction + hurdleBps / 10_000))), f.symbol);
        if (!(qty > 0)) { block("QUANTITY_BELOW_MINIMUM_LOT"); target = undefined; }
        else if (bar.volume <= 0) block("ZERO_VOLUME_ENTRY_NO_FILL");
        else {
          const notional = qty * px, fee = notional * feeBps / 10_000;
          if (notional > cap + 1e-8 || notional * (stopFraction + hurdleBps / 10_000) > riskBudget + 1e-8) riskBreachCount++;
          maxEntryNotional = Math.max(maxEntryNotional, notional); maxRiskBudget = Math.max(maxRiskBudget, riskBudget);
          p = { symbol: f.symbol, side: target.side, qty, entryQty: qty, entryPx: px, entryMs: atMs,
            stopPx: px * (1 - target.side * stopFraction), initialStopFraction: stopFraction, forecast: f, entryForecastId: f.id,
            gross: 0, fee, funding: 0, fundingKnown: true, turnover: notional, reductions: 0 };
          orders.push({ symbol: f.symbol, side: target.side, atMs, qty, price: px, reduceOnly: false,
            reason: policy === "weekly-forecast" ? "POSITIVE_CONSERVATIVE_NET_FORECAST" : "BENCHMARK_LONG_ENTRY",
            forecastId: f.id, feeUsd: fee, grossPnlUsd: 0 });
          const own = asset(f.symbol); own.orders++; own.feeUsd += fee; own.turnoverUsd += notional;
          day(atMs).orders++; addCash(atMs, -fee); block("ENTRY_FILLED_PROXY");
        }
      }
    }
    if (p) {
      const bar = hour.get(p.symbol)!;
      mark(bar.open);
      const side = p.side, exitSide = -side as Direction;
      const openExec = price(bar.open, exitSide, p.symbol), adverse = side === 1 ? bar.low : bar.high;
      const favorable = side === 1 ? bar.high : bar.low;
      const stopHit = side * (price(adverse, exitSide, p.symbol) - p.stopPx) <= 0;
      if (bar.volume > 0 && stopHit) {
        const gap = side * (openExec - p.stopPx) <= 0;
        if (!gap) mark(favorable, accruedFunding(p, atMs, HOUR / 3));
        const exitMs = gap ? atMs : atMs + 2 * HOUR / 3;
        const exitPx = gap ? openExec : price(p.stopPx, exitSide, p.symbol);
        fund(p, atMs, exitMs - atMs);
        stopBlocked.set(p.symbol, p.forecast.decisionMs);
        reduce(p.qty, exitPx, exitMs, "HARD_STOP_4_DAILY_SIGMA"); target = undefined;
        mark(); lossState(exitMs);
      } else {
        if (bar.volume === 0) { zeroVolumeHeldHours++; block("ZERO_VOLUME_HELD_NO_EXECUTION"); }
        mark(favorable, accruedFunding(p, atMs, HOUR / 3));
        mark(adverse, accruedFunding(p, atMs, 2 * HOUR / 3));
        mark(bar.close, accruedFunding(p, atMs, HOUR));
        fund(p, atMs, HOUR); mark(bar.close); lossState(atMs + HOUR, bar.close);
      }
    } else mark();
    if ((atMs + HOUR) % DAY === 0) { day(atMs).netPnlUsd = lastTotal - previousDailyPnl; previousDailyPnl = lastTotal; }
  }
  for (const own of perAsset) {
    own.fundingCashUsd = own.missingFundingHours ? null : own.knownFundingCashUsd;
    own.netPnlUsd = own.fundingCashUsd === null || p?.symbol === own.symbol
      ? null : own.grossPnlUsd - own.feeUsd + own.fundingCashUsd;
  }
  if (!accountingKnown) for (const row of daily) row.netPnlUsd = null;
  const gross = perAsset.reduce((sum, a) => sum + a.grossPnlUsd, 0);
  const fee = perAsset.reduce((sum, a) => sum + a.feeUsd, 0);
  const knownFunding = perAsset.reduce((sum, a) => sum + a.knownFundingCashUsd, 0);
  return {
    version: S.version, policy, benchmarkOnly: policy !== "weekly-forecast",
    scenario: input.scenario, fundingAssumption: input.fundingAssumption,
    startMs: input.startMs, endMs: input.endMs, evidenceKind: A.evidenceKind,
    accountingKnown: accountingKnown && !p, fundingTimestampVerified: false, synthetic: false,
    completedTrades: trades.length, orderCount: orders.length, grossPnlUsd: gross, feeUsd: fee,
    fundingCashUsd: accountingKnown ? knownFunding : null, knownFundingCashUsd: knownFunding,
    netPnlUsd: accountingKnown && !p ? cash : null, markedNetPnlUsd: accountingKnown ? lastTotal : null,
    netReturnOnInitialEquity: accountingKnown && !p ? cash / A.initialEquityUsd : null,
    maxDrawdownUsd: accountingKnown ? maxDrawdown : null, knownMarkedMaxDrawdownProxyUsd: maxDrawdown,
    maxDrawdownFraction: accountingKnown ? maxDrawdownFraction : null,
    maximumEntryNotionalUsd: maxEntryNotional, maximumMarkedNotionalUsd: maxMarkedNotional,
    maximumRiskBudgetUsd: maxRiskBudget, riskBreachCount, riskHaltReasons: risk.reasons(),
    fundingRequiredHours, fundingObservedHours, missingFundingHours, zeroVolumeHeldHours, weeklyDecisions,
    turnoverUsd: perAsset.reduce((sum, a) => sum + a.turnoverUsd, 0),
    exposureNotionalHours: perAsset.reduce((sum, a) => sum + a.exposureNotionalHours, 0),
    hurdleBps, trades, orders, perAsset, dailyNetPnlUsd: daily, blockReasons: reasons,
    unresolvedPosition: p ? { symbol: p.symbol, side: p.side, qty: p.qty, entryPx: p.entryPx,
      entryMs: p.entryMs, exitReason: exitReason ?? "OPEN_AT_WINDOW_END" } : null,
    flatBenchmark: { completedTrades: 0, netPnlUsd: 0, maxDrawdownUsd: 0 }, limitations: A.limitations,
  };
}
