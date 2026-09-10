# Independent validation review — 10 September 2026

The existing evidence does not demonstrate a profitable replacement for the running spot system. A wider daily-data search can rank exploratory candidates, but it cannot create an untouched holdout from already reused history. This review contributes 25 distinct validation interventions, V01–V25, in `validation-hypotheses.json`; one agent produced them. Their status concerns the intervention or evidence requirement, not a demonstrated profitable trading strategy.

## What the current evidence says

The prior independent daily-family study used 720 completed BTC/USD and ETH/USD daily bars, with January–June 2025 development, July–December 2025 validation, and January–9 September 2026 comparison. Its development/validation-selected rotation lost $98.00 in the last period at base costs and $159.49 under combined stress. Trend lost $16.95 and OU reversion lost $186.39 at base costs. All three remained negative in the zero-commission diagnostic. This rejects reducing fees alone as a demonstrated solution for those candidates. Sources: `reports/parallel-strategy-study-2026-09-10/comparison.json`, `sensitivity.json`, `report.md`.

The earlier weekly BTC study reports $1,175.60 net over 505 calendar weeks with $100,000 starting cash and an initial $100 fee-inclusive purchase budget, 11 completed episodes, and $584.28 weekly-close drawdown. That net is approximately 1.176% of starting account cash across the whole historical span, not an annual return or a return on a fully invested $100,000. The reported 13-week-block lower 5% mean weekly net is negative ($-0.48). That study explicitly says profitability remains unvalidated. Its fixed-unit buy-and-hold benchmark earned more dollars with substantially greater exposure drift and drawdown. Source: `reports/new-spot-system-2026-09-10/historical-study/report.md`.

The studies differ in cadence, warmup, initial cash, entry budget, risk rules, and terminal valuation. Their dollar outcomes should not be ranked against each other.

## Accounting and chronology audit

`reports/parallel-strategy-study-2026-09-10/common.py` currently implements funded long-or-cash accounting correctly for its declared proxy model: buys debit principal and entry fees, sales credit proceeds after exit fees, rotations sell before funding a purchase, quantity floors to lots, prices round adversely to ticks, entries honor minimums, daily marks include hypothetical exit costs, and terminal cash equals the sum of closed-trade net P&L. An unchanged asset target does not add inventory. The existing audit artifact records ten groups, including 96 target prefix checks across all 12 prior variants. I inspected that code and artifact; I did not rerun its write-producing script against the old study.

Daily targets from bar i fill no earlier than open i+2 under the declared 60-second post-close finalization rule. Entry volume uses i-2 at the execution open, which is causal. The earlier i-1 error was already corrected and documented. Per-period replay starts flat and discards target instructions from before the period; warmup features may use earlier completed data. This is a declared reset experiment, not one continuous portfolio across the three windows.

Material boundaries:

- The maximum entry is hardcoded as `min(budget, cash * 0.1, cash, previous finalized volume notional * 0.001)`. Raising `budget` beyond 10% cash alone cannot increase the allocation. It equals an equity fraction at entry because this one-position model is flat immediately before each purchase.
- There is no common.py marked-exposure reduction or account-drawdown halt. Appreciation can carry inventory above its initial budget. Runtime `src/spot-trend/spec.ts` instead uses a 0.1%-of-equity entry fraction, $1,000 absolute entry/marked caps, a 1%-equity marked cap, and a 5% account drawdown halt.
- Daily open fills, fixed adverse prices, and historical daily-volume participation are proxies. Sales always fill in common.py, without sell-side participation, partial liquidity, or failed liquidation. The current funded paper order system has richer IOC/partial-fill behavior.
- Daily closes provide sampled drawdown. The prior-peak-to-daily-low diagnostic still omits within-day high-to-low peak paths and must not be called a worst-case intraday bound.
- common.py force-sells at the last close; weekly replay force-sells at the last eligible weekly open. Align valuation endpoints before comparison. A forced terminal sale must not be counted as a strategy-generated exit or as verified executable depth.
- Weekly `replay.ts` checks the current week's positive total volume when filling at its open, explicitly described as retrospective. That condition is not available at the opening timestamp; it must remain disclosed as a proxy limitation. It does not establish live order acceptability.
- The daily dataset's approximately 103 days before January 2025 are insufficient to recreate 40 completed native weeks of runtime warmup. The new daily screen cannot claim exact runtime parity.

## Protocol for the new 100-configuration screen

1. Save the exact 100 IDs, families, parameters, data/source hashes, evaluator hash, cost scenarios, windows, objective and tie break before evaluating outcomes. Retain failed and zero-trade configurations. Call them configurations; agent counts are separate.
2. Use the existing three calendar windows, visibly labeled reused exploratory data. Rank on January–June 2025 only, using a fixed conservative score such as the minimum scenario value of net P&L minus half close drawdown. Freeze that ranking before later-period evaluation. Later results cannot retroactively select a purported out-of-sample winner.
3. Keep native synchronized daily inputs, causal prefixes, i+2 earliest fill, and i-2 volume availability. Test all 100 target generators on multiple truncated histories. Hash and inspect generated outputs.
4. Run four scenarios: base 80-bps fee/3-bps adverse price/lag 2; cost stress 100/10/2; delay stress 80/3/3; combined 100/10/3. These are configured paper assumptions, not verified account fees. Report each scenario, since delay can improve prices.
5. Replay cash, BTC buy-and-hold, and ETH buy-and-hold using identical cash, entry cap, costs, delay and terminal convention. Calculate paired daily excess returns. Include absolute account P&L, account return and allocation denominator so small exposure is visible.
6. Retain a risk/return frontier for net P&L, close drawdown and sampled-low drawdown, plus turnover, fee burden, rejected orders, active days, strategy exits, forced exits, largest-episode contribution and monthly results. A frontier or least-losing outcome is not evidence of positive expectancy.
7. Treat bootstrap, parameter-neighbor stability and subperiod checks as descriptive fragility diagnostics. Reused dates, 100 new trials, earlier unknown searches and rare independent episodes prevent strong confidence claims. Cash days belong in calendar resampling.
8. A selected exploratory candidate may be a subject for a future frozen paper experiment. Do not deploy, submit real orders or enlarge runtime risk based solely on this screen. Future measurements should include actual applicable fees, timestamped books, requests, fills, rejections and shortfall. The research screen can be completed without those future observations; profitability validation cannot.

