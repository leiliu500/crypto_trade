"""Execution-cost algebra and synthetic accounting audit; no candidate outcomes or runtime imports."""
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import math
import sys
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
COMMON = ROOT / 'reports/parallel-strategy-study-2026-09-10/common.py'


def hurdle(entry_fee_bps, exit_fee_bps, entry_slip_bps, exit_slip_bps):
    fe, fx, se, sx = [x / 10000 for x in (entry_fee_bps, exit_fee_bps, entry_slip_bps, exit_slip_bps)]
    factor = (1 + fe) * (1 + se) / ((1 - fx) * (1 - sx))
    flat_retention = 1 / factor
    return dict(entryFeeBps=entry_fee_bps, exitFeeBps=exit_fee_bps,
                entrySlippageBps=entry_slip_bps, exitSlippageBps=exit_slip_bps,
                breakEvenReferencePriceReturnPct=100 * (factor - 1),
                breakEvenReferencePriceReturnBps=10000 * (factor - 1),
                flatRoundTripLossPer1000BudgetUsd=1000 * (1 - flat_retention),
                flatRoundTripLossOn10000AccountPct=10 * (1 - flat_retention),
                netUsdFor1000BudgetAtGrossMovePct={str(move): 1000 * ((1 + move / 100) * flat_retention - 1)
                                                for move in (0, .1, .5, 1, 2, 3)},
                note='Analytical before adverse tick/lot rounding, missed fills, spread beyond assumed slippage, and other costs.')


def main():
    original = COMMON.read_bytes()
    spec = importlib.util.spec_from_file_location('frozen_common_execution_audit', COMMON)
    common = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(common)
    start = common.timestamp('2025-01-01')
    bars = [dict(openMs=start + i * common.DAY, open=1000., high=1000., low=1000., close=1000., volume=1_000_000.) for i in range(8)]
    data = {symbol: copy.deepcopy(bars) for symbol in common.SYMBOLS}
    targets = ['ETH/USD'] * len(bars)
    checks = []
    synthetic = {}
    for scenario, lag in [('base', 2), ('stress', 3)]:
        result = common.evaluate(targets, data, start='2025-01-01', end='2025-01-09', scenario=scenario, details=True)
        assert result['orders'][0]['timestampMs'] == start + lag * common.DAY
        assert len(result['orders']) == 2 and result['orders'][-1]['reason'] == 'terminal'
        assert result['closedTrades'] == 1 and sum(t['exitReason'] != 'terminal' for t in result['trades']) == 0
        assert result['netPnlUsd'] < 0
        cash = 10000.
        for order in result['orders']:
            gross = order['quantity'] * order['price']
            cash += -gross - order['feeUsd'] if order['side'] == 'BUY' else gross - order['feeUsd']
        assert math.isclose(cash - 10000, result['netPnlUsd'], abs_tol=1e-8)
        assert math.isclose(sum(row['pnlUsd'] for row in result['daily']), result['netPnlUsd'], abs_tol=1e-8)
        assert result['orders'][0]['quantity'] * result['orders'][0]['price'] + result['orders'][0]['feeUsd'] <= 1000 + 1e-8
        checks += [f'{scenario}: causal first fill at lag {lag}', f'{scenario}: flat-price costs lose money',
                   f'{scenario}: funded fee-inclusive cap and independent ledger reconcile',
                   f'{scenario}: terminal trade is not a natural completed episode']
        synthetic[scenario] = {'netPnlUsd': result['netPnlUsd'], 'feeUsd': result['feesUsd'],
                               'orders': result['orders'], 'naturalEpisodes': 0}
    lag_data = copy.deepcopy(data)
    lag_data['ETH/USD'][1]['volume'] = 0  # i-1 is not finalized at first base execution open i=2.
    unchanged = common.evaluate(targets, lag_data, start='2025-01-01', end='2025-01-09', scenario='base', details=True)
    assert unchanged['orders'][0] == synthetic['base']['orders'][0]
    checks.append('Unfinalized i-1 volume does not change the first base entry')
    exit_data = copy.deepcopy(data)
    exit_data['ETH/USD'][3]['volume'] = 0
    exit_result = common.evaluate(['ETH/USD'] + [None] * 7, exit_data, start='2025-01-01', end='2025-01-09', scenario='base', details=True)
    assert exit_result['orders'][1]['side'] == 'SELL' and exit_result['orders'][1]['timestampMs'] == start + 3 * common.DAY
    checks.append('Documented limitation reproduced: full exit assumed even when execution-day volume is zero')
    assert COMMON.read_bytes() == original
    settings = {'base_taker': (80, 80, 3, 3), 'stress_taker': (100, 100, 10, 10),
                'maker_both_hypothetical': (40, 40, 3, 3), 'maker_entry_taker_exit_hypothetical': (40, 80, 3, 3)}
    result = {'version': 'asset-execution-audit-v1', 'researchOnly': True, 'candidateOutcomesScored': False,
              'commonSha256': hashlib.sha256(original).hexdigest(),
              'verifiedAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(),
              'formula': 'P_exit_reference/P_entry_reference >= (1+entry_fee)*(1+entry_slip)/((1-exit_fee)*(1-exit_slip))',
              'feeSource': {'url': 'https://www.kraken.com/features/fee-schedule', 'verifiedDate': '2026-09-10',
                            'publicSpotTier1MakerBps': 40, 'publicSpotTier1TakerBps': 80, 'actualAccountTier': 'unknown'},
              'costScenarios': {name: hurdle(*values) for name, values in settings.items()},
              'syntheticChecksPassed': len(checks), 'checks': checks, 'syntheticFlatPriceResults': synthetic,
              'cautions': ['Maker scenarios are algebra only: no queue, fill-probability, or adverse-selection evidence.',
                           'No candidate P&L or reused historical strategy outcome was read or computed in this audit.']}
    (HERE / 'audit.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'checksPassed': len(checks), 'costScenarios': result['costScenarios']}, indent=2))


if __name__ == '__main__':
    main()
