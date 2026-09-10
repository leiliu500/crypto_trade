"""Independent event/receipt audit; never calls the scored simulator.

Only validation artifacts are written. Frozen requests are checked against raw
finalized observations, while cash, quantities and fees are replayed from fills.
"""
import datetime as dt
import gzip
import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REPO = ROOT.parents[1]
OUT = ROOT / 'results-v1'
DATA = REPO / 'reports/parallel-strategy-study-2026-09-10/data'
DAY = 86400000
CHECKS = Counter()
TOTAL = Counter()
LARGEST = 0.


def read(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check(ok, label):
    assert ok, label
    CHECKS[label] += 1


def near(a, b, label, tolerance=1e-7):
    global LARGEST
    difference = abs(a-b)
    LARGEST = max(LARGEST, difference)
    assert difference <= tolerance, (label, a, b)
    CHECKS[label] += 1


def stamp(day):
    return int(dt.datetime.fromisoformat(day).replace(tzinfo=dt.timezone.utc).timestamp()*1000)


def independent_atr(bars, last, n):
    if last < n:
        return None
    intervals = []
    for j in range(last-n+1, last+1):
        b = bars[j]
        # True range is the span of the bar expanded to include prior close.
        intervals.append(max(b['high'], bars[j-1]['close'])-min(b['low'], bars[j-1]['close']))
    return math.fsum(intervals)/n


def audit_run(run, bars, eligible, thesis, hold, risk, rule, settings, dates, passive=False, cash_only=False):
    start, end = map(stamp, dates)
    first = next(i for i,b in enumerate(bars) if b['openMs']==start)
    last = next(i for i,b in enumerate(bars) if b['openMs']==end-DAY)
    check(len(run['daily'])==last-first+1, 'all window daily observations present')
    lag, fee, slip = settings['signalToOpenBars'], settings['feeBps']/10000, settings['slippageBps']/10000
    groups = defaultdict(list)
    for event in run['events']:
        groups[event['timestampMs']].append(event)
    check([e['timestampMs'] for e in run['events']]==sorted(e['timestampMs'] for e in run['events']), 'events chronological')
    fill_events = [{k:v for k,v in e.items() if k!='kind'} for e in run['events'] if e['kind']=='FILL']
    check(fill_events==run['orders'], 'fill events exactly match order receipts')
    c = {k:0 for k in run['counters']}
    pending, inventory, buy, last_sale = None, 0., None, None
    cash, total_fees, adverse, gross_edge, turnover = 10000., 0., 0., 0., 0.
    peak, close_dd, low_dd, previous_equity, exposed = 10000., 0., 0., 10000., 0
    episodes, ever_bought, processed = [], False, 0

    def liquidation(reference):
        sell_price = math.floor(reference*(1-slip)/rule['tick'])*rule['tick']
        return cash+inventory*sell_price*(1-fee)

    def fill(order, i, terminal=False):
        nonlocal cash, inventory, buy, total_fees, adverse, gross_edge, turnover, ever_bought, last_sale
        q, price, side = order['quantity'], order['price'], order['side']
        reference = bars[i]['close'] if terminal else bars[i]['open']
        check(q > 0 and price > 0, 'positive size and price')
        near(order['referencePrice'], reference, 'fill references proper future open or disclosed terminal close')
        near(q/rule['lot'], round(q/rule['lot']), 'lot alignment', 1e-6)
        near(price/rule['tick'], round(price/rule['tick']), 'tick alignment', 1e-6)
        near(order['feeUsd'], q*price*fee, 'both-side fee equation')
        intended_price = reference*(1+slip if side=='BUY' else 1-slip)
        difference = price-intended_price if side=='BUY' else intended_price-price
        check(-1e-9 <= difference <= rule['tick']+1e-8, 'side-adverse price rounding')
        if side=='BUY':
            check(inventory==0, 'entry only while fully flat')
            check(last_sale!=i, 'no same-day reentry')
            check(not passive or not ever_bought, 'passive control buys once')
            source = i-2
            check(order['volumeBarIndex']==source, 'size uses latest finalized i-2 daily volume')
            check(bars[source]['openMs']+DAY+60000 < order['timestampMs'], 'volume finalized before fill')
            cap = min(1000., cash*.1, cash, bars[source]['volume']*bars[source]['close']*.001)
            near(order['budgetUsd'], cap, 'funded entry budget')
            spend = q*price+order['feeUsd']
            check(spend <= cap+1e-7, 'fee included within cash and volume caps')
            check(cap-spend < rule['lot']*price*(1+fee)+1e-7, 'quantity rounds down at lot step')
            check(q>=rule['minQty'] and q*price>=rule['minCost'], 'entry instrument minimums')
            atr = independent_atr(bars, source, risk['atrLookback'])
            if any(risk[k] is not None for k in ('stopAtrMultiple','trailingAtrMultiple','profitAtrMultiple')) and not (atr is not None and atr>0):
                c['riskEntriesWithoutPositiveAtr'] += 1
            cash -= spend
            inventory, buy, ever_bought = q, dict(order, index=i, basis=spend, atr=atr), True
            adverse += q*(price-reference)
            if last_sale is not None and i-last_sale<=7:
                c['rapidReentriesWithin7Days'] += 1
        else:
            check(side=='SELL' and inventory>0, 'sale only while actual units held')
            near(q, inventory, 'full inventory sale assumption explicit')
            if q<rule['minQty'] or q*price<rule['minCost']:
                c['assumedExitBelowMinimum'] += 1
            net = q*price-order['feeUsd']-buy['basis']
            edge = q*(reference-buy['referencePrice'])
            price_cost = q*((buy['price']-buy['referencePrice'])+(reference-price))
            near(net, edge-price_cost-buy['feeUsd']-order['feeUsd'], 'episode reference edge minus costs equals net')
            episodes.append(dict(entryMs=buy['timestampMs'], exitMs=order['timestampMs'], quantity=q,
                entryPrice=buy['price'], exitPrice=price, referencePnlUsd=edge, adversePriceCostUsd=price_cost,
                feesUsd=buy['feeUsd']+order['feeUsd'], netPnlUsd=net,
                holdingDays=(order['timestampMs']-buy['timestampMs'])/DAY,
                entryAtr=buy['atr'], exitReason=order['reason']))
            c['terminalSales' if terminal else 'naturalExits'] += 1
            gross_edge += edge
            adverse += q*(reference-price)
            cash += q*price-order['feeUsd']
            inventory, buy, last_sale = 0., None, i
        total_fees += order['feeUsd']
        turnover += q*price
        check(cash >= -1e-7, 'cash never borrowed')

    def expected_exit(j):
        if buy is None or j<buy['index']:
            return None
        age = j-buy['index']+1
        entry_price, atr, close = buy['price'], buy['atr'], bars[j]['close']
        if atr is not None and atr>0:
            peak_close = max([entry_price]+[bars[n]['close'] for n in range(buy['index'],j+1)])
            for key, threshold, below, reason in (
                ('stopAtrMultiple', entry_price-(risk['stopAtrMultiple'] or 0)*atr, True, 'protective_close_stop'),
                ('trailingAtrMultiple', peak_close-(risk['trailingAtrMultiple'] or 0)*atr, True, 'trailing_close_stop'),
                ('profitAtrMultiple', entry_price+(risk['profitAtrMultiple'] or 0)*atr, False, 'profit_close_exit')):
                if risk[key] is not None and (close<=threshold if below else close>=threshold):
                    return reason
        if hold['maxHoldBars'] is not None and age>=hold['maxHoldBars']:
            return 'maximum_holding_age'
        streak = 0
        for n in range(j,buy['index']-1,-1):
            if thesis[n]:
                break
            streak += 1
        if age>=hold['minimumHoldBars'] and streak>=hold['thesisBreakConfirmBars']:
            return 'thesis_break'
        return None

    for row, i in zip(run['daily'],range(first,last+1)):
        t, j = bars[i]['openMs'], i-1
        open_events = groups.get(t,[])
        due = pending is not None and pending['dueIndex']==i
        check(len(open_events)==int(due), 'exactly one attempt at queued due open and none otherwise')
        for event in open_events:
            processed += 1
            check(event['kind'] in ('FILL','REJECT') and event['intent']==pending, 'due fill or rejection belongs to unchanged committed intent')
            check(pending['decisionMs'] < t and pending['signalBarIndex']+lag==i, 'execution follows causal finalized signal lag')
            check(pending['side']==event['side'], 'fill side matches submitted side')
            if event['kind']=='FILL':
                fill(event,i)
            else:
                check(event['side']=='BUY' and event['reason']=='LOT_OR_MIN_COST', 'entry rejection type')
                cap=min(1000.,cash*.1,cash,bars[i-2]['volume']*bars[i-2]['close']*.001)
                p=math.ceil(bars[i]['open']*(1+slip)/rule['tick'])*rule['tick']
                q=math.floor(cap/(p*(1+fee))/rule['lot'])*rule['lot']
                check(q<rule['minQty'] or q*p<rule['minCost'], 'rejection justified by actual cap and minima')
                c['rejectedEntries'] += 1
            pending = None
        expected_events = []
        decision = t+60000
        if j>=first and not cash_only:
            if pending is not None and pending['side']=='BUY' and not passive and not thesis[j]:
                expected_events.append(dict(timestampMs=decision,kind='CANCEL',reason='ENTRY_THESIS_INVALIDATED',intent=pending))
                pending=None
                c['canceledEntryIntents'] += 1
            if inventory>0 and not passive:
                reason=expected_exit(j)
                if pending is None and reason is not None:
                    check(j>=buy['index'], 'no pre-entry holding or risk trigger')
                    pending=dict(side='SELL',decisionMs=decision,signalBarIndex=j,dueIndex=j+lag,reason=reason)
                    expected_events.append(dict(timestampMs=decision,kind='SUBMIT_INTENT',**pending))
            elif inventory==0:
                c['flatDecisionBars'] += 1
                c['eligibleFlatBars'] += bool(eligible[j])
                if pending is None and eligible[j] and last_sale!=i and not (passive and ever_bought):
                    pending=dict(side='BUY',decisionMs=decision,signalBarIndex=j,dueIndex=j+lag,reason='entry_eligible')
                    c['submittedEntries'] += 1
                    expected_events.append(dict(timestampMs=decision,kind='SUBMIT_INTENT',**pending))
        actual_events=groups.get(decision,[])
        check(actual_events==expected_events, 'all finalization decisions and omitted decisions reproduce independently')
        processed += len(actual_events)
        if inventory>0:
            exposed += 1
            low_dd=max(low_dd,peak-liquidation(bars[i]['low']))
        equity=liquidation(bars[i]['close']) if inventory else cash
        if i==last:
            terminal_events=groups.get(end,[])
            expected_count=int(pending is not None)+int(inventory>0)
            check(len(terminal_events)==expected_count, 'terminal cancels and sales all accounted')
            for event in terminal_events:
                processed += 1
                if event['kind']=='CANCEL':
                    check(event['reason']=='WINDOW_END' and event['intent']==pending, 'only outstanding intent canceled at terminal boundary')
                    c['terminalPendingEntries' if pending['side']=='BUY' else 'terminalPendingExits'] += 1
                    pending=None
                else:
                    check(event['kind']=='FILL' and event['reason']=='terminal' and event['intent'] is None, 'forced terminal sale separate from natural intent')
                    fill(event,i,True)
            check(inventory==0 and pending is None, 'terminal leaves cash and no hidden intent')
            near(equity,cash,'terminal sale matches costed liquidation mark')
        near(row['equityUsd'],equity,'daily liquidation equity from independent cash ledger')
        near(row['pnlUsd'],equity-previous_equity,'daily P&L increments')
        near(row['quantity'],inventory,'daily inventory')
        check(row['date']==dt.datetime.fromtimestamp(t/1000,dt.timezone.utc).date().isoformat(),'daily date alignment')
        peak=max(peak,equity)
        close_dd=max(close_dd,peak-equity)
        previous_equity=equity
    check(processed==len(run['events']),'every event consumed exactly once')
    check(c==run['counters'],'all intent execution exposure and assumption counters reconcile')
    check(len(episodes)==len(run['episodes'])==run['entries'],'episode and entry counts')
    for expected,actual in zip(episodes,run['episodes']):
        check(set(expected)==set(actual),'episode schema')
        for key,value in expected.items():
            if isinstance(value,(float,int)):
                near(actual[key],value,'episode field '+key)
            else:
                check(actual[key]==value,'episode field '+key)
    net=cash-10000.
    measures=dict(netPnlUsd=net,grossReferenceEdgeUsd=gross_edge,feesUsd=total_fees,
        adversePriceCostUsd=adverse,turnoverUsd=turnover,maxCloseDrawdownUsd=close_dd,
        priorClosePeakToDailyLowDrawdownUsd=low_dd,selectionUtility=net-.5*close_dd,
        meanHoldingDays=sum(e['holdingDays'] for e in episodes)/len(episodes) if episodes else 0,
        exposedDays=exposed,totalDays=last-first+1,naturalCompletedEpisodes=c['naturalExits'],terminalSales=c['terminalSales'])
    for key,value in measures.items():
        near(run[key],value,'summary metric '+key)
    near(net,gross_edge-total_fees-adverse,'total reference edge minus fees and adverse cost')
    near(net,sum(e['netPnlUsd'] for e in episodes),'episode net sum')
    near(net,sum(r['pnlUsd'] for r in run['daily']),'daily net sum')
    TOTAL.update(c)
    TOTAL['auditedRuns'] += 1
    TOTAL['auditedOrders'] += len(run['orders'])
    TOTAL['auditedEvents'] += len(run['events'])


def main():
    reg=read(OUT/'registration.json')
    lock=read(OUT/'selection-lock.json')
    summary=read(OUT/'summary.json')
    protocol=read(ROOT/'protocol.json')
    full=json.loads(gzip.decompress((OUT/'full-ledgers.json.gz').read_bytes()))
    development=json.loads(gzip.decompress((OUT/'development-ledgers.json.gz').read_bytes()))
    targets=read(OUT/'targets.json')
    dev_targets=read(OUT/'development-targets.json')
    data,rules=read(DATA/'dataset.json'),read(DATA/'rules.json')
    original={str(p.relative_to(REPO)):sha(p) for p in OUT.iterdir() if p.is_file()}
    for path,wanted in lock['hashes'].items():
        check(sha(REPO/path)==wanted,'frozen source/data hash')
    check(reg['hashes']==lock['hashes'],'registration and selection inputs identical')
    for name,wanted in read(OUT/'integrity.json').items():
        check(sha(OUT/name)==wanted,'result integrity hash')
    check(reg['registeredAt']<lock['lockedAt'] and lock['laterPeriodsEvaluated'] is False,'selection records registration before development lock and no later scoring')
    check(summary['selectedCombination']==lock['selectedCombination'] and summary['choiceIncludingCash']==lock['choiceIncludingCash'],'no later reselection of combination or cash choice')
    check(reg['combinationCount']==54 and sum(map(len,reg['combinations'].values()))==54,'54 combinations, 27 per asset')
    for symbol,choices in reg['combinations'].items():
        check(len(choices)==27,'exactly 27 asset combinations')
        n=len(dev_targets['thesis'][symbol])
        check(targets['thesis'][symbol][:n]==dev_targets['thesis'][symbol],'parent thesis development prefix unchanged')
        for key,target in targets['entries'][symbol].items():
            check(target[:n]==dev_targets['entries'][symbol][key],'entry development prefix unchanged')
            check(all(not e or t for e,t in zip(target,targets['thesis'][symbol])),'entry gate never authorizes a cash parent thesis')
        spec_map={c['id']:c for c in choices}
        prefix=symbol[:3].lower()
        for key in list(spec_map)+[prefix+'_cash',prefix+'_passive']:
            passive=key==prefix+'_passive'
            cash=key==prefix+'_cash'
            c=choices[0] if passive or cash else spec_map[key]
            eligible=[True]*len(data[symbol]) if passive or cash else targets['entries'][symbol][c['entry']]
            check(full[key]['development']==development[key]['development'],'full evaluation preserves every development ledger byte value')
            for period,by_case in full[key].items():
                for case,run in by_case.items():
                    audit_run(run,data[symbol],eligible,targets['thesis'][symbol],c['holding'],c['exit'],rules[symbol],protocol['scenarios'][case],protocol['periods'][period],passive,cash)
                    check({k:v for k,v in run.items() if k not in ('daily','events','orders','episodes')}==summary['performance'][key][period][case],'summary exact projection of complete ledger')
        utility={key:min(case['selectionUtility'] for case in development[key]['development'].values()) for key in list(spec_map)+[prefix+'_cash',prefix+'_passive']}
        for key,value in utility.items():
            near(lock['worstScenarioDevelopmentUtility'][key],value,'selection utility from development only')
        rank=lambda keys:sorted(keys,key=lambda k:(-utility[k],k))
        check(rank(list(spec_map))[0]==lock['selectedCombination'][symbol],'best registered combination uses development only')
        check(rank(list(spec_map)+[prefix+'_cash'])[0]==lock['choiceIncludingCash'][symbol],'cash included in development choice')
        check(rank(list(utility))==lock['developmentRanking'][symbol],'complete development ranking including passive')
        baseline=choices[0]
        selected=spec_map[lock['selectedCombination'][symbol]]
        attrs=summary['componentAttribution'][symbol]
        for component in ('entry','holding','exit'):
            isolated=[c['id'] for c in choices if all(c[k]==baseline[k] for k in ('entry','holding','exit') if k!=component)]
            check(rank(isolated)[0]==lock['singleStageDevelopmentChoices'][symbol][component],'single-stage choices independently selected on development')
            alone=next(c['id'] for c in choices if all(c[k]==(selected[k] if k==component else baseline[k]) for k in ('entry','holding','exit')))
            removed=next(c['id'] for c in choices if all(c[k]==(baseline[k] if k==component else selected[k]) for k in ('entry','holding','exit')))
            check(attrs['singleComponentAppliedToBaseline'][component]==alone,'standalone attribution uses selected component')
            check(attrs['selectedComponentRemoved'][component]==removed,'removal attribution restores only the chosen component')
        for period,cases in attrs['metrics'].items():
            for case,recorded in cases.items():
                net=lambda k:summary['performance'][k][period][case]['netPnlUsd']
                base_net=net(baseline['id'])
                joint=net(selected['id'])-base_net
                additive=sum(net(k)-base_net for k in attrs['singleComponentAppliedToBaseline'].values())
                near(recorded['jointImprovementUsd'],joint,'joint improvement attribution')
                near(recorded['sumStandaloneComponentImprovementUsd'],additive,'standalone additive attribution')
                near(recorded['interactionResidualUsd'],joint-additive,'interaction residual attribution')
                for component,k in attrs['selectedComponentRemoved'].items():
                    near(recorded['removalImpactUsd'][component],net(selected['id'])-net(k),'joint component removal attribution')
        performance=summary['performance'][selected['id']]
        later=('later_2025','recent_2026')
        cases=protocol['scenarios']
        total_net=lambda key,case:sum(summary['performance'][key][p][case]['netPnlUsd'] for p in later)
        expected=dict(positiveEveryDevelopmentAndLaterScenario=all(performance[p][c]['netPnlUsd']>0 for p in ('development',*later) for c in cases),
            tenNaturalLaterEpisodesEachScenario=all(sum(performance[p][c]['naturalCompletedEpisodes'] for p in later)>=10 for c in cases),
            naturalEpisodeEachLaterWindow=all(performance[p][c]['naturalCompletedEpisodes']>0 for p in later for c in cases),
            laterSampledLowDrawdownAtMost500=all(performance[p][c]['priorClosePeakToDailyLowDrawdownUsd']<=500 for p in later for c in cases),
            laterNetAtLeastBaselineEveryScenario=all(total_net(selected['id'],c)>=total_net(baseline['id'],c) for c in cases),
            laterNetAtLeastPassiveEveryScenario=all(total_net(selected['id'],c)>=total_net(prefix+'_passive',c) for c in cases),
            noExitMinimumOrMissingRiskAtrAssumptions=all(performance[p][c]['counters']['assumedExitBelowMinimum']==0 and performance[p][c]['counters']['riskEntriesWithoutPositiveAtr']==0 for p in ('development',*later) for c in cases))
        q=summary['qualification'][symbol]
        check(q['checks']==expected and q['historicalScreenPassed']==all(expected.values()),'all qualification checks and aggregate reproduce')
        check(q['futureProfitValidated'] is False and q['liveActivationAllowed'] is False,'research-only status retained')
    check(TOTAL['auditedRuns']==928==summary['totalWindowScenarioRuns'],'complete 928-run audit')
    for path,wanted in original.items():
        check(sha(REPO/path)==wanted,'audit leaves frozen result files unchanged')
    result=dict(status='PASS_WITH_RESEARCH_LIMITATIONS',auditedAtUtc=dt.datetime.now(dt.timezone.utc).isoformat(),
        sourceSha256=sha(Path(__file__)),resultsDirectory=str(OUT.relative_to(REPO)),resultHashes=original,
        checksPassed=sum(CHECKS.values()),checks=dict(CHECKS),totals=dict(TOTAL),largestNumericalResidual=LARGEST,
        substantiveImplementationDefectsFound=[],qualification=summary['qualification'],
        limitations=['Known history reuse; chronological later periods are not untouched holdouts.',
            '54 lifecycle combinations are recombinations of registered components, not 54 novel mathematical systems.',
            'Full costed OHLC fills, exit liquidity and instrument rules are historical screening assumptions.',
            'One-shot entry gates persist until their fixed fill attempt unless the parent thesis turns cash; the gate itself need not recur.',
            'Baseline control uses a normalized daily event lifecycle and sizing, not exact current BTC or ETH40 runtime parity.',
            'Independent single-stage winners and standalone components of the joint winner answer different questions.',
            'Component gains are conditional on other components; removal impacts and interaction residuals are accounting contrasts, not causal proof of future edge.',
            'Terminal sells are excluded from natural episodes; sampled low drawdown is not intraday pathwise drawdown.',
            'The execution specialist does not rank hypothetical maker profitability from OHLC data.'])
    (HERE/'audit.json').write_text(json.dumps(result,indent=2,allow_nan=False)+'\n')
    print(json.dumps({k:result[k] for k in ('status','checksPassed','largestNumericalResidual')} | {'totals':dict(TOTAL)}))


if __name__=='__main__':
    main()
