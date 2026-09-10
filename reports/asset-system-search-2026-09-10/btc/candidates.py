"""Four frozen BTC research policies. No execution, network, or P&L selection.

Inputs are completed daily OHLC bars. Each output is a desired funded long/cash
state; the common evaluator applies finalization delay and account constraints.
All constants below were chosen before this tranche's performance evaluation.
"""
import math
import statistics

ASSET = 'BTC/USD'
WARMUP = 90
COST_LOG = math.log((1 + .008) * (1 + .0003) / ((1 - .008) * (1 - .0003)))


def candidates():
    shared = dict(asset=ASSET, warmupBars=WARMUP,
                  researchOnly=True, validatedProfitable=False,
                  mathematicalNovelty='Established mathematics, no original invention claimed',
                  economics='Directional persistence or conditional positive returns; no structural arbitrage',
                  constraints=['Funded BTC long or cash only; no leverage, shorts, or additions',
                               'Completed daily observations only; execution delay supplied by shared evaluator',
                               'Reused history; no untouched holdout or prospective profitability evidence',
                               'Decision thresholds fixed at base costs across all cost/delay scenarios'])
    rows = [
        dict(id='btc_kalman_velocity_v1', name='Latent local-linear trend', family='kalman_local_linear',
             constants=dict(forecastDays=20, uncertaintyPenalty=1, observationVarianceScale=1,
                            levelProcessVarianceScale=.01, velocityProcessVarianceScale=.0001,
                            initialVelocityVarianceDivisor=90, returnVarianceFloor=1e-8),
             state='Filtered log level, daily log velocity, 2x2 covariance, previous desired target',
             equations=['x_t = F x_(t-1) + w_t, F=[[1,1],[0,1]], log(C_t)=H x_t+v_t, H=[1,0]',
                        'R=sample variance of first89 daily log returns; Q=diag(.01R,.0001R), then frozen',
                        'Pminus=F P F^T+Q; K=Pminus H^T/(H Pminus H^T+R)',
                        'x=xminus+K(log(C)-H xminus); P=(I-KH)Pminus',
                        'Enter when20*(velocity-sqrt(P_velocity)) > fixed base log roundtripcost; exit when velocity<=0'],
             initialization='At completed bar89: level=log(C89), velocity=mean(r1..r89), P=diag(R,R/90); no prior trades',
             null='The inferred positive latent velocity fails to persist long enough to pay both sides of trading costs',
             failureRegime='Abrupt reversal, volatility shifts, misspecified linear-Gaussian dynamics; covariance is not calibrated tail risk',
             nearestPrior='SMA/endpoint trend and adaptive Bayesian regression already exist',
             structuralDifference='Two-dimensional latent level/velocity dynamics with propagated state covariance, versus fixed-window price averages or supervised coefficient regression',
             distinctnessStatus='Provisional new daily inference implementation; fixed-gain filtering can be represented as an infinite linear filter, so no claim of independent new economics',
             sources=[dict(title='Kalman (1960), A New Approach to Linear Filtering and Prediction Problems',
                           url='https://doi.org/10.1115/1.3662552',
                           verification='Bibliographic record verified; direct paper download unavailable during source lookup')]),
        dict(id='btc_nonlinear_gp_v1', name='Causal nonlinear return forecast', family='squared_exponential_gp',
             constants=dict(horizonDays=14, retrainEveryBars=7, trainingStrideBars=3,
                            maximumTrainingRows=40, minimumTrainingRows=12,
                            kernelAmplitude=.08, observationNoise=.12, lengthScale=1,
                            featureScales=[.05,.10,.03], uncertaintyPenalty=.25,
                            numericalJitter=1e-12),
             state='Bounded causal labeled feature bank; weekly frozen kernel factor and coefficients; previous target',
             equations=['z_t=[log(C_t/C_(t-7))/.05, log(C_t/C_(t-28))/.10, stdev(r_(t-13)..r_t)/.03]',
                        'y_j=log(C_(j+14)/C_j), eligible only when j+14<=t; train at90+7k',
                        'Use at most40 indices j=t-14-3k>=28; k(z,zprime)=.08^2*exp(-||z-zprime||^2/2)',
                        'A=K+(.12^2+1e-12)I; mu=kstar^T A^-1 y; latentVariance=.08^2-kstar^T A^-1 kstar',
                        'Enter when mu-.25*sqrt(latentVariance)>fixed base log roundtripcost; exit when mu<=0'],
             initialization='No target until90 bars and at least12 fully matured labels; zero-mean GP prior, no fit to future labels',
             null='Past local return patterns have no stable conditional mean beyond costs; predicted gains fail after delay',
             failureRegime='Regime changes, limited training support, overlapping labels, and uncalibrated kernel/noise assumptions',
             nearestPrior='Existing Gaussian-distance empirical conditional averages and ridge regression; prior GP catalog was advisory only',
             structuralDifference='Nonlinear full training-kernel inverse and joint posterior covariance; not the existing normalized independent distance-weighted average or a linear-kernel/ridge substitution',
             distinctnessStatus='Provisional distinct nonlinear inference implementation; predictive confidence is model-based, not empirically calibrated',
             sources=[dict(title='Rasmussen and Williams, Gaussian Processes for Machine Learning, Chapter2',
                           url='https://gaussianprocess.org/gpml/chapters/RW2.pdf',
                           verification='Primary author-hosted chapter opened; regression equations2.22–2.24')]),
        dict(id='btc_rank_sen_trend_v1', name='Rank persistence and robust slope', family='mann_kendall_theil_sen',
             constants=dict(windowDays=60, minimumKendallTau=.35, forecastDays=20),
             state='Latest60 log closes and previous desired target',
             equations=['S=sum_(a<b) sign(log(C_b)-log(C_a)); tau=S/[60*59/2]',
                        'SenSlope=median_(a<b)((log(C_b)-log(C_a))/(b-a))',
                        'Enter when tau>=.35 and20*SenSlope>fixed base log roundtripcost; exit when tau<=0 or SenSlope<=0'],
             initialization='First eligible decision at90; retain target in entry/exit hysteresis region',
             null='Rank-monotone historical paths do not imply enough future positive slope to overcome trading costs',
             failureRegime='Slow exits after reversals, persistent sideways noise; serial dependence invalidates treating tau as a significance test',
             nearestPrior='SMA/endpoint momentum/channel trend; the new statistic remains in the directional-persistence economic family',
             structuralDifference='All-pair ordinal evidence and median pairwise slopes are nonlinear rank estimators, not fixed linear price averages or rolling extrema',
             distinctnessStatus='Provisional new estimator composition, not a new economic mechanism; tau is descriptive and no p-value is asserted',
             sources=[dict(title='Mann (1945), Nonparametric Tests Against Trend',
                           url='https://www.jstor.org/stable/1907187',
                           verification='Primary article URL resolves but full text not available via tool'),
                      dict(title="Sen (1968), Estimates of the Regression Coefficient Based on Kendall's Tau",
                           url='https://doi.org/10.1080/01621459.1968.10480934',
                           verification='Bibliography verified; publisher returned403')]),
        dict(id='btc_directional_change_v1', name='Directional-change event state', family='directional_change_event_clock',
             constants=dict(atrDays=14, minimumReversalFraction=.04, atrMultiple=3),
             state='Up/down event direction, extremum since last opposite event, reversal fraction fixed at each event',
             equations=['TR_t=max(H_t-L_t,abs(H_t-C_(t-1)),abs(L_t-C_(t-1))); ATR14=mean(latest14TR)',
                        'At initialization or an event set delta=max(.04,3*ATR14/C_t); freeze delta until next event',
                        'Down state: trough=min(trough,C_t); if C_t>=trough*(1+delta), switch up, peak=C_t',
                        'Up state: peak=max(peak,C_t); if C_t<=peak*(1-delta), switch down, trough=C_t',
                        'Target BTC in up state, cash in down state; sample only daily closes, never infer intraday event ordering'],
             initialization='At89 initialize down, trough=C89, freeze then-current reversal fraction; first eligible target90',
             null='Price overshoots following a confirmed reversal are too small or too short to clear fees and delayed entries',
             failureRegime='Alternating reversals, overshoots completed before delayed execution, threshold frozen across volatility changes',
             nearestPrior='Close-channel breakouts and trailing exit controls',
             structuralDifference='Event-reset unbounded-memory extrema rather than extrema over a fixed calendar window; both entry and exit move the event clock',
             distinctnessStatus='Established directional-change control variant; conservative new-mathematics count excludes it pending equivalence review',
             sources=[dict(title='Glattfelder and Golub, Bridging the Gap: Decoding the Intrinsic Nature of Time in Market Data',
                           url='https://arxiv.org/abs/2204.02682',
                           verification='Primary preprint abstract opened; event-time mathematics is provenance, not evidence for BTC profit')]),
    ]
    return [dict(shared, **row) for row in rows]


