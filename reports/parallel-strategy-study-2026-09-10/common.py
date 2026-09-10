"""Shared causal, funded spot research accounting. No runtime imports or orders."""
import datetime as dt
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DAY = 86_400_000
SYMBOLS = ('BTC/USD','ETH/USD')

def timestamp(date):
    return int(dt.datetime.fromisoformat(date).replace(tzinfo=dt.timezone.utc).timestamp()*1000)

def load_data(development_only=True):
    name = 'development.json' if development_only else 'dataset.json'
    raw = (ROOT/'data'/name).read_bytes()
    if not development_only:
        assert hashlib.sha256(raw).hexdigest() == json.loads((ROOT/'protocol.json').read_text())['datasetSha256']
    return json.loads(raw)

def evaluate(targets, data, start='2025-01-01', end='2025-07-01', scenario='base', budget=1000., capital=10000., details=False):
    protocol = json.loads((ROOT/'protocol.json').read_text())
    settings = protocol['scenarios'][scenario] if isinstance(scenario,str) else scenario
    fee, slip, lag = settings['feeBps']/10000, settings['slippageBps']/10000, settings['signalToOpenBars']
    rules = json.loads((ROOT/'data/rules.json').read_text())
    assert len(targets) == len(data[SYMBOLS[0]])
    assert all(t in (*SYMBOLS,None) for t in targets)
    assert 0 <= fee < 1 and 0 <= slip < 1 and lag >= 2 and budget > 0 and capital > 0
    indices = [i for i,b in enumerate(data[SYMBOLS[0]]) if timestamp(start) <= b['openMs'] < timestamp(end)]
    assert indices and indices == list(range(indices[0],indices[-1]+1))
    cash, qty, basis, held = capital, 0., 0., None
    fees, pricecosts, turnover, exposed = 0., 0., 0., 0
    peak, maxdd, lowdd = capital, 0., 0.
    entry = None
    daily, trades, orders, rejects = [], [], [], []

    def price(symbol, reference, side):
        tick = rules[symbol]['tick']
        p = reference * (1 + slip * side)
        return (math.ceil(p/tick) if side > 0 else math.floor(p/tick))*tick

    def liquidate(reference):
        return cash if held is None else cash + qty*price(held,reference,-1)*(1-fee)

    def sell(i, reference, reason):
        nonlocal cash, qty, basis, held, fees, pricecosts, turnover, entry
        p = price(held,reference,-1)
        gross, f = qty*p, qty*p*fee
        net = gross-f-basis
        cash += gross-f; fees += f; pricecosts += qty*(reference-p); turnover += gross
        exit_ms = data[held][i]['openMs'] + (DAY if reason == 'terminal' else 0)
        orders.append(dict(symbol=held,side='SELL',timestampMs=exit_ms,quantity=qty,price=p,feeUsd=f,reason=reason))
        trades.append(dict(symbol=held,entryMs=entry['timestampMs'],exitMs=exit_ms,
                           quantity=qty,entryPrice=entry['price'],exitPrice=p,
                           netPnlUsd=net,feesUsd=entry['feeUsd']+f,
                           holdingDays=(exit_ms-entry['timestampMs'])/DAY,exitReason=reason))
        held, qty, basis, entry = None, 0., 0., None

    for i in indices:
        t = data[SYMBOLS[0]][i]['openMs']
        signal_i = i-lag
        desired = targets[signal_i] if signal_i >= indices[0] else None
        if desired != held:
            if held is not None:
                sell(i,data[held][i]['open'],'target_change')
            if desired is not None:
                r, b = rules[desired], data[desired][i]
                p = price(desired,b['open'],1)
                # The immediately previous daily bar is not finalized at this open.
                prev = data[desired][i-2]
                spend = min(budget,cash*.1,cash,prev['volume']*prev['close']*.001)
                q = math.floor((spend/(p*(1+fee)))/r['lot'])*r['lot']
                if q < r['minQty'] or q*p < r['minCost']:
                    rejects.append(dict(timestampMs=t,symbol=desired,reason='LOT_OR_MIN_COST'))
                else:
                    f = q*p*fee; basis = q*p+f; cash -= basis
                    fees += f; turnover += q*p; pricecosts += q*(p-b['open'])
                    held, qty = desired, q
                    entry = dict(symbol=held,side='BUY',timestampMs=t,signalBarOpenMs=data[held][signal_i]['openMs'],quantity=q,price=p,feeUsd=f)
                    orders.append(entry.copy())
                    assert cash >= -1e-7
        if held is not None:
            exposed += 1
            lowdd = max(lowdd,peak-liquidate(data[held][i]['low']))
        equity = cash if held is None else liquidate(data[held][i]['close'])
        if i == indices[-1] and held is not None:
            sell(i,data[held][i]['close'],'terminal')
            assert abs(cash-equity) < 1e-7
            equity = cash
        peak = max(peak,equity); maxdd = max(maxdd,peak-equity)
        previous = daily[-1]['equityUsd'] if daily else capital
        daily.append(dict(date=dt.datetime.fromtimestamp(t/1000,dt.timezone.utc).date().isoformat(),
                          equityUsd=equity,pnlUsd=equity-previous,held=held))
    assert abs(sum(x['netPnlUsd'] for x in trades)-(cash-capital)) < 1e-6
    wins = sum(t['netPnlUsd'] for t in trades if t['netPnlUsd'] > 0)
    losses = -sum(t['netPnlUsd'] for t in trades if t['netPnlUsd'] < 0)
    monthly = {}
    for row in daily:
        month = row['date'][:7]; monthly[month] = monthly.get(month,0)+row['pnlUsd']
    result = dict(start=start,end=end,scenario=scenario,initialCapitalUsd=capital,entryBudgetUsd=budget,
                  netPnlUsd=cash-capital,returnOnAccountPct=(cash/capital-1)*100,
                  netPctOfEntryBudget=(cash-capital)/budget*100,
                  maxDrawdownUsd=maxdd,maxDrawdownPctInitialCapital=maxdd/capital*100,
                  maxIntradayLowDrawdownUsd=lowdd,closedTrades=len(trades),entries=len(trades),
                  feesUsd=fees,adversePriceCostUsd=pricecosts,turnoverUsd=turnover,
                  profitFactor=wins/losses if losses else None,
                  winningTrades=sum(t['netPnlUsd']>0 for t in trades),
                  meanHoldingDays=sum(t['holdingDays'] for t in trades)/len(trades) if trades else 0,
                  exposedDays=exposed,totalDays=len(indices),positiveMonths=sum(v>0 for v in monthly.values()),
                  monthlyPnlUsd=monthly,rejectedEntries=len(rejects),selectionUtility=cash-capital-.5*maxdd)
    if details:
        result.update(daily=daily,trades=trades,orders=orders,rejections=rejects)
    return result
