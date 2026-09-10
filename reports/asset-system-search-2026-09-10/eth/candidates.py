#!/usr/bin/env python3
"""Four frozen ETH/cash research candidates; no network, orders or P&L scoring.

All observations are completed daily bars. Targets at i are eligible only for
the common evaluator's i+2/i+3 open. Established methods, not new mathematics.
"""
import copy
import math

SYMBOL = 'ETH/USD'
WARMUP = 90
LOG_COST = math.log((1.008 * 1.0003) / (.992 * .9997))

REGISTRY = [
    {
        'id': 'eth_kalman_drift_v1',
        'name': 'ETH continuous-state drift filter',
        'family': 'continuous_latent_linear_trend',
        'economicMechanism': 'Persistent directional demand may support a sufficiently large, slow ETH drift after costs.',
        'information': 'ETH completed closes; causal EWMA of past squared log returns.',
        'equations': [
            'y_t=log(C_t), z_t=(level_t,drift_t), F=[[1,1],[0,1]], H=[1,0].',
            'Before observation t: R=max(1e-8, prior EWMA squared return); Q=diag(.01R,.0001R).',
            'z_pred=Fz; P_pred=FPF^T+Q; K=P_pred*H^T/(H*P_pred*H^T+R); z=z_pred+K(y-H*z_pred); P=(I-KH)P_pred.',
            'After filtering t, EWMA=.94*EWMA+.06*(y_t-y_(t-1))^2.',
            'Enter if 14*drift - 14*sqrt(P_drift,drift)>base log round-trip cost; exit if drift<=0; otherwise retain target.'
        ],
        'parameters': {'horizonDays': 14, 'ewmaDecay': .94, 'initialDailyReturnVariance': .0016,
                       'levelProcessVarianceFraction': .01, 'driftProcessVarianceFraction': .0001,
                       'initialDriftVarianceDivisor': 90, 'uncertaintyPenaltySd': 1,
                       'logEntryHurdle': LOG_COST, 'warmupBars': WARMUP},
        'initialization': 'First log close, zero drift, P=diag(.0016,.0016/90), EWMA=.0016; filter from bar 1, suppress targets before index 90.',
        'nearestPriorFamily': 'ETH40 trend and the previous HMM/BOCPD inference prototypes.',
        'materialDifference': 'A continuous two-state posterior and covariance-dependent entry hurdle; no discrete latent-state bank or fixed lookback close mean.',
        'novelty': 'Established inference template applied to ETH; no original mathematics or distinct economic source claimed.',
        'nullAndFailure': 'Filtered drift need not persist. Gaussian assumptions, changes in volatility, and slow reversals can produce losses; the state-uncertainty penalty excludes future process risk.',
        'sources': ['https://hans.fugal.net/comps/papers/kalman_1960.pdf']
    },
    {
        'id': 'eth_crossasset_mature_ridge_v1',
        'name': 'ETH mature-label BTC context regression',
        'family': 'causal_crossasset_direct_horizon_regression',
        'economicMechanism': 'A lagged BTC/ETH return relationship could predict ETH continuation or catch-up over 14 days.',
        'information': 'ETH and BTC closes through t; only historical 14-day outcomes fully realized by t enter training.',
        'equations': [
            'x_t=[1, log(ETH_t/ETH_(t-14))/.10, log(BTC_t/BTC_(t-14))/.10, log(BTC_t/BTC_(t-1))/.03].',
            'At t>=28, mature label y=log(ETH_t/ETH_(t-14)) for regressor x_(t-14).',
            'g=P*x/(lambda+x^T*P*x); beta=beta+g*(y-x^T*beta); P=(P-g*x^T*P)/lambda, lambda=.99.',
            'v=.98*v+.02*preupdateResidual^2; mu=x_t^T*beta; meanPenalty=sqrt(v*x_t^T*P*x_t).',
            'After at least 60 matured labels and index 90, enter if mu-meanPenalty>base log round-trip cost; exit if mu<=0; otherwise retain.'
        ],
        'parameters': {'forecastHorizonDays': 14, 'returnFeatureScale': .10, 'oneDayBtcScale': .03,
                       'forgettingFactor': .99, 'residualVarianceDecay': .98,
                       'initialResidualVariance': .01, 'initialInverseInformationDiagonal': 1,
                       'minimumMaturedLabels': 60, 'uncertaintyPenaltySd': 1,
                       'logEntryHurdle': LOG_COST, 'warmupBars': WARMUP},
        'initialization': 'beta=0, inverse information=identity, residual variance=.01; first feature at 14, first mature update at 28.',
        'nearestPriorFamily': 'Relative-strength rotation and fixed-window momentum; generic regression prototypes elsewhere are not new mathematics.',
        'materialDifference': 'Causal fitted conditional ETH forecast with BTC context and explicit label maturation. It never rotates into BTC. Learning parameters respond to realized forecast errors.',
        'novelty': 'Established recursive least squares; new candidate application, not an original estimator or independent alpha source.',
        'nullAndFailure': 'Cross-asset predictability may be absent or unstable; overlapping outcomes violate independent-error interpretations, so the mean penalty is not a calibrated confidence bound.',
        'sources': ['https://arxiv.org/abs/2003.02737']
    },
    {
        'id': 'eth_volume_pressure_v1',
        'name': 'ETH close-location volume pressure',
        'family': 'volume_conditioned_directional_pressure',
        'economicMechanism': 'High-volume closes near the daily high may indicate persistent directional participation.',
        'information': 'ETH daily high, low, close and native venue volume.',
        'equations': [
            'CLV_t=(2*C_t-H_t-L_t)/(H_t-L_t), or 0 when H_t=L_t.',
            'pressure_t=sum_(j=t-27..t)(CLV_j*V_j)/sum_(j=t-27..t)(V_j).',
            'Enter when pressure>.15 and C_t>C_(t-1); exit when pressure<-.05; otherwise retain.'
        ],
        'parameters': {'lookbackDays': 28, 'entryPressure': .15, 'exitPressure': -.05, 'warmupBars': WARMUP},
        'initialization': 'Cash; no entry before index 90. A zero volume window has pressure zero.',
        'nearestPriorFamily': 'Indicator hysteresis, with volume and intrabar close location replacing the price-only statistic.',
        'materialDifference': 'Identical close histories can give different targets when high/low/volume histories differ.',
        'novelty': 'Chaikin-style established indicator. Under the prior strict structural protocol this is a feature variant, not a certified new mathematical system family.',
        'nullAndFailure': 'A close-location statistic is not actual signed order flow; a gap down may coexist with positive pressure. Native venue volume may not represent global ETH demand.',
        'sources': ['https://help.chaikinanalytics.com/chaikin-analytics-platform/analytics-chart-overview',
                    'https://library.tradingtechnologies.com/trade/analytics/charts/technical-indicators/chaikin-money-flow-cmf/']
    },
    {
        'id': 'eth_drawdown_recovery_v1',
        'name': 'ETH drawdown recovery state machine',
        'family': 'event_anchored_recovery',
        'economicMechanism': 'A large selloff followed by recovery could reflect temporary liquidity pressure followed by replenished demand.',
        'information': 'ETH closes, trailing 90-close peak, and remembered peak/trough for an armed event.',
        'equations': [
            'In IDLE at t>=90, arm if C_t<=.80*max(C_(t-89)..C_t); save that peak and trough=C_t.',
            'In ARMED, trough=min(trough,C_t). Enter if C_t>=1.08*trough and C_t<savedPeak.',
            'In LONG, exit if C_t>=savedPeak or C_t<=savedTrough or t-entryIndex>=42.',
            'After exit suppress arming through exitIndex+6; return to IDLE on exitIndex+7.'
        ],
        'parameters': {'peakLookbackDays': 90, 'armDrawdownFraction': .20,
                       'recoveryFraction': .08, 'maxSignalHoldingDays': 42, 'cooldownDays': 7,
                       'warmupBars': WARMUP},
        'initialization': 'IDLE, cash, with no prewarmup event state. One transition branch per completed bar.',
        'nearestPriorFamily': 'Trend-conditioned reversion and channel breakout; common drawdown recovery and trailing-stop ideas.',
        'materialDifference': 'Event-specific peak/trough remain after their original observations leave a fixed lookback. Entry requires an ordered drawdown then recovery sequence.',
        'novelty': 'A fixed heuristic state policy within the known recovery/reversion parent. New implementation and trial; independent structural novelty unresolved.',
        'nullAndFailure': 'A rebound may be a pause in a longer decline. Remembered barriers are close-signal conditions followed by delayed execution, not guaranteed stop prices.',
        'sources': [],
        'provenanceNote': 'Research-team heuristic; no literature-originality claim or cited profitability theorem.'
    }
]


