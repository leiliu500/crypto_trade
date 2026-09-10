The strongest lead from this search is **ETH with a 40-day moving-average trend rule**. A continuous historical replay from 1 January 2025 through 9 September 2026 earned **$948.41 after base trading costs**, or **$841.40 with higher costs and an extra day's execution delay**, from a $10,000 simulated account. These are total returns of **9.48% / 8.41% over the entire interval**, with a fee-inclusive entry ceiling of $1,000 and 10% of current equity. They are historical simulations, not money earned by the running account or dependable expected returns.

**No configuration passed the complete research screen.** The selected ETH rule is a useful next research candidate, but its nine later trade episodes, concentrated winners and drawdown fail the preset evidence/risk criteria. The search has narrowed the problem to a concrete rule with positive historical economics; it has not solved future profitability.

The session permits four agents at once. The work used the primary agent and three actual investigators for economics, strategy design and independent validation. It **did not create 100 agents**. It tested **100 configurations**: six mathematical rule types, split into ten asset/family groups, with ten lookback values each. All **1,200 strategy/window/scenario results**, 36 baseline results and every order/trade/equity ledger are retained. The related configurations are not independent statistical evidence. Seven configurations never traded; two 90-day pullback configurations contain contradictory entry requirements and are explicitly retained as rejected configurations. The audit found 94 distinct target paths on this dataset.

The selected rule is implemented in [the reproducible research tool](../../tools/profit-search.py). After 90 completed bars of warmup, calculate the mean of the latest 40 completed ETH/USD daily closes. Enter a funded long target when the close exceeds that mean by **1.673889%**; exit when the close is at or below the mean; otherwise preserve the prior target. The band reduces turnover and is not a forecast of a profitable price move. No shorts, leverage or additional purchases during a holding episode are modeled.

