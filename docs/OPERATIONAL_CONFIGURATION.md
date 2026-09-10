# BTC/ETH paper operating controls

The `btc-eth-risk-bounded-sizing-v14.0.0` configuration extends v13 with configurable, risk-bounded distributional order sizes. It retains the trailing 24-hour realized-price-minus-recorded-fees ledger, audit records, entry suspension on persistence failure, and separate research permissions. It is not a profitable strategy certification. No real-order adapter is enabled.

The current deployment disables the distribution engine, paper entries, paper trial, efficient training and regime model. The older policy engine and cross-asset entry permissions are also disabled, and `MODEL_ONLY_ENTRIES=true` blocks legacy entry fallback. Futures remains a market and account monitor; its model panels are removed. Existing records and protective exits are retained. BTC spot and ETH40 observation run independently on their existing services.

## Effective configuration and precedence

`config/base.json` defines strategy and operational parameters; `btc_usd.json` and `eth_usd.json` hold permitted symbol overrides. JSON parameters take precedence over legacy environment values. Runtime permissions, venue fees, and connection credentials remain in `.env`. Global loss and concentration limits cannot be overridden per symbol. Malformed booleans, blank numbers, invalid fee units, and contradictory risk limits fail loading.

Run `npm run config:audit` locally or `npm run config:audit:production` inside the built container. The report and startup log include a SHA-256 fingerprint of resolved settings, also saved in the database run metadata. Credentials and connection URLs are excluded. Changing a connection password alone does not change the trading configuration fingerprint.

| Control | Configured value | Interpretation |
|---|---:|---|
| Generic symbol notional | $1,000 | Ceiling, not an order target |
| Portfolio gross notional | $5,000 | Shared ceiling, further constrained by concentration and strategy limits |
| Same-cluster positions | 1 | BTC and ETH are treated as correlated exposures |
| Distribution paper order | $1,000 maximum and 1% of current equity | Further reduced by modeled loss, liquidity, exchange lots and symbol limits; see [position sizing](PAPER_POSITION_SIZING.md) |
| Base risk fraction | 0.1% | Existing sizing budget before quality, volatility, and other caps |
| Rolling and session loss fractions | 0.75% each | Separate trailing 24-hour and UTC-session realized-price-minus-recorded-fee windows |
| Maximum drawdown fraction | 5% | Existing account risk threshold |
| Maximum visible-book participation | 1% | Existing liquidity constraint |
| Fractional Kelly / maximum Kelly fraction | 0.1 / 5% | Existing sizing controls; not evidence that forecasts are calibrated |
| Futures maker / taker fees | 2 / 5 bp per fill | Published-tier paper assumptions; actual account tier remains unverified |
| Required database audit | true | Required for entries; exit handling continues when unavailable |
| Maximum database write lag | 5 seconds | Pending and in-flight records must make progress; checked each second |
| Telemetry SQL timeout | 5 seconds server / 6 seconds client | Bounds stalled statements and broken-response waits |
| Quote age / provider future skew | 2,000 / 250 ms | Existing general market checks; distribution has its stricter 1,000 ms quote limit |
| Distribution evaluation cadence | 1 second | Independent of the existing 6/16/31-minute training clocks |

Risk magnitudes were retained, not claimed to be universal institutional settings. The uncalibrated covariance limit remains disabled and is explicitly labeled in the audit. The main paper runtime reconstructs realized price P&L and recorded execution fees from broker history, verifies fills against order totals and positions, and maintains the rolling window `(now - 24 hours, now]`. A loss immediately before UTC midnight therefore remains in the rolling budget after midnight. UTC-session accounting remains separate.

The dashboard exposes this amount as “Trailing 24h realized”, explicitly excluding funding. Missing fees inside the measured window, truncated retained history, inconsistent fills, or position mismatches make the measurement unknown and block new entries; they do not become zero loss. Older missing fee records remain separately counted as unknown but do not contaminate a later window containing complete fee evidence. Complete historical quantities and prices are still required to reconstruct the remaining inventory and verify all order totals. Exit handling continues. Broker history currently retains at most 10,000 fill activities; a truncated history cannot establish an exact ledger without a separately verified checkpoint. Generic engines without the paper-history dependency expose the exact measurement as unavailable. Existing stop and loss accounting still does not establish an exchange liquidation model or full exchange cash-flow parity.

## Audit failures and research permissions

When required persistence fails, the engine blocks new entries and cancels pending entry orders. Reduce-only exits and position reconciliation remain active. Recovery requires successful reconciliation under a healthy persistence epoch. Dropped audit records latch `AUDIT_DATA_LOSS`; an ordinary reconnect cannot clear it. A startup database failure leaves entries blocked while paper positions can still be managed; resolve the database issue and restart to restore the audit store.

