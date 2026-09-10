# ETH40 forward paper observation

This is a separate, cash-funded ETH/USD paper experiment for the development-selected `sma_eth-040` candidate. Historical qualification failed; positive historical nominal returns do not establish future profitability. The existing futures engine and BTC weekly paper service have independent accounts and deployments.

## Frozen strategy

The history anchor is September 20, 2024, with the original 90-bar warmup. For completed candle i, use the mean of its latest 40 closes, including i. Enter the long target when close exceeds that mean multiplied by `1.0167388926355327`; exit to cash when close is at or below the mean; otherwise retain the previous target. Hysteresis is reconstructed from the fixed anchor, including after a restart. BTC is a passive benchmark here; ETH's signal has not been validated as a BTC strategy.

Execution is eligible at UTC open i+2. Only the first 60 seconds of that day permit paper fills. A launch starts all accounts in cash and uses the launch UTC candle as the first prospective signal candle. Consequently the first execution opportunity is two UTC days after launch. A missed window is recorded and never backfilled. The same target may be attempted at the next eligible daily opening. Quote and minimum-size failures can retry inside the opening minute. There is at most one fill per account per day; a partial sale leaves real residual inventory, which can only be sold at a later opening with an eligible cash target. No additions, leverage, shorts, or automatic parameter changes are permitted.

Each account starts at $10,000. A fee-inclusive entry budget is the minimum of $1,000, 10% of cash, cash, and 0.1% of the signal candle's ETH or BTC dollar volume. There is no daily rebalancing and no newly introduced drawdown stop. Marked exposure can exceed the entry cap as prices change.

## Executable quotes and costs

The service reads public Kraken spot WebSocket v1 ETH/USD and XBT/USD books, normalized to ETH/USD and BTC/USD. Snapshots require a subsequently verified top-ten CRC32 checksum. Both local receipt and the latest exchange update must be within five seconds at the decision; an exchange clock lead greater than one second is rejected. Recorded book levels and decimal-string checksum inputs allow later inspection. Disconnects, malformed messages and checksum failures invalidate the book. A REST receipt alone is not treated as proof of a fresh executable quote.

Instrument metadata is obtained independently for each pair. Lot sizes, tick sizes, minimum quantities, minimum notional, and online status apply to that pair only. Native daily OHLC history requires finalization by candle close plus 60 seconds, continuity, and agreement with previously accepted completed data. Conflicting revisions stop decisions for the affected history instead of silently rewriting the frozen history.

The fee assumption is **80 basis points (0.80%) per side**, the public entry-tier Kraken Pro spot taker fee checked on September 10, 2026. Private account eligibility is unknown, and simulated account balances do not qualify for actual fee discounts. [Kraken fee schedule](https://www.kraken.com/features/fee-schedule). Book integrity follows the [official checksum specification](https://docs.kraken.com/exchange/guides/websockets/book-checksum-v1).

Paper orders walk the appropriate displayed ask/bid levels within a ten-basis-point price collar and use at most 5% of displayed quantity inside that collar. Quantity is rounded down to the instrument lot. Buying power includes entry fees, and sales cannot exceed inventory. This replaces the historical OHLC price plus assumed three-basis-point slippage. Actual book walking, partial or missed fills, and the bounded opening window form an explicit prospective execution contract; they are not a claim that historical OHLC fills were executable. There are no authenticated exchange requests or live order submissions.

## Accounting and comparisons

ETH40, passive ETH, and passive BTC have separate funded ledgers. Passive accounts each buy once at an eligible opening, using the same entry budget and execution limits, then retain inventory and unused cash. These are approximately 10%-funded passive benchmarks, not 100%-invested coin returns. First actual fill timestamps and failures are retained so unequal fill dates remain visible. The cash benchmark stays at $10,000 with zero assumed interest.

Each fill records side, quantity, VWAP, fee rate, timestamp, and a deterministic account/day identifier. Cash, inventory, acquisition basis, realized net P&L and accumulated fees reconcile to receipts. Open inventory is marked to a fresh verified bid minus the exit fee. This is a net bid mark, not a guaranteed simultaneous full liquidation price; actual exits still obey depth limits. Missing or stale inventory marks yield unavailable P&L instead of substituting an old price. A report does not force a terminal sale or count a marked open position as a completed episode.

The service records sampled full-account drawdown, net returns, cash and passive excess returns, decisions, rejections, fills, quote ages and history/source hashes. Sampled drawdown cannot capture every intraday low between observations. Independent benchmark fills do not compete with each other for simulated liquidity; each represents an alternative allocation.

## Durability and operations

The first durable event freezes source and compiled-runtime hashes, configuration, the original selection artifact, and the historical seed before any forward decisions. An exclusive OS lock prevents two writers to the same volume. Immutable numbered events link state and evidence hashes. Raw REST responses and accepted histories are stored by content hash, and balances are reconciled to receipts on restore. A committed event is recovered after a crash even if the process stopped before updating memory. A write, source-version, chain, or accounting integrity error stops the process.

The collector image is frozen. Start or recreate the existing collector without rebuilding it:

```sh
docker-compose -f docker-compose.eth40-paper.yml up -d --no-build
```

The service uses container `crypto-eth40-paper` and volume `crypto_trade_eth40_observation_v1`. It publishes no host port. Its private Docker network connects it to the existing dashboard, which exposes an **ETH40** tab at `/?view=eth40` on the same address and port as BTC spot and Futures monitoring. On the host this is `http://127.0.0.1:3001/?view=eth40`.

Read-only dashboard endpoints are `/api/eth40/status`, `/api/eth40/receipts`, and `/api/eth40/manifest`. Health reports collector progress; individual market-data readiness is reported separately. There is no HTTP trade, reset, or configuration endpoint. The frozen image contains only the paper runtime, the public WebSocket dependency, and research inputs; it does not contain exchange credentials.

The ETH40 tab includes a visible liveness panel. It separates dashboard response age from durable observation age, shows ETH and passive BTC quote checks at the recorded capture, and displays recorded daily history and execution timing. Ages and the execution countdown update every second; the dashboard requests status every five seconds. Recent observations in the panel are distinct committed records seen during that browser session. Repeated polls do not add observations, and the initial manifest event is excluded from the observation count.

Quotes are checked against their capture timestamp, not the time a user opens the dashboard. Normal observations are collected approximately every 30 seconds after cycle work completes, with more frequent checks during the daily execution minute. A responsive API can therefore report an older observation or a market-data problem. Missing or expired status is shown as unconfirmed; waiting for the first eligible execution day is an expected state, not evidence that the collector stopped.

```sh
docker-compose -f docker-compose.eth40-paper.yml ps
docker-compose -f docker-compose.eth40-paper.yml logs --tail=30
curl -fsS http://127.0.0.1:3001/api/eth40/status
```

Preserve the volume and original runtime when stopping/restarting. A different frozen manifest is rejected; changing a rule after observing results requires a separately identified experiment. Do not reset losses or overwrite the initial nomination to imply historical qualification.

Plan durable storage for the full review period. Initial captured record sizes project about 9.8 GiB for 181 days, before growth and filesystem overhead; the host had about 9.1 GiB free at deployment. Additional capacity or a reviewed archive/compression design is needed. Preserve all hash-referenced evidence; simply removing old event files will make integrity checks fail at restart.

The review date is six calendar months after the actual durable start time. Fewer than ten completed ETH40 episodes remains inconclusive. Reaching the date or episode count triggers no automatic promotion, and this service contains no live execution adapter.
