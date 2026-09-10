# Funding economics: fixed development protocol

Prepared at 2026-09-09 05:01:22 UTC, before opening the new forecast study's outcomes. The runner must seal this document, its numerical specification, source files, and input hashes before calculating results. A later correction must be recorded explicitly; it must not replace a failed result silently.

This study tests a small, fixed forecast of funding cash received by a one-base-unit short in Kraken linear BTC/USD and ETH/USD perpetuals. It does **not** backtest a complete spot/perpetual carry strategy. All 2023–2025 source data are development data that have previously been available for inspection. Neither this study nor a chronological split makes them an untouched test. Reserved 2026 strategy returns are excluded.

## Funding units, timestamps, and availability

For the linear contracts, a positive absolute rate is USD received per base unit short per hour; a negative rate is a payment by the short. A fixed quantity `q` held over an entire hour receives `q * absoluteRate`. Partial-hour accrual uses the held fraction of the hour. Relative rates are a different representation and must not be multiplied by a later market price to manufacture supposedly exact cash flows. Funding accrues continuously and is booked at hour-end or a position change. See [Kraken's linear contract specifications](https://support.kraken.com/articles/4844359082772-linear-multi-collateral-derivatives-contract-specifications).

The current official [historical-funding API schema](https://docs.kraken.com/api-reference/historical-funding-rates/historical-funding-rates.md) defines `timestamp` as the **start** of the applicable period. For hourly linear-contract rows, source time `t` covers `[t, t + 1 hour)`, with normalized settlement time `t + 1 hour`. This study imposes an additional one-hour publication lag: modeled `availableAt = t + 2 hours`. At decision `d`, the newest admitted normalized settlement is therefore `d - 1 hour`. This historical availability is **assumed**, not an archived record of when a client first received the rate. It is distinct from using a currently published rate during its live accrual period.

The existing archive audit matched 3,612 CSV/API overlapping rows per asset on timestamp, absolute rate, and relative rate. That supports the archive normalization `settlementTimestamp = sourceTimestamp + 1 hour` on the overlap. Extending the convention to non-overlapping CSV rows remains an explicit inference. Preserve the audit artifact and raw timestamps in provenance; do not claim the CSV export documentation itself specifies the convention.

Duplicate/conflicting timestamps, nonfinite rates, wrong symbols, or unexpected intervals fail validation. Genuine zero funding remains zero. Missing funding is never filled with zero or interpolated. Input rates must be bounded to the permitted source years before any study calculation.

## Frozen cohorts and forecasts

There is one cohort per calendar month, January 2024 through December 2025, per asset. The decision is the first day of the month at **00:00 UTC**. The target is the sum of absolute funding rates with source timestamps in that entire calendar month, representing USD received by a continuously held short of exactly 1 BTC or 1 ETH. Calendar-month duration determines the number of target hours, including the leap day in February 2024.

The candidate uses exactly 91 complete days ending at the history cutoff `decision - 1 hour`. Equivalently, its source timestamps cover `[decision - 1 hour - 91 days, decision - 1 hour)`, or normalized settlement timestamps cover `(decision - 1 hour - 91 days, decision - 1 hour]`:

1. `pointHourly = 0.5 * mean(last 7 days) + 0.5 * mean(last 30 days)`.
2. Partition the trailing 91 days into exactly 13 adjacent, non-overlapping 7-day blocks anchored to that history cutoff. Calculate each block's hourly mean.
3. `conservativeHourly = min(mean(last 7 days), q10(13 weekly means))`.
4. `q10` uses the nearest-rank empirical quantile: sort the 13 means ascending and select the second value, `ceil(0.10 * 13)`. It is not an interpolated quantile.
5. Multiply each hourly forecast by the exact number of hours in the target calendar month to obtain the monthly cash forecast.

All 2,184 history hours are required for a candidate forecast. If any required hour is missing, the forecast is unavailable with a recorded reason. If any required target-month hour is missing, that month's outcome is `UNKNOWN`; report missing hours and exclude it from scored pairs. A month is not rescued by scoring only its observable fraction. Its full target becomes available one hour after the next month's boundary under the same modeled publication lag. Year filtering uses accrual/source time: the settlement of December 2025's final hour at January 1, 2026 belongs to the permitted December target and does not authorize inspection of any 2026 accrual period or strategy price returns.

The three fixed point baselines are zero hourly funding, the last completed hourly rate, and the trailing 30-day hourly mean. Their monthly forecasts use the same target duration. Baselines may report their own availability, but the primary comparison uses only identical cohorts where the candidate, all baselines, and the entire target are known. Additional baseline-only cohorts are separately labeled. No horizon, weighting, percentile, or baseline is selected from these results.

## Report contract and acceptance limits

Report every cohort with decision time, history cutoff, expected and observed history/target counts, forecast status, target status, all forecasts, and actual funding cash when complete. Also report input/source hashes and aggregate matched counts per asset and year.

For each asset and year, report matched mean absolute error, mean squared error, and direction accuracy for each point forecast. Treat positive, zero, and negative as separate directions; a zero forecast is not credited for a nonzero outcome. Report signed error and aggregate forecast/actual totals for interpretation. Values are USD per **one base unit**, so BTC and ETH errors must not be pooled into an economically misleading common dollar score.

For the conservative forecast, report the count and frequency of complete outcomes below the forecast, plus the magnitude of each violation. The weekly means are not 13 independent future-month draws, and 12 monthly outcomes per year are a small sample. The empirical bound is neither a confidence interval for the mean nor a calibrated coverage guarantee. No significance, predictive effectiveness, or profitable trading claim follows merely from a positive average funding rate.

A useful research result would be lower matched error than simple baselines in both assets without concealing missing cohorts. This is descriptive evidence, not an automatic deployment gate. A failed result remains a failed result: no replacement weights, new horizons, or selective asset/year reporting in this protocol. Cash with zero trading activity is the economic baseline for subsequent complete-strategy evaluation.

## Fee and holding-period frontier

Separately report current carry snapshots under spot fees of **0, 20, 40, and 80 basis points per executed side**, with explicitly stated futures fees, all four entry/exit executions, spread/slippage, and any financing or conversion costs. These are fee sensitivities, not evidence that an account qualifies for a tier. Until authenticated account-specific fee evidence is available, set `actualFeeVerified: false`; preserve source and observation time. A zero-fee case is a hypothetical lower bound, not the default execution model.

The [published Kraken fee schedule](https://www.kraken.com/features/fee-schedule) currently shows entry-tier spot maker/taker fees of 40/80 bp and futures maker/taker fees of 2/5 bp; account and jurisdiction determine applicability. The official API schema states that legacy futures fee endpoints stopped reflecting charged fees effective 2026-06-22 and directs account verification to Spot `GetTradeVolume`. Do not use those deprecated futures responses as fee attestation. Maker fees require actual passive fills or a separately validated execution model; a limit order alone does not establish maker execution.

For equal illustrative entry/exit notionals `N` on each leg, taker round-trip fees alone are `2 * N * (spotFee + futuresFee)`. At 80 bp spot and 5 bp futures, this is 170 bp of one leg's notional, or 85 bp of the combined two-leg gross exposure. Fee schedules are applied to actual executed notionals in a complete ledger. A conditional constant-rate break-even time is costs divided by positive forecast hourly funding revenue; nonpositive revenue has no finite funding-only break-even. It is not a promise that funding persists until that time.

Do not reinterpret an old $12 research scenario as the user's general account exposure limit. Any $12 or $1,000 scenarios here are explicitly labeled research sensitivities and do not alter runtime limits.

## Requirements for a later trading decision

The economic entry condition is positive conservative **complete-strategy** net value relative to cash after executable costs and an explicit risk allowance, using fixed rules registered before evaluation. This funding-only study cannot satisfy that condition on its own. A paired ledger must also include spot/perpetual basis change, quantity mismatch, terminal liquidation, financing, margin, and collateral costs. Synchronized executable spot and futures books, matched instrument units, actual fee evidence, funding receipts, and a defined hedge-repair/exit policy are required.

Zero-funding and reversed-funding paths are mandatory stress reports under the same decisions, holding period, and execution assumptions. They measure potential loss and required capital. Requiring a funding-only trade to earn positive returns when funding is zero and fees are positive would be an impossible profitability gate; survival and capital limits must be specified separately. Missing prices, funding, or unresolved hedge fills make full economic results unknown.

Dated cash-and-carry is a separate possible instrument choice, not a remedy inferred from a weak perpetual forecast. Evaluate observable executable basis versus spot purchase, futures entry and settlement fees, spot unwind, cash opportunity cost, and liquidity reserves. Kraken charges a taker fee when a dated position settles, and the settlement index differs from an arbitrary spot exit print. Annual return must use committed spot cash plus derivative collateral and repair reserves as its denominator. Same-venue execution does not remove basis, liquidation, custody, or transfer risk. [BIS research on crypto carry](https://www.bis.org/publications/working-paper-1087-crypto-carry) explains the economic role of market segmentation and constrained arbitrage capital; it does not establish a guaranteed opportunity for this account.

No model or strategy is activated by this report. Improved data, exact accounting, clear abstention, and a reproducible failed test are valid outcomes of this research process.
