"""Independent invariants for cash accounting, causality and execution timing."""
import copy
import importlib.util
import json
from common import ROOT, DAY, SYMBOLS, evaluate, timestamp, load_data

def module(family):
    spec = importlib.util.spec_from_file_location(family, ROOT/family/'candidate.py')
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

def main():
    checks = []
    data = {s:[dict(openMs=timestamp('2025-01-01')+i*DAY,open=100.,high=110.,low=90.,close=100.,volume=1e8) for i in range(30)] for s in SYMBOLS}
    flat = evaluate([None]*30,data,end='2025-01-31',details=True)
    assert flat['netPnlUsd'] == flat['closedTrades'] == flat['feesUsd'] == 0
    checks.append('cash is exactly flat')
    targets = ['BTC/USD']*30
    base = evaluate(targets,data,end='2025-01-31',details=True)
    stress = evaluate(targets,data,end='2025-01-31',scenario='stress',details=True)
    assert base['orders'][0]['timestampMs'] == timestamp('2025-01-03')
    assert stress['orders'][0]['timestampMs'] == timestamp('2025-01-04')
    assert base['closedTrades'] == 1 and len(base['orders']) == 2
    assert stress['netPnlUsd'] < base['netPnlUsd'] < 0
    checks.extend(['base and stress delayed open timing','unchanged target never adds','flat-price fees lose money'])
    independent_cash = 10000.
    inventory = {s:0. for s in SYMBOLS}
    for o in base['orders']:
        sign = 1 if o['side'] == 'BUY' else -1
        independent_cash -= sign*o['quantity']*o['price']+o['feeUsd']
        inventory[o['symbol']] += sign*o['quantity']
    assert all(abs(q)<1e-10 for q in inventory.values())
    assert abs(independent_cash-10000-base['netPnlUsd']) < 1e-8
    assert abs(sum(d['pnlUsd'] for d in base['daily'])-base['netPnlUsd']) < 1e-8
    checks.extend(['independent order-ledger cash reconstruction','terminal inventory zero and daily equity reconciled'])
    rotation = evaluate(['BTC/USD']*10+['ETH/USD']*10+[None]*10,data,end='2025-01-31',details=True)
    assert rotation['closedTrades'] == 2 and [o['side'] for o in rotation['orders']] == ['BUY','SELL','BUY','SELL']
    assert all(t['netPnlUsd']<0 for t in rotation['trades'])
    checks.append('rotation liquidates before funding new position and charges both legs')
    altered = copy.deepcopy(data)
    for s in SYMBOLS:
        altered[s][1]['volume'] = .00001
    changed = evaluate(targets,altered,end='2025-01-31',details=True)
    assert changed['orders'] == base['orders']
    checks.append('unfinalized previous-bar volume cannot alter first fill')
    minimum = evaluate(targets,data,end='2025-01-31',budget=.001,details=True)
    assert minimum['entries']==0 and minimum['rejectedEntries']>0
    checks.append('minimum size rejects non-executable tiny orders')
    development = load_data()
    prefix_checks = 0
    for family in ['trend','reversion','rotation']:
        mod = module(family)
        for params in mod.VARIANTS:
            full = mod.generate(development,params)
            for n in [60,90,103,120,150,180,220,260]:
                truncated = {s:bars[:n] for s,bars in development.items()}
                assert mod.generate(truncated,params) == full[:n], (family,params,n)
                prefix_checks += 1
    checks.append(f'{prefix_checks} real-data prefix-invariance checks across all 12 variants')
    (ROOT/'accounting-audit.json').write_text(json.dumps(dict(passed=True,checks=checks),indent=2)+'\n')
    print(json.dumps(dict(passed=True,checks=len(checks),prefixChecks=prefix_checks)))

if __name__ == '__main__':
    main()
