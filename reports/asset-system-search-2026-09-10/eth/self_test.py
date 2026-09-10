#!/usr/bin/env python3
"""Signal invariants only; deliberately no profit scoring or candidate selection."""
import copy
import hashlib
import importlib.util
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
spec = importlib.util.spec_from_file_location('eth_candidate_check', HERE / 'candidates.py')
model = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)


def data_from(closes, location=0., volumes=None):
    bars = []
    for i, close in enumerate(closes):
        # Set close location while preserving the same close history.
        high, low = close * (1.01 - .009 * location), close * (.99 - .009 * location)
        bars.append(dict(openMs=i * 86400000, open=close, close=close, high=high, low=low,
                         volume=1000. if volumes is None else volumes[i]))
    return {'ETH/USD': copy.deepcopy(bars), 'BTC/USD': copy.deepcopy(bars)}


def inverse(a):
    n = len(a)
    rows = [row[:] + [float(i == j) for j in range(n)] for i, row in enumerate(a)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda j: abs(rows[j][col]))
        rows[col], rows[pivot] = rows[pivot], rows[col]
        divisor = rows[col][col]
        rows[col] = [v / divisor for v in rows[col]]
        for r in range(n):
            if r != col:
                multiple = rows[r][col]
                rows[r] = [v - multiple * q for v, q in zip(rows[r], rows[col])]
    return [r[n:] for r in rows]


def ridge_reference(data):
    # Independently accumulate discounted normal equations then invert, rather
    # than the production Sherman-Morrison inverse update.
    cs = {s: [b['close'] for b in bars] for s, bars in data.items()}
    matrix = [[float(i == j) for j in range(4)] for i in range(4)]
    rhs, beta, variance = [0.] * 4, [0.] * 4, .01
    out, held, labels = [], None, 0
    for t in range(len(cs['ETH/USD'])):
        if t >= 28:
            x = model._ridge_features(cs, t - 14)
            y = math.log(cs['ETH/USD'][t] / cs['ETH/USD'][t - 14])
            residual = y - sum(a * b for a, b in zip(x, beta))
            matrix = [[.99 * matrix[i][j] + x[i] * x[j] for j in range(4)] for i in range(4)]
            rhs = [.99 * rhs[i] + x[i] * y for i in range(4)]
            p = inverse(matrix)
            beta = [sum(p[i][j] * rhs[j] for j in range(4)) for i in range(4)]
            variance = .98 * variance + .02 * residual * residual
            labels += 1
        if t >= 90 and labels >= 60:
            x = model._ridge_features(cs, t)
            mu = sum(a * b for a, b in zip(x, beta))
            leverage = sum(x[i] * p[i][j] * x[j] for i in range(4) for j in range(4))
            if mu - math.sqrt(max(0., variance * leverage)) > model.LOG_COST:
                held = model.SYMBOL
            elif mu <= 0:
                held = None
        out.append(held)
    return out


def main():
    checks = []
    registry = model.candidates()
    by_id = {c['id']: c for c in registry}
    source = REPO / 'reports/parallel-strategy-study-2026-09-10/data/dataset.json'
    data = json.loads(source.read_text())
    for c in registry:
        full = model.targets(c, data)
        assert len(full) == 720 and all(t in (None, model.SYMBOL) for t in full)
        assert full[:90] == [None] * 90
        for n in (0, 1, 14, 28, 60, 89, 90, 91, 101, 150, 200, 284, 400, 500, 600, 719):
            prefix = {s: b[:n] for s, b in data.items()}
            assert model.targets(c, prefix) == full[:n], (c['id'], n)
        checks.append({'check': 'causal_prefix_and_warmup', 'id': c['id'], 'prefixes': 16})
        assert model.targets(c, data_from([100.] * 250)) == [None] * 250
    checks.append({'check': 'four_flat_histories_remain_cash', 'count': 4})
    increasing = data_from([100 * math.exp(.003 * i) for i in range(250)], location=.9)
    decreasing = data_from([100 * math.exp(-.003 * i) for i in range(250)], location=-.9)
    for cid in ('eth_kalman_drift_v1', 'eth_crossasset_mature_ridge_v1'):
        assert model.targets(by_id[cid], increasing)[-1] == model.SYMBOL
        assert model.targets(by_id[cid], decreasing)[-1] is None
    checks.append({'check': 'filter_and_regression_positive_negative_drift_witnesses', 'count': 4})
    for sample in (data, increasing, decreasing):
        assert model.targets(by_id['eth_crossasset_mature_ridge_v1'], sample) == ridge_reference(sample)
    checks.append({'check': 'ridge_independent_discounted_normal_equations', 'histories': 3})
    reversed_location = data_from([b['close'] for b in increasing['ETH/USD']], location=-.9)
    volume_candidate = by_id['eth_volume_pressure_v1']
    pressure_long = model.targets(volume_candidate, increasing)
    pressure_cash = model.targets(volume_candidate, reversed_location)
    assert pressure_long[-1] == model.SYMBOL and pressure_cash[-1] is None
    # Uniform volume-unit scaling leaves the ratio unchanged.
    scaled = copy.deepcopy(increasing)
    for bars in scaled.values():
        for b in bars:
            b['volume'] *= 1e6
    assert model.targets(volume_candidate, scaled) == pressure_long
    checks.append({'check': 'same_closes_distinct_pressure_and_volume_unit_invariance'})
    # Arm, track a lower trough, recover, enter, then recover original peak.
    event = data_from([100.] * 90 + [75., 70., 74., 76., 100., 70., 76.])
    event_targets = model.targets(by_id['eth_drawdown_recovery_v1'], event)
    assert event_targets[90:] == [None, None, None, model.SYMBOL, None, None, None]
    checks.append({'check': 'ordered_recovery_entry_exit_and_cooldown'})
    altered = copy.deepcopy(registry[0])
    altered['parameters']['horizonDays'] = 15
    try:
        model.targets(altered, data)
        raise AssertionError('Accepted altered parameters')
    except ValueError:
        pass
    checks.append({'check': 'frozen_parameter_mutation_rejected'})
    result = {'passed': True, 'checks': checks, 'candidateCodeSha256': hashlib.sha256((HERE/'candidates.py').read_bytes()).hexdigest(),
              'datasetSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'profitResultsInspected': False}
    (HERE/'self-test.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
