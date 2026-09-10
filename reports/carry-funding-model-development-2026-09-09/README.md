# BTC/ETH funding forecast: development result

The fixed adaptive funding forecast does not consistently beat simple baselines. It is not approved for strategy activation, and this funding-only study cannot establish a profitable spot/futures trade.

The model predicts the monthly USD funding income of a continuously held one-base-unit short. Its forecast blends the trailing 7-day and 30-day hourly means equally. A separate conservative estimate uses the smaller of the recent weekly mean and the second-smallest of 13 preceding weekly means. All decisions use an additional one-hour historical publication lag. This is an assumption about availability, not observed client receipt evidence.

| Asset / development year | Comparable months / 12 | Adaptive MAE | 30-day mean MAE | Zero-funding MAE | Conservative shortfall months |
|---|---:|---:|---:|---:|---:|
| BTC 2024 | 12 | $641.12 | $637.52 | $948.60 | 1 / 12 |
| BTC 2025 | 6 | $286.23 | $347.80 | $543.95 | 1 / 6 |
| ETH 2024 | 12 | $30.50 | $30.12 | $42.62 | 1 / 12 |
| ETH 2025 | 6 | $10.96 | $13.78 | $7.28 | 2 / 6 |

MAE is monthly absolute forecast error in USD per **one BTC or one ETH**, so the assets' dollar errors must not be pooled. The full JSON includes the last-rate baseline, squared error, direction accuracy, signed error, all 48 calendar cohorts, and explicit missing hours. Conservative shortfalls mean actual funding was below the empirical estimate; that estimate is not a confidence bound.

The seven missing hourly observations per asset in 2025 affect both target months and subsequent 91-day lookbacks. Only six monthly cohorts per asset have a complete candidate forecast and complete target. Excluded months remain in the denominator and are not scored as zero income.

The simpler 30-day average has slightly lower MAE on both assets in 2024. The candidate improves on all three baselines for the six comparable BTC months in 2025, but ETH is worse than zero funding. These mixed development results do not support a common BTC/ETH predictive advantage. No weights, horizons, or asset selection were changed after these outcomes.

`registration.json` was written before calculation and seals the protocol, source, and data. `integrity.json` confirms the study sources were unchanged during execution. The archived years were previously available development data; they are not an untouched holdout. No 2026 accrual-period outcomes or strategy price returns were analyzed.

A complete carry trade additionally needs paired spot/perpetual basis changes, four executed fee legs, financing, collateral, hedge repair, and terminal liquidation. Those inputs are absent here, so `completeStrategyPnlUsd` is null. The existing directional portfolio's separate 2025 confirmation already failed; this forecast study neither supersedes that result nor supplies comparable total-P&L evidence.
