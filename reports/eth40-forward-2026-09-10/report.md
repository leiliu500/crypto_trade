# ETH40 forward paper service — running

**Access update:** ETH40 has subsequently been integrated into the main dashboard at `/?view=eth40`. Host port 3003 has been removed; the port references below document the original launch. See the [dashboard integration report](../eth40-dashboard-tab-2026-09-10/report.md) for its verified deployment status.

The separate ETH40 collector started **September 10, 2026 at 20:13:41.861 UTC**. It is running and healthy on host loopback port **3003**, with its own container and persistent volume. At the recorded deployment check it had **33 completed observation cycles**, fresh BTC and ETH books, and no current market-data errors. The existing futures engine and BTC weekly paper service remained healthy with their original container identities.

**There are no forward profit results yet.** All three funded paper accounts still hold their original $10,000 cash, with zero fills, fees and P&L. The first eligible execution window is **September 12, 2026, 00:00–00:01 UTC**, preserving the frozen signal-to-execution delay. An ETH40 purchase still requires its eligible daily signal, fresh executable book and valid size limits.

BTC and ETH use independent books, instrument rules and metadata ages. ETH40's SMA/hysteresis rule applies only to ETH. Passive BTC and ETH buy once as separate comparisons; their approximately $1,000 funded allocations plus remaining cash use the same entry limits. This does not transfer ETH's signal to BTC or assume a common profitable strategy for both assets.

## Verification

- TypeScript build passed. **61 distinct focused tests passed** across the new signal, market, status and persistence code plus reused accounting and locking code. The complete 60-test set passed before the final drawdown invariant; the resulting 11-test persistence suite passed after that change.
- The new signal matched the original Python ETH40 targets on **all 720 historical days**, with **zero mismatches**. See [signal parity](signal-parity.json).
- Public Kraken REST and WebSocket preflight captured native daily history, per-pair rules, and fresh checksummed books. A separate Python CRC32 calculation verified both decimal-string proofs and their equality to the numeric levels in an actual saved cycle. See [quote audit](quote-proof-audit.json) and [committed observation](recorded-cycle-before-restart.json).
- Restarting only the new container preserved its original start/review dates, frozen manifest, cash and receipt ledgers, and continued the journal sequence. This live restart occurred before any eligible trade; synthetic tests cover recovery of a committed fill after a failed head write without a duplicate debit. See [restart audit](restart-audit.json).
- Source, compiled modules, WebSocket library bytes, runtime version, configuration and research inputs were frozen before collection. Current workspace fingerprints matched the deployed manifest at the final check. See [manifest](runtime-manifest.json) and [deployment record](deployment.json).

The fee assumption is the published entry-tier Kraken Pro spot taker fee of **0.80% per side**, checked September 10, 2026. Private-account discounts are not assumed. [Kraken fee schedule](https://www.kraken.com/features/fee-schedule). Recorded fills walk the appropriate displayed depth, obey lot/minimum rules, and include fees in cash debits.

Inventory reporting uses fresh best bids less the assumed exit fee. These are marks, not guaranteed full-position liquidation proceeds; actual exits obey depth limits, and residual inventory remains recorded. Drawdown is sampled. Runtime book integrity is validated locally by the market adapter; event restoration checks hashes and accounting rather than independently replaying every historical signal and book update. The deployment audit additionally checked the actual captured quote proofs.

The economic review date is **March 10, 2027 at 20:13:41.861 UTC**. Fewer than ten completed ETH40 episodes remains inconclusive. Historical qualification failures are retained, and there is no automatic promotion or live trading adapter.

The earlier nomination remains an immutable record of the pre-implementation proposal. This deployment report records the subsequent implementation and actual collection start.

## Access

On the host, open `http://127.0.0.1:3003/` or use an SSH tunnel. Read-only status is available at `/api/status`, with full funded account receipts at `/api/receipts` and the frozen manifest at `/api/manifest`.

The container is `crypto-eth40-paper`; its volume is `crypto_trade_eth40_observation_v1`. [Operating instructions](../../docs/ETH40_FORWARD_OBSERVATION.md) describe the strategy, timing, cost assumptions, persistence and restart commands.

## Storage capacity

The host filesystem was 82% used with approximately 9.1 GiB free at deployment. Using the captured 5,889-byte cycle and two raw daily-history responses totaling 142,243 bytes, the current 30-second observation / five-minute history cadence projects approximately **9.8 GiB over 181 days**, before filesystem overhead, growing receipt lists or other services' records. This is an estimate from initial samples, not measured long-term usage.

Collection has sufficient space to start, but the full six-month trial requires additional durable capacity or a reviewed retention/compression design that preserves referenced evidence and account history. No storage was provisioned and no historical records were deleted. A disk write failure stops accounting rather than silently dropping evidence. Capacity planning remains an operational follow-up.