Example and Docker defaults disable model engines and paper-order permissions. The earlier efficient paper trial was an **unvalidated experiment** and is now stopped. Its recorded labels and evaluations remain preserved; no distribution training artifact is imported at startup. A paper trial bypasses prospective validation and must not be described as approved for real capital. Research returns from earlier frozen studies are unchanged.

## Carry research configuration

`config/carry-research.json` is separately validated and restricted to `MONITOR_ONLY`. It cannot enable orders. `npm run carry:monitor -- NEW_OUTPUT_DIRECTORY` performs five public GET requests and writes a compressed input snapshot plus a reproducible feasibility report. The report compares independent budget scenarios; the rows are not simultaneous allocations.

To reproduce a saved snapshot without another market request, pass the configuration path and compressed input as the third and fourth CLI arguments: `npm run carry:monitor -- NEW_OUTPUT_DIRECTORY config/carry-research.json SAVED_PUBLIC_INPUT_JSON_GZ`.

The monitor uses equal base quantities of funded spot and short linear futures, actual public lot rules and executable bid/ask depth, a 100% derivative collateral reserve, and distinct spot/futures fees. The $12 and $1,000 gross budgets are research sensitivities and do not change runtime risk limits. The configured 5% annual capital hurdle, 1.5 bp slippage per execution, 50 bp settlement-basis reserve, and 25 bp unwind reserve are explicit research assumptions requiring empirical validation. Dated contracts are eligible for the research policy only at 30–90 days to maturity; other maturities are diagnostics. Perpetual funding scenarios assume constant, zero, or reversed rates and are not forecasts.

The separate paired execution kernel is a synthetic paper harness for independent fills, partial hedges, cancellation, and repeated exit repair. Its declared discrete funding settlements do **not** reproduce Kraken's continuous accrual and settlement on position changes. `fullyCostedNetPnlUsd` always remains null; its numeric PnL is explicitly labeled a synthetic settlement proxy.

The new `src/carry/funding-accrual.ts` component calculates continuous signed funding through exact elapsed-time intervals and separately reconciles recorded USD cash receipts at hour ends and position changes. Missing rates or receipts remain unknown. This component is independently tested research infrastructure, not yet an exchange-reconciled funding feed inside the running broker. Its complete-strategy P&L remains null.

`npm run carry:funding-study -- NEW_OUTPUT_DIRECTORY` runs the fixed monthly funding-only forecast protocol on the existing 2023–2025 development archive. It seals protocol/source/input hashes before calculating outcomes, forbids 2026 accrual periods, and never reads price returns. The September 9 study did not show consistent superiority to simple baselines; 2025 data gaps also prevent a complete comparison. It does not authorize a new strategy. See `docs/FUNDING_ECONOMIC_PROTOCOL.md` and `reports/carry-funding-model-development-2026-09-09/report.json`.

`npm run carry:fee-frontier -- NEW_OUTPUT_DIRECTORY` reuses the saved public snapshot at fixed 0/20/40/80 bp spot fee sensitivities, retaining all other declared costs. These are hypothetical fees, not verified account tiers or a backtest.

The September 9, 2026 04:31 UTC snapshot, reproduced in `reports/carry-feasibility-reviewed-2026-09-09`, found a minimum BTC paired gross of approximately $15.78 versus the $12 research cap. Twelve larger or ETH combinations were mechanically feasible, but all 36 configured net scenarios were negative. No available dated contract met the 30–90-day maturity rule. These are current-price scenario calculations, not a historical performance test. The earlier probe report is retained and superseded because a floating-point decimal adapter rejected BTC lots; exact decimal increments and a regression now prevent that error.

At the published entry tier retrieved on September 9, 2026, spot taker fees are 80 bp and futures taker fees are 5 bp per fill. Account, region, and tier qualification require separate verification. A simulated $100,000 account balance does not establish eligibility for an assets-on-platform fee tier. [Kraken fee schedule](https://www.kraken.com/features/fee-schedule)

Institutional carry has a defined economic source, but financing, margin requirements, market segmentation, and implementation costs constrain it. This system still lacks synchronized historical spot/futures execution data and verified full funding accounting. A hedge monitor cannot establish returns after costs. [BIS: Crypto carry](https://www.bis.org/publications/working-paper-1087-crypto-carry)

Kraken's linear perpetual funding accrues over time and can change; dated contracts have settlement-index risk relative to an executable spot exit. Missing funding remains unknown, and neither current funding nor quoted dated basis is a guaranteed realized profit. [Kraken contract specifications](https://support.kraken.com/articles/4844359082772-linear-multi-collateral-derivatives-contract-specifications)
