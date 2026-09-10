"""Predeclared holding permissions for a bounded BTC/ETH lifecycle study.

Configuration only: no prices, P&L evaluation, execution or runtime imports.
All bar counts refer to distinct finalized daily bars after the first entry fill.
Risk exits override these thesis-retention permissions.
"""


def holding_specs():
    """Return fresh dictionaries; callers cannot mutate a later registration."""
    return {
        'BTC/USD': [
            {'id': 'btc_hold_immediate_v1', 'minimumHoldBars': 0,
             'thesisBreakConfirmBars': 1, 'maxHoldBars': None},
            {'id': 'btc_hold_weekly_persistence_v1', 'minimumHoldBars': 7,
             'thesisBreakConfirmBars': 7, 'maxHoldBars': None},
            {'id': 'btc_hold_bounded_thesis_v1', 'minimumHoldBars': 0,
             'thesisBreakConfirmBars': 1, 'maxHoldBars': 84},
        ],
        'ETH/USD': [
            {'id': 'eth_hold_immediate_v1', 'minimumHoldBars': 0,
             'thesisBreakConfirmBars': 1, 'maxHoldBars': None},
            {'id': 'eth_hold_daily_persistence_v1', 'minimumHoldBars': 2,
             'thesisBreakConfirmBars': 2, 'maxHoldBars': None},
            {'id': 'eth_hold_bounded_thesis_v1', 'minimumHoldBars': 0,
             'thesisBreakConfirmBars': 1, 'maxHoldBars': 40},
        ],
    }
