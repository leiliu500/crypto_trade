"""Bounded independent audit; raw source + Decimal, without common.evaluate."""
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR
import datetime as dt
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DAY = 86400000
D = lambda value: Decimal(str(value))
read = lambda name: json.loads((ROOT / name).read_text())
sha = lambda name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()

lock, comparison = read('final-selection-lock.json'), read('comparison.json')
detail, protocol = read('final-detail.json'), read('protocol.json')
raw = {}
for symbol, file, key in [('BTC/USD', 'BTC-daily-source.json', 'XXBTZUSD'),
                           ('ETH/USD', 'ETH-daily-source.json', 'XETHZUSD')]:
    source = read('data/' + file)
    assert source['error'] == []
    raw[symbol] = {int(row[0])*1000: row for row in source['result'][key]}

checks = []
assert lock['commonSha256'] == sha('common.py')
assert lock['protocolSha256'] == sha('protocol.json')
for family, item in lock['selections'].items():
    assert item['candidateSha256'] == sha(family + '/candidate.py')
    assert item['selectionSha256'] == sha(family + '/selection.json')
    recorded = read(family + '/selection.json')
    assert item['params'] == recorded['params']
checks.append('Common, protocol, all three model and development selection hashes match the prefinal lock')
ranked = sorted(comparison['validation'], key=lambda family: (
    -comparison['validation'][family]['stress']['selectionUtility'], family))
assert ranked == lock['validationRanking']
assert ranked[0] == lock['selectedFamily'] == comparison['selectedBeforeFinal'] == 'rotation'
checks.append('Frozen family ranking exactly matches validation stress utility, never final utility')

money = {}
rules = read('data/rules.json')
for scenario, result in detail['trend'].items():
    settings = protocol['scenarios'][scenario]
    fee, slip = D(settings['feeBps']) / 10000, D(settings['slippageBps']) / 10000
    cash, inventory, total_fees = D(10000), {}, D(0)
    verified_orders = []
    for order in result['orders']:
        symbol = order['symbol']
        terminal = order.get('reason') == 'terminal'
        stamp = order['timestampMs'] - (DAY if terminal else 0)
        row = raw[symbol][stamp]
        ref = D(row[4] if terminal else row[1])
        sign = 1 if order['side'] == 'BUY' else -1
        tick = D(rules[symbol]['tick'])
        px = ((ref * (1 + sign * slip) / tick).to_integral_value(
            rounding=ROUND_CEILING if sign == 1 else ROUND_FLOOR) * tick)
        assert abs(px - D(order['price'])) < D('0.00000001')
        qty = D(order['quantity'])
        if sign == 1:
            liquidity = raw[symbol][stamp - 2*DAY]
            spend = min(D(1000), cash * D('.1'), cash, D(liquidity[6])*D(liquidity[4])*D('.001'))
            lot = D(rules[symbol]['lot'])
            expected_qty = (spend / (px * (1+fee)) / lot).to_integral_value(rounding=ROUND_FLOOR)*lot
            assert abs(qty - expected_qty) < D('0.000000000001')
            assert stamp-order['signalBarOpenMs'] == settings['signalToOpenBars']*DAY
        cost = qty * px * fee
        assert abs(cost-D(order['feeUsd'])) < D('0.00000001')
        cash -= sign*qty*px + cost
        inventory[symbol] = inventory.get(symbol, D(0)) + sign*qty
        total_fees += cost
        verified_orders.append(dict(side=order['side'], symbol=symbol, price=float(px),
                                    sourceReference=float(ref), terminal=terminal))
    assert all(abs(qty) < D('0.000000000001') for qty in inventory.values())
    assert abs(cash-10000-D(result['netPnlUsd'])) < D('0.00000001')
    assert abs(total_fees-D(result['feesUsd'])) < D('0.00000001')
    assert abs(sum(D(row['pnlUsd']) for row in result['daily'])-D(result['netPnlUsd'])) < D('0.00000001')
    money[scenario] = dict(independentNetPnlUsd=float(cash-10000), independentFeesUsd=float(total_fees),
                           verifiedOrders=verified_orders,
                           strategyTriggeredExits=sum(trade['exitReason'] != 'terminal' for trade in result['trades']),
                           terminalClosures=sum(trade['exitReason'] == 'terminal' for trade in result['trades']))
checks.append('Trend order prices, lot sizing, delayed signal timestamp, fees, flat inventory and cash reconcile to raw Kraken rows using Decimal')

for family, qualifier in comparison['qualification'].items():
    assert not qualifier['passed']
    assert not qualifier['checks']['positiveFinalBaseAndStress']
    assert not qualifier['checks']['minimumTenLaterClosedTrades']
    assert not qualifier['checks']['positiveAdjustedPairedLowerBounds']
    for scenario in ('base', 'stress'):
        assert comparison['final'][family][scenario]['netPnlUsd'] < 0
    for baseline, estimate in comparison['confidence'][family].items():
        own = detail[family]['base']['daily']; reference = detail[baseline]['base']['daily']
        assert [row['date'] for row in own] == [row['date'] for row in reference]
        excess = sum(D(a['pnlUsd'])-D(b['pnlUsd']) for a, b in zip(own, reference))
        assert abs(excess-D(estimate['excessNetUsd'])) < D('0.00000001')
        assert estimate['twelveTrialAdjustedLowerNetUsd'] <= estimate['nominalOneSided95LowerNetUsd'] < 0
checks.append('Every model is negative in both final scenarios; qualification failures and paired excess-P&L totals are consistent')

audit = dict(passed=True, scope='Selection code/lock and qualification review, plus independent raw-source trend cash audit',
    criticalFindings=[], checks=checks, independentTrendMoney=money,
    codeReview=dict(validationSignalsReceiveOnlyPre2026Bars=True,
                    developmentWinnersRecomputedBeforeValidation=True,
                    finalCannotChangeFrozenSelection=True,
                    bootstrapPairedCircular14DayBlocks=True,
                    bootstrapAdjustmentDescriptiveDueToReusedHistory=True,
                    noClaimOfCalibratedProspectiveConfidence=True),
    reportingCautions=[
        'The prefinal selected model is rotation; trend has the smallest final loss only retrospectively and cannot replace it as a validated winner.',
        'Trend has zero strategy-triggered exits in the final window; its one reported closed episode is a forced terminal liquidation.',
        'The 12-trial bootstrap adjustment does not account for unknown earlier studies, and sparse trades plus nonstationarity limit statistical interpretation.',
        'finalEvaluated=false in final-selection-lock.json describes the immutable prefinal snapshot, not the current completion state.'
    ], fingerprints={name:sha(name) for name in ['compare.py','final-selection-lock.json','comparison.json','final-detail.json','sensitivity.json']})
(ROOT/'trend/final-audit.json').write_text(json.dumps(audit, indent=2)+'\n')
print(json.dumps(dict(passed=True, criticalFindings=[], independentTrendMoney=money), indent=2))
