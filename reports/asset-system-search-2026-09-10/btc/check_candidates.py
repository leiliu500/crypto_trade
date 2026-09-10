"""Independent numerical and causality checks; deliberately no P&L evaluator."""
import copy
import hashlib
import importlib.util
import itertools
import json
import math
from pathlib import Path
import statistics
import time

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
spec = importlib.util.spec_from_file_location('btc_frozen_candidates',ROOT/'candidates.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def gaussian_solve(A,b):
    augmented = [list(row)+[v] for row,v in zip(A,b)]
    n = len(b)
    for k in range(n):
        pivot = max(range(k,n),key=lambda i:abs(augmented[i][k]))
        augmented[k],augmented[pivot] = augmented[pivot],augmented[k]
        divisor = augmented[k][k]
        assert abs(divisor)>1e-14
        augmented[k] = [x/divisor for x in augmented[k]]
        for i in range(n):
            if i != k:
                scale = augmented[i][k]
                augmented[i] = [a-scale*b for a,b in zip(augmented[i],augmented[k])]
    return [row[-1] for row in augmented]


def synthetic(closes):
    bars = [dict(openMs=i*86400000,open=c,high=c*1.001,low=c*.999,close=c,volume=100.)
            for i,c in enumerate(closes)]
    return {'BTC/USD':bars,'ETH/USD':copy.deepcopy(bars)}


def independent_kalman(data,candidate):
    y = [math.log(b['close']) for b in data['BTC/USD']]
    output = [None]*len(y)
    if len(y)<=90:
        return output
    returns=[y[i]-y[i-1] for i in range(1,90)]
    R=max(statistics.variance(returns),1e-8)
    x=[y[89],statistics.mean(returns)]
    P=[[R,0.],[0.,R/90]]
    F=[[1.,1.],[0.,1.]]
    Q=[[R*.01,0.],[0.,R*.0001]]
    held=None
    for i in range(90,len(y)):
        xp=[sum(F[a][b]*x[b] for b in range(2)) for a in range(2)]
        pp=[[sum(F[a][u]*P[u][v]*F[b][v] for u in range(2) for v in range(2))+Q[a][b]
             for b in range(2)] for a in range(2)]
        gain=[pp[a][0]/(pp[0][0]+R) for a in range(2)]
        innovation=y[i]-xp[0]
        x=[xp[a]+gain[a]*innovation for a in range(2)]
        # Joseph covariance update is algebraically distinct from implementation.
        B=[[float(a==b)-gain[a]*float(b==0) for b in range(2)] for a in range(2)]
        P=[[sum(B[a][u]*pp[u][v]*B[b][v] for u in range(2) for v in range(2))+gain[a]*R*gain[b]
            for b in range(2)] for a in range(2)]
        assert P[0][0]>=0 and P[1][1]>=0 and P[0][0]*P[1][1]-P[0][1]**2>=-1e-15
        if x[1]<=0:
            held=None
        elif 20*(x[1]-math.sqrt(P[1][1]))>m.COST_LOG:
            held='BTC/USD'
        output[i]=held
    return output


def main():
    started=time.perf_counter()
    registration=json.loads((ROOT/'registration.json').read_text())
    assert hashlib.sha256((ROOT/'candidates.py').read_bytes()).hexdigest()==registration['candidateSourceSha256']
    assert m.candidates()==registration['candidates']
    full=json.loads((REPO/'reports/parallel-strategy-study-2026-09-10/data/dataset.json').read_text())
    assert len(full['BTC/USD'])==720
    numerical=0
    # Positive definite systems with nontrivial off-diagonals, independent solver.
    for n in range(1,13):
        B=[[math.sin(1+i+3*j) for j in range(n)] for i in range(n)]
        A=[[sum(B[k][i]*B[k][j] for k in range(n))+(1 if i==j else 0) for j in range(n)] for i in range(n)]
        rhs=[math.cos(i+1) for i in range(n)]
        actual=m._solve(m._cholesky(A),rhs)
        expected=gaussian_solve(A,rhs)
        assert max(abs(a-b) for a,b in zip(actual,expected))<1e-11
        numerical+=1
    points=[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[2.,-1.,.5]]
    query=[.25,.5,.75]
    K=[[.08**2*math.exp(-sum((u-v)**2 for u,v in zip(x,z))/2)+(.12**2+1e-12 if i==j else 0)
        for j,z in enumerate(points)] for i,x in enumerate(points)]
    cross=[.08**2*math.exp(-sum((u-v)**2 for u,v in zip(x,query))/2) for x in points]
    values=[.05,-.12,.08,.01]
    direct_alpha=gaussian_solve(K,values)
    expected_mu=sum(a*b for a,b in zip(cross,direct_alpha))
    expected_variance=.08**2-sum(a*b for a,b in zip(cross,gaussian_solve(K,cross)))
    L=m._cholesky(K)
    actual_mu=sum(a*b for a,b in zip(cross,m._solve(L,values)))
    actual_variance=.08**2-sum(x*x for x in m._forward(L,cross))
    assert abs(expected_mu-actual_mu)<1e-13 and abs(expected_variance-actual_variance)<1e-13
    numerical+=1
    rank_cases=0
    for permutation in itertools.permutations(range(5)):
        tau,slope=m._rank_statistics(permutation)
        inversions=sum(permutation[i]>permutation[j] for i in range(5) for j in range(i+1,5))
        assert abs(tau-(10-2*inversions)/10)<1e-14
        monotone=[x**3 for x in permutation]
        assert m._rank_statistics(monotone)[0]==tau
        rank_cases+=1
    assert m._rank_statistics([1.,1.,1.,1.])==(0.,0.)
    assert m._rank_statistics([2.,4.,6.,8.])==(1.,2.)
    assert m._rank_statistics([8.,6.,4.,2.])==(-1.,-2.)
    rank_cases+=3
    samples={
      'flat':synthetic([100.]*240),
      'rising':synthetic([100.*math.exp(.003*i) for i in range(240)]),
      'falling':synthetic([100.*math.exp(-.003*i) for i in range(240)]),
      'reversal':synthetic([100.*math.exp(.004*min(i,130)-.008*max(i-130,0)) for i in range(240)]),
      'alternating':synthetic([100.*math.exp(.035*math.sin(i*.9)) for i in range(240)]),
      'shock':synthetic([100.*math.exp(.0005*i+(.5 if i==120 else 0)) for i in range(240)])}
    target_summaries={}
    specs=m.candidates()
    for name,data in samples.items():
        target_summaries[name]={}
        for c in specs:
            path=m.targets(c,data)
            assert len(path)==240 and set(path)<={None,'BTC/USD'} and all(x is None for x in path[:90])
            target_summaries[name][c['id']]=dict(longDays=sum(x is not None for x in path),
                changes=sum(x!=y for x,y in zip(path,path[1:])),
                targetSha256=hashlib.sha256(json.dumps(path).encode()).hexdigest())
        assert m.targets(specs[0],data)==independent_kalman(data,specs[0])
    for c in specs:
        assert all(x is None for x in m.targets(c,samples['flat']))
        assert all(x is None for x in m.targets(c,samples['falling']))
    prefixes=0
    native={c['id']:m.targets(c,full) for c in specs}
    cuts=[1,28,89,90,91,97,120,181,282,366,550,719]
    for c in specs:
        for cut in cuts:
            truncated={s:bars[:cut] for s,bars in full.items()}
            assert m.targets(c,truncated)==native[c['id']][:cut],(c['id'],cut)
            prefixes+=1
    assert native[specs[0]['id']]==independent_kalman(full,specs[0])
    altered=copy.deepcopy(full)
    for bar in altered['ETH/USD']:
        for key in ('open','high','low','close'):
            bar[key]*=17
    for c in specs:
        assert m.targets(c,altered)==native[c['id']]
    # Explicit close-event path with zero ATR multiplier isolates event semantics.
    c=copy.deepcopy(specs[3]); c['constants']['atrMultiple']=0
    bars=synthetic([100.]*90+[103.,105.,110.,108.,105.,100.,103.,105.])['BTC/USD']
    path=m._directional(bars,[math.log(b['close']) for b in bars],c)
    assert path[90:]==[None,'BTC/USD','BTC/USD','BTC/USD',None,None,None,'BTC/USD']
    result=dict(status='PASS',sourceSha256=registration['candidateSourceSha256'],
        independentPositiveDefiniteAndGpPosteriorChecks=numerical,rankPermutationAndTieChecks=rank_cases,
        independentKalmanPaths=7,syntheticFamilies=len(samples),syntheticPolicyPaths=24,
        causalPrefixChecks=prefixes,otherAssetIsolationChecks=4,directionalEventPathChecks=1,
        nativeTargetDiagnostics={cid:dict(longBars=sum(x is not None for x in path),
            changes=sum(x!=y for x,y in zip(path,path[1:])),
            sha256=hashlib.sha256(json.dumps(path).encode()).hexdigest()) for cid,path in native.items()},
        syntheticTargetDiagnostics=target_summaries,elapsedSeconds=time.perf_counter()-started,
        limitation='Checks prove these bounded implementation properties, not profit, calibrated uncertainty, or global structural originality.')
    (ROOT/'checks.json').write_text(json.dumps(result,indent=2,allow_nan=False)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k not in ('nativeTargetDiagnostics','syntheticTargetDiagnostics')}))


if __name__=='__main__':
    main()
