#!/usr/bin/env python3
"""Independent read-only audit of the 100-configuration study; writes only its audit JSON."""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
def read(path): return json.loads(path.read_text())
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def near(a,b): return math.isclose(a,b,rel_tol=1e-9,abs_tol=1e-6)
def audit_diagnostics(screen, common, data, study, selected_id):
    diagnostic=read(HERE/'selected-diagnostics.json')
    assert diagnostic['selectedId']==selected_id and not diagnostic['validatedProfitable']
    for rel,expected in diagnostic['sourceHashes'].items(): assert digest(ROOT/rel)==expected
    chosen=next(c for c in screen.candidates() if c['id']==selected_id)
    target=screen.targets(chosen,data)
    continuous={}
    for scenario,run in diagnostic['continuousSameAccount'].items():
        expected=common.evaluate(target,data,'2025-01-01','2026-09-10',screen.SCENARIOS[scenario],details=True)
        assert expected==run
        cash=10000.; inventory={'BTC/USD':0.,'ETH/USD':0.}; fees=0.
        for order in run['orders']:
            sign=1 if order['side']=='BUY' else -1
            cash-=sign*order['quantity']*order['price']+order['feeUsd']
            inventory[order['symbol']]+=sign*order['quantity']; fees+=order['feeUsd']
            assert cash>=-1e-6 and all(q>=-1e-9 for q in inventory.values())
        assert all(abs(q)<1e-9 for q in inventory.values())
        assert near(cash-10000,run['netPnlUsd']) and near(fees,run['feesUsd'])
        assert near(sum(t['netPnlUsd'] for t in run['trades']),run['netPnlUsd'])
        assert near(sum(d['pnlUsd'] for d in run['daily']),run['netPnlUsd'])
        continuous[scenario]={k:run[k] for k in ['netPnlUsd','returnOnAccountPct','maxDrawdownUsd','maxIntradayLowDrawdownUsd','closedTrades']}
    ledger=read(study/'ledgers'/f'{selected_id}.json')
    bootstrap_checks=0
    for period,by_scenario in diagnostic['confidence'].items():
        for scenario,by_baseline in by_scenario.items():
            candidate=ledger[period][scenario]
            concentration=diagnostic['concentration'][period][scenario]
            largest=max(t['netPnlUsd'] for t in candidate['trades'])
            assert near(largest,concentration['largestWinningEpisodeUsd'])
            assert near(candidate['netPnlUsd']-largest,concentration['arithmeticNetExcludingLargestWinnerUsd'])
            assert sum(t['exitReason']=='terminal' for t in candidate['trades'])==concentration['terminalEpisodes']
            for label,record in by_baseline.items():
                symbol={'cash':None,'buy_hold_btc':'BTC/USD','buy_hold_eth':'ETH/USD'}[label]
                baseline=common.evaluate([symbol]*len(target),data,*screen.PERIODS[period],screen.SCENARIOS[scenario],details=True)
                assert [d['date'] for d in candidate['daily']]==[d['date'] for d in baseline['daily']]
                values=[a['pnlUsd']-b['pnlUsd'] for a,b in zip(candidate['daily'],baseline['daily'])]
                assert near(sum(values),record['observedExcessNetUsd'])
                # Independently construct sampled paths, including wrap-around, instead of using analyze.bootstrap.
                count=record['repetitions']; block=record['blockDays']; n=len(values)
                full,remainder=divmod(n,block); rng=random.Random(20260910100); samples=[]
                for _ in range(count):
                    path=[]
                    for _ in range(full):
                        start=rng.randrange(n)
                        path.extend(values[(start+k)%n] for k in range(block))
                    start=rng.randrange(n)
                    path.extend(values[(start+k)%n] for k in range(remainder))
                    assert len(path)==n
                    samples.append(sum(path))
                samples.sort()
                assert near(samples[int(.05*count)],record['nominalOneSided95LowerNetUsd'])
                assert near(samples[int(.05/100*count)],record['hundredTrialAdjustedLowerNetUsd'])
                bootstrap_checks+=1
    for label,by_scenario in diagnostic['continuousBaselines'].items():
        symbol={'cash':None,'buy_hold_btc':'BTC/USD','buy_hold_eth':'ETH/USD'}[label]
        for scenario,run in by_scenario.items():
            assert run==common.evaluate([symbol]*len(target),data,'2025-01-01','2026-09-10',screen.SCENARIOS[scenario])
    return dict(passed=True,continuousLedgers=4,continuousBaselines=12,bootstrapComparisons=bootstrap_checks,
                bootstrapRepetitionsPerComparison=20000,continuous=continuous,
                sourceHashes={str(p.relative_to(ROOT)):digest(p) for p in [HERE/'analyze.py',HERE/'selected-diagnostics.json']})
