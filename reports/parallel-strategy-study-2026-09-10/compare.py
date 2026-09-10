"""Locked family selections, validation selection, then chronological final audit."""
import datetime as dt
import hashlib
import json
import random
from common import ROOT, evaluate, load_data
from audit import module

FAMILIES = ['trend','reversion','rotation']

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def save(name, obj):
    (ROOT/name).write_text(json.dumps(obj,indent=2)+'\n')

def summary(result):
    return {k:v for k,v in result.items() if k not in ['daily','orders','trades','rejections']}

def bootstrap(result, baseline, seed=20260910):
    values = [r['pnlUsd']-b['pnlUsd'] for r,b in zip(result['daily'],baseline['daily'])]
    assert [r['date'] for r in result['daily']] == [r['date'] for r in baseline['daily']]
    rng = random.Random(seed); n=len(values); totals=[]
    blocks = [sum(values[(i+k)%n] for k in range(14)) for i in range(n)]
    for _ in range(5000):
        full,remainder=divmod(n,14)
        total=sum(blocks[rng.randrange(n)] for _ in range(full))
        start=rng.randrange(n)
        total += sum(values[(start+k)%n] for k in range(remainder))
        totals.append(total)
    totals.sort()
    return dict(excessNetUsd=sum(values),nominalOneSided95LowerNetUsd=totals[int(.05*len(totals))],
                twelveTrialAdjustedLowerNetUsd=totals[int((.05/12)*len(totals))],
                replicates=len(totals),blockDays=14,descriptiveNotProspective=True)

def validate():
    protocol=json.loads((ROOT/'protocol.json').read_text())
    data=load_data(False)
    # Validation code receives only bars before 2026; final outcome generation is a separate invocation.
    from common import timestamp
    data={s:[b for b in bs if b['openMs'] < timestamp('2026-01-01')] for s,bs in data.items()}
    selections, validation = {}, {}
    for family in FAMILIES:
        chosen=json.loads((ROOT/family/'selection.json').read_text())
        params=chosen['params']; mod=module(family)
        assert params in mod.VARIANTS
        dev=load_data()
        trials=[]
        for variant in mod.VARIANTS:
            scores=evaluate(mod.generate(dev,variant),dev,scenario='stress')
            trials.append((scores['selectionUtility'],variant['id']))
        expected=min(trials,key=lambda x:(-x[0],x[1]))[1]
        assert params['id']==expected, (family,'development selection mismatch')
        selections[family]=dict(params=params,candidateSha256=digest(ROOT/family/'candidate.py'),
                                 selectionSha256=digest(ROOT/family/'selection.json'))
        targets=mod.generate(data,params)
        validation[family]={scenario:evaluate(targets,data,*protocol['periods']['validation'],scenario=scenario,details=True) for scenario in ['base','stress']}
    winner=min(FAMILIES,key=lambda f:(-validation[f]['stress']['selectionUtility'],f))
    dev=load_data(); baseline_scores={}
    for symbol,name in [('BTC/USD','buy-hold-btc'),('ETH/USD','buy-hold-eth')]:
        baseline_scores[name]=evaluate([symbol]*len(dev[symbol]),dev,scenario='stress')['selectionUtility']
    baseline=min(baseline_scores,key=lambda k:(-baseline_scores[k],k))
    lock=dict(lockedAt=dt.datetime.now(dt.timezone.utc).isoformat(),selectedFamily=winner,
              selectedParams=selections[winner]['params'],selections=selections,
              developmentSelectedBaseline=baseline,baselineDevelopmentUtility=baseline_scores,
              commonSha256=digest(ROOT/'common.py'),protocolSha256=digest(ROOT/'protocol.json'),
              finalEvaluated=False,validationRanking=sorted(FAMILIES,key=lambda f:(-validation[f]['stress']['selectionUtility'],f)))
    save('validation.json',validation); save('final-selection-lock.json',lock)
    print(json.dumps(dict(selectedFamily=winner,validation={f:{s:summary(x) for s,x in by.items()} for f,by in validation.items()}),indent=2))

