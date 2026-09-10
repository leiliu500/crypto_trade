# BTC/ETH accounting and funding research rebuild

This release separates three questions: whether the simulator operates correctly, whether a forecast adds predictive value, and whether an executable strategy earns returns after all costs. The new work improves the first and tests part of the second. It does not establish the third.

## Paper runtime

The v13 main runtime uses the actual trailing 24-hour sum of realized price P&L minus recorded execution fees, separate from the UTC-session window. All five portfolio entry checks use it. The dashboard and persisted health snapshots show the measurement and its completeness; funding is explicitly excluded. Missing current-window fees or inconsistent inventory history block new entries while reduce-only exits remain available. Entry permissions, strategy thresholds, risk magnitudes, and the existing unvalidated distribution paper trial retain their prior values.

The upgrade's read-only preflight uses the saved simulator history: 382 orders, 382 fill activities, and no open positions. There are 102 legacy fills without fee records, all before the current 24-hour window. The first preflight correctly exposed that a whole-history fee requirement was too broad; its failed report is preserved at `../rolling-pnl-preflight-v13-2026-09-09.json`. The corrected ledger keeps those fees unknown while calculating later windows from their own evidence. It still verifies every historical fill quantity, price, order total, weighted fill average, and remaining position.

The compressed preflight input is retained here. Boundary tests cover a missing old entry fee followed by a fully observed new exit loss, unknown fees one millisecond inside the window versus exactly at its excluded left boundary, and truncated inventory history despite no recent trading. Other tests cover partial fills, duplicate/conflicting receipts, UTC midnight, restart recovery, and a fill arriving during account reconciliation.

## New strategy research

The independent continuous-funding component integrates signed base quantity times absolute USD funding rate over actual holding time. It separates accrued obligations from actual cash receipts and reconciles both. It follows the timing described by [Kraken's contract specifications](https://support.kraken.com/articles/4844359082772-linear-multi-collateral-derivatives-contract-specifications), but it is not connected to verified exchange cash receipts in the running broker. Complete-strategy P&L therefore remains unknown.

The fixed funding forecast was tested on existing 2023–2025 development history with explicit delayed availability and simple zero, last-rate, and 30-day-average baselines. It did not consistently beat them. Only six monthly cohorts per asset are comparable in 2025 because seven missing hours affect targets and later lookbacks. The independent audit reproduced all 48 cohorts. See `../carry-funding-model-development-2026-09-09/README.md`.

The saved carry snapshot was also recalculated at fixed hypothetical spot fees of 0, 20, 40, and 80 bp per side. All 36 declared paths remained negative at every fee assumption under the retained futures fees, spreads, slippage, capital hurdle, and basis/unwind reserves. These are independent product/budget sensitivities, not realized returns or simultaneous allocations. See `../carry-fee-frontier-2026-09-09/frontier.json`.

No profitable candidate has been approved. Account-specific fees and complete paired historical execution evidence remain unverified. This work adds no real-order adapter and makes no profitability claim.