def _logs(data):
    bars = data[ASSET]
    for b in bars:
        if not all(math.isfinite(b[k]) and b[k] > 0 for k in ('open', 'high', 'low', 'close')):
            raise ValueError('BTC OHLC must be finite and positive')
    return bars, [math.log(b['close']) for b in bars]


def _kalman(bars, y, spec):
    out = [None] * len(y)
    if len(y) <= WARMUP:
        return out
    cfg = spec['constants']
    returns = [y[j]-y[j-1] for j in range(1,WARMUP)]
    variance = max(statistics.variance(returns), cfg['returnVarianceFloor'])
    R = variance * cfg['observationVarianceScale']
    q0, q1 = variance*cfg['levelProcessVarianceScale'], variance*cfg['velocityProcessVarianceScale']
    level, velocity = y[WARMUP-1], statistics.fmean(returns)
    p00, p01, p11 = variance, 0., variance/cfg['initialVelocityVarianceDivisor']
    held = None
    for i in range(WARMUP,len(y)):
        a, b, d = p00+2*p01+p11+q0, p01+p11, p11+q1
        residual = y[i]-(level+velocity)
        denominator = a+R
        k0, k1 = a/denominator, b/denominator
        level, velocity = level+velocity+k0*residual, velocity+k1*residual
        p00, p01, p11 = a*R/denominator, b*R/denominator, max(0., d-b*b/denominator)
        if velocity <= 0:
            held = None
        elif cfg['forecastDays']*(velocity-cfg['uncertaintyPenalty']*math.sqrt(p11)) > COST_LOG:
            held = ASSET
        out[i] = held
    return out


