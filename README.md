# Alpaca minimal-latency crypto engine

A production-oriented TypeScript implementation of the attached mathematical design. The engine reconstructs Alpaca's crypto L2 book, computes causal microstructure features on every event, and uses explicit deterministic entry, regime, cost, anti-chasing, persistence, reset, and exit rules. The default path does not construct or load a predictive model.

It does **not** promise profit or zero latency. `shadow` is the default. Paper mode requires paper credentials and `ALPACA_PAPER=true`; live mode remains protected by two explicit live-trading interlocks.

## Implemented system

The hot path is:

```text
Alpaca crypto WebSocket
  -> reset/delta L2 book validation
  -> causal microstructure + sampled 5/15/60-minute trend state
  -> prior-event adaptive microprice-noise threshold
  -> bounded micro/book/flow/motion score + mandatory motion quorum
  -> decayed occupancy/evidence + hysteresis + arm-anchored anti-chasing
  -> health/liquidity + venue/exposure/cooldown gates
  -> calibrated-or-analytic edge - uncertainty - exact walked cost
  -> anti-chasing + quantity-aware execution planning
  -> risk, correlation, and liquidity sizing
  -> maker-only entry planning (taker exits remain available)
  -> capped Alpaca limit order
  -> private trade_updates reconciliation
  -> deterministic hold/reversal + recovery/time/profit-floor exits
```

The main contracts are:

- Candidate: a bounded directional score, two-of-three book/flow/motion quorum with motion mandatory, decayed occupancy, leaky evidence, confirmation time/events, arbitration, cooldown, and midpoint-at-arm chase limit must pass. A directional regime is still reported but cannot suppress a micro candidate.
- Entry: every health, dynamic-liquidity, venue, exposure, edge, cost, sizing, execution-plan, and portfolio gate must then pass. Candidate sensitivity never bypasses order economics.
- Cost: `deterministic opportunity − uncertainty reserve − 1.75 × exact quantity-dependent round-trip cost >= minimum edge`.
- Horizon: microstructure selects entry timing, while a bounded five-second sampler supplies causal 5/15/60-minute trend returns, slow efficiency, and slow realized variance to the 1/2/4-hour economic horizons.
- Trend warm-up: new processes fail closed until at least 90% of the 60-minute slow window is observed. The dashboard reports `SLOW_TREND_WARMUP` and then `SLOW_TREND_GATE` when alignment is insufficient.
- State: one continuous episode produces at most one candidate. Re-arming requires release hysteresis or an excessive event-gap reset, and the configured cooldown must have elapsed.
- Models: `SIGNAL_MODE=DETERMINISTIC_ONLY` is the default. An optional model may only veto, rank, or reduce an already-valid deterministic intent; it cannot create exposure.
- Risk: `quantity × maximum modeled loss per unit <= current risk budget`.
- Protection: `profitFloor[t] >= profitFloor[t−1]`.
- Data: a stale, crossed, pre-reset, timestamp-reversed, or disconnected book cannot create exposure. A provider timestamp may lead the local clock by at most `MAX_PROVIDER_FUTURE_SKEW_MS` (250 ms by default); accepted leads are conservatively clamped to zero age. A gap beyond `MAX_KINEMATICS_GAP_MS` (5 seconds by default) resets only motion evidence for that event and does not mislabel otherwise valid data as stale.
- State: a send timeout is `UNKNOWN`; it is reconciled by account/orders/positions before another entry.
- Priority: existing exposure is managed before pending orders, and pending orders before new entries.

See [Mathematical implementation](docs/MATHEMATICS.md) for the formulas and their source modules.

## Alpaca API coverage

The implementation uses the current Alpaca Trading API and Crypto Data API directly:

- Trading resources: account, account configuration, account portfolio history, activities, assets, clock, order create/list/get/by-client-ID/replace/cancel/cancel-all, position list/get/close/close-all.
- Crypto latest data: order books, quotes, trades, bars, and snapshots.
- Crypto historical data: bars, quotes, and trades with page-token-capable query types.
- Public stream: trades, quotes, and order-book reset/deltas at `v1beta3/crypto/{loc}`.
- Private stream: all `trade_updates`, including new, partial fill, fill, cancel, expiry, replace, reject, pending, suspended, and uncommon states.
- Every trading response retains Alpaca's `X-Request-ID` for operational diagnosis.

Startup preflight reads all latest crypto resources, account configuration, and clock. Reconciliation reads account, dynamic asset precision, all open crypto orders, positions, and 24-hour portfolio history. REST market data is never awaited in the trading hot path.

Alpaca venue constraints are enforced:

