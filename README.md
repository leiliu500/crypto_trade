# Multi-venue minimal-latency crypto engine

A TypeScript research and paper-trading engine. The default strategy layer reconstructs Kraken's linear perpetual-futures L2 book, evaluates separate causal long/short trend, breakout, and recovery policies, and uses empirically measured executable policy returns. Its risk, order lifecycle, telemetry, and local paper broker remain shared with the legacy engine.

It does **not** promise profit or zero latency. The checked-in `.env.example` selects the Kraken Futures adapter and starts in shadow mode; `npm run paper` enables its local paper broker. Kraken market data is production public data, while orders, fills, balances, and positions remain strictly local. Kraken live order routing is intentionally unavailable.

## Rebuilt default strategy layer

`POLICY_ENGINE_ENABLED=true` replaces the legacy volatility-capture forecasts and micro-driven exits. The same versioned entry predicates and stop/target/deadline rules drive research and paper positions. V2 checks entries on every fresh quote, independently of the periodic research timer, and calibrates only separately tagged entry-timed evidence. Existing risk and liquidity limits remain mandatory. See [policy design and validation](docs/POLICY_REBUILD.md).

```text
fresh quotes + causal features -> independent policy observations
                              -> daily purged train / validation / final holdout
                              -> scoped, expiring empirical model
healthy signal + risk limits  -> capped paper IOC -> shared policy exits
```

Paper execution remains available without a promoted model: the existing `ANALYTIC_PAPER` permission now authorizes explicitly **unscored policy experiments**, not manufactured positive-edge forecasts. They are capped at $12 per entry and one attempt per symbol per 30 minutes while the engine is running; all health, drawdown, liquidity, lot-size, and portfolio controls remain active. `CALIBRATED_PAPER` permits only passing empirical models. No automatic live trading or size escalation is implemented. Synthetic test profits verify accounting, not market profitability.

Run `npm run research:policies -- --summary` for the current report. Migration `008_policy_research` stores candidate starts, terminal outcomes, evaluation audits, and approved models. Startup and hourly refresh replace the complete model set; UTC-day evidence boundaries and model expiry stay fixed within the day. Missing outcomes and unclean telemetry fail promotion. Legacy `research:calibrate` is diagnostic-only and no longer installs markout buckets into the active strategy.

After-cost research now has a separate, non-trading episode stream. It compares
the current breakout trigger with sustained five-/fifteen-minute range breaks,
captures distinct eligible signals during execution cooldowns, and tests paired
exits under latency, fee, and depth stress. Use `npm run research:episodes` and
`npm run research:replay -- recording.jsonl.gz`; add `--require-qualified` to fail
when evidence does not qualify. These read-only reports never promote a model or
change order sizing. See [after-cost research](docs/AFTER_COST_RESEARCH.md).

## Legacy engine and diagnostic compatibility

The following legacy signal and routing descriptions apply to `POLICY_ENGINE_ENABLED=false` and the explicit paper lifecycle/exercise tools, not the rebuilt default entry path. Existing positions without a policy identifier retain their original exit management.

The hot path is:

```text
Kraken Futures public WebSocket
  -> reset/delta L2 book validation
  -> causal microstructure + sampled 5/15/60-minute trend state
  -> prior-event adaptive microprice-noise threshold
  -> bounded micro/book/flow/motion score + mandatory motion quorum
  -> decayed occupancy/evidence + hysteresis + arm-anchored anti-chasing
  -> health/liquidity + venue/exposure/cooldown gates
  -> calibrated-or-analytic edge - uncertainty - exact walked cost
  -> anti-chasing + quantity-aware execution planning
  -> risk, correlation, and liquidity sizing
  -> lower-confidence-EV maker/IOC entry routing + bounded exit fallback
  -> Kraken paper: capped linear-perpetual order for native long or short exposure
  -> local paper acknowledgements/fills/cancels/reconciliation
  -> deterministic hold/reversal + recovery/time/profit-floor exits
```

The main contracts are:

