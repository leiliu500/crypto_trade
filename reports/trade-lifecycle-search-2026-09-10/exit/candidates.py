"""Three fixed exit hypotheses per asset, registered before lifecycle scoring.

Price barriers are finalized-close decisions, never assumed intrabar fills.
All volatility multiples use the entry-frozen mean true range.
"""


def exit_specs():
    """Return fresh dictionaries so a caller cannot mutate the registered priors."""
    result = {}
    for symbol, prefix in (("BTC/USD", "btc"), ("ETH/USD", "eth")):
        result[symbol] = [
            dict(id=f"{prefix}_thesis_only", atrLookback=20,
                 stopAtrMultiple=None, trailingAtrMultiple=None,
                 profitAtrMultiple=None),
            dict(id=f"{prefix}_volatility_trailing", atrLookback=20,
                 stopAtrMultiple=3., trailingAtrMultiple=4.,
                 profitAtrMultiple=None),
            dict(id=f"{prefix}_asymmetric_bracket", atrLookback=20,
                 stopAtrMultiple=2., trailingAtrMultiple=None,
                 profitAtrMultiple=4.),
        ]
    return result
