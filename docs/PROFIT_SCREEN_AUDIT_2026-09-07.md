# Model entry and trade optimization — September 7, 2026

The model remains unprofitable. Configuration `btc-eth-profit-screen-v10.4.2`
requires the existing positive cost/uncertainty screen and exact order economics
for new paper orders. Rejected model directions continue in a separate shadow
experiment. This change avoids knowingly negative-score orders; it does not
establish a profitable replacement strategy. The current model may place no
orders.

[Machine-readable evidence](../reports/profit-screen-audit-2026-09-07.json)
preserves the ledger, replay, paired exits, cutoffs and input hashes. The fixed
trade and quote cutoff is **2026-09-07 15:56:00 UTC**. The audited entry cohort is
`btc-eth-model-entry-price-v10.4.1`, deployed earlier that day. Later outcomes
are excluded from these figures.

| Recorded paper trades | Closed | Winners | Gross price P&L | Fees | Net P&L |
| --- | ---: | ---: | ---: | ---: | ---: |
| BTC | 18 | 3 | +$0.00250000 | $0.14306855 | -$0.14056855 |
| ETH | 14 | 6 | -$0.02040000 | $0.09479190 | -$0.11519190 |
| Total | 32 | 9 | -$0.01790000 | $0.23786045 | **-$0.25576045** |

All 32 attempts filled and closed, with reconciled costs and clean telemetry.
There are no open or unresolved trades in this cutoff cohort. Win rate is
28.125%, profit factor is 0.1623, and mean net return per trade is -8.8667 bp.
Profit factor divides winning net P&L by the absolute sum of losing net P&L;
the audit returns null when the loss denominator is zero.

The average predicted directional move was **0.8107 bp**, versus an average
model cost hurdle of **13.2461 bp**. Every entry failed the cost screen. All
passed the earlier entry-price correction, so trading after an exhausted
target is no longer the explanation for these losses. Six trades made money
on price movement but lost after fees. Halving fees with the same fills would
still lose $0.13683023; eliminating fees entirely would still lose $0.0179.
Cheaper fills cannot be assumed to retain the same prices and fill rates.

