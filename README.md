# Multi-venue minimal-latency crypto engine

A production-oriented TypeScript implementation of the attached mathematical design. The active paper path reconstructs Kraken's linear perpetual-futures L2 book, computes causal microstructure features on every event, and uses explicit deterministic entry, regime, cost, anti-chasing, persistence, reset, and exit rules. The default path does not construct or load a predictive model. The retained Alpaca adapter includes an optional, disabled-by-default route that converts qualified bearish BTC or ETH intents into finite-risk long puts on a crypto ETF proxy.

It does **not** promise profit or zero latency. The checked-in `.env.example` selects the Kraken Futures adapter and starts in shadow mode; `npm run paper` enables its local paper broker. Kraken market data is production public data, while orders, fills, balances, and positions remain strictly local. Kraken live order routing is intentionally unavailable.

## Implemented system

The hot path is:

```text
Kraken Futures public WebSocket (or the retained Alpaca adapter)
  -> reset/delta L2 book validation
  -> causal microstructure + sampled 5/15/60-minute trend state
  -> prior-event adaptive microprice-noise threshold
  -> bounded micro/book/flow/motion score + mandatory motion quorum
  -> decayed occupancy/evidence + hysteresis + arm-anchored anti-chasing
  -> health/liquidity + venue/exposure/cooldown gates
  -> calibrated-or-analytic edge - uncertainty - exact walked cost
  -> anti-chasing + quantity-aware execution planning
  -> risk, correlation, and liquidity sizing
  -> maker-only entry planning + maker-first non-urgent exits with bounded IOC fallback
  -> Kraken paper: capped linear-perpetual order for native long or short exposure
  -> local paper acknowledgements/fills/cancels/reconciliation
  -> deterministic hold/reversal + recovery/time/profit-floor exits
```

The main contracts are:

- Candidate: a bounded directional score, two-of-three book/flow/motion quorum with motion mandatory, decayed occupancy, leaky evidence, confirmation time/events, arbitration, cooldown, and midpoint-at-arm chase limit must pass. A directional regime is still reported but cannot suppress a micro candidate.
- Entry: every health, dynamic-liquidity, venue, exposure, edge, cost, sizing, execution-plan, and portfolio gate must then pass. Candidate sensitivity never bypasses order economics.
- Cost: `deterministic opportunity − uncertainty reserve − (exact fixed fees + stressed variable execution cost) >= minimum edge`. The `1.75` safety factor applies only to uncertain execution, impact, latency, and adverse-selection components; known venue fees remain exact.
- Horizon: microstructure selects entry timing. A bounded five-second sampler supplies causal 5/15/60-minute trend returns, slow efficiency, and slow realized variance; a separate 30-second sampler supplies the ordered four-hour pullback/recovery state to the 1/2/4-hour economic horizons.
- Entry families: continuation keeps its existing aligned 5/15/60-minute gate. Pullback/recovery separately requires a prior structural move, a fee-scale retracement, a confirmed rebound, retained trend, and unrecovered room; it does not relax continuation thresholds.
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

No Kraken API key is read in this mode, and no Kraken private REST or WebSocket order method is called. A Kraken Pro browser sign-in is unrelated to the local simulator. `TRADING_MODE=live` with `TRADING_VENUE=kraken_futures` fails at configuration load.

## Alpaca API coverage

The retained Alpaca adapter uses the current Alpaca Trading API and Crypto Data API directly:

- Trading resources: account, account configuration, account portfolio history, activities, assets, clock, order create/list/get/by-client-ID/replace/cancel/cancel-all, position list/get/close/close-all.
- Crypto latest data: order books, quotes, trades, bars, and snapshots.
- Crypto historical data: bars, quotes, and trades with page-token-capable query types.
- Options control plane: current-day contract discovery and option-order/position reconciliation.
- Public stream: trades, quotes, and order-book reset/deltas at `v1beta3/crypto/{loc}`.
- Proxy/options streams: IBIT/ETHA quotes from the stock WebSocket and explicitly subscribed contract quotes/trades from Alpaca's msgpack-only options WebSocket. REST snapshots never authorize an option order.
- Private stream: all `trade_updates`, including new, partial fill, fill, cancel, expiry, replace, reject, pending, suspended, and uncommon states.
- Every trading response retains Alpaca's `X-Request-ID` for operational diagnosis.

