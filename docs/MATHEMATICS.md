# Mathematical implementation

This file maps the design mathematics to executable TypeScript. All prices used for fills are bid/ask or walked-book prices, never last-trade prices.

## Latency and stale data

`src/core/latency.ts` records feed, compute, send, acknowledgement, fill, and total latency and exposes p50/p90/p95/p99/max. The deterministic opportunity horizon is:

```text
h = L_total,p95 + H
```

The default rule engine decays deterministic opportunity to arrival:

```text
gross_arrival = gross_observed exp(-L_p95 / tau_rule)
```

Optional model-overlay modes additionally use `src/strategy/forecast.ts` and expire model output beyond its configured alpha half-life. `src/core/statistics.ts` uses a rolling robust provider-age gate:

```text
A_max = max(A_absolute, median(A) + 6 MAD(A))
```

Negative age, excessive age, timestamp reversal, missing reset, crossed book, or stream/account uncertainty blocks entries.

## Causal microstructure features

`src/core/features.ts` implements:

```text
mid = (bestAsk + bestBid) / 2
spreadBps = 10000 (bestAsk - bestBid) / mid
QI1 = (bidQty - askQty) / (bidQty + askQty)
microprice = (askPx bidQty + bidPx askQty) / (askQty + bidQty)
QIK = (sum(w_i bidQty_i) - sum(w_i askQty_i)) / totalWeightedDepth
w_i = exp(-depthDecay i)
```

Persistence-adjusted depth multiplies each level by its observed age maturity and one minus cancellation hazard. OFI uses the four-indicator top-book equation from the design and real-time exponential decay. Aggressive flow is signed taker volume divided by total decayed volume. Bid/ask additions, cancellations, cancellation ratios, and replenishment rates are maintained separately.

The causal alpha-beta-gamma state estimates log-price velocity and acceleration. Variance is a time-aware EWMA of `return² / elapsedSeconds`, then:

```text
sigma_h = sqrt(varianceRate h)
z_micro = log(microprice / mid) / sigma_h
z_velocity = velocity h / sigma_h
z_acceleration = 0.5 acceleration h² / sigma_h
```

Directional efficiency is net log movement divided by path length. CUSUM maintains positive/negative normalized-return accumulators. No centered or future sample is used.

## Deterministic regimes, entry, and costs

`src/strategy/deterministic-features.ts` causally extends the base features with log-price impulse, a prior range that excludes the current event, anchor distance, CUSUM scores, alignment flip rate, usable depth, and replenishment pressure. `src/strategy/deterministic-regime.ts` applies liquidity-stress priority, directional breakout/trend votes, chop rejection, and separate reset thresholds for hysteresis.

For direction `d ∈ {−1,+1}`, entry requires independent quorums:

```text
bookVotes(d) >= 2       from microprice edge, QI1, QIK
flowVotes(d) >= 2       from OFI, TFI, replenishment
kinematicVotes(d) >= 2  from velocity, acceleration, impulse, breakout, CUSUM
efficiency >= threshold and flowFlipRate <= maximum
```

The fixed-weight score is an engineering rule, not a trained predictor:

```text
S_d = sum(w_i clip(d X_i / threshold_i, -1, 1)) / sum(w_i)
```

Raw quorum/score/health/liquidity/regime validity is persisted in event time:

```text
rho_d(t) = sum(deltaTime_i pass_i) / sum(deltaTime_i)
```

Occupancy, minimum consecutive time, and minimum event count must all pass. Long requires `S_long − S_short >= arbitrationMargin`; short is symmetric. A conflict produces no trade.

The model-free opportunity estimate combines bounded microprice, kinematic, flow, and impulse components at `h = L_p95 + holdHorizon`:

```text
grossDet_d = exp(-L_p95/ruleDecayTau) × quality
             × min(totalSigmaCap × sigma_h, weightedOpportunity_d)
```

Quality combines efficiency, persistence, and score above the reset threshold. The uncertainty reserve is the component median absolute deviation plus latency volatility, spread stress, flip-rate, and opposing-acceleration penalties.

`src/strategy/cost.ts` adds:

```text
C_roundTrip = spread + maker/taker fees + walked impact
            + latency loss + adverse selection + funding + borrow
```

For Alpaca spot, funding and borrow are zero. `src/strategy/deterministic-entry.ts` applies:

```text
LCB_d = grossDet_d - uncertaintyReserve_d - 1.75 roundTripBps(q)
```

