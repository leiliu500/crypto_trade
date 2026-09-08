# Historical conditional-model comparisons

These are chronological comparisons on previously inspected recordings. They test collection and model behavior now; they are **not untouched holdout evidence**. No future collector was launched and no research model was installed in the trading engine.

## First recording: September 6–7

The recording spans September 6 23:51:59 through September 7 04:49:13 UTC, approximately 4.95 hours. The initial bank contains 810 older action labels. Both collectors observe the same intervening events before inference banks freeze at September 7 02:00 UTC. The evaluation period ends at 04:49:16 UTC.

| Measurement | Current collector | Efficient candidate |
| --- | ---: | ---: |
| New learned action labels over the recording | 60 | 256 |
| 5-minute action labels | 20 | 168 |
| 15-minute action labels | 20 | 59 |
| 30-minute action labels | 20 | 29 |
| Frozen labels available at evaluation start, including seed | 846 | 915 |
| Mean publication delay after final execution scenario completes | 14.13 minutes | 0 |
| Conditional policy selections in the later evaluation segment | 0 | 0 |

Collection improved **4.27×** in this recording. The gain is concentrated in short horizons and includes pre-evaluation collection. It is not a fourfold increase in independent market contexts or evidence that the model makes better trades.

Base-scenario forecast errors on common valid action outcomes:

| Asset | Current model RMSE | Efficient model RMSE | Current-bank unconditional mean RMSE | Efficient-bank unconditional mean RMSE |
| --- | ---: | ---: | ---: | ---: |
| BTC | 17.51 bps | 17.40 bps | 15.52 bps | 15.54 bps |
| ETH | 27.38 bps | 27.39 bps | 26.42 bps | 26.39 bps |

The conditional forecast change is small and mixed. The simple unconditional means have lower RMSE for both assets here. There are only **26 BTC and 27 ETH paired action outcomes**, drawn from **10 asset-specific origins on one UTC date**. Outcomes across actions and scenarios share market paths. This is insufficient for a reliable uncertainty estimate or a general effectiveness claim.

Fixed long, fixed short and momentum policy known-only net sums were negative in this segment, but four selected decision paths had unknown outcomes across the execution stresses. Their full-period performance cannot be inferred by treating those unknowns as zero. Both conditional policies matched the flat policy's zero selections, which does not demonstrate predictive skill.

An independent audit reconciled all **542 compact audit records**, their hash chain, seed and frozen-bank hashes, action nonoverlap, cutoff causality, and every scenario/action forecast-error row.

Artifacts:

- [First replay report](../reports/conditional-history-study-2026-09-08/conditional-development-20260908.json)
- [First replay audit](../reports/conditional-history-study-2026-09-08/conditional-development-20260908.json.audit.jsonl.gz)
- [Independent verification](../reports/conditional-history-study-2026-09-08/first-independent-audit.json)
- [Protocol and method](CONDITIONAL_STUDY.md)

## Larger later recording

The closed September 8 recording spans 01:24:43 through 16:44:26 UTC, approximately **15.33 hours**. It contains 2,588,498 recorded events and 2,417,621 accepted books. There were nine public disconnects, no recorder-gap markers and no timestamp reversals.

Both collectors start with the same **894 older labels**, whose latest completion was September 7 10:59:39 UTC. They observe preceding records causally before inference freezes at **September 8 08:00 UTC**. The evaluation endpoint is 16:44:28 UTC, approximately **8.74 hours** later. The evaluation produced 59,807 ready asset decisions.

| Measurement | Current collector | Efficient candidate |
| --- | ---: | ---: |
| New learned action labels over the entire recording | 222 | 819 |
| 5-minute action labels | 74 | 553 |
| 15-minute action labels | 74 | 187 |
| 30-minute action labels | 74 | 79 |
| New usable labels before the 08:00 freeze | 126 | 366 |
| Frozen labels at evaluation start, including seed | 1,020 | 1,260 |
| Mean publication delay after final execution scenario completes | 14.59 minutes | 0 |
| Conditional selections during later evaluation | 0 | 0 |

The candidate learned **3.69×** as many valid action labels. BTC's learned 5/15/30-minute counts rose from 40/40/40 to 275/93/41; ETH's rose from 34/34/34 to 278/94/38. Counts include both sides, valid nonfills and pre-evaluation collection. They are not independent context counts.

Among five-minute action estimates, the first reported gate was insufficient samples **53.90% → 15.54%** of the time for BTC and **75.40% → 27.37%** for ETH. After support improved, the score-below-minimum gate accounted for 82.26% of BTC and 67.16% of ETH five-minute estimates. These are action-estimate rates, not independent trade opportunities. Better coverage did not produce a positive eligible action.

Base-scenario forecast errors on common valid action outcomes:

| Asset | Current model RMSE | Efficient model RMSE | Current-bank unconditional mean RMSE | Efficient-bank unconditional mean RMSE |
| --- | ---: | ---: | ---: | ---: |
| BTC | 13.24 bps | 12.98 bps | 13.57 bps | 13.53 bps |
| ETH | 23.59 bps | 23.33 bps | 22.04 bps | 22.02 bps |

BTC improved modestly and beat the simple averages in this segment; it had trailed them in the first replay. ETH improved modestly against the current model but still trailed the simple averages. The **74 BTC and 77 ETH paired action outcomes** come from **16 origins per asset on one UTC date**. These results do not establish reliable forecast superiority or a trading edge.

All fixed long, fixed short and momentum known-only mean returns were negative. Unknown paths prevent full-period performance claims. Across stresses, 34 selected decision paths had an unknown outcome; the 98 unknown scenario outcomes are not 98 independent trades. Both conditional policies selected zero actions.

The independent audit verified **1,801 records**, the complete hash chain, both seeded freeze-bank hashes, strictly preceding training cutoffs, per-action training nonoverlap, per-policy global position nonoverlap, forecast ordering and all 36 action/scenario error rows.

- [Later replay report](../reports/conditional-history-study-2026-09-08/conditional-later-v2-20260908.json)
- [Later replay audit](../reports/conditional-history-study-2026-09-08/conditional-later-v2-20260908.json.audit.jsonl.gz)
- [Later independent verification](../reports/conditional-history-study-2026-09-08/later-independent-audit.json)
- [Run status and artifact hashes](../reports/conditional-history-study-2026-09-08/status.json)

## Interpretation and implementation status

Existing recordings are sufficient to demonstrate the collection improvement and run useful comparisons now. They cannot be certified untouched: the recent records were used in online training and inspected during the no-entry and warmup investigations. A later chronological split inside a replay does not erase that prior exposure.

These are two separate historical comparisons, not one continuous two-day portfolio backtest. Forecast changes are small and inconsistent across assets and periods; both models abstain throughout. **Effectiveness remains inconclusive.**

The efficient collector remains a research candidate. The trading engine's training and entry rules were not changed by this work, and no future collector was started. The completed implementation passes **619 tests** and the TypeScript build. Separate research images preserve the attested source versions.

Replay hashing was accelerated using native JSON serialization while retaining the original hash bytes and BigInt fallback. A paired 10,000-event benchmark found no byte or chain mismatches and a 1.71× faster serialization/hash path. The initial, incomplete larger replay was stopped before evaluation, retained as a partial attempt, then resealed and restarted with identical training and trading rules. No completed result was discarded or selected based on performance.
