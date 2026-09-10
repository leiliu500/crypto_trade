No reviewed strategy is established as a profitable replacement. Root's completed screen nominates the development-selected **40-day ETH moving-average rule** as the strongest candidate for a subsequent frozen research experiment. It earned positive historical net returns across the tested scenarios but failed the declared episode-count and drawdown requirements. The independent concentration and neighboring-parameter review below explains why it remains unvalidated.

This review was completed by **one strategy research agent**. Its **25 distinct records** are hypotheses and interventions, not 25 independent agents or 25 newly executed backtests. The machine-readable [strategy ledger](strategy-hypotheses.json) contains the rationale, evidence, test and likely impact of every record. Eight records support research controls or diagnostics, seven reject specified promotion/sufficiency claims, and ten need new data or evaluation. “Supported” does not mean a profitable trading edge has been proven.

The strongest local evidence is the earlier [parallel strategy comparison](../parallel-strategy-study-2026-09-10/report.md). All three frozen candidates lost after costs during 1 January–9 September 2026: CUSUM **−$16.95**, OU reversion **−$186.39**, and BTC/ETH rotation **−$98.00**. All also lost under the reported zero-commission diagnostic. Rotation had won the prior validation selection, but its validation net depended on one ETH winner. Promoting CUSUM because it later lost least would add another selection decision using an already inspected test period.

The existing [40-week BTC strategy](../new-spot-system-2026-09-10/historical-study/report.md) is more promising over its much longer historical sample: **+$1,175.60** base net, **11 episodes**, and a **−$0.48 lower bootstrap mean weekly net bound**. That is positive historical profit with unresolved uncertainty. Its starting account, initial exposure, later cap reductions and horizon differ from the daily comparison, so the dollar figures cannot rank the strategies directly. Buy-and-hold earned more in the long historical window while suffering greater sampled drawdown. An exact common benchmark must distinguish timing skill from lower exposure.

The verified current formula uses the latest **40 completed native weeks**. It enters above `SMA40 * 1.0166`, exits at or below `SMA40`, and retains its state inside that interval. See [specification](../../src/spot-trend/spec.ts) and [signal code](../../src/spot-trend/signal.ts). A short daily dataset is insufficient to warm that exact rule for early comparison dates; replacing it silently with 280 daily bars changes the strategy. Use saved native weekly history for the exact comparison, or clearly mark that benchmark unavailable for the selected start date.

The ledger preserves a bounded alternative as **S04: BTC majority trend with hysteresis**. Root's later screen gives ETH40 stronger research priority; S04 is not a coequal winner. Its proposed formula is: Compute three moving averages over 30, 60 and 90 completed daily closes, including the decision close. With base fee `f = 0.008` and adverse price adjustment `s = 0.0003`, define:

```
b = ((1 + f) * (1 + s)) / ((1 - f) * (1 - s)) - 1
upper_votes = count(close > SMA_n * (1 + b)), n in [30, 60, 90]
lower_votes = count(close < SMA_n / (1 + b)), n in [30, 60, 90]
enter BTC when upper_votes >= 2
exit to cash when lower_votes >= 2
otherwise retain the previous target
```

Require 90 completed observations before voting. Keep `b` fixed while stress-testing transaction costs, so signal changes are not confused with execution-cost effects. The lower threshold is the reciprocal of the upper multiplier, producing equal log-distance bands. The band is a turnover-control heuristic; it is not a forecast that a trade will earn its break-even move.

Optional **S05** replaces the majority with one SMA90 under otherwise identical rules. This is a complexity control and counts as another tested variant. Freeze these exact rules before root's replay; do not search alternative windows or bands after observing results. Use the existing funded spot research evaluator's completed-bar delay, fee-inclusive budget, adverse ticks, minimum sizes and liquidation accounting. Evaluate separate same-delay cost and additional-delay scenarios, as a later fill can accidentally improve performance. Root owns the market replays. The independent diagnostics below were calculated from its saved ledgers; the exact S04 lower-band formula above was not replayed.