- Candidate: a bounded directional score, two-of-three book/flow/motion quorum with motion mandatory, decayed occupancy, leaky evidence, confirmation time/events, arbitration, cooldown, and midpoint-at-arm chase limit must pass. A directional regime is still reported but cannot suppress a micro candidate.
- Entry: every health, dynamic-liquidity, venue, exposure, edge, cost, sizing, execution-plan, and portfolio gate must then pass. The final plan must also have positive lower-confidence order value and a conservative net-edge/maximum-loss ratio of at least `0.20`. Pullback/recovery stays maker-only. A continuation may use a reduced-size capped IOC only when its exact robust edge, lower-confidence EV, aligned OFI/TFI/book imbalance, liquidity state, and measured decision-to-venue latency all pass; otherwise the independently valid maker plan remains the fallback. Early breakout is a separate paper-research family: it requires fresh displacement and velocity with bounded opposing structural drift, qualifies only against exact taker/taker economics, and never falls back to maker. An uncalibrated analytical breakout additionally requires an agreeing directional regime before paper execution; neutral candidates remain in route shadow until their own calibrated cohort proves positive. Candidate sensitivity never bypasses order economics.
- Cost: `deterministic opportunity − uncertainty reserve − (exact fixed fees + stressed variable execution cost) >= minimum edge`. The `1.75` safety factor applies only to uncertain execution, impact, latency, and adverse-selection components; known venue fees remain exact. Every maker entry is qualified against a full taker exit. A later profitable maker exit is treated only as realized improvement and is never required for the entry to look economic.
- Horizon: microstructure selects entry timing. A bounded five-second sampler supplies causal 5/15/60-minute trend returns, slow efficiency, and slow realized variance. Continuation economics use 1/2/4-hour horizons and select the strongest conservative post-cost edge. Entry loss sizing caps that forecast volatility at the family's unproductive-exit horizon, so a long alpha horizon cannot widen the stop. Early-breakout research uses a separate 30-minute economic horizon and a two-minute no-progress exit. A separate 30-second sampler supplies the ordered four-hour state for 15-minute pullback/recovery entries.
- Entry families: continuation keeps its existing aligned 5/15/60-minute gate. Pullback/recovery separately requires a prior structural move, a fee-scale retracement, a confirmed rebound, retained trend, and unrecovered room. Early breakout requires ready structural history, positive fast trend, a new two-second extreme or aligned 500-millisecond impulse, aligned velocity, stable flow, and bounded opposing 15/60-minute drift. None of these families relaxes another family's thresholds.
- Trend warm-up: PostgreSQL first restores recent one-second mids into only the sampled slow-trend state. If that history is absent or stale after a clean restart, completed venue one-minute bars plus a current L2 midpoint provide the same causal structural bootstrap. Missing, future, invalid, crossed, or stale venue observations still fail closed; without usable history a process must observe at least 90% of the 60-minute window. Fast microstructure, CUSUM, and trigger state are never hydrated.
- State: one continuous episode produces at most one candidate. Re-arming requires release hysteresis or an excessive event-gap reset, and the configured cooldown must have elapsed.
- Models: `SIGNAL_MODE=DETERMINISTIC_ONLY` is the default. An optional model may only veto, rank, or reduce an already-valid deterministic intent; it cannot create exposure.
- Risk: `quantity × maximum modeled loss per unit <= current risk budget`.
- Protection: `profitFloor[t] >= profitFloor[t−1]`.
- Data: a stale, crossed, pre-reset, timestamp-reversed, or disconnected book cannot create exposure. A provider timestamp may lead the local clock by at most `MAX_PROVIDER_FUTURE_SKEW_MS` (250 ms by default); accepted leads are conservatively clamped to zero age. A gap beyond `MAX_KINEMATICS_GAP_MS` (5 seconds by default) resets only motion evidence for that event and does not mislabel otherwise valid data as stale. Telemetry distinguishes event-gap resets from bounded-filter resets.
- State: a send timeout is `UNKNOWN`; it is reconciled by account/orders/positions before another entry.
- Priority: existing exposure is managed before pending orders, and pending orders before new entries.

See [Mathematical implementation](docs/MATHEMATICS.md) for the formulas and their source modules.

