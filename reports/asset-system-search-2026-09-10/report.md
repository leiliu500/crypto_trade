The four-agent search tested eight frozen BTC/ETH candidate applications. **No new replacement passed the declared profit, cost, episode and drawdown screen.** All four new BTC candidates lost money in the continuous historical replay after the specified costs. ETH40 retained the highest continuous net return among the ETH strategies compared here. These findings support continuing the existing paper observations, not deploying a new profit claim.

**These amounts are historical simulations, not the BTC or ETH40 forward accounts.** The daily history from September 2024 to September 2026 has already been used by earlier searches. The results therefore cannot establish an untouched holdout, a universally best system, or future profitability.

The four specialist roles were BTC mathematics and signal design, ETH mathematics and signal design, execution economics, and independent validation. Candidate definitions and source hashes were frozen before this run measured their returns. The coordinator applied one common funded accounting model and locked one new candidate per asset using only January–June 2025. Later results did not change that selection.

| Asset | Defensible outcome | Next action |
|---|---|---|
| BTC | The preselected rank/Sen method was the least-losing new candidate over the continuous period, but failed both later windows. Cash beat all four new BTC policies in that replay. | Keep the current BTC service as paper research; this study does not justify a replacement or live allocation. |
| ETH | ETH40 outperformed the four challengers on continuous historical net return and was already ahead on development utility. The preselected recovery challenger failed later consistency. | Keep the existing ETH40 rules and forward account frozen; continue the registered observation. |

