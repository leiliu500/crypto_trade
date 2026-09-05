# Executable policy research and paper engine

## Why rebuild

The pre-rebuild audit contained 20 matched closed trades: 2 winners, mean net return -12.18 bps, gross price P&L -$0.2937 and fees $2.7183. Several forecast horizons were 30 minutes or four hours while actual holding periods were seconds. Those records are a diagnostic baseline, not enough evidence to infer a reliable profitable replacement.

The new path removes volatility-capture edge forecasts from automatic entry decisions. A price moving up and down does not establish that a causal entry can capture that move after executable spread, fees and exits. The objective is to test that proposition directly for BTC and ETH, on both sides.

## Declared hypotheses, not optimized claims

Signals use only contemporaneously available features. Trends require aligned fast/medium/slow moves and flow; breakouts require displacement, velocity and aligned flow; recovery requires an ordered pullback and recovery within the structural trend. The exact predicates and following policy menu are versioned in `trading-policy.ts`. Any changed rule or execution assumption requires a new `POLICY_VERSION`.

| Family | Policies / hard deadlines | Gross stop | Net target |
| --- | --- | --- | --- |
| Trend | 15 minutes / 30 minutes | 30 / 40 bps | 45 / 65 bps |
| Breakout | 1 minute / 3 minutes | 15 / 20 bps | 20 / 30 bps |
| Recovery | 5 minutes / 15 minutes | 20 / 30 bps | 30 / 45 bps |

These values define a small research menu. They have **not** been shown profitable on historical or future market data. Stop levels are triggers, not guaranteed maximum losses during gaps or illiquidity.

## Candidate collection and executable labels

Periodic research remains on a one-minute timer, before legacy score, cost, exposure and cooldown filters. Those counterfactuals carry `sampling=PERIODIC` and are diagnostic only. **Entry evaluation runs independently on every fresh executable quote**, so a 0.5–2 second breakout does not have to survive until a minute boundary. Trade-only feature updates cannot submit orders. Each attempt rechecks the current predicate, quote freshness, liquidity, sizing, portfolio and account risk; a rejection does not consume the 30-minute attempt cooldown. Successful dispatch eligibility does consume it before asynchronous submission, preventing duplicate entries.

Once a plan passes those checks, the collector records both declared exit variants of its family with `sampling=ENTRY`, using that decision's quote, timestamp and actual risk-sized quantity. The decision links to the selected observation. Entry capture never moves the periodic research timer, and insufficient label capacity fails closed. Starts are enqueued before dispatch; completion updates cannot overwrite a previously terminal record. Venue shortability, minimum quantities and increments apply.

`executable-policy-v2` separates this timing change from v1. Only v2 `ENTRY` labels can promote a model; neither periodic counterfactuals nor old/missing-source labels are pooled into entry evidence. Consequently uncalibrated shadow/record runs remain diagnostic: collecting periodic data alone does not authorize event-driven execution. Initial promotion requires fresh eligible paper-research attempts. Existing v1 positions retain their unchanged stop/target/deadline management.

Each counterfactual requests no more than $12 notional, caps IOC entry at the original executable ask/bid, and observes arrival after 250 ms. Late arrival beyond another 1,000 ms, quote gaps over five seconds, invalid books, disconnects, shutdown, or missing executable exit depth invalidate the observation. A timely IOC nonfill is a zero-return attempt; partial fills retain their exposure and returns are weighted by filled/requested quantity.

The collector evaluates the shared stop, net target and unconditional deadline against depth-walked exit prices. It observes the exit after an additional 250 ms and subtracts both per-leg fees, with the exit fee based on exit notional, plus the configured adverse-selection/funding/borrow/cost-error reserve. It does not add spread twice. Pending or invalid mature outcomes remain visible and block promotion in their cohort. Full raw quote/trade recording remains enabled in the Compose stack.

The current paper broker fills IOC orders immediately from its local book; the research collector's 250 ms delay is a separate stress assumption, not an exact fill-time replica. Entry labels now share the attempted quantity and decision quote; periodic fixed-notional counterfactuals remain separate. A rejected submission is still an attempted decision, and its counterfactual is not an actual trade result. Real paper outcomes must confirm the simulation. No live execution claim is made.

