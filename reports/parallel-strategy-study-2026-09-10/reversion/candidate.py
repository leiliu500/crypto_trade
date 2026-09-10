"""Causal OU residual-reversion research candidate; no runtime dependencies."""

import json
import hashlib
import math
from pathlib import Path


VARIANTS = [
    {"id": "balanced", "trend_span": 120, "fit_window": 60, "entry_z": 1.3,
     "max_holding_days": 30, "min_half_life": 1.5, "max_half_life": 30,
     "edge_multiple": 1.5, "trend_floor_20d": -0.05},
    {"id": "fast", "trend_span": 90, "fit_window": 45, "entry_z": 1.15,
     "max_holding_days": 21, "min_half_life": 1.5, "max_half_life": 20,
     "edge_multiple": 1.35, "trend_floor_20d": -0.05},
    {"id": "patient", "trend_span": 150, "fit_window": 90, "entry_z": 1.5,
     "max_holding_days": 42, "min_half_life": 1.5, "max_half_life": 35,
     "edge_multiple": 1.75, "trend_floor_20d": -0.05},
    {"id": "rising_trend", "trend_span": 120, "fit_window": 60, "entry_z": 1.3,
     "max_holding_days": 30, "min_half_life": 1.5, "max_half_life": 30,
     "edge_multiple": 1.5, "trend_floor_20d": 0.0},
]


def _features(bars, p):
    alpha = 2.0 / (p["trend_span"] + 1.0)
    ema = []
    residual = []
    features = []
    warmup = max(p["trend_span"], p["fit_window"] + 1, 21)
    window = p["fit_window"]
    for i, bar in enumerate(bars):
        log_close = math.log(float(bar["close"]))
        ema.append(log_close if i == 0 else alpha * log_close + (1 - alpha) * ema[-1])
        residual.append(log_close - ema[-1])
        if i + 1 < warmup:
            features.append({"valid": False, "reason": "warmup"})
            continue
        xs = residual[i - window:i]
        ys = residual[i - window + 1:i + 1]
        mean_x = sum(xs) / window
        mean_y = sum(ys) / window
        variance_x = sum((x - mean_x) ** 2 for x in xs)
        if variance_x <= 1e-16:
            features.append({"valid": False, "reason": "degenerate_fit"})
            continue
        phi = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / variance_x
        intercept = mean_y - phi * mean_x
        if not 0.2 < phi < 0.98:
            features.append({"valid": False, "reason": "nonstationary_fit"})
            continue
        half_life = -math.log(2) / math.log(phi)
        if not p["min_half_life"] <= half_life <= p["max_half_life"]:
            features.append({"valid": False, "reason": "half_life"})
            continue
        innovation_variance = sum((y - intercept - phi * x) ** 2 for x, y in zip(xs, ys)) / (window - 2)
        if innovation_variance <= 1e-16:
            features.append({"valid": False, "reason": "degenerate_innovation"})
            continue
        scale = math.sqrt(innovation_variance / (1 - phi ** 2))
        equilibrium = intercept / (1 - phi)
        z = (residual[i] - equilibrium) / scale
        trend_change = ema[i] - ema[i - 20]
        if trend_change < p["trend_floor_20d"]:
            features.append({"valid": False, "reason": "falling_trend"})
            continue
        forecast = ((equilibrium - residual[i]) * (1 - phi ** p["max_holding_days"])
                    + min(0, trend_change / 20) * p["max_holding_days"])
        hurdle = p["edge_multiple"] * (math.log(1.01 / 0.99) + math.log(1.001 / 0.999))
        features.append({"valid": True, "phi": phi, "halfLife": half_life, "scale": scale,
                         "z": z, "forecast": forecast, "hurdle": hurdle,
                         "eligible": z <= -p["entry_z"] and forecast >= hurdle})
    return features


