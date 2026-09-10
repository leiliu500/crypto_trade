The BTC spot strategy now submits orders to its local paper broker, and the main dashboard displays the strategy, its account, and its orders. Both updated services were deployed on September 10, 2026 around 06:20 UTC and are healthy. Real exchange order submission remains disabled.

An eligible entry or exit now creates a durable `SUBMITTED` IOC limit order before settlement. The broker records acceptance, full or partial fills, cancellation, rejection, and fees. It checks cash, inventory, quote freshness, expiry, venue minimums, price protection, and displayed liquidity. Restart recovery preserves request identity and prevents duplicate debits. The actual deployed image passed 22 isolated synthetic checks covering full fills, partial IOC fills, durable reloads, and corrupted or missing submission evidence. These simulated test orders did not access the production paper account and are not profit evidence.

The port 3001 dashboard has a separate BTC spot section with paper submission status, cash, BTC, equity, forward net P&L, realized and unrealized P&L, fees, delayed weekly signal, next entry window, current blocking reason, and order events. The browser reads the bounded same-origin `/api/spot-dashboard` proxy. Desktop and mobile browser checks passed with no JavaScript exceptions or horizontal overflow. The existing futures section remains a separate account.

The existing spot ledger migrated with an exact legacy backup and immutable migration proof. A subsequent container recreation preserved its original start time, cash, inventory, fees, receipts, and migration identity; evaluation cycles continued. At 06:22 UTC it held **$100,000 cash, zero BTC, zero orders, zero fills, and $0 net P&L**. Its decision was `NEXT_WEEK_ENTRY_WINDOW`. The next possible new-entry window is **September 17, 2026, 00:00–01:00 UTC**, subject to the signal, execution, and risk checks. No entry was forced outside the declared policy.

The combined suite passed **195 tests**, and the TypeScript build passed. Verification inside the exact images with networking disabled confirmed the frozen spot research evidence and a successful migration of a copied actual ledger. The dashboard image uses the exact previous futures image as its base; all 82 files in the futures training-source dependency chain retain their original canonical SHA-256 `c57475ab04ce281cbd83f86f95f0099d56d24ef5edcee758e293be197f8d036b`.

The [independent deployed review](independent-futures-proxy-review.json) passed 23 checks. Futures cash remained exactly $99,998.28269740003; all 382 existing orders and 382 activities, flat positions, and the funding epoch were preserved. Startup restored 6,279 training labels and 362 market-history samples without rejected symbols or training/history errors. The futures engine became operational, and the dashboard proxy matched the spot service's actual status.

| Service | Deployed image SHA-256 |
|---|---|
| Spot paper orders | `6b8b607debf4afa5054d1bac78cdd9086a8354b85494db73ab8b03864e43b8fe` |
| Futures with spot dashboard | `f2c56ce778d47b1f2fef74636a27f277d92bd4aaca69b835ca9d2b51bfd92cda` |

Evidence: [test results](tests.tap), [exact-image verification](image-verification.json), [compiled order lifecycle checks](order-lifecycle-smoke-image.json), [actual restart verification](restart-verification.json), [deployed browser checks](browser-deployed/browser-report.json), [desktop screenshot](browser-deployed/desktop-deployed-spot.png), and [mobile screenshot](browser-deployed/mobile-deployed-spot.png).

Use `docker-compose -f docker-compose.yml -f docker-compose.dashboard-spot.yml` for future operations on this dashboard image, and `docker-compose -f docker-compose.spot-paper.yml` for the separate spot service. The original compose file alone selects the older dashboard image. See [operation and migration details](../../docs/SPOT_TREND_SYSTEM.md).

This rollout verifies order submission and dashboard integration. The strategy's profitability remains unvalidated; enabling orders does not establish positive future returns. Historical research and its failed uncertainty check remain unchanged.
