The September 9 rebuild separates three questions: whether the market data can produce a valid order, whether a strategy earns cash after costs, and whether the available evidence supports activating it. A successful code test answers only the first question. No future profit is guaranteed.

The new price-channel strategy uses BTC and ETH, 55 completed daily bars for entry, a 20-day opposite channel for exit, and a favorable-only stop based on 2 × Wilder ATR20. Each asset receives at most 0.05% of account equity in initial modeled risk, within the combined 0.1% cluster budget, $1,000 per-asset notional cap, 1% equity cap, and remaining account loss limits. It does not fit a directional intercept or repeatedly reduce winners against an unchanged original stop.

The first channel experiment exposed a late-entry failure during the February 3, 2025 ETH fall. A second, explicitly separate hypothesis anchors the protective stop to the completed signal close and rejects a fill displaced by more than half an ATR. Position risk uses the actual permitted fill-to-stop distance. The half-ATR limit was declared before that variant's replay; it was not optimized over a parameter grid. Original results and source copies remain intact.

| Reused development period | Price-protected base net | Higher costs and extra-hour delay |
| --- | ---: | ---: |
| 2024 | $84.19 | $98.24 |
| 2025 H1 | $138.32 | $31.70 |

These figures include execution fees, adverse candle-price execution assumptions and funding. Nineteen base-case episodes closed across the two periods. Independent source-based verification reproduced the cash calculations, lot sizing, stop anchoring and funding. The four-week block bootstrap lower 5% mean weekly net remains negative, at approximately −$2.93. The declared statistical acceptance gate therefore fails. This candidate is not activated or described as validated profitable.

One unchanged-strategy test of the previously reserved January–July 2026 period was sealed before its outcomes were calculated. All 24 development outputs reproduced exactly before this test. Three absent funding observations affected held BTC/ETH exposure; the first, on February 4, stopped new entries for the rest of the period. Both cases closed three episodes and left no inventory. Full funded profit, drawdown and confidence bounds are unknown. The test did not qualify the strategy. Independent verification checked 10,258 source and cash assertions. The partial cash changes of +$118.76 base and +$106.79 stress omit missing funding and are not full-period profit results. No parameter search or activation followed this test.

The candle studies do not establish executable depth, partial fills or exact intrahour ordering. Opening-price fills use the completed execution candle's positive volume as a retrospective availability proxy. Funding publication timing is an assumption. The paper entry adapter checks actual current books, clocks, venue increments, execution-price limits and verified eligibility separately; a failed study cannot authorize an order.

The alternative 180-day BTC spot/perpetual carry study generated no qualified entry in any of eight runs. At 80 basis points per spot execution, fees, a 50% funding haircut and the 5% annual benchmark on segregated capital make the economic hurdle too high. Independent weekly spot prices were used, without inventing hourly spot prices or synchronized hedge fills. The matched accounting kernel supports separate cash wallets, per-leg fees, exact continuous funding, partial reductions and collateral checks, but the study cannot authorize execution.

The existing paper engine's $12 cap had already been replaced by a risk-bounded limit of `min($1,000, 1% of current equity)`. Its separate training bank initially had only one day of matching outcomes. The old historical trainer always reconstructed $12 labels, and startup skipped all imports when risk-based sizing was enabled. The new versioned training path reconstructs fresh outcomes from the full recorded book/trade sequence using the active sizing policy and causal sizing features. It preserves each retained origin, quantity, book, feature configuration and source-file hashes. Import rechecks that evidence, rejects incompatible sizes, and retains the existing bank on failure.

Those distribution labels include simulated execution, fees and the configured reserve; they are not an observed-funding cash-profit test. The paper account's funding ledger remains separate. Historical labels supply training and cannot become prospective validation. All conditional support, date, conservative return and account risk gates remain in force.

The complete reconstruction processed 15,920,777 records from 34 archives, retaining 6,001 complete outcomes and 3,038 original sizing proofs across September 4–9. The independent audit verified the source, sizing, immutable artifact and repeated-import behavior. All 12 unconditional worst-scenario action means were negative, approximately −15.6 to −19.9 basis points. The causal replay recorded 483,175 decisions below the score minimum and no passing selection. These are dependent training diagnostics, not an account-return calculation. Restoring history therefore repairs the data barrier without establishing that the short-horizon strategy has a profitable edge. [Full reconstruction results](../reports/profit-engine-rebuild-2026-09-09/distribution-training-v2/RESULT.md).

The repair was deployed to the paper service on September 10 at 00:04 UTC. Startup added 5,763 historical labels to the current bank and retained 6,148 labels across six dates. The small difference from the preflight reflects newer paper outcomes collected before restart; existing evidence takes precedence over overlapping historical labels. Post-deployment verification passed for the actual import, active policy, account cash, orders, positions, funding epoch and service health. Cash remained $99,998.28269740003 with no new fills or orders during that audit. The following sampled observations had four to six supported training dates and uniformly negative action scores, with zero selected entries. The historical compatibility bug is repaired; profitable trading remains unestablished. [Deployment and observation evidence](../reports/profit-engine-rebuild-2026-09-09/deployment-2026-09-10/report.md).

Reproducible commands:

```sh
npm run research:channel -- NEW_CHANNEL_REPORT_DIRECTORY
npx tsx src/channel/verify-v1-parity-main.ts NEW_PRICE_PROTECTED_REPORT_DIRECTORY
npm run research:channel -- NEW_PRICE_PROTECTED_REPORT_DIRECTORY price-protected-v2
npm run carry:horizon-study -- NEW_CARRY_REPORT_DIRECTORY
npm run research:distribution:train -- --sizing-mode=RISK_BOUNDED --reference-equity=100000 --reference-high-water=100000 --assets=RULES.json --cutoff=ISO_TIMESTAMP --state-out=NEW_ARTIFACT.json RECORDING.jsonl.gz
```

The base channel CLI reproduces v1; the explicit `price-protected-v2` argument selects the second frozen hypothesis. Existing report directories and artifacts are not overwritten.

Evidence: [price-protected channel results](../reports/profit-engine-rebuild-2026-09-09/channel-price-protected-v2/report.md), [independent channel verification](../reports/profit-engine-rebuild-2026-09-09/channel-price-protected-v2/verification.json), [carry results](../reports/profit-engine-rebuild-2026-09-09/long-horizon-carry/report.md), [carry verification](../reports/profit-engine-rebuild-2026-09-09/long-horizon-carry/verification.json), [training recovery audit](../reports/profit-engine-rebuild-2026-09-09/distribution-history-feasibility.md).

Reserved-period evidence: [holdout report](../reports/profit-engine-rebuild-2026-09-09/channel-price-protected-v2/holdout-2026/report.md), [independent cash verification](../reports/profit-engine-rebuild-2026-09-09/channel-price-protected-v2/holdout-2026/cash-verification.json). Its three-episode count reflects the missing-data halt and cannot establish the full-period entry frequency of an account with complete funding records.
