"""Bounded, registered BTC/ETH system comparison. Offline research; no order API."""
import argparse
import datetime as dt
import gzip
import hashlib
import importlib.util
import json
import math
import random
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
PRIOR = REPO / 'reports/parallel-strategy-study-2026-09-10'
WEEKLY = REPO / 'reports/new-spot-system-2026-09-10/market-data/dataset.json'
DAY = 86_400_000
PERIODS = {'development': ('2025-01-01', '2025-07-01'),
           'later_2025': ('2025-07-01', '2026-01-01'),
           'recent_2026': ('2026-01-01', '2026-09-10'),
           'continuous': ('2025-01-01', '2026-09-10')}
SCENARIOS = {'base': {'feeBps': 80, 'slippageBps': 3, 'signalToOpenBars': 2},
             'cost': {'feeBps': 100, 'slippageBps': 10, 'signalToOpenBars': 2},
             'delay': {'feeBps': 80, 'slippageBps': 3, 'signalToOpenBars': 3},
             'combined': {'feeBps': 100, 'slippageBps': 10, 'signalToOpenBars': 3}}


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    sys.modules[name] = result
    spec.loader.exec_module(result)
    return result


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


def load_modules():
    return {asset: module(ROOT / asset / 'candidates.py', 'asset_candidates_' + asset)
            for asset in ('btc', 'eth')}


def common_module():
    return module(PRIOR / 'common.py', 'asset_study_common')


def btc_weekly_control(data):
    """Native-week SMA40 signal, normalized into the shared daily OHLC contract.

    At daily signal availability (close+60s), use the running BTC rule's
    current-week-open cutoff. Only already-finalized native weeks enter the
    hysteresis. Daily execution lag and common sizing are comparison proxies,
    not an exact replay of the minute-level BTC paper service or its mark caps.
    """
    weeks = json.loads(WEEKLY.read_text())['bars']
    states, held = [], None
    for i, bar in enumerate(weeks):
        assert bar['endMs'] == bar['openMs'] + 7 * DAY
        assert bar['availableAtMs'] >= bar['endMs'] + 60_000
        if i:
            assert bar['openMs'] == weeks[i-1]['endMs']
        if i >= 39:
            average = sum(w['close'] for w in weeks[i-39:i+1]) / 40
            if bar['close'] > average * 1.0166:
                held = 'BTC/USD'
            elif bar['close'] <= average:
                held = None
        states.append(held)
    output, cursor = [], -1
    for bar in data['BTC/USD']:
        available = bar['openMs'] + DAY + 60_000
        cutoff = available // (7 * DAY) * (7 * DAY)
        while cursor + 1 < len(weeks) and weeks[cursor+1]['availableAtMs'] <= cutoff:
            cursor += 1
        output.append(states[cursor] if cursor >= 0 else None)
    return output


def controls(data):
    old = module(REPO / 'tools/profit-search.py', 'prior_asset_controls')
    n = len(data['BTC/USD'])
    return {'btc_weekly_signal_control': btc_weekly_control(data),
            'eth40_control': old.targets({'family': 'sma_eth', 'lookbackDays': 40}, data),
            'buy_hold_btc': ['BTC/USD'] * n, 'buy_hold_eth': ['ETH/USD'] * n,
            'cash': [None] * n}


def validate_data(data):
    btc, eth = data['BTC/USD'], data['ETH/USD']
    assert len(btc) == len(eth) and btc
    assert [b['openMs'] for b in btc] == [b['openMs'] for b in eth]
    for bars in data.values():
        for i, b in enumerate(bars):
            assert all(math.isfinite(b[k]) for k in ('openMs', 'open', 'high', 'low', 'close', 'volume'))
            assert 0 < b['low'] <= min(b['open'], b['close']) <= max(b['open'], b['close']) <= b['high']
            assert b['volume'] >= 0
            if i:
                assert b['openMs'] - bars[i-1]['openMs'] == DAY


def checked_targets(mod, candidate, data, asset):
    target = mod.targets(candidate, data)
    assert isinstance(target, list) and len(target) == len(data['BTC/USD'])
    assert set(target) <= {None, asset.upper() + '/USD'}
    assert all(x is None for x in target[:90]), candidate['id']
    return target


