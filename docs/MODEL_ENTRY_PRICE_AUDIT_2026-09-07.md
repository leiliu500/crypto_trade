# Model entry-price correction — September 7, 2026

The expanded paper sample remains unprofitable. This change rejects model
entries whose quoted entry price has already passed the model's predicted price
target, and consumes the existing 30-minute evaluation interval when that
happens. Capped model evaluation continues; the full profitability screen is
still permitted to fail for paper experiments.

Evidence: [model-entry-price-audit-2026-09-07.json](../reports/model-entry-price-audit-2026-09-07.json).
The fixed ledger cutoff is **2026-09-07 04:17:05.027 UTC**, configuration
`btc-eth-model-evaluation-v10.4.0`. Results below use that cutoff, not later
outcomes received while implementing the change.

## Entries and realized costs

There were 24 filled entries: **22 closed, 2 open, and 3 closed winners**.
Closed net P&L was **-$0.22268435**, comprising **-$0.04930000** in price movement
and **$0.17338435** in fees. The 18 additional closed trades since the previous
audit lost **$0.19763015**. Even removing every fee from the captured fills would
leave a loss. All 24 forecasts were below their model cost hurdle.

| Asset | Closed trades | Winners | Gross P&L | Fees | Net P&L |
| --- | ---: | ---: | ---: | ---: | ---: |
| BTC | 11 | 2 | +$0.03200000 | $0.08804040 | -$0.05604040 |
| ETH | 11 | 1 | -$0.08130000 | $0.08534395 | -$0.16664395 |

Two completed trades had an exhausted forecast target at their original order
limit. The limit is known at decision time; a later favorable fill must not
retroactively change whether the entry screen passes.

| Entry UTC | Asset / side | Forecast return from entry limit | Actual net P&L |
| --- | --- | ---: | ---: |
| September 7 00:41:30 | ETH long | -0.19393 bp | -$0.01245360 |
| September 7 03:12:35 | BTC short | -0.02942 bp | -$0.00617750 |

Skipping those two entries on the fixed recorded panel would reduce its loss
by **$0.01863110 (8.37%)**, from -$0.22268435 to **-$0.20405325**. This remains
negative and does not account for replacement trades. It is not a claim about
prospective results after deployment.

## Why both the price check and proposal interval changed

The previous planner checked whether the predicted move remained positive from
the current market midpoint. For tiny forecasts, the buy ask could already be
above the predicted midpoint target, or the sell bid below it. Replay v2 had a
stricter entry-quote check already, so the earlier report did not reproduce this
part of the submitting planner. This audit identifies and fixes that mismatch.

The shared direction check computes:

```text
target = forecast.referenceMid * (1 + forecast.predictedGrossBps / 10000)
directionalReturnBps = side * (target - orderLimit) / orderLimit * 10000
```

A paper evaluation entry requires a finite, positive directional return.
The planner and final order-submission guard both enforce it. The calculation
does not replace the midpoint-based net-value calculation, so entry spread is
not deducted twice. Fees, uncertainty, liquidity, sizing, and portfolio checks
keep their existing roles.

An initial replay that allowed immediate retries after rejecting an entry had
worse descriptive results: later replacement trades changed the proposal
times. Its negative results are retained in the evidence file. The final rule
therefore records an exhausted forecast as a skipped evaluation proposal and
consumes the 30-minute interval, just as a submitted evaluation attempt does.
It does not consume that interval for unrelated health or liquidity failures.

## Chronological comparison on the new period

The replay used **325,560 stored quotes** from the preceding 48 hours. Quotes
before **September 7 00:00 UTC** train the model; entries are scored after that
time through the fixed cutoff. There were 18 proposal times shared exactly by
the old and corrected rules. **13 proposals** had complete paths across both
rules and all three execution scenarios; five were excluded jointly because
of missing paths or the end of the recording. Nonfills and skips contribute
zero on the same original proposal denominator.

| Asset / scenario | Old net bp per proposal | Corrected net bp per proposal |
| --- | ---: | ---: |
| BTC / 1-second quote execution | -14.35 | -12.82 |
| BTC / 1.5× fees | -17.92 | -15.67 |
| BTC / 3-second latency | -7.73 | -6.23 |
| ETH / 1-second quote execution | -15.15 | -7.80 |
| ETH / 1.5× fees | -19.31 | -11.13 |
| ETH / 3-second latency | -7.61 | -7.61 |

The correction reduces observed losses in five comparisons and is unchanged
in the sixth. Every result is still negative. The final schedule was examined
after seeing the immediate-retry variant's results, so this is exploratory
selection on a small sample, not an untouched holdout. Future paper results
must confirm any benefit. Repeated strategy selection on reused data can
overfit; see [Bailey et al., The Probability of Backtest
Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

Quote replay lacks depth and subsecond execution paths, allows 1.1 seconds of
sampling tolerance, and does not reproduce the live one-second order expiry,
exact sizing, portfolio constraints, or all restart behavior. It charges the
configured 5 bp fee per leg and a 3 bp reserve. Those are paper assumptions,
not a verified live account fee tier. The stored quote history and its SHA-256
identify this exact experiment; raw quotes remain outside Git.

## Exits and model quality

Observed-entry 15- versus 30-minute comparisons now have 15 complete pairs out
of 24 entry opportunities. Longer exits improved short-side descriptive means
but worsened long-side means; all four cohort means remained negative. No exit
policy was changed. The model's recorded prequential mean squared error is
also worse than zero-return forecasting for both assets, and no forecast has
demonstrated a fee-covering edge in this evaluation.

The model still learns completed midpoint-return intervals. This correction
changes which evaluation trades can submit, not the learning target or model
weights. A more complex model is not justified merely by the observed losses.

## Implementation and deployment

- `crossAssetEntryGrossBps` is shared by planning, the final submit guard,
  replay, and audit attribution.
- Exhausted model proposals consume the existing 30-minute paper interval;
  replay records them explicitly as `SKIPPED`, with zero return.
- The audit adds a `DIRECTIONAL_ENTRY` comparison and accepts an explicit
  configuration version so the old and new cohorts can be inspected separately.
- New submitting configuration: **`btc-eth-model-entry-price-v10.4.1`**.
  The model-only paper mode, $12 cap, and existing 15-minute position exits
  remain in force. Breakout/retest does not submit entries.

The TypeScript build and **all 367 tests passed**. Tests exercise BTC/ETH longs
and shorts through the paper broker, independent submit rejection, cooldown
after a rejected proposal, unchanged fee accounting, and continued reduce-only
exits. The update was deployed on September 7; checks at **04:49:52 UTC** found
a healthy engine and database, valid books, 171 historical training labels
restored, and both existing positions restored at their original quantities,
prices, and exit policies. Deployed module hashes matched the tested build,
and the new production audit command successfully read the old cohort.

To audit the original cohort after deployment:

```sh
npm run optimize:model -- --configuration-version=btc-eth-model-evaluation-v10.4.0
```

Omit the option to audit the currently configured cohort. These trade audits
count recorded orders; pre-order skipped proposals are visible in entry
evaluation telemetry and the replay's proposal counts.

To reproduce the original and corrected quote experiments on this host:

```sh
npm run research:cross-asset -- /tmp/model-profit-sep7-quotes.jsonl --paper-evaluation --start=2026-09-07T00:00:00Z --legacy-midpoint-entry
npm run research:cross-asset -- /tmp/model-profit-sep7-quotes.jsonl --paper-evaluation --start=2026-09-07T00:00:00Z
```

The legacy option is a read-only replay control and cannot change order flags.
