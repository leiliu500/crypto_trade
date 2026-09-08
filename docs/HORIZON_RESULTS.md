# BTC/ETH horizon results — September 7, 2026 data

Completed September 8, 2026 UTC. None of the 26 candidate policies passed the prespecified training profitability screen for either asset. Both overall selections and every family selection stayed FLAT. The study supplies no evidence for enabling the shorter or volatility-adjusted policies in the paper engine.

All 52 asset/action training means were negative even in the base execution scenario. This is evidence about the fixed action benchmark on the admitted recordings, not proof that every conditional strategy at these horizons must lose. The running paper strategy was unchanged.

## Coverage and execution

The replay verified all 21 original compressed-file hashes: 4,079,695,169 compressed bytes and 8,930,114 events, including 8,496,959 books, 432,724 trades, 34 public disconnects and 397 ignored private events. No same-stream receive-time reversals or invalid reconstructed books occurred. Buffered cross-stream interleavings remained in recorded order.

There were 242 origins: 184 training and 58 later. Only 126 training and 13 later origins were complete for every action and execution scenario. The other 58 training and 45 later origins were excluded from matched comparisons. Known short-path outcomes remain in coverage diagnostics; they do not replace missing longer outcomes.

The base simulation uses 250 ms entry/exit arrival latency, 5 bp taker fees per side and a 3 bp reserve. Other scenarios charge 1.5× fees or use 750 ms latency and half visible depth. Net values include execution prices, fees and reserve; nonfills contribute zero. Unknown paths are excluded rather than recorded as flat returns.

## Matched fixed-barrier comparison

Values below are hypothetical mean **net basis points per origin**, with the same 25 bp gross stop and 40 bp net target for all deadlines. Each table uses identical complete origins across its candidates. These are unconditional long/short diagnostics, not executed account returns. The later columns were not used to select a policy.

### BTC/USD

Training: 70/92 common origins across three UTC dates. Later: 7/29 common origins on one date.

| Holding deadline | Training long | Training short | Later long | Later short |
| --- | ---: | ---: | ---: | ---: |
| 1 min | -12.58 | -13.52 | -13.69 | -10.64 |
| 3 min | -12.37 | -13.63 | -14.12 | -9.43 |
| 5 min | -12.29 | -13.70 | -14.57 | -10.25 |
| 15 min | -11.97 | -13.66 | -9.27 | -10.08 |
| 30 min | -12.26 | -13.27 | -14.64 | -4.46 |

### ETH/USD

Training: 56/92 common origins across three UTC dates. Later: 6/29 common origins on one date.

| Holding deadline | Training long | Training short | Later long | Later short |
| --- | ---: | ---: | ---: | ---: |
| 1 min | -12.48 | -13.43 | -11.63 | -10.68 |
| 3 min | -11.42 | -14.12 | -11.76 | -9.63 |
| 5 min | -11.48 | -14.34 | -9.36 | -11.82 |
| 15 min | -12.22 | -13.94 | -4.63 | -12.75 |
| 30 min | -11.34 | -15.04 | -7.50 | -4.98 |

For example, BTC one-minute longs averaged +0.23 bp before explicit fees and reserve, but −12.58 bp net. ETH one-minute longs averaged +0.29 bp before those costs, but −12.48 bp net. Shortening the holding period did not supply the missing directional edge in this benchmark.

## Frozen selection result

The selection rule required at least 24 complete training origins over three UTC dates, and a stressed lower daily mean above +1 bp. Both assets met the sample/date requirements here. Every candidate failed the return requirement. The best training lower score within each family was:

| Asset | Family | Best stressed lower mean (bp) | Selected |
| --- | --- | ---: | --- |
| BTC/USD | LEGACY | -20.47 | FLAT |
| BTC/USD | FIXED_CONTROL | -20.40 | FLAT |
| BTC/USD | VOLATILITY | -19.82 | FLAT |
| ETH/USD | LEGACY | -23.71 | FLAT |
| ETH/USD | FIXED_CONTROL | -18.83 | FLAT |
| ETH/USD | VOLATILITY | -19.81 | FLAT |

These lower scores use the fixed daily aggregation and uncertainty approximation described in the protocol; they are not calibrated confidence guarantees. The policies chosen before the later period were FLAT, giving zero fills and zero simulated selected-policy return over all 29 later origins per asset. That establishes no trading profit. Volatility-adjusted exits did not make any candidate eligible.

## Limits and the microsecond question

The archive covers August 27 and September 4–7 with a substantial gap. It had already been inspected, and the later assessment has just one date with seven complete BTC and six complete ETH origins. Exclusions may depend on market conditions. These results cannot establish an optimal trading horizon or overall strategy profitability.

This benchmark samples shared origins every 31 minutes so its longest paths do not overlap. It does not reproduce the live model's conditional one-second entry checks or its shared BTC/ETH portfolio slot. Dollar normalization in the machine report uses a standard $12 denominator and is not a cash ledger. Historical applicability of the supplied September 7 instrument rules is an additional assumption.

Microsecond speed is strategy-dependent. Kraken's colocated service reports roughly 200-microsecond network round trips, a different measurement from order fills ([Kraken](https://blog.kraken.com/product/api/beeks-colocation-one-year)). This application's approximately 25 ms book batching and millisecond recordings cannot establish a microsecond execution edge. Holding deadlines and decision/execution latency are separate. The study did not test faster computation; it found no eligible holding-policy candidate under the specified execution assumptions.

## Live trial observation

The independent live check at September 8, 00:09 UTC showed healthy feeds and paper permission enabled. BTC had 39/48 relevant samples and ETH 40/48; both were gated by INSUFFICIENT_SAMPLES and all displayed scores were negative. Durable order history checked at 00:13 UTC confirmed no orders created after the trial baseline, no fills and no account change. These observations are separate from the historical simulation and may change as live data arrives.

## Artifacts and validation

- [Prespecified method](HORIZON_COMPARISON.md) and [source hashes](../reports/distribution-horizon-protocol-2026-09-07.json).
- [Readable machine summary](../reports/distribution-horizon-summary-2026-09-07.json), [full compressed outcomes](../reports/distribution-horizon-comparison-2026-09-07.json.gz) and [verification](../reports/distribution-horizon-validation-2026-09-07.json).
- [Live trial observation](../reports/distribution-horizon-live-check-2026-09-08.json).

The build and all 569 tests passed. Recorded-data checks independently recomputed all common-panel means, verified identical legacy/fixed five-minute outcomes across every panel, and confirmed that all pre-run source hashes remained unchanged. The isolated replay had no network access, mounted market data read-only and submitted no broker orders. No new horizon policy was deployed.