def candidates():
    return copy.deepcopy(REGISTRY)


def _validate(data):
    if set(data) != {'ETH/USD', 'BTC/USD'}:
        raise ValueError('Require aligned ETH/USD and BTC/USD data')
    eth, btc = data['ETH/USD'], data['BTC/USD']
    if len(eth) != len(btc) or any(a['openMs'] != b['openMs'] for a, b in zip(eth, btc)):
        raise ValueError('Mismatched asset history')
    for bars in (eth, btc):
        for b in bars:
            if any(not math.isfinite(b[k]) or b[k] <= 0 for k in ('open', 'high', 'low', 'close')):
                raise ValueError('Invalid OHLC')
            if not math.isfinite(b['volume']) or b['volume'] < 0:
                raise ValueError('Invalid volume')
            if not b['low'] <= min(b['open'], b['close']) <= max(b['open'], b['close']) <= b['high']:
                raise ValueError('Inconsistent OHLC')


def _kalman(data):
    output, held = [], None
    bars = data[SYMBOL]
    if not bars:
        return output
    level, drift, variance = math.log(bars[0]['close']), 0., .0016
    p00, p01, p11 = variance, 0., variance / 90
    previous = level
    for i, bar in enumerate(bars):
        observation = math.log(bar['close'])
        if i:
            r = max(1e-8, variance)
            level += drift
            a = p00 + 2 * p01 + p11 + .01 * r
            b = p01 + p11
            c = p11 + .0001 * r
            denominator = a + r
            k0, k1 = a / denominator, b / denominator
            innovation = observation - level
            level += k0 * innovation
            drift += k1 * innovation
            p00 = a - a * a / denominator
            p01 = b - a * b / denominator
            p11 = max(0., c - b * b / denominator)
            variance = .94 * variance + .06 * (observation - previous) ** 2
        previous = observation
        if i >= WARMUP:
            if 14 * (drift - math.sqrt(p11)) > LOG_COST:
                held = SYMBOL
            elif drift <= 0:
                held = None
        output.append(held)
    return output


