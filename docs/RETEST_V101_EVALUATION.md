# Latest paper-trade evaluation

As of September 5, 2026, 21:11:51 UTC, version
`btc-eth-breakout-retest-v10.1.0` had four completed trades and no open positions.
The database and dashboard both contained the same eight version-specific
orders. Older strategy results are excluded.

| Entry time UTC | Trade | Entry → exit | Holding time | Net return | Exit reason |
|---|---|---|---:|---:|---|
| 19:28:58 | ETH short | 2480.10 → 2481.00 | 102 s | -13.63 bps | Structure invalid |
| 20:05:23 | ETH long | 2477.90 → 2478.80 | 60 s | -6.37 bps | 1-minute deadline |
| 20:09:14 | BTC short | 79762 → 79765 | 60 s | -10.38 bps | 1-minute deadline |
| 20:54:26 | ETH short | 2477.00 → 2477.60 | 180 s | -12.42 bps | 3-minute deadline |

Total gross price P&L was -$0.002700. Actual simulator entry and exit fees were
$0.037721, producing -$0.040421 net P&L. Fees explain 93.3% of the net loss.
These are capped paper positions, not returns on the whole account.

## Entry and exit findings

All entries carried `edgeSource=UNRESOLVED`, zero effective model samples, and
`modelVersion=unscored-paper-experiment`. The frozen breakout/retest rules are
working as a signal definition, but no validated after-cost edge selected these
orders. Without a matching promoted model, the engine rotates the declared
holding policies by time. This is experimental sampling, not evidence that the
chosen horizon is profitable.

The best tracked favorable executable move was 4.84 bps, on the ETH long. The
other trades reached at most 0.88 bps. Fees alone were approximately 10 bps
round trip. No trade accumulated an after-fee profit for the floor to protect;
recorded protection states never activated either the profit floor or recovery.
Lowering the activation threshold would not create an after-fee gain here.

The three deadline exits and one structural exit match the declared policies.
The first ETH short had a 10-minute policy but invalidated after 102 seconds;
holding until its deadline would have ignored its structural rule. Observed
losses do not establish a defect in these exits. MFE is hindsight and is not an
achievable expected return or a justification for tuning a take-profit.

## Research/execution discrepancy

Immutable plans were created 511–580 ms after their signal quotes. Positions
opened 746–830 ms after those quotes. The research collector instead schedules
an IOC from signal time plus its declared 250 ms latency, subject to subsequent
quote arrival. Thus these are not equivalent execution timelines.

The BTC research outcomes explicitly say `ENTRY_NOT_FILLED` with zero return
for every horizon, while the paper broker filled the entry and lost 10.38 bps.
This is direct evidence that those labels cannot be treated as exact
counterfactuals for the actual fill. It does not prove timing is the only cause;
book selection and cap application must also be reconciled.

All twelve completed ETH research horizon outcomes were negative, including
the 10- and 30-minute alternatives. Those values include a 3-bp reserve and
different simulated executions; they are not interchangeable with realized
cash P&L. Overlapping horizons are dependent observations. Longer holds have
not demonstrated a solution in this sample.

The next engineering priority is to reconcile research with actual decision
time, dispatch, IOC cap, and fill events, explicitly retaining mismatches. Then
evaluate cost-aware entry and route alternatives using separate chronological
data. Changing thresholds again before that repair risks optimizing misleading
labels. No profitable model or alternative route is demonstrated by this audit.

The running engine remains healthy and paper entries remain allowed. This
evaluation changes no strategy settings and performs no deployment. Four
trades are too few to estimate stable expectancy, but they confirm that the
latest revision has not demonstrated profitability.

[Machine-readable trade evidence](../reports/retest-v101-evaluation-2026-09-05.json)
includes immutable entry policies, realized fee attribution, favorable
excursions, timing measurements, and paired research outcomes.
