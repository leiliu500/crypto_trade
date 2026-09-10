# Adaptive model versus independent price rules

This version tests a structural alternative to the conditional sample bank. It is a research comparison, with no automatic change to the running paper strategy. Neither an increased number of entries nor a fitted model establishes profitable trading.

**September 8 result: development failed; no candidate selected or activated.** All six specifications were evaluated on 2024 with complete selected-trade accounting. Each asset had 8,733 forecast origins for every adaptive candidate, with zero unavailable predictions. The independent rules generated entries without any conditional sample bank, but neither approach qualified after costs. The runner denied both confirmation and final evaluation; January–July 2026 remains unopened.

The table shows individual-asset simulations with the same $12 cap. These are dollar P&Ls under the stated funding and execution scenarios, not actual live returns or an aggregate portfolio.

| Candidate | BTC trades (base) | BTC net base / stress | ETH trades (base) | ETH net base / stress |
| --- | ---: | ---: | ---: | ---: |
| Adaptive trend, 4h | 18 | −0.378 / +0.120 | 16 | −0.079 / +0.227 |
| Adaptive recovery, 4h | 104 | −1.437 / −2.175 | 76 | −2.139 / −1.891 |
| Adaptive trend, 24h | 224 | −0.339 / −3.148 | 167 | −2.241 / −4.409 |
| Adaptive recovery, 24h | 251 | −0.640 / −2.837 | 206 | −6.448 / −8.919 |
| Channel breakout, 24h | 210 | −8.892 / −9.983 | 218 | −4.555 / −6.602 |
| Trend recovery, 24h | 184 | +0.601 / −1.570 | 185 | −5.811 / −5.904 |

The adaptive models' mean squared forecast errors were worse than both zero-return and training-only unconditional-mean predictions for both assets (0.20–1.51% worse than zero). The BTC recovery rule has positive gross returns, but its stress costs erase the gain. Removing funding from the *same stress fills* would leave that BTC rule at +$0.684; both ETH rules still lose after fees and slippage alone. This attribution is not a retuned or newly qualified strategy. The selected 2024 non-flat baseline was BTC buy-and-hold (+$5.918 base / +$2.387 stress); no candidate earned advancement against it.

The structural entry mechanism and exit recovery are implemented and tested. Profitability remains unestablished. A further strategy change needs a new declared hypothesis and development evaluation; lowering these failed gates or inspecting the reserved period would not validate this version.

Validation passed: production build, 760 regression tests and 14 additional study-gate tests. An independent reconstruction checked both 24-hour models' monthly fits, all 13,177 qualified forecasts, and their per-origin errors; a separate weighted solver agreed within 1e-12 bps. Independent account reconstruction reconciled all 34 scenario reports, 4,346 selected trade records and 298,690 hourly equity points within $1.46e-11. These counts include separate alternative strategies/scenarios, not one tradable portfolio. See `independent-model-audit.json`, `development-execution-audit.json` and `validation-status.json` in the report directory.

The four adaptive candidates predict 4-hour or 24-hour gross returns with trend or recovery features. They refit at each UTC month start from the preceding 365 days, weighting completed labels with a fixed 90-day half-life. Their training rows, normalization, intercept and coefficients use only information available before that refit. Each decision is purged at least 26 hours from the cutoff. A fit expires at the next month boundary; it needs 6,000 rows and weight ESS of 1,000 per asset. Weight ESS measures weight concentration, not the number of independent overlapping outcomes.

Two independent strategies use completed hourly prices: a transition beyond the previous 24-hour high/low channel, and recovery through a quarter-ATR band around EMA24 in the EMA168 trend direction. They need 169 contiguous completed candles, but no conditional samples, fit, or peer-asset prices. Two ATRs of price distance must clear the base fee/slippage/funding screen. That distance is geometric room, not an expected return or probability; its economic usefulness is judged from executed-policy results.

## Frozen comparison

The machine-readable protocol is `reports/hourly-adaptive-study-2026-09-08/protocol.json`. The first performance run is forbidden until this protocol has been registered. There is one fixed specification and no parameter sweep.

1. **2024 development:** compare all six candidates independently on BTC and ETH. Choose the eligible candidate with greatest stress net P&L minus half its drawdown for each asset. A candidate needs at least 20 completed trades, positive net P&L, known accounting and drawdown/daily loss at most $12 in both scenarios. No portfolio-combination search follows.
2. **2025 confirmation:** evaluate those fixed choices together in one global slot. This year was already examined in the earlier study; it is explicitly not an untouched test.
3. **January–July 2026 final:** open only if development and confirmation pass. Strategy choices and the update algorithm remain fixed; monthly fits may learn from labels completed earlier in the final period. August is excluded because an earlier experiment examined part of it.

