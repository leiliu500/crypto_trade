The strongest actionable solution is to measure a fixed strategy's executable edge after verified costs, then change the component that demonstrably destroys that edge. Existing evidence does not establish a profitable replacement. Increasing exposure, relaxing entry gates, or repeating searches on familiar history does not resolve the measured failures.

This review contains **25 distinct economics hypotheses examined by one agent**, not 25 agents. Nine mechanisms or measurement interventions are supported, seven bounded rescue claims are rejected, and nine require additional data. “Supported” never means future profits have been established. The complete rationale, test, expected impact, source paths and source hashes are in [economics-hypotheses.json](economics-hypotheses.json).

The three highest-priority actions are:

1. **E01 — verify the actual fee tier for each traded product.** Spot paper uses 80 basis points per side. The existing [account-fee adapter](../../src/kraken/account-fees.ts) accepts only `PF_` derivatives, so binding authenticated spot fees is a concrete missing integration. An actual account snapshot should supply product, maker/taker rates, observation time and expiry. Kraken's public entry tier currently lists 0.40% maker and 0.80% taker spot fees, with cross-product volume and assets-on-platform qualifications; a simulated balance does not qualify the user for a discount. [Kraken fee schedule](https://www.kraken.com/features/fee-schedule). The read-only TradeVolume API supplies product-specific maker and taker fees and requires query permissions. [Kraken TradeVolume](https://docs.kraken.com/api-reference/account-data/get-trade-volume).
2. **E12 — collect every executable opportunity and decompose gross movement into net return.** For accepted and rejected decisions, preserve signal availability, synchronized quotes/depth, intended orders, order outcomes, and later fixed-horizon executable prices. Show gross movement, spread, slippage, fees and any funding separately. The existing [market data records](../../src/spot-trend/market.ts), [journal](../../src/spot-trend/journal.ts) and [order receipts](../../src/spot-trend/orders.ts) provide a starting point. This establishes whether an intervention should change the forecast, holding period, costs, liquidity rules or execution.
3. **E04 — keep infrequent funded spot exposure as the best existing economic hypothesis for prospective paper testing.** Its reduced turnover gives it a plausible way to amortize high entry-tier spot costs. The parent weekly study had 11 episodes and $27.22 fees across nearly ten years. That is a useful mechanism to test, with a matched-exposure benchmark and a frozen rule. It does not establish a dependable return, and the continuous-entry revision has different execution timing from the historical parent. [Historical study](../new-spot-system-2026-09-10/historical-study/report.md), [entry-timing revision](../spot-continuous-entries-2026-09-10/report.md).

The current paper position shows why gross and net results must be separated. The read-only status response for cycle 165, timestamp `1789068042270`, reports a healthy v3 paper service holding 0.00128587 BTC bought at $77,074. The entry cost was $99.9000015, including $0.7928572 fees. Gross inventory price movement was approximately **+$0.06069**, but the estimated exit fee was another **$0.79334**, giving **−$1.52551 liquidation P&L** and $0 realized P&L. These are simulated paper results, not exchange fills. Selected response fields and the independent calculation are retained in the JSON.

At the configured 80-basis-point fee, the entry's fee-only break-even selling bid is approximately **$78,317.13**, before any additional future execution shortfall. For reference prices with 3 basis points adverse execution on both sides, break-even appreciation is **1.673889%**:

`((1 + entry fee) × (1 + entry slippage)) / ((1 − exit fee) × (1 − exit slippage)) − 1`

The [spot account implementation](../../src/spot-trend/account.ts) already subtracts both acquisition costs and estimated exit fees correctly. Removing an exit reserve would improve the displayed number while leaving economic profit unchanged. The strategy's 1.66% moving-average entry band is a turnover control; it does not predict a further 1.66% price increase.

Several attractive-sounding solutions have already failed bounded tests:

| Saved experiment | Economic evidence | Implication |
|---|---|---|
| Three daily BTC/ETH families | 2026 base net: trend −$16.95; reversion −$186.39; rotation −$98.00 | None is a demonstrated replacement. |
| Same daily decisions, zero commission | Net: −$1.10, −$141.53, −$35.48, retaining 3 bp adverse execution | Fees worsen losses, but fee reduction alone does not rescue these signals. |
| Hourly futures trend | 493 trades and −$1,021.72 in 2024; 244 trades and −$803.78 in 2025 H1 | More activity did not produce positive economics. |
| Saved carry fee frontier | All 36 paths negative at every 0/20/40/80 bp spot-fee assumption | Fee discounts alone do not clear the retained reserves and capital hurdle. |
| Long-horizon carry selector | Zero cycles in all eight saved cases | No observed carry profit exists in that screen. |
| Channel 2026 funded holdout | Three held hours lack funding; full net and drawdown unknown | Missing cash-flow evidence prevents qualification. |

