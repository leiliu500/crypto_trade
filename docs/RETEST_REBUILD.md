# Breakout–retest rebuild

This implements the deterministic paper-trading core of the supplied
[design](KRAKEN_REBUILD_DESIGN.md). It is an implementation and research result,
not evidence of profitable trading. Configuration is now
`btc-eth-breakout-retest-v10.1.0`, policy evidence `executable-policy-v3`, and
episode evidence `after-cost-episodes-v2`. Old evidence cannot install a new model.

## Default entry behavior

With `POLICY_ENGINE_ENABLED=true`, `BREAKOUT_RETEST_ENABLED` defaults to true.
The only submitting strategy is a symmetric breakout, frozen-level retest, then
reacceleration. The range covers one minute of one-second samples, excluding
the current quote. A breakout needs directional three-second aggressive-trade
imbalance above 0.15. Retest tolerance is the larger of two spreads and the
causal three-second volatility estimate at breakout. The level and invalidation
boundary remain fixed. Detector v2 requires a reversal from the breakout's
running extreme by at least one spread (frozen at breakout), within the retest
tolerance. Proximity during a continuing burst is insufficient. Reacceleration
must exceed the preceding three-second extreme after retesting and reclaim the
frozen level, with renewed directional trade flow. One spread is a declared
noise threshold, not a fitted profitability parameter. Setup volatility also
remains frozen at breakout; v1 inadvertently supplied entry-time volatility.

The setup expires after two minutes. Invalid books and quote gaps over five
seconds discard setup history. Trade snapshots, stale/future trade timestamps,
and duplicate trade IDs cannot provide confirmation. A setup produces at most
one candidate. The CUSUM detector uses previous variance for normalization and
emits shadow events only. The dashboard exposes setup phase and frozen level.

The four declared holding policies are 1, 3, 10 and 30 minutes, with a 30-bp
gross stop, structural invalidation, and net-profit protection. These constants
are hypotheses from the design; they were not tuned to turn the replay positive.

Existing `ANALYTIC_PAPER` permission remains available: qualifying unscored
experiments retain the $12 cap and 30-minute attempt spacing. Calibrated paper
requires an in-scope model with positive conservative return. Health, liquidity,
quantity increments, exposure, drawdown and portfolio checks remain mandatory.
`BREAKOUT_RETEST_ENABLED=false` is the explicit compatibility switch for old
candidate predicates; previously open old-policy positions retain their exits.

## One lifecycle ledger and protection

`net-liquidation.ts` records entry and exit notionals, actual fee cash flows,
remaining quantity, signed funding cash flows and other costs. It computes the
liquidation price by walking bids for longs or asks for shorts. It does not
subtract spread again. It also solves the net execution price for any desired
profit after partial exits.

New paper fills carry the actual simulator fee into the engine and persisted
activity history. Historical reconstruction prefers that immutable fee over
today's configured rate. Position snapshots retain the ledger and protection.

Initial net risk includes the fixed stop, both fee legs and configured reserve.
After a 1R net peak, the desired dollar floor is the maximum of its previous
value, 0.05R, half the peak, and peak minus allowed giveback. Giveback is at least
0.25R or twice the volatility allowance. After a -.5R adverse excursion and
recovery to +.25R, the floor rises to net break-even without automatically
closing. Floors never loosen; breach means initiate exit, not guaranteed fill.
The baseline uses the volatility estimate frozen at the setup. Updating the
allowance dynamically is a distinct future policy requiring paired validation.

The same protection equations run in paper positions, policy collection and
execution stress replay. Partial exits preserve lifecycle P&L. A missing or
inconsistent ledger triggers the uncertainty exit. Persisted exit intent stays
latched after restart. Without a saved protection state, historical fills can
rebuild accounting but cannot reconstruct an unseen peak: recovery requests exit.

Partial fills are evaluated immediately against the current usable book.
A reduce-only protective order can run while residual entry cancellation is
pending; another entry or competing closing order cannot. Cumulative fills are
deduplicated even when the venue repeats them under another event ID. Late fills
after a protective cancellation retain exit intent.

