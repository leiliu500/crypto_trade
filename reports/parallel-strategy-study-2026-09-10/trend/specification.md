# Sequential drift detection: preregistered candidate

This specification is written before any candidate backtest result is inspected. This is an exploratory historical comparison, not a claim of future profitability.

## Hypothesis and universe

BTC/USD and ETH/USD funded spot, long or cash. A sustained directional change can generate a multiweek move that exceeds the unusually conservative 1.66% base and 2.20% stress round-trip trading costs. Daily standardized return accumulation separates persistent positive evidence from an isolated large candle. No shorting, leverage, funding income, or intraday execution is assumed.

For each asset, use completed daily closes only. Let `r[t] = log(close[t] / close[t-1])`. Keep exponentially weighted daily return mean and second moment with half-life `L`; the current observation is standardized using the variance known at `t-1`. Variance is floored at `(0.005)^2` to prevent nearly flat prices from creating extreme standardized evidence. Standardized returns are clipped to [-4, 4], which limits a single unusual daily candle's contribution without changing the actual execution return.

Two-sided one-sided cumulative sums use drift allowance `k = 0.25` daily standard deviations:

```
positive[t] = max(0, positive[t-1] + z[t] - k)
negative[t] = max(0, negative[t-1] - z[t] - k)
```

Entry requires at least 60 completed returns, `positive >= H`, and the current EWMA mean times 30 days exceeds `log(1.022)`. That last condition is an economic hurdle anchored to the common stress round-trip cost, not a forecast guarantee. When flat, choose the qualifying asset with the largest confidence score below, with BTC first on an exact tie. When a qualifying entry occurs, reset the chosen asset's two evidence sums, start a fresh holding clock, and store a single globally desired long symbol. Hold that symbol until its exit; do not rotate merely because the other asset has a larger score. The common evaluator controls delayed-open fills, cash, and the $1,000 position budget. A signal after closed bar `i` fills at bar `i+2` open in base and `i+3` in stress; these delays allow completed-bar finalization without assuming an impossible simultaneous close/open fill.

Exit a desired long when `negative >= H/2`, the EWMA return mean is no longer positive, or 90 daily bars have elapsed since entry. Reset that asset's two evidence sums on exit. Do not reenter on the same close as an exit. Desired state precedes actual state by the evaluator's execution delay; the common execution evaluator remains authoritative for trades and P&L.

Confidence score for ranking simultaneously active assets is `30 * EWMA mean / max(EWMA volatility * sqrt(30), 0.005)`, floored at zero. It is a risk-adjusted drift score, not a calibrated probability. A zero target is emitted while flat or warming up.

## Fixed variants

| Variant | EWMA half-life | Entry evidence H | Reversal evidence H/2 |
|---|---:|---:|---:|
| cusum_l14_h4 | 14 days | 4 | 2 |
| cusum_l14_h6 | 14 days | 6 | 3 |
| cusum_l28_h4 | 28 days | 4 | 2 |
| cusum_l28_h6 | 28 days | 6 | 3 |

No other parameter variations will be tested. Choose the highest common development stress net return minus 0.5 times maximum drawdown, using the common evaluator's dollar metrics. Ties prefer the lexicographically first variant ID, aligned to the shared protocol before the first historical run. Development: 2025-01-01 inclusive to 2025-07-01 exclusive. Later windows are reserved for the root evaluator; this agent will not inspect their outcomes.

## Evidence limits

The cost hurdle extrapolates a recent average, and cryptocurrency drift can reverse abruptly. Daily close signals and next-open fills cannot establish intraday executable liquidity, maker fill probabilities, or stop-loss paths. A handful of favorable trades cannot establish statistically reliable profitability. CUSUM alert thresholds here are fixed exploratory choices, not calibrated false-discovery probabilities under an independent Gaussian return model. The data and historical periods have been reused by prior studies, so the later period is chronologically held out for this candidate, not an untouched prospective test.

## Mathematical reference

The standardized two-sided tabular recurrence follows [NIST, CUSUM Control Charts](https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc323.htm), accessed 2026-09-10. Its evidence-accumulation rationale concerns detecting process-mean shifts; it does not establish a trading edge or validate the return-distribution assumptions used here.
