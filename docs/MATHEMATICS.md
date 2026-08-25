# Mathematical implementation

This file maps the design mathematics to executable TypeScript. All prices used for fills are bid/ask or walked-book prices, never last-trade prices.

## Latency and stale data

`src/core/latency.ts` records feed, compute, send, acknowledgement, fill, and total latency and exposes p50/p90/p95/p99/max. Trigger features use short causal windows. Economic edge uses a separate configured horizon, so instantaneous acceleration is never linearly extrapolated over the full trade horizon.

Optional model-overlay modes additionally use `src/strategy/forecast.ts` and expire model output beyond its configured alpha half-life. `src/core/statistics.ts` uses a rolling robust provider-age gate:

```text
A_max = max(A_absolute, median(A) + 6 MAD(A))
```

Provider timestamps up to the configured 250 ms future-skew tolerance are clamped to zero age. A larger future lead, excessive positive age, timestamp reversal, missing reset, crossed book, kinematic gap reset, or stream/account uncertainty blocks entries. Operational diagnostics preserve the specific cause, including `EVENT_GAP` versus `FILTER_BOUNDS` kinematics resets, instead of collapsing every condition into a generic stale-data reason.

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

The structural gate has two independent entry families. The continuation family retains the aligned 5/15/60-minute trend requirements. The pullback/recovery family scans a causal four-hour path sampled every 30 seconds in order: a directional base precedes the structural extreme, the counter-extreme occurs after that structural extreme, and the current sample recovers after the counter-extreme. For direction `d`, best prior base `p_b`, structural extreme `p_s`, counter-extreme `p_c`, and current price `p_t` in log-price units:

```text
structuralMove_d = 10000 d (p_s - p_b)
pullbackDepth_d  = 10000 d (p_s - p_c)
recovery_d       = 10000 d (p_t - p_c)
remainingRoom_d  = 10000 d (p_s - p_t)
```

All four quantities must satisfy their configured structural bounds, and `recovery/pullbackDepth` must remain below the anti-chase fraction. The analytical pullback edge credits only still-unrealized room:

```text
grossPullback_d = min(maxGross, captureFraction quality remainingRoom_d)
uncertainty_d   = baseUncertainty + roomUncertaintyFraction (1-quality) remainingRoom_d
conservativeGross_d = max(0, grossPullback_d - uncertainty_d)
```

The prior trend, pullback depth, and already-realized recovery affect confirmation quality but are never counted as future profit. This family then passes through the same liquidity, health, exposure, maker-fill, robust-cost, exact-quantity, sizing, and portfolio gates as continuation. Calibration buckets include the family key so continuation returns cannot authorize pullback entries or vice versa.

For continuation, only the directional move simultaneously present in all three sampled trend windows is eligible for the analytical trend term:

```text
sustainedTrend_d = max(0, min(d trend5m, d trend15m, d trend60m))
trendContribution_d,H = trendCaptureFraction_H alignment_d sustainedTrend_d
```

The horizon-specific capture fraction is bounded by one. Slow-path efficiency still increases the uncertainty reserve when the path is noisy, but it is not multiplied into gross trend a second time. A continuation candidate whose spread is above the learned trade threshold may reach exact economics only when the spread remains below the learned stress threshold and staleness, spread-z, depth, and impact checks all pass; the observed spread remains fully charged by the robust-cost gate.

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

`src/strategy/cost.ts` adds every component once:

```text
C_roundTrip = spread + maker/taker fees + walked impact
            + latency loss + adverse selection + funding + borrow
```

For Alpaca spot, funding and borrow are zero. `src/strategy/deterministic-entry.ts` applies:

```text
fixedCost = entryFee + exitFee + funding + borrow
variableCost = entryExecution + exitExecution + impact + latency + adverseSelection
robustCost = fixedCost + max(1.75 variableCost,
                             variableCost + positiveCostErrorP95)
LCB_d = conservativeGross_d - robustCost
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

Fill probability uses `1-exp(-lambda TTL)` and a log hazard driven by aggressive volume versus queue ahead, flow, imbalance, and spread. The same actual TTL is used by both fill modeling and the resulting order plan. Continuation maker TTL cannot exceed half the configured micro-alpha half-life. The independent multi-hour pullback/recovery family instead uses `PULLBACK_MAKER_TTL_MS` (20 seconds by default), so micro-alpha expiry cannot force a structurally valid order to disappear before a plausible maker fill. Non-urgent exits selected by `MAKER_MAKER_TAKER_FALLBACK` rest at the ask for a bounded TTL; after cancellation is authoritatively reconciled, any remainder walks the bid and uses the worst walked price as an IOC limit cap. Hard-stop, data-invalid, recovery-no-edge, and profit-floor exits bypass the maker attempt.

The fallback path fixes the maker exit fee in the ledger and adds `(1-P_exitFill)` times the taker-minus-maker fee, half spread, and configured fallback adverse move to stressable variable cost. Exit completion therefore does not depend on an indefinite maker fill, and the economic gate does not pretend the fallback branch is free.

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

A resting pullback/recovery entry treats a single non-stale kinematics reset as temporary estimator unavailability. It remains eligible only until its normal TTL and only while structural signal, exact cost, flow, and book-health checks remain valid. `KINEMATICS_UNAVAILABLE` cancellation requires both `PULLBACK_KINEMATICS_GRACE_MS` elapsed and `PULLBACK_KINEMATICS_GRACE_EVENTS` consecutive reset events. TTL is evaluated first so cancellation telemetry reflects the binding cause.

A pending maker entry treats one opposing flow sensor as provisional. If either directional OFI is below `-2` or directional trade flow is below `-0.5`, cancellation requires both `ADVERSE_FLOW_CONFIRMATION_MS` elapsed and `ADVERSE_FLOW_CONFIRMATION_EVENTS` consecutive adverse observations. Simultaneously opposing OFI and trade flow are corroborated evidence and cancel immediately. A neutral observation clears the pending fault and emits recovery telemetry; TTL, stale-book, and exact-cost failures keep their existing priority.

Alpaca does not expose a dead-man switch, exchange checksum, or sequence in the documented crypto stream. The implementation cancels all orders on data/private-stream failure, invalidates the book, waits for a new `r=true` reset, reconciles account/orders/positions, recomputes risk, and only then clears operational halts.
