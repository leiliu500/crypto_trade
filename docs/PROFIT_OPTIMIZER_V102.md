# Profit optimizer evidence repair

The optimization objective is positive expected net return after actual entry
and exit fees, executable prices and the declared reserve. Cleaner entry shapes,
lower trade counts, or synthetic winning tests do not satisfy that objective.

## Implemented in local v10.2.0

Submitted-entry policy research now binds all paired holding policies to the
actual paper client order ID and decision time. It waits for reconciled broker
execution instead of simulating another entry 250 ms after the signal quote.
An actual paper fill therefore cannot be replaced by a hypothetical non-fill.

The collector uses observed price, timestamp, and filled quantity. Actual fees
must match the declared paper fee schedule; a mismatch is invalid evidence.
Confirmed IOC non-fills remain zero-return attempts. Rejections, missing
confirmations, price-cap violations and unsupported multiple-fill paths remain
invalid observations. A single terminal partial fill retains the originally
requested quantity as the return denominator. Duplicate terminal callbacks do
not alter completed entry state.

The four holding policies still simulate alternative exits after the observed
entry. They are **not realized broker trades**. Exit execution uncertainty,
recording gaps and missing outcomes remain explicit. Multiple separate fills
require a fuller lifecycle replay and are not silently approximated.

Observed paper-entry cohorts and simulated-entry cohorts are separated during
model evaluation and parent-group shrinkage. Hypothetical stress episodes lose
the observed-fill marker. Configuration v10.2.0 prevents the old mismatched
entry evidence from selecting a new policy. The chronological holdout,
independence, clean-telemetry and positive lower-bound requirements remain.

## Profit evidence examined

The current v10.1.0 shadow report contained 73 episodes and 960 observations,
covering current-breakout and breakout-retest cohorts in BTC and ETH. No
completed baseline fill was profitable and no cohort qualified. Horizons
share market paths and cannot be counted as independent trades. Some longer
paths were unfinished, and the report's frozen holdout excludes the current
intraday period. This is diagnostic evidence, not a fitted profit forecast.

The report provides no supported basis to promote a longer horizon, change
direction, or increase size. Switching to maker execution also requires its
own fill-conditioned evidence; lower advertised fees cannot be substituted
into taker fills to claim a profitable route.

[Saved shadow report](../reports/profit-research-review-2026-09-05.json)
and [actual trade evaluation](RETEST_V101_EVALUATION.md) retain the negative
findings. No new profit improvement has been demonstrated. The purpose of this
repair is to make subsequent net-return optimization learn from the entries
that actually occurred.

## Validation and runtime status

TypeScript build and all 311 tests pass. Regression cases cover the original
simulated non-fill/actual fill mismatch, partial quantity, fee mismatch,
unconfirmed/rejected execution, duplicate terminal callbacks, and symmetric
end-to-end paper entries with matching observed research labels.

The changes were deployed at the user's request as v10.2.0. Post-restart
checks confirmed a healthy paper engine, connected database, valid BTC/ETH
books, and entries allowed without system halts. Paper submissions remain
enabled with the same sizing and experiment rate limits. No live trading,
model promotion, fee reduction, or profit claim accompanies this revision.
