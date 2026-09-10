"""Register, develop, then evaluate an offline component-interaction study."""
import argparse
import datetime as dt
import gzip
import hashlib
import importlib.util
import itertools
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
PRIOR = REPO/'reports/asset-system-search-2026-09-10'
DATA = REPO/'reports/parallel-strategy-study-2026-09-10/data'


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False)+'\n')


def compressed(path, value):
    path.write_bytes(gzip.compress(json.dumps(value,allow_nan=False).encode(),mtime=0))


def ts(date):
    return int(dt.datetime.fromisoformat(date).replace(tzinfo=dt.timezone.utc).timestamp()*1000)


def modules():
    return {k:module(ROOT/(k+'/candidates.py' if k in ('entry','holding','exit') else k+'.py'),'lifecycle_'+k)
            for k in ('entry','holding','exit','simulator')}


def controls(data):
    old = module(PRIOR/'study.py','lifecycle_existing_controls')
    old.validate_data(data)
    raw = old.controls(data)
    return {s:[x==s for x in raw['btc_weekly_signal_control' if s=='BTC/USD' else 'eth40_control']]
            for s in data}


def hashes():
    files = [ROOT/'study.py',ROOT/'simulator.py',ROOT/'protocol.json',
             DATA/'dataset.json',DATA/'rules.json',PRIOR/'study.py',
             REPO/'tools/profit-search.py',
             REPO/'reports/new-spot-system-2026-09-10/market-data/dataset.json']
    files += [ROOT/k/f for k in ('entry','holding','exit') for f in ('candidates.py','registry.json')]
    return {str(p.relative_to(REPO)):digest(p) for p in files}


def verify(values):
    for p, expected in values.items():
        assert digest(REPO/p)==expected, ('Frozen source changed',p)


def combinations(mods):
    entries, holds, exits = mods['entry'].specs(), mods['holding'].holding_specs(), mods['exit'].exit_specs()
    result, baseline = {}, {}
    for s in ('BTC/USD','ETH/USD'):
        assert len(entries[s])==len(holds[s])==len(exits[s])==3
        choices = []
        for e,h,x in itertools.product(entries[s],holds[s],exits[s]):
            choices.append(dict(id='__'.join((e['id'],h['id'],x['id'])),entry=e['id'],holding=h,exit=x))
        result[s]=choices
        baseline[s]=choices[0]['id']
    return result, baseline


def signals(mods, data):
    thesis = controls(data)
    entries = {s:mods['entry'].build_entries(s,bars,thesis[s]) for s,bars in data.items()}
    for s, values in entries.items():
        assert len(values)==3
        for values_ in values.values():
            assert len(values_)==len(data[s]) and all(type(x) is bool for x in values_)
            assert not any(values_[:90])
            assert all(not e or t for e,t in zip(values_,thesis[s]))
    return thesis, entries


def runs_for(mods, data, specs, protocol, periods):
    thesis, entries = signals(mods,data)
    rules = json.loads((DATA/'rules.json').read_text())
    result = {}
    for s, choices in specs.items():
        for c in choices+[dict(id=s[:3].lower()+'_cash',passive=False,cash=True),
                          dict(id=s[:3].lower()+'_passive',passive=True,cash=False)]:
            special = 'passive' in c
            h = choices[0]['holding'] if special else c['holding']
            x = choices[0]['exit'] if special else c['exit']
            elig = [True]*len(data[s]) if special else entries[s][c['entry']]
            result[c['id']] = {p:{case:mods['simulator'].run(data[s],elig,thesis[s],h,x,rules[s],settings,
                  ts(protocol['periods'][p][0]),ts(protocol['periods'][p][1]),
                  passive=c.get('passive',False),cash_only=c.get('cash',False))
                  for case,settings in protocol['scenarios'].items()} for p in periods}
    return result, dict(thesis=thesis,entries=entries)


def summaries(mods,runs):
    return {k:{p:{s:mods['simulator'].metrics(r) for s,r in cases.items()} for p,cases in periods.items()}
            for k,periods in runs.items()}


def develop(out):
    out.mkdir(parents=True,exist_ok=False)
    mods=modules()
    protocol=json.loads((ROOT/'protocol.json').read_text())
    specs, baseline=combinations(mods)
    registration=dict(registeredAt=dt.datetime.now(dt.timezone.utc).isoformat(),
                      combinations=specs,baseline=baseline,hashes=hashes(),
                      historicalDataPreviouslyReused=True,combinationCount=54)
    save(out/'registration.json',registration)
    full=json.loads((DATA/'dataset.json').read_text())
    data={s:[b for b in bars if b['openMs']<ts('2025-07-01')] for s,bars in full.items()}
    runs,targets=runs_for(mods,data,specs,protocol,['development'])
    summary=summaries(mods,runs)
    utility={k:min(v['selectionUtility'] for v in periods['development'].values()) for k,periods in summary.items()}
    selected, cash_choices, ranks, stage_choices={}, {}, {}, {}
    for s,choices in specs.items():
        ids=[c['id'] for c in choices]
        selected[s]=min(ids,key=lambda k:(-utility[k],k))
        cash=s[:3].lower()+'_cash'
        cash_choices[s]=min(ids+[cash],key=lambda k:(-utility[k],k))
        ranks[s]=sorted(ids+[cash,s[:3].lower()+'_passive'],key=lambda k:(-utility[k],k))
        base=choices[0]
        stage_choices[s]={}
        for part in ('entry','holding','exit'):
            match=[c['id'] for c in choices if all(c[k]==base[k] for k in ('entry','holding','exit') if k!=part)]
            stage_choices[s][part]=min(match,key=lambda k:(-utility[k],k))
    save(out/'development.json',summary)
    compressed(out/'development-ledgers.json.gz',runs)
    save(out/'development-targets.json',targets)
    lock=dict(lockedAt=dt.datetime.now(dt.timezone.utc).isoformat(),selectedCombination=selected,
              choiceIncludingCash=cash_choices,developmentRanking=ranks,baseline=baseline,
              singleStageDevelopmentChoices=stage_choices,worstScenarioDevelopmentUtility=utility,
              laterPeriodsEvaluated=False,hashes=registration['hashes'],liveActivationAllowed=False)
    save(out/'selection-lock.json',lock)
    print(json.dumps({k:lock[k] for k in ('selectedCombination','choiceIncludingCash','singleStageDevelopmentChoices')},indent=2))


