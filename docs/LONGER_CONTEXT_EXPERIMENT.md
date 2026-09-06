# Longer-context entry experiment

The loss audit showed that most existing entries did not cover round-trip
fees even at their best recorded exit. This experiment changes the breakout
lookback from one minute to five minutes, retaining the same frozen-level
pullback, reacceleration, fees, execution stresses and four exit policies.
Range length is a hypothesis, not an expected-profit estimate.

## Implemented

`BreakoutRetest` accepts declared 1-, 5-, and 15-minute ranges; its default
remains one minute. Required history scales with the selected range, and gaps
discard history. A five-minute detector therefore cannot use a one-minute
warmup or forget an earlier extreme simply because it left the shorter window.

The live research collector has an independent `breakout-retest-5m` hypothesis,
fed with actual aggressive trades. It emits paired 1/3/10/30-minute exit cases
under five execution stresses, with its own frozen level, invalidation and
volatility. It never supplies candidates to the order planner. Existing
health/liquidity checks and the research capacity limit apply; capacity
rejections remain invalid evidence. Other hypotheses keep their identities.

Replay records the chosen range in report metadata and observation identity:

```sh
npm run research:retest -- --range-minutes=5 capture.jsonl.gz
```

The optional 15-minute range is available for explicitly declared research,
but was not evaluated or selected in this experiment. Raw replay still uses
hypothetical entries and must not be confused with observed paper fills.

## Negative comparison retained

On the same 175,102-event archived recording, the five-minute version produced
10 setups versus 28 for the existing one-minute detector. It produced no
profitable baseline fills. Example three-minute exit results per filled attempt:

| Cohort | One-minute context | Five-minute context |
|---|---:|---:|
| BTC short | -13.82 bps | -10.49 bps |
| BTC long | -15.38 bps | -15.76 bps |
| ETH short | -13.31 bps | -13.20 bps |
| ETH long | -15.44 bps | -11.78 bps |

The five-minute baseline had only 2, 1, 2, and 1 fills respectively in these
cohorts. Three recording gaps and unfinished paths remain; replay returns exit
code 2 rather than accepting them as good evidence. This is a reused
diagnostic recording, not an untouched holdout. Reduced activity and less
negative cells do not establish profitability.

[Five-minute results](../reports/retest-5m-context-2026-09-06.json) and
[one-minute comparator](../reports/retest-replay-v2-2026-09-05.json) preserve
all scenarios and incomplete outcomes.

The failed comparison is why the five-minute strategy remains shadow-only.
TypeScript build and all 314 tests pass, including longer-range history and
symmetric isolated shadow-entry regressions.
No positive model, larger position size or profitable submitting strategy is
claimed. These new changes are local, not deployed; existing paper submission
permissions remain enabled.
