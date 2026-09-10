"""Produce a reviewable report and CSV from the locked study's actual outputs."""
import csv
import datetime as dt
import json
from common import ROOT

def money(x):
    return f'{"−" if x < 0 else "+" if x > 0 else ""}${abs(x):,.2f}'

def main():
    c=json.loads((ROOT/'comparison.json').read_text())
    detail=json.loads((ROOT/'final-detail.json').read_text())
    sens=json.loads((ROOT/'sensitivity.json').read_text())
    lock=json.loads((ROOT/'final-selection-lock.json').read_text())
    labels={'trend':'Statistical trend / CUSUM','reversion':'OU mean reversion','rotation':'BTC/ETH momentum rotation','cash':'Cash','buy-hold-btc':'BTC buy-and-hold','buy-hold-eth':'ETH buy-and-hold'}
    rows=[]
    for f in labels:
        b,s=c['final'][f]['base'],c['final'][f]['stress']
        trades=detail[f]['base']['trades']
        natural=sum(t['exitReason']!='terminal' for t in trades)
        terminal=sum(t['exitReason']=='terminal' for t in trades)
        rows.append(f'| {labels[f]} | {money(b["netPnlUsd"])} | {money(s["netPnlUsd"])} | ${b["maxDrawdownUsd"]:,.2f} | {b["closedTrades"]} ({natural}/{terminal}) |')
    validation=[]
    for f in ['trend','reversion','rotation']:
        v=c['validation'][f]
        validation.append(f'| {labels[f]} | {money(v["base"]["netPnlUsd"])} | {money(v["stress"]["netPnlUsd"])} | {v["base"]["closedTrades"]} |')
    zero='; '.join(f'{labels[f]} {money(sens[f]["feeOnly"][0]["netPnlUsd"])}' for f in ['trend','reversion','rotation'])
    ci='\n'.join(f'| {labels[f]} | {money(c["confidence"][f]["cash"]["nominalOneSided95LowerNetUsd"])} | {money(c["confidence"][f]["cash"]["twelveTrialAdjustedLowerNetUsd"])} |' for f in ['trend','reversion','rotation'])
    text=f'''# Parallel spot strategy experiments — 10 September 2026

**No tested candidate qualifies as a profitable replacement.** Three independent agents implemented three different mathematical systems and tested four predeclared variants each. The family selected before the final test was BTC/ETH momentum rotation. It earned money in the second half of 2025, then lost money in the 2026 comparison. Selecting the least-losing 2026 strategy afterward would introduce another selection bias.

The work produced research implementations, reproducible backtests, order/trade ledgers, and audits. It did not change the running paper strategy, dashboard, caps or account, and did not submit exchange orders. These research modules are not a replacement execution engine.

## Final comparison

**1 January–9 September 2026 inclusive**, native BTC/USD and ETH/USD spot daily candles. Each replay starts with **$10,000 cash** and a **maximum $1,000 fee-inclusive entry budget**, further limited to 10% of current equity. There is one funded long position at a time. Dollar profits below are total account changes; they are not returns on a fully invested $10,000 portfolio.

| Approach | Net, base costs | Net, cost + delay stress | Base maximum drawdown | Closed episodes (strategy exit / forced final exit) |
|---|---:|---:|---:|---:|
{chr(10).join(rows)}

All closing values include selling fees, adverse prices and tick rounding. Drawdown uses daily liquidation equity; intraday-low drawdown is also recorded in the JSON. The trend candidate had one entry and **no strategy-triggered exit** in this period; its episode was closed by the test's terminal-liquidation convention. Rotation had three strategy exits and one forced terminal exit. Its profitable final ETH holding was included after paying liquidation costs, yet total net performance remained negative.

Cash preserved capital in this sample. It is a benchmark, not a profit-generating strategy. The current weekly production rule was not replayed as a competing fourth model; the earlier weekly study has a different horizon and sizing and cannot be compared directly with these dollar results.

## What each agent built

1. **Statistical trend / CUSUM.** Standardize daily log returns with past volatility, accumulate evidence for positive and negative drift, and enter only after enough upward evidence and a drift hurdle. Exit on reversal evidence, nonpositive drift or a 90-day limit. Selected parameters: 28-day EWMA half-life and evidence threshold 6. [Formula and development results](trend/report.md).
2. **OU mean reversion.** Fit a rolling AR(1) model to deviations from a causal moving trend, estimate equilibrium and reversion half-life, reject unstable/falling regimes, and buy only a sufficiently large discounted excursion. Exit on normalization, invalidation, holding limit or a close-based stop. The selected patient variant did not trade in development; it later traded and lost. [Formula and development results](reversion/report.md).
3. **BTC/ETH momentum rotation.** Use 60-day relative momentum and a 90-day absolute trend condition to choose one asset or cash, with a cost hurdle and hysteresis to reduce unnecessary switches. The extrapolated drift is a heuristic, not a calibrated expected-return guarantee. [Formula and development results](rotation/report.md).

CUSUM is a method for detecting persistent shifts; applying it to returns does not establish profitable predictability. [NIST CUSUM reference](https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc323.htm).

## Selection and validation

The data contains 720 completed daily bars per symbol, beginning 20 September 2024. Earlier bars provide warmup. Each agent selected one of four fixed variants on **January–June 2025**, maximizing stressed net profit minus half dollar drawdown. The development winner of mean reversion was zero-trade cash behavior, which is explicitly a failed activity candidate. No losing variant was silently substituted to produce more entries.

Root independently recalculated those selections, evaluated only **July–December 2025**, and locked the family ranking before invoking the final evaluation. The selection lock timestamp is `{lock['lockedAt']}`.

| Frozen family candidate | Validation base net | Validation stress net | Closed episodes |
|---|---:|---:|---:|
{chr(10).join(validation)}

Rotation's validation profit depended on one ETH episode earning **$544.03**, followed by a **$82.44** loss. That concentration and its later losses weaken the case for a repeatable edge. Its development stress result was also negative. CUSUM happened to have the smallest final loss, but it was not the preselected winner and had only one final episode.

The historical dates overlap earlier research in this repository. The chronological split therefore **is not untouched or prospective evidence**. Trying more models on familiar data can overstate confidence; all 12 variants are retained rather than reporting only an attractive result. [Bailey et al., The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf).

## Fees, position cap and execution assumptions

Base fees are the current paper research assumption, **80 basis points per side**, plus 3 basis points adverse price per side. Stress uses 100 basis points and 10 basis points respectively, plus one extra daily bar of execution delay. These are configured assumptions, not a verified fee tier for the user's real account. Kraken's actual fee schedule depends on the applicable product and tier. [Kraken fee schedule](https://www.kraken.com/features/fee-schedule).

Ignoring tick rounding, a base-cost round trip needs a reference-price rise of approximately **1.674%** just to break even:

`required rise = ((1 + fee) * (1 + slippage)) / ((1 - fee) * (1 - slippage)) - 1`

The fee-only diagnostic keeps signal and execution timing fixed. Even at **zero commissions**, while retaining 3-basis-point adverse execution, final results are negative: {zero}. Fees worsen performance, but reducing them alone did not create a profitable edge in these candidates.

A separate $100 entry-cap / $100,000-cash sensitivity is saved in `sensitivity.json` under the historical key `currentPaperSizing`. This is **approximate $100 exposure sensitivity**, not an exact reproduction of the current runtime's 0.1%-of-equity rule. It also loses money for all three candidates. Changing the cap changes exposure and dollar outcomes; it does not establish positive expectancy. Benchmark sizing was used only in research and was not applied to the running system.

Completed daily bar i becomes eligible after its close plus 60 seconds. Base targets fill at open i+2 and stress at open i+3. Position changes use adverse tick-rounded prices, lot flooring, minimum quantity/notional, sufficient cash, and at most 0.1% of the latest finalized daily volume. The volume reference was corrected from i−1 to i−2 after independent review; all development results remained unchanged. A terminal sale at the final close is an explicit retrospective valuation convention.

Extra delay can occasionally improve a fill, so the combined stress scenario is not a guaranteed worst case. A separate same-delay cost stress is also saved. Daily trade aggregates do not establish executable bid/ask prices, depth, stop paths or order acceptance. They cannot show whether a five-minute evaluator missed an intraday opportunity. The exchange's OHLC endpoint has a limited recent history and includes an unfinished final row; that row was excluded here. [Kraken OHLC documentation](https://docs.kraken.com/api-reference/market-data/get-ohlc-data).

## Uncertainty and qualification

There are only 1–4 final episodes per selected model, too few to support dependable profitability claims. All candidates fail the predeclared positive final-net requirement and the minimum ten combined validation/final episodes. The 14-day paired block bootstrap also gives negative lower bounds versus cash:

| Candidate | Nominal one-sided 95% lower net bound | 12-trial-adjusted lower net bound |
|---|---:|---:|
{ci}

The 5,000 bootstrap replicates preserve local dependence approximately, not every market regime. The trial adjustment covers these 12 variants only; earlier unknown searches, nonstationarity and sparse trades mean these are descriptive diagnostics, not validated confidence guarantees. Paired comparisons against the development-selected BTC buy-and-hold baseline also fail the positive lower-bound criterion.

## Recommendation

**Do not promote any of these three candidates as a profit solution.** Keep the frozen selection and failed final results as evidence. There is no demonstrated profitable winner to rebuild the active system around.

The next useful experiment needs executable evidence: confirm the account's actual fee tier, record synchronized books and signals, and measure whether a fixed candidate's favorable movement exceeds round-trip costs on subsequently collected data. Record rejected opportunities as well as fills so the failure can be assigned to the signal, transaction costs or execution. Choose any further strategy from that measured effect before opening another evaluation period; widening entry gates or increasing capital without positive net expectancy would not solve this result.

For entries that qualify in such an experiment, event-driven book monitoring and serialized order handling can then test execution latency. Faster evaluation is an execution improvement to measure separately; these daily tests neither establish nor refute an intraday edge. No future profits are guaranteed.

## Reproduction and verification

The study uses Python's standard library and the saved, hashed native spot responses. No network, runtime or exchange access is needed to reproduce the comparison:

```bash
python3 reports/parallel-strategy-study-2026-09-10/audit.py
python3 reports/parallel-strategy-study-2026-09-10/compare.py validate
python3 reports/parallel-strategy-study-2026-09-10/compare.py final
python3 reports/parallel-strategy-study-2026-09-10/write_report.py
```

`accounting-audit.json` records ten audit groups, including 96 real-data prefix-invariance checks across all variants, independent order-ledger cash reconciliation, delayed fills, no additions, terminal inventory, rotation funding and minimum-size rejections. Each agent also ran synthetic signal tests and independently reviewed the common evaluator. Final independent audits are retained in each candidate directory.

Key artifacts: [protocol](protocol.json), [selection lock](final-selection-lock.json), [comparison](comparison.json), [full final trade/equity ledgers](final-detail.json), [fee and size sensitivity](sensitivity.json), [CSV](comparison.csv), and the three candidate directories. The original raw responses and normalized data hashes are retained under `data/`.
'''
    (ROOT/'report.md').write_text(text)
    with (ROOT/'comparison.csv').open('w',newline='') as handle:
        writer=csv.writer(handle)
        writer.writerow(['period','model','scenario','netPnlUsd','accountReturnPct','entryBudgetUsd','closedEpisodes','strategyExits','terminalExits','maxDrawdownUsd','feesUsd'])
        for name,by in c['final'].items():
            for scenario,r in by.items():
                trades=detail[name][scenario]['trades']
                writer.writerow(['2026-01-01/2026-09-10',name,scenario,r['netPnlUsd'],r['returnOnAccountPct'],r['entryBudgetUsd'],r['closedTrades'],sum(t['exitReason']!='terminal' for t in trades),sum(t['exitReason']=='terminal' for t in trades),r['maxDrawdownUsd'],r['feesUsd']])
    print(json.dumps(dict(report=str(ROOT/'report.md'),qualified=c['anyCandidateQualified'])))

if __name__=='__main__':
    main()
