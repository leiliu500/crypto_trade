"""Independent frozen-rotation episode and split-state audit."""

import datetime as dt
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

from common import load_data
from candidate import generate


def iso(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).date().isoformat()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit_episodes(result):
    orders = result["orders"]
    assert len(orders) == 2 * len(result["trades"])
    capital = result["initialCapitalUsd"]
    cash, all_fees, all_turnover = capital, 0.0, 0.0
    episodes = []
    for index, trade in enumerate(result["trades"]):
        buy, sell = orders[2 * index : 2 * index + 2]
        assert buy["side"] == "BUY" and sell["side"] == "SELL"
        assert buy["symbol"] == sell["symbol"] == trade["symbol"]
        assert abs(buy["quantity"] - sell["quantity"]) < 1e-12
        q = buy["quantity"]
        buy_gross, sell_gross = q * buy["price"], q * sell["price"]
        basis = buy_gross + buy["feeUsd"]
        assert basis <= min(result["entryBudgetUsd"], 0.1 * cash) + 1e-6
        cash -= basis
        assert cash >= 0
        cash += sell_gross - sell["feeUsd"]
        independent_pnl = sell_gross - sell["feeUsd"] - basis
        assert abs(independent_pnl - trade["netPnlUsd"]) < 1e-8
        assert abs(buy["feeUsd"] + sell["feeUsd"] - trade["feesUsd"]) < 1e-8
        expected_lag = 2 if result["scenario"] == "base" else 3
        assert buy["timestampMs"] - buy["signalBarOpenMs"] == expected_lag * 86400000
        all_fees += buy["feeUsd"] + sell["feeUsd"]
        all_turnover += buy_gross + sell_gross
        episodes.append({
            "symbol": trade["symbol"], "entryDate": iso(trade["entryMs"]),
            "exitDate": iso(trade["exitMs"]), "netPnlUsd": independent_pnl,
            "feesUsd": trade["feesUsd"], "holdingDays": trade["holdingDays"],
            "exitReason": trade["exitReason"],
        })
    assert abs(cash - capital - result["netPnlUsd"]) < 1e-6
    assert abs(all_fees - result["feesUsd"]) < 1e-8
    assert abs(all_turnover - result["turnoverUsd"]) < 1e-6
    profits = [row["netPnlUsd"] for row in episodes if row["netPnlUsd"] > 0]
    best = max((row["netPnlUsd"] for row in episodes), default=0)
    return {
        "accountingPassed": True,
        "netPnlUsd": result["netPnlUsd"], "closedEpisodes": len(episodes),
        "strategyExitEpisodes": sum(row["exitReason"] != "terminal" for row in episodes),
        "forcedTerminalEpisodes": sum(row["exitReason"] == "terminal" for row in episodes),
        "winningEpisodes": len(profits), "bestEpisodePnlUsd": best,
        "bestEpisodeShareOfGrossPositivePnl": best / sum(profits) if profits else None,
        "bestEpisodeShareOfNetPnl": best / result["netPnlUsd"] if result["netPnlUsd"] > 0 else None,
        "pnlExcludingBestEpisodeArithmeticOnlyUsd": result["netPnlUsd"] - best,
        "turnoverUsd": all_turnover,
        "turnoverAsMultipleOfEntryBudget": all_turnover / result["entryBudgetUsd"],
        "feesUsd": all_fees, "adversePriceCostUsd": result["adversePriceCostUsd"],
        "exposedDayFraction": result["exposedDays"] / result["totalDays"],
        "episodes": episodes,
    }


def main():
    validation = json.loads((ROOT / "validation.json").read_text())["rotation"]
    final = json.loads((ROOT / "final-detail.json").read_text())["rotation"]
    sensitivity = json.loads((ROOT / "sensitivity.json").read_text())["rotation"]
    selection = json.loads((HERE / "selection.json").read_text())
    assert sha(HERE / "candidate.py") == selection["candidateSha256"]
    assert sha(HERE / "spec.md") == selection["specSha256"]
    data = load_data(False)
    targets = generate(data, selection["params"])
    split_checks = []
    for start in ("2025-07-01", "2026-01-01"):
        ms = int(dt.datetime.fromisoformat(start).replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
        index = next(i for i, bar in enumerate(data["BTC/USD"]) if bar["openMs"] == ms)
        begun = index
        while begun > 0 and targets[begun - 1] == targets[index]:
            begun -= 1
        warmup = max(selection["params"]["momentum_days"], selection["params"]["trend_days"] - 1)
        sliced = {symbol: rows[index - warmup :] for symbol, rows in data.items()}
        reset = generate(sliced, selection["params"])[warmup:]
        assert reset == targets[index:]
        split_checks.append({
            "start": start, "targetAtStart": targets[index],
            "historicalTargetBegan": iso(data["BTC/USD"][begun]["openMs"]),
            "resetIncumbentAtSplitMatchesEntireSubsequentSignalSeries": True,
            "explanation": "Retain only the exact indicator warmup needed before split; the first eligible stateful decision is at split, so incumbent begins in cash.",
        })
    report = {
        "version": "rotation-independent-final-audit-v1", "passed": True,
        "candidateId": selection["chosenId"],
        "candidateUnchangedAfterDevelopment": True,
        "validation": {s: audit_episodes(r) for s, r in validation.items()},
        "final": {s: audit_episodes(r) for s, r in final.items()},
        "splitStateChecks": split_checks,
        "zeroFeeFinalPnlUsd": next(r["netPnlUsd"] for r in sensitivity["feeOnly"] if r["scenario"]["feeBps"] == 0),
        "conclusions": [
            "Validation profit depends entirely on one July–September 2025 ETH move; both validation episodes were ETH, so that window does not demonstrate successful cross-asset rotation.",
            "Final 2026 contains three losing strategy exits and one profitable forced terminal liquidation. The latter is a conservative liquidation mark of an otherwise open signal position, not evidence of a strategy-triggered winning exit.",
            "Final 2026 still loses with zero commissions at unchanged base slippage and delay. Lower fees alone do not repair the model on this window.",
            "Stress validation earns more than base because delay changes market prices, particularly the second losing episode. The combined stress scenario is not a guaranteed lower-bound or worst-case return.",
            "Warm historical intended allocation and actual cash inventory differ conceptually. The first validation target began May 10; resetting incumbent at July 1 independently yields the identical subsequent target series. Final begins in cash and also matches a split reset, so this distinction does not change these recorded rotation results.",
        ],
        "methodologicalLimits": [
            "Twelve disclosed current variants do not capture the unknown number of prior trials on reused history; chronological splits and adjusted bootstrap are descriptive rather than independent prospective evidence.",
            "Daily bars and delayed open proxies cannot establish order-book execution quality or intraday stop behavior; historical minimums and tick rules are approximated using current metadata.",
            "The model tracks desired allocation without fill/rejection feedback; a production implementation needs durable broker-confirmed position state and reconciliation.",
            "There are only six combined later-period episodes, including one forced terminal liquidation, and only two gross-positive episodes. Long serially dependent exposures weaken inference from resampled daily PnL.",
            "Removing a best episode above is arithmetic concentration analysis, not a counterfactual resimulation; changed intervening equity could alter later sizing.",
        ],
        "sourceSha256": {name: sha(ROOT / name) for name in ("validation.json", "final-detail.json", "sensitivity.json")},
    }
    (HERE / "final-audit.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": True, "zeroFeeFinalPnlUsd": report["zeroFeeFinalPnlUsd"], "validationBaseConcentration": report["validation"]["base"]["bestEpisodeShareOfNetPnl"], "splitStateChecksPassed": True}))


if __name__ == "__main__":
    main()
