import { createHash } from "node:crypto";
import type { FundingRow } from "../research/hourly-data.js";
import { applyPortfolioFill, applyPortfolioFunding, cancelPortfolioOrder, newPortfolioState,
  planPortfolioAdjustment, portfolioEquity, reservePortfolioOrders } from "./kernel.js";
import { PORTFOLIO_DAY_MS as DAY, PORTFOLIO_HOUR_MS as HOUR, PORTFOLIO_SYMBOLS as SYMBOLS,
  PORTFOLIO_VERSION, type AssetRules, type HourlyBar, type Pair, type PortfolioFill,
  type PortfolioPlan, type PortfolioQuote, type PortfolioState, type PortfolioTarget } from "./types.js";

export interface PortfolioReplayScenario {
  id: string; delayHours: number; feeBps: number; slippageBps: number;
  fundingShiftMs: 0 | -3600000; extraFundingBpsPerDay: number;
}
export interface PortfolioReplayInput {
  bars: readonly HourlyBar[]; funding: readonly FundingRow[]; targets: readonly PortfolioTarget[];
  rules: Pair<AssetRules>; startMs: number; endMs: number; scenario: PortfolioReplayScenario;
  initialEquityUsd?: number;
}
export interface PortfolioReplayUnknown { atMs: number; symbol: typeof SYMBOLS[number] | null; reason: string }
export interface PortfolioReplayEquity {
  atMs: number; equityUsd: number | null; indicativeEquityUsd: number; preTradeEquityUsd: number | null;
  liquidationEquityUsd: number | null; indicativeLiquidationEquityUsd: number;
  cashUsd: number; marks: Pair<number>; quantities: Pair<number>; grossExposureUsd: number; preTradeGrossExposureUsd: number;
  reservedOrders: number;
}
export interface PortfolioReplayFunding {
  id: string; atMs: number; sourceTimestampMs: number; symbol: typeof SYMBOLS[number];
  signedQty: number; absoluteRate: number | null; actualCostUsd: number | null;
  extraCostUsd: number; knownCostUsd: number; mark: number;
}
export interface PortfolioReplayDaily { date: string; netPnlUsd: number | null; indicativeNetPnlUsd: number }
const pair = <T>(factory: () => T): Pair<T> => ({ "BTC/USD": factory(), "ETH/USD": factory() });
const finite = (v: number) => typeof v === "number" && Number.isFinite(v);
const aligned = (v: number) => Number.isSafeInteger(v) && v >= 0 && v % HOUR === 0;
const date = (v: number) => new Date(v).toISOString().slice(0, 10);

/** Hourly adapter for the exact shared target/inventory kernel.
 * Open prices are execution proxies; a positive final candle volume does not
 * prove liquidity at its open. Zero-volume attempts reserve capacity until the
 * candle closes. No high/low/close/volume enters the adjustment plan.
 * Missing exposed paths remain unknown even if subsequent prices resume.
 */
