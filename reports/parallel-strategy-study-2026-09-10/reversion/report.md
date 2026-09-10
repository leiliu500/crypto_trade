# OU residual mean reversion: development result

**This family did not establish a profitable trading candidate in development.** The frozen selection rule chose `patient`, which made zero trades. Its $0 profit is a cash-like result and fails the user's activity objective. The other variants generated trades but lost money after costs. No parameter was changed after these outcomes became available.

The experiment used completed BTC/USD and ETH/USD daily bars, a $10,000 funded account, one long position at a time, and an entry budget capped at $1,000 and 10% of equity. Selection used only 2025-01-01 through 2025-06-30. The common evaluator charged 80 basis points per side plus adverse price adjustment in base, 100 basis points per side in stress, and delayed execution by the prescribed number of bars. Remaining positions were liquidated with costs at the period end.

| Fixed variant | Base net PnL | Stress net PnL | Stress maximum close drawdown | Closed trades | Development selection score |
|---|---:|---:|---:|---:|---:|
| Balanced | -$120.15 | -$109.73 | $172.11 | 2 | -$195.78 |
| Fast | -$199.13 | -$360.84 | $415.09 | 4 | -$568.39 |
| Patient, selected | $0.00 | $0.00 | $0.00 | 0 | $0.00 |
| Rising trend | -$120.15 | -$109.73 | $172.11 | 2 | -$195.78 |

The score is stress net PnL minus half maximum dollar drawdown. Net profits and drawdowns above use the entire $10,000 account; the entry budget is $1,000. Base/stress had the same closed-trade counts here. Stress changes both execution cost and execution date, so its PnL need not be lower than base for every strategy.

The patient model had no eligible entry observations during development. Across the two instruments' 362 daily observations, 92 lacked enough warmup, 59 failed the AR(1) mean-reversion condition, 58 failed the falling-trend filter, and the remaining 153 lacked a sufficiently large cost-aware excursion. This is an observable consequence of the frozen hypothesis and parameters. Relaxing those conditions after seeing losses or inactivity would require a new study and count as additional model search.

The hypothesis estimates a slow trend in log prices, then fits a trailing AR(1) to causal residuals. The fitted equilibrium, stationary residual scale, and half-life govern entries. A forecast must cover the exact stressed roundtrip fee/slippage log cost multiplied by a fixed safety factor. Exits follow normalization, invalidation, holding duration, or a close-based volatility loss threshold. The fit's assumptions can fail during structural price changes; forecasting reversion does not ensure that prices revert before a loss exit.

The module passed synthetic entry/exit generation, flat-series rejection, valid-output, and 20 total prefix-invariance checks. These are implementation checks, not evidence of a financial edge. During independent accounting review, the liquidity cap's volume input was moved from the immediately previous bar to the last finalized bar (`i-2` at an open). Re-running all four variants with that correction produced exactly unchanged development results. Root controls later-period evaluation and qualification; this agent did not inspect those outcomes.

Artifacts: `spec.json`, `candidate.py`, `selection.json`, `development-results.json`, `development-signal-diagnostics.json`, and reproducible `check_signal.py` / `synthetic-checks.json`. The initial pre-outcome cost hurdle was corrected to the exact roundtrip log-cost ratio before the first historical replay; final module/spec hashes are recorded in `selection.json`.