Sources: [daily comparison](../parallel-strategy-study-2026-09-10/report.md), [daily fee sensitivity](../parallel-strategy-study-2026-09-10/sensitivity.json), [hourly trend screen](../systematic-rebuild-2026-09-09/economic-screen/report.md), [carry fee frontier](../carry-fee-frontier-2026-09-09/frontier.json), [long-horizon carry screen](../profit-engine-rebuild-2026-09-09/long-horizon-carry/report.md), [funded holdout](../profit-engine-rebuild-2026-09-09/channel-price-protected-v2/holdout-2026/report.md).

The weekly parent earned $1,175.60 historically, approximately **1.176% of its $100,000 whole account over almost ten years**. It did not earn that return in one year or as an independently funded $100 account. Only 11 completed episodes and a negative lower bootstrap mean of −$0.4782 per week leave profitability unvalidated. Buy-and-hold earned more with different exposure and larger drawdown; that comparison is not risk matched. [Historical report](../new-spot-system-2026-09-10/historical-study/report.md).

Carry deserves precise accounting. Negative `netAfterCostsUsd` in the saved frontier includes a 5% annual opportunity-cost hurdle and conservative reserves; it is not automatically the same as a realized cash loss. Current [funding source](../../src/kraken/paper-funding.ts) and [rolling P&L source](../../src/risk/rolling-pnl.ts) include paper-model postings and label them accordingly. Older v13 documentation predates this implementation, and this audit did not verify which futures build is deployed. Kraken describes funding as continuous accrual, settled at hour end or a change in net position. Observed model accrual and actual venue cash receipts must remain distinct. [Kraken derivatives specifications](https://support.kraken.com/articles/4844359082772-linear-multi-collateral-derivatives-contract-specifications).

All 25 bounded reviews are retained below. Each row's full test and source evidence appear under the matching ID in the JSON.

| ID | Hypothesis or intervention | Status |
|---|---|---|
| E01 | Verify account and product fee tiers | needs_data |
| E02 | Test passive orders with queue-aware evidence | needs_data |
| E03 | Zero commission rescues daily candidates | rejected |
| E04 | Reduce cumulative costs with infrequent funded spot exposure | supported |
| E05 | Larger positions create positive expectancy | rejected |
| E06 | Separate whole-account and allocated-capital return | supported |
| E07 | Value open inventory after selling fees | supported |
| E08 | Include actual operating expenses and capital hurdle | needs_data |
| E09 | Compare future executable return with exact break-even | supported |
| E10 | Loosen economic gates to make more profit | rejected |
| E11 | Faster checks improve weekly-strategy execution | needs_data |
| E12 | Collect all opportunities and attribute gross-to-net returns | supported |
| E13 | Measure partial fills, dust and exit capacity | needs_data |
| E14 | Price asynchronous carry-leg execution risk | needs_data |
| E15 | Discounted spot fees rescue saved carry paths | rejected |
| E16 | Existing long-horizon carry selector is profit-ready | rejected |
| E17 | Enforce both venues' feasible hedge size | supported |
| E18 | Reconcile continuous funding and distinguish venue receipts | supported |
| E19 | Recover exact missing funding intervals | needs_data |
| E20 | Existing adaptive funding model has validated advantage | rejected |
| E21 | Monitor dated carry with positive stressed executable economics | needs_data |
| E22 | Improve collateral efficiency under explicit margin stress | needs_data |
| E23 | Preserve rolling-loss boundaries and unknown historical fees | supported |
| E24 | Prior futures failure came from duplicate or mismatched fees | rejected |
| E25 | Freeze selection and require prospective net evidence | supported |

Validation for this review checked 25 unique sequential IDs, all required fields, the three allowed statuses, 31 referenced local files, and SHA-256 identities for those files. Break-even and paper gross-to-net calculations were recomputed independently. No production code, configuration, account state or deployment was changed, and no orders were submitted by this audit.
