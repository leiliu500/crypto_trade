Weekly inventory candidate btc-eth-weekly-mean-variance-inventory-v2: historical economic results. No future profitability is guaranteed.

Historical eligibility: failed. Runtime activation: false.

| Period | Costs | Funding interpretation | Episodes | Orders | Net after fees and funding | Drawdown |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| 2024-01-01–2025-01-01 | base | source-plus-hour | 21 | 286 | $-273.52 | $495.09 |
| 2024-01-01–2025-01-01 | base | source-as-end | 21 | 286 | $-273.40 | $494.95 |
| 2024-01-01–2025-01-01 | stress | source-plus-hour | 22 | 293 | $-380.26 | $611.24 |
| 2024-01-01–2025-01-01 | stress | source-as-end | 22 | 293 | $-380.07 | $611.01 |
| 2025-01-01–2025-07-01 | base | source-plus-hour | 8 | 102 | $-261.97 | $409.64 |
| 2025-01-01–2025-07-01 | base | source-as-end | 8 | 102 | $-261.95 | $409.62 |
| 2025-01-01–2025-07-01 | stress | source-plus-hour | 6 | 92 | $-173.14 | $420.57 |
| 2025-01-01–2025-07-01 | stress | source-as-end | 6 | 92 | $-173.13 | $420.55 |

Full validation decisions and benchmark comparisons are in report.json. Individual runs retain every order, inventory episode, full calendar daily P&L, funding coverage and blocked decision.

Both evaluated periods have been inspected in earlier studies. They are reused development and confirmation data, not fresh holdouts. January–July 2026 remains excluded. Parameters and source copies were sealed before model fitting and replay, and no parameter grid was searched.

The comparator is the mean of independently constrained BTC-long and ETH-long paths. These use the same stop, sizing and risk controls and are risk-managed benchmarks, not passive buy-and-hold or a simultaneously executable two-position portfolio.

The study uses hourly candles and assumed execution. It cannot prove available order-book depth, fills, slippage, intrabar chronology or actual funding settlement timing. A positive historical screen can support a bounded paper trial; it cannot establish live profitability.
