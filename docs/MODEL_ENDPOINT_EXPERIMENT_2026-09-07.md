# BTC/ETH model experiment — 2026-09-07

Profitability remains unestablished. Recovering valid training endpoints improved
training coverage, but the production model and all three experimental variants
had greater forward squared forecast error than predicting zero return on their
respective samples. No variant produced a forecast that passed the existing
profitability screen during the scored period. These experiments remain offline;
they do not change the deployed model or order permissions.

The [complete report](../reports/model-endpoint-experiment-2026-09-07.json)
contains forecasts, completed training labels, individual simulated outcomes,
paired comparisons, and source/data hashes. The preceding
[paper trade audit](PROFIT_SCREEN_AUDIT_2026-09-07.md) found 32 closed trades,
9 winners, and a net loss of $0.25576045. Avoiding those entries does not establish
a profitable replacement.

## Hypothesis and fixed comparison

Production discards a pending 15-minute training label after an intermediate
invalid quote or excessive quote gap. A midpoint return target can still be
measured from valid starting and ending quotes. This is different from a trade
path: a gap can hide a stop, target, or available fill price.

The experiment compares the existing 15-minute model with three research
identities that retain frozen starting features and forecasts across intermediate
interruptions: 15, 30, and 60 minutes. A valid synchronized ending quote must
arrive within 90 seconds of the declared horizon. Missing endpoints, reversed
timestamps, and stale model resets still discard pending labels. Feature-history
gap checks remain in place. Missing execution paths invalidate trades in every
variant. Research identities are rejected by the production order validator.

All four variants use the same Bayesian experts, features, priors, and cost
configuration. This was a fixed four-variant comparison, without a parameter
sweep or selection followed by retesting on the same later period.

- Input: 446,088 quote rows, from 2026-09-04 22:15:58.840 UTC through
  2026-09-07 15:55:59.238 UTC; 710 invalid/gap events in replay.
- Training consumes earlier quotes causally. Validation starts at
  2026-09-06 12:00:00 UTC; the later period starts at 2026-09-07 00:00:00 UTC.
  Learning continues as labels mature. These are reused snapshots, so the
  report's `HOLDOUT` label means a chronological later period, not untouched data.
- Every variant uses a 90-minute proposal interval. Comparisons retain only
  matching symbol/timestamp opportunities completed in all four variants and
  all three stresses. Nonfills and skipped entries contribute zero to the
  original opportunity denominator. Boundary-crossing opportunities are purged
  jointly across horizons.
- Costs: 5 bp per side plus a 3 bp reserve and executable bid/ask spread.
  Scenarios use one-second quote latency, 1.5-times fees, and three-second latency.
- Exits: existing 15-minute and 30-minute stop/target policies. The 60-minute
  experiment reuses the 30-minute stop and target with a 60-minute deadline.
  These are quote simulations, with the replay's existing 1.1-second sampling
  tolerance; they do not reproduce depth or every broker execution constraint.

## Results

Completed training intervals per symbol over the full source increased from
204 to 256 for the 15-minute endpoint variant. The 30-minute and 60-minute
variants completed 128 and 64 intervals respectively. Each model generated
3,322 forecasts across BTC and ETH during the scored period; none qualified.

Squared forecast error divided by the error of predicting zero return is shown
below. Values below 1 would improve on that baseline. Each model uses its own
completed labels, so these ratios are not a comparison on identical samples.

| Model | BTC validation | BTC later | ETH validation | ETH later |
| --- | ---: | ---: | ---: | ---: |
| Production 15m | 1.0544 | 1.0137 | 1.0437 | 1.0212 |
| Endpoint 15m | 1.0485 | 1.0178 | 1.0483 | 1.0178 |
| Endpoint 30m | 1.0031 | 1.0066 | 1.0041 | 1.0164 |
| Endpoint 60m | 1.0399 | 1.0227 | 1.0239 | 1.0777 |

Only 14 of 38 distinct proposed opportunities survived the joint execution
comparison; 24 were excluded and none crossed the period boundary. Baseline
directional entry results below include costs, skipped entries, and nonfills.
The denominator is original matched proposals, not filled trades.

| Model | BTC validation, bp (4 proposals) | BTC later, bp (2) | ETH validation, bp (4) | ETH later, bp (4) |
| --- | ---: | ---: | ---: | ---: |
| Production 15m | -8.11 | -25.92 | -2.28 | -0.96 |
| Endpoint 15m | -8.11 | -21.98 | -2.28 | -6.61 |
| Endpoint 30m | -6.74 | -33.50 | +0.66 | -8.21 |
| Endpoint 60m | -14.66 | -19.35 | -15.99 | +5.38 |

ETH endpoint-60m was positive in the later period at baseline (+5.38 bp),
increased fees (+2.88 bp), and increased latency (+11.72 bp). It had only two
baseline fills, versus a negative earlier period. Different latency scenarios
can produce different fills; higher simulated latency is not necessarily worse
on such a small sample. This is insufficient evidence to choose that model.

The conservative screen accepts zero proposals for every model, giving zero
simulated return on its original denominator. Abstention is not profitability.
Each symbol/period has only one observed date; the experiment's seven-day
minimum reference is unmet and is not itself a sufficient promotion criterion.
Excluding missing paths can also bias the surviving sample.

The evidence supports investigating predictive inputs and fresh multi-day
validation, rather than treating an easier screen or a longer horizon as a
demonstrated fix. Repeatedly choosing parameters against reused later-period
results risks backtest overfitting; see
[Bailey et al., The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

## Reproduction and checks

```bash
npm run research:model-experiment -- /tmp/model-optimization-quotes.jsonl \
  --start=2026-09-06T12:00:00Z --holdout=2026-09-07T00:00:00Z
```

Quote SHA-256:
`57ac6d96ea10c0ecfdcb8247f91955a537cac5f071bf457952ea83a70d8c8b44`.
The input capture is a local artifact; the report records the costs used, so
reproduction also requires matching those configured costs.

`npm run build` passed; all 375 tests passed. New tests cover endpoint recovery,
late endpoints and time reversal, distinct research identities, causal forecast
immutability, chronological boundary validation, and joint exclusion of missing
or boundary-crossing execution paths. Replaying the unchanged production mode
over the same capture exactly matched the previous outcomes, learning statistics,
last forecasts, entry-screen comparison, forecast count, and eligible count.
No experimental variant was deployed.