export function simulatePortfolioReplay(input: PortfolioReplayInput) {
  const { startMs, endMs, scenario } = input;
  if (!aligned(startMs) || !aligned(endMs) || endMs <= startMs || endMs - startMs > 5 * 366 * DAY
    || !scenario.id || !Number.isInteger(scenario.delayHours) || scenario.delayHours < 1
    || ![scenario.feeBps, scenario.slippageBps, scenario.extraFundingBpsPerDay].every(v => finite(v) && v >= 0)
    || scenario.slippageBps >= 10_000 || ![0, -HOUR].includes(scenario.fundingShiftMs))
    throw new Error("PORTFOLIO_REPLAY_INVALID_INPUT");
  const bars = pair(() => new Map<number, HourlyBar>());
  for (const bar of input.bars) {
    if (!SYMBOLS.includes(bar.symbol) || !aligned(bar.openMs)
      || ![bar.open, bar.high, bar.low, bar.close].every(v => finite(v) && v > 0)
      || !finite(bar.volume) || bar.volume < 0 || bar.low > Math.min(bar.open, bar.close)
      || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high)
      throw new Error("PORTFOLIO_REPLAY_INVALID_BAR");
    if (bars[bar.symbol].has(bar.openMs)) throw new Error("PORTFOLIO_REPLAY_DUPLICATE_BAR");
    bars[bar.symbol].set(bar.openMs, bar);
  }
  const funding = pair(() => new Map<number, FundingRow>());
  for (const row of input.funding) {
    if (!SYMBOLS.includes(row.symbol) || !aligned(row.timestampMs) || !finite(row.rate)
      || row.absoluteRate !== undefined && !finite(row.absoluteRate)) throw new Error("PORTFOLIO_REPLAY_INVALID_FUNDING");
    const settlement = row.timestampMs + scenario.fundingShiftMs;
    if (funding[row.symbol].has(settlement)) throw new Error("PORTFOLIO_REPLAY_DUPLICATE_FUNDING");
    funding[row.symbol].set(settlement, row);
  }
  const targets = [...input.targets].sort((a, b) => a.decisionMs - b.decisionMs);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]!;
    if (t.version !== PORTFOLIO_VERSION || !aligned(t.decisionMs) || !Number.isSafeInteger(t.availableAtMs)
      || t.availableAtMs < t.decisionMs || !Number.isSafeInteger(t.validUntilMs) || t.validUntilMs <= t.availableAtMs
      || !SYMBOLS.every(s => finite(t.targetUsd[s])) || i > 0 && t.decisionMs === targets[i - 1]!.decisionMs)
      throw new Error("PORTFOLIO_REPLAY_INVALID_TARGET");
  }
  let state = newPortfolioState(input.initialEquityUsd ?? 100_000);
  const plans: PortfolioPlan[] = [], fills: PortfolioFill[] = [], equity: PortfolioReplayEquity[] = [];
  const fundingReceipts: PortfolioReplayFunding[] = [], unknowns: PortfolioReplayUnknown[] = [];
  const attempts: Array<{ orderId: string; symbol: typeof SYMBOLS[number]; atMs: number; knownAtMs: number;
    status: "FILLED" | "ZERO_VOLUME_UNFILLED" }> = [];
  const pendingNoFills = new Map<string, number>();
  const daily = new Map<string, PortfolioReplayDaily>();
  for (let at = Math.floor(startMs / DAY) * DAY; at < endMs; at += DAY)
    daily.set(date(at), { date: date(at), netPnlUsd: 0, indicativeNetPnlUsd: 0 });
  const perAsset = pair(() => ({ feesUsd: 0, actualFundingCostUsd: 0, extraFundingCostUsd: 0,
    turnoverUsd: 0, slippageUsd: 0, pricePnlUsd: 0, realizedPricePnlUsd: 0, unrealizedPricePnlUsd: 0,
    totalFundingCostUsd: 0 as number | null, netPnlUsd: 0 as number | null,
    filledOrders: 0, zeroVolumeNoFills: 0, exposedHours: 0, staleMarkHours: 0,
    maximumExposureUsd: 0, terminalQty: 0 }));
  let targetIndex = 0, target: PortfolioTarget | null = null;
  const marks = pair(() => 1);
  let previousEquity = state.initialEquityUsd, peakEquity = state.initialEquityUsd;
  let peakLiquidation = state.initialEquityUsd, maximumDrawdown = 0, liquidationDrawdown = 0;
  let maximumGrossExposureUsd = 0, exposureHourUsd = 0, cashFundingCreditUsd = 0, cashFundingDebitUsd = 0;
  const markUnknown = (atMs: number, symbol: typeof SYMBOLS[number] | null, reason: string) => {
    unknowns.push({ atMs, symbol, reason });
  };
  const addDaily = (atMs: number, amount: number) => {
    const row = daily.get(date(Math.max(startMs, Math.min(endMs - 1, atMs))));
    if (row) row.indicativeNetPnlUsd += amount;
  };
  const trackDrawdown = (value: number, liquidation: number) => {
    peakEquity = Math.max(peakEquity, value); maximumDrawdown = Math.max(maximumDrawdown, peakEquity - value);
    peakLiquidation = Math.max(peakLiquidation, liquidation);
    liquidationDrawdown = Math.max(liquidationDrawdown, peakLiquidation - liquidation);
  };
  const liquidationValue = (account: PortfolioState, value: number) => value - SYMBOLS.reduce((cost, symbol) => {
    const qty = account.positions[symbol].qty;
    if (!qty) return cost;
    const tick = input.rules[symbol].priceIncrement;
    const adverse = marks[symbol] * (1 - Math.sign(qty) * scenario.slippageBps / 10_000);
    const price = qty > 0 ? Math.floor((adverse + tick * 1e-10) / tick) * tick
      : Math.ceil((adverse - tick * 1e-10) / tick) * tick;
    return cost + qty * (marks[symbol] - price) + Math.abs(qty) * price * scenario.feeBps / 10_000;
  }, 0);

  for (let at = startMs; at <= endMs; at += HOUR) {
    // Inventory held over the preceding interval pays before boundary fills.
    if (at > startMs) for (const symbol of SYMBOLS) {
      const qty = state.positions[symbol].qty;
      if (!qty) continue;
      perAsset[symbol].exposedHours++;
      const priorBar = bars[symbol].get(at - HOUR);
      if (!priorBar) markUnknown(at, symbol, "MISSING_HELD_INTERVAL_BAR");
      else {
        marks[symbol] = priorBar.close;
        if (priorBar.volume === 0) perAsset[symbol].staleMarkHours++;
      }
      const rate = funding[symbol].get(at);
      const actualCostUsd = rate?.absoluteRate === undefined ? null : qty * rate.absoluteRate;
      if (actualCostUsd === null) markUnknown(at, symbol, rate ? "MISSING_ABSOLUTE_FUNDING_RATE" : "MISSING_FUNDING_RATE");
      const extraCostUsd = Math.abs(qty) * marks[symbol] * scenario.extraFundingBpsPerDay / 24 / 10_000;
      const knownCostUsd = (actualCostUsd ?? 0) + extraCostUsd;
      const id = `funding:${scenario.id}:${symbol}:${at}`;
      state = applyPortfolioFunding(state, { id, atMs: at, costUsd: knownCostUsd });
      fundingReceipts.push({ id, atMs: at, sourceTimestampMs: at - scenario.fundingShiftMs,
        symbol, signedQty: qty, absoluteRate: rate?.absoluteRate ?? null, actualCostUsd, extraCostUsd,
        knownCostUsd, mark: marks[symbol] });
      perAsset[symbol].actualFundingCostUsd += actualCostUsd ?? 0;
      perAsset[symbol].extraFundingCostUsd += extraCostUsd;
      cashFundingDebitUsd += Math.max(0, actualCostUsd ?? 0);
      cashFundingCreditUsd += Math.max(0, -(actualCostUsd ?? 0));
    }
    for (const [orderId, knownAt] of pendingNoFills) if (knownAt <= at) {
      state = cancelPortfolioOrder(state, orderId); pendingNoFills.delete(orderId);
    }
    const current = pair<HourlyBar | undefined>(() => undefined);
    for (const symbol of SYMBOLS) {
      current[symbol] = at < endMs ? bars[symbol].get(at) : undefined;
      const lastClose = bars[symbol].get(at - HOUR)?.close;
      if (at < endMs && current[symbol]) marks[symbol] = current[symbol]!.open;
      else if (lastClose !== undefined) marks[symbol] = lastClose;
      else if (state.positions[symbol].qty) markUnknown(at, symbol, "MISSING_MARK");
      if (at < endMs && !current[symbol] && state.positions[symbol].qty)
        markUnknown(at, symbol, "MISSING_EXECUTION_BAR_WHILE_HELD");
    }
    const preTradeAccount = portfolioEquity(state, marks), preTrade = preTradeAccount.equityUsd;
    maximumGrossExposureUsd = Math.max(maximumGrossExposureUsd, preTradeAccount.grossNotionalUsd);
    for (const symbol of SYMBOLS) perAsset[symbol].maximumExposureUsd = Math.max(perAsset[symbol].maximumExposureUsd,
      Math.abs(state.positions[symbol].qty) * marks[symbol]);
    addDaily(at === startMs ? at : at - 1, preTrade - previousEquity);
    trackDrawdown(preTrade, liquidationValue(state, preTrade));
    while (targetIndex < targets.length) {
      const next = targets[targetIndex]!;
      if (next.decisionMs > at - scenario.delayHours * HOUR || next.availableAtMs > at) break;
      target = next; targetIndex++;
    }
    if (at < endMs) {
      const forceFlat = at >= endMs - 48 * HOUR;
      const effectiveTarget = target ?? { version: PORTFOLIO_VERSION, policy: "flat" as const,
        decisionMs: startMs, availableAtMs: startMs, validUntilMs: endMs + HOUR,
        inputSha256: "no-active-target", targetUsd: pair(() => 0), signals: [] };
      if (current["BTC/USD"] && current["ETH/USD"]) {
        const quotes = pair<PortfolioQuote>(() => ({ symbol: "BTC/USD", atMs: at, bid: 1, ask: 1, bidQty: 1e9, askQty: 1e9 }));
        for (const symbol of SYMBOLS) quotes[symbol] = { symbol, atMs: at,
          bid: current[symbol]!.open * (1 - scenario.slippageBps / 10_000),
          ask: current[symbol]!.open * (1 + scenario.slippageBps / 10_000), bidQty: 1e9, askQty: 1e9 };
        const plan = planPortfolioAdjustment({ state, target: effectiveTarget, quotes, rules: input.rules,
          atMs: at, feeBps: scenario.feeBps, forceFlat });
        plans.push(plan);
        if (plan.orders.length) {
          state = reservePortfolioOrders(state, plan);
          // The entire plan is already fixed before inspecting candle volume.
          for (const order of plan.orders) {
            const b = current[order.symbol]!;
            if (b.volume === 0) {
              pendingNoFills.set(order.id, at + HOUR);
              perAsset[order.symbol].zeroVolumeNoFills++;
              attempts.push({ orderId: order.id, symbol: order.symbol, atMs: at, knownAtMs: at + HOUR,
                status: "ZERO_VOLUME_UNFILLED" });
              continue;
            }
            const fill: PortfolioFill = { id: `fill:${order.id}`, orderId: order.id, symbol: order.symbol,
              atMs: at, signedQty: order.signedQty, price: order.limitPrice,
              feeUsd: Math.abs(order.signedQty) * order.limitPrice * scenario.feeBps / 10_000 };
            const before = state.realizedPricePnlUsd;
            state = applyPortfolioFill(state, fill);
            perAsset[order.symbol].pricePnlUsd += state.realizedPricePnlUsd - before;
            perAsset[order.symbol].feesUsd += fill.feeUsd;
            perAsset[order.symbol].turnoverUsd += Math.abs(fill.signedQty) * fill.price;
            perAsset[order.symbol].slippageUsd += fill.signedQty * (fill.price - b.open);
            perAsset[order.symbol].filledOrders++;
            fills.push(fill);
            attempts.push({ orderId: order.id, symbol: order.symbol, atMs: at, knownAtMs: at, status: "FILLED" });
          }
        }
      } else if (SYMBOLS.some(s => state.positions[s].qty || !forceFlat && effectiveTarget.targetUsd[s])) {
        for (const symbol of SYMBOLS) if (!current[symbol]) markUnknown(at, symbol, "MISSING_ADJUSTMENT_QUOTES");
      }
    }
    const accountEquity = portfolioEquity(state, marks).equityUsd, liquidation = liquidationValue(state, accountEquity);
    addDaily(at, accountEquity - preTrade); previousEquity = accountEquity;
    trackDrawdown(accountEquity, liquidation);
    const grossExposureUsd = SYMBOLS.reduce((sum, s) => sum + Math.abs(state.positions[s].qty) * marks[s], 0);
    maximumGrossExposureUsd = Math.max(maximumGrossExposureUsd, grossExposureUsd);
    if (at < endMs) exposureHourUsd += grossExposureUsd;
    for (const symbol of SYMBOLS) perAsset[symbol].maximumExposureUsd = Math.max(perAsset[symbol].maximumExposureUsd,
      Math.abs(state.positions[symbol].qty) * marks[symbol]);
    equity.push({ atMs: at, equityUsd: unknowns.length ? null : accountEquity, indicativeEquityUsd: accountEquity,
      preTradeEquityUsd: unknowns.length ? null : preTrade, liquidationEquityUsd: unknowns.length ? null : liquidation,
      indicativeLiquidationEquityUsd: liquidation, cashUsd: state.cashUsd, marks: { ...marks },
      quantities: pair(() => 0), grossExposureUsd, preTradeGrossExposureUsd: preTradeAccount.grossNotionalUsd,
      reservedOrders: state.pending.length });
    for (const symbol of SYMBOLS) equity[equity.length - 1]!.quantities[symbol] = state.positions[symbol].qty;
  }
  if (state.pending.length) markUnknown(endMs, null, "TERMINAL_UNRESOLVED_ORDERS");
  for (const symbol of SYMBOLS) {
    const item = perAsset[symbol], position = state.positions[symbol];
    item.terminalQty = position.qty;
    if (position.qty) markUnknown(endMs, symbol, "TERMINAL_OPEN_INVENTORY");
    const ownUnknown = unknowns.some(u => u.symbol === symbol || u.symbol === null);
    item.realizedPricePnlUsd = item.pricePnlUsd;
    item.unrealizedPricePnlUsd = position.qty * (marks[symbol] - position.averagePrice);
    item.totalFundingCostUsd = ownUnknown ? null : item.actualFundingCostUsd + item.extraFundingCostUsd;
    item.netPnlUsd = ownUnknown ? null : item.pricePnlUsd + item.unrealizedPricePnlUsd
      - item.feesUsd - item.actualFundingCostUsd - item.extraFundingCostUsd;
  }
  const firstUnknownMs = unknowns.length ? Math.min(...unknowns.map(u => u.atMs)) : null;
  for (const row of daily.values()) row.netPnlUsd = firstUnknownMs !== null
    && Date.parse(`${row.date}T00:00:00Z`) + DAY >= firstUnknownMs ? null : row.indicativeNetPnlUsd;
  const known = unknowns.length === 0;
  if (!known) {
    equity[equity.length - 1]!.equityUsd = null; equity[equity.length - 1]!.liquidationEquityUsd = null;
  }
  return { version: "portfolio-hourly-replay-v1", scenario, startMs, endMs,
    inputReceipts: Object.fromEntries((["bars", "funding", "targets", "rules"] as const).map(key => [key,
      { sha256: createHash("sha256").update(JSON.stringify(input[key])).digest("hex"),
        records: Array.isArray(input[key]) ? input[key].length : 2 }])),
    accountingMode: "SIGNED_ARCHIVED_ABSOLUTE_FUNDING_WITH_EXPLICIT_TIMESTAMP_SCENARIO",
    fundingTimestampConventionVerified: false, allPathsKnown: known,
    netPnlUsd: known ? previousEquity - state.initialEquityUsd : null,
    indicativeNetPnlUsd: previousEquity - state.initialEquityUsd,
    maximumDrawdownUsd: known ? maximumDrawdown : null,
    maximumLiquidationDrawdownUsd: known ? liquidationDrawdown : null,
    totalFeesUsd: state.totalFeesUsd, totalFundingCostUsd: known ? state.totalFundingCostUsd : null,
    knownFundingCostUsd: state.totalFundingCostUsd, cashFundingDebitUsd, cashFundingCreditUsd,
    totalTurnoverUsd: state.totalTurnoverUsd, totalSlippageUsd: SYMBOLS.reduce((sum, s) => sum + perAsset[s].slippageUsd, 0),
    maximumGrossExposureUsd, meanGrossExposureUsd: exposureHourUsd / ((endMs - startMs) / HOUR),
    zeroVolumeNoFills: attempts.filter(a => a.status === "ZERO_VOLUME_UNFILLED").length,
    equity, daily: [...daily.values()], plans, fills, fundingReceipts, attempts, unknowns, perAsset, finalState: state,
    limitations: ["Hourly open fill proxy does not verify trade-level liquidity or actual receipt latency.",
      "Zero-volume marks are indicative; intrahour drawdown is not measured.",
      "Historical rules use supplied instrument constraints; funding timestamp interpretation remains unresolved.",
      "Missing funding and exposed price paths are unknown; indicative values omit unknown cash flows.",
      "Orders target a 12 USD gross cap at adjustment checks; intervening price changes can raise exposure."] };
}
