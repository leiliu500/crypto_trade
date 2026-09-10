"""Causal entry-gate invariants; no P&L computation or selection."""
import copy
import hashlib
import importlib.util
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
spec = importlib.util.spec_from_file_location('entry_candidate', HERE/'candidates.py')
model = importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)


def synthetic(closes, location=0.):
    return [dict(openMs=i*86400000, open=c, close=c, high=c*(1.01-.009*location),
                 low=c*(.99-.009*location), volume=1000.) for i,c in enumerate(closes)]


def main():
    source = REPO/'reports/parallel-strategy-study-2026-09-10/data/dataset.json'
    data = json.loads(source.read_text())
    checks, prefixes = [], 0
    for symbol, bars in data.items():
        # Arbitrary causal baseline, independently exercising every branch.
        baseline = [i % 11 != 0 for i in range(len(bars))]
        full = model.build_entries(symbol, bars, baseline)
        assert len(full) == 3
        ids = list(full)
        assert full[ids[0]] == [i >= 90 and value for i, value in enumerate(baseline)]
        for values in full.values():
            assert len(values) == len(bars) and all(type(x) is bool for x in values)
            assert values[:90] == [False]*90
            assert all(not x or baseline[i] for i,x in enumerate(values))
        for n in (0,1,19,28,50,89,90,91,110,150,250,400,600,719,720):
            result = model.build_entries(symbol, bars[:n], baseline[:n])
            assert result == {key: values[:n] for key,values in full.items()}
            prefixes += len(result)
        assert all(not any(v) for v in model.build_entries(symbol,bars,[False]*len(bars)).values())
        # Neither downstream baseline changes nor future price changes alter earlier gates.
        altered = copy.deepcopy(bars)
        for b in altered[400:]:
            for k in ('open','high','low','close'):
                b[k] *= 2
        later = model.build_entries(symbol,altered,baseline[:400]+[not x for x in baseline[400:]])
        assert all(later[k][:400] == full[k][:400] for k in full)
        flat = model.build_entries(symbol,synthetic([100.]*250),[True]*250)
        assert not any(flat[ids[1]]) and not any(flat[ids[2]])
        scaled = copy.deepcopy(bars)
        for b in scaled:
            for k in ('open','high','low','close'):
                b[k] *= 100
            b['volume'] *= 1000
        assert model.build_entries(symbol,scaled,baseline) == full
    checks.append({'check':'prefix_causality','candidatePrefixComparisons':prefixes})
    checks.append({'check':'six_lengths_booleans_warmups_baseline_subsets_and_future_mutation'})
    checks.append({'check':'flat_alternative_gates_inactive_and_price_volume_unit_invariance'})
    rise = synthetic([100*math.exp(.005*i) for i in range(150)],location=.9)
    bull = [True]*150
    btc = model.build_entries('BTC/USD',rise,bull)
    eth = model.build_entries('ETH/USD',rise,bull)
    assert btc['btc_entry_path_efficiency'][-1]
    assert eth['eth_entry_volatility_confirmation'][-1] and eth['eth_entry_volume_pressure'][-1]
    checks.append({'check':'positive_drift_and_positive_pressure_firing_witnesses'})
    noisy = synthetic([100 + .01*i + (3 if i%2 else -3) for i in range(150)])
    assert not model.build_entries('BTC/USD',noisy,bull)['btc_entry_path_efficiency'][-1]
    pullback = synthetic([100.]*90+[110.,105.,100.,99.,98.,103.])
    pull = model.build_entries('BTC/USD',pullback,[True]*96)
    assert pull['btc_entry_pullback_recovery'][95]
    assert not pull['btc_entry_pullback_recovery'][94]
    checks.append({'check':'BTC_noisy_path_rejected_and_ordered_pullback_cross_fires'})
    shock = copy.deepcopy(rise)
    shock[-1]['high'] = shock[-1]['close']*1.2
    shock[-1]['low'] = shock[-1]['close']*.8
    assert not model.build_entries('ETH/USD',shock,bull)['eth_entry_volatility_confirmation'][-1]
    previous_off = bull[:]
    previous_off[-2] = False
    assert not model.build_entries('ETH/USD',rise,previous_off)['eth_entry_volatility_confirmation'][-1]
    checks.append({'check':'ETH_range_shock_and_unconfirmed_baseline_rejected'})
    negative_pressure = synthetic([b['close'] for b in rise],location=-.9)
    assert not model.build_entries('ETH/USD',negative_pressure,bull)['eth_entry_volume_pressure'][-1]
    checks.append({'check':'same_closes_opposite_close_location_changes_ETH_pressure_gate'})
    result={'passed':True,'checks':checks,'profitResultsComputedOrInspected':False,
            'codeSha256':hashlib.sha256((HERE/'candidates.py').read_bytes()).hexdigest(),
            'datasetSha256':hashlib.sha256(source.read_bytes()).hexdigest()}
    (HERE/'self-test.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))


if __name__ == '__main__':
    main()
