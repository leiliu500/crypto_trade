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

The structural gate has two independent entry families. The continuation family retains the aligned 5/15/60-minute trend requirements. The pullback/recovery family scans a causal four-hour path sampled every 30 seconds in order: a directional base precedes the structural extreme, the counter-extreme occurs after that structural extreme, and the current sample recovers after the counter-extreme. An explicitly enabled uncalibrated analytical paper pullback also requires an authorized directional regime, aligned and efficient 15-/60-minute trends in direction `d`, and a counter-extreme no older than the configured reversal-age bound; a sufficiently sampled calibrated bucket may identify a different profitable cohort. For direction `d`, best prior base `p_b`, structural extreme `p_s`, counter-extreme `p_c`, and current price `p_t` in log-price units:

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

For Kraken Futures paper trading, borrow is zero and funding uses the configured conservative reserve. `src/strategy/deterministic-entry.ts` applies:

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

The micro trigger arbitrates direction directly from bounded long/short scores; chop/unknown regime labels do not erase candidates or force risk sizing to zero. Liquidity is evaluated separately from prior spread observations, and the current spread is then observed even when no candidate exists. Kraken linear perpetuals support native long and short exposure; instrument metadata remains authoritative for tradeability and precision.

`src/execution/planner.ts` compares:

```text
EV_taker = notional LCB_taker / 10000

EV_maker = P_fill notional LCB_maker / 10000
         - (1-P_fill) opportunityCost
         - staleOrderCost
```

Both route values therefore use the exact route-specific lower-confidence edge after robust costs, not an unconditional forecast that ignores selection into maker fills. The continuation router constructs a full-size maker candidate and a 25%-size capped IOC candidate independently. The IOC is eligible only when all of the following hold:

```text
family = CONTINUATION
score >= 0.30
d OFI >= 0.50, d TFI >= 0.20, d QI_K >= 0.15
liquidityPass and not liquidityStress
latencySamples >= configured minimum
latencyP95 <= 0.25 alphaHalfLife
LCB_taker >= 8 bps
EV_taker/notional >= 1 bp
EV_taker/notional > EV_maker/notional
```

If any urgency condition fails, an independently valid maker candidate is retained; no trade is created when neither exact plan passes. Pullback/recovery never enters through this IOC route. Live-mode IOC activation is hard-disabled while paper, shadow, and replay collect evidence. Evidence modes use a zero-sample bootstrap so their first safe paper acknowledgment can create a latency observation instead of waiting for samples that only an order can produce; after that first observation the measured p95 gate applies. The disabled live route retains a floor of 20 observations.

Early breakout is a distinct cohort, not a weakened continuation gate. Its causal structure requires ready slow history, positive five-minute trend, bounded opposing 15-/60-minute drift and alignment, a fresh two-second extreme or aligned 500-millisecond impulse, aligned velocity, and a low flow-flip rate. Its analytical paper estimate uses slow sampled variance over a separate 30-minute horizon and is compared only with exact `TAKER_TAKER` cost. The IOC route additionally requires score `>= 0.35`, displacement `>= 0.05` bps, aligned velocity z-score `>= 0.25`, lower-confidence net edge `>= 8` bps, and per-notional expected value `>= 1` bp. It never converts an IOC rejection into a maker order. The analytical-paper multiplier and family multiplier compound to 2.5% of normal deterministic size, and live routing is hard-disabled.

Fill probability uses `1-exp(-lambda TTL)` and a log hazard driven by aggressive volume versus queue ahead, flow, imbalance, and spread. Its exposure interval is policy-aware: when one OFI/TFI sensor is already adverse it is capped at that entry family's adverse-flow confirmation time, and corroborated adverse OFI plus TFI assigns zero maker-fill probability because the order policy cancels immediately. This estimates the probability of filling before the engine's own cancellation rather than before the nominal order TTL. The checked-in hazard intercept is `-4.00`; the optimization report must still accumulate its full duration/sample requirement and ROC discrimination before treating the model as deployable calibration. Continuation maker TTL cannot exceed half the configured micro-alpha half-life. Its adverse-flow confirmation is bounded inside that TTL (100 milliseconds and two events by default); pullback/recovery uses its 20-second maker TTL and the slower two-second, three-event adverse confirmation. Each submitted plan also owns a wall-clock deadline timer, so TTL enforcement does not depend on another market event. A cancellation that occurs before POST acknowledgment is latched and executed once the authoritative venue order ID arrives. A profitable, cost-covered non-urgent exit may rest at the ask for the bounded five-second TTL; after cancellation is authoritatively reconciled, any remainder walks the bid and uses the worst walked price as an IOC limit cap. Losing/cost-uncovered exits and hard-risk, data-invalid, recovery-no-edge, and profit-floor exits bypass the maker attempt.

Every maker entry is qualified using a complete taker exit: full taker fee, half-spread crossing, and the configured fallback adverse reserve. A profitable position may opportunistically improve that cost with a bounded maker exit, but entry viability never depends on receiving it. Exit completion therefore does not depend on an indefinite maker fill, and forced evidence/risk exits are priced consistently with their actual IOC behavior.

