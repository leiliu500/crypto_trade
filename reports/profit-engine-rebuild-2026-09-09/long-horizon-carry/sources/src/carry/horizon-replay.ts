import type { FundingRow, HourlyBar } from "../research/hourly-data.js";
import type { SpotHistoryBar } from "../research/spot-history-data.js";
import { HORIZON_CARRY_SPEC as S, HORIZON_CARRY_SPEC_SHA256, type HorizonCarryScenario,
  type HorizonFundingEndShiftHours } from "./horizon-spec.js";
import { horizonCarrySignal } from "./horizon-signal.js";
import { newCarryInventory, applyCarryInventoryPair, observeCarryInventoryFunding, markCarryInventory,
  boundCarryInventoryEquity, carryInventoryExecution, type CarryInventoryState } from "./inventory.js";

export interface HorizonCarryReplayInput {
  id: string; startMs: number; endMs: number; scenario: HorizonCarryScenario;
  fundingEndShiftHours: HorizonFundingEndShiftHours;
  spotBars: readonly SpotHistoryBar[]; futureBars: readonly HourlyBar[]; funding: readonly FundingRow[];
}
type Signal = ReturnType<typeof horizonCarrySignal>;
type Mark = ReturnType<typeof markCarryInventory>;
interface Cycle { entryMs: number; exitMs: number; reason: string; qty: number; holdingDays: number;
  horizonTruncated: boolean; committedCapitalUsd: number; capitalBenchmarkUsd: number;
  netCashPnlUsd: number | null; capitalBenchmarkExcessUsd: number | null; mark: Mark;
  inventory: CarryInventoryState; minimumCollateralCoverageRatio: number | null;
  weeklyEquityBounds: Array<ReturnType<typeof boundCarryInventoryEquity>> }

/** Coarse independent price economic proxy. Both receipt prices are explicit;
 * same timestamp does not establish simultaneous executable market quotes. */
