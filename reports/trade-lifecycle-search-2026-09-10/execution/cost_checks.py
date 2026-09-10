#!/usr/bin/env python3
"""Deterministic accounting examples; no market data, estimated fills, or trading."""
from decimal import Decimal, getcontext
import json
from pathlib import Path

getcontext().prec = 32
D = Decimal


def economics(entry_fee_bps, exit_fee_bps, entry_slip_bps, exit_slip_bps):
    ef, xf, es, xs = [D(str(v)) / 10000 for v in
                      (entry_fee_bps, exit_fee_bps, entry_slip_bps, exit_slip_bps)]
    ratio = (1 + ef) * (1 + es) / ((1 - xf) * (1 - xs))
    # Budget includes entry fee; reference price is normalized to 1.
    quantity = D(1000) / ((1 + ef) * (1 + es))
    flat_pnl = quantity * (1 - xs) * (1 - xf) - 1000
    one_percent_pnl = quantity * D('1.01') * (1 - xs) * (1 - xf) - 1000
    assert abs(quantity * ratio * (1 - xs) * (1 - xf) - 1000) < D('1e-25')
    return dict(entry_fee_bps=entry_fee_bps, exit_fee_bps=exit_fee_bps,
                entry_slip_bps=entry_slip_bps, exit_slip_bps=exit_slip_bps,
                reference_price_break_even_percent=float((ratio - 1) * 100),
                flat_price_pnl_per_1000_budget=float(flat_pnl),
                plus_1_percent_price_pnl_per_1000_budget=float(one_percent_pnl))


class OrderExample:
    """Illustrative evidence ledger, deliberately not a venue or fill simulator."""
    def __init__(self):
        self.cash, self.quantity, self.fees = D(1000), D(0), D(0)
        self.requested, self.status, self.reconciled = D(1), 'OPEN', False
        self.executions = {}

    def fill(self, execution_id, quantity, price, fee_bps=80):
        event = tuple(map(D, map(str, (quantity, price, fee_bps))))
        if execution_id in self.executions:
            if self.executions[execution_id] != event:
                raise ValueError('conflicting execution identity')
            return
        qty, px, fee = event
        assert qty > 0 and self.quantity + qty <= self.requested
        charge = qty * px * fee / 10000
        self.cash -= qty * px + charge
        self.quantity += qty
        self.fees += charge
        self.executions[execution_id] = event

    def can_fallback(self):
        return self.status in ('CANCELED', 'EXPIRED') and self.reconciled

    def snapshot(self):
        return dict(status=self.status, cash=str(self.cash), inventory=str(self.quantity),
                    fees=str(self.fees), remainder=str(self.requested - self.quantity),
                    reconciled=self.reconciled, fallback_allowed=self.can_fallback())


def main():
    untouched = OrderExample()
    untouched.status, untouched.reconciled = 'CANCELED', True
    assert untouched.cash == 1000 and untouched.quantity == 0
    partial = OrderExample()
    partial.fill('synthetic-exec-1', '.25', 100)
    partial.status = 'CANCEL_REQUESTED'
    waiting = partial.snapshot()
    assert not partial.can_fallback()
    # A fill observed during cancellation still changes inventory.
    partial.fill('synthetic-exec-2', '.10', 100)
    partial.status = 'CANCELED'
    before_reconciliation = partial.snapshot()
    assert not partial.can_fallback()
    partial.fill('synthetic-exec-2', '.10', 100)  # Duplicate changes nothing.
    partial.reconciled = True
    assert partial.cash == D('964.720') and partial.quantity == D('.35')
    assert partial.fees == D('.280') and partial.can_fallback()
    conflict_rejected = False
    try:
        partial.fill('synthetic-exec-2', '.11', 100)
    except ValueError:
        conflict_rejected = True
    assert conflict_rejected
    # Exact fee-only comparison for a fixed $1,000 entry budget, identical exit.
    # How much worse may the maker entry price be before its lower fee is erased?
    maximum_maker_price_ratio = (1 + D('.008')) / (1 + D('.004'))
    assert maximum_maker_price_ratio * (1 + D('.004')) == 1 + D('.008')
    examples = []
    # Arbitrary conditional payoffs, not empirical expectations or rankings.
    for p, filled_pnl in [(D('.25'), D(10)), (D('.75'), D(10)), (D('.75'), D(-10))]:
        examples.append(dict(assumed_fill_probability=float(p),
                             assumed_conditional_filled_pnl=float(filled_pnl),
                             assumed_unfilled_cash_pnl=0,
                             toy_expected_pnl=float(p * filled_pnl)))
    return dict(status='synthetic accounting checks passed; no empirical maker ranking',
                scenarios={'base_taker': economics(80, 80, 3, 3),
                           'stress_taker': economics(100, 100, 10, 10),
                           'hypothetical_maker_entry_taker_exit_same_3bp_proxy': economics(40, 80, 3, 3)},
                states={'unfilled_canceled': untouched.snapshot(),
                        'partial_cancel_requested': waiting,
                        'partial_terminal_before_reconciliation': before_reconciliation,
                        'partial_terminal_reconciled': partial.snapshot()},
                conflicting_duplicate_rejected=conflict_rejected,
                exact_fee_only_maker_entry_price_disadvantage_limit_bps=float((maximum_maker_price_ratio - 1) * 10000),
                payoff_identity='E[P&L] = p_fill * E[P&L|fill] + (1-p_fill) * E[P&L|no_fill]',
                assumed_payoff_examples=examples,
                caveats=['Synthetic executions are supplied inputs, never inferred from OHLC.',
                         'Unfilled cash P&L is zero here; missed opportunity is a separate counterfactual.',
                         'Higher fill probability alone need not improve P&L when conditional fills lose.',
                         'Fallback permission here is reconciliation only; signal, cash, quantity, quote and risk checks are also required.',
                         'Passive fee and 3bp scenarios are algebra, not maker execution estimates.'])


if __name__ == '__main__':
    result = main()
    destination = Path(__file__).with_name('cost-checks-output.json')
    destination.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