def metrics(result):
    summary = {k: v for k, v in result.items() if k not in ('daily', 'orders', 'trades', 'rejections')}
    summary['naturalCompletedEpisodes'] = sum(t['exitReason'] != 'terminal' for t in result['trades'])
    summary['terminalLiquidations'] = sum(t['exitReason'] == 'terminal' for t in result['trades'])
    return summary


def input_hashes():
    paths = [Path(__file__), PRIOR / 'common.py', PRIOR / 'protocol.json',
             PRIOR / 'data/dataset.json', PRIOR / 'data/rules.json', WEEKLY,
             REPO / 'tools/profit-search.py', ROOT / 'protocol.json']
    paths += [ROOT / a / 'candidates.py' for a in ('btc', 'eth')]
    return {str(p.relative_to(REPO)): sha(p) for p in paths}


def verify_hashes(hashes):
    for name, expected in hashes.items():
        assert sha(REPO / name) == expected, ('Frozen input changed', name)


def develop(out):
    out.mkdir(parents=True, exist_ok=False)
    mods, common = load_modules(), common_module()
    registry = {asset: mods[asset].candidates() for asset in mods}
    assert all(len(specs) == 4 for specs in registry.values())
    ids = [c['id'] for specs in registry.values() for c in specs]
    assert len(ids) == len(set(ids)) == 8
    registered = {'registeredAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                  'candidateApplications': 8, 'registry': registry, 'hashes': input_hashes(),
                  'historyAlreadyReused': True, 'originalMathematicalInventionsClaimed': 0}
    # Freeze source, inputs and candidate identities before target generation or P&L.
    save(out / 'registration.json', registered)
    raw = common.load_data(False)
    data = {s: [b for b in bars if b['openMs'] < common.timestamp('2025-07-01')] for s, bars in raw.items()}
    validate_data(data)
    signals = controls(data)
    for asset, specs in registry.items():
        for candidate in specs:
            signals[candidate['id']] = checked_targets(mods[asset], candidate, data, asset)
    runs = {key: {scenario: common.evaluate(target, data, *PERIODS['development'],
                                           settings, details=True)
                  for scenario, settings in SCENARIOS.items()} for key, target in signals.items()}
    utility = {key: min(r['selectionUtility'] for r in by.values()) for key, by in runs.items()}
    selected, all_ranks = {}, {}
    for asset, specs in registry.items():
        new = [c['id'] for c in specs]
        control = 'btc_weekly_signal_control' if asset == 'btc' else 'eth40_control'
        ranked = sorted(new + [control, 'buy_hold_' + asset, 'cash'], key=lambda key: (-utility[key], key))
        selected[asset] = min(new, key=lambda key: (-utility[key], key))
        all_ranks[asset] = ranked
    save(out / 'development.json', {key: {s: metrics(r) for s, r in by.items()} for key, by in runs.items()})
    save(out / 'development-targets.json', signals)
    save(out / 'selection-lock.json', {'lockedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
        'selectedNewCandidate': selected, 'rankingIncludingControls': all_ranks,
        'worstScenarioDevelopmentUtility': utility, 'rule': 'max min_scenario(net - 0.5 * close drawdown); lexical ties',
        'laterPeriodsEvaluatedByThisRun': False, 'hashes': registered['hashes'],
        'historicalDataPreviouslyReused': True, 'activationAllowed': False})
    print(json.dumps({'selectedNewCandidate': selected, 'rankingIncludingControls': all_ranks}))


def confidence(a, b):
    assert [r['date'] for r in a] == [r['date'] for r in b]
    values = [x['pnlUsd'] - y['pnlUsd'] for x, y in zip(a, b)]
    rng, n, length, totals = random.Random(20260910), len(values), 14, []
    blocks = [sum(values[(i+j) % n] for j in range(length)) for i in range(n)]
    full, remainder = divmod(n, length)
    for _ in range(5000):
        total = sum(blocks[rng.randrange(n)] for _ in range(full))
        start = rng.randrange(n)
        totals.append(total + sum(values[(start+j) % n] for j in range(remainder)))
    totals.sort()
    return {'excessNetUsd': sum(values), 'nominalLowerNetUsd': totals[int(.05 * len(totals))],
            'eightTrialAdjustedLowerNetUsd': totals[int(.05 / 8 * len(totals))],
            'blockDays': length, 'replicates': len(totals),
            'interpretation': 'Descriptive only: reused history, serial dependence and unknown prior search count.'}


