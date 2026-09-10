"""Registered causal cost-aware BTC/ETH momentum rotation signals.

This module reads no files and performs no execution or account mutation.
"""

from math import isfinite, log


VARIANTS = [
    {"id": "rotation_m60_t60", "momentum_days": 60, "trend_days": 60},
    {"id": "rotation_m60_t90", "momentum_days": 60, "trend_days": 90},
    {"id": "rotation_m90_t60", "momentum_days": 90, "trend_days": 60},
    {"id": "rotation_m90_t90", "momentum_days": 90, "trend_days": 90},
]

SYMBOLS = ("BTC/USD", "ETH/USD")
HURDLE = 1.5 * 2.0 * (0.008 + 0.0003)


def generate(data, params):
    """Return one desired long symbol or cash after each completed daily bar."""
    lookback = int(params["momentum_days"])
    trend_days = int(params["trend_days"])
    if lookback <= 0 or trend_days <= 0:
        raise ValueError("Lookbacks must be positive")
    n = len(data[SYMBOLS[0]])
    if any(len(data[symbol]) != n for symbol in SYMBOLS):
        raise ValueError("Daily series must be aligned and equal length")
    closes = {
        symbol: [float(bar["close"]) for bar in data[symbol]]
        for symbol in SYMBOLS
    }
    if any(
        not isfinite(value) or value <= 0
        for values in closes.values()
        for value in values
    ):
        raise ValueError("Daily close must be finite and positive")

    targets = []
    incumbent = None
    first_ready = max(lookback, trend_days - 1)
    for index in range(n):
        if index < first_ready:
            targets.append(None)
            continue

        scores = {}
        eligible = []
        retained = {}
        for symbol in SYMBOLS:
            series = closes[symbol]
            close = series[index]
            momentum = log(close / series[index - lookback])
            trend = sum(series[index - trend_days + 1 : index + 1]) / trend_days
            score = (30.0 / lookback) * momentum
            scores[symbol] = score
            if close > 1.005 * trend and score > HURDLE:
                eligible.append(symbol)
            retained[symbol] = close >= 0.995 * trend and momentum > 0.0

        # Python's stable max selects BTC first when forecast scores tie.
        contender = max(eligible, key=lambda symbol: scores[symbol]) if eligible else None
        if incumbent is None or not retained[incumbent]:
            incumbent = contender
        elif (
            contender is not None
            and contender != incumbent
            and scores[contender] - scores[incumbent] > HURDLE
        ):
            incumbent = contender
        targets.append(incumbent)

    return targets