def final():
    lock=json.loads((ROOT/'final-selection-lock.json').read_text())
    assert digest(ROOT/'common.py')==lock['commonSha256']
    assert digest(ROOT/'protocol.json')==lock['protocolSha256']
    protocol=json.loads((ROOT/'protocol.json').read_text()); data=load_data(False)
    val=json.loads((ROOT/'validation.json').read_text())
    outputs, metrics, sensitivity, qualifications = {}, {}, {}, {}
    for family in FAMILIES:
        assert digest(ROOT/family/'candidate.py')==lock['selections'][family]['candidateSha256']
        params=lock['selections'][family]['params']
        targets=module(family).generate(data,params)
        outputs[family]={s:evaluate(targets,data,*protocol['periods']['final'],scenario=s,details=True) for s in ['base','stress']}
        sensitivity[family]=dict(
            feeOnly=[evaluate(targets,data,*protocol['periods']['final'],scenario=dict(feeBps=f,slippageBps=3,signalToOpenBars=2)) for f in [0,20,40,80,100]],
            sameLagCostStress=evaluate(targets,data,*protocol['periods']['final'],scenario=dict(feeBps=100,slippageBps=10,signalToOpenBars=2)),
            currentPaperSizing={s:evaluate(targets,data,*protocol['periods']['final'],scenario=s,budget=100,capital=100000) for s in ['base','stress']})
    for name,symbol in [('cash',None),('buy-hold-btc','BTC/USD'),('buy-hold-eth','ETH/USD')]:
        targets=[symbol]*len(data['BTC/USD'])
        outputs[name]={s:evaluate(targets,data,*protocol['periods']['final'],scenario=s,details=True) for s in ['base','stress']}
    confidence={}
    for family in FAMILIES:
        confidence[family]={baseline:bootstrap(outputs[family]['base'],outputs[baseline]['base']) for baseline in ['cash',lock['developmentSelectedBaseline']]}
        checks=dict(
            positiveValidationBaseAndStress=all(val[family][s]['netPnlUsd']>0 for s in ['base','stress']),
            positiveFinalBaseAndStress=all(outputs[family][s]['netPnlUsd']>0 for s in ['base','stress']),
            minimumTenLaterClosedTrades=all(val[family][s]['closedTrades']+outputs[family][s]['closedTrades']>=10 for s in ['base','stress']),
            tradesInEachLaterPeriod=all(val[family][s]['closedTrades']>0 and outputs[family][s]['closedTrades']>0 for s in ['base','stress']),
            maxFinalDrawdownWithin500=all(outputs[family][s]['maxDrawdownUsd']<=500 for s in ['base','stress']),
            positiveAdjustedPairedLowerBounds=all(x['twelveTrialAdjustedLowerNetUsd']>0 for x in confidence[family].values()))
        qualifications[family]=dict(passed=all(checks.values()),checks=checks)
    metrics={name:{s:summary(x) for s,x in results.items()} for name,results in outputs.items()}
    save('final-detail.json',outputs); save('sensitivity.json',sensitivity)
    save('comparison.json',dict(version='parallel-native-spot-comparison-v1',selectedBeforeFinal=lock['selectedFamily'],
          finalPeriod=protocol['periods']['final'],trialCount=12,validation={f:{s:summary(x) for s,x in by.items()} for f,by in val.items()},
          final=metrics,confidence=confidence,qualification=qualifications,
          anyCandidateQualified=any(q['passed'] for q in qualifications.values()),
          productionChanged=False,realOrdersSubmitted=False))
    print(json.dumps(dict(selectedBeforeFinal=lock['selectedFamily'],final={f:{s:dict(net=outputs[f][s]['netPnlUsd'],trades=outputs[f][s]['closedTrades'],drawdown=outputs[f][s]['maxDrawdownUsd']) for s in ['base','stress']} for f in outputs},qualification=qualifications),indent=2))

if __name__=='__main__':
    import sys
    {'validate':validate,'final':final}[sys.argv[1]]()
