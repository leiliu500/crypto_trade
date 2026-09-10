# Carry horizon and independent spot-data audit

A slower spot-long/perpetual-short design is worth a bounded investigation. The existing evidence does **not** establish positive full-strategy profit in both 2024 and January–June 2025. The failed carry snapshot remains failed. No new strategy outcomes or 2026 strategy performance were calculated in this audit.

The earlier feasibility study was a single September 9, 2026 snapshot, not a historical carry backtest. Its perpetual holding assumption was **720 hours / 30 days**. It charged 80 basis points on each spot execution, 5 on each derivative execution, 1.5 basis points of slippage on each of four executions, current quoted spreads, a 50-basis-point basis reserve, a 25-basis-point unwind reserve, and a 5% annual capital hurdle on spot cash plus fully reserved derivative collateral. The dated products had approximately 2.145, 16.145, and 107.145 days remaining; none met the declared 30–90 day maturity policy. Every one of the 36 feasible scenario paths was negative even in the separate hypothetical zero-spot-fee sensitivity.

For the BTC $1,000 paired-gross scenario, the constant-current-funding 30-day path received $4.4723 funding and charged $8.3141 execution fees, $0.2935 slippage, $0.0068 spread, $4.0710 capital hurdle and $3.6680 basis/unwind reserves, leaving **−$11.8811**. At hypothetical zero spot fees it still lost **$4.0240**. This failure is explained by the complete declared economics, not by the old $12 cap alone.

The existing historical funding study supplies a separate, useful observation:

| Period | Asset | Funding cash per continuously short one base unit | Funding / starting perpetual trade-open reference | Negative funding months |
|---|---|---:|---:|---|
| 2024 | BTC | $11,383.1590 | 26.9182% | None |
| 2025 H1 | BTC | $3,263.7299 | 3.4932% | None |
| 2024 | ETH | $507.1832 | 22.2293% | August |
| 2025 H1 | ETH | $35.1015 | 1.0535% | March, April |

Funding coverage is complete for these four periods. These are pre-existing monthly funding results aggregated without trading decisions. The reference denominator is an explicitly identified perpetual price, **not a fabricated spot fill**. Funding cash alone omits the two price legs, changing basis, execution costs, financing, collateral and liquidation. It must not be presented as strategy profit.

Longer holding periods amortize the four execution fees. They do not remove basis changes or make future funding certain. They also do not remove the opportunity cost of reserved capital. Cash net and excess return over the 5% annual capital benchmark should be reported separately: that benchmark is an analytical comparison, not a venue cash debit. Removing it from cash accounting is appropriate only if the report also preserves the benchmark and clearly distinguishes the new protocol from the old rejected calculation. The weak ETH 2025 funding is a material obstacle at current entry-level spot fees.

Kraken's current public schedule shows **0.80% spot taker per executed side at Tier 1**, with lower fees dependent on qualification. Older pages cached with a 0.40% entry tier do not establish the current account's entitlement. This paper account does not prove actual account fee tier. [Current official fee schedule](https://www.kraken.com/features/fee-schedule?mode=consumerapp).

Kraken specifies that positive perpetual funding is paid by longs to shorts. Funding accrues continuously at the rate set for the hour and settles at hour end or when the net position changes. A historical replay needs signed absolute USD-per-base-unit rates prorated over actual inventory intervals. It must separately model spot ownership and perpetual margin; two equal and opposite positions in the same derivative are not a spot hedge. [Official linear contract specifications](https://support.kraken.com/articles/4844359082772-linear-multi-collateral-derivatives-contract-specifications).

Independent spot source restoration is now available in [spot-history/manifest.json](spot-history/manifest.json), validated by `loadSpotHistoryDataset`:

| Source | BTC coverage | ETH coverage |
|---|---|---|
| 1,440-minute spot trade candles | 285 days, September 19, 2024 through June 30, 2025 | Same |
| 10,080-minute spot trade candles | 130 completed weeks, December 29, 2022 through June 25, 2025 | Same |

The weekly bars retain Kraken's Thursday UTC starts. The final retained weekly bar ends June 26, 2025 UTC. Daily bars cover the remaining days of June. Each observed series has no gaps within its own available range. No hourly spot candles were invented, and the series have not been silently mixed. The loader hashes each original public response, removes periods outside the permitted scope before inspecting their prices, persists only the selected complete source rows, and independently reconstructs the dataset when loading. It explicitly records the assumed finalization lag and the absence of historical receipt evidence.

The ordinary spot OHLC API only exposes recent history, so daily data cannot restore early 2024. The official quarterly OHLCVT archives are linked from Kraken's support page. Byte-range probes retrieved ZIP tails for 2023 Q1/Q3/Q4 and 2024 Q2, while 2023 Q2, 2024 Q1/Q3/Q4 and 2025 Q1/Q2 returned Google Drive quota-exceeded pages. The full archive also returned quota-exceeded. The failed responses and source IDs are preserved in [archive-probes.json](archive-probes.json); no archive quota was bypassed. [Official download source](https://support.kraken.com/articles/360047124832-downloadable-historical-ohlcvt-open-high-low-close-volume-trades-data), [OHLC API limitations](https://docs.kraken.com/api-reference/market-data/get-ohlc-data).

Coarse independent spot candles permit an explicitly labeled economic proxy for a new, frozen low-turnover carry protocol. They do not establish contemporaneous basis, one-leg execution losses, intraperiod liquidation paths, maker fills or real book impact. A professional paper rebuild therefore also needs separate live spot books, spot cash and inventory, perpetual collateral and funding, paired-order state, partial-fill repair, costed flattening and recoverable ledgers. Kraken exposes public spot level-2 book snapshots/updates and checksums; these can support prospective paper execution. [Official spot book documentation](https://docs.kraken.com/exchange/api-reference/spot-websocket-v2/book).

Five targeted loader tests pass. They cover timestamp preservation, exclusion of incomplete/future periods before price access, malformed data, duplicates, bounded HTTP responses, immutable outputs, missing-period reporting and source-hash reconstruction. The sealed real dataset contains **830 independent spot bars**. No activation flag or trading configuration changed in this audit.
