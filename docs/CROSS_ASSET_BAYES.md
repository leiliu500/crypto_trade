# BTC/ETH dynamic Bayesian strategy research

Implemented a joint BTC/ETH return model that learns independently of the existing
breakout entry rules. It estimates future returns, adapts the weights of different
predictors, and tests whether the resulting forecast covers uncertainty and costs.
The initial evaluation found no profitable edge. This is a substantive new model
and prospective execution experiment, not a demonstrated profit improvement.

## Model

Fresh BTC and ETH quotes are synchronized within two seconds and sampled once per
minute. Sixty minutes of continuous history supplies 5/15/60-minute own-asset
returns, 5/15-minute peer returns, relative returns and deviations from rolling
log-price means. A rolling covariance estimates each asset's exposure to its peer:

```text
beta = clip(cov(own 1m returns, peer 1m returns) / max(0.01, var(peer returns)), 0, 3)
relative15 = own15 - beta * peer15
relativeLevel = (log(own) - mean(log(own))) - beta * (log(peer) - mean(log(peer)))
```

Returns are expressed in bps and divided by a fixed 20-bp scale. Feature magnitude
above six excludes a trading candidate. The relative features are conditional
predictors; no BTC/ETH cointegration or guaranteed mean reversion is assumed.

Each symbol has four experts: own-asset trend, cross-asset dynamics, relative
value, and zero expected return. The first two use a 64-label memory half-life;
the latter two use 32 labels. The zero-return expert is a meaningful competitor
when apparent patterns contain no useful prediction.

Each regression keeps discounted sufficient statistics:

```text
lambda = 2^(-1 / halfLifeLabels)
Sxx <- lambda*Sxx + x*x'
Sxy <- lambda*Sxy + x*y
Syy <- lambda*Syy + y^2
n   <- lambda*n + 1

Lambda = Lambda0 + Sxx
m = solve(Lambda, Sxy)
a = 3 + n/2
b = 2 + (Syy - m'*Sxy)/2

mu = x'*m
parameterVariance = b/(a-1) * x'*solve(Lambda,x)
predictiveVariance = b/(a-1) * (1 + x'*solve(Lambda,x))
predictive degrees of freedom = 2*a
predictive Student-t scale squared = b/a * (1 + x'*solve(Lambda,x))
```

The zero-mean prior has precision one for the intercept and ten for slopes.
Cholesky solves avoid explicit matrix inversion. The zero-return expert has no
coefficients and learns only the dispersion around zero.

Labels are arithmetic midpoint returns over completed, non-overlapping
15-minute intervals. Quotes spanning invalid data are discarded. The first 24
completed labels establish the minimum research warmup; this is not a promotion
threshold. Gaps clear pending labels and price history. Training older than one
day is discarded. On process restart, completed historical quotes can seed the
learner before fresh market data resumes.

Expert weights update from the Student-t likelihood of the prediction saved at
the start of each interval, before its target was known:

```text
unnormalizedWeight_j = weight_j^0.98 * predictiveDensity_j(realizedReturn)
weight_j = 0.99 * normalizedWeight_j + 0.01/4
```

The mixture mean and variances include disagreement between experts:

```text
mu = sum(weight_j * mu_j)
V = sum(weight_j * (V_j + (mu_j-mu)^2))
score = abs(muBps) - 2*parameterStdBps - 0.1*predictiveStdBps
        - (2*takerFeeBps + reserveBps + currentSpreadBps)
```

A positive score proposes the sign of the mixture mean for research execution.
The penalty is a fixed decision rule, not a calibrated 95% coverage guarantee.
Student-t predictions arise from conjugate parameter uncertainty; discounting
is an approximate model of changing relationships, not proof of stationarity.

