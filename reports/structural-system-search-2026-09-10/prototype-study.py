"""First structural prototype tranche. Two new implementations, not 10,000 systems."""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]


def module(path, name):
    spec=importlib.util.spec_from_file_location(name,path)
    obj=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(obj)
    return obj


def save(path, obj):
    path.write_text(json.dumps(obj,indent=2,allow_nan=False)+'\n')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    args.out.mkdir(parents=True,exist_ok=False)
    screen=module(REPO/'tools/profit-search.py','earlier_exploratory_screen')
    change=module(ROOT/'changepoint.py','changepoint_candidate')
    hmm=module(ROOT/'hmm.py','hmm_candidate')
    common=screen.read_common()
    data=common.load_data(False)
    screen.assert_data(data)
    ids=['bocpd','hmm']
    periods=dict(screen.PERIODS,continuous=('2025-01-01','2026-09-10'))
    spec=dict(version='two-structural-prototype-screen-v1',
              registeredAt=dt.datetime.now(dt.timezone.utc).isoformat(),
              requestedDistinctSystems=10000,newPrototypeCount=2,
              tenThousandSearchComplete=False,originalMathematicalInventions=0,
              reusedHistoricalData=True,activationAllowed=False,validatedProfitable=False,
              mathematicalDefinitions={'bocpd':change.SPEC,'hmm':hmm.SPEC},
              periods=periods,scenarios=screen.SCENARIOS,
              priorControl=dict(id='sma_eth-040',status='previously selected; not a new method'),
              account='Each reset window and separate continuous run starts with $10000. Entry=min($1000,10% current equity,cash,past-volume ceiling), fee-inclusive. One funded long or cash. No additions, leverage, enforced stop/drawdown halt or current-runtime parity.',
              execution='Finalized daily bar i targets fill at open i+2/base or i+3/delay. Terminal flatten pays adverse price and fees at last close. OHLC proxy, not proven executable liquidity.',
              selection='Select between the two new prototypes using worst-scenario development net minus half close drawdown; ties lexicographic. No later reselection.',
              nomination='All12 reset-window/scenario nets positive, >=10 total later episodes per scenario, maximum later low drawdown <=500. Historical proxy nomination only, never proof.',
              limitations=['Two researched and implemented mechanisms are not 10000 original mathematical systems.',
                           'Both model-to-trade rules are new research heuristics, not profit guarantees from source papers.',
                           'Horizon forecasts do not impose a holding deadline and are not calibrated episode profit predictions.',
                           'Current public fee assumptions, no authenticated actual fee verification.',
                           'Known history and small samples prevent untouched validation claims.',
                           'Forecaster mechanisms and economic-system mechanisms are separate taxonomy axes; do not add their counts.'],
              hashes={str(p.relative_to(REPO)):hashlib.sha256(p.read_bytes()).hexdigest() for p in
                      [Path(__file__),ROOT/'changepoint.py',ROOT/'hmm.py',ROOT/'hmm-spec.json',REPO/'tools/profit-search.py',
                       screen.PRIOR/'common.py',screen.PRIOR/'protocol.json',screen.PRIOR/'data/dataset.json',
                       screen.PRIOR/'data/rules.json']})
    save(args.out/'protocol.json',spec)
    signals={'bocpd':change.generate(data),'hmm':hmm.generate(data),
             'prior_eth40':screen.targets(dict(family='sma_eth',lookbackDays=40),data)}
    for label,target in [('cash',None),('buy_hold_btc','BTC/USD'),('buy_hold_eth','ETH/USD')]:
        signals[label]=[target]*len(data['ETH/USD'])
    assert all(len(t)==len(data['ETH/USD']) and set(t)<={None,'ETH/USD','BTC/USD'} for t in signals.values())
    save(args.out/'targets.json',signals)
    runs={key:{} for key in signals}
    for period,(start,end) in periods.items():
        for key,target in signals.items():
            runs[key][period]={scenario:common.evaluate(target,data,start,end,settings,details=True)
                               for scenario,settings in screen.SCENARIOS.items()}
        if period=='development':
            utilities={key:min(r['selectionUtility'] for r in runs[key][period].values()) for key in ids}
            selected=min(ids,key=lambda key:(-utilities[key],key))
            save(args.out/'selection-lock.json',dict(
                lockedAt=dt.datetime.now(dt.timezone.utc).isoformat(),selectedId=selected,
                developmentUtilities=utilities,historyAlreadyReused=True,selectionUniverse=ids))
    summaries={key:{p:{s:{k:v for k,v in r.items() if k not in ('daily','orders','trades','rejections')}
                            for s,r in by.items()} for p,by in ps.items()} for key,ps in runs.items()}
    qualification={key:screen.screen_summary({p:r for p,r in runs[key].items() if p!='continuous'}) for key in ids}
    result=dict(selectedId=selected,prototypeCount=2,originalInventions=0,tenThousandSearchComplete=False,
                prototypeWindowScenarioRuns=2*len(periods)*len(screen.SCENARIOS),
                controlWindowScenarioRuns=4*len(periods)*len(screen.SCENARIOS),
                nomination=qualification,performance=summaries,validatedProfitable=False,
                productionChanged=False,realOrdersSubmitted=False)
    save(args.out/'summary.json',result)
    save(args.out/'full-ledgers.json',runs)
    save(args.out/'integrity.json',{p.name:hashlib.sha256(p.read_bytes()).hexdigest()
                                  for p in sorted(args.out.iterdir()) if p.is_file()})
    print(json.dumps(dict(selectedId=selected,qualification=qualification,
        continuous={key:{s:round(r['netPnlUsd'],2) for s,r in ps['continuous'].items()} for key,ps in runs.items()}),indent=2))


if __name__=='__main__':
    main()
