`RobustAgeGate` now computes exactly the same age thresholds without sorting its retained window three times on every warmed observation. No events are dropped or sampled, and no strategy or financial threshold changes.

The implementation retains the original insertion-order timestamp queue and a second array containing the same values in sorted order. Median is a direct lookup with the original interpolation arithmetic. Absolute distances increase in two ordered sequences away from that center; binary partition selects their middle values to obtain the exact MAD. Inserts and removals shift at most the bounded 4096-value index. Large expiry batches compact that index in one pass. Timestamp pruning still stops at the first unexpired FIFO record, even if older timestamps occur later in the queue.

Parity tests compare every returned field against a frozen copy of the original implementation for 34,625 observations. Cases cover odd/even windows, duplicates, floating-point extremes, invalid ages, boundary thresholds, out-of-order timestamps, nonfinite clocks, the 4096-sample cap, repeated FIFO compactions, and partial/full expiry batches. All pass. Core tests and `npm run typecheck` also pass. The benchmark adds exact equality checks for another 12,000 measured observations.

Local synthetic measurements on Node v22.20.0:

| Retained ages | Pattern | Original, 4000 observations | Optimized, 4000 observations | Optimized per observation |
|---|---|---:|---:|---:|
| 4096 cap | Mixed values | 20,679 ms | 20.31 ms | 5.08 µs |
| 4096 cap | Many duplicates | 10,657 ms | 10.01 ms | 2.50 µs |
| 256 time window | Mixed values | 930 ms | 10.40 ms | 2.60 µs |

These are single local wall-clock measurements under the current machine load. They establish the computational improvement, not a guaranteed service latency or end-to-end replay speed. The separate recorded-data comparison must still confirm identical labels and sizing origins before the full training preparation.

Application source changed: `src/core/statistics.ts` only. Supporting files are `test/robust-age-gate-parity.test.ts`, its frozen reference under `test/fixtures`, and the reproducible `robust-age-gate-benchmark.mjs` / `.json` in this report directory. The training source fingerprint necessarily changes; the final training artifact must be prepared from the new frozen source.