def evaluate(out):
    assert not (out/'summary.json').exists()
    lock=json.loads((out/'selection-lock.json').read_text())
    reg=json.loads((out/'registration.json').read_text())
    verify(lock['hashes'])
    mods=modules()
    specs,baseline=combinations(mods)
    assert specs==reg['combinations'] and baseline==reg['baseline']
    protocol=json.loads((ROOT/'protocol.json').read_text())
    data=json.loads((DATA/'dataset.json').read_text())
    runs,targets=runs_for(mods,data,specs,protocol,list(protocol['periods']))
    prior_targets=json.loads((out/'development-targets.json').read_text())
    for s in data:
        n=len(prior_targets['thesis'][s])
        assert targets['thesis'][s][:n]==prior_targets['thesis'][s]
        for e,v in prior_targets['entries'][s].items():
            assert targets['entries'][s][e][:n]==v
    summary=summaries(mods,runs)
    dev=json.loads((out/'development.json').read_text())
    for k in summary:
        assert summary[k]['development']==dev[k]['development'], ('Development changed',k)
    qualification, attribution={},{}
    cases=list(protocol['scenarios'])
    later=('later_2025','recent_2026')
    for s,key in lock['selectedCombination'].items():
        base=baseline[s]
        choices=specs[s]
        selected=next(c for c in choices if c['id']==key)
        initial=choices[0]
        one_at_time, removed={},{}
        for part in ('entry','holding','exit'):
            def match(part_selected):
                return next(c['id'] for c in choices if all(c[k]==(selected[k] if k in part_selected else initial[k])
                            for k in ('entry','holding','exit')))
            one_at_time[part]=match([part])
            removed[part]=match([k for k in ('entry','holding','exit') if k!=part])
        interactions={}
        for p in protocol['periods']:
            interactions[p]={}
            for case in cases:
                net=lambda k:summary[k][p][case]['netPnlUsd']
                actual=net(key)-net(base)
                additive=sum(net(k)-net(base) for k in one_at_time.values())
                interactions[p][case]=dict(jointImprovementUsd=actual,sumStandaloneComponentImprovementUsd=additive,
                  interactionResidualUsd=actual-additive,
                  removalImpactUsd={part:net(key)-net(k) for part,k in removed.items()})
        attribution[s]=dict(singleComponentAppliedToBaseline=one_at_time,selectedComponentRemoved=removed,metrics=interactions)
        later_net=lambda k,case:sum(summary[k][p][case]['netPnlUsd'] for p in later)
        checks=dict(positiveEveryDevelopmentAndLaterScenario=all(summary[key][p][c]['netPnlUsd']>0
                    for p in ('development',*later) for c in cases),
          tenNaturalLaterEpisodesEachScenario=all(sum(summary[key][p][c]['naturalCompletedEpisodes'] for p in later)>=10 for c in cases),
          naturalEpisodeEachLaterWindow=all(summary[key][p][c]['naturalCompletedEpisodes']>0 for p in later for c in cases),
          laterSampledLowDrawdownAtMost500=all(summary[key][p][c]['priorClosePeakToDailyLowDrawdownUsd']<=500 for p in later for c in cases),
          laterNetAtLeastBaselineEveryScenario=all(later_net(key,c)>=later_net(base,c) for c in cases),
          laterNetAtLeastPassiveEveryScenario=all(later_net(key,c)>=later_net(s[:3].lower()+'_passive',c) for c in cases),
          noExitMinimumOrMissingRiskAtrAssumptions=all(summary[key][p][c]['counters']['assumedExitBelowMinimum']==0 and
             summary[key][p][c]['counters']['riskEntriesWithoutPositiveAtr']==0 for p in ('development',*later) for c in cases))
        qualification[s]=dict(candidate=key,checks=checks,historicalScreenPassed=all(checks.values()),
                              futureProfitValidated=False,liveActivationAllowed=False)
    save(out/'targets.json',targets)
    compressed(out/'full-ledgers.json.gz',runs)
    save(out/'summary.json',dict(selectedCombination=lock['selectedCombination'],choiceIncludingCash=lock['choiceIncludingCash'],
       baseline=baseline,performance=summary,qualification=qualification,componentAttribution=attribution,
       combinationCount=54,totalWindowScenarioRuns=len(runs)*len(protocol['periods'])*len(cases),
       historicalDataPreviouslyReused=True,productionChanged=False))
    save(out/'integrity.json',{p.name:digest(p) for p in sorted(out.iterdir()) if p.is_file() and p.name!='integrity.json'})
    print(json.dumps(qualification,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase',choices=('develop','evaluate'))
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    {'develop':develop,'evaluate':evaluate}[args.phase](args.out)
