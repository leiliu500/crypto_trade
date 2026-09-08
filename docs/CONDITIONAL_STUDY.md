# Conditional BTC/ETH model study

This study tests a research training candidate against the current training collector and simple baselines. It does not submit orders or install a model. More labels, more evaluations, fewer abstentions, and zero trades do not establish a predictive or profitable edge.

## Frozen design

The active work uses **existing historical recordings**. No future collector has been started or scheduled. The first replay trains on older labels and preceding recorded events, then freezes inference at **2026-09-07 02:00 UTC** for evaluation through **04:49:16 UTC**. A larger replay uses the closed September 8 archive, with a training/evaluation boundary at **08:00 UTC** and an endpoint of **16:44:28 UTC**.

The sealed development manifests copy their initial historical labels and hash source files, package files, costs, instrument rules and source configuration. These periods were already inspected during model diagnostics and are explicitly historical development evidence. Chronological separation prevents direct label leakage within a replay; it cannot undo earlier design decisions influenced by the archive.

Each UTC day uses a frozen bank containing only labels completed **strictly before** that day begins. Collectors continue observing the market during the day; those labels can enter the next day's bank. This is prospective daily walk-forward evaluation. The model's existing age, decay, sample, day, effective-sample and score restrictions still apply. The comparison uses the current paper-trial profile's three-day support requirement.

The current collector uses complete six-action panels every 31 minutes. The candidate schedules paired long/short actions every **6, 16 and 31 minutes** for the 5-, 15- and 30-minute horizons. A completed action becomes available immediately after all three execution scenarios finish validly. A later failure of another action cannot erase that completed label. Banks remain separate and nonoverlapping per asset/action; correlated horizons are not counted as additional independent observations in a pooled model.

This candidate targets the three-date paper-trial research profile. At sustained full collection, its bounded 1,024-sample five-minute bank spans approximately 4.27 days and cannot satisfy the default seven-date validated profile. Sparse collection can extend that span. Capacity or retention changes would need a separately versioned candidate and validation; this study does not authorize promotion or a lower date gate.

## Comparisons and endpoints

- Trading policies: current conditional model, efficient-training conditional model, flat, long 15-minute action, short 15-minute action, and 15-minute momentum (sign of the observed preceding 15-minute return; zero stays flat).
- Each policy has one global BTC/ETH position slot. They share the same events, readiness rules, action exits, quantity rounding, shortability, fees, reserve, latency and depth stresses. Baseline action names include their predefined stops and targets; these are not guaranteed full-horizon holds.
- Each asset has a common 31-minute probe grid across all six actions. Origins are at least 31 minutes apart. Forecasts are saved before observing outcomes, including forecasts when a model abstains. No new entries or probes start in the final 31 minutes.
- Forecast accuracy compares scenario-specific conditional means with training-only unconditional action means. MAE/RMSE comparisons use common finite forecasts and valid outcomes. Separate availability counts expose support gains and missingness.
- Training diagnostics include learned/invalid labels per asset/action, labels per observed ready asset-hour, and delay between completed execution paths and publication.
- Trading reports distinguish filled, unfilled, unknown, known-only net-bps sums and mean net bps per known selection. These are simulated requested-notional outcomes, not compounded portfolio returns or actual account P&L.
- Day-level paired squared-error differences and their approximate intervals are descriptive, unadjusted for multiple comparisons. One-second evaluations and overlapping cross-action returns are not independent observations.

The available forward-run template has descriptive adequacy screens requiring ten UTC dates with twelve observed ready hours for both assets, and, for each conditional policy, at least 100 filled selections overall plus 30 per asset spanning seven dates. These short historical comparisons cannot meet that screen and remain **INCONCLUSIVE** as effectiveness evidence. Passing an adequacy screen would not prove effectiveness. Profitability and deployment readiness remain false until a separate review of independent evidence.

## Provenance and operation

Previously inspected recordings are **development data**, even when their evaluation segment is later than their training labels. They cannot be relabeled as an untouched holdout.

Historical replay retains the source archive hashes and compact, hash-chained forecasts, labels, outcomes and daily model hashes. Source events keep their original emission order. Replay audit output is compressed and streamed with bounded memory.

An unused prospective runner is also available. It uses an independent Kraken public connection and has no account credentials, broker or order interface. It retains compact evidence and atomic status reports without duplicating full raw depth. Its compact audit alone cannot reconstruct every source event, and the production recorder is a different connection. This limits independent replay of a forward run and is recorded in its manifest. Its original fourteen-day template has not been sealed or launched; any shorter future design needs its duration and adequacy criteria fixed before collection.

A process interruption ends the run. The runner refuses late starts, changed source/seed hashes, existing output directories, silent restart, future source events and leaking seeds. Failed or interrupted results remain partial. This intentionally does not replace missing future observations with an inspected replay.

Commands:

```bash
npm run research:conditional-study -- prepare-development --out /tmp/study-dev-protocol --seed /tmp/development-seed.json --start 2026-09-07T02:00:00Z --end 2026-09-07T04:49:16Z
npm run research:conditional-study -- replay --protocol /tmp/study-dev-protocol/protocol.json --input /tmp/recording.jsonl.gz --out /tmp/study-dev-result.json
```

`Dockerfile.study` packages the separate study runner with attested sources. It does not replace the trading-engine image. The production controller continues its current training and entry rules during these comparisons.
