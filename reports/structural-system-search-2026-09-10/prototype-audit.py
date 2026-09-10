#!/usr/bin/env python3
"""Independent structural-prototype audit; no model changes or order routing."""
import importlib.util
import argparse
import hashlib
import json
import math
import itertools
from pathlib import Path

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value
def near(a,b): return math.isclose(a,b,rel_tol=1e-9,abs_tol=1e-11)
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def read(path): return json.loads(path.read_text())

def audit_changepoint():
    model=module('audit_changepoint',HERE/'changepoint.py')
    seq=[.004,-.003,.002,.04,-.015,.001]
    filter=model.RunLengthFilter(.0001)
    prior=filter.prior
    # Explicit enumeration of all 2^t growth/reset histories, without its step or log-density routines.
    branches=[(1.,0,prior)]
    checks=0
    for observation in seq:
        expanded=[]
        for weight,run,(mu,kappa,alpha,beta) in branches:
            df=2*alpha; scale2=beta*(kappa+1)/(alpha*kappa)
            density=math.gamma((df+1)/2)/(math.gamma(df/2)*math.sqrt(df*math.pi*scale2))
            density*=(1+(observation-mu)**2/(df*scale2))**(-(df+1)/2)
            posterior=((kappa*mu+observation)/(kappa+1),kappa+1,alpha+.5,
                       beta+kappa*(observation-mu)**2/(2*(kappa+1)))
            h=model.SPEC['hazard']
            expanded.extend([(weight*density*h,0,prior),(weight*density*(1-h),run+1,posterior)])
        norm=sum(b[0] for b in expanded)
        branches=[(weight/norm,run,stats) for weight,run,stats in expanded]
        expected={}
        for weight,run,stats in branches: expected[run]=expected.get(run,0)+weight
        actual=filter.step(observation)
        assert len(filter.stats)==len(expected)
        for run,weight in expected.items(): assert near(weight,math.exp(filter.log_weights[run]))
        mu=sum(weight*stats[0] for weight,run,stats in branches)
        variance=sum(weight*(stats[3]/(stats[1]*(stats[2]-1))+stats[0]**2) for weight,run,stats in branches)-mu**2
        factor=sum((1-model.SPEC['hazard'])**k for k in range(model.SPEC['decisionHorizonDays']))
        assert near(actual['meanDailyLogReturn'],mu)
        assert near(actual['expectedRunDays'],sum(weight*run for weight,run,stats in branches))
        assert near(actual['next20DayMean'],factor*mu)
        assert near(actual['latentMeanUncertainty'],factor*math.sqrt(max(0.,variance)))
        checks+=1
    return dict(passed=True,enumeratedObservationUpdates=checks,finalEnumeratedPaths=len(branches),
                verified=['Student-t predictive density against direct gamma expression',
                          'Run-length posterior against all binary reset/growth paths',
                          'Conjugate state updates and mixture latent-mean moments',
                          '20-day hazard-survival expectation and declared mean-uncertainty penalty'],
                limitation='Latent-mean uncertainty omits future observation/process uncertainty; it is not a calibrated trade-loss quantile.')