## Kraken Futures paper trading

`TRADING_VENUE=kraken_futures` maps `BTC/USD` to `PF_XBTUSD` and `ETH/USD` to `PF_ETHUSD`. These are Kraken's linear perpetuals, so quantity and P&L remain denominated in base-asset units. Startup reads Kraken's public instruments catalogue and fails closed unless every configured product is tradeable, linear, and has valid price/quantity increments.

The public WebSocket subscribes to Kraken `book` and `trade` feeds. A snapshot is mandatory, every book delta must have the next exchange sequence, and a gap disconnects and invalidates the local book until a new snapshot arrives. Retrospective trade snapshots never advance causal features.

The paper broker is local-only and provides the normal order lifecycle: submit, acknowledge, IOC/GTC, cancel/cancel-all, partial fill, open-order reconciliation, long/short positions, reduce-only exits, fees, realized P&L, and mark-to-market equity. Account state is atomically persisted at `KRAKEN_PAPER_STATE_FILE`, including positions, cash/P&L, orders, and fills. On restart, positions and balances are restored; any order that was still resting is marked canceled because fills during downtime cannot be reconstructed safely. IOC fills walk the observed book subject to the order's limit. Resting maker fills require contra-side Kraken trades to consume simulated queue-ahead volume. This is deliberately conservative but cannot reproduce real queue identity, venue latency, margin liquidation, funding realization, API rejection, or outages.

No Kraken API key is read in this mode, and no Kraken private REST or WebSocket order method is called. A Kraken Pro browser sign-in is unrelated to the local simulator. Real-money order routing is not implemented.

## Execution constraints

Pullback/recovery entries remain non-marketable GTC limits. Continuations build independent maker and reduced-size IOC candidates before submission. Every submitted plan has an independent wall-clock deadline, so quiet market data cannot leave it resting past expiry. Cancellation intent is latched while an order send is in flight and is executed immediately after acknowledgment. Account reconciliation fetches the exact authoritative status of locally tracked orders missing from the open-order list instead of assuming they were canceled. Minimum size, quantity increment, and price increment come from Kraken Futures instrument metadata.

## Setup

Requires Node.js 20 or newer.

```powershell
npm install
Copy-Item .env.example .env
```

The CLI loads `.env` through Node's built-in environment-file support. For Kraken local paper trading, no exchange credential is required:

```powershell
$env:TRADING_VENUE = 'kraken_futures'
$env:TRADING_MODE = 'paper'
npm run paper
```

No exchange credentials are required. `.env` is ignored by Git.

Tunable parameters are JSON-backed:

- `config/base.json` contains the enabled symbol list and baseline parameter values.
- Files such as `config/btc_usd.json`, `config/doge_usd.json`, `config/eth_usd.json`, `config/link_usd.json`, `config/sol_usd.json`, and `config/xrp_usd.json` contain symbol-specific overrides. A symbol such as `XRP/USD` maps to `xrp_usd.json`.
- A symbol file only needs to include values that differ from the baseline. Its keys must already exist in `base.json`, and global dashboard/database parameters cannot be overridden per symbol.- `CONFIG_DIR` can select another configuration directory. JSON values take precedence over legacy tunable environment variables, so tuning has one source of truth.

Keep credentials and connection secrets out of all JSON files.

## Modes

| Mode | Behavior |
|---|---|
| `record` | Records public book/trade events to JSONL; no decisions or orders. |
| `replay` | Reconstructs and validates a recorded event stream. |
| `shadow` | Runs the full decision pipeline and emits plans without submitting them. |
| `paper` | Runs capped deterministic-rule orders through the selected paper adapter. Kraken orders remain local. |

Commands:

```powershell
npm run record
npm run replay
npm run recall
npm run report:rejected-entries
npm run shadow
npm run paper
npm run paper:demo-trade -- BTC/USD
npm run build
npm test
```

The default USD market universe is `BTC`, `ETH`, `LINK`, `SOL`, `XRP`, `DOGE`, `ADA`, `LTC`, `AVAX`, `HYPE`, and `PEPE`. Each pair must pass the same causal feature, liquidity, cost, risk, and maker-fill gates; expanding the universe does not relax entry economics.