- This engine trades Alpaca **spot crypto**. Assets currently report `shortable=false`, so deterministic short intents are evaluated symmetrically for audit/replay but cannot open short exposure.
- Alpaca crypto supports market, limit, and stop-limit orders with GTC/IOC. The strategy entry path is explicitly `MAKER_TAKER`: a non-marketable GTC entry followed by a taker-capable safety exit. Every final quantity is exact-cost revalidated, and a taker entry cannot silently replace an unfilled or uneconomic maker entry.
- There are no perpetuals, leverage, liquidation, funding, or native reduce-only flags on this venue. Funding/borrow are therefore zero, and exits are client-side clamped to the known long position.
- Alpaca's documented order-book schema exposes reset and price-level deltas, but no exchange sequence number or checksum. The engine requires a reset after connection, rejects timestamp reversal/crossed books/duplicates, and never misrepresents its local counter as an exchange sequence guarantee.
- Minimum size, quantity increment, and price increment come from the live Alpaca Assets resource rather than hard-coded symbol rules.

Official references: [real-time crypto data](https://docs.alpaca.markets/docs/real-time-crypto-pricing-data), [crypto trading](https://docs.alpaca.markets/docs/crypto-trading), [orders](https://docs.alpaca.markets/reference/postorder), and [trade updates](https://docs.alpaca.markets/docs/websocket-streaming).

## Setup

Requires Node.js 20 or newer.

```powershell
npm install
Copy-Item .env.example .env
```

The CLI loads `.env` through Node's built-in environment-file support. `.env` is reserved for credentials, endpoint safety controls, trading mode, live interlocks, and database connection values. You may also set those runtime values in the current shell before starting:

```powershell
$env:ALPACA_API_KEY = '<paper key>'
$env:ALPACA_API_SECRET = '<paper secret>'
$env:ALPACA_PAPER = 'true'
npm run shadow
```

The standard Alpaca names `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY` are also accepted. Secrets are never included in application logs. `.env` is ignored by Git.

Tunable parameters are JSON-backed:

- `config/base.json` contains the enabled symbol list and baseline parameter values.
- Files such as `config/btc_usd.json`, `config/doge_usd.json`, `config/eth_usd.json`, `config/link_usd.json`, `config/sol_usd.json`, and `config/xrp_usd.json` contain symbol-specific overrides. A symbol such as `XRP/USD` maps to `xrp_usd.json`.
- A symbol file only needs to include values that differ from the baseline. Its keys must already exist in `base.json`, and global dashboard/database parameters cannot be overridden per symbol.
- `CONFIG_DIR` can select another configuration directory. JSON values take precedence over legacy tunable environment variables, so tuning has one source of truth.

Keep credentials and connection secrets out of all JSON files.

## Modes

| Mode | Behavior |
|---|---|
| `record` | Records public book/trade events to JSONL; no decisions or orders. |
| `replay` | Reconstructs and validates a recorded event stream. |
| `shadow` | Runs the full decision pipeline and emits plans without submitting them. |
| `paper` | Submits capped deterministic-rule orders to Alpaca paper trading; no model file is required. |
| `live` | Real-money orders. Requires live credentials and both live interlocks. |

Commands:

```powershell
npm run record
npm run replay
npm run recall
npm run shadow
npm run paper
npm run paper:demo-trade -- BTC/USD
npm run build
npm test
```

The default deterministic configuration in `config/base.json` is:

```text
SIGNAL_MODE=DETERMINISTIC_ONLY
DETERMINISTIC_CONFIG_VERSION=deterministic-slow-trend-v2.0
```

`record` appends raw order-book and trade events to `data/events.jsonl`. Paper, shadow, and live modes also continuously append independently compressed gzip batches to `data/continuous-events.jsonl.gz` when `CONTINUOUS_RECORDING_ENABLED` is true. The batched writer keeps compression off the market-data hot path and makes completed batches replayable while the engine remains online. Run `npm run recall -- data/continuous-events.jsonl.gz` to analyze that capture.

`recall` reconstructs the same causal features, adaptive micro trigger, occupancy/evidence state, cost, and deterministic-entry pipeline, then labels the best executable move available over the configured future horizon. It reports long opportunity recall, signal precision, audit-only downside moves, gate-block frequencies, and non-finite feature incidents. Labels deduct two taker fees plus fixed costs but omit latency and impact, so the result is an optimistic upper bound rather than a profit claim.

`paper:demo-trade` is an explicit diagnostic path for observing the real Alpaca paper order lifecycle. It waits for a healthy warmed book, submits one approximately $11 `BTC/USD` capped IOC entry by default (above Alpaca's $10 USD-crypto minimum), and records reserve, send, acknowledgment, private updates, fills, position management, and any strategy-managed exit in the normal dashboard and database. It is hard-disabled outside paper mode, refuses existing exposure or pending orders, caps entry notional at $25, and labels the decision `PAPER_LIFECYCLE_DEMO` because it intentionally bypasses strategy gates. Stop the normal engine before using it because both commands bind the same dashboard port.

For repeated strategy-pipeline exercise in a paper account, `PAPER_ENTRY_EXERCISE=true` is an explicit non-economic mode. It retains signal, liquidity, exposure, sizing, portfolio, and order-lifecycle controls, but uses zero simulated fees, latency reserve, adverse-selection reserve, positive cost error, and analytical signal-uncertainty reserve. It assumes full sigma/breakout capture, reduces the cost safety factor to `1`, the minimum net edge to `0`, requires IOC/taker entry planning, adds a 5 bps IOC limit-price protection buffer against quote movement during entry and exit submission, and caps each symbol at $25 notional. Startup and the dashboard label the run `EXERCISE`. The switch fails closed outside the Alpaca paper endpoint. Results from this mode are operational tests only and must never be interpreted as achievable performance.

Recall and tuning safeguards live in `config/base.json` under the `RECALL_*` parameters. The report refuses to authorize per-symbol tuning until it has both the minimum recording duration and the minimum count of eligible long opportunity windows. The checked-in baseline requires seven days and 100 opportunities; shorter captures are smoke tests only and must not be used to loosen trading gates.

No `MODEL_CONFIG_JSON` is read in this mode. `ENTRY_MODE=rules` remains a compatibility alias. The optional `DETERMINISTIC_WITH_MODEL_VETO` and `DETERMINISTIC_WITH_MODEL_RANKING` modes require a versioned `MODEL_CONFIG_JSON` and fail closed when it is absent. The router is structurally unable to turn a null deterministic intent into an order.

Live mode additionally requires:

```text
ALPACA_PAPER=false
ALLOW_LIVE_TRADING=true
LIVE_TRADING_CONFIRMATION=I_UNDERSTAND_LIVE_ORDERS_USE_REAL_MONEY
```

## AWS EC2 deployment with Docker Compose

The Compose stack builds and runs the trading engine and PostgreSQL together. The dashboard listens on port `3001`, PostgreSQL remains bound only to EC2 loopback, and named volumes preserve database and recorded event data across container replacements.

On an EC2 instance with Docker Engine and the Compose plugin installed:

```bash
cp .env.example .env
# Add the Alpaca credentials to .env and keep TRADING_MODE=shadow for the first run.
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

The dashboard is enabled by default at `http://127.0.0.1:3001` for a local process, or `http://EC2_PUBLIC_IP:3001` for the Compose deployment. It shows execution-gate liveness, Alpaca public/private stream state, reconciliation and book validity, micro score/phase/block reasons, occupancy, evidence, adaptive noise and movement threshold, arm-anchored chase, per-direction groups, gross opportunity, uncertainty, round-trip cost and lower-bound edge, risk halts, latency, hold/reversal exit dynamics, order fill progression, lifecycle timelines, and the operational audit stream. Its pipeline counters expose `MICRO_EVENT`, `MICRO_ARMED`, and `MICRO_CANDIDATE` separately from cost qualification and order sends. It is read-only, uses no third-party browser assets, and redacts credential-shaped event fields.

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

The test suite enforces exact decimal conversion, reset/delta and duplicate behavior, crossed-book rejection, causal feature replay equality, slow-window warm-up and trend alignment, maker-only entry-path enforcement, mandatory staleness/health gates, adaptive prior-noise decisions, independent evidence quorums, tiny persistent movement detection, spike rejection, opposing-evidence decay, event-gap reset, one candidate per episode, arm-anchored anti-chasing, long/short symmetry, inclusive exact-cost thresholds, model non-creation, deterministic hold/reversal, maximum-loss sizing, monotone floors, operational reconciliation, private-event idempotence, and non-retry of order POSTs.

The replay package includes event validation, opportunity-recall analysis, arrival-time IOC/maker fill simulation primitives, chronological walk-forward fold construction with purge/embargo, conservative stress profiles, and reusable trade-metric calculations. A complete fill-to-P&L walk-forward runner still requires a sufficiently long recorded dataset; the software does not present short smoke-test output as validated performance.

Start with recorder → replay → shadow → paper → minimum-size live. Do not scale until live fill quality, latency, costs, and calibration agree with conservative out-of-sample results.
