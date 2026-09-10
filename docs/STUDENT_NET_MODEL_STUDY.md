# Nonlinear after-cost Student-t study

This experiment asks whether additional price/volume information and a nonlinear predictive distribution improve BTC/ETH trading. Mathematical complexity is a hypothesis to test. It does not establish positive expected returns. Existing conditional and adaptive models, study records, and the running strategy remain unchanged.

## September 8 result

The boosted model improved on its matched linear baseline, but **both failed 2024 development**. No candidate was activated. Confirmation and the January–July 2026 final period were denied before evaluation. Results are individual-asset dollar P&Ls under the common $12 cap and projected cost scenarios, not actual live returns or a combined portfolio.

| Model | Asset | Base completed trades | Base net USD | Stress net USD |
| --- | --- | ---: | ---: | ---: |
| Student-t boosting | BTC | 212 | −0.351 | −3.312 |
| Student-t boosting | ETH | 202 | −2.703 | −4.118 |
| Matched linear | BTC | 186 | −3.184 | −6.627 |
| Matched linear | ETH | 222 | −3.901 | −10.102 |

Every model/head had 8,733 evaluation origins per asset, zero unavailable predictions, zero unknown outcomes, and zero conflicting-direction abstentions. This failure is not a warmup or insufficient-sample block. The boosted model produced 6,730 qualifying hourly signals before the shared account constraints; the matched linear model produced 6,461.

Boosting improved Brier and CRPS scores relative to the matched linear model in both assets and cost scenarios. However, **both models were worse than the simple held-out unconditional distribution** on those scores. For example, base Brier loss averaged over directions was 0.252617 versus 0.250418 unconditional for BTC, and 0.256067 versus 0.255337 for ETH; lower is better. The nominal central 80% boosted intervals covered only 75.84% of BTC and 77.07% of ETH outcomes, demonstrating why empirical calibration cannot be advertised as guaranteed coverage.

The boosted strategy's stress results remain negative even if all funding charges are removed from the same fills: BTC −$0.702 and ETH −$1.072 after fees and slippage alone. This is cost attribution, not a retuned strategy or evidence that funding should be omitted. Projected funding is a limitation, but it does not fully explain the failed stress results.

The numerical and software tests pass; exploitable after-cost information has not been established. The result supports preserving the holdout and investigating additional economic information before making another model more complex. The existing recorder has order-book/aggressor-flow data for a short local window, but no multiyear order-book, open-interest, mark/index premium, or verified funding-settlement history for this comparison.

Validation includes a production build and 828 distinct passing tests (827 in the full regression run plus a final scope test, with all 16 study tests rerun after that fix). Independent prediction reconstruction matched 192 saved head models, 139,728 head/origin predictions, 34,932 decisions, and both qualified-forecast arrays. Proper scores agree within 1.97e-12. Independent accounting reconciled all 12 scenario reports and 105,420 hourly equity points; all 1,623 candidate trades match their cost labels exactly, and all 192 monthly label partitions match their recorded hashes and strict time cutoffs. The records are `independent-prediction-audit.json`, `independent-execution-audit.json`, and `validation-status.json` under `reports/hourly-student-study-2026-09-08`.

## What changes

The older hourly learned models mainly used four close-return features. This study adds completed volume surprise, relative volume, candle body/close location, true-range surprise, current volatility, and a BTC–ETH residual with a trailing estimated hedge coefficient. All twelve coordinates use only synchronized completed candles with 169 hours of continuous history. They are a new schema, unrelated to the live distribution controller's twelve coordinates.

The new model uses fixed Student-t distributions with five degrees of freedom. Forty-eight rounds of shallow trees jointly learn location and scale through natural-gradient descent on negative log likelihood. Tree splits use 32 training-only histogram bins, depth two and at least 256 rows per leaf. A common backtracking step keeps each accepted update from increasing training loss. The fixed learning rate is 0.05. These are declared choices, not parameters selected by sweeping historical profits.

For a target (y), location \(\mu\), scale \(\sigma\) and \(z=(y-\mu)/\sigma\), the optimized loss, up to its fixed normalizing constant, is

\[
L=\log\sigma+3\log(1+z^2/5).
\]

The natural-gradient coordinates are

\[
g_\mu=-8(y-\mu)/(5+z^2),\qquad
g_{\log\sigma}=4(1-z^2)/(5+z^2).
\]

