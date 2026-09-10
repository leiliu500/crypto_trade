"""Causal sequential drift/CUSUM candidate; no account or future-data input."""

from __future__ import annotations

import math


VARIANTS = [
    {"id": "cusum_l14_h4", "half_life": 14, "entry_evidence": 4},
    {"id": "cusum_l14_h6", "half_life": 14, "entry_evidence": 6},
    {"id": "cusum_l28_h4", "half_life": 28, "entry_evidence": 4},
    {"id": "cusum_l28_h6", "half_life": 28, "entry_evidence": 6},
]


def generate(data: dict, params: dict) -> list[str | None]:
    """Return a single desired long/cash state at each completed daily close."""
    symbols = [s for s in ("BTC/USD", "ETH/USD") if s in data]
    if not symbols:
        return []
    count = len(data[symbols[0]])
    if any(len(data[s]) != count for s in symbols):
        raise ValueError("Daily symbol histories must be aligned")
    alpha = 1.0 - math.exp(-math.log(2.0) / params["half_life"])
    entry_h = float(params["entry_evidence"])
    minimum_variance = 0.005**2
    hurdle = math.log(1.022)
    states = {
        s: {"mean": 0.0, "second": minimum_variance, "up": 0.0,
            "down": 0.0, "n": 0, "previous": None}
        for s in symbols
    }
    held = None
    entry_index = None
    targets = []

    for i in range(count):
        for symbol in symbols:
            state = states[symbol]
            close = float(data[symbol][i]["close"])
            if not math.isfinite(close) or close <= 0:
                raise ValueError("Prices must be finite and positive")
            if state["previous"] is not None:
                daily_return = math.log(close / state["previous"])
                lag_variance = max(
                    minimum_variance,
                    state["second"] - state["mean"] ** 2,
                )
                standardized = max(-4.0, min(4.0, daily_return / math.sqrt(lag_variance)))
                state["up"] = max(0.0, state["up"] + standardized - 0.25)
                state["down"] = max(0.0, state["down"] - standardized - 0.25)
                state["mean"] = (1 - alpha) * state["mean"] + alpha * daily_return
                state["second"] = (1 - alpha) * state["second"] + alpha * daily_return**2
                state["n"] += 1
            state["previous"] = close

        exited = False
        if held is not None:
            state = states[held]
            if (state["down"] >= entry_h / 2
                    or state["mean"] <= 0
                    or i - entry_index >= 90):
                state["up"] = state["down"] = 0.0
                held = None
                entry_index = None
                exited = True

        if held is None and not exited:
            candidates = []
            for symbol in symbols:
                state = states[symbol]
                if (state["n"] >= 60 and state["up"] >= entry_h
                        and state["mean"] * 30 > hurdle):
                    variance = max(minimum_variance, state["second"] - state["mean"]**2)
                    score = 30 * state["mean"] / max(math.sqrt(variance * 30), 0.005)
                    candidates.append((score, symbol))
            if candidates:
                # max preserves the BTC-first input ordering on exact score ties.
                held = max(candidates, key=lambda candidate: candidate[0])[1]
                entry_index = i
                states[held]["up"] = states[held]["down"] = 0.0
        targets.append(held)

    return targets


if __name__ == "__main__":
    import hashlib
    import json
    from pathlib import Path
    import sys

    own_directory = Path(__file__).resolve().parent
    sys.path.insert(0, str(own_directory.parent))
    from common import evaluate, load_data

    development_data = load_data(development_only=True)
    trials = []
    for order, variant in enumerate(VARIANTS):
        targets = generate(development_data, variant)
        results = {
            scenario: evaluate(
                targets, development_data, start="2025-01-01", end="2025-07-01",
                scenario=scenario,
            )
            for scenario in ("base", "stress")
        }
        stress = results["stress"]
        trials.append({
            "variant": variant,
            "metrics": results,
            "selectionScoreUsd": stress["netPnlUsd"] - 0.5 * stress["maxDrawdownUsd"],
            "order": order,
        })
    selected = min(
        trials,
        key=lambda trial: (
            -trial["selectionScoreUsd"],
            trial["variant"]["id"],
        ),
    )
    report = {
        "family": "sequential_standardized_drift_cusum",
        "developmentWindow": {"startInclusive": "2025-01-01", "endExclusive": "2025-07-01"},
        "trials": trials,
        "selectedVariant": selected["variant"],
        "selectionRule": "Maximum development stress netPnlUsd minus 0.5 * maxDrawdownUsd; ties lexicographically first variant ID",
        "specificationSha256": hashlib.sha256((own_directory / "specification.md").read_bytes()).hexdigest(),
        "candidateSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "laterWindowsInspectedByCandidateAgent": False,
    }
    (own_directory / "development-results.json").write_text(json.dumps(report, indent=2) + "\n")
    (own_directory / "selection.json").write_text(json.dumps({
        "id": selected["variant"]["id"],
        "params": selected["variant"],
        "selectionScoreUsd": selected["selectionScoreUsd"],
        "selectionRule": report["selectionRule"],
        "specificationSha256": report["specificationSha256"],
        "candidateSha256": report["candidateSha256"],
        "developmentClosedTrades": selected["metrics"]["stress"]["closedTrades"],
        "laterWindowsInspectedByCandidateAgent": False,
    }, indent=2) + "\n")
    print(json.dumps({"selectedVariant": report["selectedVariant"], "trials": [
        {"id": t["variant"]["id"], "baseNetUsd": t["metrics"]["base"]["netPnlUsd"],
         "stressNetUsd": t["metrics"]["stress"]["netPnlUsd"],
         "stressDrawdownUsd": t["metrics"]["stress"]["maxDrawdownUsd"],
         "stressClosedTrades": t["metrics"]["stress"]["closedTrades"],
         "selectionScoreUsd": t["selectionScoreUsd"]} for t in trials]}, indent=2))
