# Profitability-first systematic rebuild

The previous sizing change is already separate from this study: the paper order ceiling is the smaller of $1,000 and 1% of current equity, with risk, exchange and liquidity constraints able to reduce it. A larger order multiplies both gains and losses. It cannot turn a negative net return into a positive one.

The replacement is a **research candidate**, not an activated profitable strategy. It must earn economic approval; an executable order, a positive gross move, or a successful broker test does not provide that approval. No future profit is guaranteed.

The first frozen candidate failed all eight economic runs. Under the baseline funding interpretation, 493 trades lost $1,021.72 in 2024 and 244 trades lost $803.78 in January–June 2025. Both assets lost money individually. Adverse execution prices produced losses even before explicit fees and funding, so changing the notional cap cannot repair this candidate's edge. No parameter was retuned after seeing these outcomes, and no new strategy was activated. The original system's profitability and entry-selection problem is not resolved by this rejected candidate. See the [complete frozen report](../reports/systematic-rebuild-2026-09-09/economic-screen/report.md).

## Fixed hypothesis

The source of truth is `src/systematic/spec.ts`. The candidate uses 192 contiguous completed hourly candles. Its direction comes from EMA(16) minus EMA(64), divided by ATR(32), with absolute strength at least 0.5 and the last close agreeing with the slow trend. Missing candles, unfinished candles, weak trends and conflicting prices produce explicit no-entry results.

The initial stop is 2 ATR, the net target is 4 ATR, the net trailing allowance is 2 ATR after a 1R activation, and the maximum holding period is 72 hours. A six-hour cooldown follows closure. These are declared hypotheses, not estimated expected returns. Historical momentum research motivates testing the hypothesis; it does not validate this particular implementation. [Liu and Tsyvinski, NBER](https://www.nber.org/papers/w24877).

## Position and execution mathematics

Risk sizing uses the existing 0.1% equity risk budget, reduced with drawdown and volatility. Maximum loss includes the stop, estimated transaction costs and a jump allowance. It also respects the $1,000 / 1% equity ceiling and venue quantity increments. There is no fabricated Kelly edge or positive expected-value estimate.

Entry liquidity is cumulative depth on the chosen trade side within a three-basis-point price collar. The order may consume at most 1% of that depth. A thin first bid does not disqualify a long trade with adequate executable ask depth. Depth beyond the price collar cannot rescue an otherwise invalid order.

The order uses a marketable limit IOC, with a 250 ms minimum delay and a two-second lifetime. The paper broker executes on a later valid quote and respects the limit price. An unfilled entry expires. Stops can slip or fail to fill during gaps; modeled loss is not a guaranteed maximum loss.

Entry feasibility reserves both trading fees, adverse execution on both legs, spread, and funding. The cost-to-stop ratio must be at most 25%. This ratio tests whether the geometry is economically plausible, not whether the strategy has positive expectancy. Baseline fees are five basis points per side, consistent with the starting futures tier in the [Kraken fee schedule](https://www.kraken.com/features/fee-schedule).

Position protection uses a cash-flow ledger. Actual fills include their execution fees; spread and impact are already in execution prices. Net targets and trailing floors preserve the original entry basis through partial exits. Missing recovery evidence triggers protective closure rather than reconstructing an unobserved profit peak.

## Profitability acceptance

The source of truth for declared acceptance thresholds is `src/systematic/validation.ts`. The historical protocol freezes sources, configuration, windows, scenarios and thresholds before calculating results. No parameter search selects a winning variant.

The 2024 and January–June 2025 windows have been inspected in previous research and are **development evidence**, not untouched holdouts. January–July 2026 remains reserved. Historical results must include all fees, adverse execution and actual recorded funding, with explicit assumptions about funding timestamps. Missing funding makes the affected economic result unknown. Flat cash has zero trading P&L and is the minimum comparator.

Approval requires positive net results under baseline and cost stress in both chronological windows, sufficient trade and calendar coverage, acceptable drawdown, and uncertainty estimates that preserve blocks of dependent days. Passing reused historical tests alone cannot activate the strategy: prospective evidence must use frozen matching source/configuration, actual order books and complete financing accounting.

The hourly replay is an execution proxy. Candles cannot prove executable depth, sub-hour latency, stop/target ordering, or precise intrabar fills. A separate recorded-order-book audit checks plumbing and leaves unresolved positions unresolved; it cannot establish profitability from a few minutes of data.

## Existing paper accounting limitation

The running paper broker records price P&L and execution fees. It does not yet reconcile actual funding cash flows. The funding reserve in a candidate position is an estimate, not observed financing. Prospective funded-net-profit approval therefore remains unavailable until actual holding-interval funding is persisted and reconciled, including outages. The economic replay can account for the historical funding data without claiming the running broker already does so.

## Reproduction

Use `npm run research:systematic -- --help` for the economic study. The execution audit accepts a recording and a new output directory:

```sh
npm run research:systematic:execution -- /path/to/events.jsonl.gz reports/new-book-audit
```

The execution audit uses an in-memory broker and public candle/instrument reads. It sends no orders to the running engine or exchange. Its immutable input artifact records the recording hash, candle inputs, current instrument rules and the limits of historical availability assumptions.
