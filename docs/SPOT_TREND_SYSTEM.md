The new BTC spot system passed its frozen historical screen for a separate research paper trial. It is not validated profitable. The experiment changes the instrument and holding period: buy fully funded BTC during a sustained weekly trend, hold through the trend, and sell to USD cash when the delayed weekly state weakens. There are no shorts, loans, perpetual funding payments, fitted profit forecasts, or frequent timed round trips.

The signal uses the arithmetic average of 40 completed native Kraken weeks. It enters above 1.0166 times that average, exits at or below the average, and retains its previous state inside the band. The 1.66% band is a fixed turnover control scaled to declared execution costs; distance from an average is not an expected profit estimate. The rule and acceptance checks were sealed before strategy returns were calculated. Recent history had already been used by other candidates and is not an untouched validation set.

| January 2017–September 2026 | Base | Higher costs and another week of delay |
|---|---:|---:|
| Trend net after fees | $1,175.60 | $1,228.51 |
| Completed trend episodes | 11 | 11 |
| Trend execution fees | $27.22 | $34.60 |
| Trend weekly-close drawdown | $584.28 | $575.09 |
| BTC buy-and-hold net | $6,609.16 | $6,572.98 |
| BTC buy-and-hold weekly-close drawdown | $5,501.93 | $5,472.27 |

These are historical price-proxy results over almost ten years. The ledger starts with $100,000 and the initial purchase budget is $100 including fees. Base profit is approximately 1.176% of that whole account over the full interval. Dividing profit by the initial $100 entry budget is not the return of a separately funded $100 account: the larger cash ledger can finance later entries after losses. Buy-and-hold starts at the same first eligible opening with the same initial purchase budget, then keeps fixed units; its later exposure is larger and is not risk matched.

The thirteen-week moving-block bootstrap lower 5% mean weekly net is **−$0.4782**. Only 11 completed episodes per scenario and this negative uncertainty bound leave profit unvalidated. The positive economic screen permits a small forward research paper experiment; it does not permit real orders or establish dependable profits. All failed checks and comparisons remain visible in the [complete historical report](../reports/new-spot-system-2026-09-10/historical-study/report.md). The [independent audit](../reports/new-spot-system-2026-09-10/audit.json) checked 73,337 assertions across 24 runs and 116 fills without importing the application model.

Each new purchase spends at most `min($1,000, 0.1% of liquidation equity, available cash)`, including fees. The whole purchase is at risk. Appreciation can increase marked inventory; the forward service checks a separate `min($1,000, 1% of equity)` marked cap and a persistent 5% account drawdown halt. Quotes and prices can move between checks. Risk-triggered or missing-history exits continue when fresh valid execution books are available. Partial fills and unsellable dust remain explicitly accounted for.