The default deterministic configuration in `config/base.json` includes:

```text
SIGNAL_MODE=DETERMINISTIC_ONLY
DETERMINISTIC_CONFIG_VERSION=btc-eth-regime-confirmed-breakout-v9.7.0
PULLBACK_MAKER_TTL_MS=20000
PULLBACK_KINEMATICS_GRACE_MS=5000
PULLBACK_KINEMATICS_GRACE_EVENTS=2
CONTINUATION_SIGNAL_INVALIDATION_GRACE_MS=750
CONTINUATION_SIGNAL_INVALIDATION_GRACE_EVENTS=3
CONTINUATION_ADVERSE_FLOW_CONFIRMATION_MS=100
CONTINUATION_ADVERSE_FLOW_CONFIRMATION_EVENTS=2
ADVERSE_FLOW_CONFIRMATION_MS=2000
ADVERSE_FLOW_CONFIRMATION_EVENTS=3
MAKER_FILL_HAZARD_INTERCEPT=-4.00
RULE_MIN_MAKER_FILL_PROBABILITY=0.05
MAKER_MINIMUM_EXPECTED_VALUE_BPS=0.25
ENTRY_MINIMUM_REWARD_RISK_RATIO=0.20
CONTINUATION_TAKER_ENABLED=true
ANALYTIC_PAPER_SIZE_MULTIPLIER=0.10
CONTINUATION_TAKER_SIZE_MULTIPLIER=0.25
CONTINUATION_TAKER_MIN_SCORE=0.30
CONTINUATION_TAKER_MIN_NET_EDGE_BPS=8
CONTINUATION_TAKER_MIN_EXPECTED_VALUE_BPS=1
CONTINUATION_TAKER_MAX_LATENCY_HALF_LIFE_FRACTION=0.25
CONTINUATION_TAKER_MIN_LATENCY_SAMPLES=0
EARLY_BREAKOUT_TAKER_ENABLED=true
EARLY_BREAKOUT_TAKER_SIZE_MULTIPLIER=0.25
EARLY_BREAKOUT_TAKER_MIN_SCORE=0.35
EARLY_BREAKOUT_TAKER_MIN_NET_EDGE_BPS=8
EARLY_BREAKOUT_TAKER_MIN_EXPECTED_VALUE_BPS=1
EARLY_BREAKOUT_TAKER_MIN_BREAKOUT_BPS=0.05
EARLY_BREAKOUT_TAKER_MIN_VELOCITY_Z=0.25
ENTRY_ROUTE_SHADOW_ENABLED=true
ENTRY_ROUTE_SHADOW_HORIZONS_MS=1000,5000,30000,60000,300000,900000,1800000,3600000,7200000,14400000
RULE_PULLBACK_HORIZON_MS=900000
POSITION_MINIMUM_HOLD_MS=60000
POSITION_UNPRODUCTIVE_EXIT_MS=900000
BREAKOUT_POSITION_MINIMUM_HOLD_MS=5000
BREAKOUT_POSITION_UNPRODUCTIVE_EXIT_MS=120000
BREAKOUT_POSITION_MAXIMUM_HOLD_MS=1800000
```

Continuation economics are evaluated over 1-, 2-, and 4-hour horizons, with the strongest conservative post-cost edge selected. Entry loss sizing is independently capped at the 15-minute unproductive-exit horizon, so a long trend forecast cannot create a four-hour stop. This preserves enough horizon for conservative edge to clear costs while still rejecting entries below the order-EV and reward/risk floors.

The zero latency-sample floor lets the first paper acknowledgment bootstrap measurement. Once any sample exists, its observed p95 must still fit the alpha budget.

