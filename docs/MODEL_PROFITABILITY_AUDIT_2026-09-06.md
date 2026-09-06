# BTC/ETH model profitability audit — September 6, 2026

The current model has not demonstrated a profitable trading edge. Recorded paper
trades lose after fees, and the historical evaluation remains negative under
each declared execution stress. Cost filters reject every scored opportunity;
their zero return represents abstention, not a profitable replacement strategy.

The machine-readable evidence is in
[model-profitability-audit-2026-09-06.json](../reports/model-profitability-audit-2026-09-06.json).

## Recorded entries and trades

The read-only ledger cutoff is **2026-09-06 23:40:49.506 UTC**, configuration
`btc-eth-model-evaluation-v10.4.0`. Five model entries had filled: four closed and
one remained open. The open trade contributes no closed-trade result. All five
forecasts were below their recorded cost hurdle. Model evaluation was explicitly
enabled, so these failing profitability screens were allowed to produce paper
orders under the existing liquidity and risk checks.

| Entry time UTC | Asset | Direction | Gross P&L | Fees | Net P&L |
| --- | --- | --- | ---: | ---: | ---: |
| 22:37:45 | BTC | Short | -$0.00330000 | $0.00800205 | -$0.01130205 |
| 22:38:45 | ETH | Long | +$0.00390000 | $0.00752355 | -$0.00362355 |
| 23:08:46 | BTC | Short | +$0.00140000 | $0.00801720 | -$0.00661720 |
| 23:09:46 | ETH | Short | -$0.00100000 | $0.00251140 | -$0.00351140 |
| **Total closed** | | | **+$0.00100000** | **$0.02605420** | **-$0.02505420** |

All four closed at the 15-minute policy deadline. Two favorable price moves
became losses after fees. Forecast directional magnitudes at these entries were
0.27–1.11 bp, while the paper configuration charges 5 bp per taker leg and the
model's cost hurdle was approximately 13.1–13.4 bp including reserves and spread.
Those are configured paper costs, not a verified live account fee tier.

Holding prices and fills fixed, halving the fees would still leave a
**-$0.01202710** result. Removing every fee would leave only **+$0.00100000**.
This sensitivity does not establish that maker execution or a cheaper venue
could obtain the same fills.

## Historical evaluation and mathematical diagnostics

The replay consumes **324,832 recorded quotes** from the 48 hours ending
**2026-09-06 23:26:38.256 UTC**. Earlier observations train the model; scored
entry attempts begin at **September 6 00:00 UTC**. The model learns each completed
non-overlapping 15-minute label before later forecasts, without fitting to future
labels. These market snapshots have been used in previous research, so this is
an exploratory chronological check, not an untouched holdout.

There were 93 candidate opportunities, with 88 complete across all three
execution scenarios: 46 BTC and 42 ETH. Five opportunities were excluded from
the paired result because a quote path was invalid or extended beyond the
recording cutoff. Nonfills stay in the denominator at zero return. The replay
also rejected 38 forecast checks whose predicted move had already been consumed
by crossing the entry spread.

| Scenario | BTC net bp per original attempt | ETH net bp per original attempt |
| --- | ---: | ---: |
| Recorded quotes, 1-second latency | -12.34 | -9.24 |
| 1.5× configured fees | -16.91 | -12.81 |
| 3-second latency | -11.62 | -8.33 |

The baseline filled 42 BTC and 30 ETH attempts. No forecast in the full replay
passed the conservative profitability screen. Neither the cost-only nor the
conservative entry filter accepted an opportunity from the paired panel. These
filters do not invent replacement trades after skipping an original attempt.

The replay completed 172 training labels per asset. For its 148 labels scored
after the training minimum, model mean squared error was **1.88% worse for BTC**
and **2.33% worse for ETH** than a zero-return forecast. These error statistics
cover the whole replay, including observations before the entry cutoff; they
are not trade P&L or a significance test. The deployed model had 174 training
labels at the quote cutoff and was also worse than its zero-return benchmark.
Its startup window and label timing differ from this continuous cold replay.

The available observed-entry comparisons of `trend-15m` and `trend-30m` had
**zero complete paired outcomes across the four original entries** at the quote
cutoff. Missing or pending longer paths prevent an evidence-backed exit change.

## Changes made

- Added `npm run optimize:model`, a database-enforced read-only audit of the
  configured model cohort. It links entry forecasts to full-position exit
  ledgers, reconciles gross returns and fees, deduplicates copied ledgers,
  separates open/unresolved results, and reports fee and entry-screen comparisons.
- Extended `research:cross-asset` with `--paper-evaluation` and `--start=...`.
  The previous replay considered only forecasts passing the profit screen and
  therefore missed the experiment now permitted to place paper trades.
- Evaluation replay uses the existing `trend-15m` stop/target/deadline function,
  executable-price forecast rebasing, 30-minute cooldown, delayed exit quotes,
  and a common opportunity panel across cost and latency stresses.

The historical execution remains approximate: recorded quotes lack depth and
subsecond paths; the replay does not reproduce live sizing, portfolio gates or
the one-second order expiry. It allows 1.1 seconds of quote sampling tolerance.
Results include a 3 bp reserve, while the recorded realized ledger contains
actual paper price P&L and charged fees. Hypothetical returns are not broker fills.
Partial exit ledgers without a complete position aggregate remain unresolved in
the audit instead of being scored as fully closed trades.

Validation: TypeScript build and 27 focused tests passed, covering causal
forecast handling, both trade directions, stop execution latency, missing-path
exclusions, fee reconciliation, duplicate ledgers, incomplete exits and cutoffs.
Both reports were run against the stored data. The audit and replay updates were
deployed at the user's request on September 6. Checks at **23:52 UTC** confirmed a
healthy engine and database, valid BTC/ETH books, 172 completed training intervals
restored from history, and both pre-restart paper positions restored with their
original quantities, entry prices and `trend-15m` exits. The deployed audit command
ran successfully, and the four deployed analysis/replay modules matched the
tested build by SHA-256. Paper evaluation and model-only order submission remain
enabled. Trading rules and risk limits were not retuned.

## Optimization decision and next experiment

No execution parameter change is supported by this evidence. The model's weak
directional forecasts do not cover costs; increasing size would scale that
observed loss. The existing capped, model-only paper evaluation can continue
collecting the outcomes requested by the user.

The next model or horizon revision should be declared before evaluating fresh
data. Assess prediction error against zero return, net performance after fees,
and the same execution stresses. Collect at least seven observed UTC days before
using the repository's day-block uncertainty calculation; that minimum alone
does not demonstrate an edge. Any promoted candidate needs positive net evidence
on fresh observations, rather than a threshold chosen to improve these four
trades. Repeatedly selecting parameters on reused backtests can produce false
discoveries; this is why this audit does not label an optimized historical score
as proven profitability. See [Bailey et al., The Probability of Backtest
Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

To refresh the current configured cohort:

```sh
npm run optimize:model
```

To rerun the captured historical experiment on this host:

```sh
npm run research:cross-asset -- /tmp/profit-audit-quotes.jsonl --paper-evaluation --start=2026-09-06T00:00:00Z
```

The raw quote capture stays outside Git. Its SHA-256, input cutoff, code hashes,
full per-attempt replay outcomes, actual ledger attribution, and paired exit
exclusions are stored in the JSON evidence file.