def _cholesky(matrix):
    n = len(matrix)
    L = [[0.] * n for _ in range(n)]
    for i in range(n):
        for j in range(i+1):
            value = matrix[i][j]-sum(L[i][k]*L[j][k] for k in range(j))
            if i == j:
                if value <= 0:
                    raise ArithmeticError('Nonpositive GP covariance pivot')
                L[i][j] = math.sqrt(value)
            else:
                L[i][j] = value/L[j][j]
    return L


def _forward(L, rhs):
    out = []
    for i in range(len(rhs)):
        out.append((rhs[i]-sum(L[i][j]*out[j] for j in range(i)))/L[i][i])
    return out


def _solve(L, rhs):
    intermediate = _forward(L,rhs)
    out = [0.] * len(rhs)
    for i in range(len(rhs)-1,-1,-1):
        out[i] = (intermediate[i]-sum(L[j][i]*out[j] for j in range(i+1,len(rhs))))/L[i][i]
    return out


def _feature(y, i, scales):
    returns = [y[j]-y[j-1] for j in range(i-13,i+1)]
    return [(y[i]-y[i-7])/scales[0], (y[i]-y[i-28])/scales[1], statistics.stdev(returns)/scales[2]]


def _kernel(left, right, amplitude, scale):
    return amplitude*amplitude*math.exp(-sum((a-b)**2 for a,b in zip(left,right))/(2*scale*scale))


