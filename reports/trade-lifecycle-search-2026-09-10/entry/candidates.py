"""Frozen entry gates only: no position targets, fills, exits or profit scoring."""
import copy
import math

WARMUP = 90
ROUND_TRIP_GROSS = (1.008 * 1.0003) / (.992 * .9997) - 1
ROUND_TRIP_LOG = math.log1p(ROUND_TRIP_GROSS)

SPECS = {
    'BTC/USD': [
        {'id': 'btc_entry_baseline', 'name': 'BTC unchanged normalized weekly eligibility',
         'equation': 'eligible_i = (i>=90) AND baseline_i', 'parameters': {'warmupBars': 90},
         'economicHypothesis': 'Control: preserve every supplied weekly long-state entry opportunity.',
         'lineage': 'Current 40-native-week BTC trend; this function does not reconstruct or change its baseline.'},
        {'id': 'btc_entry_path_efficiency', 'name': 'BTC directional path-quality gate',
         'equation': 'eligible_i = baseline_i AND i>=90 AND (C_i-C_(i-28))/sum_(j=i-27..i)|C_j-C_(j-1)|>=.35 AND C_i/C_(i-28)-1>baseRoundTripGross',
         'parameters': {'warmupBars': 90, 'returnDays': 28, 'minimumSignedEfficiency': .35, 'minimumGrossMove': ROUND_TRIP_GROSS},
         'economicHypothesis': 'Within the slow bullish regime, avoid entries whose recent price displacement is small relative to its traveled path and costs.',
         'lineage': 'Signed Kaufman-style efficiency ratio; established indicator gate, not new mathematics.',
         'failure': 'Strong trends can begin after noisy paths; historical displacement is not a forecast of remaining return.',
         'sources': ['https://ta-lib.org/functions/er.html']},
        {'id': 'btc_entry_pullback_recovery', 'name': 'BTC pullback recovery crossing gate',
         'equation': 'E_i=(2/11)C_i+(9/11)E_(i-1), E_0=C_0; eligible_i=baseline_i AND i>=90 AND C_(i-1)<=E_(i-1) AND C_i>E_i AND max(C_(i-19)..C_i)/C_i-1>=.02',
         'parameters': {'warmupBars': 90, 'emaSpan': 10, 'peakLookbackDays': 20, 'minimumDistanceBelowPeak': .02},
         'economicHypothesis': 'Enter only after a local pullback starts recovering while the slower weekly regime remains eligible.',
         'lineage': 'Established trend-conditioned pullback and crossing event; one fixed application.',
         'failure': 'May miss uninterrupted rallies; the rebound can fail and later fill prices can erase apparent entry improvement.'}
    ],
    'ETH/USD': [
        {'id': 'eth_entry_baseline', 'name': 'ETH unchanged ETH40 eligibility',
         'equation': 'eligible_i = (i>=90) AND baseline_i', 'parameters': {'warmupBars': 90},
         'economicHypothesis': 'Control: preserve every supplied ETH40 long-state entry opportunity.',
         'lineage': 'Current frozen daily ETH40 hysteresis; no redefinition of its original target.'},
        {'id': 'eth_entry_volatility_confirmation', 'name': 'ETH cost and volatility confirmation gate',
         'equation': 'r_j=log(C_j/C_(j-1)); sigma_i=sqrt(sum_(j=i-19..i)r_j^2/20); TR_j=max(H_j-L_j,|H_j-C_(j-1)|,|L_j-C_(j-1)|); eligible_i=baseline_i AND baseline_(i-1) AND i>=90 AND log(C_i/C_(i-5))>max(baseRoundTripLog,sqrt(5)*sigma_i) AND TR_i<=2*mean(TR_(i-20)..TR_(i-1))',
         'parameters': {'warmupBars': 90, 'returnDays': 5, 'volatilityDays': 20, 'volatilityMultiplier': 1., 'maximumTrueRangeRatio': 2., 'baselineConfirmationBars': 2, 'minimumLogMove': ROUND_TRIP_LOG},
         'economicHypothesis': 'Require short-term confirmation scaled by the asset\'s recently observed fluctuations, while excluding isolated large range shocks.',
         'lineage': 'Established volatility-normalized momentum and shock filtering; fixed composite entry gate.',
         'failure': 'The scale is RMS return, not a calibrated standard error or confidence test; it can reject the beginning of a successful large breakout.'},
        {'id': 'eth_entry_volume_pressure', 'name': 'ETH volume-pressure confirmation gate',
         'equation': 'CLV_j=(2*C_j-H_j-L_j)/(H_j-L_j), zero when H_j=L_j; pressure_i=sum_(j=i-27..i)(CLV_j*V_j)/sum_(j=i-27..i)V_j; eligible_i=baseline_i AND i>=90 AND pressure_i>.15 AND C_i>C_(i-1)',
         'parameters': {'warmupBars': 90, 'pressureDays': 28, 'minimumPressure': .15},
         'economicHypothesis': 'Require native-venue volume-weighted close location to support the ETH40 bullish target.',
         'lineage': 'Reuses the earlier eth_volume_pressure_v1 entry statistic unchanged, now solely as an ETH40 entry gate; not a new primitive method.',
         'failure': 'A volume-weighted close location is not signed order flow; one venue may not reflect the global market.',
         'sources': ['https://help.chaikinanalytics.com/chaikin-analytics-platform/analytics-chart-overview', 'https://library.tradingtechnologies.com/trade/analytics/charts/technical-indicators/chaikin-money-flow-cmf/']}
    ]
}