Student-t scale is not standard deviation; for this distribution, standard deviation is \(\sigma\sqrt{5/3}\). Trees can express interactions and changing dispersion that a linear point forecast cannot. The methodological basis is [NGBoost, Duan et al.](https://proceedings.mlr.press/v119/duan20a.html); this is a local fixed implementation, not evidence from that paper of cryptocurrency profitability.

The matched baseline is weighted ridge regression with penalty 16 and an unpenalized intercept, using the **same new features, after-cost labels, calibration windows and execution scenarios**. This separates the contribution of nonlinear mathematics from the contribution of new data. An unconditional empirical distribution supplies a second predictive benchmark.

## Targets and uncertainty

Each asset has four targets: long/short crossed with base/stress execution. A label is the counterfactual single-position net payoff divided by the fixed $12 capacity, multiplied by 10,000. It includes tick and lot rounding, fees, adverse slippage, funding assumptions and exit retries. Known nonfills have zero payoff; unknown paths retain null economics and are reported separately. Portfolio overlap is imposed in the subsequent shared-account simulation.

Each UTC month start fits the preceding 365 days with a 90-day label-recency half-life, withholding the last 30 days for calibration. Both boundaries have a common 51-hour decision purge and an explicit strict label-receipt cutoff. At least 6,000 fit rows, weight ESS 1,000, and 500 calibration rows are required. Calibration prices and payoffs do not enter the fit; there is no refit on them afterward.

Held-out standardized residuals \(z_i\) define the final empirical distribution \(Y=\mu(x)+\sigma(x)Z\). Its mean is \(\mu+\sigma\bar z\); its positive-payoff probability, quantiles and lower-tail expectation all come from that same distribution. Mean adjustment is not silently omitted when residuals are biased. Exact empirical CRPS and Brier scores measure the final distribution; raw Student-t likelihood is reported separately.

About 669 hourly calibration outcomes overlap over 24-hour horizons, amounting to roughly 28 daily horizons, not 669 independent observations. Predictive quantiles and tail averages are not confidence bounds on mean profit. No exchangeability or conditional-coverage guarantee is asserted. [Gibbs and Candès](https://papers.nips.cc/paper/2021/hash/0d441de75945e5acbc865406fc9a2559-Abstract.html) explain why distribution shift requires explicit treatment in uncertainty calibration; this experiment measures empirical calibration rather than implementing their online coverage algorithm.

An entry requires calibrated base mean above 5 bps, stress mean above zero, and positive-payoff probability above 0.5 in both scenarios. If both directions qualify, the policy abstains and records the inconsistency. This avoids selecting the more favorable of mutually conflicting heads.

## Same economic tests

The shared retry simulator retains the existing $12 global slot, UTC-day asset priority, fees of 5/7.5 bps per side, adverse slippage of 1.5/3 bps per side, one/two-hour entry delay, 24-hour holding and hourly exit retries for up to 24 extra hours. The current instrument-rule snapshot is an explicit assumption for historical execution.

Base and stress funding reserves remain the prior 365-day p95/p99 absolute rates, fixed at each evaluation period start, as in the previous study. Both directions pay adverse funding and stress adds 1 bp per 24 hours. Those known period costs retrospectively reprice fit/calibration payoffs. Calibration is performed at the model cutoff; it is not an archive of trades or forecasts issued at the earlier calibration timestamps. Returns are projected cost scenarios because actual funding timing and the full later funding history remain unverified.

2024 is development and has already been inspected in earlier work. Eligible asset/model combinations must pass the unchanged trade-count, positive base/stress net return and dollar-risk gates. In addition, the average long/short Brier and CRPS scores must beat the held-out unconditional distribution in both scenarios. Per-asset selection uses stress net minus half drawdown, with no combination sweep. The combined policy must beat the previously selected BTC buy-and-hold reference; it needs 100 trades, 40 active dates and 20 trades per asset in each scenario, with positive P&L for both assets and drawdown/daily loss at most $12.

Fixed choices then face 2025 confirmation, which is explicitly already inspected. January–July 2026 remains a gated final period; August is excluded. That final stage also requires positive nominal paired-weekly 95% lower bounds versus flat and BTC buy-and-hold. There is no automatic activation or live-capital permission.

## Reproduce

Build with `npm run build`, then run the following CLI with stages `register`, `develop`, `confirm`, and `test` in that order, advancing only after a passed gate. Use a fresh output directory; existing stage artifacts cannot be overwritten.

```sh
node dist/src/research/hourly-student-study-main.js register reports/hourly-adaptive-study-2026-09-08/data-older-restored reports/hourly-adaptive-study-2026-09-08/data-recent /tmp/new-student-study
```

The runner hashes the protocol, all model/evaluation sources, input datasets and manifests, and output artifacts. It validates data before and after evaluation. A failed gate denies the next stage before reading its evaluation data or producing a start marker. Full forecasts, calibrated distributions, monthly model diagnostics, and account traces remain local; compact protocols, summaries and independent audits are retained for review.
