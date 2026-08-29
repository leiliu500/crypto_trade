# Rejected-entry counterfactual audit — 2026-08-29

Run: `578e93be-7ecd-4813-8d91-f2618e4e0b6a`

Configuration: `btc-eth-entry-availability-v7.1.0`

Rejected final route evaluations: 11 (`BTC/USD`: 5, `ETH/USD`: 6; 10 long, 1 short)

The audit uses the recorded top of book. The taker case buys at ask/sells at bid on entry, exits across the book, and deducts the configured 5 bps taker fee on both legs. The maker case is explicitly conditional on receiving a fill at the entry touch, then exits as a taker and deducts the configured 2 bps maker plus 5 bps taker fees.

| Horizon | Taker wins | Taker average | Maker-if-filled wins | Maker-if-filled average |
|---:|---:|---:|---:|---:|
| 1 second | 0 / 11 | -10.08 bps | 0 / 11 | -6.76 bps |
| 5 seconds | 0 / 11 | -10.92 bps | 0 / 11 | -7.60 bps |
| 30 seconds | 0 / 11 | -9.48 bps | 3 / 11 | -6.16 bps |
| 1 minute | 2 / 11 | -8.47 bps | 3 / 11 | -5.16 bps |
| 5 minutes | 5 / 11 | -3.98 bps | 6 / 11 | -0.66 bps |
| 15 minutes | 5 / 11 | -7.94 bps | 5 / 11 | -4.63 bps |
| 1 hour | 0 / 11 | -20.16 bps | 0 / 11 | -16.84 bps |
| 2 hours | 5 / 11 | -2.13 bps | 6 / 11 | +1.19 bps |
| 4 hours | 9 / 11 | +10.72 bps | 9 / 11 | +14.04 bps |

## Interpretation

The current evidence does not justify lowering the reward/risk or maker-fill thresholds. Every forced taker entry lost after fees through one hour, and the strategy's 15-minute unproductive-exit horizon was negative on average. The positive four-hour result is useful research evidence, but not proof that these orders should have been accepted: ten signals were clustered within roughly five minutes, so they are not independent trades, and the counterfactual excludes stops, market impact, latency, adverse selection, funding, and overlapping-position constraints.

Re-run the machine-readable report with:

```sh
npm run report:rejected-entries
```
