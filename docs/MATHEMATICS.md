# Mathematical implementation

This file maps the design mathematics to executable TypeScript. All prices used for fills are bid/ask or walked-book prices, never last-trade prices.

## Latency and stale data

`src/core/latency.ts` records feed, compute, send, acknowledgement, fill, and total latency and exposes p50/p90/p95/p99/max. Trigger features use short causal windows. Economic edge uses a separate configured horizon, so instantaneous acceleration is never linearly extrapolated over the full trade horizon.

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

`src/strategy/deterministic-features.ts` causally extends the base features with log-price impulse, a prior range that excludes the current event, anchor distance, CUSUM scores, alignment flip rate, usable depth, and replenishment pressure. `src/strategy/small-fraction-entry-trigger.ts` owns independent state for each symbol runtime: previous microprice, prior-event noise, occupancy, evidence, episode state, anchor, cooldown, and event counters.

The current event-to-event microprice movement and its causal threshold are:

```text
deltaMicroBps_t = 10000 log(microprice_t / microprice_(t-1))
sensorThreshold_t = max(minimumMicroMoveBps,
                        noiseMovementMultiplier * priorNoiseRms_t)
```

The current movement is evaluated against the noise estimate from prior events; only afterward is the time-aware EWMA square updated. Micropressure is `(microprice-mid)/(spread/2)`, clipped to `[-1,1]`.

For direction `d ∈ {−1,+1}`, candidate generation uses independent evidence groups:

```text
bookPass = micropressure or QIK passes
flowPass = OFI or TFI or replenishment passes
motionPass = adaptive delta-micro or velocity or breakout or CUSUM passes
quorum = at least two groups pass AND motionPass
```

The score is a bounded fixed-weight engineering rule, not a trained predictor. The seven nonnegative weights sum to one:

```text
S_d = d sum(w_i tanh(X_i / scale_i))
```

Weak support is accumulated with two event-time states:

```text
O_t = exp(-dt/tau_O) O_(t-1) + (1-exp(-dt/tau_O)) I(support)
A_t = max(0, exp(-dt/tau_A) A_(t-1)
             + dtSeconds (S_d - drift - opposingPenalty max(0,-S_d)))
```

Candidate firing requires quorum, arm score, minimum occupancy and evidence, confirmation time/events, cooldown, and chase distance from the midpoint captured when the episode armed. Strong scores use the shorter strong-confirmation thresholds. Release hysteresis resets an episode below `releaseScore`; a long event gap also resets it. One episode emits at most one candidate. Long/short arbitration is symmetric, and a conflict inside the configured margin produces no candidate. Regime classification remains diagnostic and may inform position analysis, but it is not a micro-candidate or sizing gate.

`src/strategy/deterministic-edge-resolver.ts` first requests calibrated edge when configured and falls back to a deterministic analytical estimate when calibration is absent. For economic horizon `H_E`:

```text
sigma_E,bps = 10000 sqrt(varianceRate H_E)
quality_d = clip(0.30 scoreQuality + 0.20 occupancy + 0.20 evidenceQuality
                 + 0.15 efficiency + 0.15 flowQuality, 0, 1)
grossDet_d = min(maxGrossBps,
                 sigmaCaptureFraction quality_d sigma_E,bps
                 + breakoutWeight breakoutBps_d)
```

The analytical uncertainty reserve contains a base reserve plus weak-quality volatility, spread, and flow-flip penalties. The edge source and horizon are included in gate diagnostics.

`src/strategy/cost.ts` adds:

```text
C_roundTrip = spread + maker/taker fees + walked impact
            + latency loss + adverse selection + funding + borrow
```

For Alpaca spot, funding and borrow are zero. `src/strategy/deterministic-entry.ts` applies:

```text
LCB_d = grossDet_d - uncertaintyReserve_d - 1.75 roundTripBps(q)
```

The cost gate is run first at minimum quantity and again during every sizing iteration and final exact book walk. Equality with the configured minimum edge passes; a value below it fails. The micro trigger's chase distance is measured from the midpoint at arm time, so a late candidate cannot use its current microprice as a moving anchor. Candidate detection is separate from health, liquidity, venue direction, exposure, economic edge, exact cost, size, execution plan, portfolio capacity, risk reservation, and send/acknowledgment lifecycle gates.

`SIGNAL_MODE=DETERMINISTIC_ONLY` constructs no forecast engine and needs no model artifact. `src/strategy/signal-router.ts` accepts only an existing deterministic intent, so optional model veto/ranking modes cannot create a trade.

## Direction and execution

The micro trigger arbitrates direction directly from bounded long/short scores; chop/unknown regime labels do not erase candidates or force risk sizing to zero. Liquidity is evaluated separately from prior spread observations, and the current spread is then observed even when no candidate exists. Alpaca's live Asset record is authoritative: because spot crypto is not shortable, a short candidate remains observable but execution permission is forced false.

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
B = equity baseRisk drawdownScale qualityScale volatilityScale
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
