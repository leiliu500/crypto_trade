# Causal residual mean reversion

This candidate buys a temporary negative deviation from a slowly changing log-price trend. A rolling AR(1) model estimates the residual's equilibrium, stationary scale, and half-life. It enters only when the negative deviation and expected convergence are large enough to clear a conservative execution-cost hurdle. It holds one funded spot position at a time and chooses the larger forecast-to-residual-risk ratio when BTC and ETH qualify together.

Four variants were defined in `spec.json` before observing their replay outcomes. `candidate.py` is a pure signal module: it receives aligned daily bars and returns desired long/cash targets. It does not access exchange services, trading configuration, account state, or future execution prices. Signal exits are evaluated at completed daily closes; the common evaluator supplies execution delays and fees. A volatility-scaled close exit is not an intraday guaranteed stop.

The mathematics expresses a testable hypothesis, not a statistical guarantee. An AR(1) coefficient below one in a small rolling sample is not proof of stationarity, the fitted equilibrium can move, and detrending induces residual dependence. The expected-reversion hurdle is a model forecast; realized returns can miss it. A downward regime change can invalidate the fit after an entry. These limitations must be assessed through chronological validation, execution-cost stress, and enough completed trades.

Synthetic checks with seeded AR(1) residuals established that every variant can emit entry and exit signals, returns a valid target at every bar, and is prefix invariant at five truncation points. These checks establish implementation properties, not financial performance.

Run the development experiment with `python3 reports/parallel-strategy-study-2026-09-10/reversion/candidate.py` after the root's `common.py` and shared dataset are available. Model selection uses only 2025-01-01 through 2025-06-30 and the root-defined stress-net-profit-minus-half-drawdown score. Older work has used these historical periods, so later chronological comparisons are not a claim of untouched prospective evidence.
