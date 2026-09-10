This inventory distinguishes mathematical mechanisms already present in the engine from candidates that would introduce a different mechanism. It is a source review, not proof of originality or a new profitability test.

| Existing mechanism | Representative source | Excluded from a claim of new mathematics |
|---|---|---|
| Local empirical conditional return distributions, Gaussian distance weights, shrinkage and tail penalties | `src/distribution/model.ts` | Another neighborhood size, bandwidth, horizon or coordinate scaling |
| Supervised regime partitions for conditional distributions | `src/distribution/regime-model.ts` | Another partition threshold or relabeled regime |
| Adaptive Bayesian/ridge regression | `src/research/hourly-adaptive-model.ts`, `src/research/cross-asset-model.ts`, `src/profit/model.ts` | Another penalty, decay rate, linear feature or posterior confidence threshold |
| Student-t location/scale learning with boosted trees and natural gradients | `src/research/hourly-student-model.ts` | A different tree count, depth or fixed degrees-of-freedom choice |
| CUSUM change detection | `src/core/features.ts`, `src/strategy/deterministic-features.ts` | Another allowance, threshold, lookback or asset |
| Moving-average trend, endpoint momentum and close-channel breakout | `src/spot-trend/signal.ts`, `src/channel/`, `tools/profit-search.py` | Different horizons, bands or asset labels |
| AR(1)/OU residual mean reversion | `reports/parallel-strategy-study-2026-09-10/reversion/candidate.py` | Another residual window or z-score entry threshold |
| Relative momentum rotation and multi-horizon trend weighting | `src/portfolio/signals.ts`, `reports/parallel-strategy-study-2026-09-10/rotation/candidate.py` | New horizon combinations, voting thresholds or asset substitutions |
| Funding-carry economics and inventory/execution checks | `src/carry/` | Renaming the funding transfer, changing the carry window, or dropping a cost term |
| Queue-aware entry-route shadow comparison | `src/execution/entry-route-shadow.ts` | Calling an entry-route decision a complete two-sided market-making system |

The earlier 100-configuration screen comprised six decision templates, ten asset/template groups, 100 registered settings and 94 observed target paths. Consensus and rotation are compositions of recurring statistics. Seven settings produced no trades, including two mathematically contradictory pullback entries. This evidence demonstrates **zero original-to-literature mathematical inventions** and does not establish 100 distinct trading mechanisms.

A proposed method absent from these representative sources still requires a broader repository search and a literature comparison. Absence of a name in source text does not prove absence of an equivalent implementation. Different observed trades likewise do not establish mathematical novelty.

Profit comparisons must use compatible economic contracts. A probabilistic forecast, portfolio allocation algorithm, market-making controller and carry book are different kinds of objects. A forecast needs an explicit decision/execution rule; an allocator needs funded multi-asset accounting; a market maker needs order-event and queue evidence; a carry system needs both legs, funding and collateral cash flows. Applying all of them to the same daily long/cash candle replay would erase important distinctions and could create misleading results.
