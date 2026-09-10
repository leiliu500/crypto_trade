import { applySpotFill, createSpotAccount, markSpotAccount } from "./account.js";
import { WEEK_MS } from "./data.js";
import { reconstructSpotTrend } from "./signal.js";
import { SPOT_TREND_SPEC as S } from "./spec.js";
export function replaySpotTrend(input) {
    if (!Number.isSafeInteger(input.startMs) || !Number.isSafeInteger(input.endMs) || input.startMs >= input.endMs
        || !["trend", "buy-hold", "cash"].includes(input.policy) || !["base", "stress"].includes(input.scenario))
        throw new Error("INVALID_SPOT_REPLAY_SCOPE");
    for (let i = 0; i < input.bars.length; i++) {
        const b = input.bars[i];
        if (!Number.isSafeInteger(b.openMs) || b.openMs % WEEK_MS !== 0 || b.endMs !== b.openMs + WEEK_MS
            || b.availableAtMs !== b.endMs + 60_000 || ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite)
            || Math.min(b.open, b.high, b.low, b.close) <= 0 || b.volume < 0 || b.low > Math.min(b.open, b.close)
            || b.high < Math.max(b.open, b.close) || i > 0 && b.openMs !== input.bars[i - 1].endMs)
            throw new Error("INVALID_SPOT_REPLAY_BARS");
    }
    const bars = input.bars.filter(b => b.openMs >= input.startMs && b.endMs <= input.endMs);
    if (bars.length < 2)
        throw new Error("SPOT_REPLAY_TOO_SHORT");
    const costs = S.scenarios[input.scenario], orders = [], weekly = [];
    let account = createSpotAccount(S.initialCashUsd), peak = S.initialCashUsd, closePeak = S.initialCashUsd, priorEquity = S.initialCashUsd;
    let maxDrawdown = 0, downsideEnvelope = 0, closedEpisodes = 0, halted = false, investedWeeks = 0;
    let maxNotional = 0, benchmarkEntered = false;
    const initialEntryBudgetUsd = Math.min(S.maximumEntryPrincipalUsd, S.entryPrincipalEquityFraction * S.initialCashUsd);
    const roundPrice = (price, side) => {
        const adverse = price * (1 + (side === "buy" ? 1 : -1) * costs.adverseSlippageBps / 10_000);
        return (side === "buy" ? Math.ceil(adverse / S.historicalTickSize) : Math.floor(adverse / S.historicalTickSize)) * S.historicalTickSize;
    };
    const floorQuantity = (q) => Math.floor(q / S.historicalLotSize) * S.historicalLotSize;
    const transact = (side, quantity, bar, reason) => {
        const price = roundPrice(bar.open, side);
        // A retrospective availability check, not evidence of depth available at the opening timestamp.
        if (bar.volume === 0 || quantity < S.historicalMinimumQuantity || quantity * price < S.historicalMinimumNotionalUsd)
            return false;
        const fill = { id: `${S.version}:${input.policy}:${input.scenario}:${bar.openMs}:${orders.length}`,
            side, quantity, price, feeBps: costs.feeBps, timestampMs: bar.openMs };
        const oldQuantity = account.quantity;
        account = applySpotFill(account, fill);
        if (oldQuantity > 0 && account.quantity === 0)
            closedEpisodes++;
        orders.push({ ...fill, reason });
        return true;
    };
    const flatten = (bar, reason) => account.quantity > 0 && transact("sell", account.quantity, bar, reason);
    for (let i = 0; i < bars.length; i++) {
        const bar = bars[i], terminal = i === bars.length - 1;
        const signal = reconstructSpotTrend(input.bars, bar.openMs - costs.additionalDelayWeeks * WEEK_MS);
        const openingMark = markSpotAccount(account, roundPrice(bar.open, "sell"), costs.feeBps);
        peak = Math.max(peak, openingMark.liquidationEquityUsd);
        if (input.policy === "trend" && openingMark.liquidationEquityUsd <= peak * (1 - S.maximumAccountDrawdownFraction))
            halted = true;
        if (terminal)
            flatten(bar, "TERMINAL_LIQUIDATION");
        else if (input.policy === "trend" && (halted || signal.state === "cash"))
            flatten(bar, halted ? "ACCOUNT_DRAWDOWN_HALT" : signal.reason);
        else if (input.policy === "trend" && account.quantity > 0) {
            const cap = Math.min(S.maximumMarkedNotionalUsd, Math.max(0, openingMark.liquidationEquityUsd) * S.maximumMarkedEquityFraction);
            // A scheduled reduction, not a promise that exposure never crossed this limit during the week.
            if (account.quantity * bar.open > cap) {
                const keep = floorQuantity(cap / bar.open), reduce = account.quantity - keep;
                if (keep >= S.historicalMinimumQuantity && keep * roundPrice(bar.open, "sell") >= S.historicalMinimumNotionalUsd
                    && reduce * roundPrice(bar.open, "sell") >= S.historicalMinimumNotionalUsd && reduce >= S.historicalMinimumQuantity)
                    transact("sell", reduce, bar, "MARKED_NOTIONAL_CAP");
                else
                    flatten(bar, "MARKED_NOTIONAL_CAP_REMAINDER");
            }
        }
        else if (!terminal && !halted && account.quantity === 0
            && (input.policy === "trend" && signal.state === "long" || input.policy === "buy-hold" && !benchmarkEntered)) {
            const equity = markSpotAccount(account, bar.open, costs.feeBps).liquidationEquityUsd;
            const budget = Math.min(account.cashUsd, S.maximumEntryPrincipalUsd, input.policy === "buy-hold" ? initialEntryBudgetUsd : S.entryPrincipalEquityFraction * Math.max(0, equity));
            const price = roundPrice(bar.open, "buy");
            const quantity = floorQuantity(budget / (price * (1 + costs.feeBps / 10_000)));
            if (transact("buy", quantity, bar, input.policy === "buy-hold" ? "BUY_HOLD_START" : signal.reason))
                benchmarkEntered = true;
        }
        const mark = markSpotAccount(account, roundPrice(bar.close, "sell"), costs.feeBps);
        const low = markSpotAccount(account, roundPrice(bar.low, "sell"), costs.feeBps).liquidationEquityUsd;
        downsideEnvelope = Math.max(downsideEnvelope, peak - low);
        peak = Math.max(peak, mark.liquidationEquityUsd);
        closePeak = Math.max(closePeak, mark.liquidationEquityUsd);
        maxDrawdown = Math.max(maxDrawdown, closePeak - mark.liquidationEquityUsd);
        maxNotional = Math.max(maxNotional, account.quantity * bar.high);
        if (account.quantity > 0)
            investedWeeks++;
        weekly.push({ openMs: bar.openMs, endMs: bar.endMs, signalAvailableAtMs: signal.availableAtMs,
            signalState: signal.state, signalReason: signal.reason, quantity: account.quantity, cashUsd: account.cashUsd,
            liquidationEquityUsd: mark.liquidationEquityUsd, weeklyNetUsd: mark.liquidationEquityUsd - priorEquity,
            markedNotionalUsd: account.quantity * bar.close, weeklyLowLiquidationEquityUsd: low });
        priorEquity = mark.liquidationEquityUsd;
    }
    const netPnlUsd = priorEquity - S.initialCashUsd;
    const hurdle = initialEntryBudgetUsd * .05 * (input.endMs - input.startMs) / (365.25 * 86_400_000);
    return { version: S.version, policy: input.policy, scenario: input.scenario, startMs: input.startMs, endMs: input.endMs,
        firstEligibleExecutionOpenMs: bars[0].openMs, finalEligibleExecutionOpenMs: bars.at(-1).openMs,
        initialCashUsd: S.initialCashUsd, initialEntryBudgetUsd, finalCashUsd: account.cashUsd, finalQuantity: account.quantity,
        netPnlUsd, realizedNetUsd: account.realizedNetUsd, feesUsd: account.feesUsd, closedEpisodes,
        netReturnOnInitialEntryBudgetFraction: netPnlUsd / initialEntryBudgetUsd,
        drawdownOnInitialEntryBudgetFraction: maxDrawdown / initialEntryBudgetUsd,
        netAccountReturnFraction: netPnlUsd / S.initialCashUsd,
        buys: orders.filter(o => o.side === "buy").length, sells: orders.filter(o => o.side === "sell").length,
        turnoverUsd: orders.reduce((sum, o) => sum + o.quantity * o.price, 0), investedWeeks,
        maximumMarkedNotionalUsd: maxNotional, maxWeeklyCloseDrawdownUsd: maxDrawdown, sampledPeakToWeeklyLowUsd: downsideEnvelope,
        accountDrawdownHalted: halted, terminalFlat: account.quantity === 0,
        fivePercentInitialBudgetHurdleUsd: hurdle, netAboveAllocatedCapitalHurdleUsd: netPnlUsd - hurdle,
        orders, weekly };
}
/** Dependent observations: calendar-week moving blocks, never a trade-count confidence claim. */
export function bootstrapSpotWeeks(values, blockWeeks, repetitions, seed, quantile) {
    if (!Number.isInteger(blockWeeks) || blockWeeks < 1 || !Number.isInteger(repetitions) || repetitions < 1
        || !Number.isFinite(quantile) || quantile <= 0 || quantile >= 1 || !values.every(Number.isFinite))
        throw new Error("INVALID_SPOT_BOOTSTRAP");
    if (values.length < blockWeeks)
        return { lowerMeanWeeklyNetUsd: null, completeWeeks: values.length, blocks: 0 };
    let random = seed >>> 0;
    const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 2 ** 32; };
    const means = [], blocks = values.length - blockWeeks + 1;
    for (let r = 0; r < repetitions; r++) {
        let sum = 0, count = 0;
        while (count < values.length) {
            const start = Math.floor(next() * blocks);
            for (let j = 0; j < blockWeeks && count < values.length; j++, count++)
                sum += values[start + j];
        }
        means.push(sum / values.length);
    }
    means.sort((a, b) => a - b);
    return { lowerMeanWeeklyNetUsd: means[Math.floor((means.length - 1) * quantile)], completeWeeks: values.length, blocks };
}
//# sourceMappingURL=replay.js.map