## Empirical policy tables

Models are scoped by symbol, setup/side, coarse volatility and flow condition,
policy, costs and configuration. Cell means shrink toward the same-symbol,
same-side parent group (kappa 20) using only the corresponding earlier period.
Confidence resamples whole UTC-day blocks with a reproducible 1,000-replicate
bootstrap. A profitable parent cannot conceal a negative cell. The conservative
bound also retains the existing day-clustered normal estimate.

The UTC-frozen train/selection/final-holdout split, purging, 100 independent
samples, seven observed days, 30 final-holdout samples, stable folds, clean
telemetry and expiry requirements remain. No positive model can be inferred
from a fitted mean alone. Optional continuation-value exits remain disabled.

## Exchange integration boundaries

Kraken's public instruments endpoint still supplies linear PF contract metadata.
Account fee lookup is available through `npm run fees:account`; the production
variant is `fees:account:production`. It uses a dedicated Spot key from
`KRAKEN_SPOT_FEE_API_KEY` and `KRAKEN_SPOT_FEE_API_SECRET` in the local environment,
the authenticated TradeVolume endpoint, and exact `{asset, aclass: derivatives}`
identifiers. Missing contract-specific rates fail rather than fall back to spot
fees. No credentials are needed or read by the default paper engine. The fee
inspector does not replace simulator rates or start live orders.

Paper plans explicitly carry `feeSource=PAPER_CONFIG` and
`fundingSource=RESERVE_ONLY`. The ledger supports signed funding cash and
continuous interval accrual, but no authenticated funding/account stream is
connected. `fundingEvidence=UNOBSERVED` is explicit; zero recorded funding is not
claimed to mean funding was zero. Replay includes the configured reserve, not
observed funding. Native exchange stops, protection acknowledgments, live fee
refresh, dead-man-switch handling and real-account reconciliation remain outside
the local paper adapter. Live order routing remains unavailable. Thus the full
live-exchange specification is not completed or validated by this rebuild.

Maker routes are not enabled by the new policy without route-specific evidence.
The initial paper experiment is price-capped IOC with taker/taker economics.
The existing legacy maker simulator remains available for separate research;
maker-route and continuation-value promotion are not claimed by this change.

Verified exchange references:
- [Fee endpoint deprecation](https://docs.kraken.com/api-reference/fee-schedules/get-fee-schedules)
- [Contract-specific TradeVolume](https://docs.kraken.com/api-reference/account-data/get-trade-volume)
- [Continuous funding specification](https://support.kraken.com/articles/4844359082772-linear-multi-collateral-derivatives-contract-specifications)

## Reproduce research

Validation: TypeScript build and all 308 tests pass. Tests include symmetric
paper entry/exit paths, fee and partial-fill accounting, monotone floors,
cancel-pending protection, and research/paper exit parity. These validate
implementation behavior, not market profitability.

```sh
npm run research:retest -- capture.jsonl.gz
npm run research:policies -- --summary --no-save
npm run research:episodes
npm run optimize:report
```

Retest replay discovers setups causally from raw events and pairs fixed versus
net-floor exits under the five declared execution stresses. Fixed control keeps
the same structural stop, gross stop and deadline, disabling only net-floor
updates. Current instrument increments and configured fees are explicit replay
assumptions. It is signal-conditional research, not a portfolio backtest.
Exit code 2 retains data gaps, missing paths and unfinished outcomes as failures.
Variants reuse market events and cannot count as independent trades.

The archived September 4 recording contained 175,102 events over approximately
95 minutes, 68 setups, three gaps and zero invalid reconstructed books. Every
base-scenario completed cohort had negative mean net return; none of those
filled outcomes was profitable. Floors and fixed exits matched in that sample
because the profit floors never activated. The gaps and unfinished cases also
prevent validation. See [raw results](../reports/retest-replay-2026-09-05.json).

The rebuild supplies a causal entry and lifecycle implementation, but historical
profitability remains unproven. Do not reinterpret a zero-trade result, synthetic
test profit, or missing outcomes as a profitable strategy.