def _ridge_features(closes, i):
    if i < 14:
        return None
    eth, btc = closes[SYMBOL], closes['BTC/USD']
    return [1., math.log(eth[i] / eth[i - 14]) / .10,
            math.log(btc[i] / btc[i - 14]) / .10,
            math.log(btc[i] / btc[i - 1]) / .03]


def _ridge(data):
    closes = {symbol: [b['close'] for b in bars] for symbol, bars in data.items()}
    p = [[float(j == k) for k in range(4)] for j in range(4)]
    beta, variance, seen = [0.] * 4, .01, 0
    features, output, held = [], [], None
    for i, bar in enumerate(data[SYMBOL]):
        x_now = _ridge_features(closes, i)
        features.append(x_now)
        if i >= 28:
            x = features[i - 14]
            y = math.log(closes[SYMBOL][i] / closes[SYMBOL][i - 14])
            px = [sum(p[j][k] * x[k] for k in range(4)) for j in range(4)]
            denominator = .99 + sum(x[j] * px[j] for j in range(4))
            gain = [item / denominator for item in px]
            residual = y - sum(x[j] * beta[j] for j in range(4))
            beta = [beta[j] + gain[j] * residual for j in range(4)]
            p = [[(p[j][k] - gain[j] * px[k]) / .99 for k in range(4)] for j in range(4)]
            variance = .98 * variance + .02 * residual * residual
            seen += 1
        if i >= WARMUP and seen >= 60:
            mu = sum(x_now[j] * beta[j] for j in range(4))
            leverage = sum(x_now[j] * p[j][k] * x_now[k] for j in range(4) for k in range(4))
            penalty = math.sqrt(max(0., variance * leverage))
            if mu - penalty > LOG_COST:
                held = SYMBOL
            elif mu <= 0:
                held = None
        output.append(held)
    return output


def _volume(data):
    bars, output, held = data[SYMBOL], [], None
    weighted, volumes = [], []
    for i, bar in enumerate(bars):
        span = bar['high'] - bar['low']
        clv = (2 * bar['close'] - bar['high'] - bar['low']) / span if span > 0 else 0.
        weighted.append(clv * bar['volume'])
        volumes.append(bar['volume'])
        if i >= WARMUP:
            volume = sum(volumes[i - 27:i + 1])
            pressure = sum(weighted[i - 27:i + 1]) / volume if volume else 0.
            if pressure > .15 and bar['close'] > bars[i - 1]['close']:
                held = SYMBOL
            elif pressure < -.05:
                held = None
        output.append(held)
    return output


def _recovery(data):
    closes = [b['close'] for b in data[SYMBOL]]
    output, state, held = [], 'IDLE', None
    peak, trough, entered, next_arm = None, None, None, 0
    for i, current in enumerate(closes):
        if i < WARMUP:
            output.append(None)
            continue
        if state == 'LONG':
            if current >= peak or current <= trough or i - entered >= 42:
                state, held, next_arm = 'IDLE', None, i + 7
        elif state == 'ARMED':
            trough = min(trough, current)
            if current >= 1.08 * trough and current < peak:
                state, held, entered = 'LONG', SYMBOL, i
        elif i >= next_arm:
            trailing_peak = max(closes[i - 89:i + 1])
            if current <= .80 * trailing_peak:
                state, peak, trough = 'ARMED', trailing_peak, current
        output.append(held)
    return output


GENERATORS = {'eth_kalman_drift_v1': _kalman, 'eth_crossasset_mature_ridge_v1': _ridge,
              'eth_volume_pressure_v1': _volume, 'eth_drawdown_recovery_v1': _recovery}


def targets(candidate, data):
    """Causal target, never a same-bar fill; input candidate parameters are frozen."""
    _validate(data)
    spec = next((c for c in REGISTRY if c['id'] == candidate['id']), None)
    if spec is None or candidate.get('parameters', spec['parameters']) != spec['parameters']:
        raise ValueError('Unknown candidate or altered frozen parameters')
    return GENERATORS[candidate['id']](data)