The implementation draws on conjugate Bayesian prediction and dynamic model
averaging. These methods provide inference machinery, not evidence of crypto
profitability. See [Murphy's Gaussian conjugacy derivations](https://www.cs.ubc.ca/~murphyk/Papers/bayesGauss.pdf)
and [Koop and Korobilis on dynamic model averaging](https://doi.org/10.1111/j.1468-2354.2012.00704.x).

## System integration

`TradingEngine` feeds the joint model on fresh quotes when both BTC and ETH are
configured. Forecasts enter telemetry and the research snapshot. An eligible,
fresh forecast creates a separately tagged `btc-eth-dynamic-bayes-v1` hypothesis
in the existing shadow collector. The tag prevents pooling it with breakout
evidence. It runs the existing 15/30-minute continuation policies under five
execution stresses, with actual recorded books, capped hypothetical IOC entries,
partial fills, fees, reserves and invalid-path handling. Health, liquidity and
research-capacity checks apply.

Configuration `btc-eth-joint-bayes-v10.3.0` also enables paper submission through
`CROSS_ASSET_PAPER_ENTRIES_ENABLED=true` in Compose and `.env.example`. Direct
configuration loading defaults this flag off. Submission additionally requires
paper mode, the policy engine, both symbols, and analytical paper permission;
exercise and calibrated-only modes cannot submit joint-model experiments.

An eligible forecast takes priority over the existing breakout/retest candidate
and uses only `trend-15m`, matching its prediction horizon. The existing strategy
remains available when no joint forecast qualifies. Orders use the existing
$12 notional cap and shared 30-minute per-symbol attempt cooldown. Health,
drawdown, liquidity, sizing, asset and portfolio controls remain mandatory.
The planner rebases the prediction from its saved midpoint to the current quote
and subtracts fees, spread, latency, impact, adverse selection, funding/borrow
reserves and positive cost error once. The uncertainty-adjusted score must exceed
the configured minimum net edge and reward/risk threshold at the final quantity.
The IOC price cap stays at the best quote and expiry never extends past one
second after the forecast. Stale or invalid forecasts cannot qualify.

Orders retain the full model snapshot and are tagged `ANALYTIC`, `researchOnly`,
and a model-version-specific regime. They are never represented as calibrated
execution evidence. Entry-timed labels attach to actual reconciled paper fills;
the 15/30-minute paired exits remain separately identified counterfactuals.
Joint orders use the existing 30-bp stop, 45-bp net target and 15-minute deadline,
and do not inherit a coincident breakout/retest invalidation level. These exit
rules differ from the midpoint forecast target, so realized profitability still
requires prospective evaluation.

The dashboard exposes `crossAssetPaperEntriesEnabled` and each symbol's
`policyPulse.research.crossAsset.paperSubmissionEnabled`, learning counters and
latest forecast. The visible BTC and ETH cards show submission permission separately from entry
gates, completed training intervals against the 24-interval minimum, forecast
direction, model net score, costs and uncertainty. Forecasts older than one
second are marked expired, including when the displayed stream is paused.
The training bar measures completed labels, not profitability or entry readiness.

Restart restores the existing paper account and positions. Before trading starts,
the joint model replays up to 48 hours of stored BTC/ETH bid/ask snapshots through
the same causal learner. A read-only database cursor gives a consistent historical
cutoff and bounded batches. Invalid books, stale quotes, missing health evidence,
dropped telemetry and exercise runs remain invalid points in the timeline; they
cannot create completed training labels. Only normal Kraken market-data runs
qualify. Quotes at or after the cutoff and reversed timestamps are rejected.

The replay builds an isolated model and installs it only after the full read
succeeds. No historical forecasts, research-entry observations or order plans
are emitted. Startup discards the unfinished historical interval and clears
the quote cache. Startup reconstructs a separate minute price window from valid,
synchronized historical quotes using the existing 90-second sample-gap limit.
This permits brief deployment interruptions in price features. The training
path still rejects quote outages over five seconds and every invalid quote;
retained price context cannot complete a training interval across an outage or
the handoff. A price window older than 90 seconds is discarded. Both assets must supply fresh quotes before
any new forecast. Stale learned parameters older than one day are discarded.
Actual order submission still requires a current qualifying forecast and the
existing cost, sizing, liquidity, cooldown and portfolio checks.

`historyBootstrap` in each asset's dashboard model data records the data cutoff,
quote count, restored labels and whether recent history survived. The visible
panel shows how many completed intervals came from history. Historical model
training is not evidence that executable trades will be profitable.

A missing, failed or insufficient history read falls back to live learning.
Cold learning takes roughly seven hours of continuous usable quotes (one hour
of history plus 24 completed 15-minute intervals); gaps can extend this. An
enabled, trained model can remain flat if no forecast qualifies.

## Initial result

The fixed data cutoff is September 6 at 15:45 UTC. The export contains 280,568
market snapshots over approximately 41.5 hours, beginning September 4 at 22:15
UTC. Fifty-four snapshots were invalid, and eight pending paired labels were
discarded. Each asset supplied 109 completed labels, including 85 after warmup.
BTC and ETH labels share market time and are not independent observations.

| Forecast error after warmup | BTC | ETH |
|---|---:|---:|
| New model MSE, bps squared | 54.81 | 184.29 |
| Zero-return forecast MSE, bps squared | 53.66 | 180.05 |

The model did not improve forecast error against that baseline. Across 3,386
minute-level predictions, zero passed the uncertainty/cost rule. The highest
score was -15.47 bps. There were no selected hypothetical trades; zero exposure
must not be described as trading profit or a proven improvement to the old system.

This is an initial prequential screen on previously collected data. The sample
is short, market conditions overlap, and the design was informed by earlier
audits. It is not an untouched holdout. A useful next result requires positive
predictive value on new market periods and cost-covering execution outcomes;
additional mathematical complexity by itself does not meet that requirement.

The snapshot replay is deliberately labelled screening-only: market cards lack
depth and sub-second paths. It uses common candidate timestamps across 1-second
latency, 1.5x fees and 3-second latency scenarios. It charges both fees and keeps
misses and invalid paths explicit. Its fixed 15-minute exit differs from the
stop/target policies of prospective shadow execution, so the two results must
remain separate.

[Saved report](../reports/cross-asset-bayes-2026-09-06.json).

## Reproduce and validate

```sh
npm run research:cross-asset:warmup
npm run --silent research:cross-asset:export -- --end=2026-09-06T15:45:00Z > /tmp/btc-eth-quotes.jsonl
npm run --silent research:cross-asset -- /tmp/btc-eth-quotes.jsonl
```

The warmup command runs the same read-only training path before deployment,
reports its data cutoff and training result, and exits with code 2 if the minimum
training requirement is not met. It never submits orders or modifies the running
engine. The deployed engine repeats this replay against its current historical
cutoff before starting market-data processing.

The exporter uses a database-enforced read-only connection, excludes unclean
telemetry and exercise runs, and marks bad quotes rather than removing their
place in the timeline. Build and the full test suite validate the local code.
Regressions cover analytical posterior values, Student-t density, drift
adaptation, collinearity, causal prefixes, disjoint labels, stale training,
flat-market abstention, symmetric shadow entries and stressed replay accounting.
Paper-order tests cover BTC and ETH in both directions through actual local
broker fills, paired evidence, restored exit policies, fees and cooldowns.
Planner checks cover disabled permissions, model scope, stale data, consumed
price edge, higher costs, risk size and reward/risk rejection. Synthetic gains
validate mechanics and accounting; they are not profitability evidence.