def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--screen',type=Path,default=HERE/'screen')
    args=parser.parse_args()
    path=args.screen.resolve()
    spec=importlib.util.spec_from_file_location('independent_profit_search',ROOT/'tools/profit-search.py')
    screen=importlib.util.module_from_spec(spec); spec.loader.exec_module(screen)
    protocol=read(path/'protocol.json'); lock=read(path/'development-lock.json')
    result=read(path/'summary.json'); rows=read(path/'all-results.json')
    baselines=read(path/'baselines.json'); integrity=read(path/'artifact-integrity.json')
    checks=[]
    assert protocol['historicalDataAlreadyReused'] and not protocol['activationAllowed'] and not result['validatedProfitable']
    assert not result['deploymentPerformed']
    specs=screen.candidates(); ids=[c['id'] for c in specs]
    assert len(ids)==len(set(ids))==100 and {r['candidate']['id'] for r in rows}==set(ids)
    assert len(rows)==100 and protocol['candidates']==specs
    checks.append('all 100 registered configurations retained; reused-data and no-deployment labels valid')
    for rel, expected in protocol['sources'].items(): assert digest(ROOT/rel)==expected,rel
    for rel, expected in integrity.items(): assert digest(path/rel)==expected,rel
    actual={str(p.relative_to(path)) for p in path.rglob('*') if p.is_file() and p.name!='artifact-integrity.json'}
    assert actual==set(integrity)
    prior=read(screen.PRIOR/'protocol.json')
    for source in prior['sources']:
        assert digest(screen.PRIOR/source['file'])==source['sha256']
    checks.append('all study artifacts and registered sources match hashes; raw daily source hashes verified')
    common=screen.read_common(); data=common.load_data(False); screen.assert_data(data)
    prefix_checks=0
    targets={}
    for candidate in specs:
        full=screen.targets(candidate,data); targets[candidate['id']]=full
        assert len(full)==len(data['BTC/USD']) and set(full).issubset({None,'BTC/USD','ETH/USD'})
        for length in [60,89,90,91,103,150,285,469,600]:
            truncated={s:b[:length] for s,b in data.items()}
            assert screen.targets(candidate,truncated)==full[:length],(candidate['id'],length)
            prefix_checks+=1
    checks.append(f'{prefix_checks} causal prefix-invariance checks across all 100 target configurations')
    rows_by_id={r['candidate']['id']:r for r in rows}
    ranking=sorted(rows_by_id,key=lambda cid:(-min(r['selectionUtility'] for r in rows_by_id[cid]['runs']['development'].values()),cid))
    assert ranking==lock['ranking'] and ranking[0]==lock['selectedId']==result['selectedId']
    assert lock['developmentRuns']==rows_by_id[ranking[0]]['runs']['development']
    assert result['selected']==rows_by_id[ranking[0]]
    assert dt.datetime.fromisoformat(protocol['registeredAt']) <= dt.datetime.fromisoformat(lock['lockedAt'])
    # Regenerate development using only pre-July history, not the full target bank.
    development={s:[b for b in bars if b['openMs']<common.timestamp('2025-07-01')] for s,bars in data.items()}
    development_replays=0
    for candidate in specs:
        target=screen.targets(candidate,development)
        for scenario,settings in screen.SCENARIOS.items():
            replay=common.evaluate(target,development,*screen.PERIODS['development'],settings)
            assert replay==rows_by_id[candidate['id']]['runs']['development'][scenario]
            development_replays+=1
    checks.append(f'development-only rank and all {development_replays} development replays match without later data')
    ledger_checks=0
    for candidate in specs:
        cid=candidate['id']; ledger=read(path/'ledgers'/f'{cid}.json')
        assert set(ledger)==set(screen.PERIODS)
        for period,runs in ledger.items():
            for scenario,run in runs.items():
                summary={k:v for k,v in run.items() if k not in ['orders','trades','daily','rejections']}
                assert summary==rows_by_id[cid]['runs'][period][scenario]
                cash=run['initialCapitalUsd']; inventory={'BTC/USD':0.,'ETH/USD':0.}
                fee_sum=0.; previous_time=-1; first=common.timestamp(screen.PERIODS[period][0])
                lag=screen.SCENARIOS[scenario]['signalToOpenBars']
                for order in run['orders']:
                    q,p,f=order['quantity'],order['price'],order['feeUsd']
                    assert all(math.isfinite(v) and v>0 for v in (q,p)) and f>=0
                    assert order['timestampMs']>=previous_time
                    previous_time=order['timestampMs']; fee_sum+=f
                    assert near(f,q*p*screen.SCENARIOS[scenario]['feeBps']/10000)
                    asset=order['symbol']
                    if order['side']=='BUY':
                        assert not any(v>1e-9 for v in inventory.values())
                        assert order['signalBarOpenMs']>=first
                        assert order['timestampMs']-order['signalBarOpenMs']==lag*common.DAY
                        cash-=q*p+f; inventory[asset]+=q
                    else:
                        inventory[asset]-=q; cash+=q*p-f
                    assert cash>=-1e-6 and all(v>=-1e-9 for v in inventory.values())
                assert all(abs(v)<1e-9 for v in inventory.values())
                assert near(cash-run['initialCapitalUsd'],run['netPnlUsd'])
                assert near(sum(t['netPnlUsd'] for t in run['trades']),run['netPnlUsd'])
                assert near(sum(d['pnlUsd'] for d in run['daily']),run['netPnlUsd'])
                assert near(cash,run['daily'][-1]['equityUsd']) and near(fee_sum,run['feesUsd'])
                assert run['closedTrades']==len(run['trades'])
                peak=run['initialCapitalUsd']; maxdd=0.
                previous=peak
                for day in run['daily']:
                    assert near(day['equityUsd']-previous,day['pnlUsd'])
                    peak=max(peak,day['equityUsd']); maxdd=max(maxdd,peak-day['equityUsd'])
                    previous=day['equityUsd']
                assert near(maxdd,run['maxDrawdownUsd'])
                ledger_checks+=1
        assert screen.screen_summary(rows_by_id[cid]['runs'])==rows_by_id[cid]['summary']
    checks.append(f'{ledger_checks} ledgers independently reconcile funded cash, inventory, both fees, timing, daily/trade P&L and close drawdown')
    for name,by_period in baselines.items():
        symbol={'cash':None,'buy_hold_btc':'BTC/USD','buy_hold_eth':'ETH/USD'}[name]
        for period,runs in by_period.items():
            for scenario,run in runs.items():
                expected=common.evaluate([symbol]*len(data['BTC/USD']),data,*screen.PERIODS[period],screen.SCENARIOS[scenario])
                assert run==expected
                if name=='cash': assert run['netPnlUsd']==run['feesUsd']==run['closedTrades']==run['maxDrawdownUsd']==0
    checks.append('all 36 cash and equally funded buy-and-hold scenario/window baselines reproduce')
    passing=[r['candidate']['id'] for r in rows if r['summary']['exploratoryScreenPassed']]
    assert passing==result['exploratoryPassingIds'] and len(passing)==result['passingCount']
    assert sum(r['summary']['positiveAllWindowsAndScenarios'] for r in rows)==result['positiveAllWindowsCount']
    assert result['strategyWindowScenarioRuns']==1200 and result['baselineRuns']==36
    hindsight=sorted(rows_by_id,key=lambda cid:(-rows_by_id[cid]['summary']['worstLaterWindowNetUsd'],cid))[0]
    assert result['hindsightBestWorstLaterNetId']==hindsight and result['hindsightSelectionIsBiased']
    checks.append('screen pass counts, selected row and explicitly biased hindsight diagnostic reconcile')
    impossible=['pullback_btc-090','pullback_eth-090']
    assert all(not any(targets[cid]) for cid in impossible)
    unique_targets=len({json.dumps(v) for v in targets.values()})
    supplementary=audit_diagnostics(screen,common,data,path,result['selectedId']) if (HERE/'selected-diagnostics.json').exists() else None
    payload=dict(version='independent-profit-search-audit-v1',passed=True,checks=checks,
                 screenDirectory=str(path.relative_to(ROOT)),configurations=100,prefixChecks=prefix_checks,
                 independentDevelopmentReplays=development_replays,independentLedgers=ledger_checks,
                 uniqueObservedTargetPaths=unique_targets,selectedId=result['selectedId'],passingCount=result['passingCount'],
                 caveats=['All history was reused; audit correctness does not establish profit.',
                          'Six formula classes split into ten asset/family groups; 100 configurations are related.',
                          'The 90-day pullback variants are structurally unable to enter because entry requires price both above and below the same 90-day mean.',
                          'Daily execution and low-price drawdown retain the disclosed proxy limitations.',
                          'Observed unique target paths are dataset-specific, not a count of independent statistical hypotheses.'],
                 structurallyInactiveCandidates=impossible,
                 supplementaryDiagnostics=supplementary,
                 fileHashes={'tools/profit-search.py':digest(ROOT/'tools/profit-search.py'),
                             str((path/'artifact-integrity.json').relative_to(ROOT)):digest(path/'artifact-integrity.json'),
                             str(Path(__file__).relative_to(ROOT)):digest(Path(__file__))})
    (HERE/'screen-audit.json').write_text(json.dumps(payload,indent=2)+'\n')
    print(json.dumps(payload,indent=2))

if __name__=='__main__': main()