2024 was previously used for training and is not described as untouched. The combined portfolio must have at least 100 completed trades, 40 active UTC dates, 20 trades per asset, positive net P&L for both assets, full accounting, and drawdown/daily loss no greater than $12, in both scenarios. It must also beat the non-flat baseline selected by 2024 stress utility. Baselines are flat, 168-hour trend held for 24 hours, and separate BTC/ETH buy-and-hold. Baseline ranking uses arithmetic utility; candidate risk limits do not hide an otherwise stronger baseline.

The final stage additionally requires positive nominal one-sided 95% lower bounds for base P&L improvement over flat and the selected baseline. Intervals resample paired seven-day blocks over every UTC calendar day, including idle days, with 2,000 repetitions and a fixed seed. They are not corrected for all historical research decisions and do not prove live profitability.

## Same account and execution assumptions

Both approaches share one position or pending-order slot, capped at $12 entry notional on a $100,000 paper account. Simultaneous qualifying signals choose BTC on even UTC epoch days and ETH on odd days. This exogenous priority avoids ranking a forecast against geometric ATR room as though the scores had the same meaning.

Base costs are 5 bps fee and 1.5 bps adverse slippage per side; stress uses 7.5/3 bps and one extra hour of entry delay. The same prequalified signals enter both scenarios. Fills round against order side to the supplied tick; size floors to the lot and must satisfy minimum size. Too-small orders are known nonfills. The September 7, 2026 instrument rules are an explicit assumption for earlier history. Hourly candles cannot establish order-book liquidity, actual fill probability, margin availability or intrahour drawdown.

Actual historical funding is incomplete and its source timestamp convention is unverified. These are **scenario P&Ls**, not reconciled actual returns. For each evaluation period, the preceding 365 days set a fixed p95 absolute hourly funding charge for base and p99 for stress. Every position pays this adverse charge on hourly mark notional, without credits; stress also adds 1 bp per 24 hours. Funding through a delayed exit continues. No forward funding is used to choose the reserve.

The new simulator retries a clock exit at hourly opens through its scheduled exit plus 24 hours inclusive. A zero-volume attempt becomes known unfilled at that candle's close; the final failed attempt is unresolved at plus 25 hours. Inventory, funding and the shared slot persist until an executable exit. Missing observations remain unknown. Unknown accounting never becomes a zero P&L or silently releases the slot. Signal generation ends 51 hours before each period endpoint so delayed 24-hour entries and retries can finish; buy-and-hold has the same retry allowance.

The original v1 simulator and reports remain unchanged. The real November 1, 2025 six-hour interruption is independently reconciled in `maintenance-retry-independent-audit.json`, across both assets, both directions and both cost scenarios.

## Reproduce

Build first with `npm run build`. The restored data directories retain source manifests and raw-file hashes. The restoration audit reproduces the previous normalized dataset hashes exactly after replacing only fetch metadata.

```sh
node dist/src/research/hourly-adaptive-study-main.js register reports/hourly-adaptive-study-2026-09-08/data-older-restored reports/hourly-adaptive-study-2026-09-08/data-recent /tmp/new-adaptive-study
node dist/src/research/hourly-adaptive-study-main.js develop reports/hourly-adaptive-study-2026-09-08/data-older-restored reports/hourly-adaptive-study-2026-09-08/data-recent /tmp/new-adaptive-study
node dist/src/research/hourly-adaptive-study-main.js confirm reports/hourly-adaptive-study-2026-09-08/data-older-restored reports/hourly-adaptive-study-2026-09-08/data-recent /tmp/new-adaptive-study
node dist/src/research/hourly-adaptive-study-main.js test reports/hourly-adaptive-study-2026-09-08/data-older-restored reports/hourly-adaptive-study-2026-09-08/data-recent /tmp/new-adaptive-study
```

Run later stages only if the previous gate passes. A failed gate denies access before feature/outcome evaluation for the next stage. Start records, protocol, source files, input datasets, manifests and result artifacts are hashed. Sources and data are revalidated before completion. Files use exclusive creation, so a used output directory cannot silently become a fresh test. Keep compact summaries/audits for review; raw downloads and detailed hourly account artifacts stay local.