def specs():
    return copy.deepcopy(SPECS)


def _validate(symbol, bars, baseline_targets):
    if symbol not in SPECS or len(bars) != len(baseline_targets):
        raise ValueError('Unknown symbol or mismatched baseline length')
    if any(type(x) is not bool for x in baseline_targets):
        raise ValueError('Baseline must contain only booleans')
    for i, bar in enumerate(bars):
        if any(not math.isfinite(bar[k]) or bar[k] <= 0 for k in ('open', 'high', 'low', 'close')):
            raise ValueError('Invalid OHLC')
        if not math.isfinite(bar['volume']) or bar['volume'] < 0:
            raise ValueError('Invalid volume')
        if not bar['low'] <= min(bar['open'], bar['close']) <= max(bar['open'], bar['close']) <= bar['high']:
            raise ValueError('Inconsistent OHLC')
        if 'openMs' in bar and i and bars[i-1].get('openMs') is not None and bar['openMs'] - bars[i-1]['openMs'] != 86400000:
            raise ValueError('Require contiguous daily observations')


def build_entries(symbol, bars, baseline_targets):
    """Entry permission if flat; a false gate NEVER means sell or stop holding.

    Coordinator supplies the causal frozen baseline aligned at signal-bar time.
    Coordinator applies finalization/execution delay once, after this function.
    """
    _validate(symbol, bars, baseline_targets)
    eligible = [bool(i >= WARMUP and base) for i, base in enumerate(baseline_targets)]
    ids = [s['id'] for s in SPECS[symbol]]
    result = {ids[0]: eligible, ids[1]: [False] * len(bars), ids[2]: [False] * len(bars)}
    closes = [b['close'] for b in bars]
    if not bars:
        return result
    if symbol == 'BTC/USD':
        ema = [closes[0]]
        for price in closes[1:]:
            ema.append((2 / 11) * price + (9 / 11) * ema[-1])
        for i in range(WARMUP, len(bars)):
            if not eligible[i]:
                continue
            path = sum(abs(closes[j] - closes[j-1]) for j in range(i-27, i+1))
            efficiency = (closes[i] - closes[i-28]) / path if path else 0.
            result[ids[1]][i] = efficiency >= .35 and closes[i] / closes[i-28] - 1 > ROUND_TRIP_GROSS
            result[ids[2]][i] = closes[i-1] <= ema[i-1] and closes[i] > ema[i] and max(closes[i-19:i+1]) / closes[i] - 1 >= .02
    else:
        returns, ranges, weighted, volumes = [0.], [bars[0]['high'] - bars[0]['low']], [], []
        for i, b in enumerate(bars):
            if i:
                returns.append(math.log(closes[i] / closes[i-1]))
                ranges.append(max(b['high'] - b['low'], abs(b['high'] - closes[i-1]), abs(b['low'] - closes[i-1])))
            span = b['high'] - b['low']
            clv = (2*b['close'] - b['high'] - b['low']) / span if span > 0 else 0.
            weighted.append(clv * b['volume'])
            volumes.append(b['volume'])
            if i < WARMUP or not eligible[i]:
                continue
            sigma = math.sqrt(sum(x*x for x in returns[i-19:i+1]) / 20)
            prior_atr = sum(ranges[i-20:i]) / 20
            result[ids[1]][i] = baseline_targets[i-1] and math.log(closes[i] / closes[i-5]) > max(ROUND_TRIP_LOG, math.sqrt(5)*sigma) and ranges[i] <= 2*prior_atr
            volume = sum(volumes[i-27:i+1])
            pressure = sum(weighted[i-27:i+1]) / volume if volume else 0.
            result[ids[2]][i] = pressure > .15 and closes[i] > closes[i-1]
    return result
