# Hourly BTC/ETH model study

The profit problem remains unresolved. All four replacements failed the 2025 development gate, so no replacement was activated and the January–July 2026 final test remains unopened. The work adds a reproducible longer-history model and account test; it does not establish a profitable trading strategy.

| Candidate | Completed base trades | Base scenario net P&L | Stress scenario net P&L |
| --- | ---: | ---: | ---: |
| Trend, 4 hours | 2 | −$0.2521 | +$0.2996 |
| Recovery, 4 hours | 29 | +$0.0739 | −$0.9015 |
| Trend, 24 hours | 141 | Unknown | −$8.2450 |
| Recovery, 24 hours | 182 | Unknown | −$7.8361 |

Amounts are account P&L under a $12 entry cap and the funding assumptions below. Stress changes arrival/exit times, so it can change gross returns and trade counts as well as costs; its positive 4-hour trend result is not evidence from an independent trade sample. Each 24-hour base policy had one exit during a zero-volume November hour. That inventory remained unresolved under the declared fixed-endpoint simulation, blocking new positions and making full-year base P&L unknown. Known completed base trades netted −$4.7662 and −$0.5019 respectively; these partial totals are not full-year returns. The complete stress paths made 156 and 208 trades and lost money.

BTC prediction error was worse than a zero-return forecast for every candidate. ETH error improved by less than 0.1%, insufficient to establish useful trade selection. The 4-hour trend candidate qualified only four forecasts across 17,468 BTC/ETH origins; the recovery candidate qualified 65. Longer holding periods generated historical entries, but the tested forecasts did not deliver enough gross return to survive stressed execution costs. No threshold was reduced after seeing these results.

Funding conservatism does not explain the 24-hour recovery rejection: its complete stress path earned $3.3026 gross and charged $3.7450 in fees plus $1.4980 in slippage. It therefore lost approximately $1.9404 before any funding allowance. An adaptive refit or an exit-retry policy would be a new version requiring its own chronological validation; neither has been shown to repair the predictive weakness.

The full suite passed 729 tests, the production build passed, and an independent audit reconstructed every candidate forecast, selection and hourly account balance. The actual final-test command refused the failed development candidate before creating a final-test start marker. The running paper service remained healthy. The authoritative selection is `reports/hourly-model-study-2026-09-08/selection.json`; the accounting audit is `development-independent-audit.json` in the same directory.

The existing short-horizon models have not established positive returns after costs. This replacement experiment uses years of completed hourly Kraken Futures candles to predict 4-hour or 24-hour returns. It is a separate research implementation; it does not submit orders or activate a new trading strategy.

The fixed menu contains four per-asset ridge models: trend and trend/recovery features, each at 4-hour and 24-hour horizons. The penalty is 16. Features use trailing 4-hour, 24-hour and 168-hour returns, trailing volatility, and relative BTC/ETH performance. The recovery variant adds two fixed interactions. Scaling and coefficients are fitted on training rows only; completed outcomes must precede the fit cutoff. Costs are charged separately and never shrunk toward zero by the predictor.

The registered protocol is `reports/hourly-model-study-2026-09-08/protocol.json`. Training uses 2024; selection uses 2025 stress net P&L minus half of maximum account drawdown. The selected model is refitted on 2024–2025 and frozen before the final January–July 2026 test. August is excluded because earlier research already inspected August 27. Final-test execution is denied if development loses after base or stressed costs, has too few trades, or contains unresolved selected outcomes. Failed variants remain in the report; the holdout cannot choose another winner.

The dataset contains 24,120 hourly candles per asset from December 2023 through August 2026: 48,240 in total, with no missing hours and 12 zero-volume hours per asset. The independent audit reconstructs normalized data and verifies all 30 archived source/extracted-file hashes. Downloaded HTTP data was approximately 8.34 MB; normalized data and retained sources occupy approximately 22 MB. No future recording campaign is required. Sources are Kraken's [market candles API](https://docs.kraken.com/api/docs/futures-api/charts/candles) and [historical funding export](https://support.kraken.com/articles/export-historical-funding-rates).

Funding exports have missing hours and stop in February 2026. The CSV timestamp convention also remains unverified. Therefore the primary result is explicitly **projected P&L under funding assumptions**, not verified historical net profit. Every holding hour incurs adverse funding for both long and short positions: the training-only 95th percentile absolute hourly rate in base, and the 99th percentile plus one additional basis point per day under stress. These percentiles are assumptions, not guaranteed bounds on future funding. Raw observed funding remains separate and is never filled with invented zeros.

The account simulator uses one shared $12 position and an initial $100,000 paper account. Signals enter at the next strictly later hourly open; stress adds another hour of delay. Base taker fees are 5 bp per side and adverse slippage is 1.5 bp per side; stress uses 7.5 bp and 3 bp. Clock exits avoid assuming a favorable order of intrabar stop/target touches. A zero-volume entry resolves as a nonfill only when its candle closes. Missing selected prices or unexecutable exits make full-period results unknown. Hourly equity includes open P&L, fees and funding, so open losses count toward drawdown.

Reported comparisons include flat, a fixed 168-hour trend held for 24 hours, and separate BTC/ETH buy-and-hold baselines under the same initial order cap. Buy-and-hold exposure changes with price; this is a capital comparison, not matched market exposure. Prediction errors use every known eligible-origin label and disclose missing labels; trade selection does not filter the error sample. Full-calendar daily P&L, including idle days, supports paired seven-day block intervals.

Run the reproducible stages from the repository root:

```sh
npm run build
npm run research:hourly-data:production -- --out reports/hourly-model-study-2026-09-08/data
npm run research:hourly-model:production -- develop reports/hourly-model-study-2026-09-08/data/dataset.json reports/hourly-model-study-2026-09-08
npm run research:hourly-model:production -- test reports/hourly-model-study-2026-09-08/data/dataset.json reports/hourly-model-study-2026-09-08
```

The data download is needed only once. Existing output files cannot be overwritten. Development writes the candidate/source/data/protocol seals; the test stage checks them, reconstructs the frozen fit, and creates a single-use start marker before evaluating outcomes.

Passing historical scenario checks would only nominate an operational paper candidate. Candle fills still require tick/lot, liquidity, timing and actual funding reconciliation before activation. No live-profit claim or automatic real-money promotion follows from this study.