Historical buys and sells use the first weekly opening strictly after the signal becomes available; the stress case adds one week. Current public Tier 1 fees of 80 basis points per side are charged throughout the base history, with 3 basis points of adverse price adjustment; stress uses 100 and 10 basis points respectively. These are forward cost assumptions, not historically verified account entitlements. Positive weekly volume is a retrospective availability proxy, and candle prices cannot establish executable depth. See the [Kraken fee schedule](https://www.kraken.com/features/fee-schedule) and [OHLC API documentation](https://docs.kraken.com/api-reference/market-data/get-ohlc-data).

Forward paper orders use the delayed state that was already available at the current Thursday 00:00 UTC opening. Version 3 evaluates new entries every cycle throughout the week, including when the service starts after Thursday's first hour. An entry uses the current executable book; it never backdates a fill. The delayed weekly signal cutoff is unchanged. The historical table above describes the parent weekly strategy and does not validate the revised execution timing. The service checks every five minutes and walks a fresh spot book within 10 basis points of the best price, using at most 5% of displayed quantity inside that range. The first partial entry consumes that weekly entry opportunity. Current-book fills and more frequent protective checks differ from coarse weekly price proxies, so their results must be measured prospectively. Paper fills are simulated, not observed exchange executions.

The service has its own container, its own paper-account volume, and a local status endpoint. It does not import the old futures account's money or simulated trades. Exact source and research evidence hashes must match on startup. Receipt reconciliation, immutable cycle evidence, atomic durable state replacement, and a kernel file lock protect restart continuity. A persistence error stops the process rather than continuing from possibly stale balances.

The paper runner submits an IOC limit order to a local spot paper broker. The `SUBMITTED` request is durably recorded before the broker can accept or fill it. Orders expose acceptance, full or partial fills, cancellation, rejection, and fees; a partial IOC fill cancels its unfilled remainder. Client order IDs prevent duplicate debits. Pending requests expire after 30 seconds and are checked again against the current book, cash, inventory, venue rules, and entry policy after a restart. Settlement evidence references the persisted submission. There is no exchange order API or live trading credential path.

The main dashboard on port 3001 opens the BTC spot view with submission status, cash, BTC inventory, liquidation equity, forward net P&L, realized and unrealized P&L, fees, signal timing, entry blockers, and order events. It reads `/api/spot-dashboard`, a bounded same-origin proxy to the spot service. Unavailable or stale data is identified explicitly. The existing BTC/ETH executable return distributions, futures account, and operational panels are available only through the explicit Futures monitoring view (`/?view=futures`). The default spot view (`/` or `/?view=spot`) uses the spot service for its header connection status and does not start the futures dashboard stream. The futures strategy remains a separate running paper engine; its predictions do not drive spot orders.

The spot liveness panel separates service reachability from strategy progress. It shows the age of the upstream status response, recorded evaluation count and last evaluation time, approximate next check, last successful market-data cycle, pending and terminal paper orders, and the entry/risk gate. Display ages update every second; API polling remains every five seconds. The next-check countdown is an estimate based on the recorded cycle and configured wait, not an acknowledged scheduler deadline. Once due, it waits for a new recorded evaluation instead of restarting itself. The recent evaluation list contains only distinct evaluations observed in the current browser session; it is not a reconstructed historical log. The account start date is not process uptime, and a responding status API alone does not establish that strategy evaluations are advancing.

Order cards show position direction separately from the exchange side: spot buys open LONG exposure and sells close LONG exposure; this funded spot system does not open shorts. The dashboard reads the existing spot journal through a read-only volume mount, reconciles its fills, and follows committed cycle evidence to show holding evaluations, recorded bid and net P&L changes, partial exits and closure. This history survives browser reloads. Cards refresh with the five-second status poll; prices and P&L change only when new recorded strategy valuations are available, currently about every five minutes. Display-only ages and holding durations tick every second. Older timeline events are paginated, and unavailable, loading or stale history is identified explicitly. This display does not change the trading runtime or write to its journal.

Build and start the separate service:

```bash
npm run build
docker-compose -f docker-compose.spot-paper.yml up -d --build
curl http://127.0.0.1:3002/status
```

Its container is `crypto-spot-trend-paper`, its volume is `crypto_trade_spot_trend_research`, and its HTTP port is bound to host loopback only. The external `crypto-trade_default` network must exist so the main dashboard can reach it. `/healthz` reports data/service health. `/status` exposes submission capability, orders, the current decision, cash, inventory, realized and marked P&L, and the explicit unvalidated research status. Restarting reuses the existing ledger and does not reset capital. The known, untraded version 1 ledger migrates once with an exact backup and immutable migration proof. The exact known version 2 runtime also migrates to version 3 with settled orders, balances and receipt proofs preserved, a separate immutable runtime-upgrade proof, and no pending order allowed during the switch. Other runtime/evidence mismatches or previously traded version 1 ledgers require reconciliation.

For this deployment, the main dashboard image overlays only dashboard code and assets on the exact previously deployed futures image. It preserves the futures trading-source hashes and existing account volume:

```bash
docker tag sha256:4e5d6e8ecd4e816fdcb550caa11c20ff9172d0aa580ed99deaf4bccf8bca0c1a crypto-trade-engine:spot-dashboard-base-20260910
npm run build
docker-compose -f docker-compose.yml -f docker-compose.dashboard-spot.yml build engine
docker-compose -f docker-compose.yml -f docker-compose.dashboard-spot.yml up -d --no-build --no-deps engine
curl http://127.0.0.1:3001/api/spot-dashboard
```

Use this overlay command when recreating the dashboard deployment; the base compose file alone names the older image. The fixed base hash is specific to this rollout, not a general upgrade mechanism.

Reproduce the sealed research with a new output directory:

```bash
npm run research:spot-trend -- reports/new-spot-system-2026-09-10/market-data /tmp/new-spot-study-reproduction
```

The checked-in study remains immutable. The standalone `audit.mjs` also refuses to overwrite its existing audit; run independent audit reproductions in a separate copied workspace with a fresh audit destination. A modified rule is a new experiment, and changing its parameters after inspecting these outcomes would not create independent validation.
