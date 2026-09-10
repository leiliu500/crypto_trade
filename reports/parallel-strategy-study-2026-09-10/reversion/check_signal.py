"""Deterministic implementation checks, without historical performance data."""
import hashlib
import json
import math
import random
from pathlib import Path

from candidate import VARIANTS, generate, _generate_with_diagnostics


root = Path(__file__).resolve().parent
rng = random.Random(41)
data = {}
for symbol in ["BTC/USD", "ETH/USD"]:
    rows = []
    residual = 0.0
    for i in range(500):
        residual = 0.82 * residual + rng.gauss(0, 0.05)
        close = math.exp(8 + 0.0004 * i + residual)
        rows.append(dict(openMs=i * 86400000, open=close, high=close,
                         low=close, close=close, volume=1))
    data[symbol] = rows

results = []
for params in VARIANTS:
    full = generate(data, params)
    assert len(full) == 500
    assert set(full) <= {"BTC/USD", "ETH/USD", None}
    for cutoff in [120, 175, 250, 375, 499]:
        assert generate({s: r[:cutoff] for s, r in data.items()}, params) == full[:cutoff]
    flat = {s: [dict(row, open=100, high=100, low=100, close=100) for row in bars]
            for s, bars in data.items()}
    assert generate(flat, params) == [None] * 500
    _, diagnostics = _generate_with_diagnostics(data, params)
    assert diagnostics["entries"] > 0 and diagnostics["exits"] > 0
    results.append(dict(id=params["id"], passed=True, syntheticEntries=diagnostics["entries"],
                        syntheticExits=diagnostics["exits"], prefixChecks=5,
                        flatSeriesProducesNoFalseSignals=True))

report = dict(passed=True, syntheticOnly=True,
              moduleSha256=hashlib.sha256((root / "candidate.py").read_bytes()).hexdigest(),
              variants=results)
(root / "synthetic-checks.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
