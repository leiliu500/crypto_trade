"""Independent synthetic lifecycle review; does not inspect historical P&L."""
import copy
import hashlib
import importlib.util
import json
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent/'simulator.py'
spec = importlib.util.spec_from_file_location('lifecycle_independent_review', SOURCE)
sim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sim)
DAY = 86400000
RULES = {'lot':.001,'tick':.1,'minQty':.001,'minCost':.1}
HOLD = {'maxHoldBars':None,'minimumHoldBars':1,'thesisBreakConfirmBars':1}
EXIT = {'atrLookback':20,'stopAtrMultiple':3.,'trailingAtrMultiple':None,'profitAtrMultiple':None}


def fixture():
    bars=[{'openMs':i*DAY,'open':100.,'high':101.,'low':99.,'close':100.,'volume':1e6} for i in range(110)]
    eligible=[False]*110
    eligible[90]=True
    return bars,eligible,[True]*110


def replay(bars,eligible,thesis,lag=2,**kwargs):
    return sim.run(bars,eligible,thesis,kwargs.pop('holding',HOLD),kwargs.pop('exit_policy',EXIT),kwargs.pop('rules',RULES),
                   {'feeBps':80,'slippageBps':3,'signalToOpenBars':lag},90*DAY,100*DAY,**kwargs)


def reconcile(result):
    cash=Decimal('10000')
    qty=Decimal(0)
    for order in result['orders']:
        q,p,f=(Decimal(str(order[k])) for k in ('quantity','price','feeUsd'))
        if order['side']=='BUY':
            assert qty == 0
            cash -= q*p+f
            qty += q
            assert cash >= 0
            assert float(q*p+f) <= order['budgetUsd']+1e-7
        else:
            assert abs(q-qty)<Decimal('0.00000000001')
            qty -= q
            cash += q*p-f
        assert abs(float(q/Decimal(str(RULES['lot'])))-round(float(q/Decimal(str(RULES['lot']))))) < 1e-6
    assert qty == 0
    assert abs(float(cash-10000)-result['netPnlUsd']) < 1e-6
    assert abs(result['netPnlUsd']-(result['grossReferenceEdgeUsd']-result['feesUsd']-result['adversePriceCostUsd'])) < 1e-6
    assert all(a['timestampMs'] <= b['timestampMs'] for a,b in zip(result['events'],result['events'][1:]))


