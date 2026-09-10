The optimized replay is now dominated by JSON decoding and stream handling. This profile does not justify another application-code change before the frozen full replay.

The final run used the frozen `/tmp/distribution-risk-v2-optimized-20260909/snapshot`, its existing public configuration and instrument rules, and the actual recorded archive `continuous-events.20260905T045958Z.jsonl.gz`. A separate Docker container had networking disabled, one CPU, 2 GiB memory, and read-only source, dependency and archive mounts. Existing baseline, optimized and production containers were left running.

The bounded generator preserved each record in original order and stopped after approximately 30 CPU seconds. It consumed 61,184 records, including 61,180 public market events, spanning 34 minutes and 16 seconds of market time. Replay used 30.09 CPU seconds and 30.20 wall seconds, approximately 2,026 records per wall second. The process exited successfully. No model artifact, economic outcome report, deployment or order was produced.

The final profile contains 24,043 main-thread V8 samples:

| Work | Self sample share | Inclusive sample share |
|---|---:|---:|
| `JSON.parse` in `decodeRecordedEvent` | 43.05% | 43.05% |
| Readline newline expression | 5.90% | 5.90% |
| Garbage collection | 5.59% | 5.59% |
| `LocalOrderBook.apply` | 4.35% | 6.29% |
| `distributionBookReason` depth validation | 2.44% | 2.44% |
| `FeatureEngine.onBook` | 0.95% | 6.63% |
| `DistributionController.onBook` | 0.78% | 8.98% |
| Full sizing feature path `onBook` | 0.52% | 12.22% |
| Optimized `RobustAgeGate.observe` | 0.17% | 3.36% |

Inclusive percentages overlap through callers and must not be added. These are main-thread sample proportions, not a decomposition of all process CPU; zlib worker activity and scheduling are not fully represented. This early archive prefix also does not represent a mature multiday model bank. The unchanged full replay provides the actual end-to-end throughput measurement.

The large JSON parsing cost is intrinsic to the current full-record JSONL input path. Changing serialization, introducing parallel parsing, or rewriting the streaming reader would require a separate correctness and provenance review. Smaller book/feature hotspots offer limited total improvement and provide no evidence for dropping events, reducing depth, bypassing validation, or changing strategy calculations. Preserve the current source freeze and finish the full replay.

Reproducible tooling is retained one directory above as `profile-training-prefix.mjs` and `analyze-training-cpu-profile.mjs`. The final machine-readable files are `prefix-summary.json`, `training-prefix.cpuprofile`, and `analysis.json`. The source aggregate is `ea201bae84aaa6e02a4b992a629b0593d3f5ce4089297ccab9e6719ec15fa51a` and the sizing-policy ID is `827a3c64f88eb32848104dc94f37b416f185a057441576e12cc16a4144ba7c02`.

Two preliminary profiles are retained for transparency and excluded from these conclusions: `*.instrumented.*` includes an extra uncompressed-record digest absent from the normal path; `*.pre-teardown-fix.*` captured useful runtime data but encountered a profiling-harness checksum-listener error during shutdown. The final driver hashes compressed bytes, removes the listener before closing, and exits cleanly.

Final container invocation:

```sh
docker run --rm --name distribution-risk-cpu-profile-final-20260909 \
  --network none --cpus=1 --memory=2g \
  -v crypto_trade_event_data:/archive:ro \
  -v /tmp/distribution-risk-v2-optimized-20260909/snapshot:/work:ro \
  -v /home/ec2-user/crypto_trade/node_modules:/work/node_modules:ro \
  -v /home/ec2-user/crypto_trade/reports/profit-engine-rebuild-2026-09-09/profile-training-prefix.mjs:/tools/profile-training-prefix.mjs:ro \
  -v /home/ec2-user/crypto_trade/reports/profit-engine-rebuild-2026-09-09/cpu-profile:/out \
  -w /work 9d102b68d463 node --cpu-prof --cpu-prof-dir=/out \
  --cpu-prof-name=training-prefix.cpuprofile --cpu-prof-interval=1000 \
  --import /work/node_modules/tsx/dist/loader.mjs /tools/profile-training-prefix.mjs
node reports/profit-engine-rebuild-2026-09-09/analyze-training-cpu-profile.mjs
```
