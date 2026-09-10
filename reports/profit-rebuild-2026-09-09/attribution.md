# Rejected hourly v1: loss attribution

This report explains recorded losses; it does not establish a profitable replacement. The input is the already rejected 2024 and 2025 H1 base replay, consistently using the source-plus-hour funding interpretation. No parameter search or new strategy performance run was performed, and reserved January–July 2026 was not evaluated.

| Measure | 2024 | 2025 H1 |
|---|---:|---:|
| Trades | 493 | 244 |
| Gross price P&L after modeled execution ($) | -598.66 | -623.57 |
| Explicit fees ($) | 389.71 | 176.56 |
| Funding cash ($) | -33.36 | -3.65 |
| Net P&L ($) | -1,021.72 | -803.78 |
| Win rate | 49.7% | 45.5% |
| Average win ($) | 10.28 | 9.16 |
| Average loss magnitude ($) | 14.28 | 13.69 |
| Payoff-implied break-even win rate | 58.1% | 59.9% |
| Profit factor | 0.71 | 0.56 |
| Median hold (hours) | 9.21 | 7.94 |
| Median signal ATR (bps) | 85.05 | 93.00 |
| Median initial stop (bps) | 170.11 | 186.00 |
| Turnover ($) | 779,418.05 | 353,110.98 |
| Net bps / entry notional | -26.21 | -45.54 |
| Same-side same-symbol reentries within 24h | 282 | 139 |
| Of those, after a hard stop | 93 | 47 |

## What the recorded losses establish

Explicit fees account for 38.1% / 22.0% of the loss, negative price P&L for 58.6% / 77.6%, and funding for 3.3% / 0.5%. Removing explicit fees would still leave both periods negative under the modeled fill prices. Increasing the capital cap scales exposure to a negative observed expectancy; it does not repair it.

The nominal target is twice the initial stop, but realized winners average less than realized losers. Most winning trades exit through the trail rather than the target. A stated target/stop ratio is not the realized payoff ratio and cannot be inserted into an expected-value formula as though every winner reaches its target.

The EMA spans are 16 and 64 hours, while 348/493 and 178/244 trades finish within 16 hours. ATR is an average of one-hour true ranges, even though its estimator averages 32 observations. A 2×ATR stop and trail remain scaled to one-hour movement, not a 32-hour or 64-hour risk horizon. The holding-time mismatch and repeated same-side reentry are consistent with churn, but post hoc attribution cannot prove that wider stops would improve returns.

Both symbols and both long/short sides lose in both windows. There is no supported fix here that simply drops one losing asset or direction.

## Design changes justified for a new falsifiable test

1. Align the signal, rebalance cadence and exit horizon. Use volatility measured at the intended holding horizon; do not interpret a 32-observation hourly ATR as 32-hour volatility. A diffusion approximation gives sigma(H) ≈ sigma(1h)√H, but crypto clustering and tails require empirical checks and explicit stress bounds.
2. Treat a persistent directional state as one exposure episode. Rebalance only when the target exposure changes enough to justify round-trip costs; add hysteresis between entry and exit thresholds. Do not close and repurchase unchanged exposure solely because a new hourly signal ID exists.
3. Evaluate price return, execution costs, explicit fees and funding separately, and optimize no parameter on this attribution. Use observed realized payoff distributions and net returns; ATR or geometric price room is not an expected-return forecast.
4. Freeze a small economically motivated replacement family before evaluating it, assess stressed net returns and drawdown, and reserve genuinely uninspected chronological data for final confirmation. A better development result alone does not authorize a profit claim.

## Descriptive breakdowns

### development-2024

Asset and direction:

| Group | Trades | Gross ($) | Fees ($) | Funding ($) | Net ($) | Median hold (h) |
|---|---:|---:|---:|---:|---:|---:|
| BTC/USD LONG | 128 | -100.72 | 109.31 | -33.62 | -243.65 | 10.92 |
| BTC/USD SHORT | 110 | -19.29 | 86.16 | 15.13 | -90.32 | 9.34 |
| ETH/USD LONG | 134 | -275.60 | 109.13 | -28.05 | -412.77 | 8.53 |
| ETH/USD SHORT | 121 | -203.05 | 85.12 | 13.18 | -274.99 | 7.65 |

Exit reason:

| Group | Trades | Gross ($) | Fees ($) | Funding ($) | Net ($) | Median hold (h) |
|---|---:|---:|---:|---:|---:|---:|
| SYSTEMATIC_DEADLINE | 8 | 32.68 | 3.45 | -0.35 | 28.88 | 72.00 |
| SYSTEMATIC_STOP | 247 | -3,322.38 | 193.77 | -13.57 | -3,529.72 | 8.16 |
| SYSTEMATIC_TARGET | 50 | 1,394.50 | 41.47 | -1.73 | 1,351.30 | 9.41 |
| SYSTEMATIC_TRAIL | 188 | 1,296.54 | 151.01 | -17.71 | 1,127.81 | 9.63 |

Holding time:

| Group | Trades | Gross ($) | Fees ($) | Funding ($) | Net ($) | Median hold (h) |
|---|---:|---:|---:|---:|---:|---:|
| 00-04h | 134 | -271.15 | 110.64 | -1.18 | -382.97 | 1.60 |
| 04-08h | 90 | -186.33 | 73.20 | -4.69 | -264.22 | 5.59 |
| 08-16h | 124 | -26.85 | 99.24 | -12.47 | -138.55 | 11.22 |
| 16-32h | 84 | -257.16 | 63.24 | -9.39 | -329.78 | 20.42 |
| 32-64h | 49 | 48.63 | 36.57 | -5.41 | 6.64 | 43.62 |
| 64-72h | 12 | 94.20 | 6.82 | -0.22 | 87.16 | 72.00 |