The comparison below spans **January 1, 2025–September 9, 2026**, starts each continuous run with **$10,000 cash**, and caps each fee-inclusive entry at **$1,000 and 10% of current cash**, additionally limited by past finalized volume. There are no shorts, leverage or additions. Dollar returns belong to the full account; they are not annualized. Base assumptions are 80bp fees plus 3bp adverse slippage per side and execution at daily open i+2. Combined stress uses 100bp plus 10bp per side and open i+3. Current public Tier1 spot taker fees support the base assumption; the actual account tier remains unverified. [Kraken fee schedule](https://www.kraken.com/features/fee-schedule).

| Asset / fixed method | Base net | Combined stress net | Stress sampled-low drawdown | Natural episodes / forced terminal sales |
|---|---:|---:|---:|---:|
| BTC · Latent local-linear trend | −$264.10 | −$349.33 | $421.62 | 6 / 1 |
| BTC · Causal nonlinear return forecast | −$197.25 | −$314.44 | $405.84 | 4 / 0 |
| BTC · Rank persistence and robust slope **[development selection]** | −$7.01 | −$65.53 | $389.56 | 3 / 1 |
| BTC · Directional-change event state | −$414.11 | −$476.82 | $707.16 | 9 / 1 |
| BTC · BTC weekly signal control (normalized) | −$39.87 | −$96.34 | $348.65 | 1 / 1 |
| BTC · Passive BTC | −$204.59 | −$219.41 | $668.30 | 0 / 1 |
| BTC · Cash | $0.00 | $0.00 | $0.00 | 0 / 0 |
| ETH · ETH continuous-state drift filter | $644.81 | $680.30 | $613.01 | 5 / 1 |
| ETH · ETH mature-label BTC context regression | −$52.83 | −$298.12 | $404.68 | 7 / 0 |
| ETH · ETH close-location volume pressure | $659.86 | $535.68 | $347.08 | 2 / 1 |
| ETH · ETH drawdown recovery state machine **[development selection]** | $514.63 | $364.69 | $482.05 | 11 / 0 |
| ETH · ETH40 frozen signal control | $948.41 | $841.40 | $752.57 | 9 / 1 |
| ETH · Passive ETH | −$296.88 | −$330.71 | $901.49 | 0 / 1 |
| ETH · Cash | $0.00 | $0.00 | $0.00 | 0 / 0 |

The BTC control uses the current native-week SMA40 signal and its availability cutoff, normalized into the same daily execution and sizing assumptions as the challengers. It is **not an exact replay of the running BTC service**, which uses a different account size, entry cap, continuous checks and marked-exposure controls. The ETH40 row reproduces the prior frozen daily-signal control. Both controls are existing systems, not new inventions.

For the BTC development-selected rank/Sen method, combined-stress net was **+$123.11** in development, **−$34.08** in July–December 2025 and **−$199.85** in January–September 2026. The ETH recovery method made **+$308.35**, **−$119.82** and **+$24.81** in those respective cash-reset windows. The continuous results differ because they carry inventory and capital across period boundaries; the reset windows must not be added and represented as one continuous account.

Both selected challengers failed positivity across the declared scenarios, the minimum ten naturally completed later episodes, and positive paired uncertainty bounds against cash, their own passive asset and the existing signal control. Their combined-stress paired lower excess bounds versus cash were **−$832.49 BTC / −$1,019.33 ETH**, after an eight-trial adjustment. These are descriptive block-bootstrap diagnostics, not valid new significance claims: the history and many earlier candidate searches are already known.

Other ETH challengers can look attractive after seeing the complete history: Kalman produced +$680.30 under combined stress, and volume pressure +$535.68. Selecting them now would be a new selection using later results, not validation of the locked decision. Kalman had only five natural continuous episodes and $613.01 sampled-low drawdown; volume pressure had two episodes and lost in the recent stress window. Neither establishes a replacement.

The ETH recovery challenger also depended on one episode: its largest combined-stress episode earned $563.17, compared with $364.69 total. Excluding that episode leaves −$198.48. ETH40 earned $841.40 under combined stress, but its largest episode contributed $557.63 and it had only nine natural completed episodes plus one forced terminal sale. Its $752.57 sampled-low drawdown and prior failed qualification remain visible. These post-result concentration diagnostics do not alter selection or authorize a change.

Eight applications do not mean eight independent mathematical inventions. BTC used latent-state Kalman trend, nonlinear Gaussian-process prediction, Kendall rank persistence with Theil–Sen slope, and directional-change event state. ETH used a Kalman drift filter, matured-label BTC-context ridge regression, close-location volume pressure, and a drawdown/recovery state machine. Kalman appears on both assets; volume pressure is a feature-based variant, and event policies have existing trend/reversion ancestry. Full equations, parameters, primary references and lineage limits are in the [BTC review](btc/review.md) and [ETH notes](eth/research-notes.md). No parameter grid was substituted for these definitions.

The cost review found that a fee-inclusive $1,000 round trip requires about **1.6739%** reference-price appreciation just to break even under base assumptions, or **2.2244%** under combined cost stress, before extra tick, spread or depth effects. Faster turnover cannot solve that arithmetic on its own. Using maker fees without proving passive fills would overstate performance. BTC and ETH share the percentage fee assumption but require independent spread, depth, precision, minimum-size and quote-freshness checks. [Execution audit and reproducible calculations](execution/report.md).

Every historical fill is an OHLC proxy. The shared simulator assumes full exit liquidity, uses current instrument rules historically, resets cash in separate windows and liquidates remaining inventory at the terminal close. Those terminal sales pay costs but do not count as naturally completed episodes. The sampled-low drawdown measures declines from prior observed closing equity peaks to daily lows; it misses intraday high-to-subsequent-low paths. Taxes, infrastructure costs, historical order acceptance, queue position and partial fills are not established. The [protocol](protocol.json) freezes these limits and the [selection lock](results-v1/selection-lock.json) preserves the selection chronology.

The independent reviewer reconstructed all **208 simulation ledgers** directly from orders and raw bars, reproduced all six paired bootstrap comparisons, checked the BTC weekly availability cutoff across 720 daily observations, and verified candidate causality and the frozen selection. No substantive implementation defect was found; the largest numerical reconciliation residual was below $0.00000001. The reviewer independently reproduced both failed qualification decisions. This validates the implementation of the stated historical experiment, not future profitability. See the [independent validation report](validation/report.md) and [machine-readable audit](validation/audit.json).

No BTC, ETH40 or distribution runtime, configuration, account, server port or order route was changed during this research. The distribution model remains disabled. No new forward experiment or live trade was launched. ETH40 remains subject to its existing six-month review and minimum ten completed episodes; neither its historic return nor this comparison shortens that requirement.

Artifacts: [comparison CSV](comparison.csv), [all scenario metrics](results-v1/summary.json), [candidate registration and hashes](results-v1/registration.json), [complete compressed ledgers](results-v1/full-ledgers.json.gz), [concentration diagnostic](concentration.json), [BTC numerical and causality checks](btc/checks.json), [ETH checks](eth/self-test.json), and [execution checks](execution/audit.json).

Reproduce without overwriting the frozen run:

```sh
python3 reports/asset-system-search-2026-09-10/study.py develop --out /tmp/asset-system-reproduction
python3 reports/asset-system-search-2026-09-10/study.py evaluate --out /tmp/asset-system-reproduction
```
