"""Synthetic exit boundary, clock and accounting checks; no historical PnL."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


C = load('exit_candidates', HERE/'candidates.py')
S = load('lifecycle_simulator', HERE.parent/'simulator.py')
checks = []


def check(name, condition):
    assert condition, name
    checks.append(name)


def bars():
    return [dict(openMs=i*S.DAY, open=100., high=101., low=99., close=100.,
                 volume=100000.) for i in range(42)]


def change(data, i, **values):
    data[i].update(values)
    data[i]['high'] = max(data[i]['high'], data[i]['open'], data[i]['close'])
    data[i]['low'] = min(data[i]['low'], data[i]['open'], data[i]['close'])


def run(data, policy, lag=2, fee=0, all_eligible=False, minimum=1):
    eligible = [i >= 22 if all_eligible else i == 22 for i in range(len(data))]
    return S.run(data, eligible, [True]*len(data),
                 dict(maxHoldBars=None, minimumHoldBars=minimum, thesisBreakConfirmBars=1),
                 policy, dict(tick=.01, lot=.000001, minQty=.000001, minCost=1),
                 dict(feeBps=fee, slippageBps=0, signalToOpenBars=lag),
                 22*S.DAY, 42*S.DAY)


specs = C.exit_specs()
check('exactly_three_hypotheses_each_asset', set(specs) == {'BTC/USD','ETH/USD'}
      and all(len(x) == 3 for x in specs.values()))
check('all_six_identifiers_unique', len({x['id'] for rows in specs.values() for x in rows}) == 6)
for symbol in specs:
    base, trail, bracket = specs[symbol]
    prefix = symbol.split('/')[0]
    check(prefix+'_baseline_has_no_barriers', all(base[k] is None for k in
          ('stopAtrMultiple','trailingAtrMultiple','profitAtrMultiple')))
    data = bars(); change(data, 24, close=50.)
    result = run(data, base)
    check(prefix+'_baseline_preserves_thesis', result['naturalCompletedEpisodes'] == 0)
    check(prefix+'_terminal_is_not_natural', result['terminalSales'] == 1)

    data = bars(); change(data, 24, close=94.); change(data, 26, open=90.)
    result = run(data, trail, minimum=999)
    sale = result['orders'][1]
    check(prefix+'_stop_boundary_preempts_minimum_hold', sale['reason'] == 'protective_close_stop')
    check(prefix+'_stop_trigger_has_future_fill', sale['intent']['signalBarIndex'] == 24
          and sale['timestampMs'] == 26*S.DAY)
    check(prefix+'_gap_overruns_stop_price', sale['price'] == 90.)
    check(prefix+'_entry_atr_is_past_only', result['episodes'][0]['entryAtr'] == 2.)

    data = bars(); change(data, 24, close=120.); change(data, 25, close=112.)
    result = run(data, trail)
    check(prefix+'_trailing_boundary', result['orders'][1]['reason'] == 'trailing_close_stop'
          and result['orders'][1]['intent']['signalBarIndex'] == 25
          and result['orders'][1]['timestampMs'] == 27*S.DAY)

    data = bars(); change(data, 24, close=108.); change(data, 26, open=107.)
    result = run(data, bracket)
    check(prefix+'_profit_boundary_and_delayed_price', result['orders'][1]['reason'] == 'profit_close_exit'
          and result['orders'][1]['price'] == 107.)

    data = bars(); change(data, 24, high=500., low=1.)
    result = run(data, bracket)
    check(prefix+'_intraday_touches_are_not_close_triggers', result['naturalCompletedEpisodes'] == 0)
    change(data, 25, close=96.)
    result = run(data, bracket)
    check(prefix+'_post_entry_volatility_does_not_widen_stop',
          result['orders'][1]['reason'] == 'protective_close_stop'
          and result['orders'][1]['intent']['signalBarIndex'] == 25
          and result['episodes'][0]['entryAtr'] == 2.)

    data = bars(); change(data, 23, close=1.)
    result = run(data, bracket)
    check(prefix+'_pre_entry_close_never_triggers_exit', result['naturalCompletedEpisodes'] == 0)

    data = bars(); change(data, 25, close=96.)
    result = run(data, bracket, lag=3, all_eligible=True)
    check(prefix+'_delay_scenario_uses_signal_plus_three',
          result['orders'][0]['timestampMs'] == 25*S.DAY
          and result['orders'][1]['timestampMs'] == 28*S.DAY)

    data = bars(); change(data, 24, close=96.); change(data, 28, close=96.)
    result = run(data, bracket, fee=80, all_eligible=True)
    check(prefix+'_stop_reentry_churn_is_counted', result['counters']['rapidReentriesWithin7Days'] >= 1
          and result['feesUsd'] > 0)
    check(prefix+'_cash_and_costs_reconcile', abs(result['netPnlUsd']-
          (result['grossReferenceEdgeUsd']-result['feesUsd']-result['adversePriceCostUsd'])) < 1e-7)

    altered = copy.deepcopy(data); change(altered, 35, open=900., close=1000.)
    future = run(altered, bracket, fee=80, all_eligible=True)
    check(prefix+'_future_prices_cannot_change_past_orders',
          [o for o in result['orders'] if o['timestampMs'] < 35*S.DAY]
          == [o for o in future['orders'] if o['timestampMs'] < 35*S.DAY])

specs['BTC/USD'][1]['stopAtrMultiple'] = 999
check('registry_mutation_isolation', C.exit_specs()['BTC/USD'][1]['stopAtrMultiple'] == 3.)
record = dict(passed=True, count=len(checks), checks=checks,
              candidateSourceSha256=hashlib.sha256((HERE/'candidates.py').read_bytes()).hexdigest(),
              simulatorSha256=hashlib.sha256((HERE.parent/'simulator.py').read_bytes()).hexdigest(),
              historicalPnlInspected=False)
(HERE/'checks.json').write_text(json.dumps(record, indent=2)+'\n')
print(json.dumps(dict(passed=True, count=len(checks))))