export function replayHorizonCarry(input: HorizonCarryReplayInput) {
  const { startMs, endMs, scenario, fundingEndShiftHours } = input;
  if (!S.windows.some(w => w.id === input.id && w.startMs === startMs && w.endMs === endMs)
    || !["base", "stress"].includes(scenario) || !S.fundingEndShiftHours.includes(fundingEndShiftHours))
    throw new Error("INVALID_HORIZON_CARRY_SCOPE");
  const costs = S.scenarios[scenario], H = S.hourMs, W = S.weekMs;
  const futures = new Map<number, HourlyBar>(), spots = new Map<number, SpotHistoryBar>(), rates = new Map<number, FundingRow>();
  for (const bar of input.futureBars) {
    if (bar.symbol !== S.symbol || bar.openMs >= endMs) continue;
    if (!Number.isSafeInteger(bar.openMs) || bar.openMs % H || futures.has(bar.openMs)
      || ![bar.open, bar.high, bar.low, bar.close].every(v => Number.isFinite(v) && v > 0)
      || !Number.isFinite(bar.volume) || bar.volume < 0 || bar.high < Math.max(bar.open, bar.close)
      || bar.low > Math.min(bar.open, bar.close)) throw new Error("INVALID_HORIZON_CARRY_BAR");
    futures.set(bar.openMs, bar);
  }
  for (const bar of input.spotBars) {
    if (bar.symbol !== S.symbol || bar.intervalMinutes !== S.spotIntervalMinutes || bar.openMs >= endMs) continue;
    if (!Number.isSafeInteger(bar.openMs) || bar.openMs % W || spots.has(bar.openMs)
      || bar.endMsExclusive !== bar.openMs + W || bar.assumedAvailableAtMs !== bar.endMsExclusive + S.decisionDelayMs
      || ![bar.open, bar.high, bar.low, bar.close].every(v => Number.isFinite(v) && v > 0)
      || !Number.isFinite(bar.volume) || bar.volume < 0 || bar.high < Math.max(bar.open, bar.close)
      || bar.low > Math.min(bar.open, bar.close)) throw new Error("INVALID_HORIZON_SPOT_BAR");
    spots.set(bar.openMs, bar);
  }
  for (const row of input.funding) {
    if (row.symbol !== S.symbol || row.timestampMs + fundingEndShiftHours * H > endMs) continue;
    const mapped = row.timestampMs + fundingEndShiftHours * H;
    if (!Number.isSafeInteger(mapped) || mapped % H || rates.has(mapped) || !Number.isFinite(row.absoluteRate))
      throw new Error("INVALID_HORIZON_CARRY_RATE");
    rates.set(mapped, row);
  }
  const eligible = [...spots.values()].filter(b => b.openMs >= startMs && b.endMsExclusive <= endMs).sort((a, b) => a.openMs - b.openMs);
  const terminalAt = eligible.at(-1)?.openMs;
  if (terminalAt === undefined) throw new Error("HORIZON_NO_COMPLETE_SPOT_WEEKS");
  const decisions: Array<{ atMs: number; scheduledEntryMs: number; signal: Signal; disposition: string }> = [];
  const cycles: Cycle[] = [], blocked: Record<string, number> = {};
  const block = (why: string) => { blocked[why] = (blocked[why] ?? 0) + 1; };
  let state: CarryInventoryState | null = null, entryMs = 0, equity: number = S.initialEquityUsd;
  let pending: { atMs: number; signal: Signal } | null = null, exitReason: string | null = null;
  let negativeWeeks = 0, marginMinimum = Infinity, guardBreaches = 0, missingFunding = 0, missingPrices = 0;
  let anyUnknown = false, bounds: Cycle["weeklyEquityBounds"] = [];
  let lastSpot = 0, lastFuture = 0;
  const execution = (referencePrice: number, side: 1 | -1, qty: number, spot: boolean) => carryInventoryExecution({
    referencePrice, side, qty, slippageBps: costs.slippageBpsPerExecution,
    feeBps: spot ? costs.spotFeeBps : costs.perpetualFeeBps, priceIncrement: spot ? .1 : 1 });
  const close = (t: number, spotPrice: number, futurePrice: number, reason: string) => {
    const current = state!;
    state = applyCarryInventoryPair(current, { id: `exit:${t}`, atMs: t, kind: "REDUCE", qty: current.qty,
      spot: execution(spotPrice, -1, current.qty, true), future: execution(futurePrice, 1, current.qty, false) });
    const mark = markCarryInventory(state, { atMs: t, spotPrice, futurePrice });
    const capital = current.config.spotCashUsd + current.config.derivativeCollateralUsd;
    const holdingDays = (t - entryMs) / S.dayMs, hurdle = capital * S.annualCapitalHurdleFraction * holdingDays / S.yearDays;
    cycles.push({ entryMs, exitMs: t, reason, qty: current.qty, holdingDays,
      horizonTruncated: holdingDays < S.holdingDays, committedCapitalUsd: capital, capitalBenchmarkUsd: hurdle,
      netCashPnlUsd: mark.cashNetPnlUsd, capitalBenchmarkExcessUsd: mark.cashNetPnlUsd === null ? null : mark.cashNetPnlUsd - hurdle,
      mark, inventory: state, minimumCollateralCoverageRatio: marginMinimum === Infinity ? null : marginMinimum,
      weeklyEquityBounds: bounds });
    equity += mark.knownCashNetPnlUsd; anyUnknown ||= mark.cashNetPnlUsd === null;
    state = null; exitReason = null; negativeWeeks = 0; bounds = []; marginMinimum = Infinity;
  };
  for (let t = startMs; t <= terminalAt; t += H) {
    const future = futures.get(t), spot = spots.get(t), priorSpot = spots.get(t - W);
    if (future) lastFuture = future.open;
    if (spot) lastSpot = spot.open;
    let exited = false;
    // A complete prior week is used only once it has ended. Extrema are
    // independent accounting-cutoff bounds, never a synchronized equity path.
    if (state && priorSpot && t >= entryMs + W) {
      const week = Array.from({ length: W / H }, (_, i) => futures.get(t - W + i * H));
      if (week.every((b): b is HourlyBar => b !== undefined)) bounds.push(boundCarryInventoryEquity(state, {
        atMs: t, spotLow: priorSpot.low, spotHigh: priorSpot.high,
        futureLow: Math.min(...week.map(b => b.low)), futureHigh: Math.max(...week.map(b => b.high)) }));
    }
    if (state && spot) {
      if (t >= terminalAt) exitReason = "TERMINAL_HORIZON_TRUNCATION";
      else if (t - entryMs >= S.holdingDays * S.dayMs) exitReason = "HOLDING_HORIZON";
      if (exitReason && future && spot.volume > 0 && future.volume > 0) {
        close(t, spot.open, future.open, exitReason); pending = null; exited = true;
      }
    }
    if (!state && !exited && pending && t >= pending.atMs && spot && t < terminalAt) {
      if (!future || future.volume <= 0 || spot.volume <= 0) { block("ENTRY_MISSING_INDEPENDENT_EXECUTION_PROXY"); pending = null; }
      else {
        const unitSpot = execution(spot.open, 1, 1, true), unitFuture = execution(future.open, -1, 1, false);
        const cap = Math.min(S.maximumLegNotionalUsd, equity * S.maximumLegEquityFraction);
        const perBaseCapital = unitSpot.price * (1 + costs.spotFeeBps / 10_000) + S.collateralMultiple * unitFuture.price;
        const qty = Number((Math.floor(Math.min(cap / Math.max(unitSpot.price, unitFuture.price), equity / perBaseCapital)
          / S.quantityStepBtc + 1e-10) * S.quantityStepBtc).toFixed(8));
        if (qty < S.minimumQuantityBtc) block("ENTRY_BELOW_MATCHED_MINIMUM_LOT");
        else {
          const spotFill = execution(spot.open, 1, qty, true), futureFill = execution(future.open, -1, qty, false);
          state = newCarryInventory({ startedAtMs: t,
            spot: { instrumentId: "kraken:SPOT:BTC/USD", minQty: .0001, qtyIncrement: .0001, priceIncrement: .1 },
            future: { instrumentId: "kraken:LINEAR_PERPETUAL:PF_XBTUSD", minQty: .0001, qtyIncrement: .0001, priceIncrement: 1 },
            spotCashUsd: qty * spotFill.price + spotFill.feeUsd, derivativeCollateralUsd: S.collateralMultiple * qty * futureFill.price,
            maximumLegNotionalUsd: cap, initialMarginFraction: 1, maintenanceMarginFraction: S.collateralGuardFraction,
            spotExitFeeBps: costs.spotFeeBps, futureExitFeeBps: costs.perpetualFeeBps });
          state = applyCarryInventoryPair(state, { id: `entry:${t}`, atMs: t, kind: "ENTER", qty, spot: spotFill, future: futureFill });
          entryMs = t; negativeWeeks = 0;
        }
        pending = null;
      }
    }
    // Thursday 00:01 decision; first independent future spot opening is a
    // full source week later. This never fills a signal at its source close.
    if (priorSpot && t < terminalAt && future) {
      const lastClosedFuture = futures.get(t - H);
      if (priorSpot.volume > 0 && lastClosedFuture) {
        const atMs = t + S.decisionDelayMs;
        const signal = horizonCarrySignal({ atMs, spotPrice: priorSpot.close, futurePrice: lastClosedFuture.close,
          funding: input.funding, spotFeeBps: costs.spotFeeBps, futureFeeBps: costs.perpetualFeeBps,
          slippageBps: costs.slippageBpsPerExecution, fundingEndShiftMs: fundingEndShiftHours * H as 0 | 3600000 });
        let disposition: string;
        if (state) {
          negativeWeeks = signal.recent28DayMeanAbsolute !== null && signal.recent28DayMeanAbsolute < 0 ? negativeWeeks + 1 : 0;
          if (signal.missingHours) exitReason ??= "MISSING_FUNDING_FORECAST";
          if (negativeWeeks >= S.fundingExitConsecutiveWeeks) exitReason ??= "TWO_NEGATIVE_FUNDING_WEEKS";
          disposition = exitReason ? "EXIT_QUEUED_NEXT_SOURCE_WEEK" : "MATCHED_INVENTORY_HELD";
        } else if (signal.entryAllowed && !exited && !anyUnknown) {
          pending = { atMs: t + W, signal }; disposition = "ENTRY_QUEUED_NEXT_SOURCE_WEEK";
        } else { disposition = exited ? "POST_EXIT_NEW_WEEK_REQUIRED" : signal.reason; block(disposition); }
        decisions.push({ atMs, scheduledEntryMs: t + W, signal, disposition });
      } else block("MISSING_CAUSAL_COMPLETED_PRICES");
    }
    if (!state || t === terminalAt) continue;
    // Check the next hour's adverse derivative mark with settled opening
    // collateral, so a positive hour-end receipt cannot hide a prior deficit.
    if (!future) { missingPrices++; anyUnknown = true; exitReason ??= "MISSING_HELD_FUTURES_BAR"; }
    else {
      const mark = markCarryInventory(state, { atMs: t, spotPrice: lastSpot, futurePrice: future.high });
      if (mark.margin.coverageRatio !== null) marginMinimum = Math.min(marginMinimum, mark.margin.coverageRatio);
      if (mark.margin.covered === false) { guardBreaches++; exitReason ??= "COLLATERAL_GUARD_BREACH"; }
    }
    const rate = rates.get(t + H);
    if (rate?.absoluteRate === undefined) { missingFunding++; anyUnknown = true; exitReason ??= "MISSING_HELD_FUNDING"; }
    else state = observeCarryInventoryFunding(state, { id: `fund:${t + H}`, intervalEndMs: t + H,
      absoluteUsdPerBasePerHour: rate.absoluteRate, knownAtMs: t + H }, t + H);
    if (future) {
      const mark = markCarryInventory(state, { atMs: t + H, spotPrice: lastSpot, futurePrice: future.high });
      if (mark.margin.coverageRatio !== null) marginMinimum = Math.min(marginMinimum, mark.margin.coverageRatio);
      if (mark.margin.covered === false) { guardBreaches++; exitReason ??= "COLLATERAL_GUARD_BREACH"; }
    }
  }
  const unresolvedMatchedQty = state?.qty ?? 0;
  const known = !anyUnknown && !unresolvedMatchedQty;
  const cashPnl = cycles.reduce((n, cycle) => n + cycle.mark.knownCashNetPnlUsd, 0);
  const hurdle = cycles.reduce((n, cycle) => n + cycle.capitalBenchmarkUsd, 0);
  return { version: S.version, specificationSha256: HORIZON_CARRY_SPEC_SHA256, id: input.id,
    startMs, endMs, effectiveTerminalAtMs: terminalAt, scenario, fundingEndShiftHours,
    completedCycles: cycles.length, pairedOrderCount: cycles.length * 4 + (state ? 2 : 0),
    accountingKnown: known, netCashPnlUsd: known ? cashPnl : null,
    capitalBenchmarkUsd: hurdle, capitalBenchmarkExcessUsd: known ? cashPnl - hurdle : null,
    feesUsd: cycles.reduce((n, cycle) => n + cycle.mark.feesUsd, 0),
    fundingCashUsd: known ? cycles.reduce((n, cycle) => n + cycle.mark.knownFundingCashUsd, 0) : null,
    grossPricePnlUsd: cycles.reduce((n, cycle) => n + cycle.mark.grossPricePnlUsd, 0),
    missingHeldFundingHours: missingFunding, missingHeldPriceHours: missingPrices,
    collateralGuardBreaches: guardBreaches, unresolvedMatchedQty, lastKnownSpotPrice: lastSpot, lastKnownFuturePrice: lastFuture,
    decisions, cycles, blocked, actualSynchronizedDrawdownUsd: null, runtimeActivationAllowed: false };
}
