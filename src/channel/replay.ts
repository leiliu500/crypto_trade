import type { FundingRow, HourlyBar, HourlySymbol } from "../research/hourly-data.js";
import { CHANNEL_SPEC as S, CHANNEL_PRICE_PROTECTED_SPEC as P } from "./spec.js";
import { CHANNEL_HOLDOUT_SPEC as HOLDOUT } from "./holdout-spec.js";

export interface ChannelDailyBar { symbol: HourlySymbol; openMs: number; endMs: number;
  open: number; high: number; low: number; close: number; volume: number; atr: number | null }
export interface ChannelSignal { symbol: HourlySymbol; endMs: number; close: number; atr: number;
  entrySide: 1 | -1 | null; longExit: boolean; shortExit: boolean }
export function channelDailyBars(bars: readonly HourlyBar[]): ChannelDailyBar[] {
  const result: ChannelDailyBar[] = [];
  for (const symbol of S.symbols) {
    const rows = bars.filter(b => b.symbol === symbol).sort((a, b) => a.openMs - b.openMs);
    let group: HourlyBar[] = [], priorEnd = -Infinity, previousClose: number | null = null;
    let atr: number | null = null, ranges: number[] = [];
    const finish = () => {
      if (group.length !== 24 || group[0]!.openMs % S.dayMs !== 0
        || group.some((b, i) => b.openMs !== group[0]!.openMs + i * S.hourMs)) return;
      const first = group[0]!, last = group.at(-1)!, high = Math.max(...group.map(b => b.high)), low = Math.min(...group.map(b => b.low));
      if (first.openMs !== priorEnd) { atr = null; ranges = []; previousClose = null; }
      const tr = Math.max(high - low, previousClose === null ? 0 : Math.abs(high - previousClose), previousClose === null ? 0 : Math.abs(low - previousClose));
      if (atr === null) { ranges.push(tr); if (ranges.length === S.atrDays) atr = ranges.reduce((a, b) => a + b, 0) / S.atrDays; }
      else atr = ((S.atrDays - 1) * atr + tr) / S.atrDays;
      result.push({ symbol, openMs: first.openMs, endMs: first.openMs + S.dayMs, open: first.open,
        high, low, close: last.close, volume: group.reduce((a, b) => a + b.volume, 0), atr });
      priorEnd = first.openMs + S.dayMs; previousClose = last.close;
    };
    for (const bar of rows) {
      if (group.length && Math.floor(group[0]!.openMs / S.dayMs) !== Math.floor(bar.openMs / S.dayMs)) { finish(); group = []; }
      group.push(bar);
    }
    finish();
  }
  return result.sort((a, b) => a.endMs - b.endMs || a.symbol.localeCompare(b.symbol));
}
export function channelSignals(days: readonly ChannelDailyBar[]): ChannelSignal[] {
  const result: ChannelSignal[] = [];
  for (const symbol of S.symbols) {
    const rows = days.filter(d => d.symbol === symbol);
    for (let i = S.entryLookbackDays; i < rows.length; i++) {
      const day = rows[i]!, prior = rows.slice(i - S.entryLookbackDays, i);
      if (day.atr === null || day.atr <= 0 || day.volume <= 0 || prior.some((d, n) => d.endMs !== day.openMs - (prior.length - 1 - n) * S.dayMs)) continue;
      const high = Math.max(...prior.map(d => d.high)), low = Math.min(...prior.map(d => d.low));
      const exits = prior.slice(-S.exitLookbackDays);
      result.push({ symbol, endMs: day.endMs, close: day.close, atr: day.atr,
        entrySide: day.close > high ? 1 : day.close < low ? -1 : null,
        longExit: day.close < Math.min(...exits.map(d => d.low)), shortExit: day.close > Math.max(...exits.map(d => d.high)) });
    }
  }
  return result.sort((a, b) => a.endMs - b.endMs || a.symbol.localeCompare(b.symbol));
}
export interface ChannelOrder { atMs: number; symbol: HourlySymbol; side: 1 | -1; qty: number;
  price: number; feeUsd: number; grossPnlUsd: number; reduceOnly: boolean; reason: string;
  entryProtection?: ChannelEntryProtection }
export interface ChannelEntryProtection { signalEndMs: number; signalClose: number; signalAtr: number;
  fixedStopPx: number; actualEntryStopDistance: number; entryDisplacementAtr: number }
