# Sequential drift/CUSUM development result

The best of four fixed CUSUM variants lost money during development. It produced an entry and a completed trade, but it did not solve the profit problem. The frozen choice for the common later-window comparison is **cusum_l28_h6**, selected mechanically by the preregistered development stress utility. This is a comparison candidate, not an activation recommendation.

Development covers 2025-01-01 through 2025-06-30. Capital is $10,000, entry budget at most $1,000, long/cash only, and execution/accounting comes from the common evaluator. Every fixed variant tested is shown below; no additional thresholds were tried after seeing these results.

| Variant | Base net P&L | Stress net P&L | Stress close drawdown | Stress closed trades | Selection utility |
|---|---:|---:|---:|---:|---:|
| cusum_l14_h4 | -$126.26 | -$133.67 | $229.05 | 1 | -$248.19 |
| cusum_l14_h6 | -$101.98 | -$126.82 | $230.86 | 1 | -$242.25 |
| cusum_l28_h4 | -$152.52 | -$61.36 | $229.05 | 1 | -$175.89 |
| **cusum_l28_h6** | **-$128.97** | **-$53.95** | **$230.86** | **1** | **-$169.38** |

Selection utility is stress net P&L minus half stress maximum daily-close liquidation drawdown. The selected variant's base account return was -1.290%; stress account return was -0.539%. Expressing these as percentages of the $1,000 entry budget would give -12.90% and -5.39%, respectively, and must not be confused with account returns.

The selected variant opened one ETH/USD position and held it for 42 days. Both executions lost on price before fees; actual modeled fees were $14.96 in base and $19.46 in stress. The slower stress fill happened to receive better market prices during this particular trade, so stress lost less despite higher costs. That favorable timing difference is not evidence that increased fees improve a strategy. All selected-variant development months were nonpositive.

The mathematics accumulates standardized directional evidence with a 28-day EWMA, enters above cumulative evidence 6 and a 30-day extrapolated drift cost hurdle, and exits on negative evidence 3, nonpositive estimated drift, or a 90-day holding limit. It holds one asset until exit. [NIST's CUSUM discussion](https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc323.htm) supports the change-detection recurrence; translating that recurrence into a tradable edge is the unproven hypothesis tested here.

The cost hurdle was insufficient: backward-looking positive drift did not reliably predict a move large enough to overcome a subsequent reversal and execution costs. One trade per six months also provides very little statistical information about expected profitability. No variant is profitable in this development window.

The implementation passed all 240 prefix-causality checks on a synthetic path for each variant, stayed cash through its warmup, entered a sustained rising path, and exited a falling path. These tests demonstrate causal signal behavior, not investment performance. Independent accounting review found a completed-volume finalization boundary issue in common.py; the root changed sizing from bar i-1 to i-2 before later-window evaluation. Development was rerun against that correction and results were unchanged.

The trend agent did not load or inspect validation or final-period model outcomes. The root owns those evaluations and the common qualification checks. Daily OHLC data does not verify historical book liquidity, exchange acceptance, or executable intraday exits; the historical dates have also been reused by earlier studies. All files are research artifacts; no trading runtime or dashboard was changed.

Artifacts: `specification.md` fixes the mathematics and four variants; `candidate.py` reproduces development selection; `development-results.json` records all variant metrics; `selection.json` records the frozen ID, parameters, and hashes; `development-audit.json` records selected-variant daily equity and trades plus common/data fingerprints; `synthetic-checks.json` records causal behavior checks.
