# Risk-governed BTC/ETH portfolio revision

The first persistent-inventory rebuild generated trades and positive 2024 net PnL, but its maximum drawdown exceeded the fixed $3 limit. Its simple 90-day benchmark earned more and also failed the risk limits. Version 2 turns those limits into controls on executable exposure and permits the simple strategy to win a declared development comparison. It preserves every source seal and failed result of version 1.

For liquidation equity E, the governor tracks its prior peak P and the current UTC day's starting liquidation equity B. It sets the shared dollar exposure limit to:

```
drawdown = max(0, P - E)
dailyLoss = max(0, B - E)
cap = 12 * min(1, max(0, 1 - drawdown / 3), max(0, 1 - dailyLoss / 1.2))
governedTarget = originalTarget * cap / 12
```

Liquidation equity includes recorded funding and the modeled cost of closing held positions. The governor observes it before planning and after fills. The portfolio allocator enforces the resulting cap after rounding to venue lots. It reduces excess inventory before permitting additions, even when the ordinary trading deadband would otherwise retain the position. A cap smaller than the minimum lot can mean holding cash.

A drawdown breach or unknown accounting latches a halt. A daily-loss breach blocks risk until the next UTC day. Losses and historical peaks survive checkpoint serialization; no loss reset is used to reopen capacity. Requests to reduce inventory retry when quotes or candle liquidity resume. Price gaps and execution interruptions can still breach a budget, and the report retains those breaches. This is an execution risk control, not a mathematical guarantee of returns or maximum loss.

The exposure rule follows the general idea of allocating risk in proportion to the remaining loss budget. [Cont and Tankov's CPPI research](https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1467-9965.2009.00377.x) explains why jumps can breach such controls. Research on [portfolio selection with drawdown control](https://web.stanford.edu/~boyd/papers/multiperiod_portfolio_drawdown.html) provides related motivation; this implementation does not reproduce that paper's model or inherit its empirical results.

## Selection and verification

The two candidates are the unchanged multiscale signal and the unchanged 90-day trend rule, both with the same governor. Eligibility requires complete cost accounting, positive BTC and ETH net results, meaningful exposure, at least 99% target coverage, maximum marked and liquidation drawdown of $3, and a maximum daily loss of $1.20 in every scenario. Both the closing daily loss and the largest observed intraday liquidation loss from the daily reference must meet that limit. A recovery by day end cannot hide an intraday breach. Eligible candidates are ranked by their worst-scenario net PnL minus half their worst marked or liquidation drawdown. An exact tie favors the simple rule.

The multiscale candidate must also exceed the governed simple rule's utility in every scenario. If the simple rule wins, the report identifies it explicitly and makes no claim that the complex model adds predictive value. Governed constant BTC/ETH holdings and both ungoverned signals remain visible as cost-matched comparisons.

Selection uses 2024 only and is frozen before 2025 confirmation. Both years were previously studied and cannot be described as untouched. Only a passing frozen candidate can open the reserved January–July 2026 test, where paired weekly confidence intervals must also pass. Each declared study period starts with a flat account and a fresh risk state; the results are not a continuous multi-year equity curve. Fees, slippage, delays, funding interpretations, historical rules, the $12 cap and the original risk limits remain fixed. No risk parameter grid search is performed.

```
npx tsx src/portfolio-v2/study-main.ts register OLDER_DATASET RECENT_DATASET OUTPUT_DIRECTORY
npx tsx src/portfolio-v2/study-main.ts develop OLDER_DATASET RECENT_DATASET OUTPUT_DIRECTORY
npx tsx src/portfolio-v2/study-main.ts confirm OLDER_DATASET RECENT_DATASET OUTPUT_DIRECTORY
npx tsx src/portfolio-v2/study-main.ts test OLDER_DATASET RECENT_DATASET OUTPUT_DIRECTORY
```

Registration seals source code, protocol, instrument rules and data before any v2 returns are computed. Each stage records full executions, risk decisions, funding and equity, plus compact summaries and integrity hashes. Later stages reject failed or changed evidence before loading market data. Execution is a historical candle proxy; funding timestamp interpretations remain sensitivities, not proven bounds. Funding changes liquidation equity and can therefore change subsequent trades under the governor. The scenarios share an algorithm and cost rules, not necessarily identical fills.

The v2 adapter currently runs historical replay. A future public-market adapter must supply a causal UTC-boundary equity observation and complete funding coverage before it can use this governor. Irregular book callback times alone do not satisfy the boundary contract; missing it halts risk. The v1 public-market controller does not silently inherit the new governor.

## Status

Implementation and both historical stages are complete. All 956 software tests and the TypeScript build pass. Independent audits reconciled all 40 governed runs across the two years, their execution/funding records, risk observations and selection gates. The 2024 comparison selected the governed 90-day rule. Selection was frozen before 2025; it was not changed after seeing that year's outcome.

| Frozen 90-day strategy | 2024 development | 2025 confirmation |
| --- | ---: | ---: |
| Base net PnL after modeled costs | +$3.73 | −$0.94 |
| Stress net PnL after modeled costs | +$3.25 | −$0.85 |
| Largest marked drawdown across scenarios | $2.22 | $2.19 |
| Largest observed daily liquidation loss | $0.57 | $0.42 |
| Result | Economic and risk gates passed | Failed profit and BTC exposure gates |

Figures use the shared $12 maximum gross-notional budget. Both funding-timestamp interpretations are included in each rounded scenario figure. These are separate annual simulations, not compounded returns on a continuously traded account. The 2024 weekly confidence interval still included losses; passing development did not establish statistical evidence of future profit.

The governor cut the simple strategy's 2024 liquidation drawdown by about 33% and net profit by about 43% relative to its ungoverned version. It reduced exposure rather than improving the underlying signal. In 2025 the selected strategy's funding and execution accounting is complete, and its losses are not classified as unknown. BTC exposure was only 302–309 hours against the fixed 720-hour minimum; ETH lost money in every scenario.

The selected strategy stopped trading on May 10, 2025 and stayed flat through year end, although daily targets continued arriving and no hard risk halt was latched. In the base scenario, liquidation drawdown left a $3.25 exposure cap. The next BTC minimum lot cost about $10.32. An ETH lot cost about $2.50, but its desired exposure was only about $1.18; holding cash minimized the declared tracking/cost objective. With no inventory, account equity could not recover and restore capacity. This is a structural failure of this signal/sizing combination at the specified lot sizes, not evidence that forcing an extra entry would be profitable.

The failed confirmation gate denied the reserved January–July 2026 test before a test-start marker was written. No candidate has been activated, and the running paper engine has not been switched to this revision. Results and complete execution artifacts are in `reports/portfolio-risk-study-2026-09-09/`.

Separate funding-only checks recovered substantial additional official history and verified 3,612 exact archive/API overlaps per asset. Seven 2025 source gaps and three 2026 source gaps remain unresolved. Other comparison policies encountered missing funding and correctly report unknown net PnL. The recovered responses are preserved separately in `reports/portfolio-funding-extension-2026-09-09/`; they were not inserted into this sealed study.

The independent accounting/risk auditor is preserved in `tools/portfolio-risk-audit.mjs`. Its synthetic evidence can be reproduced without market data:

```
gzip -dc reports/portfolio-v2-independent-synthetic-fixtures-2026-09-09.json.gz > /tmp/portfolio-v2-audit-fixtures.json
node tools/portfolio-risk-audit.mjs --synthetic
```

The audit reconstructs signed cash flows, liquidation marks, risk budgets and receipt hashes independently of the trading implementation. Altered fees, funding, risk caps, peaks and missing observations are negative controls and must be rejected.