Normal paper mode defaults to `ANALYTIC_PAPER`, so qualifying analytical continuation, maker-only pullback, and IOC-only early-breakout signals may submit, fill, manage, and exit simulated orders. These uncalibrated orders are marked `researchOnly`, sized by `ANALYTIC_PAPER_SIZE_MULTIPLIER=0.10`, and cannot authorize deployment. The additional early-breakout multiplier limits those paper positions to 2.5% of normal deterministic size. Analytical pullbacks additionally require an authorized directional regime, aligned and efficient 15-/60-minute trends, and a reversal extreme no older than `RULE_PULLBACK_MAX_REVERSAL_AGE_MS`. `CALIBRATED_PAPER` remains available as an explicit fail-closed mode. Plans and persisted order cards carry configuration, regime, evidence source, research status, conservative edge/EV, reward-risk, and the selected economic horizon so outcomes cannot be pooled across incompatible policies.

Every route-shadow decision is also normalized into durable `alpha_signals` and `alpha_markouts` tables. The records include the executable signal bid/ask, mark bid/ask, feature snapshot, predicted edge and cost, modeled maker fill, and post-cost maker/taker markouts. Continuation, early-breakout, and pullback/recovery remain separate trend, breakout, and mean-reversion classes. Migration `007_alpha_research` backfills compatible historical route-shadow telemetry, so research does not depend on a non-empty repository replay file.

Run `npm run research:calibrate -- --summary` to audit legacy markouts, or add `--all-versions` to audit each version separately. `npm run research:export -- --all-versions` emits these observations as JSONL. These fixed-horizon markouts do not reproduce actual exit management: migration 008 revokes their promotions, the diagnostic CLI saves no approved buckets, and startup no longer loads them. Use `research:policies` for the rebuilt evaluator.

`record` appends raw order-book and trade events to `data/events.jsonl`. Paper and shadow modes also continuously append independently compressed gzip batches to `data/continuous-events.jsonl.gz` when `CONTINUOUS_RECORDING_ENABLED` is true. The batched writer keeps compression off the market-data hot path and makes completed batches replayable while the engine remains online. Run `npm run recall -- data/continuous-events.jsonl.gz` to analyze one capture, or pass archived and active files in chronological order to accumulate coverage across restarts: `npm run recall -- data/continuous-events.ARCHIVE.jsonl.gz data/continuous-events.jsonl.gz`.

`recall` reconstructs the same causal features, adaptive micro trigger, occupancy/evidence state, cost, and deterministic-entry pipeline, then labels the best executable move available over the configured future horizon. It reports opportunity recall, signal precision, family-specific pullback and early-breakout outcomes, gate-block frequencies, and non-finite feature incidents. Kraken Futures runs treat long and native-short signals symmetrically in acceptance and calibration; venues without native crypto shorts retain the short side as audit-only. Labels deduct two taker fees plus fixed costs but omit latency and impact, so the result is an optimistic upper bound rather than a profit claim.

For BTC and ETH maker entries, a zero-fill TTL expiry may re-open exactly one candidate slot in the same continuous signal episode. The retry remains maker-only and must pass current direction authorization, anti-chase, liquidity, exposure, risk sizing, and exact-cost validation again. Signal-, cost-, adverse-flow-, and stale-data cancellations never arm this retry. A partially filled entry keeps its resting remainder only through the original TTL while position protection remains active; it never receives an additional episode retry.

`paper:demo-trade` is an explicit diagnostic path for the selected paper order lifecycle. It waits for a healthy warmed book, submits one approximately $11 `BTC/USD` capped IOC entry by default, and records reserve, send, acknowledgment, private updates, fills, position management, and any strategy-managed exit in the normal dashboard and database. It is hard-disabled outside paper mode, refuses existing exposure or pending orders, caps entry notional at $25, and labels the decision `PAPER_LIFECYCLE_DEMO` because it intentionally bypasses strategy gates. Stop the normal engine before using it because both commands bind the same dashboard port.

For repeated strategy-pipeline exercise in a paper account, `PAPER_ENTRY_EXERCISE=true` is an explicit non-economic mode. It retains signal, liquidity, exposure, sizing, portfolio, and order-lifecycle controls, but uses zero simulated fees, latency reserve, adverse-selection reserve, positive cost error, and analytical signal-uncertainty reserve. It assumes full sigma/breakout capture, reduces the cost safety factor to `1`, the minimum net edge to `0`, requires IOC/taker entry planning, adds a 5 bps IOC limit-price protection buffer against quote movement during entry and exit submission, and caps each symbol at $25 notional. Startup and the dashboard label the run `EXERCISE`. The switch fails closed outside paper mode. Results from this mode are operational tests only and must never be interpreted as achievable performance.

