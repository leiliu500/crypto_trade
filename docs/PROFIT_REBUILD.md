# Profit rebuild

Profitability is not established. The operational $12 cap was already replaced by risk-bounded sizing with a $1,000 and 1%-of-equity ceiling. A larger ceiling cannot turn a negative expected return into a positive one. This rebuild addresses decision horizon, costs, allocation and measurement, while preserving failed experiments.

The hourly predecessor lost $1,021.72 in 2024 and $803.78 in January–June 2025 under its base economic assumptions. Its price component was negative before fees. Median holding periods were about nine and eight hours, with repeated same-direction reentries and average losses larger than average winners. The detailed attribution is in [attribution.md](../reports/profit-rebuild-2026-09-09/attribution.md). These are descriptive findings from reused data, not evidence that a different holding period must be profitable.

The weekly model uses completed UTC daily closes, seven- and ninety-day volatility-normalized momentum, and a ridge regression fitted at the start of each month. Each paired BTC/ETH training label spans seven days and must mature for another day before fitting. Training uses the preceding 365 days with at least 26 paired weeks. Four-week block resampling retains the BTC/ETH pairing. The resulting interval describes uncertainty about a conditional mean; it is not a predictive return interval or a win probability.

The first weekly decision rule required a conservative mean bound to exceed all modeled costs. It produced zero trades and zero profit across all eight prescribed runs, so it failed. Its sealed source, models, forecasts and results remain in [economic-screen](../reports/profit-rebuild-2026-09-09/economic-screen/report.md).

The separate mean-variance variant keeps the causal forecast and changes allocation. It also failed: base net results were **−$273.52 in 2024 and −$261.97 in January–June 2025**; all eight prescribed runs were negative. It is not activated. The [sealed second study](../reports/profit-rebuild-2026-09-09/economic-screen-v2/report.md) retains every outcome. This evidence does not support profitable deployment.

The variant requires positive estimated gross return after the full cost hurdle, and uses uncertainty in position sizing. Let `mu` be the direction-adjusted net weekly return estimate and `v` the sum of historical weekly return variance and bootstrap parameter-mean variance. Its allocation ceiling is:

```text
fraction = min(0.01, 0.25 * mu / (v + mu²)), provided mu > 0
```

This follows a second-order approximation of expected log wealth, `E[log(1+wR)] ≈ w*mu - w²*(v+mu²)/2`, with a declared quarter-size multiplier. It is a research heuristic, not an exact optimal policy or calibrated probability model. Primary discussions of log-wealth allocation and uncertain parameters include [Browne and Whitt](https://www.columbia.edu/~ww2040/PortfolioChoice96.pdf) and [Bauder et al.](https://arxiv.org/abs/1803.03573). The variance proxy and chosen multiplier are this implementation's assumptions.

Both weekly designs use one shared BTC/ETH position slot. Orders are bounded by the notional/equity cap, actual lot increments, nominal risk budget, and remaining rolling/session/drawdown loss capacity. Stops are four daily volatility units from the initial fill. A qualifying position can remain open across weekly decisions; there is no repeated profit target or short deadline forcing turnover. The system never adds to an existing position. Reductions precede switches, a challenger needs a 25% score improvement, and quantity changes have a 25% deadband except hard risk/cap reductions. A stop requires a new weekly forecast before reentry.

The economic screen is frozen before fitting and replay. It evaluates 2024 and January–June 2025 with base/stressed costs and two funding timestamp interpretations, plus separately constrained BTC-long and ETH-long benchmarks. The mean of those independent benchmark paths is a comparison series, not a simultaneous two-position portfolio. Both periods have been inspected by prior studies; January–July 2026 remains excluded. No parameter grid is searched, and the second variant retains the first variant's economic acceptance thresholds.

All eight candidate runs need complete positive net accounting, no unresolved position or risk breach, drawdown at most $200 at the study's $1,000 notional ceiling, and at least eight active calendar weeks. Base runs also need a positive lower calendar-week bootstrap mean, and pooled base results must exceed the benchmark mixture. These are declared research gates, not universal institutional standards. A passing historical screen can nominate a bounded paper pilot after its raw artifacts are verified; it cannot prove executable or future profit. Full validation remains unavailable without independently verified prospective recorded-book, fill, fee and funding evidence.

Run a new immutable study with:

```sh
npm run research:profit -- --variant utility --out-dir reports/NEW_STUDY_DIRECTORY
```

The runner verifies data manifests and raw hashes, excludes reserved data before feature work, deduplicates identical overlapping source rows, and rejects conflicting rows. It writes the protocol and source copies before fitting. Historical candles provide an economic proxy: depth, spread, partial fills, latency, the intrabar path and actual funding settlement timing are not established by them. Zero-volume hours cannot fill; missing held funding makes net P&L unknown; unfilled terminal inventory is not assigned a fictitious closing price.

# Funded paper accounting

The paper broker models funding using [Kraken's public historical funding API](https://docs.kraken.com/api-reference/historical-funding-rates/historical-funding-rates) and its absolute USD-per-base-unit hourly rate:

```text
funding cash = -signed base quantity * absolute hourly rate * held fraction of hour
```

It records actual partial-fill inventory, interval coverage, source hashes, and idempotent cumulative funding adjustments. Cash and funding state persist atomically with the fill/order/position checkpoint. A restart cannot duplicate an already committed payment. Missing rates remain unknown and can be backfilled; late recovered fills produce explicit correction postings. These are paper model cash flows, not verified exchange cash receipts.

Funding starts at an explicit accounting epoch. Migration preserves existing cash and actual open inventory; it does not rewrite earlier profit or invent missing historic payments. Windows containing earlier unaccounted exposure remain unknown. Lifetime completeness is disclosed separately from current-window completeness.

Rolling and UTC-session realized net values now include recorded execution fees and funding cash at its actual paper posting time. A late adjustment belongs to the session in which cash changed. Open accrued funding is displayed separately and is not called realized cash. Trade-level price P&L continues to exclude funding and is labeled accordingly. Missing current funding evidence blocks new entries while allowing protective exits and preserving the verified fill ledger.

Funding projection uses exact rational arithmetic and indexed rate intervals. Settled obligations are cached; new quotes recompute open accrual only. The broker cache expires at an hour boundary as well as after fills, rates and cash postings, preventing a previous hour's complete status from hiding a newly due obligation.
