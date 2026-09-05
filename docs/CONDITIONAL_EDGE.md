# Conditional net-return research

`npm run research:edge -- --summary` runs a database-enforced read-only analysis.
Omit `--summary` for every chronological forecast and realized outcome. Paper
order submission, risk limits, execution policies and model promotion are unchanged.

This is a custom application of established regularized estimation and
risk-adjusted decision theory, not a new theorem or proof of profit. Ridge
addresses correlated predictors through coefficient shrinkage
([primary documentation](https://scikit-learn.org/stable/modules/linear_model.html#ridge-regression-and-classification)).
Balancing forecasts against costs and risk follows the general framework in
[Boyd et al.](https://stanford.edu/~boyd/papers/cvx_portfolio.html).
The particular features and constants below are research hypotheses.

## Target and features

For direction `s`, filled fraction `q`, entry price `Pe`, exit price `Px`,
per-side fee `f` in basis points, and additional reserve `r`, fit:

```text
y = q × [10,000 × s × (Px/Pe − 1) − f × (1 + Px/Pe) − r]
```

An observed IOC nonfill has `y = 0`; partial fills retain quantity weighting.
The executable-outcome validator reconciles this identity. Invalid and pending
labels are counted explicitly. These hypothetical attempt returns differ from
actual account P&L, which the trade report reconciles separately.

Features use only the signal quote: directional fast, medium and slow returns;
slow-trend efficiency; bounded directional OFI, TFI and velocity; and the
interaction of directional slow return with efficiency. Returns are scaled by
`max(1, 2f + r + spread)` to express motion relative to execution costs.
This is a feature scale, not an extra subtraction from the net target.

## Estimation and score

Standardize using only training means and scales. With an intercept column in
`X`, `D = diag(0,1,...,1)`, and fixed `lambda = 10`:

```text
A     = X'X + lambda D
beta  = solve(A, X'y)
mu(x) = x'beta
v     = max(1, sum((y − X beta)^2)/(n − p))
u(x)  = sqrt(v × x' solve(A, x))
L     = mean of the largest ceil(0.10 n) training values of max(0, −y)
score = mu(x) − 1.96 u(x) − 0.10 L
```

This penalizes uncertainty in the conditional mean and empirical tail loss.
It is not a predictive interval or a distribution-free 95% lower bound;
dependence, nonlinear dynamics, distribution shifts and model bias can invalidate
its Gaussian ridge uncertainty approximation. A one-basis-point residual floor
prevents constant histories from implying certainty. Features more than six
training standard deviations away are flagged out of domain. `preferred` means
the research score is positive and in domain; it never affects orders.

## Chronological evaluation

Every prediction requires at least 24 earlier non-overlapping outcomes. Fitting,
normalization, residuals and tail losses use those earlier outcomes only. The
longest declared family horizon plus 13 seconds supplies a common embargo across
exits and stresses. Non-overlap does not establish statistical independence.

Models are separated by configuration, policy version, sampling method, symbol,
side, family, regime, exit policy, fee, reserve, hypothesis and execution scenario.
No cross-cohort winner is selected. Duplicate IDs are excluded entirely. Actual
entry and broader episode evidence are never pooled. Data-quality exclusions can
bias exploratory results; this report cannot qualify a strategy for deployment.

The baseline uses exactly the forecasted opportunities. The conditional mean
per opportunity replaces nonpreferred outcomes with zero. Avoided losses are not
trading profits. Selecting no entries gives a null preferred-trade mean.

Deployment would need a frozen specification, fresh multi-day holdout, paired
stress validation, and portfolio/execution-aware evaluation. Existing policy
promotion requirements remain separate and unchanged.
