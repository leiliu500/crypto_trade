"""Offline chronological lifecycle experiment. No exchange client or runtime writes."""
import datetime as dt
import math

DAY = 86400000


def atr_at(bars, i, lookback):
    if i < lookback:
        return None
    ranges = [max(bars[j]['high'] - bars[j]['low'],
                  abs(bars[j]['high'] - bars[j-1]['close']),
                  abs(bars[j]['low'] - bars[j-1]['close']))
              for j in range(i-lookback+1, i+1)]
    return sum(ranges) / lookback


def run(bars, eligible, thesis, holding, exit_policy, rules, scenario,
        start_ms, end_ms, passive=False, cash_only=False):
    """Execute open events before each previous-bar finalization event.

    All timestamped events are emitted in chronological order. Decisions at
    open+60 seconds cannot act on the new day's close/high/low/volume.
    """
    assert len(bars) == len(eligible) == len(thesis)
    indices = [i for i, b in enumerate(bars) if start_ms <= b['openMs'] < end_ms]
    assert indices and indices == list(range(indices[0], indices[-1]+1))
    fee, slip = scenario['feeBps']/10000, scenario['slippageBps']/10000
    lag = scenario['signalToOpenBars']
    assert 0 <= fee < 1 and 0 <= slip < 1 and lag in (2, 3)
    cash, qty, basis = 10000., 0., 0.
    entry, pending = None, None
    events, orders, episodes, daily = [], [], [], []
    counters = dict(flatDecisionBars=0, eligibleFlatBars=0, submittedEntries=0,
                    canceledEntryIntents=0, rejectedEntries=0, terminalPendingEntries=0,
                    terminalPendingExits=0, naturalExits=0, terminalSales=0,
                    rapidReentriesWithin7Days=0, assumedExitBelowMinimum=0,
                    riskEntriesWithoutPositiveAtr=0)
    fees, adverse, reference_pnl, turnover = 0., 0., 0., 0.
    peak, close_dd, low_dd, exposed = 10000., 0., 0., 0
    break_count, highest_close, last_sale_i = 0, 0., None
    ever_bought = False

    def event(timestamp, kind, **values):
        assert not events or timestamp >= events[-1]['timestampMs']
        events.append(dict(timestampMs=timestamp, kind=kind, **values))

    def price(reference, side):
        shifted = reference * (1 + side * slip)
        return (math.ceil(shifted/rules['tick']) if side == 1 else
                math.floor(shifted/rules['tick'])) * rules['tick']

    def mark(reference):
        return cash + qty * price(reference, -1) * (1-fee)

    def sell(i, reference, timestamp, reason, intent):
        nonlocal cash, qty, basis, entry, fees, adverse, reference_pnl, turnover
        nonlocal break_count, highest_close, last_sale_i
        assert qty > 0 and entry is not None
        p = price(reference, -1)
        if qty < rules['minQty'] or qty*p < rules['minCost']:
            counters['assumedExitBelowMinimum'] += 1
        f = qty*p*fee
        gross_edge = qty*(reference-entry['referencePrice'])
        cost = qty*(entry['price']-entry['referencePrice']+reference-p)
        net = qty*p-f-basis
        assert abs(net-(gross_edge-cost-entry['feeUsd']-f)) < 1e-7
        cash += qty*p-f
        fees += f; adverse += qty*(reference-p); turnover += qty*p
        reference_pnl += gross_edge
        order = dict(timestampMs=timestamp, side='SELL', quantity=qty, price=p,
                     referencePrice=reference, feeUsd=f, reason=reason, intent=intent)
        orders.append(order)
        event(timestamp, 'FILL', **{k:v for k,v in order.items() if k != 'timestampMs'})
        episodes.append(dict(entryMs=entry['timestampMs'], exitMs=timestamp,
                             quantity=qty, entryPrice=entry['price'], exitPrice=p,
                             referencePnlUsd=gross_edge, adversePriceCostUsd=cost,
                             feesUsd=entry['feeUsd']+f, netPnlUsd=net,
                             holdingDays=(timestamp-entry['timestampMs'])/DAY,
                             entryAtr=entry['atr'], exitReason=reason))
        counters['terminalSales' if reason == 'terminal' else 'naturalExits'] += 1
        qty, basis, entry = 0., 0., None
        break_count, highest_close, last_sale_i = 0, 0., i

    for i in indices:
        b, t = bars[i], bars[i]['openMs']
        # All fills here originate at an earlier finalization event.
        if pending is not None and pending['dueIndex'] == i:
            request, pending = pending, None
            assert request['decisionMs'] < t
            assert request['signalBarIndex'] + lag == i
            if request['side'] == 'BUY':
                assert qty == 0
                source_i = i-2
                assert source_i >= 0 and bars[source_i]['openMs']+DAY+60000 < t
                available_volume = bars[source_i]['volume']*bars[source_i]['close']*.001
                budget = min(1000., cash*.1, cash, available_volume)
                p = price(b['open'], 1)
                units = math.floor(budget/(p*(1+fee))/rules['lot'])*rules['lot']
                if units < rules['minQty'] or units*p < rules['minCost']:
                    counters['rejectedEntries'] += 1
                    event(t, 'REJECT', side='BUY', reason='LOT_OR_MIN_COST', intent=request)
                else:
                    f = units*p*fee
                    qty, basis = units, units*p+f
                    cash -= basis; fees += f; adverse += units*(p-b['open']); turnover += units*p
                    entry = dict(timestampMs=t, index=i, price=p, quantity=units,
                                 referencePrice=b['open'], feeUsd=f,
                                 atr=atr_at(bars, source_i, exit_policy.get('atrLookback',20)))
                    if any(exit_policy.get(k) is not None for k in ('stopAtrMultiple','trailingAtrMultiple','profitAtrMultiple')) and not (entry['atr'] is not None and entry['atr'] > 0):
                        counters['riskEntriesWithoutPositiveAtr'] += 1
                    highest_close, break_count, ever_bought = p, 0, True
                    if last_sale_i is not None and i-last_sale_i <= 7:
                        counters['rapidReentriesWithin7Days'] += 1
                    order = dict(timestampMs=t, side='BUY', quantity=units, price=p,
                                 referencePrice=b['open'], feeUsd=f, budgetUsd=budget,
                                 volumeBarIndex=source_i, reason='entry', intent=request)
                    orders.append(order)
                    event(t, 'FILL', **{k:v for k,v in order.items() if k != 'timestampMs'})
            else:
                sell(i, b['open'], t, request['reason'], request)

        # Previous bar becomes available only 60 seconds after this open.
        j, decision_ms = i-1, t+60000
        if j >= indices[0] and not cash_only:
            if pending is not None and pending['side'] == 'BUY' and not passive and not thesis[j]:
                event(decision_ms, 'CANCEL', reason='ENTRY_THESIS_INVALIDATED', intent=pending)
                pending = None
                counters['canceledEntryIntents'] += 1
            if qty > 0 and not passive:
                reason = None
                # Do not treat pre-entry bars as exposure or risk-stop observations.
                if j >= entry['index']:
                    age = j-entry['index']+1
                    break_count = 0 if thesis[j] else break_count+1
                    highest_close = max(highest_close, bars[j]['close'])
                    a, close = entry['atr'], bars[j]['close']
                    if a is not None and a > 0:
                        stop = exit_policy.get('stopAtrMultiple')
                        trail = exit_policy.get('trailingAtrMultiple')
                        profit = exit_policy.get('profitAtrMultiple')
                        if stop is not None and close <= entry['price']-stop*a:
                            reason = 'protective_close_stop'
                        elif trail is not None and close <= highest_close-trail*a:
                            reason = 'trailing_close_stop'
                        elif profit is not None and close >= entry['price']+profit*a:
                            reason = 'profit_close_exit'
                    maximum = holding['maxHoldBars']
                    if reason is None and maximum is not None and age >= maximum:
                        reason = 'maximum_holding_age'
                    if reason is None and age >= holding['minimumHoldBars'] and break_count >= holding['thesisBreakConfirmBars']:
                        reason = 'thesis_break'
                if reason is not None and pending is None:
                    pending = dict(side='SELL', decisionMs=decision_ms, signalBarIndex=j,
                                   dueIndex=j+lag, reason=reason)
                    event(decision_ms, 'SUBMIT_INTENT', **pending)
            elif qty == 0:
                counters['flatDecisionBars'] += 1
                counters['eligibleFlatBars'] += bool(eligible[j])
                if pending is None and eligible[j] and last_sale_i != i and not (passive and ever_bought):
                    pending = dict(side='BUY', decisionMs=decision_ms, signalBarIndex=j,
                                   dueIndex=j+lag, reason='entry_eligible')
                    counters['submittedEntries'] += 1
                    event(decision_ms, 'SUBMIT_INTENT', **pending)

        # Prices below are accounting observations, never same-day decision inputs.
        if qty > 0:
            exposed += 1
            low_dd = max(low_dd, peak-mark(b['low']))
        equity = mark(b['close']) if qty else cash
        if i == indices[-1]:
            if pending is not None:
                counters['terminalPendingEntries' if pending['side']=='BUY' else 'terminalPendingExits'] += 1
                event(t+DAY, 'CANCEL', reason='WINDOW_END', intent=pending)
                pending = None
            if qty:
                sell(i, b['close'], t+DAY, 'terminal', None)
                assert abs(cash-equity) < 1e-7
                equity = cash
        peak = max(peak, equity)
        close_dd = max(close_dd, peak-equity)
        before = daily[-1]['equityUsd'] if daily else 10000.
        daily.append(dict(date=dt.datetime.fromtimestamp(t/1000,dt.timezone.utc).date().isoformat(),
                          equityUsd=equity, pnlUsd=equity-before, quantity=qty))
        assert cash >= -1e-7 and qty >= 0
    net = cash-10000.
    assert abs(net-sum(x['netPnlUsd'] for x in episodes)) < 1e-6
    assert abs(net-(reference_pnl-fees-adverse)) < 1e-6
    assert abs(net-sum(x['pnlUsd'] for x in daily)) < 1e-6
    return dict(netPnlUsd=net, grossReferenceEdgeUsd=reference_pnl, feesUsd=fees,
                adversePriceCostUsd=adverse, turnoverUsd=turnover,
                maxCloseDrawdownUsd=close_dd, priorClosePeakToDailyLowDrawdownUsd=low_dd,
                selectionUtility=net-.5*close_dd, entries=len(episodes),
                meanHoldingDays=sum(x['holdingDays'] for x in episodes)/len(episodes) if episodes else 0,
                exposedDays=exposed, totalDays=len(indices), counters=counters,
                naturalCompletedEpisodes=counters['naturalExits'], terminalSales=counters['terminalSales'],
                events=events, orders=orders, episodes=episodes, daily=daily)


def metrics(result):
    return {k:v for k,v in result.items() if k not in ('events','orders','episodes','daily')}
