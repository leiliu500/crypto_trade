"""Freeze native spot data and evaluation protocol before model outcomes."""
import datetime as dt
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DAY = 86_400_000
now = dt.datetime.now(dt.timezone.utc)
asof = int(now.timestamp() * 1000)
data, sources, rules = {}, [], {}
rawrules = json.loads((ROOT / 'data/rules-source.json').read_text())
assert rawrules['error'] == []
for symbol, key, short in [('BTC/USD', 'XXBTZUSD', 'BTC'), ('ETH/USD', 'XETHZUSD', 'ETH')]:
    path = ROOT / f'data/{short}-daily-source.json'
    raw = path.read_bytes()
    doc = json.loads(raw)
    assert doc['error'] == []
    bars = []
    for row in doc['result'][key]:
        t = row[0] * 1000
        if t + DAY + 60_000 > asof:
            continue
        o, h, l, c, vwap, vol = map(float, row[1:7])
        assert t % DAY == 0 and all(math.isfinite(v) for v in [o,h,l,c,vwap,vol])
        assert 0 < l <= min(o,c,vwap) <= max(o,c,vwap) <= h and vol > 0
        assert not bars or bars[-1]['openMs'] + DAY == t
        bars.append(dict(openMs=t, open=o, high=h, low=l, close=c, volume=vol))
    data[symbol] = bars
    r = rawrules['result'][key]
    rules[symbol] = dict(minQty=float(r['ordermin']), minCost=float(r['costmin']),
                         lot=10**-r['lot_decimals'], tick=float(r['tick_size']))
    sources.append(dict(symbol=symbol, file=str(path.relative_to(ROOT)),
                        sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw),
                        url=f'https://api.kraken.com/0/public/OHLC?pair={"XBTUSD" if short == "BTC" else "ETHUSD"}&interval=1440',
                        sourceRows=len(doc['result'][key]), completedBars=len(bars)))
assert [b['openMs'] for b in data['BTC/USD']] == [b['openMs'] for b in data['ETH/USD']]
end = dt.datetime.fromtimestamp((data['BTC/USD'][-1]['openMs'] + DAY)/1000, dt.timezone.utc).date().isoformat()
protocol = dict(version='parallel-native-spot-study-v1', registeredAt=now.isoformat(),
    researchOnly=True, activationAllowed=False, symbols=list(data), interval='1d',
    historyPreviouslyReused=True, futureProfitGuaranteed=False,
    periods=dict(development=['2025-01-01','2025-07-01'], validation=['2025-07-01','2026-01-01'], final=['2026-01-01',end]),
    selection='Each family: highest development stress net minus 0.5 close-liquidation drawdown; then family winner by same validation utility. Ties lexicographic. Final cannot change selection.',
    maximumVariantsPerFamily=4, families=['trend','reversion','rotation'],
    initialCapitalUsd=10000, entryBudgetUsd=1000, maximumEntryEquityFraction=0.1,
    sizing='One funded long position, entry budget includes fee. No leverage, shorts, additions or daily rebalancing. Marked exposure can drift above initial budget.',
    scenarios=dict(base=dict(feeBps=80,slippageBps=3,signalToOpenBars=2), stress=dict(feeBps=100,slippageBps=10,signalToOpenBars=3)),
    costs='Configured paper spot fee assumptions, not a claim about the actual account tier. Price costs charged adversely both sides and rounded to tick.',
    timing='Target from completed bar i available after i close plus 60s; base fill at open i+2, stress i+3. Period starts flat; only in-period signals may trade. Terminal exit at last close with costs, an explicit retrospective liquidation convention.',
    liquidity='Entry capped at 0.1% of previous completed daily volume times close. Current rules assumed historically. No historical book, fill or spread verification.',
    metrics='Net final cash after all fees and terminal exit; daily liquidation-value equity drawdown; low-price drawdown separately. No credit for unrealized final holdings.',
    baselines=['cash','buy-hold-btc','buy-hold-eth'],
    qualification=dict(positiveNetBothScenariosBothLaterPeriods=True,
                       minimumClosedTradesCombinedLaterPeriods=10, nonzeroTradesEachLaterPeriod=True,
                       maximumFinalCloseDrawdownUsd=500,
                       positiveFinalPairedBlockBootstrapLowerBoundAgainstCashAndDevelopmentSelectedBuyHold=True),
    inference='5000 circular moving 14-day bootstrap replicates, same paired indices. One-sided 95% nominal and 1-0.05/12 familywise trial-adjusted lower bounds; both descriptive due to prior history reuse and unknown earlier searches.',
    sources=sources, rules=rules,
    limitations=['720 completed days per symbol; limited regimes and rare tail evidence.',
                 'Daily candles cannot demonstrate intraday missed opportunities, immediate stop fills, available depth or order acceptance.',
                 'Long/cash only. Results cannot transfer to futures or shorting.',
                 'Chronological held-out comparison is not a new prospective experiment because earlier research reused these dates.'])
for name,obj in [('dataset.json',data),('rules.json',rules),('development.json',{s:[b for b in bs if b['openMs'] < 1751328000000] for s,bs in data.items()})]:
    (ROOT/'data'/name).write_text(json.dumps(obj,separators=(',',':'))+'\n')
protocol['datasetSha256'] = hashlib.sha256((ROOT/'data/dataset.json').read_bytes()).hexdigest()
(ROOT/'protocol.json').write_text(json.dumps(protocol,indent=2)+'\n')
print(json.dumps(dict(completedBars={s:len(v) for s,v in data.items()}, finalPeriod=protocol['periods']['final'], datasetSha256=protocol['datasetSha256'])))
