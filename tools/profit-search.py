#!/usr/bin/env python3
"""Reproducible exploratory search. Reads frozen candles; cannot place orders.

These dates have already been studied. Chronology reduces direct selection
leakage but cannot make this an untouched holdout or establish future profit.
"""
import argparse
import csv
import datetime as dt
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import statistics

REPO = Path(__file__).resolve().parents[1]
PRIOR = REPO / 'reports/parallel-strategy-study-2026-09-10'
PERIODS = {'development': ('2025-01-01', '2025-07-01'),
           'later_2025': ('2025-07-01', '2026-01-01'),
           'recent_2026': ('2026-01-01', '2026-09-10')}
SCENARIOS = {
    'base': dict(feeBps=80, slippageBps=3, signalToOpenBars=2),
    'cost': dict(feeBps=100, slippageBps=10, signalToOpenBars=2),
    'delay': dict(feeBps=80, slippageBps=3, signalToOpenBars=3),
    'combined': dict(feeBps=100, slippageBps=10, signalToOpenBars=3),
}
LOOKBACKS = [10, 15, 20, 30, 40, 50, 60, 70, 80, 90]
FAMILIES = ['sma_btc', 'sma_eth', 'momentum_btc', 'momentum_eth',
            'channel_btc', 'channel_eth', 'pullback_btc', 'pullback_eth',
            'rotation', 'consensus_btc']
# A turnover band, not an estimate of future price movement.
BAND = ((1 + .008) * (1 + .0003) / ((1 - .008) * (1 - .0003))) - 1


