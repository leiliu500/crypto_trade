# BTC/ETH momentum rotation: development report

**The selected rotation model does not establish a profitable edge.** All four
registered variants lost money in the development stress scenario. The
least-negative stress utility selected `rotation_m60_t90`: 60-day momentum,
90-day trend floor, and fixed entry/switching hurdles tied to nominal base
round-trip friction. The model is frozen for the root's later evaluation; its
parameters were not changed after seeing development results.

The model chooses BTC, ETH, or cash. It enters the strongest eligible asset
only above its absolute trend floor and momentum hurdle, retains a valid
incumbent within a hysteresis band, and rotates only for a material relative
strength advantage. `spec.md` contains the full formulas and the documented
pre-outcome warmup amendment. This is a momentum ranking hypothesis rather
than a calibrated expected-return estimate.

## Complete registered development comparison

Window: 2025-01-01 through 2025-06-30. Initial account: $10,000. Maximum entry
budget: $1,000, including entry fees; actual entry budget also respects the
shared 10%-of-equity and volume limits. All trades are funded spot longs.
Results include execution costs, fees, and terminal liquidation.

| Variant | Base net P&L | Stress net P&L | Stress maximum daily-close drawdown | Stress closed trades | Stress selection utility |
|---|---:|---:|---:|---:|---:|
| rotation_m60_t60 | -$188.72 | -$193.35 | $289.61 | 7 | -$338.16 |
| **rotation_m60_t90** | **+$5.47** | **-$58.55** | **$230.09** | **5** | **-$173.60** |
| rotation_m90_t60 | -$279.63 | -$280.30 | $343.94 | 6 | -$452.27 |
| rotation_m90_t90 | -$136.16 | -$137.27 | $265.05 | 4 | -$269.80 |

Selection utility is net P&L minus one-half of maximum dollar drawdown. It is
used to select the registered candidate even when every candidate fails to
earn money; selecting one does not imply it is suitable for deployment.

For the selected model, base return was +0.055% of the full account and stress
return was -0.586%. Base fees were $79.82 plus $3.00 of adverse price costs;
stress fees were $98.97 plus $9.91 of adverse price costs. Stress also delays
execution one additional daily bar, so the difference between scenarios must
not be attributed solely to fees. There was only one positive calendar month
in each scenario. Five completed development trades are too few to establish
stable expectancy.

## Verification and common-accounting review

- `check_signal.py` passed 20 synthetic checks: adequate warmup, relative
  momentum selection, prefix invariance, staying in cash when positive
  momentum is below the cost hurdle, bearish cash allocation, and exit on
  trend failure. Results are in `synthetic-checks.json`.
- `run_development.py` loads only `development.json` and asserts that no
  observation is at or beyond 2025-07-01. No validation or final-period market
  data or strategy outcomes were inspected by this candidate agent.
- Reviewed shared accounting: delayed signals precede fills; buys reserve
  fees and round quantity down; sells charge fees; rotation sells before
  buying and uses resulting cash; terminal liquidation is charged; aggregate
  closed-trade P&L reconciles to account cash. No material accounting defect
  remained in the reviewed version.
- The root corrected the volume reference from bar `i-1` to `i-2` because
  `i-1` is not finalized at the next open. Initial results are preserved under
  `initial-accounting/`. All variants were rerun without changing parameters;
  monetary results and the selected variant were unchanged. Current hashes
  are in `registration.json` and `selection.json`.
- The signal tracks an intended allocation; the shared evaluator supplies
  actual delayed inventory. A chronological window starts with cash, so its
  first fill may adopt an allocation whose signal began during warmup. This
  is a documented target-allocation replay, not a broker-state simulation.
- The intraday-low drawdown statistic uses daily lows and prior close peaks.
  It does not reconstruct the unknown order of intraday highs and lows.
  Historical tick/lot rules and liquidity caps are approximations when only
  current instrument metadata and daily bars are available.

## Recommendation to the root comparison

Continue the frozen candidate through the common later windows, but do not
describe the development winner as profitable or deploy it from these
results. If later evaluation is also weak, reject this model family under the
tested costs instead of reducing the hurdle merely to increase entries.
The history was used in previous research, so later chronological windows
are not a genuinely untouched holdout; prospective paper evidence is still
needed even if a later result looks attractive.

Reproduction: `python3 reports/parallel-strategy-study-2026-09-10/rotation/check_signal.py`
and `python3 reports/parallel-strategy-study-2026-09-10/rotation/run_development.py`.