Maker and taker are independent execution candidates. Each candidate iterates quantity, style-specific cost, deterministic LCB revalidation, and risk sizing to stability. Economic arbitration selects the strongest conservative post-cost edge across horizon and path. Because risk volatility is independently capped at the unproductive-exit horizon, choosing a stronger long-horizon edge does not widen the entry stop. A final candidate must also satisfy:

```text
entryRiskHorizon = min(selectedEconomicHorizon, unproductiveExitHorizon)
rewardRisk = conservativeNetEdgeBps / modeledMaximumLossBps >= 0.20
orderExpectedValueBps >= 0.25
```

A candidate that fails exact cost, reward/risk, expected value, or fill probability is discarded with a distinct audit reason. The 1/2/4-hour economic horizons retain enough trend scale to clear robust costs, while the independent 15-minute risk cap prevents those horizons from manufacturing multi-hour stops. This prevents a small positive forecast from authorizing a stop several times larger than the forecast and prevents a nominally cheap maker path from passing after calibrated no-fill opportunity costs make its order-level EV negative.

`src/execution/entry-route-shadow.ts` records the counterfactual without looking ahead. At decision time it freezes both exact plans and displayed maker queue ahead. Subsequent contra-side trades first consume that queue and only then fill the simulated maker; through-price trades clear the remaining queue. At each configured horizon each policy walks the then-current exit book at its own quantity. A missed maker fill contributes zero policy return, a partial fill scales its per-unit return by the filled fraction, and the taker uses its frozen walked entry VWAP. Fees and carrying reserves are deducted once. Stale books do not produce marks, and the report excludes a delayed mark rather than assigning a later observation to its earlier target horizon. `npm run optimize:report` also slices symbol, side, and family, excludes runs with missing or dropped health telemetry, and requires the configured sample span/count plus positive taker net return and a positive lower 95% confidence bound for taker minus maker before reporting the route as deployment-ready.

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

For Kraken long or short futures exposure:

```text
u = side (executableExitPrice - averageEntry)
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

It exits on hard risk, floor breach, stale data, or confirmed hold-engine exit evidence. The hold engine combines weak continuation, reversal quorum, and non-positive incremental edge with OR semantics; the position manager preserves that result rather than requiring both a negative edge and a reversal quorum. After the one-minute minimum hold, a no-progress loss at or beyond `minimumProgressR` (0.25 by default) exits as `EARLY_ADVERSE_STOP`; a position whose MFE never covers costs exits after the 15-minute unproductive stop. The separate early-breakout family uses a five-second minimum hold, one-second adverse-evidence confirmation, two-minute unproductive exit, and 30-minute maximum hold; its risk volatility is capped at the two-minute loss-control horizon. A loss that recovers past costs either exits when hold edge is gone or arms break-even permanently. A straight winner does not arm break-even until it covers both a meaningful fraction of risk and the configured cost multiple. Once armed it locks `lockMin` of maximum net profit; the full volatility trail still requires both the risk and cost thresholds, preventing one-cost-unit moves from being clipped into tiny winners. Reversal-dependent partial reductions remain allowed only when their modeled benefit exceeds extra costs.

## Order and failure state

`src/execution/order-state.ts` idempotently handles all private order events. Any partial fill immediately produces position exposure. An ambiguous send never triggers automatic retry; it becomes unknown state and forces reconciliation.

A resting pullback/recovery entry treats a single non-stale kinematics reset as temporary estimator unavailability. It remains eligible only until its normal TTL and only while structural signal, exact cost, flow, and book-health checks remain valid. `KINEMATICS_UNAVAILABLE` cancellation requires both `PULLBACK_KINEMATICS_GRACE_MS` elapsed and `PULLBACK_KINEMATICS_GRACE_EVENTS` consecutive reset events. TTL is evaluated first so cancellation telemetry reflects the binding cause.

A pending maker entry treats one opposing flow sensor as provisional. If either directional OFI is below `-2` or directional trade flow is below `-0.5`, cancellation requires both `ADVERSE_FLOW_CONFIRMATION_MS` elapsed and `ADVERSE_FLOW_CONFIRMATION_EVENTS` consecutive adverse observations. Simultaneously opposing OFI and trade flow are corroborated evidence and cancel immediately. A neutral observation clears the pending fault and emits recovery telemetry; TTL, stale-book, and exact-cost failures keep their existing priority.

The open-order endpoint is not authoritative evidence that an absent order was canceled: it may already be filled, rejected, or expired. Account reconciliation therefore performs an exact ID or client-ID lookup for every locally pending order missing from the open list before applying a terminal state. Failure to obtain that authoritative state keeps reconciliation unhealthy rather than guessing.

The Kraken feed supplies exchange sequences but no private dead-man switch is involved in the local simulator. The implementation cancels local orders on data/private-stream failure, invalidates the book, waits for a new snapshot, reconciles account/orders/positions, recomputes risk, and only then clears operational halts.
