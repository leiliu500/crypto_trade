# Current-size historical training

The `risk-bounded-training-backfill-v2` protocol reconstructs counterfactual action labels from archived public order books and trades using the current risk sizing policy. It addresses a bank that lacks enough training dates after a sizing-policy change. It does not establish profitability or guarantee an entry.

Run the preparation command against frozen, chronological recordings and a new output path:

```sh
npm run research:distribution:train -- \
  --sizing-mode=RISK_BOUNDED \
  --reference-equity=100000 --reference-high-water=100000 \
  --assets=reports/distribution-instrument-rules-2026-09-07.json \
  --cutoff=2026-09-09T20:16:36.489Z \
  --state-out=NEW_IMMUTABLE_ARTIFACT.json \
  FIRST_FROZEN_RECORDING.jsonl.gz NEXT_FROZEN_RECORDING.jsonl.gz
```

Use the full selected recording sequence in one invocation to retain feature continuity. `--state-in` may resume a matching v2 label bank, but reconstructs market features from the newly supplied public history; it does not restore earlier feature history or unresolved executions. Every new public receipt must follow the checkpoint's completed labels and recorded receipt floors. The original source, cost, sizing and instrument assumptions must match before older labels can be retained.

The declared $100,000 reference balance is a fixed counterfactual sizing input, not a claim about historical account cash. Both balances are retained per origin. At the current policy, requested quantity is bounded by the lesser of the $1,000 experiment cap and 1% of reference equity, then by the unchanged loss, volatility, drawdown, venue lot and book participation rules. The cap is an upper bound; many books correctly produce a smaller quantity or no valid quantity.

Feature updates follow the running engine's book and trade order, including trade-clock advancement against the last valid book. All observed public updates remain in the causal simulator; missing paths, public disconnects, recorder gaps and genuine receipt reversals invalidate affected outcomes. No candles, synthetic depth, fabricated executions or downsampling fill missing coverage.

This protocol uses the current efficient paper-trial profile. Each 5, 15 or 30 minute action follows its existing independent nonoverlap schedule and requires all three execution scenarios. A complete six-action panel is not required for independent action collection. The importer rejects legacy fixed-size labels and different training profiles instead of changing the production profile to accept them.

Every retained origin contains the observed book, full sizing features, reference capital, requested quantity and distribution feature vector. The importer recomputes its permitted quantity from the current policy and instrument rules, verifies hashes and temporal bounds, and rejects mismatches before changing the bank. It also requires the canonical TypeScript dependency closure to match the trusted running code. TS and compiled runners hash the same shipped `src` files; a runtime without those files cannot accept v2 artifacts. Preparation checks source identity before replay and before atomic publication. A resumed artifact cannot receive a new source identity for its older labels.

The immutable artifact records compressed input hashes, instrument rules, feature configuration, costs, sizing policy, source hashes and the checkpoint hash where applicable. Historical rules are supplied assumptions unless independently archived and verified. The active bounded bank keeps newer live labels ahead of overlapping historical labels. Reimporting the same artifact is idempotent. New labels clear prospective selections; replay selections and pending paths cannot grant order permission.

File preparation stores origins using the versioned `risk-training-origins-json-gzip-base64-v1` encoding. This preserves every original book level and numeric feature and verifies both compressed and decoded bytes. The outer file remains limited to 64 MiB; the decoded origin block is limited to 256 MiB and its declared exact size. Corrupt, truncated, conflicting or unknown encodings are rejected. Original uncompressed v2 artifacts remain readable under their original source identity; packing never assigns new execution-code provenance to old labels.

Labels include the configured execution fees and fixed reserve. They do **not** include observed funding cash, historical margin cash flows, real broker fills or an account return. Negative outcomes remain negative. The existing requirements for local sample count, effective support, UTC dates, freshness, a positive robust score and the configured profile's validation remain unchanged. Three archive dates do not guarantee three eligible dates in every current feature neighborhood.

The September 9 feasibility inventory found 34 frozen archives spanning September 4 at 22:15:59.790 UTC through September 9 at 20:16:36.489 UTC, totaling 7,114,338,384 compressed bytes. These are endpoint coverage bounds; only replay establishes complete usable execution paths. The mutable current recorder file is excluded. Preparation writes a new artifact only. Production import and activation are separate reviewed actions.
