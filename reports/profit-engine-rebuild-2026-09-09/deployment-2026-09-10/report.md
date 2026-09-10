The historical-training repair was deployed to the Kraken Futures paper engine at **2026-09-10 00:04:15 UTC**. The running image is `sha256:4e5d6e8ecd4e816fdcb550caa11c20ff9172d0aa580ed99deaf4bccf8bca0c1a`. The verified source identity remains `c57475ab04ce281cbd83f86f95f0099d56d24ef5edcee758e293be197f8d036b` across 82 canonical source files.

**Profitability is not established.** The warmup and import defect is repaired, but the model still finds no current positive economic entry. Candidate strategies that failed their declared validation gates remain inactive.

| Check | Result |
| --- | --- |
| Historical reconstruction | 34 archives, 15,920,777 records, 6,001 complete outcomes |
| Original sizing proofs | 3,038; costs, instruments, features and source verified |
| Current-bank preflight | 5,765 additions, 6,146 retained; repeat import adds zero |
| Actual startup import | 5,763 additions, 6,148 retained across six UTC dates |
| Paper cash before and after deployment audit | $99,998.28269740003; exact zero change |
| New orders and fills during account audit | Zero; all 382 old activities preserved |
| Funding epoch | Preserved at September 9, 20:14:26.595 UTC |
| Runtime and database | Healthy and connected; no account halt |
| Current cap | min($1,000, 1% of equity), further limited by liquidity and risk |

The preflight and startup counts differ because the running engine collected additional outcomes between the two checks. Existing paper evidence takes precedence over overlapping historical labels; bounded action banks discard older excess history. Historical labels cannot become prospective validation.

The immutable 18,242,784-byte artifact has SHA256 `357d2802753bfecd18eabdd6fefe6fd7cec9649fadaed06d3a47fbe5436fd9c8`. It was staged at `/app/data/distributional-training-risk-v2-20260909T201636-357d2802753bfecd.json`. Only `DISTRIBUTIONAL_TRAINING_FILE` changed in `.env`. Recovery copies were created under `/app/data/pre-risk-training-import-2026-09-10T00-02-09.319Z`; they are separate file snapshots, not a transaction spanning all files.

Post-deployment verification at 00:06:12 UTC found all twelve current BTC/ETH action estimates supported by five or six training dates and rejected by `SCORE_BELOW_MINIMUM`. A separate ten-second sampler recorded 27 snapshots after container startup through 00:08:39 UTC, including two unavailable snapshots during startup. It captured 38 fresh decisions, all rejected by the economic score. Supported date counts ranged from four to six; conditional net means were approximately −17.01 to −6.09 basis points, and conservative scores were −30.36 to −17.26 basis points. The observed selection counter remained zero. This sampled view is not a complete decision or order ledger and does not establish future performance.

The full reconstructed replay likewise produced no passing selection. Its 483,175 below-minimum decisions and negative raw action means are counterfactual training diagnostics after simulated execution, fees and a fixed reserve. They do not include observed funding cash and cannot be summed into account profit. The paper funding ledger is separate; funding before its existing epoch remains explicitly unknown.

Validation includes the 1,297-test full-suite run, focused checks for the final lossless origin format, nine import tests in the actual compiled image, a real-archive parity comparison, an independent full-artifact audit, a real-account schema smoke check, current-bank preflight and post-deployment account reconciliation. Passing software checks does not prove a trading edge.

A final runtime check at 00:13:58 UTC confirmed healthy service and database status, unchanged flat-account equity, zero open orders or positions, and continued learning: three additional outcomes, for 6,151 retained samples. No entry had been selected. Both quotes in that particular snapshot were below the venue minimum order quantity after the existing liquidity limit was applied. Liquidity remains an independent entry condition alongside the economic score. [Final runtime snapshot](final-runtime.json).

Evidence: [deployment record](deployment.json), [current-bank preflight](import-preflight.json), [staging and backup hashes](staging.json), [single configuration change](env-change.json), [post-deployment verification](post-deployment.json), [sampled observations](sampled-observation.json), [full artifact audit](../distribution-training-v2/full-artifact-audit.json), [full reconstruction report](../distribution-training-v2/full-replay-report.json), [build validation](../build-validation.json), [compiled import validation](../compiled-import-validation.json).