def main():
    source_hash=hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    checks=[]
    # A pending lag-three buy is canceled by a newly finalized broken thesis.
    b,e,t=fixture()
    t[91]=False
    result=replay(b,e,t,lag=3)
    assert not result['orders'] and result['counters']['canceledEntryIntents']==1
    cancel=next(x for x in result['events'] if x['kind']=='CANCEL')
    assert cancel['timestampMs']==92*DAY+60000
    reconcile(result)
    checks.append({'check':'pending_entry_canceled_by_thesis_before_later_due_open','passed':True})

    # A one-shot firing event need not recur to keep its scheduled intent alive.
    b,e,t=fixture()
    result=replay(b,e,t,lag=3)
    assert result['orders'][0]['timestampMs']==93*DAY
    assert result['counters']['canceledEntryIntents']==0
    reconcile(result)
    checks.append({'check':'entry_gate_disappearance_preserves_pending_valid_thesis','passed':True})

    # A bar before entry cannot stop a newly bought position, even if it only
    # becomes finalized one minute after the entry open.
    b,e,t=fixture()
    b[91].update(close=20.,low=1.,high=1000.)
    t[91]=False
    result=replay(b,e,t)
    assert result['orders'][0]['timestampMs']==92*DAY
    assert result['naturalCompletedEpisodes']==0 and result['terminalSales']==1
    assert result['priorClosePeakToDailyLowDrawdownUsd']<100
    reconcile(result)
    checks.append({'check':'pre_entry_close_high_low_and_thesis_cannot_trigger_position_exit','passed':True})

    # Post-entry thesis break at close 92 finalizes at 93+60s, fills 94 open.
    b,e,t=fixture()
    t[92]=False
    b[94].update(open=95.,low=94.,close=95.,high=96.)
    result=replay(b,e,t)
    sale=result['orders'][1]
    assert sale['timestampMs']==94*DAY and sale['referencePrice']==95.
    assert sale['intent']['decisionMs']==93*DAY+60000
    assert result['naturalCompletedEpisodes']==1 and result['terminalSales']==0
    reconcile(result)
    checks.append({'check':'natural_exit_uses_future_open_and_distinct_natural_count','passed':True})

    b,e,t=fixture()
    t[92:95]=[False]*3
    hold={'maxHoldBars':None,'minimumHoldBars':3,'thesisBreakConfirmBars':3}
    result=replay(b,e,t,holding=hold)
    sale=result['orders'][1]
    assert sale['timestampMs']==96*DAY and sale['reason']=='thesis_break'
    assert sale['intent']['decisionMs']==95*DAY+60000
    reconcile(result)
    checks.append({'check':'three_post_entry_breaks_and_minimum_age_before_exit','passed':True})

    b,e,t=fixture()
    b[92].update(close=90.,low=89.)
    hold={'maxHoldBars':None,'minimumHoldBars':10,'thesisBreakConfirmBars':3}
    result=replay(b,e,t,holding=hold)
    sale=result['orders'][1]
    assert sale['timestampMs']==94*DAY and sale['reason']=='protective_close_stop'
    reconcile(result)
    checks.append({'check':'protective_close_stop_overrides_minimum_holding_age','passed':True})

    b,e,t=fixture()
    b[92]['low']=10.
    result=replay(b,e,t)
    assert result['naturalCompletedEpisodes']==0
    assert result['priorClosePeakToDailyLowDrawdownUsd']>500
    reconcile(result)
    checks.append({'check':'intraday_low_affects_risk_diagnostic_but_not_close_stop','passed':True})

    # The last-day terminal sale charges exit costs and never counts natural.
    b,e,t=fixture()
    result=replay(b,e,t)
    assert result['terminalSales']==1 and result['naturalCompletedEpisodes']==0
    assert len(result['orders'])==2 and result['orders'][1]['timestampMs']==100*DAY
    assert result['netPnlUsd']<0 and result['feesUsd']>0 and result['adversePriceCostUsd']>0
    reconcile(result)
    checks.append({'check':'terminal_fees_cash_lot_and_reference_pnl_reconciliation','passed':True})

    # Sizing must use i-2, even though enormous i-1/i volumes are in the array.
    b,e,t=fixture()
    b[90]['volume']=10.
    b[91]['volume']=b[92]['volume']=1e15
    result=replay(b,e,t)
    purchase=result['orders'][0]
    assert purchase['volumeBarIndex']==90 and abs(purchase['budgetUsd']-1.)<1e-12
    reconcile(result)
    checks.append({'check':'sizing_volume_uses_i_minus_2_not_unfinalized_or_future_volume','passed':True})

    b,e,t=fixture()
    result=replay(b,[True]*110,t,cash_only=True)
    assert result['netPnlUsd']==0 and not result['orders']
    reconcile(result)
    checks.append({'check':'cash_control_cannot_fire_or_pay_fees','passed':True})

    # Capture the model's declared full-exit assumption as a limitation rather
    # than silently treating sell minimums as enforced.
    b,e,t=fixture()
    t[92]=False
    b[94].update(open=.01,low=.005,high=.02,close=.01)
    rules=dict(RULES,tick=.0001,minCost=50.)
    result=replay(b,e,t,rules=rules)
    violation=[o for o in result['orders'] if o['side']=='SELL' and o['quantity']*o['price']<rules['minCost']]
    limitation={'id':'sell_minimum_not_enforced','observed':bool(violation),'syntheticMinimumNotionalUsd':50.,
                'sellNotionalUsd':violation[0]['quantity']*violation[0]['price'] if violation else None,
                'implication':'Model assumes full exits even when synthetic sell notional falls below venue minimum; disclose assumption or implement residual/rejection handling.'}
    assert hashlib.sha256(SOURCE.read_bytes()).hexdigest()==source_hash,'Simulator changed during audit; rerun'
    output={'syntheticChecksPassed':True,'historicalCandidatePnLInspected':False,'simulatorSha256':source_hash,
            'checks':checks,'limitations':[limitation],
            'resetTiming':'First in-window bar is first considered at next-day+60s; first buy is firstIndex+lag open. Passive follows same start delay.'}
    (HERE/'engine-review.json').write_text(json.dumps(output,indent=2)+'\n')
    print(json.dumps(output,indent=2))


if __name__=='__main__':
    main()