def audit_hmm():
    hmm=module('audit_hmm_equations',HERE/'hmm.py'); spec=hmm.SPEC
    def density(x,mu,var): return math.exp(-((x-mu)**2)/(2*var))/math.sqrt(2*math.pi*var)
    fixed={'means':[-.018,.001,.024],'variances':[.00014,.00007,.00019],
           'transition':[[.88,.1,.02],[.08,.87,.05],[.03,.07,.9]],'initial':[.2,.3,.5]}
    values=[-.012,.003,.016,-.007]
    ending=[0.]*3
    for states in itertools.product(range(3),repeat=4):
        prob=fixed['initial'][states[0]]
        for t,x in enumerate(values):
            if t: prob*=fixed['transition'][states[t-1]][states[t]]
            prob*=density(x,fixed['means'][states[t]],fixed['variances'][states[t]])
        ending[states[-1]]+=prob
    a,_,ll=hmm.forward(values,fixed)
    assert near(ll,math.log(sum(ending)))
    assert all(near(math.exp(a[-1][j]),ending[j]/sum(ending)) for j in range(3))
    # Independent probability-domain, scaled forward/backward implementation of the frozen regularized fit.
    xs=[-.02+.003*math.sin(i) for i in range(30)]+[.002*math.cos(i) for i in range(30)]+[.025+.004*math.sin(i) for i in range(30)]
    mean=sum(xs)/90; gv=max(hmm.VAR_FLOOR,sum((x-mean)**2 for x in xs)/90)
    ordered=sorted(xs); means=[ordered[math.ceil(q*90)-1] for q in spec['initialMeansTrainingQuantiles']]
    variances=[gv]*3; A=[[.9 if i==j else .05 for j in range(3)] for i in range(3)]
    initial=list(spec['initialStateProbabilities']); pseudo=spec['emissionPseudoObservations']
    for _ in range(spec['trainingIterations']):
        B=[[density(x,means[j],variances[j]) for j in range(3)] for x in xs]
        alpha=[]; scales=[]
        for t in range(90):
            predicted=initial if t==0 else [sum(alpha[t-1][i]*A[i][j] for i in range(3)) for j in range(3)]
            raw=[predicted[j]*B[t][j] for j in range(3)]; total=sum(raw)
            alpha.append([x/total for x in raw]); scales.append(total)
        beta=[[1.]*3 for _ in xs]
        for t in range(88,-1,-1):
            beta[t]=[sum(A[i][j]*B[t+1][j]*beta[t+1][j] for j in range(3))/scales[t+1] for i in range(3)]
        gamma=[]
        for t in range(90):
            raw=[alpha[t][j]*beta[t][j] for j in range(3)]; z=sum(raw); gamma.append([x/z for x in raw])
        counts=[[spec['transitionPseudocountDiagonal'] if i==j else spec['transitionPseudocountOffDiagonal'] for j in range(3)] for i in range(3)]
        for t in range(89):
            raw=[[alpha[t][i]*A[i][j]*B[t+1][j]*beta[t+1][j] for j in range(3)] for i in range(3)]
            z=sum(sum(row) for row in raw)
            for i in range(3):
                for j in range(3): counts[i][j]+=raw[i][j]/z
        means=[]; variances=[]
        for j in range(3):
            w=sum(g[j] for g in gamma); mu=sum(gamma[t][j]*xs[t] for t in range(90))/(w+pseudo)
            var=(sum(gamma[t][j]*(xs[t]-mu)**2 for t in range(90))+pseudo*(gv+mu**2))/(w+pseudo)
            means.append(mu); variances.append(max(hmm.VAR_FLOOR,var))
        A=[[x/sum(row) for x in row] for row in counts]
    order=sorted(range(3),key=lambda j:means[j]); actual=hmm.fit(xs)
    assert all(near(actual['means'][k],means[j]) and near(actual['variances'][k],variances[j]) for k,j in enumerate(order))
    assert all(near(actual['transition'][k][l],A[i][j]) for k,i in enumerate(order) for l,j in enumerate(order))
    posterior=[.2,.3,.5]; total=0.; distribution=list(posterior)
    for _ in range(spec['forecastHorizonDays']):
        distribution=[sum(distribution[i]*fixed['transition'][i][j] for i in range(3)) for j in range(3)]
        total+=sum(distribution[j]*fixed['means'][j] for j in range(3))
    assert near(total,hmm.expected_log_growth(posterior,fixed))
    return dict(passed=True,enumeratedLatentPaths=81,independentRegularizedEMIterations=40,
                verified=['Normal emissions and forward likelihood/posterior against exhaustive paths',
                          'Scaled probability-domain forward/backward and regularized parameter updates match fitted model',
                          'Sorted means permute both transition axes consistently','Fourteen-day conditional log-growth expectation'],
                limitation='Expected log growth is a model projection, not calibrated net cash profit; 90-return parameter fit stays frozen.')