Startup preflight reads all latest crypto resources, account configuration, and clock. Reconciliation reads account, dynamic asset precision, all open crypto orders, positions, and 24-hour portfolio history. REST market data is never awaited in the trading hot path.

Alpaca venue constraints are enforced:

- Spot crypto assets currently report `shortable=false`. With `CRYPTO_SHORT_OPTIONS_ENABLED=false` (the default), short intents remain audit-only. When explicitly enabled, a qualified `BTC/USD` short buys an IBIT put and a qualified `ETH/USD` short buys an ETHA put; this is proxy exposure, not a short sale of the coin.
- The options route is deliberately long-put-only. It does not sell naked calls or construct a synthetic short, so modeled maximum loss is the premium paid. It requires Alpaca options level 2, whole contracts, `day` orders, regular US options hours, fresh stock and option WebSocket quotes, a configured spread limit, and sufficient options buying power.
- Only contracts whose expiration date equals the current `America/New_York` trading date are eligible. Greeks are not required because Alpaca generally cannot calculate them for 0DTE; the selector uses proxy moneyness, live bid/ask liquidity, and open interest. If the proxy has no listed expiration that day, the route fails closed.
- New 0DTE entries are allowed only from 09:35 through 14:59 ET. Positions are sent a streamed, marketable-limit exit from 15:15 ET; any position still present at 15:25 ET uses an emergency market `sell_to_close` before Alpaca's expiration-risk processing window. Every entry is intraday-only and the engine never intentionally carries it through expiration.
- Option orders remain interlocked through terminal-order reconciliation, including partial fills and momentarily inconsistent order/position snapshots. Ambiguous POST outcomes are resolved by client order ID and are never resubmitted speculatively. Opening orders encode the originating crypto reference price in their owned client ID so stop/target management survives a process restart, and any signal-router size reduction scales the maximum premium budget before whole-contract rounding.
- The proxy route's premium cap is a loss bound, not evidence that a crypto signal has profitable 0DTE option expectancy. Paper fills must be used to calibrate proxy basis, option spread/slippage, and time decay before live enablement.
- Alpaca crypto supports market, limit, and stop-limit orders with GTC/IOC. Entries remain non-marketable GTC limits. Continuation entries retain the micro-alpha TTL; multi-hour pullback/recovery entries use a separate 20-second maker TTL. Every submitted plan has an independent wall-clock deadline, so quiet market data cannot leave it resting past expiry. Cancellation intent is latched while an order POST is in flight and is executed immediately after acknowledgment. A single transient kinematics reset cannot cancel a resting pullback order: cancellation requires both the configured five-second grace and two consecutive unavailable events. A lone adverse OFI or trade-flow sensor also requires a configurable two-second, three-event confirmation; corroborated OFI and trade flow still cancel immediately. TTL, stale-book, structure, and exact-cost checks remain fail-closed. Non-urgent exits may rest at the ask for up to 30 seconds and then cancel/reconcile before a price-capped IOC submits the remainder; hard stops and profit-floor exits use IOC immediately. The `MAKER_MAKER_TAKER_FALLBACK` ledger charges maker exit fees plus stressed, probability-weighted fallback fee/spread/adverse costs. Every final quantity is exact-cost revalidated, and a taker entry cannot silently replace an unfilled or uneconomic maker entry. Account reconciliation fetches the exact authoritative status of locally tracked orders missing from Alpaca's open-order list instead of assuming they were canceled.
- There are no perpetuals, leverage, liquidation, funding, or native reduce-only flags on this venue. Funding/borrow are therefore zero, and exits are client-side clamped to the known long position.
- Alpaca's documented order-book schema exposes reset and price-level deltas, but no exchange sequence number or checksum. The engine requires a reset after connection, rejects timestamp reversal/crossed books/duplicates, and never misrepresents its local counter as an exchange sequence guarantee.
- Minimum size, quantity increment, and price increment come from the live Alpaca Assets resource rather than hard-coded symbol rules.

