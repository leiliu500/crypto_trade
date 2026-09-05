# Kraken Futures BTC/ETH Trading System

## Complete mathematical and engineering design for entries, order management, holding, profit protection, and exits

**Prepared:** September 5, 2026  
**Adapter context:** `KRAKEN_FUTURES`  
**Markets:** BTC and ETH  
**Default runtime:** Deterministic rules and versioned empirical tables; no LLM or neural network required.  
**Status:** Research and engineering specification, not an implemented or profitability-validated trading system.

> **Risk and scope:** No entry or exit rule can guarantee profitable trades. This design targets positive expected profit after actual costs, limits unsuccessful trades, and protects profitable trades using estimated executable prices. Stops, profit floors, and daily thresholds are intervention rules, not guaranteed execution prices or maximum losses. Proposed strategy thresholds must be validated before live use. Confirm the actual Kraken product, contract type, account permissions, and current specifications before applying this design.

This document consolidates the full preceding design, including its mathematics, numerical examples, implementation requirements, configuration hypotheses, order lifecycle, failure handling, and validation requirements. Source links are provided throughout and collected at the end. Exchange documentation can change; account-specific fees and behavior must be checked at deployment.

## Contents

1. [Design objective and separation of responsibilities](#design-objective-and-separation-of-responsibilities)
2. [Correct the Kraken-specific economics](#1-correct-the-kraken-specific-economics)
3. [Use one authoritative profit calculation](#2-use-one-authoritative-profit-calculation)
4. [Why exit mathematics alone does not create an edge](#3-why-exit-mathematics-alone-does-not-create-an-edge)
5. [System architecture](#4-system-architecture)
6. [Entry features](#5-entry-features)
7. [Default entry strategy](#6-default-entry-strategy-breakout-pullback-reacceleration)
8. [Policy-level expectancy and entry qualification](#7-policy-level-expectancy-and-entry-qualification)
9. [Position sizing and portfolio risk](#8-position-sizing-and-portfolio-risk)
10. [Holding, recovery, profit protection, and exits](#9-holding-recovery-profit-protection-and-exits)
11. [Kraken order lifecycle and failure handling](#10-kraken-order-lifecycle-and-failure-handling)
12. [Data quality and observability](#11-data-quality-and-observability)
13. [Validation and deployment requirements](#12-validation-and-deployment-requirements)
14. [Implementation priorities](#13-implementation-priorities)
15. [Sources](#14-sources)

---

## Design objective and separation of responsibilities

Stop adding indicators indiscriminately. Redesign the engine around three separate questions:

1. **Entry quality:** Is there evidence that this specific setup has positive expected profit after actual Kraken costs?
2. **Execution quality:** Which order type gives the best expected result, including the possibility of not filling?
3. **Position management:** After a fill, is continuing to hold better than closing now, and how much profit or capital may be given back?

These questions require different mathematics. Combining them into one buy/sell score makes it difficult to discover why a strategy loses money.

The objective is positive **net expectancy**, not merely more trades, a higher gross win rate, or profitable-looking mark-price movements.

---

## 1. Correct the Kraken-specific economics

### 1.1 Confirm which Kraken derivatives product the adapter actually uses

The accounting and numerical examples below assume the Kraken Derivatives API and **linear BTC/USD and ETH/USD perpetual contracts**.

Discover the actual symbols and contract specifications from the instruments endpoint rather than assuming the meaning of `KRAKEN_FUTURES`. Kraken metadata distinguishes contract types and supplies fields such as tick size, contract size, trade precision, and margin requirements. **Do not apply linear-contract accounting to inverse contracts.** [R1]

There is also a product distinction: Kraken Derivatives US offers Bitnomial-listed perpetual futures with a different, per-contract fee structure. The international percentage-based fee examples in this document must not automatically be applied to those contracts. [R2]

### 1.2 Current fee-service integration requirement

Kraken states that, effective **June 22, 2026**, the old Futures fee-schedule endpoints no longer reflect the fees actually charged. Its documentation directs clients to the Spot `GetTradeVolume` endpoint, authenticated with a Spot API key. That endpoint supports derivatives identifiers using the `{asset, aclass}` form, including `aclass: "derivatives"`. [R3], [R4]

The fee service must obtain **contract-specific account fees** and reconcile them against actual fills. Do not silently use old endpoints, spot trading rates, or library defaults.

### 1.3 Round-trip fee economics

For the applicable international Futures schedule, Kraken publishes a base tier of **0.02% maker and 0.05% taker** as of this document's preparation date. [R5]

The following fee-only round trips are approximate because entry and exit notionals can differ:

| Entry route | Exit route | Approximate fee-only round trip |
|---|---|---:|
| Maker | Maker | 4 basis points |
| Maker | Taker | 7 basis points |
| Taker | Taker | 10 basis points |

One basis point is:

$$
1\text{ bp}=0.01\%=0.0001.
$$

**Example:** A favorable move of 6 basis points on $10,000 notional produces approximately $6 gross profit. A maker-entry/taker-exit round trip costs approximately $7 in fees alone. The trade is already losing before additional execution costs.

**Catching smaller price changes is not necessarily an improvement.** An opportunity must be large enough, and sufficiently predictable, to pay for trading.

---

## 2. Use one authoritative profit calculation

Every component—entry evaluation, stops, recovery detection, profit protection, and reporting—must use the same accounting engine.

### 2.1 Net profit for a constant-size linear position

Define direction:

$$
d=
\begin{cases}
+1, & \text{long},\\
-1, & \text{short}.
\end{cases}
$$

Let:

| Symbol | Meaning |
|---|---|
| $Q$ | Positive base-asset-equivalent position quantity |
| $P_e$ | Actual entry price, or consistently aggregated fill price |
| $P_x$ | Expected executable exit price |
| $f_e$ | Entry fee rate as a decimal fraction of notional |
| $f_x$ | Exit fee rate as a decimal fraction of notional |
| $F$ | Signed funding cash flow; positive when received |
| $C$ | Other applicable costs not already included elsewhere |

Then:

$$
\Pi_{\text{net}}
=
dQ(P_x-P_e)
-f_eQP_e
-f_xQP_x
+F-C.
$$

**Do not subtract spread twice.** When $P_e$ and $P_x$ are actual or realistically simulated fills, their difference already contains spread crossing and execution-price effects.

The single-entry formula is the constant-size case. A lifecycle with multiple fills and partial exits must aggregate the actual cash flows, quantities, and fees consistently rather than assume the original quantity remains open.

### 2.2 Mark positions at estimated liquidation value

For a long, estimate selling the remaining quantity into bids. For a short, estimate buying it back from asks:

$$
P_x=
\begin{cases}
\operatorname{VWAP}_{\text{bids}}(Q), & d=+1,\\
\operatorname{VWAP}_{\text{asks}}(Q), & d=-1.
\end{cases}
$$

Apply an additional adverse-execution reserve for latency and disappearing liquidity, without duplicating costs already embedded in the book-walk price.

Define:

$$
L_t
=
\text{estimated net lifecycle profit if the remaining position were closed now}.
$$

For partial exits, $L_t$ includes realized profit, all fees already incurred, accrued funding, and the estimated liquidation value of the remainder.

Kraken's linear perpetual documentation describes funding as accruing continuously while the position is open. Do not model it as zero merely because the position closes before an hourly settlement. [R6]

### 2.3 Calculate the actual profit-protection execution price

For a target net profit $G$, solving the net-profit equation gives:

$$
P_G^{\text{long}}
=
\frac{
P_e(1+f_e)+(G+C-F)/Q
}{
1-f_x
}.
$$

For a short:

$$
P_G^{\text{short}}
=
\frac{
P_e(1-f_e)-(G+C-F)/Q
}{
1+f_x
}.
$$

Setting $G=0$ gives the fee-adjusted break-even execution price.

**A stop at the entry price is generally not a break-even stop.**

These are required **execution prices**, not guaranteed stop-trigger prices. A trigger needs a buffer for execution slippage and for differences between its reference price and executable bids or asks. Recompute the required price from the remaining-position ledger after partial exits.

---

## 3. Why exit mathematics alone does not create an edge

Consider a simplified strategy with three quantities measured in basis points:

| Symbol | Meaning |
|---|---|
| $W$ | Gross profit on a winner |
| $D$ | Positive magnitude of gross loss on a loser |
| $c$ | Round-trip trading cost |
| $p$ | Probability of winning |

Then:

$$
\mathbb{E}[R_{\text{net}}]
=
pW-(1-p)D-c.
$$

Positive expectancy requires:

$$
\boxed{
p>\frac{D+c}{W+D}
}.
$$

### 3.1 Numerical example

Let:

$$
W=50,\qquad D=30,\qquad c=9.
$$

The required win probability is:

$$
p>\frac{30+9}{50+30}=48.75\%.
$$

At $p=55\%$:

$$
0.55(50)-0.45(30)-9=5\text{ bps}.
$$

At $p=48\%$:

$$
0.48(50)-0.52(30)-9=-0.6\text{ bps}.
$$

Simply increasing the profit target does not solve this problem: the probability of reaching the target also changes.

### 3.2 Why target/stop geometry does not manufacture an advantage

As an illustrative mathematical check, consider an idealized driftless Brownian price-change process, starting at zero and stopped at either a fixed upper barrier $+W$ or lower barrier $-D$, without a time limit. Its upper-barrier hitting probability is:

$$
p=\frac{D}{W+D}.
$$

Substitution gives:

$$
\mathbb{E}[R_{\text{net}}]=-c.
$$

This is not a claim that BTC or ETH follows this model. It demonstrates that **changing profit-target and stop-loss geometry does not itself create a predictive advantage**.

Entry research must establish the advantage. Order management must preserve as much of it as possible.

---

## 4. System architecture

Separate signals, economics, execution, and safety:

```text
Kraken public/private streams
              |
              v
Timestamp validation + book reconstruction + account reconciliation
              |
              v
Causal feature calculations
              |
              v
Deterministic setup state machines
              |
              v
Setup-specific, execution-specific expectancy evaluation
              |
              v
Position sizing + portfolio risk checks
              |
              v
Order lifecycle controller
              |
              v
Net-P&L hold/exit controller
              |
              v
Independent safety supervisor + immutable audit log
```

### 4.1 Default runtime

The default runtime does not need an LLM or neural network. Entry rules can be deterministic, with fixed, versioned statistical tables calibrated offline.

Use different timescales for different jobs:

| Function | Initial research setting |
|---|---|
| Market-data processing | Every relevant event |
| Return and volatility samples | 1 second |
| Entry-timing features | 1–10 seconds |
| Setup context | 1–5 minutes |
| Candidate holding horizons | 1, 3, 10, and 30 minutes |
| Risk and order reconciliation | Event-driven plus watchdog |

These are engineering starting points, not profitable parameters established for the account.

**Fast execution should help trade a worthwhile move. It should not force the strategy to scalp moves smaller than its costs.**

---

## 5. Entry features

Measure price movement and actual order flow rather than stacking numerous overlapping indicators.

### 5.1 Causal returns and volatility

Using midprice $m_t$:

$$
x_t=\log m_t.
$$

Define:

$$
r_t=10^4(x_t-x_{t-1}).
$$

On one-second samples, $r_t$ is a one-second log return in basis points.

A simple causal volatility estimator is:

$$
\sigma_t^2
=
(1-\alpha)\sigma_{t-1}^2
+
\alpha(r_t-\widehat{\mu}_{t-1})^2.
$$

Here $\widehat{\mu}_{t-1}$ is a return-mean estimate available before the current observation. Use only previously available information in normalization and calibration.

### 5.2 Sequential shift detection instead of raw acceleration

Raw second differences amplify small price fluctuations. For a deterministic change detector, define:

$$
z_t=\frac{r_t}{\sigma_{t-1}+\epsilon}.
$$

Maintain upward and downward cumulative statistics:

$$
U_t=\max(0,U_{t-1}+z_t-k),
$$

$$
D_t=\max(0,D_{t-1}-z_t-k).
$$

Here $D_t$ is the downward detector statistic, distinct from the fixed gross-loss magnitude $D$ in Section 3. The positive $\epsilon$ protects the normalization from division by zero; $k$ is the detector's allowance parameter.

Threshold crossings create events:

$$
U_t>h
\quad\Rightarrow\quad
\text{upward-shift candidate},
$$

$$
D_t>h
\quad\Rightarrow\quad
\text{downward-shift candidate}.
$$

Calibrate $k$ and $h$ on training data, freeze them for validation, and require a reset before another candidate. A threshold remaining exceeded must not fire repeatedly.

This is a **detector**, not proof of profitable continuation.

### 5.3 Aggressive trade imbalance

For a window $w$:

$$
TI_w
=
\frac{\sum_{j\in w}\epsilon_jv_j}
{\sum_{j\in w}v_j+\epsilon},
$$

where $v_j$ is trade volume and:

$$
\epsilon_j=
\begin{cases}
+1, & \text{aggressive buy},\\
-1, & \text{aggressive sell}.
\end{cases}
$$

Kraken's Futures trade feed identifies the taker side, so this sign can be derived directly rather than guessed from price changes. [R7]

### 5.4 Order-flow imbalance

Let $b_n$ and $a_n$ be best bid and ask prices; let $B_n$ and $A_n$ be their displayed quantities.

Define the event contribution:

$$
\begin{aligned}
e_n={}&
\mathbf{1}_{b_n\ge b_{n-1}}B_n
-\mathbf{1}_{b_n\le b_{n-1}}B_{n-1}\\
&-\mathbf{1}_{a_n\le a_{n-1}}A_n
+\mathbf{1}_{a_n\ge a_{n-1}}A_{n-1}.
\end{aligned}
$$

Then:

$$
OFI_w=\sum_{n\in w}e_n.
$$

Normalize by contemporaneous depth when comparing different liquidity conditions.

Order-flow imbalance has a research basis as a measure of short-horizon price impact. The foundational study cited here concerns US equities and largely contemporaneous price changes; it does **not** establish a profitable BTC/ETH forecasting strategy. That must be tested separately. [R8]

### 5.5 Trend efficiency

Define:

$$
ER_w=
\frac{|x_t-x_{t-w}|}
{\sum_{i=t-w+1}^{t}|x_i-x_{i-1}|+\epsilon}.
$$

Use this to distinguish relatively directional movement from back-and-forth movement.

Do not turn all these measurements into ten mandatory confirmation gates. Use a small number for candidate generation and the others for conditional evaluation.

---

## 6. Default entry strategy: breakout, pullback, reacceleration

Start with **one independently testable strategy**, not a collection of strategies that conceal each other's losses.

### 6.1 Long setup: Stage A — Detect the breakout

Compute the prior range high, excluding the current observation:

$$
B_t=\max_{u\in[t-W,t)}m_u.
$$

Here $W$ is a lookback duration, distinct from the gross winning return used in Section 3.

When price breaks above $B_t$, store a **frozen breakout level** $B$, the event time, and the market state. Require supporting aggressive-buy imbalance.

Do not let the reference breakout level move retrospectively after the setup has been created.

### 6.2 Long setup: Stage B — Wait for an orderly pullback

Arm the setup when price returns near the frozen level $B$, within a predeclared tolerance:

$$
\delta_t
=
\max\left(
2\,\text{spread}_t,
\;k_\delta m_t\frac{\widehat{v}_{\text{pullback}}}{10^4}
\right).
$$

In this expression, $\text{spread}_t$ is measured in price units, and $\widehat{v}_{\text{pullback}}$ is the estimated return standard deviation over the pullback horizon, in basis points.

Reject the setup if price breaks materially below $B-\delta_t$, data becomes invalid, or the setup expires.

### 6.3 Long setup: Stage C — Detect renewed buying

After the retest, generate a long candidate when price crosses the high of a short, previously observed interval and short-window aggressive flow turns positive.

An initial hypothesis might use a **three-second** reacceleration interval and:

$$
TI_3>0.15.
$$

These values require testing. They are not established trading advantages.

### 6.4 Long setup: Stage D — Evaluate economics and execute

A candidate is not an order. Submit only after the cost-aware evaluation in Section 7, position sizing in Section 8, and operational checks pass.

Mirror the logic for shorts: a downside breakout, a retest of the frozen level, and renewed selling.

### 6.5 Why use this structure?

This structure tests buying a resumption rather than automatically paying the spread at the most extended point of an initial burst. Whether it improves results on the actual Kraken contracts is an empirical question.

The sequential shift detector can supply a second candidate stream in **shadow mode**. Do not automatically combine every detector into one increasingly restrictive rule.

For a later range-reversal strategy, require an observable failed breakout and re-entry into the range—not merely a large price move or an overbought reading.

---

## 7. Policy-level expectancy and entry qualification

Replace a generic cost-quality score with the measured economics of the **complete policy**.

The question is not:

> Is predicted movement greater than some multiple of fees?

The question is:

> What is the distribution of net outcomes when this exact entry and exit policy runs from this state?

### 7.1 Define a policy alternative

For each candidate, evaluate a small, predeclared set of alternatives:

$$
a=(\text{direction},\text{entry route},\text{size},\text{stop},\text{exit policy},\text{horizon}).
$$

Let:

$$
Y(a)=\text{complete lifecycle net P\&L under alternative }a.
$$

This must include losses, timeouts, partial fills, fees, funding, and the actual exit rules.

### 7.2 Deterministic default: empirical lookup tables

Group historical candidates by a limited set of characteristics: symbol, setup type, broad volatility regime, broad flow condition, and execution route.

For a cell with $n$ observations, shrink its mean toward a broader parent group:

$$
\widehat{\mu}_{\text{shrunk}}
=
\frac{n}{n+\kappa}\overline{Y}_{\text{cell}}
+
\frac{\kappa}{n+\kappa}\overline{Y}_{\text{parent}}.
$$

The parameter $\kappa$ controls shrinkage toward the broader group. Sparse cells should not produce extreme confidence.

Estimate a lower confidence bound by resampling **blocks of time**, rather than pretending thousands of adjacent ticks are independent:

$$
LCB(a)
=
\operatorname{Quantile}_{0.05}
\left\{
\widehat{\mathbb{E}}^{\,*}[Y(a)]
\right\}.
$$

The starred estimate represents an estimate from a time-block bootstrap replicate.

### 7.3 Production decision

Choose:

$$
\boxed{
a^*=\arg\max_a LCB(a)
}
$$

subject to:

$$
LCB(a^*)>0
$$

and operational, liquidity, and loss-risk limits.

Multiple strategy searches also require an untouched final test. A positive confidence bound selected from hundreds of alternatives is not automatically credible.

### 7.4 Maker fills must be modeled conditionally

For a passive order canceled without fallback when unfilled:

$$
\mathbb{E}[Y_{\text{maker}}]
=
P(\text{fill})\,
\mathbb{E}[Y_{\text{maker}}\mid\text{fill}].
$$

This expression treats the unfilled branch as zero trading P&L and requires the filled branch to include partial-fill outcomes and their management costs.

The conditional expectation matters. A resting buy can fill precisely because price is falling.

A maker-then-taker fallback is a **different policy** with a different outcome distribution. Simulate the entire sequence, including late fills.

### 7.5 When every candidate fails the cost-quality test

Distinguish an implementation error from an absent economic opportunity.

Audit percentage/basis-point conversions, incorrect spot fees, duplicated costs, funding units, contract multipliers, and whether execution prices already include spread.

Also check whether the purported expected move is actually volatility or historical maximum favorable excursion. Neither is automatically an achievable expected profit.

Then test a longer horizon or a different execution route **with new evidence**. Do not simply lower the safety threshold until trades appear.

---

## 8. Position sizing and portfolio risk

Determine risk first and leverage second.

### 8.1 Planned risk per trade

For initial testing, use **0.10% of account equity as planned risk per trade** as a research starting point, not a validated optimum or an instruction to begin live trading.

Let:

$$
R_{\$}=Er,
$$

where $E$ is account equity and $r$ is the selected per-trade risk fraction.

### 8.2 Loss per unit at the planned stop

For a linear position with estimated entry $P_e$ and adverse stop execution $P_s$, approximate loss per unit as:

$$
\ell_{\text{unit}}
=
|P_e-P_s|
+f_eP_e+f_xP_s
+s_{\text{reserve}}
+f_{\text{funding,reserve}}.
$$

Here $s_{\text{reserve}}$ is an additional execution-loss reserve per base unit, and $f_{\text{funding,reserve}}$ is an adverse funding reserve per base unit, not a raw fee rate. Reserve terms must exclude costs already incorporated into $P_e$ or $P_s$.

Then:

$$
Q_{\text{risk}}=\frac{R_{\$}}{\ell_{\text{unit}}}.
$$

### 8.3 Apply quantity, liquidity, margin, and notional constraints

The order quantity is:

$$
Q=
\operatorname{roundDownToStep}
\left[
\min\left(
Q_{\text{risk}},
Q_{\text{liquidity}},
Q_{\text{margin}},
Q_{\text{notional}}
\right)
\right].
$$

Re-evaluate risk after rounding and with quantity-dependent execution costs. Skip a trade when the minimum permitted size exceeds the risk budget.

**Do not tighten the stop artificially just to obtain a larger position.** Set the invalidation distance first and reduce quantity to fit.

### 8.4 BTC/ETH portfolio exposure

Initially allow only one BTC-or-ETH position at a time. Later, estimate their covariance and stress simultaneous adverse moves before allowing both.

### 8.5 Proposed initial account controls

| Control | Starting setting to validate |
|---|---|
| Planned risk per trade | 0.10% of equity |
| Daily loss threshold | 0.50% of cash-flow-adjusted equity |
| Initial concurrent positions | One across BTC and ETH |
| Gross notional ceiling | At most 2× equity |
| Averaging down or martingale | Disabled |
| Re-entry | Requires a fresh setup event |
| Loss-limit breach | Stop entries and invoke the risk-reduction policy |

A stop or daily threshold is an intervention rule, **not a guaranteed maximum loss**.

---

## 9. Holding, recovery, profit protection, and exits

Use two layers: deterministic protection that is always active, and an optional, separately validated continuation-value estimator.

### 9.1 Layer A — Deterministic protection, always active

Let $R_0$ be the initial planned dollar risk and define the highest observed net liquidation profit:

$$
M_t=\max\left(0,\sup_{u\le t}L_u\right).
$$

Here $L_u$ is lifecycle net liquidation profit, not a mark-price-only unrealized gain.

#### Initial loss protection

Until profit protection activates, use the desired net-P&L exit floor:

$$
F_t=-R_0.
$$

The time-indexed $F_t$ denotes an exit floor; it is distinct from the signed funding cash flow $F$ in Section 2.

Exit earlier when the setup's structural invalidation occurs. A broken thesis does not need to consume the entire risk budget.

#### Profit-floor activation

Once:

$$
M_t\ge aR_0,
$$

activate:

$$
\boxed{
F_t=
\max\left(
F_{t-1},
G_{\min},
\rho M_t,
M_t-A_t
\right)
}.
$$

Define permitted giveback in dollars as:

$$
A_t
=
\max\left(
 a_{\min}R_0,
 k_A N_0\frac{\widehat{v}_t(h)}{10^4}
\right).
$$

Parameters and quantities:

| Symbol | Meaning |
|---|---|
| $a$ | Profit-floor activation multiple of initial risk |
| $G_{\min}$ | Minimum desired locked net profit after activation |
| $\rho$ | Fraction of peak net profit to retain; normally chosen between 0 and 1 |
| $a_{\min}$ | Minimum giveback allowance as a multiple of initial risk |
| $k_A$ | Volatility-based giveback multiplier |
| $N_0$ | Entry notional |
| $\widehat{v}_t(h)$ | Estimated return standard deviation over defined horizon $h$, in basis points |

For illustration—not an optimized recommendation—test:

$$
a=1,\qquad \rho=0.5,
$$

with volatility and minimum-profit parameters chosen before validation.

This creates a **monotone floor**. It may tighten, but it cannot loosen because volatility increased or the system became hopeful.

When:

$$
L_t\le F_t,
$$

initiate exit. If a newly calculated floor is already above the current executable liquidation profit, the condition calls for exit; it does not mean the higher floor can still be guaranteed.

A larger giveback permits more continuation but exposes more profit to reversal. A tighter floor protects more quickly but may truncate winners. This tradeoff cannot be eliminated; it must be evaluated across many trades.

### 9.2 Recovery from an initially losing trade

Record maximum adverse excursion using net liquidation profit:

$$
MAE_t=\min_{u\le t}L_u.
$$

A proposed recovery rule is:

$$
MAE_t\le-0.5R_0
\quad\text{and subsequently}\quad
L_t\ge0.25R_0.
$$

Then raise the desired floor to at least **net break-even**, without lowering any stronger existing floor.

This is a risk preference to test, not evidence that a recovered trade has better or worse future returns.

Do not immediately close merely because a trade recovered, and do not permit a large renewed loss merely because it might continue. Evaluate the ongoing setup and enforce the revised protection.

### 9.3 Layer B — Optional continuation-value estimation

The advanced formulation is a finite-horizon optimal-stopping problem.

Let state $s_t$ include remaining quantity, current flow, volatility, position age, the profit floor, and other relevant information available at decision time:

$$
V_t(s)
=
\max\left[
L_t(s),
\mathbb{E}\left[V_{t+\Delta t}(S')\mid s\right]
-\lambda\mathcal{R}_t(s)
\right].
$$

Terminal condition:

$$
V_T(s)=L_T(s).
$$

The first alternative closes now. The second continues, accounting for future outcomes and an incremental risk penalty. Choose units for $\lambda\mathcal{R}_t(s)$ consistent with the dollar-valued objective.

**Already-paid entry fees are sunk costs.** They belong in total P&L, but must not be subtracted again when comparing holding with closing now.

Estimate continuation value offline using causal regression or empirical state tables. Keep this layer disabled until it improves on the deterministic baseline out of sample. The optional layer must not override mandatory protection or increase the original risk budget.

Never use future maximum favorable excursion as the holding value. That assumes the engine knows the future best exit.

### 9.4 Required behavior across important trade cases

| Position behavior | Controller response |
|---|---|
| Immediate adverse move; thesis invalid | Exit early rather than wait for recovery. |
| Initial loss; thesis intact | Hold only within the original risk and time limits. |
| Loss followed by genuine net recovery | Apply recovery protection and reassess continuation. |
| Immediate profit; continuation remains valid | Allow continuation behind the rising floor. |
| Profit followed by reversal | Exit on the floor or earlier invalidation. |
| Flat or stagnant trade | Exit at the prevalidated time limit. |
| Partial exit | Recalculate remaining risk, protection quantity, and lifecycle P&L. |
| Data or account state becomes uncertain | Block entries, reconcile, and preserve or reestablish protection. |

---

## 10. Kraken order lifecycle and failure handling

A mathematical exit rule is insufficient unless the actual order controller survives partial fills, delayed acknowledgments, cancel/fill races, and disconnects.

### 10.1 Exchange order semantics

Kraken's order API supports post-only and immediate-or-cancel orders, reduce-only orders, and stop triggers based on mark, index, or last price. Its `mkt` type is an IOC order with **1% price protection**; a stop without a limit price triggers a market order. [R9]

Consequently, **do not assume requesting a market exit guarantees complete liquidation**. Reconcile the resulting fills and residual exposure.

### 10.2 Serialized controller per instrument

Use a serialized controller per instrument:

```text
FLAT
  |
  v
ENTRY_PENDING
  |
  v
PARTIALLY_FILLED / PROTECTION_PENDING
  |
  v
OPEN_PROTECTED
  |
  v
EXIT_PENDING
  |
  v
RECONCILING
  |
  v
FLAT
```

The controller must also represent uncertain states such as:

```text
SUBMIT_UNKNOWN
CANCEL_PENDING
```

An order may be partially filled while the remaining entry quantity is still working. The state representation must track both actual position exposure and the outstanding order quantity; it must not hide either behind a single optimistic status.

### 10.3 Entry submission and idempotent intent handling

Persist a unique intent and client order identifier before submission. On timeout, reconcile before retrying.

Kraken provides status lookup using client order identifiers. Do not generate a new order merely because the first response was lost. [R10]

Select post-only execution only when its fill-conditioned expectancy is better. For time-sensitive opportunities, permit a price-capped IOC when its own cost-aware expectancy passes.

Bound passive-order lifetime, but do not blindly convert an expired maker attempt into a taker order. Maker-then-taker behavior must have its own tested policy outcome distribution.

### 10.4 Every fill requires protection

Protect actual filled quantity immediately; do not wait for the full intended size.

If protection is not acknowledged within a measured, predeclared deadline, cancel residual entry exposure and initiate the risk-reduction path.

There is an unavoidable operational interval between a fill and a separately submitted protective order. Measure and constrain that interval rather than assume it does not exist.

### 10.5 Exit and cancellation races

When closing, cancel residual entry orders and monitor for late fills.

Do not delay necessary risk reduction while waiting indefinitely for cancellation. Continue reconciliation until both exposure and order state are settled.

All closing orders should be reduce-only. Never allow a stale stop or take-profit from an old lifecycle to affect a new position.

Do not consider the lifecycle finished until the exchange confirms **zero exposure** and all associated orders are terminal.

### 10.6 Native stop amendments

Maintain the monotone floor in the application and verify the acknowledged exchange trigger.

Kraken notes that editing a trailing stop with unchanged deviation parameters recalculates its stop price. Therefore, an amendment must not be assumed to preserve the previous protection level. [R11]

Never assume a batch request provides an atomic bracket or one-cancels-the-other lifecycle unless that exact behavior is documented and tested for the selected route.

### 10.7 Dead-man's-switch trap

Kraken documents its dead-man's switch as canceling **all user orders** when its timer expires. It does not describe this operation as closing all positions. [R12]

Treat protective orders as potentially affected. Do not blindly arm account-wide cancellation while relying on those orders to protect an open position.

The deployment needs an explicit disconnect policy, an independent supervisor, and fault tests proving what remains protected.

---

## 11. Data quality and observability

Data quality is part of the strategy, not merely infrastructure maintenance.

### 11.1 Book validity

Kraken's Futures book feed contains snapshots, deltas, sequence numbers, and provider timestamps. Use them to validate and reconstruct the book. A connected WebSocket alone is insufficient evidence of valid market data. [R13]

### 11.2 Provider age and processing age

Record provider age:

$$
\operatorname{Age}_{\text{provider}}
=
t_{\text{receive,UTC}}-t_{\text{exchange}}.
$$

Record processing age using a monotonic clock:

$$
\operatorname{Age}_{\text{processing}}
=
t_{\text{decision,mono}}-t_{\text{receive,mono}}.
$$

Monitor clock synchronization separately. Provider-age calculations using wall-clock timestamps must not be confused with elapsed-time measurements using a monotonic clock.

A sequence gap, invalid book, excessive age, or uncertain private-account state must block new entries.

Do not fix stale data by raising its acceptable age during an incident.

### 11.3 Decision audit trail

For every decision, log the feature timestamp, book version, strategy version, fee version, expected outcome distribution, chosen route, risk reservation, order identifiers, and eventual fills.

This makes it possible to distinguish:

- Bad prediction or absent edge.
- Excessive fees or execution costs.
- Adverse maker fills.
- Late execution.
- Incorrect exit behavior or order-state handling.

The default system should remain auditable even without any model: deterministic rules, statistical table versions, and explicit state transitions must be recoverable from the recorded events.

---

## 12. Validation and deployment requirements

Prove an improvement before increasing exposure.

Repeatedly selecting whichever method looks best historically can create backtest overfitting. This is particularly relevant after trying many mathematical approaches. The cited literature explicitly studies the strategy-selection problem. [R14]

Require chronological evaluation with an untouched final period.

### 12.1 Execution realism

Replay quote and trade events with latency, spread, partial fills, fees, funding, and order-state races.

A candle touching a passive price must not automatically count as a fill. With aggregate book data, treat unknown queue position conservatively.

Use the same accounting conventions and order lifecycle semantics in research and production. A backtest with ideal fills cannot validate an implementation exposed to partial fills and uncertain acknowledgments.

### 12.2 Ablation tests

Compare identical entries under:

1. A fixed exit policy.
2. The deterministic profit-floor exit.
3. The optional continuation-value exit.

Separately compare timing rules and order routes. This identifies which component actually improves outcomes instead of attributing every change to the combined system.

### 12.3 Measure uncertainty, not just win rate

Report net expectancy with block-based confidence intervals, drawdown, tail losses, fill-conditioned markouts, and results by symbol, execution route, and regime.

For perspective, a crude independent-observation calculation is:

$$
n\approx
\left(
\frac{z\sigma_{\text{trade}}}{\mu_{\text{trade}}}
\right)^2.
$$

With a 2-basis-point mean, a 30-basis-point standard deviation, and a one-sided critical value $z=1.645$:

$$
n\approx
\left(\frac{1.645\times30}{2}\right)^2
\approx609.
$$

Dependence, nonstationarity, and searching many alternatives can require substantially more evidence. This approximation is not a sufficient deployment test by itself.

### 12.4 Failure tests

Inject dropped connections, delayed acknowledgments, duplicate events, cancel/fill races, partial stop fills, restarts with existing positions, and unavailable fee data.

Any failure that can create uncontrolled exposure blocks deployment.

### 12.5 Interpretation of a non-trading system

No trades can be the correct result when no tested policy has positive net expectancy at current costs.

A non-trading system should still explain its decisions through candidate counts, rejection reasons, fee assumptions, policy outcomes, and data-validity state. Diagnose whether the bottleneck is missing events, implementation errors, restrictive candidate rules, or truly negative economics before changing thresholds.

---

## 13. Implementation priorities

### Priority 1 — Correct contract-specific economics

Implement correct fee ingestion and one net-liquidation P&L ledger. Confirm the contract family, fee units, funding treatment, quantity conversion, and executable exit-price estimation.

### Priority 2 — Separate candidates from profitability evaluation

Replace the generic cost-quality score with measured outcomes for the complete entry, execution, and exit policy. Keep the strategy candidate state machine separate from the permission to submit an order.

### Priority 3 — Protect the real order lifecycle

Add partial-fill protection, unknown-submission reconciliation, cancel/fill race handling, reduce-only exits, and a monotone net-profit floor. Preserve the distinction between a desired P&L floor and what the market can actually execute.

### Priority 4 — Evaluate the default entry strategy

Test breakout–pullback–reacceleration against the current entries only after accounting and execution are trustworthy. Keep the sequential detector and continuation-value layer in shadow or offline evaluation until they demonstrate incremental value.

### Central design principle

> Discover an edge after costs, choose execution conditional on that edge, and manage the remaining opportunity under a non-loosening risk floor.

More sophisticated mathematics is useful only when it improves one of these measurable components—not when it merely causes more trades.

---

## 14. Sources

The following primary documentation and research references support exchange-specific facts and the cited research context. Strategy rules, illustrative mathematics, and proposed parameters are design choices or derivations, not claims of proven profitability.

| Reference | Source | Use in this design |
|---|---|---|
| [R1] | Kraken Developers — Get instruments | Contract metadata, types, tick size, contract size, precision, and margin information. |
| [R2] | Kraken Support — US Perpetual Futures | Distinction between US Bitnomial-listed products and other Kraken derivatives products. |
| [R3] | Kraken Developers — Get fee schedules | Deprecation notice effective June 22, 2026, and replacement fee-service guidance. |
| [R4] | Kraken Developers — Get Trade Volume | Account-specific fee lookup and derivatives asset classification. |
| [R5] | Kraken Support — Fees for Derivatives trading | Published international maker/taker fee schedule and cost context. |
| [R6] | Kraken Support — Linear Multi-Collateral Derivatives Contract Specifications | Funding accrual and linear contract specifications. |
| [R7] | Kraken Developers — Futures WebSocket Trade | Trade-event fields, including taker-side information. |
| [R8] | Cont, Kukanov, and Stoikov — The Price Impact of Order Book Events | Research basis and scope of order-flow imbalance. |
| [R9] | Kraken Developers — Send order | Order types, market-order protection, stop triggers, and reduce-only semantics. |
| [R10] | Kraken Developers — Get Specific Orders' Status | Reconciliation by exchange or client order identifiers. |
| [R11] | Kraken Developers — Edit order | Trailing-stop amendment behavior. |
| [R12] | Kraken Developers — Dead man's switch | Cancellation behavior and timeout mechanism. |
| [R13] | Kraken Developers — Futures WebSocket Book | Snapshot/delta order-book feed, sequence information, and timestamps. |
| [R14] | Bailey, Borwein, López de Prado, and Zhu — The Probability of Backtest Overfitting | Strategy selection and backtest-overfitting research. |

[R1]: https://docs.kraken.com/api-reference/instrument-details/get-instruments
[R2]: https://support.kraken.com/articles/us-perpetual-futures
[R3]: https://docs.kraken.com/api-reference/fee-schedules/get-fee-schedules
[R4]: https://docs.kraken.com/api-reference/account-data/get-trade-volume
[R5]: https://support.kraken.com/articles/360048917612-fee-schedule
[R6]: https://support.kraken.com/articles/4844359082772-linear-multi-collateral-derivatives-contract-specifications
[R7]: https://docs.kraken.com/exchange/api-reference/futures-websocket/trade
[R8]: https://arxiv.org/html/1011.6402v3
[R9]: https://docs.kraken.com/api-reference/order-management/send-order
[R10]: https://docs.kraken.com/api-reference/order-management/get-specific-orders-status
[R11]: https://docs.kraken.com/api-reference/order-management/edit-order
[R12]: https://docs.kraken.com/api-reference/order-management/dead-mans-switch
[R13]: https://docs.kraken.com/exchange/api-reference/futures-websocket/book
[R14]: https://scholarworks.wmich.edu/math_pubs/42/

---

**End of design.** This file is a complete consolidation of the preceding specification, not runnable trading software or evidence that the proposed strategy is profitable. No account data, live execution logs, or backtest results were supplied or analyzed to validate its proposed trading rules.