def _gp(bars, y, spec):
    out = [None] * len(y)
    cfg = spec['constants']
    held, model = None, None
    for i in range(WARMUP,len(y)):
        if (i-WARMUP) % cfg['retrainEveryBars'] == 0:
            indices = list(range(i-cfg['horizonDays'],27,-cfg['trainingStrideBars']))[:cfg['maximumTrainingRows']]
            if len(indices) >= cfg['minimumTrainingRows']:
                features = [_feature(y,j,cfg['featureScales']) for j in indices]
                values = [y[j+cfg['horizonDays']]-y[j] for j in indices]
                kernel = [[_kernel(x,z,cfg['kernelAmplitude'],cfg['lengthScale']) for z in features] for x in features]
                for j in range(len(indices)):
                    kernel[j][j] += cfg['observationNoise']**2+cfg['numericalJitter']
                factor = _cholesky(kernel)
                model = (features,factor,_solve(factor,values))
        if model is not None:
            features, factor, alpha = model
            query = _feature(y,i,cfg['featureScales'])
            cross = [_kernel(x,query,cfg['kernelAmplitude'],cfg['lengthScale']) for x in features]
            mean = sum(k*a for k,a in zip(cross,alpha))
            whitened = _forward(factor,cross)
            variance = max(0.,cfg['kernelAmplitude']**2-sum(x*x for x in whitened))
            if mean <= 0:
                held = None
            elif mean-cfg['uncertaintyPenalty']*math.sqrt(variance) > COST_LOG:
                held = ASSET
        out[i] = held
    return out


def _rank_statistics(window):
    slopes, score = [], 0
    for i in range(len(window)):
        for j in range(i+1,len(window)):
            difference = window[j]-window[i]
            score += (difference > 0)-(difference < 0)
            slopes.append(difference/(j-i))
    return score/len(slopes), statistics.median(slopes)


def _rank(bars, y, spec):
    out = [None] * len(y)
    cfg, held = spec['constants'], None
    for i in range(WARMUP,len(y)):
        tau, slope = _rank_statistics(y[i-cfg['windowDays']+1:i+1])
        if tau <= 0 or slope <= 0:
            held = None
        elif tau >= cfg['minimumKendallTau'] and cfg['forecastDays']*slope > COST_LOG:
            held = ASSET
        out[i] = held
    return out


def _threshold(bars,i,cfg):
    true_ranges = [max(bars[j]['high']-bars[j]['low'],
                       abs(bars[j]['high']-bars[j-1]['close']),
                       abs(bars[j]['low']-bars[j-1]['close']))
                   for j in range(i-cfg['atrDays']+1,i+1)]
    return max(cfg['minimumReversalFraction'],cfg['atrMultiple']*statistics.fmean(true_ranges)/bars[i]['close'])


def _directional(bars,y,spec):
    out = [None] * len(y)
    if len(y) <= WARMUP:
        return out
    cfg, up = spec['constants'], False
    extremum = bars[WARMUP-1]['close']
    threshold = _threshold(bars,WARMUP-1,cfg)
    for i in range(WARMUP,len(y)):
        close = bars[i]['close']
        if up:
            extremum = max(extremum,close)
            if close <= extremum*(1-threshold):
                up, extremum = False, close
                threshold = _threshold(bars,i,cfg)
        else:
            extremum = min(extremum,close)
            if close >= extremum*(1+threshold):
                up, extremum = True, close
                threshold = _threshold(bars,i,cfg)
        out[i] = ASSET if up else None
    return out


def targets(candidate,data):
    expected = {c['id']:c for c in candidates()}
    if candidate.get('id') not in expected or candidate != expected[candidate['id']]:
        raise ValueError('Only exactly frozen candidate specifications are supported')
    bars,y = _logs(data)
    runner = {'kalman_local_linear':_kalman, 'squared_exponential_gp':_gp,
              'mann_kendall_theil_sen':_rank, 'directional_change_event_clock':_directional}[candidate['family']]
    output = runner(bars,y,candidate)
    assert len(output) == len(bars) and all(x in (None,ASSET) for x in output)
    assert all(x is None for x in output[:WARMUP])
    return output
