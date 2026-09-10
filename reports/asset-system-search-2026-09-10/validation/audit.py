"""Independent read-only audit of the registered asset comparison artifacts.

The accounting checks use emitted orders, original bars and exchange rules,
not common.evaluate. Only the BTC control parity and synthetic counterexamples
invoke registered code. No strategy constants or runtime files are changed.
"""
import datetime as dt
import gzip
import hashlib
import importlib.util
import json
import math
import random
import sys
from collections import Counter
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REPO = ROOT.parents[1]
OUT = ROOT / 'results-v1'
PRIOR = REPO / 'reports/parallel-strategy-study-2026-09-10'
DAY = 86_400_000
COUNTS = Counter()
MAX_RESIDUAL = 0.


def read(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check(condition, label):
    assert condition, label
    COUNTS[label] += 1


def equal(actual, expected, label, tolerance=1e-7):
    global MAX_RESIDUAL
    difference = abs(actual - expected)
    MAX_RESIDUAL = max(MAX_RESIDUAL, difference)
    check(difference <= tolerance, (label, actual, expected) if difference > tolerance else label)


def timestamp(day):
    return int(dt.datetime.fromisoformat(day).replace(tzinfo=dt.timezone.utc).timestamp() * 1000)


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main():
    protocol = read(ROOT / 'protocol.json')
    registration = read(OUT / 'registration.json')
    lock = read(OUT / 'selection-lock.json')
    summary = read(OUT / 'summary.json')
    targets = read(OUT / 'targets.json')
    data = read(PRIOR / 'data/dataset.json')
    rules = read(PRIOR / 'data/rules.json')
    ledgers = json.loads(gzip.decompress((OUT / 'full-ledgers.json.gz').read_bytes()))
    index = {b['openMs']: i for i, b in enumerate(data['BTC/USD'])}
    original_hashes = {str(p.relative_to(REPO)): digest(p) for p in OUT.iterdir() if p.is_file()}
    for name, wanted in lock['hashes'].items():
        check(digest(REPO / name) == wanted, 'locked source and data hash')
    check(lock['hashes'] == registration['hashes'], 'registration and selection source hashes match')
    for name, wanted in read(OUT / 'integrity.json').items():
        check(digest(OUT / name) == wanted, 'result artifact integrity hash')
    check(registration['registeredAt'] < lock['lockedAt'], 'source registration precedes selection')
    check(lock['laterPeriodsEvaluatedByThisRun'] is False, 'selection records no later-period scoring')
    check(summary['selectedNewCandidate'] == lock['selectedNewCandidate'], 'later results do not reselect')
    check(lock['historicalDataPreviouslyReused'] is True, 'history reuse explicitly disclosed')
    for name, old in read(OUT / 'development-targets.json').items():
        check(targets[name][:len(old)] == old, 'full-run development targets unchanged')

    for system, periods in ledgers.items():
        for period, scenarios in periods.items():
            for scenario, run in scenarios.items():
                settings = protocol['scenarios'][scenario]
                check(run['scenario'] == settings, 'all four fee and delay scenarios match registration')
                fee, slip, lag = settings['feeBps'] / 10000, settings['slippageBps'] / 10000, settings['signalToOpenBars']
                check(lag in (2, 3), 'no same-close or unfinalized daily fill')
                start, end = map(timestamp, protocol['periods'][period])
                first = index[start]
                cash, quantity, held, basis = 10000., 0., None, 0.
                total_fees, turnover, price_cost = 0., 0., 0.
                peak, max_dd, low_dd, exposed, prior_equity = 10000., 0., 0., 0, 10000.
                order_cursor, completed, natural, terminal = 0, [], 0, 0
                for row in run['daily']:
                    moment = timestamp(row['date'])
                    i = index[moment]
                    check(start <= moment < end, 'daily records stay within declared window')
                    desired = targets[system][i-lag] if i-lag >= first else None
                    current_orders = []
                    while order_cursor < len(run['orders']):
                        order = run['orders'][order_cursor]
                        due = order['timestampMs'] == moment if order.get('reason') != 'terminal' else order['timestampMs'] == moment + DAY and moment + DAY == end
                        if not due:
                            break
                        current_orders.append(order)
                        order_cursor += 1
                    # Terminal mark is executed after that day's low/close observations.
                    day_orders = [o for o in current_orders if o.get('reason') != 'terminal']
                    terminal_orders = [o for o in current_orders if o.get('reason') == 'terminal']
                    for order in day_orders + terminal_orders:
                        is_terminal = order.get('reason') == 'terminal'
                        if is_terminal:
                            check(moment + DAY == end and order['side'] == 'SELL', 'terminal sale only at final boundary')
                            if held:
                                low_reference = data[held][i]['low']
                                low_sale = math.floor((low_reference * (1-slip)) / rules[held]['tick']) * rules[held]['tick']
                                low_dd = max(low_dd, peak - (cash + quantity * low_sale * (1-fee)))
                                exposed += 1
                        symbol = order['symbol']
                        rule, bar = rules[symbol], data[symbol][i]
                        reference = bar['close'] if is_terminal else bar['open']
                        side = order['side']
                        price, q = order['price'], order['quantity']
                        check(price > 0 and q > 0, 'orders have positive finite price and size')
                        equal(price / rule['tick'], round(price / rule['tick']), 'tick alignment', 1e-6)
                        equal(q / rule['lot'], round(q / rule['lot']), 'lot alignment', 1e-6)
                        gross = q * price
                        equal(order['feeUsd'], gross * fee, 'per-order fee equation')
                        if side == 'BUY':
                            check(held is None and desired == symbol, 'buy only when selected target enters from cash')
                            signal_time = order['signalBarOpenMs']
                            check(signal_time == data[symbol][i-lag]['openMs'], 'recorded signal matches exact lag')
                            check(signal_time + DAY + 60_000 <= moment, 'signal candle finalized before entry')
                            check(price + 1e-10 >= reference * (1+slip), 'buy price adverse to slippage reference')
                            check(price - reference * (1+slip) <= rule['tick'] + 1e-8, 'buy rounding at most one adverse tick')
                            volume_bar = data[symbol][i-2]
                            check(volume_bar['openMs'] + DAY + 60_000 <= moment, 'volume sizing input finalized before entry')
                            cap = min(1000., cash * .1, cash, volume_bar['volume'] * volume_bar['close'] * .001)
                            spend = gross + order['feeUsd']
                            check(spend <= cap + 1e-7, 'fee-inclusive cash and participation entry cap')
                            check(q >= rule['minQty'] and gross >= rule['minCost'], 'minimum quantity and notional')
                            check(cap - spend < rule['lot'] * price * (1+fee) + 1e-7, 'size rounds down without unexplained unused budget')
                            cash -= spend
                            basis, quantity, held, entry_order = spend, q, symbol, order
                            price_cost += q * (price-reference)
                        else:
                            check(side == 'SELL' and held == symbol, 'sell only existing funded asset')
                            equal(q, quantity, 'sell quantity exactly clears inventory')
                            if not is_terminal:
                                check(desired != held, 'natural exit follows delayed target change')
                                natural += 1
                            else:
                                terminal += 1
                            check(price <= reference * (1-slip) + 1e-10, 'sell price adverse to slippage reference')
                            check(reference * (1-slip) - price <= rule['tick'] + 1e-8, 'sell rounding at most one adverse tick')
                            proceeds = gross - order['feeUsd']
                            cash += proceeds
                            completed.append((entry_order, order, proceeds-basis))
                            quantity, held, basis = 0., None, 0.
                            price_cost += q * (reference-price)
                        total_fees += order['feeUsd']
                        turnover += gross
                        check(cash >= -1e-7, 'cash never borrowed')
                    if held:
                        exposed += 1
                        bar, tick = data[held][i], rules[held]['tick']
                        close_sale = math.floor(bar['close'] * (1-slip) / tick) * tick
                        low_sale = math.floor(bar['low'] * (1-slip) / tick) * tick
                        equity = cash + quantity * close_sale * (1-fee)
                        low_dd = max(low_dd, peak - (cash + quantity * low_sale * (1-fee)))
                    else:
                        equity = cash
                    equal(row['equityUsd'], equity, 'daily equity independently marked from ledger')
                    equal(row['pnlUsd'], equity-prior_equity, 'daily P&L differences reconcile')
                    check(row['held'] == held, 'daily holding matches inventory')
                    peak = max(peak, equity)
                    max_dd = max(max_dd, peak-equity)
                    prior_equity = equity
                check(order_cursor == len(run['orders']), 'every emitted order consumed once')
                check(quantity == 0 and held is None, 'terminal accounts have no hidden position')
                equal(run['netPnlUsd'], cash-10000., 'cash movements reconcile total net')
                equal(run['netPnlUsd'], sum(row['pnlUsd'] for row in run['daily']), 'daily P&L sum reconciles total net')
                equal(run['feesUsd'], total_fees, 'aggregate charged fees reconcile')
                equal(run['turnoverUsd'], turnover, 'turnover reconciles')
                equal(run['adversePriceCostUsd'], price_cost, 'adverse reference-price cost reconciles')
                equal(run['maxDrawdownUsd'], max_dd, 'close liquidation drawdown reconciles')
                equal(run['maxIntradayLowDrawdownUsd'], low_dd, 'prior-close-peak to daily-low drawdown reconciles')
                equal(run['selectionUtility'], cash-10000.-.5*max_dd, 'development objective independently reconciles')
                check(run['exposedDays'] == exposed, 'exposure days reconcile')
                check(len(completed) == len(run['trades']) == run['closedTrades'] == run['entries'], 'entry and completed round-trip counts reconcile')
                sm = summary['performance'][system][period][scenario]
                check(sm['naturalCompletedEpisodes'] == natural and sm['terminalLiquidations'] == terminal, 'forced terminals excluded from natural episodes')
                for (buy, sell, net), trade in zip(completed, run['trades']):
                    equal(trade['netPnlUsd'], net, 'episode P&L includes entry and exit fees')
                    equal(trade['feesUsd'], buy['feeUsd'] + sell['feeUsd'], 'episode fee sum')
                    check(trade['entryMs'] == buy['timestampMs'] and trade['exitMs'] == sell['timestampMs'], 'episode chronology matches orders')
                COUNTS['complete independent ledger runs'] += 1

    development = read(OUT / 'development.json')
    utility = {key: min(run['selectionUtility'] for run in scenarios.values()) for key, scenarios in development.items()}
    for key, value in utility.items():
        equal(value, lock['worstScenarioDevelopmentUtility'][key], 'selection uses development scenario minimum')
        check(development[key] == summary['performance'][key]['development'], 'later evaluation preserves development summaries')
    for asset, registry in registration['registry'].items():
        candidates = [spec['id'] for spec in registry]
        winner = sorted(candidates, key=lambda key: (-utility[key], key))[0]
        check(winner == lock['selectedNewCandidate'][asset], 'asset winner selected from development only')
        for spec in registry:
            check(all(x is None for x in targets[spec['id']][:90]), 'ninety-bar candidate warmup')
            check(set(targets[spec['id']]) <= {None, asset.upper()+'/USD'}, 'asset candidates cannot switch to other asset')

    # Independently reproduce the native BTC source's reconstructSpotTrend calls.
    weeks = read(REPO / 'reports/new-spot-system-2026-09-10/market-data/dataset.json')['bars']
    btc_source = (REPO / 'src/spot-trend/paper.ts').read_text()
    check('Math.floor(nowMs / WEEK_MS) * WEEK_MS' in btc_source and 'reconstructSpotTrend(snapshot.bars, weekOpenMs)' in btc_source, 'BTC control cutoff agrees with paper caller source')
    excluded_latest_finalization = 0
    for i, bar in enumerate(data['BTC/USD']):
        decision_time = bar['openMs'] + DAY + 60_000
        cutoff = (decision_time // (7*DAY)) * 7*DAY
        available = [w for w in weeks if w['availableAtMs'] <= cutoff]
        held = None
        for j in range(39, len(available)):
            window = available[j-39:j+1]
            sma = sum(w['close'] for w in window)/40
            if window[-1]['close'] <= sma:
                held = None
            elif window[-1]['close'] > sma * (1+.0166):
                held = 'BTC/USD'
        check(targets['btc_weekly_signal_control'][i] == held, 'native BTC hysteresis and weekly availability parity')
        if any(w['endMs'] == cutoff and w['availableAtMs'] > cutoff for w in weeks):
            excluded_latest_finalization += 1

    # Recompute paired bootstrap by drawing day indices, not precomputed block sums.
    for asset, candidate in lock['selectedNewCandidate'].items():
        later_rows = lambda key: [row for period in ('later_2025', 'recent_2026') for row in ledgers[key][period]['combined']['daily']]
        left = later_rows(candidate)
        for control, recorded in summary['confidence'][asset].items():
            right = later_rows(control)
            check([r['date'] for r in left] == [r['date'] for r in right], 'bootstrap paired on identical dates')
            differences = [a['pnlUsd']-b['pnlUsd'] for a, b in zip(left, right)]
            n, rng, simulated = len(differences), random.Random(20260910), []
            whole, remainder = divmod(n, 14)
            for _ in range(5000):
                starts = [rng.randrange(n) for _ in range(whole+1)]
                values = [differences[(start+j) % n] for start in starts[:-1] for j in range(14)]
                values += [differences[(starts[-1]+j) % n] for j in range(remainder)]
                simulated.append(sum(values))
            simulated.sort()
            equal(recorded['excessNetUsd'], sum(differences), 'paired excess sum reproducible')
            equal(recorded['nominalLowerNetUsd'], simulated[250], 'nominal paired block quantile reproducible')
            equal(recorded['eightTrialAdjustedLowerNetUsd'], simulated[31], 'eight-trial adjusted block quantile reproducible')
            check('Descriptive only' in recorded['interpretation'], 'bootstrap carries reuse and dependence limitation')

    # Actual candidate prefix causality for both frozen winners, including all dates.
    for asset, winner in lock['selectedNewCandidate'].items():
        mod = load(ROOT / asset / 'candidates.py', 'independent_'+asset)
        spec = next(s for s in registration['registry'][asset] if s['id'] == winner)
        for length in (89, 90, 91, 180, 284, 365, 500, 600, len(data['BTC/USD'])-1):
            shorter = {s: bars[:length] for s, bars in data.items()}
            check(mod.targets(spec, shorter) == targets[winner][:length], 'selected candidate causal prefix reproduces')

    # Counterexample: unfinalized yesterday-volume cannot fund today's entry.
    common = load(PRIOR / 'common.py', 'independent_common_synthetic')
    stamp = timestamp('2025-01-01')
    bars = [dict(openMs=stamp+i*DAY, open=1000., high=1000., low=1000., close=1000., volume=1e6) for i in range(8)]
    for scenario, settings in protocol['scenarios'].items():
        fixture = {s: [dict(b) for b in bars] for s in data}
        target = ['ETH/USD'] * 8
        lag = settings['signalToOpenBars']
        fixture['ETH/USD'][lag-2]['volume'] = 0
        r = common.evaluate(target, fixture, '2025-01-01', '2025-01-09', settings, details=True)
        check(r['rejections'][0]['timestampMs'] == stamp+lag*DAY, 'zero finalized volume rejects first entry in every scenario')
        check(r['orders'][0]['timestampMs'] > stamp+lag*DAY, 'rejected fill cannot be backdated')
        check(r['netPnlUsd'] < 0, 'flat-price funded round trip loses its costs in every scenario')
        fixture = {s: [dict(b) for b in bars] for s in data}
        fixture['ETH/USD'][lag-1]['volume'] = 0
        r = common.evaluate(target, fixture, '2025-01-01', '2025-01-09', settings, details=True)
        check(r['orders'][0]['timestampMs'] == stamp+lag*DAY, 'unfinalized previous-day volume cannot reject current entry')

    for asset, candidate in lock['selectedNewCandidate'].items():
        performance = summary['performance'][candidate]
        later = ('later_2025', 'recent_2026')
        scenarios = protocol['scenarios']
        independently_checked = {
            'positiveAllDevelopmentAndLaterScenarioNets': all(performance[p][s]['netPnlUsd'] > 0 for p in ('development', *later) for s in scenarios),
            'tenNaturalCompletedLaterEpisodesEveryScenario': all(sum(performance[p][s]['naturalCompletedEpisodes'] for p in later) >= 10 for s in scenarios),
            'naturalCompletedEpisodeEachLaterPeriodEveryScenario': all(performance[p][s]['naturalCompletedEpisodes'] > 0 for p in later for s in scenarios),
            'laterLowDrawdownAtMost500EveryScenario': all(performance[p][s]['maxIntradayLowDrawdownUsd'] <= 500 for p in later for s in scenarios),
            'positiveDescriptiveAdjustedExcessBounds': all(bound['eightTrialAdjustedLowerNetUsd'] > 0 for bound in summary['confidence'][asset].values()),
        }
        check(independently_checked == summary['qualification'][asset]['checks'], 'qualification checks independently reproduce')
        check(all(independently_checked.values()) == summary['qualification'][asset]['historicalScreenPassed'], 'qualification aggregate reproduces')
    check(all(not q['historicalScreenPassed'] and not q['validatedProfitable'] and not q['activationAllowed'] for q in summary['qualification'].values()), 'both selected candidates fail and remain research only')
    for name, wanted in original_hashes.items():
        check(digest(REPO / name) == wanted, 'audit leaves registered results untouched')
    result = {
        'status': 'PASS_WITH_RESEARCH_LIMITATIONS',
        'auditedAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(),
        'resultsDirectory': str(OUT.relative_to(REPO)),
        'sourceSha256': digest(Path(__file__)),
        'resultHashes': original_hashes,
        'checksPassed': sum(COUNTS.values()),
        'counts': dict(COUNTS),
        'largestNumericalResidual': MAX_RESIDUAL,
        'weeklyFinalizationExclusionDaysChecked': excluded_latest_finalization,
        'substantiveImplementationDefectsFound': [],
        'selectedCandidates': lock['selectedNewCandidate'],
        'qualification': summary['qualification'],
        'recommendation': 'No new live deployment or replacement justified. Preserve existing BTC and ETH40 paper observations and retain cash as the no-trade control.',
        'limitations': [
            'The historical dates were previously searched; later windows are not untouched holdouts. Source hashes prove this run\'s artifact consistency, not absence of earlier exposure.',
            'Eight candidate applications share several established mathematical and economic families; they are not eight original mathematical inventions.',
            'OHLC opens, full exits, and forced terminal close sales are screening assumptions; actual bid/ask depth, partial fills, latency and queue priority are not reconstructed.',
            'The low drawdown metric measures prior observed close peaks to daily lows. It does not measure intraday high-to-subsequent-low drawdown or intraday event ordering.',
            'Windows reset to cash and liquidate at boundaries. Combined later-window P&L and its bootstrap are not the same path as the continuous diagnostic.',
            'Bootstrap bounds are descriptive and an eight-current-trial adjustment cannot correct the unknown prior search count or establish future profitability.',
            'BTC control uses the native weekly signal cutoff but shared daily execution and $10000/$1000 sizing. It is not a full replay of the running BTC service.',
            'Cash uses zero interest and results exclude taxes and infrastructure expense.'
        ]
    }
    (HERE / 'audit.json').write_text(json.dumps(result, indent=2, allow_nan=False)+'\n')
    print(json.dumps({'status':result['status'], 'checksPassed':result['checksPassed'], 'ledgerRuns':COUNTS['complete independent ledger runs'], 'largestNumericalResidual':MAX_RESIDUAL}))


if __name__ == '__main__':
    main()