The economic motivation is limited but real: Liu and Tsyvinski found crypto-specific momentum predictability in their historical sample. That supports investigating trend effects, not asserting that this candidate, market period or fee level is profitable. [Risks and Returns of Cryptocurrency](https://www.nber.org/papers/w24877). Research on time-series momentum across futures and forwards supports a broader trend hypothesis, but its asset set and portfolio construction differ from funded BTC spot. [Time Series Momentum](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum).

A wider universe is deferred. Cross-sectional crypto factor research supplies a rationale for relative strength, while its long-short factors do not automatically transfer to a two-asset, long-only system. A serious broader test needs historical listings, delistings and tradable liquidity. [Common Risk Factors in Cryptocurrency](https://www.nber.org/papers/w25882). Volatility reduction is a separate risk intervention to test after signal nomination; evidence from other assets does not prove improved BTC net returns. [Volatility Managed Portfolios](https://www.nber.org/papers/w22208). Momentum can also undergo persistent losses in particular regimes, making sparse successful episodes weak evidence of stability. [Momentum Crashes](https://www.nber.org/papers/w20439).

The current public Kraken schedule lists Tier 1 spot maker/taker fees of **0.40% / 0.80%**; applicable account tier and product still require verification. A lower fee is useful only alongside valid fill assumptions and a sufficiently favorable signal. The prior zero-fee losses reject fee reduction as a sufficient solution for those paths. [Kraken fee schedule](https://www.kraken.com/features/fee-schedule). Daily candles cannot establish queue position, spreads, book depth or intraday exit paths. The OHLC API also limits recent observations and includes an unfinished last row that must be excluded. [Kraken OHLC documentation](https://docs.kraken.com/api-reference/market-data/get-ohlc-data).

The highest-value shared intervention is **S21 plus S25**: freeze one candidate and record every subsequent signal and rejection against synchronized executable quotes, then measure fee-inclusive returns, passive excess, exposure, turnover and winner concentration at predeclared checkpoints. Retain insufficient-evidence status when the number of independent episodes is too small. Sampling more model variations over already inspected history can manufacture an attractive maximum without creating an edge; every replay and parameter choice must remain in the trial registry. [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

The following index summarizes the review. Detailed tests and evidence paths are in the ledger.

| ID | Hypothesis or intervention | Status |
|---|---|---|
| S01 | Use cash as the absolute net-profit benchmark | supported |
| S02 | Use costed BTC buy-and-hold as the passive opportunity-cost benchmark | supported |
| S03 | Retain exact 40-week BTC trend as a nominated slow baseline | needs_data |
| S04 | BTC-only majority trend across three horizons with symmetric hysteresis | needs_data |
| S05 | Single BTC SMA90 with the same symmetric band as a complexity control | needs_data |
| S06 | Asymmetric Donchian breakout as an alternative trend entry mechanism | needs_data |
| S07 | Reduce trend exposure when trailing volatility rises | needs_data |
| S08 | Require persistent exit-and-reentry separation to suppress churn | needs_data |
| S09 | Promote the already-tested BTC/ETH 60-day rotation | rejected |
| S10 | Monthly rather than daily relative-strength decisions | needs_data |
| S11 | Fixed BTC/ETH basket without routine rebalancing | needs_data |
| S12 | Broader liquid-asset cross-sectional momentum | needs_data |
| S13 | Declare a blend of the three failed daily candidates profitable | rejected |
| S14 | Promote the fitted OU residual reversion candidate | rejected |
| S15 | Simple pullback entry inside an established rising trend | needs_data |
| S16 | Require out-of-sample residual stability before any pairs/reversion strategy | supported |
| S17 | Promote CUSUM change detection as a return forecast | rejected |
| S18 | Return to the previously failed hourly trend system | rejected |
| S19 | Treat distance from moving average as a predicted profit margin | rejected |
| S20 | Assume lower fees alone will make the failed daily candidates profitable | rejected |
| S21 | Calibrate decision horizons against realized executable net movement | supported |
| S22 | Measure timing skill against equal-exposure passive returns | supported |
| S23 | Track winner concentration and remove the largest trade diagnostically | supported |
| S24 | Count every tested variant and reserve a genuinely later evaluation | supported |
| S25 | Promote only after a prospective shadow experiment answers the profit question | supported |

All local evidence paths were checked to exist, and all 25 record IDs and status values were validated. No strategy engine, deployment, account, fee setting or live order was changed by this review.

The completed root screen makes **ETH SMA40 the strongest development-locked nominee within these tested configurations**, subject to its failed gates. It enters when ETH close exceeds its 40-day mean by the declared base round-trip band and exits at/below that mean. The [selection lock](screen/development-lock.json) chose it using development utility before computing the later runs. The historical dates were nevertheless already inspected in earlier research, and 100 configurations introduce substantial selection opportunity. This is a candidate for separate prospective observation, not a qualified deployment.

I independently summed all twelve ETH40 trade ledgers and reconciled them to reported net P&L, inspected 30/40/50/60-day neighbors, and calculated matched-account benchmark excess. These derived values are preserved under `rootScreenIndependentReview` in the [ledger](strategy-hypotheses.json). Each window resets to $10,000 cash with a $1,000 maximum fee-inclusive entry budget; window results must not be added and described as one continuously compounded account.

| ETH40 window | Base net | Cost + delay net | Base largest episode | Base net excluding largest | Cost + delay net excluding largest |
|---|---:|---:|---:|---:|---:|
| 2025 H1 development | $+377.80 | $+372.86 | $+377.80 | $+0.00 | $+0.00 |
| 2025 H2 | $+335.75 | $+303.85 | $+623.09 | $-287.34 | $-253.78 |
| 2026 through September 9 | $+227.56 | $+159.58 | $+355.70 | $-128.14 | $-176.78 |

Development contains a single 51-day winner. The 2025 H2 base winner runs July 8–September 23 and supplies $623.09, exceeding that window's total net. In 2026, the base winner is the July 6 holding valued by **forced terminal liquidation**, contributing $355.70; four strategy-triggered exits together lose $128.14. Under cost plus delay, terminal liquidation contributes $336.36 while all four strategy exits lose a combined $176.78. The terminal mark includes selling costs and is legitimate liquidation equity, but it is not evidence of a successful strategy-triggered exit. There are nine later episodes per scenario, including that terminal episode, and only eight later strategy exits. Trend strategies can rely on a few large winners; this pattern limits confidence in repeatability rather than proving the economic hypothesis false.

The selected candidate also exceeds the declared $500 later intraday-low drawdown proxy in every H2 scenario: $504.45 base to $517.04 combined stress. Its maximum daily-close drawdown under combined stress is $505.96. Keeping the original thresholds is necessary; reducing exposure after seeing this excess would be a new sizing experiment, not a retroactive pass.

| ETH lookback | Development net, base / combined | 2025 H2 net, base / combined | 2026 net, base / combined | Positive all 12 runs? |
|---|---:|---:|---:|---|
| 30 days | $+166.47 / $+238.09 | $+226.67 / $+194.87 | $-180.56 / $-278.74 | No |
| 40 days | $+377.80 / $+372.86 | $+335.75 / $+303.85 | $+227.56 / $+159.58 | Yes |
| 50 days | $+117.60 / $+51.79 | $+301.00 / $+193.69 | $+133.28 / $+39.13 | Yes |
| 60 days | $-160.27 / $-213.06 | $+416.69 / $+437.62 | $+104.06 / $+152.00 | No |

The 50-day neighbor stays positive under all twelve scenarios, which offers limited support for a 40–50-day region. Its weakest net is only $39.13, and it has seven later episodes. The 30-day neighbor loses in 2026; the 60-day neighbor loses in development. Performance therefore has meaningful parameter and period sensitivity. These neighbor results are diagnostics of the registered grid, not a reason to replace the locked winner or average thresholds after inspecting outcomes.

The [matched-account baselines](screen/baselines.json) use the same starting capital, entry cap, dates and cost scenarios. Their holding exposure differs from the timing rule, so these are not risk-matched portfolios.

| Window | ETH40 base / combined net | ETH buy-and-hold base / combined net | BTC buy-and-hold base / combined net |
|---|---:|---:|---:|
| 2025 H1 | $+377.80 / $+372.86 | $-291.73 / $-325.81 | $+88.34 / $+68.07 |
| 2025 H2 | $+335.75 / $+303.85 | $+135.29 / $+120.09 | $-209.35 / $-219.24 |
| 2026 through September 9 | $+227.56 / $+159.58 | $-223.00 / $-227.54 | $-143.82 / $-154.60 |

ETH40 beats cash and both passive baselines in each of the twelve corresponding runs. For 2026 it exceeds ETH buy-and-hold by $450.57 base and $387.12 combined; it is exposed for 138/137 days versus passive ETH's 250/249 days. In H2 2025 its intraday-low drawdown is lower than ETH buy-and-hold but higher than BTC buy-and-hold. It thus shows a historically useful timing outcome without dominating every passive risk measure.

The related `consensus_btc-090` implementation loses $127.82 base in H2 and $56.32 base in 2026. Its lower band is `SMA*(1-b)`, while S04 proposes `SMA/(1+b)`; these must not be reported as the same experiment. Given the negative related evidence and ETH40's positive locked selection, I would prioritize collecting new evidence for ETH40 over immediately testing tiny variants of the consensus band. A fixed prospective shadow protocol should retain the failed historical gates, exact rules, terminal mark treatment and full trial count. No positive expected-profit claim is established by the current result.
