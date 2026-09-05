# Post-deployment loss review — September 5, 2026

The running v10.0.0 paper engine had two completed trades in the reviewed
dashboard snapshot. This is insufficient to estimate an edge, but their cash
flows explain the losses:

| Trade | Gross price P&L | Entry + exit fees | Net P&L | Exit |
|---|---:|---:|---:|---|
| BTC long | $0.000300 | $0.008003 | -$0.007703 | 1-minute deadline |
| ETH long | -$0.002800 | $0.009915 | -$0.012715 | Structural invalidation |

The broader production optimization report included 53 completed trades across
versions: 1 win, 52 losses, -$0.011600 gross price P&L and $0.464346 in fees,
producing -$0.475945 net. Fees account for 97.6% of that loss. Nineteen of twenty
gross winners became net losers. These tiny dollar amounts reflect the existing
capped paper experiments, not a profitable strategy at larger size.

[Snapshot evidence](../reports/retest-post-deployment-2026-09-05.json) records the
two new trades separately from old versions. A deadline exit is not itself a
bug; extending it requires evidence of better complete-policy returns.

## Design corrections prepared

1. Require an actual pullback from the breakout's running extreme. Previously,
   being near the frozen level was sufficient even during a continuing burst.
   The declared minimum reversal is one spread frozen at breakout.
2. Require recovery across the frozen breakout level. Previously, a local
   three-second bounce could trigger while still on the wrong side of it.
3. Preserve breakout-time volatility in the candidate. Previously, the code
   supplied entry-time volatility despite documenting a frozen estimate.

These are implementation corrections and a declared noise threshold, not
parameters fitted to these two losing trades. The shared detector applies to
paper entry, collection, and raw replay. Version v10.1.0 separates new research
from existing model evidence. Position exits for existing trades remain valid.

## Replay rejects a profitability claim

The identical archived 175,102-event recording was replayed with unchanged fees,
instrument increment assumptions, four horizons, five execution stresses, and
paired fixed/net-floor exits. Candidate count fell from 68 to 28. All baseline
cohorts still lost, with zero profitable filled outcomes. Three recording gaps
and incomplete paths remain; the CLI returned exit code 2 intentionally.

For the one-minute baseline with net floors:

| Cohort | v1 mean per completed attempt (bps) | v2 mean per completed attempt (bps) | v2 mean per filled attempt (bps) | v2 filled / completed |
|---|---:|---:|---:|---:|
| BTC short | -8.13 | -11.77 | -13.73 | 6 / 7 |
| BTC long | -8.73 | -9.42 | -14.13 | 2 / 3 |
| ETH short | -8.71 | -8.14 | -13.23 | 8 / 13 |
| ETH long | -10.53 | -2.76 | -13.81 | 1 / 5 |

The apparent ETH-long improvement includes four unfilled attempts with zero
trading P&L. It must not be interpreted as improved filled-trade profitability.
Replay now reports the filled denominator explicitly. Different candidates,
overlapping horizons and reused scenarios are not independent observations;
this is a diagnostic comparison, not an untouched holdout or portfolio return.

[Original replay](../reports/retest-replay-2026-09-05.json) and
[corrected replay](../reports/retest-replay-v2-2026-09-05.json) retain all cohorts.
Reproduce the latter with:

```sh
npm run research:retest -- capture.jsonl.gz
```

TypeScript build and all 308 tests pass, including symmetric no-pullback and
wrong-side-recovery regressions and paper fill/protection integration tests.
The revision was subsequently deployed at the user's request as v10.1.0 in
paper mode. Post-restart checks confirmed healthy service, a connected database,
valid BTC/ETH books, detector v2, and entries allowed without system halts. It is
not promoted as profitable. Paper submission retains its existing permissions. Longer holding
policies and alternative execution routes require new after-cost evidence;
neither fee reductions nor positive expectancy were assumed to force a result.
