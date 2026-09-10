# ETH40 tab — deployed on the existing dashboard

Refresh the main dashboard and select **ETH40 paper**, between **BTC spot strategy** and **Futures monitoring**. Its path is `/?view=eth40`, on the same address and port as the other tabs. **ETH40 publishes no separate host port; the former port 3003 binding has been removed and verified closed.**

The tab displays the forward paper account's cash, ETH quantity, fee-inclusive P&L, fees, recorded decisions, next daily execution window, review date, and separate cash/passive ETH/passive BTC comparisons. Captured market quotes and paper fill receipts are available within the tab. Only the selected strategy view polls its API. Stale or unavailable observations remove green status and current monetary values.

The dashboard's read-only endpoints `/api/eth40/status`, `/api/eth40/receipts`, and `/api/eth40/manifest` proxy fixed internal service paths. They cannot submit orders or accept an arbitrary destination. The ETH40 collector now connects to the dashboard through the private Docker network.

## Validation and continuity

- **153 dashboard tests passed**, covering the new UI/proxy and existing BTC, futures, funding and distribution views. TypeScript checks and production build passed.
- The new dashboard image inherits all **21 layers** of the actual previously deployed image. All **902 non-dashboard source, compiled and configuration files** match, and the image command, environment, user and health configuration remain identical. See [image verification](image-verification.json).
- ETH40 retained its original image, frozen manifest, experiment start/review dates, volume, balances and receipt ledgers. Its journal continued advancing. BTC spot retained its original running container and accounts. All three services were healthy after deployment. See [deployment verification](deployment-verification.json).
- The futures account retained **$99,998.28269740003 cash**, all **382 orders**, all **382 activity records**, and its funding configuration/history. See [account continuity](account-after.json).
- Real Chromium checks passed at desktop and mobile sizes: visible ETH40 tab, displayed values matched actual status/receipt data, browser-back navigation worked, hidden tabs made no API/WebSocket requests, and all browser requests used the existing dashboard origin. There were no JavaScript errors or page-width overflow. See [browser report](browser-deployed/browser-report.json), [desktop](browser-deployed/desktop-eth40.png), and [mobile](browser-deployed/mobile-eth40.png).

This changes access and presentation only. The frozen ETH40 strategy, execution timing, funding, and economic-review requirements are unchanged. Its original collection start remains September 10, 2026 at 20:13:41.861 UTC; the first execution opportunity remains September 12 at 00:00 UTC. There are no forward trades or profit conclusions yet.

The initial [storage capacity requirement](../eth40-forward-2026-09-10/report.md#storage-capacity) remains applicable. Current [operating instructions](../../docs/ETH40_FORWARD_OBSERVATION.md) now use the integrated tab and avoid rebuilding the frozen collector.
