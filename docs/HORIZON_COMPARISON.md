# BTC/ETH holding-period comparison

This offline study compares 1-, 3-, 5-, 15- and 30-minute exit deadlines on
recorded Kraken Futures order books and trades. It does not install a model,
change paper-entry permissions or submit orders. A holding deadline starts at
the simulated first fill; a stop or target can trigger an earlier exit, and an
exit still needs a later executable quote.

## Prespecified policy families

| Family | Candidates | Exit settings | What it compares |
| --- | --- | --- | --- |
| Legacy | Long/short at 5/15/30 minutes | Existing 25/40/60 bp gross stops and 40/65/90 bp net targets | Current reference policies |
| Fixed control | Long/short at 1/3/5/15/30 minutes | 25 bp gross stop and 40 bp net target for every deadline | Deadline changes with constant barriers |
| Volatility | Long/short at 1/3/5/15/30 minutes | Stop `max(10 bp, sigma_h)`; net target `max(20 bp, 1.6 × sigma_h)` | A fixed volatility-adjustment hypothesis |

The 26 actions are defined in `src/distribution/horizon-spec.ts` before reading
the comparison results. The volatility proxy uses only the preceding 30 minutes
of observed prices, before the model's feature clipping. The study sets
`sigma_h = sigma_30m × sqrt(h / 30m)`. This scaling and its multipliers are
assumptions to evaluate, not established forecasts. Quiet markets with zero
measured volatility remain included and use the floors. Every action's stop
and target are frozen at its origin.

BTC and ETH are reported separately. Volatility adjusts the exit distances to
each asset's observed path; it does not establish that either asset has a
profitable directional signal.

## Execution and comparison

Each common origin evaluates all 26 actions under the existing three stresses:
250 ms arrival, 250 ms with 1.5× fees, and 750 ms with half visible depth. Entry
IOCs wait for later observed quotes and can fail to fill. Exit prices follow the
same stop/target/deadline and capped-exit simulator as the current distributional
research. Fees, spread, partial fills and nonfills enter the net return once.
Missing or invalid outcomes remain unknown.

The fixed 31-minute origin spacing prevents overlap of the longest candidate
paths. It is the sampling schedule for this comparison. The running paper
engine continues its independent entry checks on fresh quotes, at most once per
second per asset. Short paths completed inside an otherwise invalid panel remain
visible in individual coverage diagnostics. Comparisons of horizons and families
use identical complete panels, so a shorter policy cannot win merely because it
had a different set of admitted opportunities. Exclusion counts remain visible.

The training benchmark selects one fixed action or FLAT per asset and family
using only completed common training panels. It requires 24 panels across three
UTC dates and a positive lower daily mean above 1 bp in every execution scenario.
Daily means receive equal weight; the fixed 2.58 uncertainty multiplier and
variance floor are conservative approximations, not calibrated confidence
guarantees. Training outcomes crossing the later-period boundary are purged
before selections lock. Later returns never change those selections.

This unconditional action benchmark evaluates policy choices and execution. It
does not reproduce the live model's conditional entry selection, one-second
opportunity distribution or shared BTC/ETH portfolio. Its per-opportunity net
basis points are not an account return. Any normalized dollars use a standardized
$12 denominator, not the exact cash ledger. Later outcomes after selecting FLAT
are zero but establish no trading profit.

## Recorded-data protocol

The main corpus uses the same 21 immutable recordings and compressed-byte hashes
as `reports/distribution-training-2026-09-07.json`. It includes August 27 and
September 4–7 with a substantial intervening gap. The earlier Alpaca recordings
are excluded. The fixed training interval begins August 27; later assessment
begins September 7 at 00:00 UTC and stops at 18:07:03 UTC. The records had already
been inspected, so this is chronological assessment rather than an untouched
holdout. A single later date provides limited evidence about stability.

```bash
npm run research:horizons -- \
  --manifest=reports/distribution-training-2026-09-07.json \
  --assets=reports/distribution-instrument-rules-2026-09-07.json \
  --training-start=2026-08-27T00:00:00Z \
  --later-start=2026-09-07T00:00:00Z \
  --cutoff=2026-09-07T18:07:03Z \
  --out=/tmp/new-horizon-comparison.json
```

Manifest paths must resolve to the exact recordings. The CLI hashes compressed
bytes while replaying them, verifies the expected sizes and hashes, checks that
all files remained unchanged, and creates a new output only after verification.
It refuses to replace an existing file. `--include-panels` retains frozen
candidate definitions and outcomes for audit.

## Timing limits

The Kraken adapter batches book images at approximately 25 ms. The recorded
book and trade timestamps use milliseconds. These inputs cannot reconstruct
intra-batch queue changes or demonstrate a microsecond trading advantage.
Microsecond network latency, decision computation time, fill latency and holding
duration are distinct measurements. This study evaluates holding policies under
explicit execution delays; it makes no claim to simulate colocated HFT.