Recall and tuning safeguards live in `config/base.json` under the `RECALL_*` parameters. The report refuses to authorize per-symbol tuning until it has both the minimum covered market-data duration and the minimum count of venue-eligible opportunity windows. Offline time between recorder segments is excluded from coverage, and any explicit recorder gap blocks tuning. The checked-in baseline requires seven covered days and 100 opportunities; shorter or incomplete captures are smoke tests only and must not be used to loosen trading gates.

No `MODEL_CONFIG_JSON` is read in this mode. `ENTRY_MODE=rules` remains a compatibility alias. The optional `DETERMINISTIC_WITH_MODEL_VETO` and `DETERMINISTIC_WITH_MODEL_RANKING` modes require a versioned `MODEL_CONFIG_JSON` and fail closed when it is absent. The router is structurally unable to turn a null deterministic intent into an order.

## AWS EC2 deployment with Docker Compose

The Compose stack builds and runs the trading engine and PostgreSQL together. The dashboard listens on port `3001`, PostgreSQL remains bound only to EC2 loopback, and named volumes preserve database and recorded event data across container replacements.

On an EC2 instance with Docker Engine and the Compose plugin installed:

```bash
cp .env.example .env
# Keep TRADING_MODE=shadow for the first run.
docker-compose up -d --build
docker-compose ps
docker-compose logs -f engine
```

Open `http://EC2_PUBLIC_IP:3001`. In the EC2 security group, allow inbound TCP port `3001` only from trusted operator IP addresses; do not expose PostgreSQL port `5433` publicly. The dashboard has no authentication, so use a private subnet, VPN, SSH tunnel, or an authenticated reverse proxy when source-IP restriction is insufficient.

The services use `restart: unless-stopped`, so they return after Docker starts following an instance reboot. Enable Docker itself at boot with the command appropriate for the EC2 image (for example, `sudo systemctl enable --now docker`). Deploy an updated checkout with `docker-compose up -d --build`; Compose replaces the engine container without deleting its named volumes. If your Docker installation provides Compose only as a CLI plugin, use `docker compose` in place of `docker-compose`.

Useful checks:

```bash
curl --fail http://127.0.0.1:3001/healthz
docker-compose exec engine node dist/src/database/verify-main.js
docker-compose exec engine node dist/src/database/smoke-main.js
```

Stop the stack with `docker-compose down`. This preserves named volumes; adding `--volumes` permanently removes the database and event-data volumes.

## Operations dashboard and PostgreSQL

The dashboard is enabled by default at `http://127.0.0.1:3001` for a local process, or `http://EC2_PUBLIC_IP:3001` for the Compose deployment. It shows execution-gate liveness, Kraken market and local paper-order stream state, reconciliation and book validity, micro score/phase/block reasons, occupancy, evidence, adaptive noise and movement threshold, arm-anchored chase, per-direction groups, gross opportunity, uncertainty, round-trip cost and lower-bound edge, risk halts, latency, hold/reversal exit dynamics, order fill progression, lifecycle timelines, and the operational audit stream. Its pipeline counters expose `MICRO_EVENT`, `MICRO_ARMED`, and `MICRO_CANDIDATE` separately from cost qualification and order sends. It is read-only, uses no third-party browser assets, and redacts credential-shaped event fields.

Start the PostgreSQL 16 service and validate its schema:

```powershell
docker-compose up -d postgres
npm run db:migrate
npm run db:verify
npm run db:smoke
```

The Compose service binds only to `127.0.0.1:5433` by default so it can coexist with a conventional local PostgreSQL instance on port 5432. Override `POSTGRES_PORT` and `DATABASE_URL` together if needed.

