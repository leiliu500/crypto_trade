"""Independent source and cash audit; imports no strategy code, submits no orders."""
import datetime as dt
import gzip
import hashlib
import json
import math
from pathlib import Path

ROOT = Path.cwd()
OUT = ROOT / 'reports/profit-engine-rebuild-2026-09-09/channel-price-protected-v2/holdout-2026'
HOUR = 3_600_000
def read(path):
    return json.loads(Path(path).read_bytes())
def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()
checks = 0
def check(condition, message):
    global checks
    checks += 1
    if not condition:
        raise AssertionError(message)
def same(actual, expected, message):
    check(math.isfinite(actual) and math.isfinite(expected) and abs(actual - expected) < 1e-6, message)

design = read(OUT / 'protocol-design.json')
protocol = read(OUT / 'protocol.json')
report = read(OUT / 'report.json')
check(sha(OUT / 'protocol-design.json') == protocol['reviewedDesignSha256'], 'Reviewed protocol hash')
for path, expected in design['sourceHashes'].items():
    check(sha(OUT / 'sources' / path) == expected, 'Frozen source ' + path)
for path, expected in design['inputHashes'].items():
    check(sha(ROOT / path) == expected, 'Input ' + path)
data = read(OUT / 'inputs/permitted-dataset.json')
check(sha(OUT / 'inputs/permitted-dataset.json') == report['dataSha256'], 'Permitted dataset hash')
bars = {(b['symbol'], b['openMs']): b for b in data['bars']}
rates = {(r['symbol'], r['timestampMs'] - HOUR): r['absoluteRate'] for r in data['funding']}

# Reconstruct every permitted funding amount directly from the public API bytes.
extension = ROOT / 'reports/portfolio-funding-extension-2026-09-09'
raw_rates = {}
for item in read(extension / 'manifest.json')['files']:
    path = extension / item['file']
    check(sha(path) == item['compressedSha256'], 'Raw API archive hash')
    decoded = gzip.decompress(path.read_bytes())
    check(hashlib.sha256(decoded).hexdigest() == item['jsonSha256'], 'Raw API JSON hash')
    symbol = {'PF_XBTUSD': 'BTC/USD', 'PF_ETHUSD': 'ETH/USD'}[item['symbol']]
    for row in json.loads(decoded)['rates']:
        start = round(dt.datetime.fromisoformat(row['timestamp'].replace('Z', '+00:00')).timestamp() * 1000)
        raw_rates[symbol, start] = row['fundingRate']
for key, rate in rates.items():
    same(rate, raw_rates[key], 'Normalized funding is exact public source rate')

results = []
for scenario in ('base', 'stress'):
    run = read(OUT / f'2026-jan-jul-{scenario}-channel.json')
    check(run['netPnlUsd'] is None and not run['accountingKnown'], 'Full profit remains unknown')
    check(not run['unresolved'], 'All recorded episodes closed')
    fee_rate = {'base': .0005, 'stress': .00075}[scenario]
    fee = gross = funding = 0.0
    missing = []
    episode_results = []
    for order in run['orders']:
        same(order['feeUsd'], order['qty'] * order['price'] * fee_rate, 'Fill fee')
        fee += order['feeUsd']
        gross += order['grossPnlUsd']
    for episode in run['episodes']:
        symbol, side, qty = episode['symbol'], episode['side'], episode['entryQty']
        exits = [o for o in run['orders'] if o['symbol'] == symbol and o['reduceOnly']
                 and episode['entryMs'] < o['atMs'] <= episode['exitMs']]
        check(len(exits) == 1 and exits[0]['qty'] == qty, 'This holdout episode has one full reduction')
        same(episode['grossPnlUsd'], side * qty * (exits[0]['price'] - episode['entryPx']), 'Episode gross')
        cash = 0.0
        holes = []
        for start in range(episode['entryMs'], episode['exitMs'], HOUR):
            key = symbol, start
            if key not in rates:
                check(key not in raw_rates, 'Missing settlement is absent from official raw source')
                hole = f'{symbol}:{start}'
                missing.append(hole)
                holes.append({'sourceStartUtc': dt.datetime.fromtimestamp(start / 1000, dt.timezone.utc).isoformat(),
                              'signedBaseQty': side * qty})
                continue
            amount = -side * qty * rates[key]
            if start == episode['exitMs'] - HOUR and episode['reason'] == 'PROTECTIVE_INTRAHOUR_TOUCH':
                amount = min(0.0, amount)
            cash += amount
        same(episode['fundingCashUsd'], cash, 'Known funding component only')
        funding += cash
        episode_results.append({'symbol': symbol, 'entryMs': episode['entryMs'], 'exitMs': episode['exitMs'],
                                'missingFunding': holes, 'knownFundingComponentUsd': cash,
                                'fullEpisodeNetKnown': not holes})
    same(run['feeUsd'], fee, 'Total fees')
    same(run['grossPnlUsd'], gross, 'Total gross')
    same(run['hourly'][-1]['cashEquityUsd'] - 100000, gross - fee + funding, 'Partial cash reconciliation')
    check(sorted(missing) == sorted(run['missingFunding']), 'Exact held funding gaps')
    first_gap = min(int(k.rsplit(':', 1)[1]) for k in missing)
    check(all(o['atMs'] <= first_gap for o in run['orders'] if not o['reduceOnly']), 'No entry after missing funding halt')
    results.append({'scenario': scenario, 'grossUsd': gross, 'feesUsd': fee,
                    'knownFundingComponentUsd': funding, 'partialCashChangeUsd': gross - fee + funding,
                    'fullNetPnlUsd': None, 'firstMissingFundingStartMs': first_gap,
                    'newEntriesHaltedAfterFirstGap': True, 'episodes': episode_results})
check(report['validation']['bootstrap']['lowerMeanWeeklyNetUsd'] is None, 'No funded confidence bound')
check(not report['validation']['historicalHoldoutPassed'] and not report['runtimeActivated'], 'Failed gate preserved')
result = {'verifiedAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(), 'checks': checks,
          'allChecksPassed': True, 'results': results,
          'scope': 'INDEPENDENT_PUBLIC_RATE_AND_RECORDED_FILL_CASH_RECONCILIATION;NOT_FULL_STRATEGY_OR_EXECUTABILITY_VALIDATION',
          'partialCashIsNotFullPeriodProfit': True, 'ordersSubmitted': 0}
with (OUT / 'cash-verification.json').open('x') as file:
    json.dump(result, file, indent=2)
    file.write('\n')
print(json.dumps({'checks': checks, 'allChecksPassed': True,
                  'partialCashChangeUsd': [r['partialCashChangeUsd'] for r in results],
                  'fullNetPnlUsd': None}))