The rule was selected by the highest development utility across all 100 configurations: maximize the worst of the four scenario values of `net profit - 0.5 * close-based drawdown`. The [selection lock](screen/development-lock.json) was written before this invocation computed the later windows. The independent auditor reproduced all development results from data truncated before July 2025. **These dates were already used by earlier repository research**, so that lock does not turn this into an untouched holdout. Broad searches on familiar history increase selection bias. [Bailey et al., The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

| Separate reset-account window | Base net | Higher costs, same delay | Extra delay, base costs | Higher costs + extra delay | Episodes per scenario |
|---|---:|---:|---:|---:|---:|
| January–June 2025, development | $377.80 | $370.38 | $380.29 | $372.86 | 1 |
| July–December 2025 | $335.75 | $312.11 | $327.16 | $303.85 | 4 |
| January–9 September 2026 | $227.56 | $198.97 | $187.87 | $159.58 | 5 |

Each row starts a new $10,000 account. Do not add those percentages and call them compounded returns. The separate continuous-account diagnostic holds cash and inventory across those boundaries and produces:

| Same-account January 2025–September 2026 replay | Base | Higher costs + extra delay |
|---|---:|---:|
| ETH40 net | $948.41 | $841.40 |
| Return on starting account | 9.48% | 8.41% |
| Maximum daily-close liquidation drawdown | $667.25 | $735.94 |
| Maximum sampled-peak-to-daily-low drawdown | $705.84 | $752.57 |
| Closed episodes, including terminal sale | 10 | 10 |
| Trading fees paid | $167.66 | $208.52 |
| BTC buy-and-hold net | -$204.59 | -$219.41 |
| ETH buy-and-hold net | -$296.88 | -$330.71 |
| Cash net | $0.00 | $0.00 |

Passive comparisons use the same starting account, initial entry budget, execution conventions and fees. Their exposure paths differ: fixed units can appreciate while the active rule exits and makes later capped entries. This is not a comparison against investing the full $10,000 in buy-and-hold. Inventory gains may increase exposure above the initial $1,000 entry limit. The research evaluator does not implement the running weekly system's marked-exposure reductions or account halt. Its historical numbers therefore cannot be attached to that runtime or to a proposed risk-limited adaptation without another replay.

The search was broad enough to find positive examples, but the result remains fragile:

- Only **ETH SMA40 and SMA50** were positive in every window/scenario. SMA50 had only $39.13 in the recent combined-stress window. Nearby SMA30 lost $278.74 there; SMA60 lost $213.06 in development combined stress. This is limited local support, not a broad stable performance plateau.
- ETH40 had only **nine combined later episodes**, below the registered minimum ten. Its worst later reset-account low drawdown was **$517.04**, above the registered $500 limit. The continuous-account diagnostic shows larger drawdown, reaching **$752.57**, or 7.53% of starting capital. No drawdown cap was enforced in these replays.
- In second-half 2025, one base-cost winner contributed **$623.09** against $335.75 total profit. The other episodes sum to **-$287.34**.
- In 2026, the final holding contributed **$355.70** under the terminal-liquidation convention; the four strategy-triggered exits together lost **$128.14**. Under combined stress all four strategy-triggered exits lost, totaling **$176.78**. The final sale includes costs and is valid terminal valuation, but is not evidence of a successful strategy-triggered exit.
- A descriptive 14-day block bootstrap gives the selected rule's 2026 base net a nominal one-sided 95% lower value of **-$278.47** versus cash, and **-$662.90** after a 100-trial tail adjustment. Bounds versus both passive baselines are also negative. The 20,000 replicates, sparse episodes and unknown earlier searches do not support a global statistical guarantee.

Base execution applies **80 basis points in fees and 3 basis points adverse pricing per side**; cost stress uses 100 and 10. Base signals from completed bar `i` execute at open `i+2`, allowing for finalization; delay stress uses `i+3`. Current public Kraken Tier 1 spot fees support the 80-basis-point taker assumption, but the user's real account entitlement is unverified. The public schedule has different tiers, and simulated account cash does not establish assets held on the exchange. [Kraken fee schedule](https://www.kraken.com/features/fee-schedule).

Both purchases and terminal sales pay fees, adverse prices and tick rounding. Purchases also respect lot size, minimum quantity/notional, available cash and a cap derived from previously finalized daily volume. Sell fills remain assumed. Daily OHLC data cannot establish executable depth, bid/ask spreads, order acceptance or intraday stop paths. Intraday-low drawdown is a sampled diagnostic, not a bound on full peak-to-trough losses. Taxes and computing/infrastructure costs are excluded. Idle cash receives no interest. Source responses exclude unfinished candles and retain hashes. [Kraken OHLC documentation](https://docs.kraken.com/api-reference/market-data/get-ohlc-data).

The economics review explains why the current system has not supplied dependable profits. Earlier short-horizon action estimates were negative after costs, and the previous daily CUSUM, OU and rotation candidates lost even with zero commissions. At the reviewed live spot snapshot, a roughly $99.90 funded entry had about $0.06 gross price appreciation but **-$1.53 liquidation P&L**, because entry and estimated exit fees totaled about $1.59. That small snapshot is an accounting diagnosis, not evidence that the strategy will keep losing. The latest reviewed engine was healthy and holding a position; repeated purchases would add exposure and costs rather than demonstrate another edge. See the [economics review](economics-review.md) and its dated [evidence ledger](economics-hypotheses.json).

The concrete next research choice is to **freeze ETH40 for a separate forward observation experiment**, retaining the exact band, exits and candidate identity. Record every decision, available bid/ask, achievable size, projected and realized fees, fill or rejection, and subsequent marked net P&L. Compare it with cash, funded passive ETH/BTC and the existing weekly BTC rule on matching dates and exposures. The [forward experiment specification](forward-experiment.json) captures this nomination and the unresolved requirements; a forward collector or execution adapter has **not** been started. Real-account spot fee lookup is a useful separate integration: the existing authenticated account-fee loader currently restricts requests to derivatives products. Lower fees should be measured with actual fill behavior rather than assumed to fix the signal.

Do not repair the failed historical screen by reducing the episode requirement, increasing the drawdown limit, deleting the terminal loss diagnostic or choosing new thresholds after seeing these results. If risk sizing is changed to fit a lower drawdown objective, it creates a new candidate whose net returns and runtime behavior need separate evaluation. A subsequent observation period must remain inconclusive when too few completed episodes are available. No configuration, running service, dashboard, account or order route was changed by this search.

Independent verification passed **900 causal-prefix checks, 400 development-only replays and 1,200 independently reconciled ledgers**, plus source hashes, all 36 baselines, selection and screen-status checks. The reviewer also ran **78 existing focused accounting, data, replay and paper-order tests**, all passing. Software and accounting correctness do not establish market profitability. See [independent audit](screen-audit.json), [validation review](validation-review.md), [strategy review](strategy-review.md), and [selected diagnostics](selected-diagnostics.json).

All configurations and failures can be inspected in [comparison.csv](screen/comparison.csv), [all-results.json](screen/all-results.json), [protocol.json](screen/protocol.json) and the [selected full ledgers](screen/ledgers/sma_eth-040.json). Reproduce the main screen in a new directory; it refuses to overwrite a completed run:

```bash
python3 tools/profit-search.py --out /tmp/profit-search-100-reproduction
python3 reports/profit-search-100-2026-09-10/screen-audit.py
```

The supplemental `analyze.py` also refuses to overwrite its completed diagnostic artifact. Its concentration, continuous-account and bootstrap calculations are preserved for independent inspection. The three investigator ledgers each contain 25 reviewed interventions; these written reviews are distinct from the 100 simulated configurations and are not additional independent agents or profit trials.