The configured taker charge is 5 bp per leg. Kraken's published lowest-volume
derivatives tier also lists 0.05% per taker trade, though this audit does not
verify an account-specific tier. See [Kraken derivatives fees](https://support.kraken.com/articles/360048917612-fee-schedule).
Actual paper ledgers contain charged fees; replay additionally deducts the
configured 3 bp reserve. Reserves are not reported as realized broker fees.

The existing profitability screen would reject all 32 recorded attempts. On
that fixed panel it avoids the $0.25576045 loss and returns zero. Skipped orders
do not establish profit, release capital into an invented replacement trade,
or justify larger size. No threshold, fee assumption, stop or target was tuned
to the winning trades.

There were **29 deadline exits**, losing $0.13986510 after fees, and **three stop
exits**, losing $0.11589535. No actual trade reached the target. The existing
paired 15/30-minute research has only nine complete pairs among 37 recorded
entry-observation opportunities, including plans that did not reach the broker.
Five BTC short pairs improve from +1.8960 to +9.3485 bp per attempt with the
longer exit; two ETH short pairs worsen from -17.4279 to -28.7980 bp, and two
ETH long pairs worsen from -30.5904 to -33.2881 bp. These are hypothetical exit
results with a reserve, on different surviving subsets from the actual ledger.
The missing paths and one observed day prevent a defensible exit-policy change.

The chronological replay uses **446,088 quotes** from September 4 through the
cutoff, retaining **710 invalid quotes**. Earlier quotes train the model; scored
proposals begin at **September 7 04:49:52 UTC**. There are 44 proposals, of which
only 22 have complete outcomes across all execution stresses. Missing paths
exclude the whole proposal from the paired comparison. Nonfills and skipped
proposals remain zero outcomes on the original denominator.

| Scenario | BTC net bp per proposal (8) | ETH net bp per proposal (14) |
| --- | ---: | ---: |
| Recorded quotes, 1-second latency | -4.4344 | -2.3256 |
| 1.5× configured fees | -6.3093 | -2.6831 |
| 3-second latency | -3.8074 | -3.7957 |

No forecast passed the profitability screen among 7,700 forecasts across the
full replay. This says nothing about all profitable market moves: it measures
this model's signals. The cold replay and live startup use different histories
and sample timing, so their trades and training counts are not interchangeable.
Stored snapshots omit depth and subsecond paths, do not reproduce all live
health/size/restart behavior, and may miss transient invalid quotes. This is
descriptive research on reused history, not an untouched strategy holdout.

At the 15:56:25 dashboard capture, training had progressed from 171 restored
labels to only 172. The last completed label was at **07:28:18.864 UTC**, about
8.47 hours old. Post-deployment snapshots record 210 stale BTC quotes and 161
stale ETH quotes, all marked `PROVIDER_TOO_OLD`, with maximum observed ages
above eight seconds. The model intentionally discards a pending interval on
invalid quotes or gaps. These observations support delayed data as a contributor;
the sampled history cannot attribute every live discard. The data gates and
24-hour model-age limit remain intact. This change does not fix feed latency.
The audit now reports training age at entry, exit groups, win rate, profit factor,
and mean net basis points to make subsequent evaluations easier to compare.

The new `btc-eth-dynamic-bayes-v1:rejected-shadow-v1` research hypothesis retains
the full immutable failing forecast and measures two existing exit policies
under five declared execution stresses. It collects at most one proposal per
symbol per 30 minutes while running, sharing spacing across directions and feed
interruptions. It preserves health, liquidity, lot-size and missing-path checks.
It measures rejected directions, including those with exhausted entry-price
targets; these are hypothetical executions, not replicas of the order planner.
Its `EPISODE` observations cannot enter production's `ENTRY`-only promotion
path. Qualified model forecasts retain their original separate hypothesis.

Compose and `.env.example` now default
`CROSS_ASSET_PAPER_EVALUATION_ENABLED=false`. Direct configuration loading
already had that default. Explicitly setting the flag true still opts into
evaluation orders. Model-only order permission, the $12 cap, position blocking,
30-minute order cooldown and existing position exits remain active.

Validation: **369 tests pass**, including both trade directions, failed-screen
order rejection, qualifying paper entry/exit behavior, rejected-forecast shadow
costs, forecast immutability, invalid-data rejection, shared spacing after a
direction flip or disconnect, and exclusion from production model promotion.
The TypeScript build passes. Deployment status is recorded separately in
[deployment evidence](../reports/profit-screen-deployment-2026-09-07.json).

The update is deployed. Checks found a healthy paper engine and connected
database, valid BTC/ETH books, model-only orders enabled, and evaluation orders
disabled. The existing BTC position retained its original quantity, entry price
and exit policy. Deployed module hashes matched the tested local build. The
database recorded 20 new shadow observations with their original failing
forecast scores; no new broker entries had been submitted by this configuration
at the verification time. Initial shadow records include nonfills and invalid
paths, not established profitable trades.

To inspect the old entry cohort after the configuration changes:

```sh
npm run optimize:model -- --configuration-version=btc-eth-model-entry-price-v10.4.1
```

That command reads the latest ledger. The JSON evidence preserves this audit's
fixed cutoff. To reproduce the captured quote replay on this host:

```sh
npm run research:cross-asset -- /tmp/model-optimization-quotes.jsonl --paper-evaluation --start=2026-09-07T04:49:52Z
```

Future work should first improve clean, continuous observations and assess the
rejected-direction shadow results on subsequent data. Profitability requires
positive results after costs across fresh days and execution stresses. Neither
the unchanged model nor this loss-avoidance setting has demonstrated that yet.