The completed screen follows these principles: unchanged common.py limits, three reused windows, four separate scenarios, retained 100 configurations, development-only selection and no automatic promotion. Its full implementation audit is below.

## Independent audit of the completed screen

`screen-audit.py` completed successfully and retained `screen-audit.json`. It verified every source/artifact hash, including original raw daily responses; all 100 configuration IDs; **900 prefix-invariance checks**; **400 development replays using only pre-July-2025 data**; the deterministic development ranking and lock; **1,200 independently reconciled order/trade/daily ledgers**; all **36 benchmark runs**; and nomination, selected-row and hindsight-diagnostic consistency. The ledger audit independently rebuilt signed cash flows and inventory, checked both fees, timing, terminal flatness, daily/trade P&L and daily-close drawdown. No direct future-data leakage or ledger accounting defect was found within the declared daily proxy model.

The selected configuration is `sma_eth-040`. Its January–June 2025 base net is $377.80; July–December 2025 is $335.75; January–9 September 2026 is $227.56. Combined cost/delay-stress net for those windows is $372.86, $303.85 and $159.58. These are three reset accounts with $10,000 starting cash and at most $1,000 entries; their profits should not be added and described as a continuous portfolio return.

**No configuration passes the frozen exploratory screen.** The selected rule has only nine combined later episodes per scenario (four plus five), below the ten-episode floor, and its later-2025 sampled-low drawdown is $504.45 base and $517.04 combined, above $500. The second all-window-positive configuration, `sma_eth-050`, also fails the episode floor. Passing these heuristic floors would still not establish prospective profitability.

There are 100 registered configurations, 94 unique observed target paths on this dataset, ten asset/family groups, and six underlying formula classes. Two retained configurations, `pullback_btc-090` and `pullback_eth-090`, are structurally inactive: their entry condition requires price above the 90-day trend and below the same 90-day mean. They should be shown as rejected zero-activity configurations. Their retention is transparent; they must not be presented as productive independent ideas or silently replaced after outcomes are known.

The positive ETH 40-day result is a concrete candidate for a subsequently frozen experiment. It is a stronger exploratory lead than the prior all-losing daily-family comparison, while its reused data, sparse episodes, drawdown and daily fill assumptions remain unresolved. This audit validates reproduction and accounting; it does not validate future profits.

The supplemental `analyze.py` diagnostics also passed independent review. I reconciled all four continuous-account ledgers and reproduced their 12 continuous benchmark runs. With the same already-selected rule, January 2025–9 September 2026 continuous net is $948.41 base (9.484% of initial account cash) and $841.40 combined (8.414%), with ten episodes across the entire period including development. Daily-close drawdown is $667.25 base/$735.94 combined; sampled-low drawdown is $705.84/$752.57. This continuous experiment has materially more drawdown than the reset-window view, and its ten full-period episodes do not satisfy the original requirement for ten later-period episodes.

I independently constructed sampled calendar paths for all 12 paired bootstrap comparisons, 20,000 repetitions each, and reproduced their stated nominal and 100-trial-adjusted lower bounds. All reported lower bounds are negative. The 100-trial extreme tail has approximately ten repetitions below it; with sparse episodes and unknown earlier searches, these are descriptive uncertainty diagnostics. Removing the largest winner arithmetically makes both later-period base nets negative ($-287.34 in later 2025; $-128.14 in recent 2026), confirming concentration. That subtraction is not a counterfactual replay. Supplemental source and output hashes are retained in `screen-audit.json`.

## Verification completed

Ran this meaningful existing subset against the current workspace:

```bash
npx tsx --test test/spot-trend-account.test.ts test/spot-trend-data.test.ts test/spot-trend-replay.test.ts test/spot-trend-orders.test.ts test/spot-trend-paper.test.ts test/spot-trend-continuous-entry.test.ts
```

Result: **78 passed, 0 failed, 0 skipped**; exit code 0. The tests cover receipt cash reconciliation, fee-inclusive funding, causal bar availability, missing-data rejection, future-prefix invariance, fresh-book depth/lot constraints, IOC and partial orders, restart idempotence, runtime cap reductions, and continuous-entry fee behavior. Synthetic profitable round trips establish accounting behavior only; they are not empirical evidence of strategy profitability.

No engine, runtime configuration, deployment, account, old report or exchange order was changed by this review. Owned outputs are this report, `validation-hypotheses.json`, `screen-audit.py` and `screen-audit.json`.