Official references: [real-time crypto data](https://docs.alpaca.markets/docs/real-time-crypto-pricing-data), [crypto trading](https://docs.alpaca.markets/docs/crypto-trading), [real-time options data](https://docs.alpaca.markets/docs/real-time-option-data), [options trading](https://docs.alpaca.markets/docs/options-trading), [orders](https://docs.alpaca.markets/reference/postorder), and [trade updates](https://docs.alpaca.markets/docs/websocket-streaming).

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

The standard Alpaca names `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY` remain accepted when `TRADING_VENUE=alpaca`. Secrets are never included in application logs. `.env` is ignored by Git.

Tunable parameters are JSON-backed:

- `config/base.json` contains the enabled symbol list and baseline parameter values.
- Files such as `config/btc_usd.json`, `config/doge_usd.json`, `config/eth_usd.json`, `config/link_usd.json`, `config/sol_usd.json`, and `config/xrp_usd.json` contain symbol-specific overrides. A symbol such as `XRP/USD` maps to `xrp_usd.json`.
- A symbol file only needs to include values that differ from the baseline. Its keys must already exist in `base.json`, and global dashboard/database parameters cannot be overridden per symbol.
- Global `OPTIONS_SHORT_*` values in `config/base.json` configure the proxy map, WebSocket feeds, ATM moneyness band, quote/spread limits, premium cap, contract subscription cap, entry/exit times, and intraday stops. The checked-in option feed is `opra`; the Alpaca account must have access to that feed.
- `CONFIG_DIR` can select another configuration directory. JSON values take precedence over legacy tunable environment variables, so tuning has one source of truth.

Keep credentials and connection secrets out of all JSON files.

## Modes

| Mode | Behavior |
|---|---|
| `record` | Records public book/trade events to JSONL; no decisions or orders. |
| `replay` | Reconstructs and validates a recorded event stream. |
| `shadow` | Runs the full decision pipeline and emits plans without submitting them. |
| `paper` | Runs capped deterministic-rule orders through the selected paper adapter. Kraken orders remain local. |
| `live` | Alpaca real-money orders only. Kraken live routing is not implemented. |

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

The default USD market universe is `BTC`, `ETH`, `LINK`, `SOL`, `XRP`, `DOGE`, `ADA`, `LTC`, `AVAX`, `HYPE`, and `PEPE`. Each pair must pass the same causal feature, liquidity, cost, risk, and maker-fill gates; expanding the universe does not relax entry economics.

The default deterministic configuration in `config/base.json` includes:

```text
SIGNAL_MODE=DETERMINISTIC_ONLY
DETERMINISTIC_CONFIG_VERSION=btc-eth-continuation-recall-v4.7.0
PULLBACK_MAKER_TTL_MS=20000
PULLBACK_KINEMATICS_GRACE_MS=5000
PULLBACK_KINEMATICS_GRACE_EVENTS=2
ADVERSE_FLOW_CONFIRMATION_MS=2000
ADVERSE_FLOW_CONFIRMATION_EVENTS=3
```

`record` appends raw order-book and trade events to `data/events.jsonl`. Paper, shadow, and live modes also continuously append independently compressed gzip batches to `data/continuous-events.jsonl.gz` when `CONTINUOUS_RECORDING_ENABLED` is true. The batched writer keeps compression off the market-data hot path and makes completed batches replayable while the engine remains online. Run `npm run recall -- data/continuous-events.jsonl.gz` to analyze one capture, or pass archived and active files in chronological order to accumulate coverage across restarts: `npm run recall -- data/continuous-events.ARCHIVE.jsonl.gz data/continuous-events.jsonl.gz`.

`recall` reconstructs the same causal features, adaptive micro trigger, occupancy/evidence state, cost, and deterministic-entry pipeline, then labels the best executable move available over the configured future horizon. It reports opportunity recall, signal precision, pullback-reversal recency shadows, gate-block frequencies, and non-finite feature incidents. Kraken Futures runs treat long and native-short signals symmetrically in acceptance and calibration; venues without native crypto shorts retain the short side as audit-only. Labels deduct two taker fees plus fixed costs but omit latency and impact, so the result is an optimistic upper bound rather than a profit claim.

`paper:demo-trade` is an explicit diagnostic path for the selected paper order lifecycle. It waits for a healthy warmed book, submits one approximately $11 `BTC/USD` capped IOC entry by default, and records reserve, send, acknowledgment, private updates, fills, position management, and any strategy-managed exit in the normal dashboard and database. It is hard-disabled outside paper mode, refuses existing exposure or pending orders, caps entry notional at $25, and labels the decision `PAPER_LIFECYCLE_DEMO` because it intentionally bypasses strategy gates. Stop the normal engine before using it because both commands bind the same dashboard port.

For repeated strategy-pipeline exercise in a paper account, `PAPER_ENTRY_EXERCISE=true` is an explicit non-economic mode. It retains signal, liquidity, exposure, sizing, portfolio, and order-lifecycle controls, but uses zero simulated fees, latency reserve, adverse-selection reserve, positive cost error, and analytical signal-uncertainty reserve. It assumes full sigma/breakout capture, reduces the cost safety factor to `1`, the minimum net edge to `0`, requires IOC/taker entry planning, adds a 5 bps IOC limit-price protection buffer against quote movement during entry and exit submission, and caps each symbol at $25 notional. Startup and the dashboard label the run `EXERCISE`. The switch fails closed outside paper mode. Results from this mode are operational tests only and must never be interpreted as achievable performance.

Recall and tuning safeguards live in `config/base.json` under the `RECALL_*` parameters. The report refuses to authorize per-symbol tuning until it has both the minimum covered market-data duration and the minimum count of venue-eligible opportunity windows. Offline time between recorder segments is excluded from coverage, and any explicit recorder gap blocks tuning. The checked-in baseline requires seven covered days and 100 opportunities; shorter or incomplete captures are smoke tests only and must not be used to loosen trading gates.

No `MODEL_CONFIG_JSON` is read in this mode. `ENTRY_MODE=rules` remains a compatibility alias. The optional `DETERMINISTIC_WITH_MODEL_VETO` and `DETERMINISTIC_WITH_MODEL_RANKING` modes require a versioned `MODEL_CONFIG_JSON` and fail closed when it is absent. The router is structurally unable to turn a null deterministic intent into an order.

Live mode additionally requires:

```text
ALPACA_PAPER=false
ALLOW_LIVE_TRADING=true
LIVE_TRADING_CONFIRMATION=I_UNDERSTAND_LIVE_ORDERS_USE_REAL_MONEY
```

Enabling the separate 0DTE route requires `CRYPTO_SHORT_OPTIONS_ENABLED=true`. In live mode it also requires:

```text
OPTIONS_SHORT_LIVE_CONFIRMATION=I_UNDERSTAND_0DTE_OPTIONS_CAN_EXPIRE_WORTHLESS
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

The test suite enforces exact decimal conversion, reset/delta and duplicate behavior, crossed-book rejection, causal feature replay equality, slow-window warm-up and trend alignment, ordered pullback/recovery detection, fee-sized recovery economics, maker-only entry-path enforcement, mandatory staleness/health gates, adaptive prior-noise decisions, independent evidence quorums, tiny persistent movement detection, spike rejection, opposing-evidence decay, event-gap reset, one candidate per episode, arm-anchored anti-chasing, long/short symmetry, inclusive exact-cost thresholds, model non-creation, deterministic hold/reversal, maximum-loss sizing, monotone floors, operational reconciliation, private-event idempotence, and non-retry of order POSTs.

The replay package includes event validation, opportunity-recall analysis, forward-return calibration candidates, profitable-after-robust-cost acceptance gates, arrival-time IOC/maker fill simulation primitives, chronological walk-forward fold construction with purge/embargo, conservative stress profiles, and reusable trade-metric calculations. Set `RECALL_REQUIRE_PROFITABLE_ENTRY=true` to make `npm run recall` exit nonzero unless a full replay contains at least one profitable venue-eligible intent; the legacy `RECALL_REQUIRE_PROFITABLE_LONG=true` gate remains long-specific. Calibration remains non-deployable until the configured duration and independent-sample requirements pass; short recordings are reported as provisional evidence only.

Run `npm run optimize:report` against the configured PostgreSQL database to audit maker-fill calibration and a read-only 15-minute unproductive-position exit counterfactual. Use `npm run optimize:report:production` in the compiled production container. The report excludes orders from runs with dropped telemetry and does not authorize a parameter change until the same minimum tuning duration and effective-sample requirements pass. Maker-fill deployment additionally requires ROC AUC of at least 0.55, while the timeout shadow requires a positive lower 95% confidence bound for its P&L improvement.

Start with recorder → replay → shadow → paper → minimum-size live. Do not scale until live fill quality, latency, costs, and calibration agree with conservative out-of-sample results.
