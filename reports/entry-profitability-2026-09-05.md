# Entry and trade evaluation — 2026-09-05

Paper order submission remains enabled, as requested. No trading threshold,
position size, holding policy or running container was changed.

## Realized trades

The initial snapshot contains 44 closed trades between September 4 at 23:58 UTC
and September 5 at 16:30 UTC. All were unscored paper breakout experiments; none
won after fees. Every exit was `POLICY_DEADLINE`, with mean holding time 117.4 s.

| Component | USD |
| --- | ---: |
| Gross price P&L | -0.0090000 |
| Entry fees | 0.1923345 |
| Exit fees | 0.1923402 |
| Net realized P&L | -0.3936747 |

Mean net return was -10.3406 bps. Seventeen trades won before fees; all seventeen
lost after fees. Aggregate price P&L was slightly negative even before fees:
reducing fees alone would not make this snapshot profitable. All 44 ledgers
reconcile. The optimizer now reports fee attribution and exit/holding statistics.
See [trade results](trade-optimization-2026-09-05.json).

## Conditional mathematical model

Implemented a fixed ridge model of executable net returns, using trend,
persistence, flow and velocity scaled to trading costs. Its score subtracts
parameter uncertainty and empirical tail loss.
See [equations and assumptions](../docs/CONDITIONAL_EDGE.md).

The research snapshot at 16:51:24 UTC contains 1,698 observations, including
paired exit variants and execution scenarios, not 1,698 independent trades.
Twenty cohorts supplied 476 chronological scenario/policy comparisons over
48 distinct symbol/signal-time pairs. None had a positive conservative score.
Three predicted means were positive, but uncertainty and tail penalties exceeded
those means. Scores ranged from -49.17 to -11.24 bps.

Base-scenario long-breakout results below cover only later opportunities with
sufficient earlier training evidence, not the whole-period mean:

| Symbol | Exit | Forward comparisons | Baseline net bps/attempt | Preferred |
| --- | --- | ---: | ---: | ---: |
| BTC | 1 minute | 23 | -9.4843 | 0 |
| BTC | 3 minutes | 23 | -9.9960 | 0 |
| ETH | 1 minute | 25 | -10.0247 | 0 |
| ETH | 3 minutes | 24 | -10.3254 | 0 |

Variants reuse market events and cannot be summed as independent evidence or
portfolio P&L. Short-side, actual-entry and confirmed-range cohorts had too few
training samples. The initial existing policy validation promoted zero models.

## Interpretation

The short-horizon signal has not demonstrated cost-covering persistence. Neither
these one-/three-minute exits nor conditioning on the recorded features has
demonstrated a profitable alternative. Hypothetically skipping all trades gives
zero exposure and avoided losses, not a profit fix.

The model can now test conditional predictability as evidence accumulates,
without blocking paper experiments. Its constants were fixed before this model
evaluation, but its design was informed by the earlier aggregate audit. This is
exploratory evidence; confirmation requires new unused data. There is no
demonstrated profitable parameter change to install from this sample.

Reproduce with `npm run research:edge -- --summary` and `npm run optimize:report`.
The database continues growing, so later results will differ from this snapshot.
See [research summary](conditional-edge-2026-09-05.json).