export interface ChannelEpisode { symbol: HourlySymbol; side: 1 | -1; entryMs: number; exitMs: number;
  entryQty: number; entryPx: number; reason: string; reductions: number;
  grossPnlUsd: number; feeUsd: number; fundingCashUsd: number; netPnlUsd: number;
  entryProtection?: ChannelEntryProtection }
interface Position { symbol: HourlySymbol; side: 1 | -1; qty: number; entryQty: number; entryPx: number;
  entryMs: number; stopPx: number; signalEndMs: number; gross: number; fees: number; funding: number; reductions: number;
  entryProtection?: ChannelEntryProtection }
export interface ChannelReplayInput { bars: readonly HourlyBar[]; funding: readonly FundingRow[];
  startMs: number; endMs: number; scenario: "base" | "stress";
  policy?: "channel" | "buy-hold-btc" | "buy-hold-eth" }
export function evaluatePriceProtectedChannelEntry(signal: ChannelSignal, fillPx: number):
  { eligible: true; protection: ChannelEntryProtection } | { eligible: false; reason: string } {
  if (!S.symbols.includes(signal.symbol) || ![1, -1].includes(signal.entrySide ?? 0)
    || ![signal.close, signal.atr, fillPx].every(v => Number.isFinite(v) && v > 0))
    return { eligible: false, reason: "ENTRY_INVALID_SIGNAL_PROTECTION" };
  const side = signal.entrySide!, fixedStopPx = signal.close - side * S.stopAtr * signal.atr;
  const actualEntryStopDistance = side * (fillPx - fixedStopPx), entryDisplacementAtr = Math.abs(fillPx - signal.close) / signal.atr;
  if (entryDisplacementAtr > P.maximumEntryDisplacementAtr + 1e-12)
    return { eligible: false, reason: "ENTRY_PRICE_DISPLACEMENT" };
  if (fixedStopPx <= 0 || actualEntryStopDistance < S.ticks[signal.symbol] - 1e-12)
    return { eligible: false, reason: "ENTRY_INVALID_FIXED_SIGNAL_STOP" };
  return { eligible: true, protection: { signalEndMs: signal.endMs, signalClose: signal.close,
    signalAtr: signal.atr, fixedStopPx, actualEntryStopDistance, entryDisplacementAtr } };
}
export function replayChannel(input: ChannelReplayInput) { return replayKernel(input, false); }
export function replayPriceProtectedChannel(input: ChannelReplayInput) { return replayKernel(input, true); }
/** Explicit one-window entrypoint. Default research APIs retain their 2025 cap. */
export function replayPriceProtectedChannelHoldout(input: ChannelReplayInput) {
  if (input.startMs !== HOLDOUT.startMs || input.endMs !== HOLDOUT.endMs) throw new Error("CHANNEL_HOLDOUT_EXACT_WINDOW_REQUIRED");
  const bars = input.bars.filter(b => b.openMs >= HOLDOUT.warmupStartMs && b.openMs < HOLDOUT.endMs);
  for (const symbol of S.symbols) {
    const warmupTimes = new Set(bars.filter(b => b.symbol === symbol && b.openMs < HOLDOUT.startMs).map(b => b.openMs));
    for (let t = HOLDOUT.startMs - HOLDOUT.minimumCompleteWarmupDays * S.dayMs; t < HOLDOUT.startMs; t += S.hourMs)
      if (!warmupTimes.has(t)) throw new Error("CHANNEL_HOLDOUT_INCOMPLETE_WARMUP");
  }
  return { ...replayKernel({ ...input, bars }, true, true), holdoutScopeVersion: HOLDOUT.version, warmupStartMs: HOLDOUT.warmupStartMs };
}
function replayKernel(input: ChannelReplayInput, priceProtected: boolean, fixedHoldout = false) {
  const { startMs, endMs, scenario } = input, policy = input.policy ?? "channel", H = S.hourMs, D = S.dayMs;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs % D || endMs % D || endMs <= startMs
    || (fixedHoldout ? startMs !== HOLDOUT.startMs || endMs !== HOLDOUT.endMs : endMs > Date.UTC(2025, 6, 1))
    || !["base", "stress"].includes(scenario)
    || !["channel", "buy-hold-btc", "buy-hold-eth"].includes(policy)) throw new Error("INVALID_CHANNEL_REPLAY_WINDOW");
  const bars = input.bars.filter(b => b.openMs < endMs), lookup = new Map<string, HourlyBar>();
  for (const b of bars) {
    if (!S.symbols.includes(b.symbol) || !Number.isSafeInteger(b.openMs) || b.openMs % H
      || ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite)
      || Math.min(b.open, b.high, b.low, b.close) <= 0 || b.volume < 0
      || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close)) throw new Error("INVALID_CHANNEL_BAR");
    const key = `${b.symbol}:${b.openMs}`;
    if (lookup.has(key)) throw new Error("DUPLICATE_CHANNEL_BAR"); lookup.set(key, b);
  }
  const funding = new Map<string, number>();
  for (const row of input.funding) {
    if (row.timestampMs <= startMs || row.timestampMs > endMs) continue;
    if (!S.symbols.includes(row.symbol) || !Number.isSafeInteger(row.timestampMs) || row.timestampMs % H || !Number.isFinite(row.absoluteRate))
      throw new Error("INVALID_CHANNEL_FUNDING");
    const key = `${row.symbol}:${row.timestampMs - H}`;
    if (funding.has(key)) throw new Error("DUPLICATE_CHANNEL_FUNDING"); funding.set(key, row.absoluteRate!);
  }
  const signals = channelSignals(channelDailyBars(bars)), bySignalTime = new Map<number, ChannelSignal[]>();
  for (const signal of signals) {
    const t = signal.endMs + S.executionDelayHoursAfterDayClose[scenario] * H;
    if (t < startMs || t >= endMs) continue;
    const group = bySignalTime.get(t) ?? []; group.push(signal); bySignalTime.set(t, group);
  }
  const feeRate = S.feesBps[scenario] / 10000, slip = S.adverseSlippageBps[scenario] / 10000;
  const price = (reference: number, side: 1 | -1, symbol: HourlySymbol) => {
    const tick = S.ticks[symbol], raw = reference * (1 + side * slip);
    return Number(((side === 1 ? Math.ceil(raw / tick - 1e-10) : Math.floor(raw / tick + 1e-10)) * tick).toPrecision(15));
  };
  const floorQty = (q: number, symbol: HourlySymbol) => Number((Math.floor(q / S.lots[symbol] + 1e-10) * S.lots[symbol]).toPrecision(15));
  const positions = new Map<HourlySymbol, Position>(), pending = new Map<HourlySymbol, ChannelSignal>();
  const exitRequested = new Map<HourlySymbol, string>(), lastStopMs = new Map<HourlySymbol, number>();
  const orders: ChannelOrder[] = [], episodes: ChannelEpisode[] = [], missingFunding: string[] = [], missingBars: string[] = [];
  const hourly: Array<{ atMs: number; cashEquityUsd: number; markedEquityUsd: number; grossNotionalUsd: number }> = [];
  const dailyNet: Array<{ dayStartMs: number; netPnlUsd: number }> = [], haltReasons: Record<string, number> = {};
  let cash: number = S.initialEquityUsd, peak: number = cash, maximumDrawdownUsd = 0, maximumConservativeDrawdownUsd = 0;
  let maximumGrossUsd = 0, maximumEntryRiskUsd = 0, known = true, permanentHalt = false;
  let sessionDay = startMs, sessionEquity: number = cash, priorDayEquity: number = cash, priorCloseEquity: number = cash;
  const marks = new Map<HourlySymbol, number>(), equityAt = new Map<number, number>([[startMs, cash]]);
  const halt = (reason: string) => { haltReasons[reason] = (haltReasons[reason] ?? 0) + 1; };
  const value = (mark: (p: Position) => number) => cash + [...positions.values()].reduce((n, p) => n + p.side * p.qty * (mark(p) - p.entryPx), 0);
  const markEquity = () => value(p => marks.get(p.symbol) ?? p.entryPx);
  const close = (p: Position, qty: number, reference: number, atMs: number, reason: string) => {
    const px = price(reference, p.side === 1 ? -1 : 1, p.symbol), fee = qty * px * feeRate, gross = p.side * qty * (px - p.entryPx);
    cash += gross - fee; p.gross += gross; p.fees += fee;
    orders.push({ atMs, symbol: p.symbol, side: p.side === 1 ? -1 : 1, qty, price: px, feeUsd: fee, grossPnlUsd: gross, reduceOnly: true, reason });
    p.qty = Number((p.qty - qty).toPrecision(15));
    if (p.qty <= S.lots[p.symbol] * 1e-6) {
      episodes.push({ symbol: p.symbol, side: p.side, entryMs: p.entryMs, exitMs: atMs, entryQty: p.entryQty,
        entryPx: p.entryPx, reason, reductions: p.reductions, grossPnlUsd: p.gross, feeUsd: p.fees,
        fundingCashUsd: p.funding, netPnlUsd: p.gross - p.fees + p.funding,
        ...(p.entryProtection ? { entryProtection: p.entryProtection } : {}) });
      positions.delete(p.symbol); exitRequested.delete(p.symbol);
    } else p.reductions++;
  };
  const fund = (p: Position, t: number, fraction: number, adverseOnly: boolean) => {
    if (fraction <= 0) return;
    const rate = funding.get(`${p.symbol}:${t}`);
    if (rate === undefined) { known = false; permanentHalt = true; missingFunding.push(`${p.symbol}:${t}`); return; }
    const amount = -p.side * p.qty * rate * fraction, applied = adverseOnly ? Math.min(0, amount) : amount;
    cash += applied; p.funding += applied;
  };
  for (let t = startMs; t < endMs; t += H) {
    if (Math.floor(t / D) * D !== sessionDay) { sessionDay = Math.floor(t / D) * D; sessionEquity = priorCloseEquity; }
    const current = new Map(S.symbols.flatMap(symbol => { const b = lookup.get(`${symbol}:${t}`); return b ? [[symbol, b] as const] : []; }));
    for (const [symbol, b] of current) marks.set(symbol, b.open);
    for (const p of positions.values()) if (!current.has(p.symbol)) {
      known = false; permanentHalt = true; missingBars.push(`${p.symbol}:${t}`); exitRequested.set(p.symbol, "MISSING_HELD_BAR");
    }
    if (t >= endMs - S.finalFlattenLeadHours * H) for (const p of positions.values()) exitRequested.set(p.symbol, "TERMINAL_FLATTEN");
    for (const s of bySignalTime.get(t) ?? []) {
      pending.delete(s.symbol); const p = positions.get(s.symbol);
      if (p && policy === "channel") {
        if (p.side === 1 ? s.longExit : s.shortExit) exitRequested.set(s.symbol, "OPPOSITE_20_DAY_CHANNEL");
        const proposed = s.close - p.side * S.stopAtr * s.atr;
        p.stopPx = p.side === 1 ? Math.max(p.stopPx, proposed) : Math.min(p.stopPx, proposed);
      } else if (policy === "channel" && s.entrySide !== null && s.endMs > (lastStopMs.get(s.symbol) ?? -Infinity)) pending.set(s.symbol, s);
    }
    // Opening gaps cross a resting protective stop before scheduled channel exits.
    for (const p of [...positions.values()]) {
      const b = current.get(p.symbol); if (!b || b.volume <= 0) continue;
      if (policy === "channel" && p.side * (b.open - p.stopPx) <= 0) {
        close(p, p.qty, b.open, t, "PROTECTIVE_OPEN_GAP"); lastStopMs.set(p.symbol, t); pending.delete(p.symbol);
      } else if (exitRequested.has(p.symbol)) close(p, p.qty, b.open, t, exitRequested.get(p.symbol)!);
    }
    let eq = markEquity();
    if (policy === "channel") for (const p of [...positions.values()]) {
      const b = current.get(p.symbol); if (!b || b.volume <= 0) continue;
      const target = floorQty(Math.min(S.maximumLegNotionalUsd, Math.max(0, eq) * S.maximumLegEquityFraction) / b.open, p.symbol);
      if (p.qty > target) close(p, Number((p.qty - target).toPrecision(15)), b.open, t, "CURRENT_NOTIONAL_CAP_REDUCTION");
    }
    eq = markEquity();
    const rollingReference = equityAt.get(t - D) ?? S.initialEquityUsd;
    let entryHalt = permanentHalt || eq <= sessionEquity * (1 - S.sessionLossFraction)
      || eq <= rollingReference * (1 - S.rolling24HourLossFraction) || eq <= peak * (1 - S.maximumAccountDrawdownFraction);
    if (entryHalt) halt(permanentHalt ? "PERMANENT_ACCOUNT_UNKNOWN_OR_DRAWDOWN" : "SESSION_OR_ROLLING_LOSS");
    const baselineSymbol = policy === "buy-hold-btc" ? "BTC/USD" : "ETH/USD";
    if (policy !== "channel" && !orders.length && t >= startMs + S.executionDelayHoursAfterDayClose[scenario] * H)
      pending.set(baselineSymbol, { symbol: baselineSymbol, endMs: startMs, close: current.get(baselineSymbol)?.open ?? 0, atr: 1, entrySide: 1, longExit: false, shortExit: false });
    for (const symbol of S.symbols) {
      const s = pending.get(symbol), b = current.get(symbol);
      if (!s || positions.has(symbol)) continue;
      if (t >= s.endMs + D || t >= endMs - S.noNewEntryLeadHours * H || entryHalt) { pending.delete(symbol); continue; }
      if (!b || b.volume <= 0) { halt("ENTRY_NO_POSITIVE_VOLUME_BAR"); continue; }
      if (!funding.has(`${symbol}:${t}`)) { halt("ENTRY_MISSING_CURRENT_FUNDING"); continue; }
      const side = s.entrySide!, px = price(b.open, side, symbol);
      const protectionResult = priceProtected && policy === "channel" ? evaluatePriceProtectedChannelEntry(s, px) : null;
      if (protectionResult && !protectionResult.eligible) { halt(protectionResult.reason); pending.delete(symbol); continue; }
      const entryProtection = protectionResult?.eligible ? protectionResult.protection : undefined;
      const stopDistance = entryProtection?.actualEntryStopDistance ?? S.stopAtr * s.atr;
      const equity = markEquity(), cap = Math.min(S.maximumLegNotionalUsd, equity * S.maximumLegEquityFraction);
      const existingRisk = [...positions.values()].reduce((n, p) => {
        const mark = marks.get(p.symbol) ?? p.entryPx;
        return n + p.qty * (Math.max(0, p.side * (mark - p.stopPx)) + mark * 2 * (feeRate + slip));
      }, 0);
      const unitRisk = stopDistance + px * 2 * (feeRate + slip);
      const gross = [...positions.values()].reduce((n, p) => n + p.qty * (marks.get(p.symbol) ?? p.entryPx), 0);
      const lossHeadroom = Math.max(0, Math.min(equity - sessionEquity * (1 - S.sessionLossFraction),
        equity - rollingReference * (1 - S.rolling24HourLossFraction), equity - peak * (1 - S.maximumAccountDrawdownFraction)) - existingRisk);
      const qty = floorQty(Math.min(cap / px, policy === "channel" ? Math.max(0, S.maximumGrossUsd - gross) / px : Infinity,
        policy === "channel" ? equity * S.riskFractionPerAsset / unitRisk : Infinity,
        policy === "channel" ? Math.max(0, equity * S.maximumClusterRiskFraction - existingRisk) / unitRisk : Infinity,
        policy === "channel" ? lossHeadroom / unitRisk : Infinity), symbol);
      pending.delete(symbol);
      if (qty < S.lots[symbol] || px - side * stopDistance <= 0) { halt("ENTRY_SIZE_BELOW_MINIMUM"); continue; }
      const fee = qty * px * feeRate; cash -= fee;
      positions.set(symbol, { symbol, side, qty, entryQty: qty, entryPx: px, entryMs: t,
        stopPx: entryProtection?.fixedStopPx ?? px - side * stopDistance,
        signalEndMs: s.endMs, gross: 0, fees: fee, funding: 0, reductions: 0,
        ...(entryProtection ? { entryProtection } : {}) });
      maximumEntryRiskUsd = Math.max(maximumEntryRiskUsd, existingRisk + qty * unitRisk);
      orders.push({ atMs: t, symbol, side, qty, price: px, feeUsd: fee, grossPnlUsd: 0, reduceOnly: false,
        reason: policy === "channel" ? "55_DAY_BREAKOUT" : "DESCRIPTIVE_BUY_HOLD", ...(entryProtection ? { entryProtection } : {}) });
    }
    // Unknown intrahour event time uses the adverse funding bound for touched stops.
    for (const p of [...positions.values()]) {
      const b = current.get(p.symbol);
      if (!b) { fund(p, t, 1, false); continue; }
      const touched = policy === "channel" && (p.side === 1 ? b.low <= p.stopPx : b.high >= p.stopPx);
      if (touched && b.volume > 0) {
        fund(p, t, 1, true); close(p, p.qty, p.stopPx, t + H, "PROTECTIVE_INTRAHOUR_TOUCH");
        lastStopMs.set(p.symbol, t + H); pending.delete(p.symbol);
      } else fund(p, t, 1, false);
    }
    const worstEquity = value(p => { const b = current.get(p.symbol); return b ? (p.side === 1 ? b.low : b.high) : marks.get(p.symbol) ?? p.entryPx; });
    maximumConservativeDrawdownUsd = Math.max(maximumConservativeDrawdownUsd, peak - worstEquity);
    const riskLoss = policy === "channel" && (worstEquity <= peak * (1 - S.maximumAccountDrawdownFraction)
      || worstEquity <= sessionEquity * (1 - S.sessionLossFraction) || worstEquity <= rollingReference * (1 - S.rolling24HourLossFraction));
    if (riskLoss) {
      const drawdown = worstEquity <= peak * (1 - S.maximumAccountDrawdownFraction);
      if (drawdown) permanentHalt = true; halt(drawdown ? "ACCOUNT_DRAWDOWN_ENVELOPE" : "SESSION_OR_ROLLING_LOSS_ENVELOPE");
      for (const p of [...positions.values()]) { const b = current.get(p.symbol);
        if (b && b.volume > 0) close(p, p.qty, p.side === 1 ? b.low : b.high, t + H, "ACCOUNT_RISK_FLATTEN");
        else exitRequested.set(p.symbol, "ACCOUNT_RISK_FLATTEN"); }
      pending.clear();
    }
    for (const [symbol, b] of current) marks.set(symbol, b.close);
    const endEquity = markEquity(), liquidationEquity = value(p => price(marks.get(p.symbol) ?? p.entryPx, p.side === 1 ? -1 : 1, p.symbol))
      - [...positions.values()].reduce((n, p) => n + p.qty * price(marks.get(p.symbol) ?? p.entryPx, p.side === 1 ? -1 : 1, p.symbol) * feeRate, 0);
    peak = Math.max(peak, liquidationEquity); maximumDrawdownUsd = Math.max(maximumDrawdownUsd, peak - liquidationEquity);
    maximumConservativeDrawdownUsd = Math.max(maximumConservativeDrawdownUsd, maximumDrawdownUsd);
    const gross = [...positions.values()].reduce((n, p) => n + p.qty * (marks.get(p.symbol) ?? p.entryPx), 0);
    maximumGrossUsd = Math.max(maximumGrossUsd, gross);
    hourly.push({ atMs: t + H, cashEquityUsd: cash, markedEquityUsd: endEquity, grossNotionalUsd: gross });
    equityAt.set(t + H, endEquity); priorCloseEquity = endEquity;
    if ((t + H) % D === 0) { dailyNet.push({ dayStartMs: t + H - D, netPnlUsd: endEquity - priorDayEquity }); priorDayEquity = endEquity; }
  }
  const unresolved = [...positions.values()].map(p => ({ symbol: p.symbol, side: p.side, qty: p.qty, entryMs: p.entryMs }));
  known &&= unresolved.length === 0;
  const feeUsd = orders.reduce((n, o) => n + o.feeUsd, 0), grossPnlUsd = orders.reduce((n, o) => n + o.grossPnlUsd, 0);
  const fundingCashUsd = episodes.reduce((n, e) => n + e.fundingCashUsd, 0) + [...positions.values()].reduce((n, p) => n + p.funding, 0);
  const netPnlUsd = known ? cash - S.initialEquityUsd : null;
  if (known && Math.abs(cash - S.initialEquityUsd - (grossPnlUsd - feeUsd + fundingCashUsd)) > 1e-6) throw new Error("CHANNEL_LEDGER_DOES_NOT_RECONCILE");
  return { version: priceProtected ? P.version : S.version, startMs, endMs, scenario, policy, accountingKnown: known, netPnlUsd,
    grossPnlUsd, feeUsd, fundingCashUsd: known ? fundingCashUsd : null,
    maxDrawdownUsd: known ? maximumDrawdownUsd : null, conservativeDrawdownEnvelopeUsd: known ? maximumConservativeDrawdownUsd : null,
    drawdownBasis: "HOURLY_LIQUIDATION_CLOSE_DRAWDOWN;ENVELOPE_USES_PRIOR_CLOSE_PEAK_NOT_FULL_INTRAHOUR_HIGHWATER",
    maximumGrossUsd, maximumEntryRiskUsd, closedEpisodes: episodes.length, orderCount: orders.length,
    unresolved, missingFunding, missingBars, haltReasons, orders, episodes, dailyNetPnlUsd: dailyNet, hourly,
    runtimeActivated: false, evidence: "HOURLY_CANDLE_ECONOMIC_PROXY_WITH_CONSERVATIVE_STOP_FUNDING" };
}
