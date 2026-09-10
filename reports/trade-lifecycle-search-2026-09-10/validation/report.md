# Independent lifecycle validation

The independent audit passes for all 928 registered system/window/scenario runs. No substantive implementation defect was found. Neither development-selected BTC nor ETH combination passes the registered descriptive screen, so the comparison does not justify changing a frozen paper experiment or activating live trading.

Reproduce with `python3 reports/trade-lifecycle-search-2026-09-10/validation/audit.py`. The [audit script](audit.py) reads frozen artifacts and original bars without calling the scored simulator. [audit.json](audit.json) records source/result hashes, detailed check counts and both screen outcomes. It writes only this validation directory and verifies that the scored result files remain unchanged.

## Accounting and chronology

All 6,272 fill receipts and 12,146 timestamped events were reconciled. Each finalization decision, including occasions with no submitted request, was independently reconstructed from the registered component rules and available source bars. The largest numeric residual was 7.46e-9 or less in the corresponding field's units.

- A request is created after its signal bar finalizes at the next open plus 60 seconds. Its only fill attempt occurs at the registered future open, with the correct two- or three-bar lag. Current-day high, low, close and volume cannot create an earlier decision.
- Buy sizing uses execution-day index i−2 volume, a fee-inclusive cap of $1,000 or 10% of available cash, instrument lot precision and minimums. Cash is never borrowed, and an existing position receives no additions.
- Entry ATR is independently computed as the mean span of each bar expanded to contain the preceding close. Only finalized pre-fill bars contribute. Risk and holding decisions use post-entry finalized closes; no pre-entry bar advances holding age or triggers a protective/profit/trailing exit.
- Both fees, adverse price rounding, daily liquidation equity, inventory, turnover, reference-price gross edge and net P&L reconcile. At both episode and account level, reference edge minus adverse price costs minus both fees equals net P&L.
- The event trace reproduces 36 canceled entry intents after parent-thesis invalidation, two pending entries canceled at a window boundary, and no canceled committed exit intent. There is no same-day re-entry after a sale. These aggregate counts include overlapping windows and repeated scenarios; they are audit workloads, not independent market observations.
- Natural exits and 474 forced terminal sales are counted separately. All outstanding intents and residual holdings are handled at each declared window boundary. Terminal sales never supply the minimum natural episode count.
- The reported close drawdown and prior-close-peak-to-daily-low drawdown reproduce. Neither metric reconstructs a true intraday high-to-subsequent-low price path.

The historical runs have zero assumed sales below instrument minimums and zero risk-policy entries lacking a positive ATR. That means those particular disqualifying assumptions were not encountered in this sample. It does not verify actual historical executable depth, exchange order acceptance, partial fills or maker queue priority. Full costed OHLC fills remain screening assumptions.

## Registration, selection and component attribution

The audit checks all frozen input hashes and result hashes. Full-history targets preserve the development prefixes, and later evaluation preserves the entire development ledgers. There are exactly 27 component combinations per asset, plus cash and passive controls; four periods and four scenarios produce 928 runs.

Both asset winners, the choices including cash, all rankings and the separately selected single-stage choices reproduce solely from development-period minimum utility across the four scenarios. Later outcomes do not change those selections. Registered timestamps and hashes establish consistency within this run; they do not establish that this previously searched historical data were unknown to earlier research.

Standalone components of the joint winner, independently selected single-stage winners, and removal of one component from the joint winner are distinct comparisons. Their identities and all joint improvements, additive sums, removal impacts and interaction residuals reproduce. These values are conditional historical contrasts; summing isolated benefits is not evidence that their joint future benefit is additive.

The BTC selected combination's development utility is unchanged if its 84-day holding cap is removed. That cap is retained through the declared lexical tie-break, not through demonstrated improvement under the selected entry gate in development. For example, BTC's base 2025H2 joint improvement is +$95.67, while the sum of standalone component improvements is −$104.37, leaving a +$200.04 interaction residual. Its continuous base joint improvement is −$2.65 with a −$44.81 residual. These different paths show why individual stage rankings cannot be treated as universal optima.

## Defensible asset conclusions

Each window starts with $10,000 and limits a fee-inclusive entry to $1,000 or 10% of cash. Later-window sums below combine July–December 2025 and January–September 9, 2026 cash-reset runs; they are not the continuous portfolio diagnostic.

| Development-selected combination | Later base net | Later combined cost/delay net | Naturally completed later episodes | Screen result |
|---|---:|---:|---:|---|
| BTC path-efficiency entry, bounded 84-day holding, thesis-only exit | −$56.24 | −$27.68 | 1 in each scenario | Fails profitability and episode requirements |
| ETH baseline entry, two-day thesis persistence, thesis-only exit | +$494.43 | +$619.18 | 8 at two-bar delay; 7 at three-bar delay | Fails episode, drawdown and consistent baseline-improvement requirements |

BTC improves on its normalized baseline over the later windows, but remains negative in aggregate and has no naturally completed episode in the 2026 window. Cash remains a useful zero-return alternative; the development lock cannot be retrospectively rewritten to claim it selected cash.

ETH is positive in every registered development/later window and cost scenario, yet positivity alone is insufficient. Its later base net is below the baseline's +$563.32, and the largest selected later sampled low drawdown is $545.11, above the $500 limit. Its larger combined cost/delay return does not erase the weaker base comparison; execution delay can improve or worsen historical paths. All four scenarios must remain visible.

The baseline is a normalized daily lifecycle control, not exact execution parity with the current BTC/ETH40 services or the earlier target-array simulator. In particular, pre-entry observations do not trigger holding exits in this engine. Paper accounts and their frozen rules must remain separate from these research results.

No untouched historical holdout exists here, and 54 combinations are recombinations of established components rather than 54 mathematical inventions. The execution specialist correctly keeps maker economics separate from demonstrated maker fills. Fresh forward observations remain necessary before any claim of validated future profit or a live replacement.