The cost gate is run first at minimum quantity and again during every sizing iteration and final exact book walk. Equality with the configured minimum edge passes; a value below it fails. Anti-chasing independently caps price-versus-microprice chase, standardized impulse, and anchor distance. Exposure/pending-order gates plus the `IDLE → ARMED → COOLDOWN` state machine ensure one continuous signal produces at most one order and cannot re-arm until both cooldown and reset intervals pass.

`SIGNAL_MODE=DETERMINISTIC_ONLY` constructs no forecast engine and needs no model artifact. `src/strategy/signal-router.ts` accepts only an existing deterministic intent, so optional model veto/ranking modes cannot create a trade.

## Regime and execution

The deterministic regime permits only one direction. Liquidity stress and chop/unknown deny both directions. Alpaca's live Asset record is authoritative: because spot crypto is not shortable, a short regime remains observable but execution permission is forced false.

`src/execution/planner.ts` compares:

```text
EV_taker = notional (predictedGrossBps - takerCostBps) / 10000

EV_maker = P_fill notional (predictedGrossBps - makerCostBps) / 10000
         - (1-P_fill) opportunityCost
         - staleOrderCost
```

Fill probability uses `1-exp(-lambda TTL)` and a log hazard driven by aggressive volume versus queue ahead, flow, imbalance, and spread. Maker TTL cannot exceed half the configured alpha half-life. Takers and exits walk every visible price level and emit the worst walked price as an IOC limit cap.

Maker and taker are independent execution candidates. Each candidate iterates quantity, style-specific cost, deterministic LCB revalidation, and risk sizing to stability. A candidate that fails its exact cost gate is discarded without suppressing the other style; the surviving candidates are compared by expected value, subject to the maker fill-probability floor.

## Position and portfolio risk

`src/risk/sizing.ts` computes:

```text
B = equity baseRisk drawdownScale qualityScale volatilityScale regimeScale
lossPerUnit = initialStopDistance + exitCostPerUnit + jumpBuffer
q_risk = B / lossPerUnit
q_liquidity = participation visibleDepth
f_kelly = fractionalKelly clip(netMean / variance, 0, f_max)
```

Final quantity is the lot-rounded minimum of risk, liquidity, Kelly, notional, exchange, and portfolio exposure limits. Cost and size are iterated until stable. A runtime assertion verifies `q × lossPerUnit <= B`.

Drawdown scaling is `(1-DD/Dmax)²`; reaching `Dmax` is a non-operational halt that reconciliation cannot clear. `src/risk/portfolio.ts` computes `w' Sigma w`, marginal risk contribution, gross notional, cluster count, and stressed open loss. No averaging down is allowed.

## Position state and monotone floor

For Alpaca long spot exposure:

```text
u = executableBid - averageEntry
MFE = max(MFE, u)
MAE = max(MAE, -u)
```

`src/strategy/deterministic-hold.ts` calculates a fixed-weight continuation score, bounded hold opportunity, uncertainty, and five symmetric reversal votes (acceleration, OFI, TFI, replenishment, CUSUM). Exit evidence is true if continuation is weak, the reversal quorum passes, or incremental hold LCB is negative after expected delay/exit cost.

`src/strategy/position-manager.ts` then maintains:

```text
breakEvenFloor = roundTripCostPrice
lockFloor = costPrice + lockFraction max(0, MFE-costPrice)
volatilityFloor = MFE - volatilityMultiple sigmaPrice
F_t = max(F_{t-1}, -initialRisk, armed floors)
```

It exits on hard risk, floor breach, confirmed non-positive incremental hold edge plus reversal evidence, stale data, or no progress over the time stop. A loss that recovers past costs either exits when hold edge is gone or arms break-even permanently. Reversal-dependent partial reductions are allowed only when their modeled benefit exceeds extra costs.

## Order and failure state

`src/execution/order-state.ts` idempotently handles all Alpaca private events. Any partial fill immediately produces position exposure. A network/send timeout never triggers automatic POST retry; it becomes unknown state and forces REST reconciliation. GETs alone use bounded retries for 429/5xx.

Alpaca does not expose a dead-man switch, exchange checksum, or sequence in the documented crypto stream. The implementation cancels all orders on data/private-stream failure, invalidates the book, waits for a new `r=true` reset, reconciles account/orders/positions, recomputes risk, and only then clears operational halts.