## Chronological evaluation

The UTC-day boundary fixes a rolling 14-day evidence window: seven days for training, 3.5 for policy selection, and 3.5 for final holdout. The longest policy horizon plus arrival, exit and quote-delay allowance is purged across boundaries and between retained samples. Both variants must have paired timestamps; duplicates, missing variants, bad arithmetic, mature pending labels, and telemetry-drop/exercise runs block approval. A bad observation can prevent promotion until it leaves the rolling window; this is intentional fail-closed behavior.

Policy selection uses validation returns only. The selected policy alone is judged on the final holdout; a failing winner is not replaced with a runner-up that happens to look better on holdout. Fitted mean returns use training and validation only. Three diagnostic walk-forward folds fit earlier means and compare subsequent realized means without overlapping labels.

Approval requires at least 100 non-overlapping observations, seven distinct observed UTC days and a seven-day sample span, at least 30 final-holdout observations, positive fitted/validation/holdout lower bounds and positive fold means. A first-to-last span is not claimed as continuous data coverage, and non-overlap alone does not prove statistical independence. The lower-bound calculation uses the larger of observation-level and day-block standard errors with a 1.96 multiplier; it is an approximate uncertainty screen, not a distribution-free guarantee or a correction for unlimited strategy searches.

Models are scoped by configuration, policy version, symbol, family, side, regime and costs. They expire at the next UTC midnight. Hourly refresh cannot shift intraday boundaries or prolong expiry. Refresh serializes database writes and replaces all models atomically, including removal when nothing passes. An evaluation error clears in-memory approvals. Current fee/reserve mismatch, expanded spread, or inadequate net edge after additional latency/impact reserves blocks calibrated execution.

## Paper execution and risk

`POLICY_ENGINE_ENABLED=true` is the default. It bypasses the legacy analytical entry path, but shares reconciliation, risk state, liquidity checks, portfolio limits, order-state tracking, persistence and the Kraken local paper broker.

In normal `ANALYTIC_PAPER` mode, missing calibration allows a declared rotation of small paper experiments: no more than $12 per order and one attempt per symbol per 30 minutes per engine process. Experiments have `edgeSource=UNRESOLVED`, `expectedValue=0`, no asserted positive net edge, and `researchOnly=true`. Experiment sizing uses an explicit notional budget in place of an invented Kelly edge; drawdown, risk budget, volatility, visible-book participation and venue limits still apply. Restart resets the in-memory experiment cooldown; it does not erase positions, pending-order reconciliation or session P&L.

`CALIBRATED_PAPER` suppresses unscored experiments. Passing models remain capped at $12 and marked research-only pending actual paper confirmation. There is no automatic live promotion or larger sizing.

Each policy position carries its policy identifier, version and cost basis through fills, snapshots and restart restoration. Shared policy exits do not use the old micro hold forecast. Legacy positions keep legacy management; unknown policy versions fail closed. Existing stale-book, order deadline, reconciliation and portfolio protections remain applicable.

## Operations

- `npm run research:policies -- --summary`: evaluate and persist this configuration.
- `npm run research:policies -- --no-save`: inspect without replacing models.
- `docker-compose exec -T engine npm run research:policies:production -- --summary`: deployed report.
- `policyObservation`, `policyEntryEvaluated`, and `policyResearchReady`: durable operational events.
- Market Pulse distinguishes fresh-quote entry checks from periodic research samples, shows liquidity reasons and current-quote plan failures, and retains quote/signal/rejection/approved-plan counters. Identical policy evaluation events are deduplicated for 30 seconds, but quote evaluation is never throttled by that telemetry limit.
- `policy_observations`, `policy_evaluations`, `policy_models`: dataset, audit reports and current approvals.
- `POLICY_ENGINE_ENABLED=false`: explicit legacy rollback; not a profitability improvement.

Migration 008 preserves legacy research history while revoking its authority to install fixed-markout calibrations. Synthetic rising/falling BTC/ETH tests exercise real paper submit/fill/close accounting with fees, but are not historical backtests. Profitability remains unproven until clean held-out market observations and subsequent paper trades demonstrate it.
