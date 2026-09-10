The new BTC spot trend system was deployed as a separate research paper service on September 10, 2026 at 05:49 UTC. It is healthy, and a container restart preserved its original ledger, cash, inventory and source-bound evidence. The existing futures engine retains its original image and 00:04 UTC start time.

**The historical economic screen passes; future profitability is unvalidated. No forward trades or profits have occurred yet.**

| Historical January 2017–September 2026 | Base | Higher costs and one extra week of delay |
|---|---:|---:|
| Trend net after fees | $1,175.60 | $1,228.51 |
| Completed episodes | 11 | 11 |
| Trend weekly-close drawdown | $584.28 | $575.09 |
| Costed BTC buy-and-hold net | $6,609.16 | $6,572.98 |

The simulated account starts with $100,000; the initial purchase budget is $100 including fees. Base profit is approximately 1.176% of the whole account over almost ten years, not an annual return or the return of an independently funded $100 account. Buy-and-hold earned more with greater exposure and drawdown. The lower 5% bootstrap mean remains negative, at −$0.4782 per week. These limitations remain part of the qualification for a small research paper experiment.

The new strategy uses a fixed 40-week BTC spot trend state, a cost-scaled turnover band, fully funded inventory, no additions, and USD cash during weak trends. Live exchange orders are unavailable. Paper fills require fresh actual spot depth, venue minimums, a 10-basis-point price collar, and at most 5% of eligible displayed quantity. Its kernel lock, immutable cycle evidence and durable receipt ledger protect restart continuity. Stale history blocks entries while fresh books still support protective exits.

Current forward verification: **$100,000 cash, 0 BTC, 0 fills, $0 realized and marked profit**. The delayed signal is long, but the first-hour weekly entry window has passed. The next possible window is **2026-09-17T00:00:00Z to 2026-09-17T01:00:00Z**, conditional on the signal, data, liquidity and risk checks at that time. No historical or catch-up fill is inserted.

All 71 new tests and the full TypeScript build passed. The independent historical audit passed 73,337 assertions over 24 runs and 116 fills. The exact compiled Docker image also passed source-evidence and kernel-lock verification with networking disabled. The two public-data smoke cycles and actual container restart preserved balances; they were flat-state continuity checks, while synthetic tests separately cover fills, exits, partials and failures.

- Container: `crypto-spot-trend-paper`
- Image: `sha256:b4fdc723b05fbee3bdeb66eda4eb686ea7ae92a779fad590deeadaaee3a6da7d`
- Separate volume: `crypto_trade_spot_trend_research`
- Local status: `http://127.0.0.1:3002/status`
- Local health: `http://127.0.0.1:3002/healthz`
- Research evidence SHA256: `3eed46dd2a5f17dc48e87e190243971754b1c7b0394ebcadb4eb289d30ebb509`

[Implementation and operation](../../../docs/SPOT_TREND_SYSTEM.md), [complete historical results](../historical-study/report.md), [independent audit](../audit.json), and [deployment checks](report.json).
