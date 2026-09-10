# Independent validation of the BTC and ETH system comparison

The independent audit found no substantive accounting or causal implementation defect in `results-v1`. Neither preselected new candidate passed the registered historical screen. These results support continuing the existing BTC and ETH40 paper observations; they do not justify replacing either system or enabling live trading.

The reproducible audit is [audit.py](audit.py); detailed checks and hashes are in [audit.json](audit.json). Run it from the repository with `python3 reports/asset-system-search-2026-09-10/validation/audit.py`. It writes only this validation directory and checks that registered result files remain unchanged.

## What was independently checked

- All 208 system/window/scenario ledgers were reconstructed from emitted orders, original OHLC bars, exchange rounding rules and the registered fee assumptions, without calling the shared evaluator. Daily equity, cash, inventory, both fees, turnover, adverse price costs, entry budgets, exposure, episode P&L and both reported drawdown metrics reconcile. The largest numerical residual was below $0.00000001 or the corresponding rounding-unit tolerance.
- Every order obeys the side's adverse tick rounding, lot precision, funded cash and fee-inclusive entry cap. Entry signals are finalized before the simulated fill; volume sizing uses the latest finalized daily bar. Synthetic zero-volume tests in all four scenarios reject unavailable participation capacity without backdating fills and show that yesterday's unfinalized volume cannot affect today's entry.
- Natural exits and forced terminal sales reconcile separately. Terminal sales do not contribute to the minimum naturally completed episode requirement.
- The BTC weekly control was reconstructed independently across the full daily history using the actual paper caller's native-week-open cutoff and 40-week hysteresis. The most recent week is excluded when its 60-second finalization timestamp falls after that cutoff. The normalized daily execution and account sizing remain different from the running BTC service.
- Source/data hashes match registration and the selection lock. Development target prefixes and development summaries are unchanged in the later evaluation. The winner per asset reproduces from the minimum development utility over the four scenarios. Later results retain those winners.
- Both selected candidates reproduce their full-history target prefixes on truncated inputs. This complements the candidate agents' broader mathematical and synthetic checks.
- All six paired bootstrap comparisons were reproduced by sampling individual day indices in 14-day circular blocks, with 5,000 replicates and the registered seed. Point differences and nominal/adjusted quantiles match. Qualification checks reproduce exactly.

## What the result means for each asset

Each comparison below uses a fresh $10,000 account per window and a fee-inclusive entry cap of $1,000, with unused funds in cash. The two later windows are July–December 2025 and January–September 9, 2026. Their summed results are separate window replays, not one continuous portfolio.

| Asset and preselected new candidate | Later windows, base net | Later windows, combined cost/delay net | Natural later episodes | Conclusion |
|---|---:|---:|---:|---|
| BTC rank persistence and Sen slope | -$211.01 | -$233.94 | 2 | Fails; no replacement established |
| ETH drawdown recovery | -$120.01 | -$95.01 | 7 | Fails; no replacement established |

BTC's rank/Sen candidate won the registered development comparison, including controls, but loses in both later windows. Its adjusted lower excess bound against cash is -$832.49; against the normalized current BTC signal it is -$719.51. Cash's zero net return exceeds the selected candidate and current BTC control over these later windows. This evidence supports paper observation and the no-trade control, not a live-profit claim.

ETH40 already beat the new ETH recovery candidate on the registered development objective: $286.79 versus $170.97 worst-scenario utility. The recovery candidate was selected only as the best *new* ETH candidate. ETH40's combined-cost/delay net across the later windows is +$463.43; recovery's is -$95.01. The recovery candidate's adjusted lower excess bound against ETH40 is -$1,937.31. Retaining ETH40 for prospective observation is the defensible comparison outcome. A different candidate's favorable later result cannot replace the frozen selection after those results are inspected.

## Limits on the conclusion

These historical dates have already been searched. The later windows are not untouched holdouts, and file hashes cannot establish absence of earlier exposure. The candidate count covers eight applications of established mathematics, including related families; it does not establish eight original inventions or an exhaustive search for the best possible system.

The bootstrap is descriptive. Its eight-current-trial adjustment cannot correct an unknown earlier search count, few independent trading episodes, or all dependence introduced by window resets. Negative lower bounds reject a favorable claim under this screen; positive historical net on its own would not validate future profits.

OHLC opens, full exits and terminal close sales are screening assumptions. They do not reproduce executable bid/ask depth, partial fills, order latency or queue priority. The reported daily-low drawdown measures declines from prior observed close peaks, rather than true intraday high-to-subsequent-low drawdown. Current fee assumptions are applied consistently to history; actual historical account tiers are not established. Taxes and infrastructure costs are excluded.

Fresh, durable forward observations with executable quotes and realistic account costs remain the needed evidence for both assets. No runtime, strategy rule, account or deployment was changed by this audit.
