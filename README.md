# Alpaca minimal-latency crypto engine

A production-oriented TypeScript implementation of the attached mathematical design. The engine reconstructs Alpaca's crypto L2 book, computes causal microstructure features on every event, and uses explicit deterministic entry, regime, cost, anti-chasing, persistence, reset, and exit rules. The default path does not construct or load a predictive model.

It does **not** promise profit or zero latency. `shadow` is the default. Paper mode requires paper credentials and `ALPACA_PAPER=true`; live mode remains protected by two explicit live-trading interlocks.

## Implemented system

The hot path is:

```text
Alpaca crypto WebSocket
  -> reset/delta L2 book validation
  -> causal deterministic feature extensions
  -> liquidity/regime gates + independent evidence quorums
  -> event-time persistence + score hysteresis + arbitration
  -> bounded opportunity - uncertainty - exact walked cost
  -> anti-chasing + exposure/reset/cooldown gates
  -> risk, correlation, and liquidity sizing
  -> maker/taker EV comparison
  -> capped Alpaca limit order
  -> private trade_updates reconciliation
  -> deterministic hold/reversal + recovery/time/profit-floor exits
```

The main contracts are:

- Entry: every independent book, executed-flow, kinematic, quality, persistence, regime, health, cost, anti-chasing, and exposure gate must pass.
- Cost: `deterministic opportunity − uncertainty reserve − 1.75 × exact quantity-dependent round-trip cost >= minimum edge`.
- Latency: deterministic opportunity is evaluated at `p95 latency + hold horizon` and decayed by `exp(−L_p95/τ_rule)`.
- State: one continuous signal produces at most one entry; both a cooldown and a below-reset interval are required to re-arm.
- Models: `SIGNAL_MODE=DETERMINISTIC_ONLY` is the default. An optional model may only veto, rank, or reduce an already-valid deterministic intent; it cannot create exposure.
- Risk: `quantity × maximum modeled loss per unit <= current risk budget`.
- Protection: `profitFloor[t] >= profitFloor[t−1]`.
- Data: a stale, crossed, pre-reset, timestamp-reversed, or disconnected book cannot create exposure. A provider timestamp may lead the local clock by at most `MAX_PROVIDER_FUTURE_SKEW_MS` (100 ms by default); accepted leads are conservatively clamped to zero age.
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
- Alpaca crypto supports market, limit, and stop-limit orders with GTC/IOC. The engine deliberately emits only price-capped limit orders: GTC for makers and marketable IOC for takers/exits. Maker and taker candidates are independently sized and exact-cost revalidated, so a rejected taker candidate cannot incorrectly suppress an economically valid maker candidate.
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
- `config/btc_usd.json` and `config/link_usd.json` contain symbol-specific overrides. A symbol such as `BTC/USD` maps to `btc_usd.json`.
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
npm run build
npm test
```

The default deterministic configuration in `config/base.json` is:

```text
SIGNAL_MODE=DETERMINISTIC_ONLY
DETERMINISTIC_CONFIG_VERSION=deterministic-v1
```

`record` appends raw order-book and trade events to `data/events.jsonl`. Paper, shadow, and live modes also continuously append independently compressed gzip batches to `data/continuous-events.jsonl.gz` when `CONTINUOUS_RECORDING_ENABLED` is true. The batched writer keeps compression off the market-data hot path and makes completed batches replayable while the engine remains online. Run `npm run recall -- data/continuous-events.jsonl.gz` to analyze that capture.

`recall` reconstructs the same causal feature, regime, persistence, cost, and deterministic-entry pipeline, then labels the best executable move available over the configured future horizon. It reports long opportunity recall, signal precision, audit-only downside moves, gate-block frequencies, and non-finite feature incidents. Labels deduct two taker fees plus fixed costs but omit latency and impact, so the result is an optimistic upper bound rather than a profit claim.

Recall and tuning safeguards live in `config/base.json` under the `RECALL_*` parameters. The report refuses to authorize per-symbol tuning until it has both the minimum recording duration and the minimum count of eligible long opportunity windows. The checked-in baseline requires seven days and 100 opportunities; shorter captures are smoke tests only and must not be used to loosen trading gates.

No `MODEL_CONFIG_JSON` is read in this mode. `ENTRY_MODE=rules` remains a compatibility alias. The optional `DETERMINISTIC_WITH_MODEL_VETO` and `DETERMINISTIC_WITH_MODEL_RANKING` modes require a versioned `MODEL_CONFIG_JSON` and fail closed when it is absent. The router is structurally unable to turn a null deterministic intent into an order.

Live mode additionally requires:

```text
ALPACA_PAPER=false
ALLOW_LIVE_TRADING=true
LIVE_TRADING_CONFIRMATION=I_UNDERSTAND_LIVE_ORDERS_USE_REAL_MONEY
```

## Operations dashboard and PostgreSQL

The local dashboard is enabled by default at `http://127.0.0.1:8787`. It shows execution-gate liveness, Alpaca public/private stream state, reconciliation and book validity, deterministic regime/score/phase/block reasons, per-direction votes, gross opportunity, uncertainty, round-trip cost and lower-bound edge, risk halts, latency, live microstructure, hold/reversal exit dynamics, order fill progression and cost decomposition, lifecycle timelines, and the operational audit stream. It is read-only, binds to loopback by default, uses no third-party browser assets, and redacts credential-shaped event fields.

Start the PostgreSQL 16 service and validate its schema:

```powershell
docker compose up -d postgres
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

The test suite enforces exact decimal conversion, reset/delta and duplicate behavior, crossed-book rejection, causal feature replay equality, mandatory warm-up/staleness/health gates, independent evidence quorums, event-time persistence, long/short symmetry, anti-chasing, direction-conflict no-trade, inclusive exact-cost thresholds, cooldown plus reset re-arming, model non-creation, deterministic hold/reversal, maximum-loss sizing, monotone floors, operational reconciliation, private-event idempotence, and non-retry of order POSTs.

The replay package includes event validation, opportunity-recall analysis, arrival-time IOC/maker fill simulation primitives, chronological walk-forward fold construction with purge/embargo, conservative stress profiles, and reusable trade-metric calculations. A complete fill-to-P&L walk-forward runner still requires a sufficiently long recorded dataset; the software does not present short smoke-test output as validated performance.

Start with recorder → replay → shadow → paper → minimum-size live. Do not scale until live fill quality, latency, costs, and calibration agree with conservative out-of-sample results.