Realization month:

| Group | Trades | Gross ($) | Fees ($) | Funding ($) | Net ($) | Median hold (h) |
|---|---:|---:|---:|---:|---:|---:|
| 2024-01 | 44 | 15.80 | 37.29 | 0.12 | -21.36 | 7.76 |
| 2024-02 | 38 | -3.65 | 35.66 | -9.73 | -49.03 | 10.56 |
| 2024-03 | 44 | -149.56 | 29.22 | -11.53 | -190.31 | 7.07 |
| 2024-04 | 47 | -3.48 | 37.05 | -1.61 | -42.14 | 8.62 |
| 2024-05 | 36 | -54.95 | 32.12 | -2.44 | -89.52 | 11.43 |
| 2024-06 | 26 | -87.02 | 24.30 | 3.18 | -108.14 | 14.62 |
| 2024-07 | 42 | -58.93 | 34.66 | -0.99 | -94.57 | 7.68 |
| 2024-08 | 48 | -1.53 | 33.58 | 0.30 | -34.81 | 5.96 |
| 2024-09 | 46 | -134.11 | 39.88 | -1.97 | -175.96 | 9.06 |
| 2024-10 | 37 | 58.39 | 33.75 | -1.63 | 23.02 | 8.56 |
| 2024-11 | 41 | -90.91 | 25.26 | -3.84 | -120.01 | 9.29 |
| 2024-12 | 44 | -88.72 | 26.95 | -3.22 | -118.90 | 9.61 |

### development-2025-h1

Asset and direction:

| Group | Trades | Gross ($) | Fees ($) | Funding ($) | Net ($) | Median hold (h) |
|---|---:|---:|---:|---:|---:|---:|
| BTC/USD LONG | 48 | -94.51 | 43.34 | -6.20 | -144.04 | 13.74 |
| BTC/USD SHORT | 50 | -244.91 | 42.52 | 3.52 | -283.91 | 8.12 |
| ETH/USD LONG | 67 | -164.43 | 48.35 | -1.74 | -214.52 | 6.18 |
| ETH/USD SHORT | 79 | -119.73 | 42.35 | 0.78 | -161.30 | 7.52 |

Exit reason:

| Group | Trades | Gross ($) | Fees ($) | Funding ($) | Net ($) | Median hold (h) |
|---|---:|---:|---:|---:|---:|---:|
| SYSTEMATIC_DEADLINE | 3 | 8.40 | 0.79 | -0.04 | 7.57 | 72.00 |
| SYSTEMATIC_STOP | 134 | -1,717.92 | 97.57 | -0.82 | -1,816.31 | 8.43 |
| SYSTEMATIC_TARGET | 22 | 568.78 | 15.03 | -0.44 | 553.31 | 11.62 |
| SYSTEMATIC_TRAIL | 85 | 517.17 | 63.16 | -2.36 | 451.65 | 6.60 |

Holding time:

| Group | Trades | Gross ($) | Fees ($) | Funding ($) | Net ($) | Median hold (h) |
|---|---:|---:|---:|---:|---:|---:|
| 00-04h | 64 | -108.32 | 48.06 | -0.10 | -156.48 | 1.89 |
| 04-08h | 58 | -249.69 | 44.39 | -0.69 | -294.78 | 5.59 |
| 08-16h | 56 | -195.66 | 40.07 | -1.45 | -237.18 | 11.21 |
| 16-32h | 39 | -7.10 | 27.23 | -1.13 | -35.46 | 19.18 |
| 32-64h | 20 | -27.43 | 14.06 | -0.87 | -42.36 | 45.99 |
| 64-72h | 7 | -35.38 | 2.75 | 0.60 | -37.53 | 69.58 |

Realization month:

| Group | Trades | Gross ($) | Fees ($) | Funding ($) | Net ($) | Median hold (h) |
|---|---:|---:|---:|---:|---:|---:|
| 2025-01 | 44 | -130.86 | 36.03 | -2.26 | -169.16 | 7.32 |
| 2025-02 | 39 | -92.06 | 27.09 | 0.59 | -118.55 | 8.26 |
| 2025-03 | 50 | -236.05 | 34.14 | -0.11 | -270.31 | 8.42 |
| 2025-04 | 43 | -10.08 | 28.87 | -0.62 | -39.58 | 7.59 |
| 2025-05 | 37 | -79.39 | 26.86 | -1.32 | -107.57 | 8.66 |
| 2025-06 | 31 | -75.13 | 23.55 | 0.07 | -98.61 | 9.49 |

## Reproduction and limits

Run `python3 reports/profit-rebuild-2026-09-09/attribution.py` from the repository root. The script reconciles trade accounting to the saved replay totals, reconstructs ATR from only the 192 preceding completed bars, and records SHA-256 input and script hashes in `attribution.json`.

- Gross P&L is signed fill-price movement after modeled adverse execution. It is not frictionless directional alpha.
- Explicit fees and funding are exact decompositions of this replay. Exit execution cost cannot be separately recovered from trade rows alone.
- Funding timestamps are unverified; this attribution consistently uses the recorded source-plus-hour interpretation.
- Candle chronology and liquidity are synthetic execution assumptions, not observed order-book fills.
- Calendar groups allocate a completed trade to exit month; these differ from the replay's daily marked-to-market P&L.
- Subgroups, holding times and reentry counts are descriptive and post hoc; they do not establish causal effects or justify selection rules.
- 2024 and 2025 H1 have been inspected repeatedly and cannot support an untouched out-of-sample claim.
