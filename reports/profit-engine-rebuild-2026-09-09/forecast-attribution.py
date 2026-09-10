#!/usr/bin/env python3
"""Read-only attribution of the sealed, failed weekly ridge forecast candidate.

No model refitting, parameter search, strategy replay, or reserved 2026 outcomes.
Only 2024 and 2025 H1 observations with labels ending within their own window
enter forecast calibration. Run from any directory with Python 3.
"""
from __future__ import annotations

import collections
import hashlib
import json
import math
import statistics
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
STUDY = ROOT / "reports/profit-rebuild-2026-09-09/economic-screen-v2"
DATA = ROOT / "reports/hourly-adaptive-study-2026-09-08/data-recent/dataset.json"
HOUR, DAY, WEEK, DELAY = 3_600_000, 86_400_000, 604_800_000, 60_000
WINDOWS = [("development-2024", 1704067200000, 1735689600000),
           ("confirmation-2025-h1", 1735689600000, 1751328000000)]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def date(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()


def mean(values):
    return statistics.mean(values) if values else None


def quantile(values, fraction):
    if not values:
        return None
    values = sorted(values)
    pos = (len(values) - 1) * fraction
    i = int(pos)
    return values[i] + (values[min(i + 1, len(values) - 1)] - values[i]) * (pos - i)


def covariance(xs, ys):
    if len(xs) < 2:
        return None
    return sum((x - mean(xs)) * (y - mean(ys)) for x, y in zip(xs, ys)) / (len(xs) - 1)


def correlation(xs, ys):
    if len(xs) < 2 or statistics.variance(xs) == 0 or statistics.variance(ys) == 0:
        return None
    return covariance(xs, ys) / math.sqrt(statistics.variance(xs) * statistics.variance(ys))


def ranks(xs):
    return [sum(y < x for y in xs) + (sum(y == x for y in xs) + 1) / 2 for x in xs]


def calibration(rows):
    if not rows:
        return {"n": 0}
    xs = [r["predictedGrossBps"] for r in rows]
    ys = [r["realizedGrossBps"] for r in rows]
    signed = [r["forecastSignedRealizedGrossBps"] for r in rows]
    variance = statistics.variance(xs) if len(xs) > 1 else 0
    slope = covariance(xs, ys) / variance if variance else None
    return {
        "n": len(rows), "meanPredictionBps": mean(xs), "meanRealizedBps": mean(ys),
        "meanForecastSignedGrossBps": mean(signed),
        "medianForecastSignedGrossBps": statistics.median(signed),
        "forecastDirectionAccuracy": mean([x * y > 0 for x, y in zip(xs, ys)]),
        "positiveReturnFrequency": mean([y > 0 for y in ys]),
        "pearson": correlation(xs, ys), "spearman": correlation(ranks(xs), ranks(ys)),
        "calibrationSlope": slope,
        "calibrationInterceptBps": mean(ys) - slope * mean(xs) if slope is not None else None,
        "meanSquaredErrorBps2": mean([(x - y) ** 2 for x, y in zip(xs, ys)]),
        "zeroForecastMeanSquaredErrorBps2": mean([y ** 2 for y in ys]),
        "meanAbsoluteErrorBps": mean([abs(x - y) for x, y in zip(xs, ys)]),
        "predictionRmsBps": math.sqrt(mean([x ** 2 for x in xs])),
        "outcomeRmsBps": math.sqrt(mean([y ** 2 for y in ys])),
        "estimationIntervalContainsIndividualOutcomeFraction": mean([
            r["lowerGrossBps"] <= r["realizedGrossBps"] <= r["upperGrossBps"] for r in rows]),
        "intervalCoverageIsNotCalibrationTest": "Interval estimates conditional mean, not future individual return.",
    }


def trade_summary(trades):
    if not trades:
        return {"n": 0}
    wins = [t["netPnlUsd"] for t in trades if t["netPnlUsd"] > 0]
    losses = [t["netPnlUsd"] for t in trades if t["netPnlUsd"] < 0]
    counterfactual = sum(t["side"] * t["entryQty"] * (t["exitPx"] - t["entryPx"]) for t in trades)
    gross = sum(t["grossPnlUsd"] for t in trades)
    return {
        "n": len(trades), "grossPnlUsd": gross,
        "feeUsd": sum(t["feeUsd"] for t in trades),
        "fundingCashUsd": sum(t["fundingCashUsd"] for t in trades),
        "netPnlUsd": sum(t["netPnlUsd"] for t in trades),
        "winRate": len(wins) / len(trades), "meanWinUsd": mean(wins), "meanLossUsd": mean(losses),
        "profitFactor": sum(wins) / -sum(losses) if losses else None,
        "medianHoldHours": statistics.median((t["exitMs"] - t["entryMs"]) / HOUR for t in trades),
        "meanHoldHours": mean([(t["exitMs"] - t["entryMs"]) / HOUR for t in trades]),
        "sameEntryAndFinalExitUntrimmedGrossDiagnosticUsd": counterfactual,
        "actualMinusUntrimmedGrossUsd": gross - counterfactual,
        "untrimmedDiagnosticCaution": "Not executable: ignores risk/notional limits, larger funding and fees, and path dependence; not a strategy backtest.",
    }


def utility_score(forecast, fit, hurdle):
    means = [sum(a * b for a, b in zip(beta, forecast["features"])) * forecast["sigmaHorizon"]
             for beta in fit["bootstrapCoefficients"]]
    variance = forecast["sigmaHorizon"] ** 2 + statistics.variance(means)
    return (abs(forecast["meanGrossBps"]) - hurdle) / 10_000 / math.sqrt(variance)


def main():
    data = json.loads(DATA.read_text())
    # Filtering precedes indexing or any return calculation. Reserved data is
    # merely present in the hashed source file and is never admitted to analysis.
    bars = [b for b in data["bars"] if WINDOWS[0][1] - DAY <= b["openMs"]
            and b["openMs"] + HOUR <= WINDOWS[-1][2]]
    close = {(b["symbol"], b["openMs"] + HOUR): b["close"] for b in bars}
    forecasts = json.loads((STUDY / "forecasts.json").read_text())["forecasts"]
    models = json.loads((STUDY / "models.json").read_text())["fits"]
    models_by_id = {m["id"]: m for m in models}
    inputs = [DATA, STUDY / "forecasts.json", STUDY / "models.json", STUDY / "protocol.json"]
    report = {"kind": "POST_HOC_READ_ONLY_FORECAST_AND_INVENTORY_ATTRIBUTION",
              "generatedAt": date(int(datetime.now(timezone.utc).timestamp() * 1000)),
              "reserved2026Evaluated": False, "modelRefitted": False,
              "newTradingStrategyBacktested": False, "parameterGridSearched": False,
              "labelConvention": "Completed UTC midnight close at decision minus 60 seconds to close exactly seven days later; label end must remain within its own window.",
              "cautions": ["These periods are reused development data, not fresh holdouts.",
                           "Signal return diagnostics exclude fees, funding, execution and inventory limits; they are not portfolio P&L.",
                           "Cross-asset observations in a week are dependent; statistics are descriptive and carry no significance claim.",
                           "An in-sample sign reversal of a failed forecast is not evidence of an investable inverse signal."],
              "windows": [], "modelCoefficients": []}
    for window, start, end in WINDOWS:
        rows = []
        for f in forecasts:
            at = f["decisionMs"] - DELAY
            if not (start <= at and at + WEEK <= end):
                continue
            assert abs(close[f["symbol"], at] - f["close"]) < 1e-7
            realized = (close[f["symbol"], at + WEEK] / f["close"] - 1) * 10_000
            fit = models_by_id[f["modelId"]]
            score = utility_score(f, fit, 37)
            rows.append({"forecastId": f["id"], "symbol": f["symbol"], "decisionMs": f["decisionMs"],
                         "month": date(at)[:7], "predictedGrossBps": f["meanGrossBps"],
                         "lowerGrossBps": f["lowerGrossBps"], "upperGrossBps": f["upperGrossBps"],
                         "realizedGrossBps": realized,
                         "forecastSignedRealizedGrossBps": (1 if f["meanGrossBps"] > 0 else -1) * realized,
                         "featureFast": f["features"][1], "featureSlow": f["features"][2],
                         "interceptContributionBps": fit["coefficients"][0] * f["sigmaHorizon"] * 10_000,
                         "fastContributionBps": fit["coefficients"][1] * f["features"][1] * f["sigmaHorizon"] * 10_000,
                         "slowContributionBps": fit["coefficients"][2] * f["features"][2] * f["sigmaHorizon"] * 10_000,
                         "utilityScore": score, "baseCostHurdleEligible": score > 0})
        groups = collections.defaultdict(list)
        for r in rows:
            groups[r["decisionMs"]].append(r)
        selections = [max([r for r in group if r["baseCostHurdleEligible"]], key=lambda r: r["utilityScore"])
                      for group in groups.values() if any(r["baseCostHurdleEligible"] for r in group)]
        path = STUDY / f"{window}-base-source-plus-hour-weekly-mean-variance.json"
        inputs.append(path)
        run = json.loads(path.read_text())
        trades, orders = run["trades"], run["orders"]
        assert math.isclose(sum(o["grossPnlUsd"] for o in orders), run["grossPnlUsd"], abs_tol=1e-7)
        assert math.isclose(sum(o["feeUsd"] for o in orders), run["feeUsd"], abs_tol=1e-7)
        assert math.isclose(sum(t["netPnlUsd"] for t in trades), run["netPnlUsd"], abs_tol=1e-7)
        episode_rows = []
        for t in trades:
            own_orders = [o for o in orders if t["entryMs"] <= o["atMs"] <= t["exitMs"]
                          and o["symbol"] == t["symbol"]]
            qty = t["entryQty"]
            qtyhours = 0
            prior = t["entryMs"]
            reduction_counts = collections.Counter()
            reductions = [o for o in own_orders if o["reduceOnly"]]
            for o in reductions:
                qtyhours += qty * (o["atMs"] - prior) / HOUR
                qty -= o["qty"]
                prior = o["atMs"]
                reduction_counts[o["reason"]] += 1
            assert abs(qty) < 1e-8
            duration = (t["exitMs"] - t["entryMs"]) / HOUR
            entry = next(f for f in forecasts if f["id"] == t["forecastId"])
            label_end = entry["decisionMs"] - DELAY + WEEK
            signed_label = (t["side"] * (close[t["symbol"], label_end] / entry["close"] - 1) * 10_000
                            if label_end <= end else None)
            episode_rows.append({**t, "entryAt": date(t["entryMs"]), "exitAt": date(t["exitMs"]),
                                 "holdHours": duration, "averageQtyFractionOfEntry": qtyhours / duration / t["entryQty"],
                                 "exitQtyFractionOfEntry": reductions[-1]["qty"] / t["entryQty"],
                                 "reductionReasonCounts": dict(reduction_counts),
                                 "initialForecastMeanGrossBps": entry["meanGrossBps"],
                                 "initialForecastSevenDaySignedRealizedGrossBps": signed_label,
                                 "sameEntryAndFinalExitUntrimmedGrossDiagnosticUsd":
                                     t["side"] * t["entryQty"] * (t["exitPx"] - t["entryPx"])})
        pair_rank_hits = []
        for group in groups.values():
            assert len(group) == 2
            a, b = group
            pair_rank_hits.append((a["predictedGrossBps"] - b["predictedGrossBps"])
                                  * (a["realizedGrossBps"] - b["realizedGrossBps"]) > 0)
        reasons = {}
        for reason in sorted({o["reason"] for o in orders}):
            own = [o for o in orders if o["reason"] == reason]
            reasons[reason] = {"orders": len(own), "grossPnlUsd": sum(o["grossPnlUsd"] for o in own),
                               "feeUsd": sum(o["feeUsd"] for o in own),
                               "turnoverUsd": sum(o["qty"] * o["price"] for o in own)}
        monthly = {}
        for month in sorted({date(t["exitMs"])[:7] for t in trades}):
            monthly[month] = trade_summary([t for t in trades if date(t["exitMs"])[:7] == month])
        block = {"id": window, "startMs": start, "endMs": end,
                 "forecastCalibration": calibration(rows),
                 "forecastCalibrationByAsset": {s: calibration([r for r in rows if r["symbol"] == s])
                                                for s in ["BTC/USD", "ETH/USD"]},
                 "forecastCalibrationByPredictedSide": {side: calibration([r for r in rows if (r["predictedGrossBps"] > 0) == (side == "long")])
                                                        for side in ["long", "short"]},
                 "forecastCalibrationByMonth": {month: calibration([r for r in rows if r["month"] == month])
                                                for month in sorted({r["month"] for r in rows})},
                 "positiveUtilityEligibleCalibration": calibration([r for r in rows if r["baseCostHurdleEligible"]]),
                 "longForecastAgainstBothNegativeTrendFeatures": calibration([
                     r for r in rows if r["predictedGrossBps"] > 37 and r["featureFast"] < 0 and r["featureSlow"] < 0]),
                 "meanForecastContributionBps": {component: mean([r[component + "ContributionBps"] for r in rows])
                                                 for component in ["intercept", "fast", "slow"]},
                 "freshWeeklyBestUtilitySelectionCalibration": calibration(selections),
                 "freshSelectionInterpretation": "Raw sign-and-rank diagnostic without existing position hysteresis or stops; not a new portfolio replay.",
                 "pairedAssetReturnRankAccuracy": mean(pair_rank_hits),
                 "fastFeatureOutcomeCorrelation": correlation([r["featureFast"] for r in rows], [r["realizedGrossBps"] for r in rows]),
                 "slowFeatureOutcomeCorrelation": correlation([r["featureSlow"] for r in rows], [r["realizedGrossBps"] for r in rows]),
                 "trades": trade_summary(trades),
                 "tradesByAssetAndSide": {s + ":" + side: trade_summary([t for t in trades if t["symbol"] == s and t["side"] == direction])
                                          for s in ["BTC/USD", "ETH/USD"] for side, direction in [("long", 1), ("short", -1)]},
                 "tradesByExitReason": {reason: trade_summary([t for t in trades if t["reason"] == reason])
                                        for reason in sorted({t["reason"] for t in trades})},
                 "tradesByRealizedMonth": monthly,
                 "orderAttributionByReason": reasons,
                 "exposureNotionalHours": run["exposureNotionalHours"],
                 "meanNotionalAcrossAllCalendarHoursUsd": run["exposureNotionalHours"] / ((end - start) / HOUR),
                 "meanHeldQuantityAsFractionOfEntry": mean([t["averageQtyFractionOfEntry"] for t in episode_rows]),
                 "medianFinalExitQuantityAsFractionOfEntry": statistics.median(t["exitQtyFractionOfEntry"] for t in episode_rows),
                 "episodeDetails": episode_rows, "forecastDetails": rows,
                 "checks": {"orderGrossMatchesReport": True, "orderFeesMatchReport": True,
                            "tradeNetMatchesReport": True, "allEpisodesCloseInventory": True}}
        report["windows"].append(block)
    for fit in models:
        report["modelCoefficients"].append({"fitAt": date(fit["fitAtMs"]), "nWeeks": fit["nWeeks"],
                                            "intercept": fit["coefficients"][0], "fastCoefficient": fit["coefficients"][1],
                                            "slowCoefficient": fit["coefficients"][2]})
    report["inputs"] = [{"path": str(p.relative_to(ROOT)), "sha256": sha(p)} for p in inputs]
    report["scriptSha256"] = sha(Path(__file__))
    (OUT / "forecast-attribution.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"windows": [{k: w[k] for k in ["id", "forecastCalibration", "forecastCalibrationByAsset",
                                                      "freshWeeklyBestUtilitySelectionCalibration", "pairedAssetReturnRankAccuracy",
                                                      "fastFeatureOutcomeCorrelation", "slowFeatureOutcomeCorrelation", "trades",
                                                      "meanHeldQuantityAsFractionOfEntry", "medianFinalExitQuantityAsFractionOfEntry"]}
                                      for w in report["windows"]], "modelCoefficients": report["modelCoefficients"]}, indent=2))


if __name__ == "__main__":
    main()
