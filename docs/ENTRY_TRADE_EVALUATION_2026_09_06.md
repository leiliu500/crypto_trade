# Entry and trade evaluation — September 6, 2026

The current entries have not demonstrated a positive return after costs. The
additional data does not support changing the submitting strategy's holding
period, installing the five-minute entry experiment, or increasing size.

## Realized paper trades

The snapshots were collected around 15:24–15:26 UTC. The database continues to
grow; these are saved results, not a continuously updated balance.

| Sample | Closed trades | Net winners | Gross price P&L | Fees | Net P&L |
|---|---:|---:|---:|---:|---:|
| All recorded versions | 110 | 4 | -$0.045600 | $0.948971 | -$0.994571 |
| Current v10.2.0 entry cohort | 51 | 3 | -$0.038500 | $0.436440 | -$0.474940 |
| Current-version entries added since the previous audit | 29 | 2 | -$0.018100 | $0.246208 | -$0.264308 |

All 110 realized ledgers reconcile. Ten of the current version's 13 gross
winners became losses after fees. Its mean realized return was -10.96 bps.
Reducing fees alone to zero would still leave aggregate price losses for these
same fills; changing execution routes would require new fill-conditioned tests.

The simulator charges 5 bps per taker fill, consistent with the published
base Futures taker rate. Both entry and exit notionals incur fees, so round-trip
fees are approximately 10 bps before spread and other execution costs.
[Kraken fee schedule](https://www.kraken.com/features/fee-schedule).
These are configured paper fees; no account-specific fee tier was inferred.

| Current entry cohort | Trades | Winners | Mean realized net bps |
|---|---:|---:|---:|
| BTC long | 14 | 0 | -10.96 |
| BTC short | 10 | 1 | -9.65 |
| ETH long | 15 | 2 | -10.44 |
| ETH short | 12 | 0 | -12.71 |

[Trade totals, validation results and snapshot hashes](../reports/entry-trade-evaluation-2026-09-06.json).

## Exit optimization on identical entries

The existing per-policy averages can use different surviving observations when
longer paths are invalid or unfinished. Added `npm run research:exits` to compare
every declared horizon on the same complete set of entry opportunities.

All 204 observed-entry labels with fills matched their broker entry price and
quantity. Two of 51 entries had at least one invalid path, leaving 49 complete
entries common to the four exit policies. Six individual invalid labels were
caused by stream interruption or quote gaps. They are counted as exclusions,
not converted into zero-return attempts.

| Alternative exit policy | Same completed entries | Mean net bps |
|---|---:|---:|
| 1 minute | 49 | -13.54 |
| 3 minutes | 49 | -13.68 |
| 10 minutes | 49 | -13.84 |
| 30 minutes | 49 | -14.32 |

These are hypothetical exits anchored to actual paper entries, including the
declared 3-bp execution reserve. They are not realized broker profits and must
not be added together. The 30-minute ETH-short alternative improved by 2.30 bps
against its one-minute comparator, but still returned -11.87 bps on average.
No symbol/direction/horizon average in the observed-entry comparison was positive.

The report separates actual and simulated entries, configuration versions,
directions, hypotheses, fee regimes and execution stresses. It rejects missing
or duplicate policies and inconsistent entry prices, quantities or frozen
structure. Confirmed nonfills remain zero-return attempts; partial fills keep
their requested-quantity denominator. Each policy also reports results on the
same subset spaced beyond the longest declared horizon. Invalid earlier
opportunities reserve that interval rather than letting a surviving later entry
replace them. Day-block bounds remain unavailable until seven observed days.

Complete-case results may still suffer from missing-path bias. Nearby symbols
and market days are dependent, and the comparisons have no multiple-testing
correction or untouched holdout. This command reads through the existing
database-enforced read-only store and never selects or installs a policy.

[Full paired results, including all execution stresses](../reports/paired-exit-evaluation-2026-09-06.json).

## Entry alternatives and decision

The five-minute retest experiment supplied 88 distinct opportunities in the
snapshot. All four symbol/direction groups were negative for every holding
period under baseline execution. On complete paired entries, their means ranged
from -16.00 to -12.54 bps per fill. The earlier failed archived replay therefore
has no supporting positive forward result yet.

The fixed conditional feature model made 1,228 chronological comparisons across
the available cohorts and preferred zero attempts after its uncertainty and
tail-loss penalties. These reuse opportunities across policies and stresses;
they are not 1,228 independent trades. The existing frozen daily policy
evaluation also promoted zero models.
[Conditional results](../reports/conditional-entry-evaluation-2026-09-06.json).

The implemented improvement is a reproducible, paired evaluation of net returns.
No profitable parameter change has been established. A further entry hypothesis
must demonstrate cost-covering directional persistence on fresh data; a larger
range, a stronger flow reading, or a cheaper assumed fee is insufficient by
itself. Keep the existing prospective validation requirements: independent
samples across multiple days, a separate chronological holdout, and execution
stress checks. Favorable hindsight exits and fewer losing trades are not proof
of a profitable strategy.

Build and all 321 tests pass, including seven new comparison regressions. The
new command was also checked against the local database. Changes are local;
the running paper strategy and its existing experiment limits remain unchanged.
