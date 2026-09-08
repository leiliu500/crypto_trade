import type { HourlyBar, FundingRow } from "./hourly-data.js";
export type { HourlyBar, FundingRow } from "./hourly-data.js";

export const HOURLY_MS = 3_600_000;
const DAY_MS = 24 * HOURLY_MS;
const SYMBOLS = ["BTC/USD", "ETH/USD"] as const;
type Symbol = (typeof SYMBOLS)[number];
export interface HourlyForecast {
  symbol: Symbol; decisionMs: number; predictedGrossBps: number; horizonHours: number;
  expectedFundingCostBps?: number;
}
export interface HourlyExecutionScenario {
  id: string; delayHours: number; feeBpsPerSide: number; slippageBpsPerSide: number;
  extraAdverseFundingBpsPer24h: number;
}
export const HOURLY_SCENARIOS = Object.freeze({
  base: Object.freeze({ id: "base", delayHours: 1, feeBpsPerSide: 5, slippageBpsPerSide: 1.5, extraAdverseFundingBpsPer24h: 0 }),
  stress: Object.freeze({ id: "stress", delayHours: 2, feeBpsPerSide: 7.5, slippageBpsPerSide: 3, extraAdverseFundingBpsPer24h: 1 }),
});
export interface HourlySimulationInput {
  bars: readonly HourlyBar[]; funding: readonly FundingRow[]; forecasts: readonly HourlyForecast[];
  startMs: number; endMs: number; scenario?: HourlyExecutionScenario;
  minimumExpectedNetBps?: number; forecastsPrequalified?: boolean; initialEquityUsd?: number;
  adverseFundingBpsPerHour?: Readonly<Record<Symbol,number>>;
}
export interface HourlySimulationTrade {
  id: string; symbol: Symbol; side: 1 | -1; decisionMs: number; expectedNetBps: number;
  predictedGrossBps: number; horizonHours: number; scheduledEntryMs: number; scheduledExitMs: number;
  status: "PENDING" | "OPEN" | "COMPLETE" | "UNFILLED" | "INVALID";
  entryMs: number | null; exitMs: number | null; qty: number | null;
  entryReferencePx: number | null; entryPx: number | null; exitReferencePx: number | null; exitPx: number | null;
  grossPnlUsd: number | null; netPnlUsd: number | null;
  feesUsd: number; slippageUsd: number; fundingUsd: number; fundingReserveUsd: number;
  invalidReasons: Array<{ atMs: number; reason: string }>;
}
export interface HourlyEquityPoint {
  atMs: number; equityUsd: number | null; liquidationEquityUsd: number | null; grossEquityUsd: number | null;
  positionSymbol: Symbol | null;
}
const time = (n: number) => Number.isSafeInteger(n) && n >= 0 && n % HOURLY_MS === 0;
const key = (symbol: string, atMs: number) => `${symbol}:${atMs}`;
const nonnegative = (n: number) => Number.isFinite(n) && n >= 0;
const validSymbol = (symbol: string): symbol is Symbol => (SYMBOLS as readonly string[]).includes(symbol);

/** Small-notional candle research, with one portfolio slot shared by both assets.
 * Funding timestamps must denote the END of the funded hour. Entry at t pays
 * settlements t+1h through the clock exit, inclusive. This simulator does not
 * resolve an archive's timestamp convention or establish live fillability. */
