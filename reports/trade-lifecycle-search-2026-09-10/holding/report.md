# BTC and ETH holding permissions

Three permissions per asset are registered before any new holding performance is evaluated. They change how long an existing funded position may retain a weakened parent thesis; they do not create an entry edge or establish profitable holding periods. The interface is [candidates.py](candidates.py), with exact timing, accounting and priority semantics in [registry.json](registry.json).

| Asset | Permission | Minimum completed daily bars | Consecutive daily thesis-loss observations | Maximum completed daily bars |
|---|---|---:|---:|---:|
| BTC | Immediate thesis exit | 0 | 1 | None |
| BTC | Weekly persistence | 7 | 7 | None |
| BTC | Bounded thesis | 0 | 1 | 84 |
| ETH | Immediate thesis exit | 0 | 1 | None |
| ETH | Daily persistence | 2 | 2 | None |
| ETH | Bounded thesis | 0 | 1 | 40 |

The immediate permission preserves the parent thesis response as a control. BTC's persistence permission allows one week for a lost weekly thesis to recover. Its seven repeated daily states are a time allowance, not seven independent weekly signals. ETH's persistence permission requires two daily observations, the smallest confirmation alternative beyond an immediate response. Its time budget is one existing 40-day signal lookback; BTC's is twelve complete weekly opportunities. These are coarse, predeclared hypotheses tied to the parent signal clocks, not estimates chosen from winning historical trades. The same asset could need different holding rules under a different entry thesis.

Start the holding clock at the first actual inventory-acquiring fill. A pending entry is not a position. Only distinct, finalized daily bars that end after that fill advance the clock or the thesis-loss streak. For example, an entry at open day k has age zero when bar k−1 finalizes 60 seconds later; bar k becoming available the next day gives age one. Restoring the long thesis resets the loss streak. A duplicate observation cannot add confirmation, and pre-entry cash states cannot be carried into the new position. Partial exits retain the original position clock until inventory is actually zero.

Risk exits always override minimum holding time. A maximum-age deadline also overrides thesis retention and requests an exit even if the thesis stays long. Neither deadline promises a fill at that price or time: future execution, rejected orders and residual inventory remain the execution engine's responsibility. Committed pending exits remain committed; a rebound in the thesis does not silently cancel them. No same-day re-entry follows a completed sale under the shared lifecycle contract.

Holding permission keeps the existing quantity unchanged, subject to independent risk reductions. It must never add to a loss, compound an entry budget, borrow cash or turn repeated signals into more inventory. The actual BTC paper runner separately enforces marked exposure and account drawdown controls; ETH40 retains its frozen funded entry cap and no-additions rule. A normalized holding comparison must not imply those different production controls have become identical.

The accounting must carry real cash, fees and remaining units. Net liquidation value uses an executable bid after expected exit costs when a suitable fresh quote exists. A missing quote means an unavailable mark, while historical daily OHLC values remain labeled screening proxies. A forced final-window sale is an accounting convention, not a naturally completed trading thesis.

Short holding periods can repeatedly incur the two-sided trading-cost hurdle. Long holding periods can let a persistent move develop, but also retain a failed thesis, enlarge reversals and tie up capital. Already-paid entry fees are sunk costs: recovering them is not a reason to suppress a required exit. The earlier [execution audit](../../asset-system-search-2026-09-10/execution/report.md) derives the registered cost hurdle; it does not establish that a longer or shorter duration earns an edge.

This module contains configuration only, so no duplicate reference engine or P&L-based selection was added. The chronological engine should test the actual implementation against at least these cases: a risk exit on holding day zero; a BTC loss streak of six versus seven observations; an ETH streak of one versus two; a recovered thesis resetting either streak; duplicate and pre-entry observations not advancing it; exact day-84/day-40 time boundaries; and partial exits preserving the age. These are behavioral checks for the shared engine, not historical optimization criteria.

The reused historical data provide no untouched holdout. All six permissions are frozen before the new comparison; no performance was calculated by this specialist, and no existing runtime, source, configuration, deployment or paper account was changed.