Engine modes start the dashboard and asynchronous database writer with the trading engine. Persistence is bounded and batched so PostgreSQL is never awaited on the strategy hot path. Set `DATABASE_REQUIRED` in `config/base.json` to `true` to make database availability a startup requirement; otherwise the engine continues while the dashboard reports degraded persistence. The named Docker volume `crypto_trade_postgres_data` preserves records across container restarts.

For a credential-free dashboard preview:

```powershell
npm run dashboard:demo
```

## Validation

The test suite enforces exact decimal conversion, reset/delta and duplicate behavior, crossed-book rejection, causal feature replay equality, slow-window warm-up and trend alignment, ordered pullback/recovery detection, fee-sized recovery economics, pullback maker-only routing, tightly gated continuation IOC routing, IOC-only early-breakout routing with no maker fallback, family-specific calibration, causal queue-ahead shadow fills, mandatory staleness/health gates, adaptive prior-noise decisions, independent evidence quorums, tiny persistent movement detection, spike rejection, opposing-evidence decay, event-gap reset, one candidate per episode, arm-anchored anti-chasing, long/short symmetry, inclusive exact-cost thresholds, model non-creation, deterministic hold/reversal, maximum-loss sizing, monotone floors, operational reconciliation, private-event idempotence, and non-retry of order POSTs.

The replay package includes event validation, opportunity-recall analysis, forward-return calibration candidates, profitable-after-robust-cost acceptance gates, arrival-time IOC/maker fill simulation primitives, chronological walk-forward fold construction with purge/embargo, conservative stress profiles, and reusable trade-metric calculations. Set `RECALL_REQUIRE_PROFITABLE_ENTRY=true` to make `npm run recall` exit nonzero unless a full replay contains at least one profitable venue-eligible intent; the legacy `RECALL_REQUIRE_PROFITABLE_LONG=true` gate remains long-specific. Continuation entries accept a same-side micro regime, or a neutral regime when the slower structural trend, strong micro-confirmation path, top-of-book pressure, and aggregate-book imbalance all agree; an explicitly opposite-side regime remains a hard block. In normal paper mode, analytical pullback/recovery signals may submit maker-only entries and early breakouts may submit reduced-size IOC-only entries so their actual local outcomes can be measured. Outside analytical paper, each family remains observation-only until a matching symbol, side, regime, and execution-path calibration bucket has the required effective samples. Calibration remains non-deployable until the configured duration and independent-sample requirements pass; short recordings and paper trades are evidence inputs, not automatic authorization for live trading.

Run `npm run optimize:report` against the configured PostgreSQL database to audit maker-fill calibration, realized net performance, causal entry-route shadows, and a read-only 10-minute unproductive-position exit counterfactual against the active 15-minute exit. Use `npm run optimize:report:production` in the compiled production container. Realized trades are matched back to their entry plan and grouped by configuration, symbol, side, family, regime, edge source, horizon, and research status; analytical/research trades can never make a cohort deployment-ready. The route shadow simulates displayed queue ahead from observed contra-side trades and marks each policy at its executable exit quantity at 1, 5, 30, and 60 seconds, 5 and 15 minutes, and 1, 2, and 4 hours; an unfilled maker scores zero and a partial fill is weighted by its fill fraction. A taker-only candidate remains valid profitability evidence and is compared with no trade instead of being discarded. Delayed marks beyond one second are excluded rather than relabeled as their target horizon. Deployment is assessed only at each signal's selected economic horizon and separately by configuration, symbol, side, family, regime, edge source, and horizon. The report excludes records from runs with dropped telemetry and does not authorize a parameter change until a cohort meets the same minimum tuning duration and effective-sample requirements. Maker-fill deployment additionally requires ROC AUC of at least 0.55, realized performance requires a positive lower 95% net-return bound, the timeout shadow requires a positive lower 95% confidence bound for its P&L improvement, and route deployment requires positive lower 95% confidence bounds for both absolute post-cost return and return versus the available maker policy or no-trade alternative. Real-money deployment remains outside this system.

Start with recorder → replay → shadow → paper. Do not scale paper assumptions into real capital without an independently reviewed live execution and risk system.