export function simulateHourlyAccount(input: HourlySimulationInput) {
  const scenario = input.scenario ?? HOURLY_SCENARIOS.base;
  const initialEquityUsd = input.initialEquityUsd ?? 100_000;
  const minimumExpectedNetBps = input.minimumExpectedNetBps ?? 5;
  const accountingMode = input.adverseFundingBpsPerHour === undefined
    ? "HISTORICAL_FUNDING" : "ADVERSE_TRAINING_RESERVE_SCENARIO";
  if (!time(input.startMs) || !time(input.endMs) || input.endMs <= input.startMs
    || (input.endMs - input.startMs) / HOURLY_MS > 200_000
    || !Number.isFinite(initialEquityUsd) || initialEquityUsd < 12
    || !Number.isFinite(minimumExpectedNetBps)
    || !scenario.id || !Number.isSafeInteger(scenario.delayHours) || scenario.delayHours < 1
    || ![scenario.feeBpsPerSide, scenario.slippageBpsPerSide, scenario.extraAdverseFundingBpsPer24h].every(nonnegative)
    || scenario.slippageBpsPerSide >= 10_000
    || (input.adverseFundingBpsPerHour !== undefined && SYMBOLS.some(s=>!nonnegative(input.adverseFundingBpsPerHour![s]))))
    throw new Error("HOURLY_SIMULATION_CONFIG");
  const bars = new Map<string, HourlyBar>(), funding = new Map<string, FundingRow>();
  for (const b of input.bars) {
    if (!validSymbol(b.symbol) || !time(b.openMs) || ![b.open,b.high,b.low,b.close].every(n => Number.isFinite(n) && n > 0)
      || !nonnegative(b.volume) || b.low > Math.min(b.open,b.close) || b.high < Math.max(b.open,b.close)
      || b.high < b.low || bars.has(key(b.symbol,b.openMs))) throw new Error("HOURLY_SIMULATION_BAR");
    bars.set(key(b.symbol,b.openMs), b);
  }
  for (const f of input.funding) {
    if (!validSymbol(f.symbol) || !time(f.timestampMs) || !Number.isFinite(f.rate)
      || (f.absoluteRate !== undefined && !Number.isFinite(f.absoluteRate))
      || funding.has(key(f.symbol,f.timestampMs))) throw new Error("HOURLY_SIMULATION_FUNDING");
    funding.set(key(f.symbol,f.timestampMs), f);
  }
  const forecasts = new Map<number, HourlyForecast[]>(), seenForecasts = new Set<string>();
  for (const f of input.forecasts) {
    if (!validSymbol(f.symbol) || !time(f.decisionMs) || !Number.isFinite(f.predictedGrossBps)
      || !Number.isSafeInteger(f.horizonHours) || f.horizonHours < 1 || f.horizonHours > 200_000
      || !nonnegative(f.expectedFundingCostBps ?? 0) || seenForecasts.has(key(f.symbol,f.decisionMs)))
      throw new Error("HOURLY_SIMULATION_FORECAST");
    seenForecasts.add(key(f.symbol,f.decisionMs));
    if (f.decisionMs < input.startMs || f.decisionMs >= input.endMs) continue;
    const rows = forecasts.get(f.decisionMs) ?? []; rows.push(f); forecasts.set(f.decisionMs, rows);
  }
  const trades: HourlySimulationTrade[] = [], equity: HourlyEquityPoint[] = [];
  const skips = { busyForecasts: 0, belowHurdleForecasts: 0, endpointForecasts: 0, zeroDirectionForecasts: 0 };
  const settlements: Array<{ tradeId: string; symbol: Symbol; atMs: number; rate: number | null; absoluteRate: number | null;
    fundingUsd: number; reserveUsd: number; source: "ABSOLUTE_RATE" | "RELATIVE_RATE_MARK" | "ADVERSE_TRAINING_RESERVE" }> = [];
  const staleMarks = new Set<string>();
  let pending: HourlySimulationTrade | null = null;
  const portfolio: { position: HourlySimulationTrade | null } = { position: null };
  let allSelectedPathsKnown = true, cashChange = 0, realizedGross = 0;
  let turnoverUsd = 0, totalFeesUsd = 0, totalSlippageUsd = 0, totalFundingUsd = 0, totalFundingReserveUsd = 0;
  let positionHours = 0, unknownPositionHours = 0;
  let peak = initialEquityUsd, liquidationPeak = initialEquityUsd;
  let knownMaximumDrawdownUsd = 0, knownMaximumLiquidationDrawdownUsd = 0, knownMaximumDrawdownFraction = 0;
  const invalidate = (trade: HourlySimulationTrade, atMs: number, reason: string) => {
    if (!trade.invalidReasons.some(r => r.atMs === atMs && r.reason === reason)) trade.invalidReasons.push({ atMs, reason });
    allSelectedPathsKnown = false;
  };
  const executable = (trade: HourlySimulationTrade, atMs: number, purpose: "ENTRY" | "EXIT" | "MARK") => {
    const b = bars.get(key(trade.symbol,atMs));
    if (!b || (b.volume === 0 && purpose !== "MARK")) {
      invalidate(trade,atMs,`${b ? "ZERO_VOLUME" : "MISSING"}_${purpose}_BAR`); return null;
    }
    if (b.volume === 0) staleMarks.add(`${trade.id}:${atMs}`);
    return b;
  };
  const feeRate = scenario.feeBpsPerSide / 10_000, slipRate = scenario.slippageBpsPerSide / 10_000;
  for (let atMs = input.startMs; atMs <= input.endMs; atMs += HOURLY_MS) {
    if (portfolio.position && atMs > portfolio.position.entryMs!) {
      positionHours++;
      const b = executable(portfolio.position,atMs,"MARK"), f = funding.get(key(portfolio.position.symbol,atMs));
      if (!f && input.adverseFundingBpsPerHour === undefined) invalidate(portfolio.position,atMs,"MISSING_FUNDING");
      if (b && (f || input.adverseFundingBpsPerHour !== undefined)) {
        const adverse = input.adverseFundingBpsPerHour?.[portfolio.position.symbol];
        const cost = adverse === undefined ? portfolio.position.side * portfolio.position.qty! * (f!.absoluteRate ?? b.open * f!.rate)
          : portfolio.position.qty! * b.open * adverse / 10_000;
        const reserve = portfolio.position.qty! * b.open * scenario.extraAdverseFundingBpsPer24h / 10_000 / 24;
        portfolio.position.fundingUsd += cost; portfolio.position.fundingReserveUsd += reserve;
        totalFundingUsd += cost; totalFundingReserveUsd += reserve; cashChange -= cost + reserve;
        settlements.push({ tradeId: portfolio.position.id, symbol: portfolio.position.symbol, atMs, rate:adverse === undefined ? f!.rate : null,
          absoluteRate:adverse === undefined ? f!.absoluteRate ?? null : null,
          fundingUsd:cost,reserveUsd:reserve,source:adverse !== undefined ? "ADVERSE_TRAINING_RESERVE"
            : f!.absoluteRate === undefined ? "RELATIVE_RATE_MARK" : "ABSOLUTE_RATE" });
      } else unknownPositionHours++;
      if (atMs === portfolio.position.scheduledExitMs) {
        const exit = executable(portfolio.position,atMs,"EXIT");
        if (exit) {
          const px = exit.open * (1 - portfolio.position.side * slipRate), fee = portfolio.position.qty! * px * feeRate;
          const slippage = portfolio.position.qty! * portfolio.position.side * (exit.open - px);
          portfolio.position.exitMs = atMs; portfolio.position.exitReferencePx = exit.open; portfolio.position.exitPx = px;
          portfolio.position.feesUsd += fee; portfolio.position.slippageUsd += slippage;
          portfolio.position.grossPnlUsd = portfolio.position.side * portfolio.position.qty! * (exit.open - portfolio.position.entryReferencePx!);
          cashChange += portfolio.position.side * portfolio.position.qty! * (px - portfolio.position.entryPx!) - fee;
          realizedGross += portfolio.position.grossPnlUsd;
          totalFeesUsd += fee; totalSlippageUsd += slippage; turnoverUsd += portfolio.position.qty! * px;
          portfolio.position.netPnlUsd = portfolio.position.invalidReasons.length ? null : portfolio.position.grossPnlUsd
            - portfolio.position.feesUsd - portfolio.position.slippageUsd - portfolio.position.fundingUsd - portfolio.position.fundingReserveUsd;
          portfolio.position.status = portfolio.position.invalidReasons.length ? "INVALID" : "COMPLETE";
          portfolio.position = null;
        } else portfolio.position.status = "INVALID"; // Unresolved inventory retains the global slot.
      }
    }
    if (pending && atMs === pending.scheduledEntryMs + HOURLY_MS
      && bars.get(key(pending.symbol,pending.scheduledEntryMs))?.volume === 0) {
      // Absence of trades across the entire entry candle is known only when
      // that candle closes. Until then the pending order owns the global slot.
      pending.status = "UNFILLED"; pending.exitMs = atMs; pending.grossPnlUsd = 0; pending.netPnlUsd = 0;
      pending = null;
    }
    if (pending && atMs === pending.scheduledEntryMs) {
      const present = bars.get(key(pending.symbol,atMs));
      const entry = present?.volume === 0 ? null : executable(pending,atMs,"ENTRY");
      if (present?.volume === 0) {
        // Remain pending until this candle's close; there is no filled inventory.
      } else if (entry) {
        const px = entry.open * (1 + pending.side * slipRate), qty = 12 / px, fee = qty * px * feeRate;
        pending.entryMs = atMs; pending.entryReferencePx = entry.open; pending.entryPx = px; pending.qty = qty;
        pending.feesUsd = fee; pending.slippageUsd = qty * pending.side * (px - entry.open); pending.status = "OPEN";
        totalFeesUsd += fee; totalSlippageUsd += pending.slippageUsd; turnoverUsd += qty * px; cashChange -= fee;
        portfolio.position = pending;
      } else pending.status = "INVALID";
      if (present?.volume !== 0) pending = null;
    }
    let floatingNet = 0, floatingGross = 0, liquidationCost = 0;
    if (portfolio.position) {
      const b = executable(portfolio.position,atMs,"MARK");
      if (b) {
        floatingNet = portfolio.position.side * portfolio.position.qty! * (b.open - portfolio.position.entryPx!);
        floatingGross = portfolio.position.side * portfolio.position.qty! * (b.open - portfolio.position.entryReferencePx!);
        const exitPx = b.open * (1 - portfolio.position.side * slipRate);
        liquidationCost = portfolio.position.qty! * b.open * slipRate + portfolio.position.qty! * exitPx * feeRate;
      }
    }
    const value = initialEquityUsd + cashChange + floatingNet;
    const liquidation = value - liquidationCost;
    if (allSelectedPathsKnown) {
      peak = Math.max(peak,value); liquidationPeak = Math.max(liquidationPeak,liquidation);
      knownMaximumDrawdownUsd = Math.max(knownMaximumDrawdownUsd,peak-value);
      knownMaximumLiquidationDrawdownUsd = Math.max(knownMaximumLiquidationDrawdownUsd,liquidationPeak-liquidation);
      knownMaximumDrawdownFraction = Math.max(knownMaximumDrawdownFraction,(peak-value)/peak);
    }
    equity.push({ atMs, equityUsd:allSelectedPathsKnown ? value : null,
      liquidationEquityUsd:allSelectedPathsKnown ? liquidation : null,
      grossEquityUsd:allSelectedPathsKnown ? initialEquityUsd + realizedGross + floatingGross : null,
      positionSymbol:portfolio.position?.symbol ?? null });
    const candidates: HourlyForecast[] = forecasts.get(atMs) ?? [];
    if (pending || portfolio.position) { skips.busyForecasts += candidates.length; continue; }
    const qualified: Array<{f:HourlyForecast;expectedNetBps:number;entryMs:number;exitMs:number}> = candidates.flatMap(f => {
      const expectedNetBps = Math.abs(f.predictedGrossBps) - 13 - (f.expectedFundingCostBps ?? 0);
      if (f.predictedGrossBps === 0) { skips.zeroDirectionForecasts++; return []; }
      if (!input.forecastsPrequalified && expectedNetBps <= minimumExpectedNetBps) { skips.belowHurdleForecasts++; return []; }
      const entryMs = atMs + scenario.delayHours * HOURLY_MS, exitMs = entryMs + f.horizonHours * HOURLY_MS;
      if (exitMs > input.endMs) { skips.endpointForecasts++; return []; }
      return [{ f,expectedNetBps,entryMs,exitMs }];
    }).sort((a,b) => b.expectedNetBps-a.expectedNetBps || a.f.symbol.localeCompare(b.f.symbol));
    const choice: (typeof qualified)[number] | undefined = qualified[0];
    if (choice) {
      pending = { id:key(choice.f.symbol,atMs),symbol:choice.f.symbol,side:choice.f.predictedGrossBps > 0 ? 1 : -1,
        decisionMs:atMs,expectedNetBps:choice.expectedNetBps,predictedGrossBps:choice.f.predictedGrossBps,
        horizonHours:choice.f.horizonHours,scheduledEntryMs:choice.entryMs,scheduledExitMs:choice.exitMs,
        status:"PENDING",entryMs:null,exitMs:null,qty:null,entryReferencePx:null,entryPx:null,exitReferencePx:null,exitPx:null,
        grossPnlUsd:null,netPnlUsd:null,feesUsd:0,slippageUsd:0,fundingUsd:0,fundingReserveUsd:0,invalidReasons:[] };
      trades.push(pending);
    }
  }
  if (portfolio.position || pending) {
    const unclosed = portfolio.position ?? pending!; invalidate(unclosed,input.endMs,"ENDPOINT_UNRESOLVED_POSITION"); unclosed.status = "INVALID";
    const last = equity.at(-1)!; last.equityUsd = null; last.liquidationEquityUsd = null; last.grossEquityUsd = null;
  }
  const byTime = new Map(equity.map(p => [p.atMs,p]));
  const dailyPnl: Array<{ date:string; startMs:number; endMs:number; grossPnlUsd:number|null; netPnlUsd:number|null;
    liquidationPnlUsd:number|null }> = [];
  for (let day = Math.floor(input.startMs/DAY_MS)*DAY_MS; day < input.endMs; day += DAY_MS) {
    const startMs = Math.max(day,input.startMs),endMs = Math.min(day+DAY_MS,input.endMs),a=byTime.get(startMs)!,b=byTime.get(endMs)!;
    dailyPnl.push({ date:new Date(day).toISOString().slice(0,10),startMs,endMs,
      grossPnlUsd:a.grossEquityUsd === null || b.grossEquityUsd === null ? null : b.grossEquityUsd-a.grossEquityUsd,
      netPnlUsd:a.equityUsd === null || b.equityUsd === null ? null : b.equityUsd-a.equityUsd,
      liquidationPnlUsd:a.liquidationEquityUsd === null || b.liquidationEquityUsd === null ? null : b.liquidationEquityUsd-a.liquidationEquityUsd });
  }
  const completed=trades.filter(t=>t.status === "COMPLETE"), final=equity.at(-1)!;
  const sum=(rows:readonly HourlySimulationTrade[],field:"grossPnlUsd"|"netPnlUsd")=>rows.reduce((s,t)=>s+(t[field] ?? 0),0);
  const report = { version:"kraken-hourly-account-simulator-v1",scenario:{...scenario},initialEquityUsd,entryNotionalUsd:12,
    accountingMode,adverseFundingBpsPerHour:input.adverseFundingBpsPerHour ? {...input.adverseFundingBpsPerHour} : null,
    returnInterpretation:accountingMode === "ADVERSE_TRAINING_RESERVE_SCENARIO"
      ? "PROJECTED_SCENARIO_PNL_WITH_TRAINING_ONLY_ADVERSE_FUNDING; NOT_VERIFIED_ACTUAL_HISTORICAL_RETURN"
      : "CANDLE_EXECUTION_PNL_WITH_SUPPLIED_HISTORICAL_FUNDING; LIVE_FILLABILITY_NOT_ESTABLISHED",
    startMs:input.startMs,endMs:input.endMs,forecastsPrequalified:input.forecastsPrequalified ?? false,minimumExpectedNetBps,
    metrics:{ selected:trades.length,filled:trades.filter(t=>t.entryMs !== null).length,completed:completed.length,
      unfilled:trades.filter(t=>t.status === "UNFILLED").length,
      unknownTrades:trades.filter(t=>t.status === "INVALID").length,
      activeUtcDates:new Set(completed.map(t=>new Date(t.entryMs!).toISOString().slice(0,10))).size,
      finalEquityUsd:final.equityUsd,totalGrossPnlUsd:allSelectedPathsKnown ? final.grossEquityUsd!-initialEquityUsd : null,
      totalNetPnlUsd:allSelectedPathsKnown ? final.equityUsd!-initialEquityUsd : null,
      knownCompletedGrossPnlUsd:sum(completed,"grossPnlUsd"),knownCompletedNetPnlUsd:sum(completed,"netPnlUsd"),
      totalFeesUsd,totalSlippageUsd,totalFundingUsd:allSelectedPathsKnown ? totalFundingUsd : null,
      knownFundingUsd:totalFundingUsd,totalFundingReserveUsd:allSelectedPathsKnown ? totalFundingReserveUsd : null,
      knownFundingReserveUsd:totalFundingReserveUsd,turnoverUsd,turnoverInitialEquity:turnoverUsd/initialEquityUsd,
      positionHours,unknownPositionHours,staleMarkHours:staleMarks.size,
      maximumDrawdownUsd:allSelectedPathsKnown ? knownMaximumDrawdownUsd : null,
      maximumDrawdownFraction:allSelectedPathsKnown ? knownMaximumDrawdownFraction : null,
      maximumLiquidationDrawdownUsd:allSelectedPathsKnown ? knownMaximumLiquidationDrawdownUsd : null,
      knownMaximumDrawdownUsd,knownMaximumLiquidationDrawdownUsd,
      maximumOneDayLossUsd:allSelectedPathsKnown ? Math.max(0,...dailyPnl.map(d=>-d.netPnlUsd!)) : null,
      perAsset:SYMBOLS.map(symbol=>{const rows=trades.filter(t=>t.symbol===symbol),known=rows.filter(t=>t.status==="COMPLETE"),unknown=rows.filter(t=>t.status==="INVALID").length;
        return {symbol,selected:rows.length,filled:rows.filter(t=>t.entryMs!==null).length,completed:known.length,unknownTrades:unknown,
          grossPnlUsd:unknown?null:sum(known,"grossPnlUsd"),netPnlUsd:unknown?null:sum(known,"netPnlUsd"),
          knownCompletedGrossPnlUsd:sum(known,"grossPnlUsd"),knownCompletedNetPnlUsd:sum(known,"netPnlUsd")};}),
    },trades,equity,dailyPnl,settlements,skips,allSelectedPathsKnown,brokerOrdersSubmitted:0,profitabilityEstablished:false,
    assumptions:["Forecasts must use completed candles; the caller owns feature and training causality.",
      "All scenarios use the same base-cost ranking and prequalified forecasts; stress changes fills and portfolio timing only.",
      "Fractional quantity uses exactly $12 at the adverse entry fill. Live tick, lot, liquidity and margin constraints are not established by candles.",
      "Funding timestamps denote settlement/end-of-hour; exact per-unit absolute rates take precedence over relative rate times open mark.",
      "When adverseFundingBpsPerHour is configured, its training-only reserve replaces actual funding entirely for both sides; stress extra funding remains separate.",
      "Entry at t pays funding at t+1h through exit inclusive. Positive funding cost is debited; negative cost is credited.",
      "Equity is sampled after settlements/fills at each hourly open. Daily P&L is successive UTC-boundary equity differences, including idle days.",
      "Clock exits use executable positive-volume bar opens; no high/low stop, target or optimistic intrabar path is assumed.",
      "A zero-volume entry is a known no-fill only at that candle's close; the pending slot remains occupied until then.",
      "Present zero-volume marks are stale indicative prices, tracked separately; they do not establish executable liquidation or intrahour risk.",
      "Missing selected entry/exit/marks/funding make full-period P&L and drawdown unknown. A missing exit retains unresolved inventory and blocks new entries.",
      "Slippage is embedded once in fills; its separate cost attribution is not charged twice."] };
  return {...report,netPnlUsd:report.metrics.totalNetPnlUsd,grossPnlUsd:report.metrics.totalGrossPnlUsd,
    maximumDrawdownUsd:report.metrics.maximumDrawdownUsd,maximumOneDayLossUsd:report.metrics.maximumOneDayLossUsd,
    daily:dailyPnl,perAsset:report.metrics.perAsset,
    unknowns:trades.flatMap(t=>t.invalidReasons.map(reason=>({tradeId:t.id,symbol:t.symbol,...reason})))};
}