def audit_study(study):
    study=study.resolve()
    protocol=read(study/'protocol.json'); summary=read(study/'summary.json')
    lock=read(study/'selection-lock.json'); targets=read(study/'targets.json')
    ledgers=read(study/'full-ledgers.json'); integrity=read(study/'integrity.json')
    for rel,expected in protocol['hashes'].items(): assert digest(REPO/rel)==expected,rel
    for rel,expected in integrity.items(): assert digest(study/rel)==expected,rel
    assert set(integrity)=={p.name for p in study.iterdir() if p.is_file() and p.name!='integrity.json'}
    assert protocol['newPrototypeCount']==summary['prototypeCount']==2
    assert protocol['requestedDistinctSystems']==10000 and not protocol['tenThousandSearchComplete']
    assert not summary['tenThousandSearchComplete'] and summary['originalInventions']==0
    assert not summary['productionChanged'] and not summary['realOrdersSubmitted'] and not summary['validatedProfitable']
    search=module('audit_previous_search',REPO/'tools/profit-search.py')
    common=search.read_common(); data=common.load_data(False)
    change=module('audit_study_change',HERE/'changepoint.py'); hmm=module('audit_study_hmm',HERE/'hmm.py')
    assert change.SPEC==protocol['mathematicalDefinitions']['bocpd'] and hmm.SPEC==protocol['mathematicalDefinitions']['hmm']
    prefix_checks=0
    for name,model in [('bocpd',change),('hmm',hmm)]:
        full=model.generate(data); assert full==targets[name]
        for length in [60,89,90,91,92,103,150,285,469,600]:
            assert model.generate({s:bars[:length] for s,bars in data.items()})==full[:length],(name,length)
            prefix_checks+=1
    assert targets['prior_eth40']==search.targets(dict(family='sma_eth',lookbackDays=40),data)
    utilities={name:min(r['selectionUtility'] for r in ledgers[name]['development'].values()) for name in ['bocpd','hmm']}
    assert utilities==lock['developmentUtilities']
    assert min(utilities,key=lambda k:(-utilities[k],k))==lock['selectedId']==summary['selectedId']
    development={s:[b for b in bars if b['openMs']<common.timestamp('2025-07-01')] for s,bars in data.items()}
    for name,model in [('bocpd',change),('hmm',hmm)]:
        target=model.generate(development)
        for scenario,settings in search.SCENARIOS.items():
            assert common.evaluate(target,development,*search.PERIODS['development'],settings,details=True)==ledgers[name]['development'][scenario]
    ledger_count=0
    for name,periods in ledgers.items():
        for period,scenarios in periods.items():
            for scenario,run in scenarios.items():
                assert {k:v for k,v in run.items() if k not in ['daily','orders','trades','rejections']}==summary['performance'][name][period][scenario]
                expected=common.evaluate(targets[name],data,*protocol['periods'][period],search.SCENARIOS[scenario],details=True)
                assert expected==run
                cash=10000.; inventory={'BTC/USD':0.,'ETH/USD':0.}; fees=0.
                previous_time=-1; lag=search.SCENARIOS[scenario]['signalToOpenBars']
                for order in run['orders']:
                    sign=1 if order['side']=='BUY' else -1
                    cash-=sign*order['quantity']*order['price']+order['feeUsd']
                    inventory[order['symbol']]+=sign*order['quantity']; fees+=order['feeUsd']
                    assert cash>=-1e-6 and all(q>=-1e-9 for q in inventory.values())
                    assert order['timestampMs']>=previous_time; previous_time=order['timestampMs']
                    if order['side']=='BUY':
                        assert order['timestampMs']-order['signalBarOpenMs']==lag*common.DAY
                    assert near(order['feeUsd'],order['quantity']*order['price']*search.SCENARIOS[scenario]['feeBps']/10000)
                assert all(abs(q)<1e-9 for q in inventory.values())
                assert math.isclose(cash-10000,run['netPnlUsd'],abs_tol=1e-6)
                assert math.isclose(fees,run['feesUsd'],abs_tol=1e-6)
                assert math.isclose(sum(t['netPnlUsd'] for t in run['trades']),run['netPnlUsd'],abs_tol=1e-6)
                assert math.isclose(sum(d['pnlUsd'] for d in run['daily']),run['netPnlUsd'],abs_tol=1e-6)
                peak=10000.; maxdd=0.
                for day in run['daily']:
                    peak=max(peak,day['equityUsd']); maxdd=max(maxdd,peak-day['equityUsd'])
                assert math.isclose(maxdd,run['maxDrawdownUsd'],abs_tol=1e-6)
                ledger_count+=1
        if name in ['bocpd','hmm']:
            assert search.screen_summary({p:r for p,r in periods.items() if p!='continuous'})==summary['nomination'][name]
    assert ledger_count==96
    closes=[b['close'] for b in data['ETH/USD']]
    training=[math.log(closes[i])-math.log(closes[i-1]) for i in range(1,91)]
    fitted=hmm.fit(training)
    state_growth=[hmm.expected_log_growth([float(i==j) for i in range(3)],fitted) for j in range(3)]
    fee=hmm.SPEC['entryFeeBpsReference']/10000; slip=hmm.SPEC['adversePriceBpsReference']/10000
    hurdle=math.log((1+fee)*(1+slip)/((1-fee)*(1-slip)))
    always_long=min(state_growth)>hurdle
    assert always_long and all(t=='ETH/USD' for t in targets['hmm'][90:])
    for period in ledgers['hmm']:
        for scenario,run in ledgers['hmm'][period].items(): assert run==ledgers['buy_hold_eth'][period][scenario]
    return dict(passed=True,prefixChecks=prefix_checks,developmentOnlyReplays=8,ledgerReconciliations=ledger_count,
                selectedId=summary['selectedId'],newPrototypes=2,originalMathematics=0,requested10000Complete=False,
                statement='Two distinct latent-state inference templates using established mathematics. Under its frozen learned parameters, HMM trading control is equivalent to long-only buy-and-hold after warmup; only BOCPD adds nonbaseline fitted behavior. No new economic premium or future profit established.',
                hmmPolicyRedundancy=dict(alwaysLongForAnyPostTrainingPosterior=always_long,
                                         pureState14DayGrowth=state_growth,entryLogHurdle=hurdle,
                                         reason='Forecast is linear in the posterior; every simplex vertex exceeds the hurdle, so every convex mixture does.',
                                         identicalBuyHoldWindowScenarioLedgers=16),
                hashes={str(p.relative_to(REPO)):digest(p) for p in [study/'integrity.json',HERE/'changepoint.py',HERE/'hmm.py']})

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--study',type=Path)
    args=parser.parse_args()
    result={'changepoint':audit_changepoint()}
    if (HERE/'hmm.py').exists(): result['hmm']=audit_hmm()
    if args.study: result['study']=audit_study(args.study)
    (HERE/'prototype-audit.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))

if __name__=='__main__': main()