def read_common():
    spec = importlib.util.spec_from_file_location('profit_search_accounting', PRIOR / 'common.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


def candidates():
    return [dict(id=f'{family}-{n:03d}', family=family, lookbackDays=n)
            for family in FAMILIES for n in LOOKBACKS]


def targets(candidate, data):
    """Causal desired asset after each completed bar; execution adds its lag."""
    family, n = candidate['family'], candidate['lookbackDays']
    closes = {s: [b['close'] for b in bars] for s, bars in data.items()}
    length = len(closes['BTC/USD'])
    held, output = None, []
    symbol = 'ETH/USD' if family.endswith('_eth') else 'BTC/USD'
    for i in range(length):
        # Common warmup removes differential availability between families.
        if i < 90:
            output.append(None)
            continue
        window = closes[symbol][i - n + 1:i + 1]
        current = closes[symbol][i]
        if family.startswith('sma_'):
            mean = statistics.fmean(window)
            if current > mean * (1 + BAND):
                held = symbol
            elif current <= mean:
                held = None
        elif family.startswith('momentum_'):
            momentum = current / closes[symbol][i - n] - 1
            if momentum > BAND:
                held = symbol
            elif momentum <= 0:
                held = None
        elif family.startswith('channel_'):
            prior = closes[symbol][i - n:i]
            if current > max(prior) * (1 + BAND):
                held = symbol
            elif current < min(prior[-max(5, n // 2):]):
                held = None
        elif family.startswith('pullback_'):
            mean, sigma = statistics.fmean(window), statistics.pstdev(window)
            trend = statistics.fmean(closes[symbol][i - 89:i + 1])
            z = (current - mean) / sigma if sigma > 0 else 0
            if held is None and current > trend and z < -1 and mean / current - 1 > BAND:
                held = symbol
            elif held is not None and (z >= 0 or current <= trend):
                held = None
        elif family == 'rotation':
            scores = {}
            for asset in ('BTC/USD', 'ETH/USD'):
                c = closes[asset][i]
                mom = c / closes[asset][i - n] - 1
                ma = statistics.fmean(closes[asset][i - 89:i + 1])
                if c > ma * (1 + BAND) and mom > BAND:
                    scores[asset] = mom
            best = max(scores, key=lambda s: (scores[s], s)) if scores else None
            if held not in scores or (best is not None and scores[best] > scores[held] + BAND):
                held = best
        elif family == 'consensus_btc':
            spans = [max(3, n // 3), max(6, 2 * n // 3), n]
            means = [statistics.fmean(closes[symbol][i - k + 1:i + 1]) for k in spans]
            if sum(current > mean * (1 + BAND) for mean in means) >= 2:
                held = symbol
            elif sum(current < mean * (1 - BAND) for mean in means) >= 2:
                held = None
        else:
            raise ValueError(f'Unknown candidate family {family}')
        output.append(held)
    return output


def screen_summary(runs):
    all_runs = [r for period in runs.values() for r in period.values()]
    later = [r for key in ('later_2025', 'recent_2026') for r in runs[key].values()]
    positive = all(r['netPnlUsd'] > 0 for r in all_runs)
    adequate = all(sum(runs[p][s]['closedTrades'] for p in ('later_2025', 'recent_2026')) >= 10
                   for s in SCENARIOS)
    drawdown = all(r['maxIntradayLowDrawdownUsd'] <= 500 for r in later)
    return dict(developmentUtility=min(r['selectionUtility'] for r in runs['development'].values()),
                minimumNetAcrossAllRunsUsd=min(r['netPnlUsd'] for r in all_runs),
                worstLaterWindowNetUsd=min(r['netPnlUsd'] for r in later),
                positiveAllWindowsAndScenarios=positive,
                atLeastTenLaterEpisodesEveryScenario=adequate,
                laterLowDrawdownWithin500Usd=drawdown,
                exploratoryScreenPassed=positive and adequate and drawdown,
                validatedProfitable=False)


def assert_data(data):
    assert set(data) == {'BTC/USD', 'ETH/USD'}
    times = [[b['openMs'] for b in data[s]] for s in ('BTC/USD', 'ETH/USD')]
    assert times[0] == times[1] and len(times[0]) > 600
    assert all(b - a == 86_400_000 for a, b in zip(times[0], times[0][1:]))
    for bars in data.values():
        for b in bars:
            assert all(math.isfinite(b[k]) and b[k] > 0 for k in ('open', 'high', 'low', 'close', 'volume'))
            assert b['low'] <= min(b['open'], b['close']) <= max(b['open'], b['close']) <= b['high']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path, help='A NEW output directory')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    common = read_common()
    data = common.load_data(development_only=False)
    assert_data(data)
    specs = candidates()
    protocol = dict(version='exploratory-100-spot-configurations-v1',
                    registeredAt=dt.datetime.now(dt.timezone.utc).isoformat(),
                    actualAgents=4, configurations=100, distinctFamilies=10,
                    researchOnly=True, historicalDataAlreadyReused=True,
                    activationAllowed=False, validatedProfitable=False,
                    initialCashUsd=10000, entryBudgetUsd=1000,
                    entryEquityFraction=.1, periods=PERIODS, scenarios=SCENARIOS,
                    bandFraction=BAND, candidates=specs,
                    selection='Lock maximum minimum-scenario development (net minus 0.5 close drawdown); ties by ID. Do not reselect on later windows.',
                    nomination='All 12 window/scenario nets positive, >=10 combined later closed episodes in EACH scenario, all later intraday-low drawdowns <=$500. Nomination is exploratory, never validation.',
                    accounting='One funded long asset or cash, no additions/shorts. Entry cash includes fees. 10% equity entry limit; marked exposure may grow. No runtime mark-cap/halt parity.',
                    timing='Signals from completed bar i, fill at i+2 or i+3 open. Liquidity cap from i-2 volume. Period accounts reset; end flattened at final close with costs.',
                    limitations=['Daily OHLC fills do not prove executable depth, spread, fills or stop paths.',
                                 'Current public fee assumptions applied to all dates; real account tier unverified.',
                                 'All dates previously studied. No untouched holdout, no prospective evidence.',
                                 '100 related variants are not 100 independent strategies or independent agents.',
                                 'Profit excludes taxes and computing/infrastructure costs; idle cash earns zero.',
                                 'Current weekly runtime is not a matched daily-data benchmark; 40-week warmup unavailable at development start.',
                                 'Reset-period net dollars are not a continuous compounded portfolio.',
                                 'Ten episodes is only a screening floor, not a statistical proof.'],
                    sources={str(p.relative_to(REPO)): sha(p) for p in
                             [Path(__file__).resolve(), PRIOR/'common.py', PRIOR/'protocol.json',
                              PRIOR/'data/dataset.json', PRIOR/'data/rules.json']})
    save(args.out/'protocol.json', protocol)
    target_bank = {c['id']: targets(c, data) for c in specs}
    rows = {c['id']: dict(candidate=c, runs={}) for c in specs}
    for period, (start, end) in PERIODS.items():
        for c in specs:
            rows[c['id']]['runs'][period] = {
                s: common.evaluate(target_bank[c['id']], data, start, end, settings)
                for s, settings in SCENARIOS.items()}
        if period == 'development':
            ranking = sorted(rows, key=lambda cid: (-min(r['selectionUtility'] for r in rows[cid]['runs'][period].values()), cid))
            selected_id = ranking[0]
            save(args.out/'development-lock.json', dict(
                lockedAt=dt.datetime.now(dt.timezone.utc).isoformat(), selectedId=selected_id,
                ranking=ranking, developmentRuns=rows[selected_id]['runs']['development'],
                caveat='Locked before this run computes later windows; dates already known from past research.'))
    for row in rows.values():
        row['summary'] = screen_summary(row['runs'])
    baselines = {}
    for label, target in [('cash', None), ('buy_hold_btc', 'BTC/USD'), ('buy_hold_eth', 'ETH/USD')]:
        baselines[label] = {p: {s: common.evaluate([target]*len(data['BTC/USD']), data, start, end, settings)
                                for s, settings in SCENARIOS.items()}
                            for p, (start, end) in PERIODS.items()}
    save(args.out/'all-results.json', list(rows.values()))
    save(args.out/'baselines.json', baselines)
    passing = [cid for cid, row in rows.items() if row['summary']['exploratoryScreenPassed']]
    hindsight = sorted(rows, key=lambda cid: (-rows[cid]['summary']['worstLaterWindowNetUsd'], cid))[0]
    # Preserve full order, trade and daily equity ledgers for every configuration.
    ledger_dir = args.out/'ledgers'
    ledger_dir.mkdir()
    for c in specs:
        save(ledger_dir/(c['id']+'.json'), {p: {s: common.evaluate(target_bank[c['id']], data, start, end, settings, details=True)
                                              for s, settings in SCENARIOS.items()}
                                         for p, (start, end) in PERIODS.items()})
    with (args.out/'comparison.csv').open('w') as f:
        writer = csv.writer(f)
        writer.writerow(['candidate', 'period', 'scenario', 'net_usd', 'account_return_pct',
                         'drawdown_usd', 'intraday_low_drawdown_usd', 'closed_episodes', 'fees_usd'])
        for cid, row in rows.items():
            for p, scenarios in row['runs'].items():
                for s, r in scenarios.items():
                    writer.writerow([cid, p, s, r['netPnlUsd'], r['returnOnAccountPct'], r['maxDrawdownUsd'],
                                     r['maxIntradayLowDrawdownUsd'], r['closedTrades'], r['feesUsd']])
    result = dict(selectedId=selected_id, selected=rows[selected_id],
                  hindsightBestWorstLaterNetId=hindsight, hindsightSelectionIsBiased=True,
                  exploratoryPassingIds=passing, passingCount=len(passing),
                  positiveAllWindowsCount=sum(r['summary']['positiveAllWindowsAndScenarios'] for r in rows.values()),
                  configurationsTested=len(rows), strategyWindowScenarioRuns=len(rows)*len(PERIODS)*len(SCENARIOS),
                  baselineRuns=len(baselines)*len(PERIODS)*len(SCENARIOS),
                  validatedProfitable=False, deploymentPerformed=False)
    save(args.out/'summary.json', result)
    save(args.out/'artifact-integrity.json', {str(p.relative_to(args.out)): sha(p)
                                             for p in sorted(args.out.rglob('*')) if p.is_file()})
    print(json.dumps({k: v for k, v in result.items() if k != 'selected'}, indent=2))


if __name__ == '__main__':
    main()