def _generate_with_diagnostics(data, params):
    symbols = sorted(data)
    if not symbols:
        return [], {"entries": 0, "exits": 0}
    n = len(data[symbols[0]])
    if any(len(data[s]) != n for s in symbols):
        raise ValueError("Aligned bar arrays required")
    features = {s: _features(data[s], params) for s in symbols}
    current = None
    entry_index = None
    entry_close = None
    entry_scale = None
    targets = []
    events = []
    reasons = {}
    for i in range(n):
        if current is not None:
            f = features[current][i]
            close = float(data[current][i]["close"])
            stop_distance = max(0.04, 2.5 * entry_scale)
            reason = None
            if not f["valid"]:
                reason = "model_invalid:" + f["reason"]
            elif f["z"] >= -0.1:
                reason = "reversion_completed"
            elif i - entry_index >= params["max_holding_days"]:
                reason = "maximum_holding_period"
            elif math.log(close / entry_close) <= -stop_distance:
                reason = "close_based_volatility_stop"
            if reason:
                events.append({"index": i, "openMs": data[current][i]["openMs"],
                               "symbol": current, "type": "exit_signal", "reason": reason})
                current = None
            targets.append(current)
            continue
        choices = []
        for symbol in symbols:
            f = features[symbol][i]
            if not f["valid"]:
                reasons[f["reason"]] = reasons.get(f["reason"], 0) + 1
            elif f["eligible"]:
                choices.append((f["forecast"] / f["scale"], symbol))
            else:
                reasons["insufficient_excursion_or_edge"] = reasons.get("insufficient_excursion_or_edge", 0) + 1
        if choices:
            _, current = sorted(choices, key=lambda pair: (-pair[0], pair[1]))[0]
            entry_index = i
            entry_close = float(data[current][i]["close"])
            entry_scale = features[current][i]["scale"]
            f = features[current][i]
            events.append({"index": i, "openMs": data[current][i]["openMs"], "symbol": current,
                           "type": "entry_signal", "z": f["z"], "forecast": f["forecast"],
                           "hurdle": f["hurdle"], "halfLife": f["halfLife"]})
        targets.append(current)
    return targets, {"events": events, "rejectionCountsWhenFlat": reasons,
                     "entries": sum(e["type"] == "entry_signal" for e in events),
                     "exits": sum(e["type"] == "exit_signal" for e in events)}


def generate(data, params):
    return _generate_with_diagnostics(data, params)[0]


if __name__ == "__main__":
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from common import load_data, evaluate
    data = load_data(development_only=True)
    rows = []
    for params in VARIANTS:
        targets, diagnostics = _generate_with_diagnostics(data, params)
        base = evaluate(targets, data, start="2025-01-01", end="2025-07-01", scenario="base")
        stress = evaluate(targets, data, start="2025-01-01", end="2025-07-01", scenario="stress")
        score = stress["netPnlUsd"] - 0.5 * stress["maxDrawdownUsd"]
        rows.append({"variant": params, "base": base, "stress": stress,
                     "developmentScore": score, "diagnostics": diagnostics})
    selected = sorted(rows, key=lambda row: (-row["developmentScore"], row["variant"]["id"]))[0]
    result = {"candidate": "causal_ou_residual_reversion", "period": ["2025-01-01", "2025-07-01"],
              "selectedVariant": selected["variant"], "selectionScore": selected["developmentScore"],
              "trialCount": len(rows), "allVariants": rows}
    output = Path(__file__).resolve().parent / "development-results.json"
    output.write_text(json.dumps(result, indent=2) + "\n")
    selection = {"family": "reversion", "id": selected["variant"]["id"],
                 "params": selected["variant"], "developmentUtility": selected["developmentScore"],
                 "specSha256": hashlib.sha256((output.parent / "spec.json").read_bytes()).hexdigest(),
                 "moduleSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                 "trialCount": len(rows), "selectedUsing": "development stress net PnL minus half maximum dollar drawdown; lexicographic tie break",
                 "period": ["2025-01-01", "2025-07-01"],
                 "laterOutcomesInspected": False}
    (output.parent / "selection.json").write_text(json.dumps(selection, indent=2) + "\n")
    print(json.dumps({"output": str(output), "selected": selected["variant"]["id"],
                      "rows": [{"id": r["variant"]["id"], "base": r["base"], "stress": r["stress"],
                                "score": r["developmentScore"]} for r in rows]}, indent=2))
