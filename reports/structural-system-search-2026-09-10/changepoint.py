"""One fixed BOCPD-inspired research rule, not an original mathematical invention.

Adams/MacKay run-length filtering with conjugate normal-inverse-gamma
observations. Future trading performance is unknown. No order routing.
"""
import math
import statistics

SPEC = dict(
    id='eth-bocpd-runlength-v1', mathematicalFamily='Bayesian online run-length inference',
    source='https://arxiv.org/abs/0710.3742', originalMathematics=False,
    symbol='ETH/USD', warmupReturns=90, hazard=1/60, priorMean=0.,
    priorKappa=1., priorAlpha=3., priorBetaRule='(alpha-1)*initial90ReturnSampleVariance; variance floor 1e-8',
    decisionHorizonDays=20, minimumExpectedRunDays=10, meanUncertaintyPenalty=1.,
    entry='expected20DayLogReturn - oneLatentMeanSD > logBaseRoundTripCost; expectedRunDays >= 10',
    exit='expected20DayLogReturn <= 0', otherwise='retain incumbent target',
    horizonMeaning='Signal heuristic, not a fixed holding deadline or calibrated executable net-return forecast',
    bandMeaning='Base round-trip cost remains fixed in all execution stresses',
    inference='Full run-length bank, no truncation; forward filtering only; no future smoothing',
    risk='Unlevered funded long/cash; common replay entry ceiling applies; no enforced stop or drawdown halt',
    status='FROZEN_RESEARCH_PROTOTYPE_NOT_VALIDATED')


def update(stats, x):
    mean, kappa, alpha, beta = stats
    return ((kappa*mean+x)/(kappa+1), kappa+1, alpha+.5,
            beta + kappa*(x-mean)**2/(2*(kappa+1)))


def predictive_log_density(stats, x):
    mean, kappa, alpha, beta = stats
    df = 2*alpha
    scale2 = beta*(kappa+1)/(alpha*kappa)
    return (math.lgamma((df+1)/2)-math.lgamma(df/2)
            -.5*math.log(df*math.pi*scale2)
            -(df+1)/2*math.log1p((x-mean)**2/(df*scale2)))


class RunLengthFilter:
    def __init__(self, variance):
        if not math.isfinite(variance) or variance <= 0:
            raise ValueError('Positive finite prior variance required')
        self.prior = (SPEC['priorMean'], SPEC['priorKappa'], SPEC['priorAlpha'],
                      (SPEC['priorAlpha']-1)*variance)
        self.stats = [self.prior]
        self.log_weights = [0.]

    def step(self, x):
        if not math.isfinite(x):
            raise ValueError('Finite observation required')
        log_evidence = [w+predictive_log_density(st, x) for w,st in zip(self.log_weights,self.stats)]
        peak = max(log_evidence)
        normalizer = peak + math.log(sum(math.exp(y-peak) for y in log_evidence))
        h = SPEC['hazard']
        # With constant hazard the reset posterior is h, not a data-dependent
        # spike. Evidence for a recent change is the mass at SHORT run lengths.
        self.log_weights = [math.log(h)] + [math.log1p(-h)+y-normalizer for y in log_evidence]
        self.stats = [self.prior] + [update(st,x) for st in self.stats]
        weights = [math.exp(w) for w in self.log_weights]
        mean = sum(w*st[0] for w,st in zip(weights,self.stats))
        variance_mean = max(0.,sum(w*(st[3]/(st[1]*(st[2]-1))+st[0]**2)
                                  for w,st in zip(weights,self.stats))-mean**2)
        factor = sum((1-h)**k for k in range(SPEC['decisionHorizonDays']))
        return dict(meanDailyLogReturn=mean, expectedRunDays=sum(i*w for i,w in enumerate(weights)),
                    recentChangeMass=sum(weights[:6]), next20DayMean=factor*mean,
                    latentMeanUncertainty=factor*math.sqrt(variance_mean), posteriorMass=sum(weights))


def generate(data, diagnostics=False):
    closes = [b['close'] for b in data['ETH/USD']]
    if any(not math.isfinite(c) or c<=0 for c in closes):
        raise ValueError('Positive finite prices required')
    n = len(closes)
    targets, trace = [None]*n, []
    if n<=91:
        return (targets,trace) if diagnostics else targets
    warmup = [math.log(closes[i]/closes[i-1]) for i in range(1,91)]
    model = RunLengthFilter(max(1e-8,statistics.variance(warmup)))
    cost = math.log((1+.008)*(1+.0003)/((1-.008)*(1-.0003)))
    held = None
    for i in range(91,n):
        d = model.step(math.log(closes[i]/closes[i-1]))
        if d['expectedRunDays']>=SPEC['minimumExpectedRunDays'] and d['next20DayMean']-d['latentMeanUncertainty']>cost:
            held = 'ETH/USD'
        elif d['next20DayMean']<=0:
            held = None
        targets[i]=held
        if diagnostics:
            trace.append(dict(barIndex=i, **d, target=held))
    return (targets,trace) if diagnostics else targets


def self_test():
    model = RunLengthFilter(1e-6)
    previous = 0.
    for i in range(50):
        d=model.step(.003+(i%3-1)*.0001)
        assert abs(d['posteriorMass']-1)<1e-10
        assert abs(math.exp(model.log_weights[0])-SPEC['hazard'])<1e-12
        previous=d['recentChangeMass']
    assert d['meanDailyLogReturn']>0 and d['expectedRunDays']>20
    shock=model.step(-.05)
    assert shock['recentChangeMass']>previous
    for _ in range(20):
        d=model.step(-.003)
    assert d['meanDailyLogReturn']<0
    # Sequential conjugate updates equal a sufficient-statistics update.
    values=[.01,-.03,.02,.04]
    prior=(0.,1.,3.,.002)
    st=prior
    for x in values:
        st=update(st,x)
    avg=statistics.fmean(values)
    beta=.002+.5*sum((x-avg)**2 for x in values)+len(values)*avg**2/(2*(1+len(values)))
    assert abs(st[0]-sum(values)/5)<1e-12 and abs(st[3]-beta)<1e-12
    print('BOCPD normalization, constant-hazard reset, shift response and conjugate sufficient statistics passed')


if __name__=='__main__':
    self_test()