def evaluate(out):
    assert not (out / 'summary.json').exists(), 'Refuse to overwrite completed results'
    registered = json.loads((out / 'registration.json').read_text())
    lock = json.loads((out / 'selection-lock.json').read_text())
    verify_hashes(lock['hashes'])
    mods, common = load_modules(), common_module()
    data = common.load_data(False)
    validate_data(data)
    signals = controls(data)
    for asset, specs in registered['registry'].items():
        assert mods[asset].candidates() == specs
        for candidate in specs:
            signals[candidate['id']] = checked_targets(mods[asset], candidate, data, asset)
    old_targets = json.loads((out / 'development-targets.json').read_text())
    for key, old in old_targets.items():
        assert signals[key][:len(old)] == old, ('Development prefix changed', key)
    runs = {key: {period: {scenario: common.evaluate(target, data, *dates, settings, details=True)
                           for scenario, settings in SCENARIOS.items()}
                   for period, dates in PERIODS.items()} for key, target in signals.items()}
    summary = {key: {p: {s: metrics(r) for s, r in by.items()} for p, by in periods.items()}
               for key, periods in runs.items()}
    qualification, bounds = {}, {}
    for asset, candidate in lock['selectedNewCandidate'].items():
        control = 'btc_weekly_signal_control' if asset == 'btc' else 'eth40_control'
        later = ('later_2025', 'recent_2026')
        combined_rows = lambda key: [row for period in later for row in runs[key][period]['combined']['daily']]
        bounds[asset] = {base: confidence(combined_rows(candidate), combined_rows(base))
                         for base in ('cash', 'buy_hold_' + asset, control)}
        checks = {
            'positiveAllDevelopmentAndLaterScenarioNets': all(summary[candidate][p][s]['netPnlUsd'] > 0
                for p in ('development', *later) for s in SCENARIOS),
            'tenNaturalCompletedLaterEpisodesEveryScenario': all(sum(summary[candidate][p][s]['naturalCompletedEpisodes']
                for p in later) >= 10 for s in SCENARIOS),
            'naturalCompletedEpisodeEachLaterPeriodEveryScenario': all(summary[candidate][p][s]['naturalCompletedEpisodes'] > 0
                for p in later for s in SCENARIOS),
            'laterLowDrawdownAtMost500EveryScenario': all(summary[candidate][p][s]['maxIntradayLowDrawdownUsd'] <= 500
                for p in later for s in SCENARIOS),
            'positiveDescriptiveAdjustedExcessBounds': all(b['eightTrialAdjustedLowerNetUsd'] > 0 for b in bounds[asset].values()),
        }
        qualification[asset] = {'candidate': candidate, 'historicalScreenPassed': all(checks.values()),
                                'checks': checks, 'validatedProfitable': False, 'activationAllowed': False}
    save(out / 'targets.json', signals)
    (out / 'full-ledgers.json.gz').write_bytes(gzip.compress(json.dumps(runs, allow_nan=False).encode(), mtime=0))
    save(out / 'summary.json', {'selectedNewCandidate': lock['selectedNewCandidate'], 'performance': summary,
        'qualification': qualification, 'confidence': bounds, 'candidateApplications': 8,
        'mathematicalInventionClaims': 0, 'allWindowScenarioRuns': len(signals) * len(PERIODS) * len(SCENARIOS),
        'historyPreviouslyReused': True, 'productionChanged': False, 'liveTradingAuthorized': False})
    save(out / 'integrity.json', {p.name: sha(p) for p in sorted(out.iterdir()) if p.is_file() and p.name != 'integrity.json'})
    print(json.dumps({'selectedNewCandidate': lock['selectedNewCandidate'], 'qualification': qualification}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=('develop', 'evaluate'))
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    {'develop': develop, 'evaluate': evaluate}[args.phase](args.out)
