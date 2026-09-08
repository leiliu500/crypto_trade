# BTC/ETH predictive quality study — September 8, 2026

## Initial diagnosis

The existing conditional model has not established an executable edge. The
main economic obstacle is weak prediction of gross returns relative to costs.
Sparse relevant history also blocks some decisions. Shrinking net returns toward
zero makes expected costs too optimistic; it does not explain the absence of
positive entries.

The [diagnosis](../reports/predictive-quality-study-2026-09-08/diagnosis.json)
reconstructs the two completed historical studies from their compact audits and
frozen training banks. Protocol, seed, audit-chain and bank hashes were verified.
All **1,512 recorded per-scenario forecasts** were reproduced with **zero numerical
difference**. The analysis uses only labels available before each frozen cutoff
and forecasts recorded before their corresponding outcomes. It does not replay
raw market depth or introduce new realized outcomes.

The later study evaluated September 8, 08:00–16:44:28 UTC. Each asset had only
**16 probe origins**, with six dependent action paths at each origin. Base execution
had 74 known BTC action outcomes and 77 known ETH outcomes; 22 and 19 paths,
respectively, were unknown. The following means include genuine nonfills at zero
and exclude unknown paths. They are counterfactual action diagnostics, not
executed account returns or independent trade samples.

| Later base-scenario diagnostic | BTC | ETH |
| --- | ---: | ---: |
| Observed mean gross return | +0.91 bp | −1.31 bp |
| Observed mean net return | −10.51 bp | −12.03 bp |
| Mean explicit cost per known action outcome, including nonfills | 11.42 bp | 10.72 bp |
| Filled paths with positive gross return | 35 / 65 | 29 / 65 |
| Filled paths with positive net return | 12 / 65 | 15 / 65 |

The configured base fee and reserve total approximately 13 bp on a full fill;
the fee-stress scenario totals approximately 18 bp. The smaller average costs in
the table reflect nonfills and any partial-fill weighting. Spread and depth effects
are already reflected in executable gross prices.

For the existing model with efficient training, local unshrunk mean net forecasts
averaged −13.06 bp for BTC and −12.52 bp for ETH. The zero-net prior raised these
to −7.37 bp and −5.91 bp. The mean shrink factors were 0.566 and 0.472. This
attenuates the negative cost component along with directional returns.

That calibration effect is material but inconsistent across assets:

| Later base-scenario RMSE | BTC | ETH |
| --- | ---: | ---: |
| Existing production net forecast with efficient training | 12.98 bp | 23.33 bp |
| Same neighbors, unshrunk net mean | 13.49 bp | 21.50 bp |
| Same neighbors, unshrunk gross mean | 12.75 bp | 20.66 bp |
| Zero-gross forecast | 12.71 bp | 21.65 bp |

BTC's gross forecasts did not improve on zero gross in this period. ETH's gross
forecasts showed a modest error reduction, while shrinking net returns toward
zero worsened net calibration. These diagnostics do not justify simply removing
shrinkage: the BTC net error moved in the opposite direction. In the earlier
five-origin assessment, gross RMSE also supplied little evidence of an advantage:
15.67 versus 15.38 bp for BTC, and 25.62 versus 25.70 bp for ETH, comparing
unshrunk conditional gross with zero gross.

Support was another limitation. Of the later 96 action forecasts per asset, the
efficiently trained model passed its sample/date prerequisites but failed the
score on 46 BTC and 26 ETH forecasts. The remaining forecasts failed sample or
date requirements. Neither conditional policy selected a trade. Adding labels
improved coverage without establishing a profitable signal. The recorded later
study remained **INCONCLUSIVE**.

## Recorded opportunities the current model missed

The [missed-opportunity audit](../reports/strategy-failure-audit-2026-09-08.json)
reproduces the archived efficient-model forecasts exactly and compares them with
their recorded execution outcomes. In the later window:

| Diagnostic | BTC | ETH |
| --- | ---: | ---: |
| Known action paths profitable after base costs | 12 / 74 | 15 / 77 |
| Observation times containing a known profitable action | 7 / 16 | 7 / 16 |
| Action paths profitable in every tested execution scenario | 6 | 9 |
| Profitable base paths blocked first by sample/date support | 9 | 11 |
| Profitable base paths with adequate support but nonpositive worst-scenario forecasts | 3 | 4 |
| Eligible actions | 0 | 0 |

