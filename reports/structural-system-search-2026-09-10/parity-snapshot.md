Some displayed cross-venue prices show positive gross surplus; synchronized execution and positive net profit remain unverified.

This is one contemporaneous EC02 feasibility observation: three requested rounds at 0, 4 and 8 seconds, covering BTC/USD and ETH/USD at Kraken and Coinbase Exchange in both buy/sell directions. It is not a backtest, a completed arbitrage trade, evidence of a lasting edge, or thousands of new systems.

Capture: 2026-09-10T19:43:17.821089+00:00 to 2026-09-10T19:43:26.042881+00:00; elapsed 8.222 seconds. Available displayed comparisons: 12/12; request failures after offline parsing correction: 0; positive gross comparisons: 6.

| Round | Asset | Buy → sell | Gross USD/base | Maximum all-in cost budget, bp of buy notional | Receipt skew, ms |
|---|---|---|---:|---:|---:|
| 1 | BTC/USD | Kraken → Coinbase | -1.64000 | -0.21234 | 12.1 |
| 1 | BTC/USD | Coinbase → Kraken | 1.53000 | 0.19810 | 12.1 |
| 1 | ETH/USD | Kraken → Coinbase | -0.05000 | -0.20252 | 50.0 |
| 1 | ETH/USD | Coinbase → Kraken | 0.02000 | 0.08101 | 50.0 |
| 2 | BTC/USD | Kraken → Coinbase | -2.38000 | -0.30814 | 14.3 |
| 2 | BTC/USD | Coinbase → Kraken | 2.27000 | 0.29391 | 14.3 |
| 2 | ETH/USD | Kraken → Coinbase | -0.24000 | -0.97205 | 155.8 |
| 2 | ETH/USD | Coinbase → Kraken | 0.07000 | 0.28352 | 155.8 |
| 3 | BTC/USD | Kraken → Coinbase | -1.71000 | -0.22140 | 140.1 |
| 3 | BTC/USD | Coinbase → Kraken | 1.60000 | 0.20716 | 140.1 |
| 3 | ETH/USD | Kraken → Coinbase | -0.15000 | -0.60757 | 141.0 |
| 3 | ETH/USD | Coinbase → Kraken | 0.13000 | 0.52659 | 141.0 |

The cost budget is `(sell bid / buy ask − 1) × 10,000`. It is the maximum combined fees, slippage, inventory recycling and other costs, expressed against buy notional. For actual fractional fee rates, nonnegative surplus requires `buyFee + (sellBid/buyAsk)×sellFee + otherCost/buyNotional ≤ sellBid/buyAsk − 1`. The JSON also retains the exact break-even equal fee per side, `(sellBid−buyAsk)/(sellBid+buyAsk)`. Negative budgets cannot support any nonnegative cost scenario at those displayed prices.

No account fee is assumed, no rebate entitlement is inferred, and actual net profit is **unknown**. The model buys with pre-funded cash at one venue and sells already-owned base inventory at the other. Top-level quantity is only a displayed upper bound: venue lots/minimums, wallet balances, order acceptance, atomic fills and subsequent inventory relocation were not established.

Requests within each round ran concurrently. Local completion timestamps were recorded after reading and parsing each response, so they bound body receipt from above and include parsing time. Starts, monotonic durations, selected HTTP cache/date headers, source bodies and hashes are retained. Coinbase's returned book time is compared with the unverified local clock. Kraken's per-level timestamps indicate last changes, not snapshot creation or a continuous heartbeat, so Kraken snapshot age remains unknown. HTTP Date has coarse precision and is not a matching-engine quote timestamp. Small local completion skew does not establish simultaneous books or prevent either quote changing before an order arrives.

Predeclared diagnostic limits were 1,000 ms receipt skew, 2,000 ms response duration, and Coinbase apparent book age from −1,000 to +2,000 ms. Diagnostic issues remain in each JSON comparison; they never authorize a trade. REST caching and unknown clock offsets can make apparent crosses misleading.

The best displayed cost budget was **0.52659 basis points**. A separate scale diagnostic charges the published Kraken entry-tier taker fee of 80 bp on its leg while hypothetically charging zero on Coinbase and ignoring other costs. 0 of 12 comparisons are positive under that scenario; the best is -79.47762 bp. This fee scenario was added after observing the quotes to show cost scale; it is neither account-specific pricing nor an independently selected strategy. [Kraken fee schedule](https://www.kraken.com/features/fee-schedule).

The initial sandbox attempt failed DNS resolution and is preserved inside the JSON. The subsequent authorized public capture returned HTTP 200 for all twelve responses. Python 3.9 initially rejected Coinbase's nanosecond timestamps; [the original failed analysis](parity-snapshot-unparsed.json) and every raw response are retained. The timestamp correction and all final comparisons were computed offline from the same sample, with no additional market requests.

Coinbase apparent book ages ranged from 465.3 to 2100.5 ms. Out-of-limit book timestamps: round 2 ETH/USD. Cached responses observed: True. No comparison is represented as synchronized executable arbitrage.


Sources: [Kraken L2 order book](https://docs.kraken.com/api-reference/market-data/get-order-book), [Coinbase product book](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-book). Coinbase L1 sizes are aggregate quantities and were not multiplied by order counts; indicative auction books are rejected.

[Raw evidence and calculations](parity-snapshot.json), [reproducible collector and analyzer](parity-snapshot.py). `python3 parity-snapshot.py --verify` recomputes saved comparisons offline. `--capture` fetches a new bounded sample and refuses to overwrite an existing report. No authenticated request, order, borrowing, transfer or deployment is available in this script.
