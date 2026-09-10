The fixed daily 55/20 channel candidate failed its declared historical development screen. Runtime activation remains false.

| Period | Cost case | Policy | Episodes | Net after costs/funding | Fees | Funding | Hourly close drawdown |
|---|---|---|---:|---:|---:|---:|---:|
| 2024 | base | channel | 15 | $70.82 | $9.32 | $-78.25 | $380.19 |
| 2024 | stress | channel | 15 | $53.39 | $13.91 | $-79.33 | $425.32 |
| 2025 H1 | base | channel | 5 | $153.73 | $2.65 | $-6.63 | $138.26 |
| 2025 H1 | stress | channel | 6 | $-13.34 | $4.32 | $-6.75 | $114.71 |

Base closed episodes: 20. Complete base weeks: 77. Four-week moving-block bootstrap lower 5% mean weekly net: $-3.13.

Descriptive cash benchmark: $0. Constant-unit long perpetual benchmarks:

| Period | Cost case | Policy | Episodes | Net after costs/funding | Fees | Funding | Hourly close drawdown |
|---|---|---|---:|---:|---:|---:|---:|
| 2024 | base | buy-hold-btc | 1 | $910.61 | $1.59 | $-266.40 | $653.97 |
| 2024 | base | buy-hold-eth | 1 | $239.47 | $1.23 | $-220.01 | $921.02 |
| 2024 | stress | buy-hold-btc | 1 | $901.37 | $2.37 | $-265.25 | $650.88 |
| 2024 | stress | buy-hold-eth | 1 | $233.39 | $1.84 | $-218.95 | $916.31 |
| 2025 H1 | base | buy-hold-btc | 1 | $114.19 | $1.07 | $-34.34 | $367.60 |
| 2025 H1 | base | buy-hold-eth | 1 | $-266.03 | $0.87 | $-10.33 | $687.07 |
| 2025 H1 | stress | buy-hold-btc | 1 | $121.34 | $1.60 | $-34.31 | $367.41 |
| 2025 H1 | stress | buy-hold-eth | 1 | $-263.65 | $1.31 | $-10.37 | $691.35 |

This single candidate was sealed with source copies before its first economic replay. Both historical periods were reused after prior candidate failures. No parameter grid or 2026 performance was evaluated.

- Prior candidate failures and repeated use of 2024/2025 make this development evidence, not untouched validation.
- Hourly trade candles do not prove executable books, price-impact depth, exact intrahour chronology, or live latency.
- Stops use adverse execution and charge paying funding for the whole touched hour while dropping receiving funding; this is a conservative timing bound, not exact observed cash.
- Drawdown uses hourly liquidation closes. The additional downside envelope uses prior close peaks, not intrahour high-water marks.
- The sum of separate adverse asset extremes is a risk envelope rather than synchronized observed portfolio prices.
- Known positive candle volume is a retrospective fill availability proxy; intrahour arrival and partial fills remain unobserved.
- Passive comparators are independent constant-unit paths with $1000 entry caps; later mark notional can exceed the entry cap. They are descriptive, not risk-matched alternatives.
- Quoted fees, ticks, minimum quantities and known-at-hour-start funding are declared assumptions rather than verified historical account entitlements.

Full orders, partial reductions, episodes, hourly marked equity, calendar daily net changes, missing data and unresolved positions are retained in each run JSON. No future profit is guaranteed.