At September 8, 13:41 UTC, the long-30m action returned +31.36 bp for BTC
and +74.18 bp for ETH after base costs. The lowest net outcomes across all
three execution scenarios were +26.35 bp and +69.15 bp. The corresponding
lowest scenario mean forecasts were -0.104 bp and +0.075 bp. Both contexts
also failed the training-date requirement. Removing that requirement and the
uncertainty/tail penalties would still leave these forecasts below the +1 bp
entry threshold. None of the 192 later action forecasts exceeded +1 bp in
every scenario, regardless of support.

These observations confirm missed profitable simulated paths. They do not
establish that those paths were predictable beforehand, nor can overlapping
counterfactual paths be added together as attainable portfolio profit. The
recordings have already been inspected and are not an untouched test set.

A live snapshot at 20:37:34 UTC found both assets ready, evaluations configured
every second, 418 evaluations since restart, and zero selections. All twelve
actions passed their sample/date requirements with four qualifying dates.
Every displayed net mean was negative: BTC ranged from -14.60 to -12.28 bp,
ETH from -13.02 to -9.14 bp. Each action failed `SCORE_BELOW_MINIMUM`.
The snapshot and archived audit identify predictive entry selection as an
unresolved problem. Operational training and deployment improvements have not
demonstrated an effective BTC/ETH trading strategy.

## Fixed candidate, specified before its evaluation results

The single candidate is **btc-eth-cost-aware-ridge-v1**. It uses a fixed ridge
penalty of **16**, with separate fits for each asset, action and execution scenario.
It estimates expected filled fraction from all valid outcomes and executable gross
return per filled unit from filled outcomes. The gross regression weights each
training row by its observed filled fraction as well as recency. The expected
cost per filled unit is estimated with those same weights and is not shrunk toward
zero.

```text
predicted net return = predicted filled fraction
                     × (predicted gross return per filled unit − estimated cost per filled unit)
```

The expected filled fraction is clipped to [0, 1]. This quantity is distinct from
the probability of any fill. Partial-fill returns are divided by filled fraction
before fitting per-filled-unit targets, then multiplied by the predicted fraction
once when forming the final forecast. Unknown execution paths are excluded; they
are never represented as nonfills.

Feature centering and scaling use only the frozen training bank, with a fixed
scale floor of 0.1. Target intercepts are unpenalized so regularization does not
erase constant fill or cost calibration. The candidate retains seven-day recency
weights and requires at least 48 observations, effective sample size 32, three UTC
dates with aggregate weight at least one each, and effective filled sample size
16. Every training label must complete strictly before the frozen cutoff.

The candidate is a research model. It does not submit orders or automatically
change the paper engine. The regularization strength, scaling rule and feature set
are fixed for this comparison; no parameter search is part of this candidate.

## Evaluation and interpretation

Compare the candidate with the existing model using efficient training, the
corresponding unconditional training mean, and a zero-gross forecast with costs.
Use identical frozen cutoffs, probe origins, action definitions and realized
execution scenarios. Report missing forecasts and unknown outcomes alongside
paired error metrics. Use the cost-only comparison to distinguish better fee
calibration from useful directional prediction.

Any return estimate must identify its actual evaluation denominator and preserve
unknown paths. Forecast-error improvements alone do not establish profitable
selection. The historical recordings were already inspected and remain
development evidence, even when the calculation is causal. More observations,
multiple independent later dates and actual net paper outcomes are needed before
claiming effectiveness.

## Completed comparison

The fixed candidate was evaluated on both archived windows. All models had
finite forecasts for all 252 action paths. Error comparisons exclude unknown
outcomes and use exactly the same known rows: 26 BTC / 27 ETH in the first
window, and 74 BTC / 77 ETH in the later window. These correspond to only five
origins per asset in the first window and sixteen per asset in the later one.

Base-scenario net-return RMSE, in basis points (lower is better):

| Window / asset | Existing efficient-training model | Unconditional mean | Zero gross minus costs | Cost-aware ridge |
| --- | ---: | ---: | ---: | ---: |
| First / BTC | 17.40 | 15.54 | 15.42 | **14.60** |
| First / ETH | 27.39 | **26.39** | 26.39 | 27.41 |
| Later / BTC | **12.98** | 13.53 | 13.42 | 13.83 |
| Later / ETH | 23.33 | **22.02** | 22.28 | 22.94 |

The candidate reduced optimistic forecast bias, but its accuracy gains did not
persist across assets and windows. Its later gross-return RMSE was 14.15 bp for
BTC and 22.74 bp for ETH, worse than zero-gross forecasts at 12.71 and 21.65 bp.
The earlier BTC gross comparison improved (14.41 versus 15.38 bp), while ETH
worsened (26.33 versus 25.70 bp). This does not demonstrate reliable additional
directional information. Even beating zero gross could reflect a fitted
intercept or expected-fill effect rather than value from the directional features.

