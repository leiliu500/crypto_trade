The failed weekly model needs a different signal and inventory design. Its forecasts rank subsequent returns poorly before trading costs, and its fixed-stop risk sizing progressively removes exposure from sustained winners. Raising the order cap or creating more entries cannot repair those two mechanisms.

This is a descriptive audit of the already sealed `economic-screen-v2` candidate, concentrating on its two base-cost, source-plus-hour ledgers. All eight original economic runs remain failed. No model was refitted, no parameter grid or new strategy was tested, and no 2026 outcome was evaluated. The two periods have been inspected before and are not fresh holdouts. Calculations, source hashes, all 154 admitted weekly labels and all 29 inventory episodes are in `forecast-attribution.json`; `forecast-attribution.py` reproduces the report data and asserts order/trade reconciliation.

| Recorded result | 2024 | January–June 2025 |
| --- | ---: | ---: |
| Inventory episodes | 21 | 8 |
| Gross price P&L, including modeled adverse execution | −$213.55 | −$252.40 |
| Execution fees | $18.11 | $5.89 |
| Funding cash | −$41.87 | −$3.67 |
| Net P&L | −$273.52 | −$261.97 |
| Profit factor | 0.572 | 0.414 |
| Winning episodes | 42.9% | 25.0% |
| Median holding period | 168.0 hours | 129.3 hours |
| Cap/risk reductions / total orders | 244 / 286 | 86 / 102 |

Price losses explain 78.1% and 96.4% of total losses. The 2024 funding charge matters, but lower fees alone leave both runs negative. There were enough entries to establish that the current rules lose on these samples.

The raw signal itself fails an elementary check. Each recorded forecast was matched to its own instrument's completed UTC close exactly seven days later; labels crossing that period's end were excluded. These are raw-return diagnostics, without inventory, costs or execution, and therefore are not portfolio returns.

| Forecast diagnostic | 2024 | January–June 2025 |
| --- | ---: | ---: |
| Admitted BTC/ETH weekly labels | 104 | 50 |
| Correlation of predicted and realized return | −0.124 | −0.176 |
| Rank correlation | −0.110 | −0.255 |
| Direction accuracy | 51.9% | 46.0% |
| Forecast MSE / zero-return forecast MSE | 1.040 | 1.076 |
| Correct BTC-vs-ETH weekly return ranking | 46.2% | 40.0% |
| Highest-utility eligible asset/side: mean signed seven-day gross return | +15.39 bps | −83.64 bps |
| Declared modeled round-trip entry hurdle | 37 bps | 37 bps |

The highest-utility diagnostic independently reconstructs the saved formula from each fit's bootstrap coefficients. It chooses the current best eligible forecast, ignoring existing inventory and switching hysteresis. Its poor returns show that removing the stop cannot by itself turn this forecast selection into a demonstrated edge. The negative correlations are descriptive; their inverse is not an automatically valid trading strategy.

The learned intercept supplies most of the average predicted return. In 2024, average contributions were +167.75 bps from the intercept, +3.53 from the fast feature and −28.99 from the slow feature. In 2025 H1 they were +96.60, −10.61 and +32.07 bps. The slow coefficient was negative throughout January–June 2024, positive July 2024–February 2025, then negative March–June 2025. A positive intercept and negative slow coefficient can forecast positive return precisely when an instrument has a negative trailing return.

That behavior was costly in the confirmation period. ETH's mean forecast was +146.10 bps against an actual mean weekly return of −89.62 bps. Across both assets, 11 otherwise eligible long forecasts had both fast and slow trend features below zero; their subsequent mean return was −251.50 bps, although 54.5% of those weeks rose. The positive hit rate did not offset the size of losses. Four ETH long episodes stopped out between January and April for a combined loss of $354.93. Cross-asset selection amplified the problem: BTC long episodes earned $30.58 in H1, while ETH long episodes lost $200.26. These small, selected episode counts do not establish that a BTC-only variant would be sound.

The inventory controller adds a separate asymmetry. It holds the original stop fixed, recomputes current dollar loss to that stop each hour and reduces quantity as price moves favorably. The controller never adds quantity back. Its realized reductions are profitable cash flows ($289.59 / $127.95 gross), but they materially reduce remaining exposure to subsequent favorable movement. The September–December 2024 BTC winner averaged 28% of its original quantity and closed with 11%; the April–June 2025 ETH winner averaged 41% and closed with 18%.

Holding each episode's original quantity to its actual final exit price produces a purely arithmetic gross result of −$50.63 / −$133.36, versus the recorded −$213.55 / −$252.40. Thus intermediate reductions lowered this same-endpoint gross diagnostic by $162.92 / $119.04. This is not an executable counterfactual: it violates the original risk and notional controls, omits its extra fees/funding and ignores path-dependent future behavior. It demonstrates the sizing asymmetry; it does not justify removing risk limits. Even that favorable diagnostic remains negative before fees and funding.

Hard-stop episodes contributed −$502.36 net across seven 2024 episodes and −$446.67 across five H1 episodes. Every other exit category combined was positive in each period. But stops were frequently reached after the initial seven-day direction was already wrong: they are often the location at which the signal's loss becomes realized, rather than the underlying cause. Weekly switching was not the primary aggregate loss source: switched episodes together earned $82.31 / $185.25 net. Reducing switching alone is insufficient.

One distinct candidate worth specifying before any new outcome calculation is a causal trend-state inventory policy with price-based state transitions and a ratcheting protection level. For example, an entry can require price to cross a trailing channel formed entirely before the decision; a smaller trailing channel invalidates the state; the protective floor only moves toward realized favorable price. Keep the existing capital and portfolio loss budgets, calculate risk to that current protective level, and use an explicit quantity band instead of hourly discretionary risk trimming. This removes the pooled return intercept, the unstable learned sign of trend, and the noisy maximum-forecast asset ranking. The purpose is a coherent, testable direction and exit hypothesis, not an invented numeric expected return or a presumed profit guarantee.

In mathematical terms, for a long state entered after `C_t > max(H_{t-L}, …, H_{t-1})`, use a causal invalidation boundary and a nondecreasing protective floor `S_t = max(S_{t-1}, boundary_t)`. Apply the symmetric construction for shorts. Determine the channel horizons and protection rule from a fixed protocol before evaluating another candidate; this audit did not select profitable values. A price channel is one implementation of a persistent trend hypothesis. The primary research on [time-series momentum](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum) motivates testing a security's own trend separately from cross-asset ranking, but its traditional-futures results do not validate this crypto channel rule, horizons, or profitability.

Any new candidate still needs chronological, after-cost accounting and an independently recorded execution trial. This audit supports rejecting the ridge forecast and repairing its exposure asymmetry; it does not prove the proposed alternative earns money.
