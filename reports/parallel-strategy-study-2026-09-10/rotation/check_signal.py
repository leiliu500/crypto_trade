"""Synthetic signal behavior and causal-prefix verification; no market data."""

import json
import math
from pathlib import Path

from candidate import VARIANTS, generate


def series(rate, length=220):
    return [{"openMs": i * 86400000, "close": 100 * math.exp(rate * i)} for i in range(length)]


def main():
    checks = []
    for params in VARIANTS:
        data = {"BTC/USD": series(.002), "ETH/USD": series(.001)}
        targets = generate(data, params)
        ready = max(params["momentum_days"], params["trend_days"] - 1)
        assert len(targets) == 220
        assert targets[:ready] == [None] * ready
        assert all(value == "BTC/USD" for value in targets[ready:])
        checks.append({"variant": params["id"], "check": "warmup_and_relative_strength", "passed": True})

        for cut in (50, 90, 100, 130, 219):
            assert generate({s: rows[:cut] for s, rows in data.items()}, params) == targets[:cut]
        checks.append({"variant": params["id"], "check": "prefix_invariance", "passed": True})

        weak = {"BTC/USD": series(.0005), "ETH/USD": series(.0004)}
        assert all(value is None for value in generate(weak, params))
        checks.append({"variant": params["id"], "check": "positive_momentum_below_cost_hurdle_stays_cash", "passed": True})

        bearish = {"BTC/USD": series(-.002), "ETH/USD": series(-.001)}
        assert all(value is None for value in generate(bearish, params))
        checks.append({"variant": params["id"], "check": "bearish_market_stays_cash", "passed": True})

        reversal = {"BTC/USD": series(.002), "ETH/USD": series(-.001)}
        for bar in reversal["BTC/USD"][180:]:
            bar["close"] = 80.0
        reversed_targets = generate(reversal, params)
        assert reversed_targets[179] == "BTC/USD"
        assert reversed_targets[180] is None
        checks.append({"variant": params["id"], "check": "trend_failure_exits_to_cash", "passed": True})

    report = {"passed": True, "checkCount": len(checks), "checks": checks}
    Path(__file__).with_name("synthetic-checks.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": True, "checkCount": len(checks)}))


if __name__ == "__main__":
    main()