The diagnostic policy evaluates only recorded probe origins in their original
event order. All four model policies use the same existing local support screen
and require a worst-scenario predicted net **mean** above 1 bp. No uncertainty or
tail score is applied to any of these diagnostic model policies, so they are
not the deployed policy. Model-specific forecast availability can differ in
general; it did not differ on these windows. Each policy has one shared BTC/ETH
slot, released only when its selected outcome record arrives.

**All four model policies selected zero trades in both windows.** Only four
actions in the first window and 72 in the later one passed the shared support
screen. The ridge candidate had two positive stressed ETH long-30m forecasts in
the later window, but those contexts failed that screen. The screen was kept
fixed after observing these results.

Under the same sparse grid/support screen, the later fixed-long, fixed-short,
and momentum baselines each made eight selections. Their known-only base mean
returns were -15.47, -8.45, and -18.18 bp respectively. Each had an unknown
selected outcome, so full-period net returns remain unavailable. These are
requested-notional counterfactual bps, not realized account returns. No model
has demonstrated an after-cost trading improvement here.

**Decision: retain the candidate for research; do not promote it to the paper
engine.** The running efficient collector remains in place. Its trading model,
entry thresholds, execution costs, and permissions were not changed by this
study. Better cost calibration alone is insufficient justification for replacing
the current model.

## Reproduction and validation

```bash
npm run research:predictive-quality -- \
  reports/conditional-history-study-2026-09-08 \
  /tmp/new-predictive-comparison
```

The production image includes the compiled command and the source files used
for hash verification. From its `/app` working directory, run
`npm run research:predictive-quality:production -- INPUT_DIRECTORY NEW_OUTPUT_DIRECTORY`.
Mount archived inputs read-only and provide a writable output directory. The
research command does not change the active trading model or submit orders.

The research tools were deployed to the paper-engine image on September 8,
2026 at approximately 20:33 UTC. An isolated production-container run reproduced
both verified comparisons exactly. The restart preserved all 1,272 training
labels and resumed live evaluations. Active trading modules are byte-identical
to the preceding deployment; the cost-aware candidate remains a research model.
See the [deployment report](../reports/predictive-tools-deployment-2026-09-08.json).

The runner seals the fixed specification and code hashes before evaluation,
refuses to overwrite previous output, and checks source hashes again before
marking completion. The loader validates seed/protocol hashes, the complete
audit chain, frozen bank hashes, strict training cutoffs, complete action/scenario
coverage, and forecast-before-outcome ordering. It does not rehash or replay raw
depth archives; their earlier sealed metadata is retained explicitly.

The first attempt detected a loader source change from parser hardening during
execution. Its outputs and incomplete-attestation status were retained. The
verified repeat used identical candidate parameters, data, forecasts and
selections; its final source hashes match the initial hashes. The repeat was
for reproducible source provenance, with no parameter selection based on results.

All **664 repository tests passed**, including 22 candidate, loader, and policy
tests. The final policy tests were repeated after adding availability reporting,
and the final TypeScript build passed.

An independent audit reproduced the frozen fits and forecasts, every scenario's
net/gross/cost error metrics and availability counts, and a separate chronological
one-slot policy replay. All 42 origins and 252 action paths matched. All eight
source hashes matched the manifest, and numerical forecasts, coefficients,
metrics, selections and outcomes matched the preserved first attempt exactly.

- [Independent final audit](../reports/predictive-quality-study-2026-09-08/independent-audit.json)
- [Verified comparison summary](../reports/predictive-quality-study-2026-09-08/fixed-ridge-v1-verified/summary.json)
- [Frozen candidate manifest](../reports/predictive-quality-study-2026-09-08/fixed-ridge-v1-verified/candidate-manifest.json)
- [First-window forecasts and outcomes](../reports/predictive-quality-study-2026-09-08/fixed-ridge-v1-verified/first.json)
- [Later-window forecasts and outcomes](../reports/predictive-quality-study-2026-09-08/fixed-ridge-v1-verified/later.json)
- [Preserved first-attempt status](../reports/predictive-quality-study-2026-09-08/fixed-ridge-v1/attempt-status.json)

## Existing evidence

- [First independent audit](../reports/conditional-history-study-2026-09-08/first-independent-audit.json)
- [Later independent audit](../reports/conditional-history-study-2026-09-08/later-independent-audit.json)
- [Later study summary](../reports/conditional-history-study-2026-09-08/later-summary.json)
- [Reproduction script for this diagnosis](../reports/predictive-quality-study-2026-09-08/diagnose-existing-predictions.mjs)
