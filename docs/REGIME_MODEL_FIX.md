# BTC/ETH regime predictor implementation and evaluation

The replacement predictor is implemented and integrated behind
`DISTRIBUTIONAL_REGIME_MODEL_ENABLED`. Its archived evaluation has not established
an improvement in entry selection or returns after costs. It is disabled by
default and has not replaced the running trading model.

The existing model's broad Euclidean neighborhood mixes opposing market states.
Its fixed scales give book imbalance and trade flow much more influence on
similarity than most return features. The new model learns small, supervised
partitions from completed gross-return outcomes, separately for each asset and
action. Tree depth is capped at two. Every leaf retains the original minimum
48 samples, effective sample size 32, and three qualifying training dates in
paper trial mode. The tree cannot split a small bank into unsupported groups.

Only gross return is shrunk toward zero; observed execution costs retain their
full weighted mean. Both targets use the original requested-notional denominator,
including partial fills and genuine nonfills. The same execution scenarios,
uncertainty multiplier, downside penalty, positive score threshold, $12 limit,
and single portfolio slot remain in force.

The candidate excludes volatility coordinate 5. An independent reproduction
found that the existing feature can change from approximately 100 bp to 1 bp
solely as an incomplete sampling interval ages, despite an unchanged price.
The stored feature schema is preserved; the new predictor does not use that
unstable coordinate. See the
[feature audit](../reports/strategy-feature-audit-2026-09-08.json).

The predictor has a separate selection-policy version. Switching between it and
the existing efficient model preserves compatible training labels and collection
clocks while clearing validation evidence from the previous selection policy.
Historical imports preserve the selected predictor. The option is restricted to
the efficient paper trial and never enables real-money orders.

## Archived results

All specification choices were fixed before evaluating this candidate. The
runner sealed source hashes and verified that they were unchanged at completion.
The original forecasts were reproduced from their archived training banks. These
recordings were already inspected and remain development evidence.

| Window / asset | Existing model net RMSE | Regime model net RMSE | Regime selections |
| --- | ---: | ---: | ---: |
| September 7 / BTC | 17.40 bp | 15.47 bp | 0 |
| September 7 / ETH | 27.39 bp | 26.38 bp | 0 |
| September 8 / BTC | 12.98 bp | 13.58 bp | 0 |
| September 8 / ETH | 23.33 bp | 22.09 bp | 0 |

All 252 action forecasts passed the candidate's native support gates, but none
had a positive worst-scenario mean above 1 bp. Removing uncertainty penalties
would therefore still produce zero selections. Six of twelve later banks could
form two supported leaves; the others remained unsplit. Better cost calibration
and broader support did not produce a profitable trading signal.

The comparison reports simple unconditional, cost-only, fixed-long, fixed-short,
momentum, and flat baselines. Each model uses its own support definition, which
is exposed in the report. The policy replay uses the sparse recorded probe grid
and releases a hypothetical portfolio slot only when its outcome record arrives.
Unknown outcomes leave full-period returns unavailable. Dependent counterfactual
paths are not independent trades or realized account profits.

Detailed results are in
[the sealed archived comparison](../reports/regime-model-fix-2026-09-08/archived/summary.json).

## Additional chronological recording check

Two closed recordings supplied a separate September 8, 17:20–20:33 UTC check.
The replay processed 591,645 events, including five disconnects and no recorder
gaps or per-stream timestamp reversals. The original 1,260-row seed came from the
previous 08:00 freeze. Four valid prewarm labels completed before 17:20 were added
to the new frozen bank; no evaluation-period labels entered either predictor.
All candidate parameters and source hashes remained unchanged.

This produced six probe origins per asset and 72 action paths. Base execution
had 26 known BTC outcomes and 29 known ETH outcomes; 17 paths were unknown.
Every candidate action passed native support, but all remained below the
positive worst-scenario mean threshold. The candidate again selected zero trades.

| Additional window / asset | Existing model net RMSE | Regime model net RMSE | Zero gross minus costs net RMSE |
| --- | ---: | ---: | ---: |
| BTC | 13.75 bp | 14.38 bp | 13.58 bp |
| ETH | 22.29 bp | 21.27 bp | 21.34 bp |

The results repeat the mixed accuracy outcome and lack of qualifying entries.
These are newly scored chronological development records, not a certified
untouched holdout: the running system had already collected data during this
period, and portions had appeared in operational diagnostics. No parameter
changes were made in response to these results. See the
[chronological comparison](../reports/regime-model-fix-2026-09-08/chronological/regime-result.json).

Across all three windows, the candidate generated zero entries from 324 action
forecasts at 54 dependent asset origins. It has failed the requested trading
improvement criterion and remains disabled. This result concerns this candidate,
its present features, costs, actions, and training data; it does not establish
that BTC/ETH markets cannot be modeled.

## Verification

The full suite passed 690 tests. New tests cover nonlinear regime separation,
cost accounting, causal predictions, time-sensitive cache expiry, sample support,
volatility exclusion, restart recovery, predictor migration, imports, and order
validation. TypeScript compilation passed. Final model and dashboard checks were
repeated after their last defensive and display changes.

```bash
npm run research:regime-quality -- \
  reports/conditional-history-study-2026-09-08 \
  /tmp/new-regime-comparison
```

The compiled production command is `research:regime-quality:production`. Passing
software checks does not establish profitability. The no-entry trading problem
remains unresolved by this candidate.
