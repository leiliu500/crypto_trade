"""Independent source-based verification; no strategy implementation imports."""
from pathlib import Path
import hashlib
import json
import math

root = Path(__file__).resolve().parents[3]
out = Path(__file__).resolve().parent
registration = json.loads((out / 'implementation-registration.json').read_text())
spec = registration['specification']
for name, expected in registration['sourceHashes'].items():
    assert hashlib.sha256((out / 'sources' / name).read_bytes()).hexdigest() == expected
for source in registration['dataSources']:
    for filename, key in [('dataset.json', 'datasetSha256'), ('manifest.json', 'manifestSha256')]:
        assert hashlib.sha256((root / source['path'] / filename).read_bytes()).hexdigest() == source[key]

spot = json.loads((root / registration['dataSources'][0]['path'] / 'dataset.json').read_text())
spots = {b['openMs']: b for b in spot['bars'] if b['symbol'] == 'BTC/USD' and b['intervalMinutes'] == 10080}
bars, funding = {}, {}
for source in registration['dataSources'][1:]:
    dataset = json.loads((root / source['path'] / 'dataset.json').read_text())
    for b in dataset['bars']:
        if b['symbol'] == 'BTC/USD' and b['openMs'] < spec['windows'][-1]['endMs']:
            if b['openMs'] in bars:
                assert bars[b['openMs']] == b
            bars[b['openMs']] = b
    for r in dataset['funding']:
        if r['symbol'] == 'BTC/USD' and r['timestampMs'] <= spec['windows'][-1]['endMs']:
            if r['timestampMs'] in funding:
                assert funding[r['timestampMs']] == r
            funding[r['timestampMs']] = r

checked = 0
max_error = 0.0
summary = []
for window in spec['windows']:
    for scenario, costs in spec['scenarios'].items():
        for shift in spec['fundingEndShiftHours']:
            run = json.loads((out / f"{window['id']}-{scenario}-funding-{shift}.json").read_text())
            for d in run['decisions']:
                t = d['atMs'] - 60_000
                assert t % 604800000 == 0 and d['scheduledEntryMs'] == t + 604800000
                s = spots[t - 604800000]['close']
                f = bars[t - 3600000]['close']
                values = [funding[t - i * 3600000 - shift * 3600000]['absoluteRate'] for i in range(2160)]
                mean = math.fsum(values) / 2160
                expected = .5 * mean * 4320
                fee = 2 * (s * costs['spotFeeBps'] + f * costs['perpetualFeeBps']) / 10000
                slip = 2 * (s + f) * costs['slippageBpsPerExecution'] / 10000
                capital = s * (1 + costs['slippageBpsPerExecution'] / 10000) * (1 + costs['spotFeeBps'] / 10000) + 2 * f
                hurdle = capital * .05 * 180 / 365
                reserve = max(s, f) * .0075
                required = fee + slip + hurdle + reserve
                expected_fields = {'expectedHaircutFundingPerBase': expected, 'feesPerBase': fee,
                                   'slippagePerBase': slip, 'capitalPerBase': capital,
                                   'capitalHurdlePerBase': hurdle, 'basisUnwindReservePerBase': reserve,
                                   'requiredPerBase': required, 'expectedExcessPerBase': expected - required}
                for key, value in expected_fields.items():
                    error = abs(d['signal'][key] - value)
                    max_error = max(max_error, error)
                    assert error < 1e-7, (key, error)
                assert d['signal']['entryAllowed'] == (expected > required)
                assert d['signal']['missingHours'] == 0
                checked += 1
            assert all(not d['signal']['entryAllowed'] for d in run['decisions'])
            assert run['completedCycles'] == 0 and run['netCashPnlUsd'] == 0
            assert run['capitalBenchmarkExcessUsd'] == 0 and run['unresolvedMatchedQty'] == 0
            summary.append({'period': window['id'], 'scenario': scenario, 'fundingShiftHours': shift,
                            'decisionsVerified': len(run['decisions']), 'entries': 0})

result = {'verified': True, 'method': 'INDEPENDENT_PYTHON_RECONSTRUCTION_FROM_HASH_VERIFIED_SOURCE_DATA',
          'decisionsVerified': checked, 'maximumDollarPerBaseArithmeticError': max_error,
          'runs': summary, 'profitabilityEstablished': False, 'reserved2026Evaluated': False}
target = out / 'verification.json'
with target.open('x') as handle:
    json.dump(result, handle, indent=2)
    handle.write('\n')
print(json.dumps(result, indent=2))
