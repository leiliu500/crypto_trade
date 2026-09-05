# After-cost signal-episode research

This is a research addition, not a claim of profitability or a replacement for the
order gateway. Existing `executable-policy-v2` signals, paper permissions, $12
entry cap, cooldowns, stop/target/deadline rules, and risk gates are unchanged.
New hypotheses never dispatch orders and cannot install production policy models.

## Separate causal evidence

`after-cost-episodes-v1` records `EPISODE` observations in the existing
`policy_observations` table, through the durable `researchEpisode` event. Starts
and terminal results are retained. No database migration or historical rewrite
is required. The `policyPulse.research` API object exposes hypotheses and counts.
The production evaluator accepts only v2 `ENTRY` evidence, not these episodes.

The collector runs on fresh quotes after health/liquidity assessment but before
position, pending-order, and cooldown returns. It therefore collects market
opportunities even when another paper order cannot be submitted. Those conditions
are recorded, not bypassed. Quantities use the $12 venue-increment notional cap;
they are explicitly `VENUE_NOTIONAL_ONLY`, not portfolio/risk-approved orders.
This is signal-conditional evidence, not a portfolio backtest. Simultaneous BTC
and ETH episodes are not assumed to be independent market events.

A continuously true signal creates one episode, not one observation per quote.
Rearming requires at least five seconds without a qualifying signal and at least
60 seconds since the previous episode for that hypothesis and side. These are
collection bounds, not claims of statistical independence: validation also thins
overlapping holding periods. Episode state is process-local; a restart can create
another nearby episode, which validation must purge. Feed gaps discard range
history and invalidate open hypothetical positions; interrupted results cannot
silently disappear or score zero. The pending-case cap is 256 per symbol;
capacity failures are persisted as invalid paired outcomes.

## Predeclared hypotheses

- `current-breakout`: the current subsecond breakout/impulse predicate, providing
  a control sampled independently of actual order attempts.
- `range-5m-confirmed` and `range-15m-confirmed`: require a complete prior range,
  built from five-second mid-price samples excluding the current quote. Prior
  range width must cover two taker fees, the configured reserve, and current
  spread. Initial displacement beyond the range must be at least one spread or
  one basis point, whichever is larger. The frozen boundary must remain broken
  for two seconds and at least three quotes, with aligned fast/medium/slow
  returns, OFI/TFI, and slow trend efficiency of at least 0.15.

These thresholds are declared research hypotheses, not fitted recommendations.
Range width is NOT a forecast of future capturable return. Neither new hypothesis
inherits the old impulse shortcut. Both long and short candidates are supported,
subject to venue shortability. All hypotheses compare the same existing one- and
three-minute breakout exit policies; no exit horizon is extended.

Changing a hypothesis, episode selection, or simulation assumption requires a
new episode version; do not pool it with v1 or with v2 actual-entry evidence.

## Execution assumptions

Every episode has both exit variants under all five scenarios:

| Scenario | Entry and exit delay | Fee multiplier | Displayed depth |
| --- | ---: | ---: | ---: |
| Base | 250 ms | 1x | 100% |
| Slower arrival | 500 ms | 1x | 100% |
| Slow arrival | 1,000 ms | 1x | 100% |
| Fee stress | 250 ms | 1.5x | 100% |
| Depth stress | 500 ms | 1x | 50% |

These are sensitivity assumptions, not measured live-exchange latencies. Each
scenario uses the first received fresh book at/after arrival, the signal-price
IOC cap, and a depth sweep. Unfilled IOC attempts return zero. Partial fills
weight attempt returns by filled/requested quantity. Insufficient exit depth or
missing quotes produce INVALID outcomes, not invented fills. Fees are charged on
entry and exit notionals; the configured extra reserve is subtracted separately.
The exit decision is causal and its execution is delayed too. The scenarios are
mutually exclusive simulations; they do not consume liquidity from one another.
This does not model hidden liquidity, queue priority, market impact feedback,
cross-symbol portfolio allocation, or all costs of an actual live account.

## Reports and replay

Commands use database-enforced read-only connections and never save models:

```sh
npm run research:episodes
npm run research:episodes -- --require-qualified
npm run research:episodes -- --export
npm run research:replay -- data/continuous-events.jsonl.gz
npm run research:replay -- --episodes archived.jsonl.gz current.jsonl.gz
```

The replay defaults to recorded v2 ENTRY decisions. `--episodes` instead replays
new shadow episodes, seeded from each base-scenario observation. Supply captures
in chronological order beginning with a reset before the first signal. A missing
signal quote, an incomplete path, or a baseline reproduction mismatch fails the
audit. `--stdin` accepts an uncompressed JSONL event stream instead of file paths;
`--export` emits JSONL outcomes. Existing terminal outcomes seed only candidate
identity/quote/quantity, never entry or exit prices or simulated decisions.
Replay does not discover unrecorded historical hypotheses. Retain raw recordings
and new episode evidence for that future research.

The replay stops after all requested cases are terminal, so quality counters
cover the consumed prefix, not necessarily the entire recording. Truncated gzip
or malformed input is an error, not permission to discard the missing tail.

Exit codes: 0 means the report/replay ran, not that trading is profitable;
2 means replay integrity failed; `--require-qualified` returns 3 when no research
cohort qualifies. The `:production` scripts run the corresponding compiled CLIs.

## Validation is not order authorization

Intraday descriptive returns include zero-return nonfills and show invalid and
pending counts. `meanNetBpsPerAttempt` is the mean over valid complete attempts;
invalid/pending attempts are counted separately and block mature evidence from
qualifying. Per-fill means remove partial-quantity weighting. Actual realized
paper P&L remains in `optimize:report`; it is not replaced by reserve-adjusted
shadow returns.

Research qualification uses the existing UTC-day-frozen 14-day chronology:
seven days of training, 3.5 days of selection, and 3.5 days of untouched holdout,
with purging and day-clustered lower bounds. Requirements remain 100 independent
samples, seven observed days and seven-day span, 30 holdout samples, positive
validation/holdout/fitted lower bounds, three positive walk-forward folds, and
fresh evidence. Today’s rows are descriptive only until the next daily cutoff.

Only baseline validation selects the exit policy. Every stress evaluates that
same policy with a common maximum-latency embargo. Missing variants, mismatched
candidate quantities/prices/costs, unknown scenarios, or unclean telemetry block
qualification. Hypotheses are reported separately; this report does not select a
winner across hypotheses using the holdout.

Even a passing `researchQualified` result has `deploymentReady: false`. A new
hypothesis still needs independent review, execution/portfolio-aware validation,
and a separately authorized paper-policy implementation. There is no automatic
live deployment, larger sizing, or guarantee of profits.
