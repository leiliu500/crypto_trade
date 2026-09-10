#!/usr/bin/env python3
"""Attribute the already rejected hourly v1. No strategy search or new backtest.

Run from the repository root:
  python3 reports/profit-rebuild-2026-09-09/attribution.py
Only recorded 2024 and 2025 H1 trades and candles preceding their signals enter
the calculations. No reserved 2026 period is evaluated.
"""
from __future__ import annotations

import bisect
import collections
import hashlib
import json
import statistics
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
INPUT_DIR = ROOT / "reports/systematic-rebuild-2026-09-09/economic-screen"
DATA = ROOT / "reports/hourly-adaptive-study-2026-09-08/data-recent/dataset.json"
HOUR = 3_600_000
START = 1704067200000  # 2024-01-01
END = 1751328000000  # 2025-07-01


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def quantile(values, fraction):
    values = sorted(values)
    if not values:
        return None
    pos = (len(values) - 1) * fraction
    lo = int(pos)
    return values[lo] + (values[min(lo + 1, len(values) - 1)] - values[lo]) * (pos - lo)


def summary(trades):
    wins = [t["netPnlUsd"] for t in trades if t["netPnlUsd"] > 0]
    losses = [t["netPnlUsd"] for t in trades if t["netPnlUsd"] < 0]
    holds = [(t["exitMs"] - t["entryMs"]) / HOUR for t in trades]
    entry_notional = sum(t["qty"] * t["entryPx"] for t in trades)
    gross = sum(t["grossPnlUsd"] for t in trades)
    net = sum(t["netPnlUsd"] for t in trades)
    fees = sum(t["feeUsd"] for t in trades)
    funding = sum(t["fundingCashUsd"] for t in trades)
    avg_win = statistics.mean(wins) if wins else 0
    avg_loss = -statistics.mean(losses) if losses else 0
    return {
        "trades": len(trades), "grossPnlUsd": gross, "feesUsd": fees,
        "fundingCashUsd": funding, "netPnlUsd": net,
        "grossPnlIncludesModeledAdverseExecution": True,
        "entryNotionalUsd": entry_notional,
        "turnoverUsd": sum(t["turnoverUsd"] for t in trades),
        "meanEntryNotionalUsd": entry_notional / len(trades),
        "meanNetPnlUsd": net / len(trades),
        "winRate": len(wins) / len(trades), "averageWinUsd": avg_win,
        "averageLossUsd": avg_loss,
        "realizedPayoffRatio": avg_win / avg_loss if avg_loss else None,
        "payoffImpliedBreakevenWinRate": avg_loss / (avg_win + avg_loss) if avg_win + avg_loss else None,
        "profitFactor": sum(wins) / -sum(losses) if losses else None,
        "meanHoldHours": statistics.mean(holds), "medianHoldHours": statistics.median(holds),
        "holdP25Hours": quantile(holds, .25), "holdP75Hours": quantile(holds, .75),
        "holdsUnder16Hours": sum(h < 16 for h in holds),
        "holdsUnder32Hours": sum(h < 32 for h in holds),
        "holdsUnder64Hours": sum(h < 64 for h in holds),
        "grossBpsPerEntryNotional": gross / entry_notional * 10_000,
        "netBpsPerEntryNotional": net / entry_notional * 10_000,
        "feeBpsPerEntryNotional": fees / entry_notional * 10_000,
        "fundingBpsPerEntryNotional": funding / entry_notional * 10_000,
    }


def grouped(trades, key):
    groups = collections.defaultdict(list)
    for trade in trades:
        groups[key(trade)].append(trade)
    return {key: summary(value) for key, value in sorted(groups.items())}


def duration_bucket(trade):
    h = (trade["exitMs"] - trade["entryMs"]) / HOUR
    for limit in [4, 8, 16, 32, 64]:
        if h < limit:
            return {4: "00-04h", 8: "04-08h", 16: "08-16h", 32: "16-32h", 64: "32-64h"}[limit]
    return "64-72h"


def date_month(timestamp):
    return datetime.fromtimestamp(timestamp / 1000, timezone.utc).strftime("%Y-%m")


dataset = json.loads(DATA.read_text())
# Deliberately discard all candles from July 2025 onward before calculation.
bars = collections.defaultdict(list)
for bar in dataset["bars"]:
    if START - 200 * HOUR <= bar["openMs"] < END:
        bars[bar["symbol"]].append(bar)
del dataset
for own in bars.values():
    own.sort(key=lambda bar: bar["openMs"])
times = {symbol: [bar["openMs"] for bar in own] for symbol, own in bars.items()}

sources = {str(DATA.relative_to(ROOT)): sha(DATA), str(Path(__file__).relative_to(ROOT)): sha(Path(__file__))}
results = {}
for window in ["development-2024", "development-2025-h1"]:
    path = INPUT_DIR / f"{window}-base-source-plus-hour.json"
    sources[str(path.relative_to(ROOT))] = sha(path)
    replay = json.loads(path.read_text())
    trades = replay["trades"]
    assert replay["startMs"] >= START and replay["endMs"] <= END
    assert all(START <= t["entryMs"] < END and t["exitMs"] <= END for t in trades)
    for t in trades:
        assert abs(t["grossPnlUsd"] - t["feeUsd"] + t["fundingCashUsd"] - t["netPnlUsd"]) < 1e-8
        own = bars[t["symbol"]]
        stop = bisect.bisect_right(times[t["symbol"]], t["signalCloseMs"] - HOUR)
        used = own[max(0, stop - 192):stop]
        assert len(used) == 192 and used[-1]["openMs"] + HOUR == t["signalCloseMs"]
        assert all(b["openMs"] - a["openMs"] == HOUR for a, b in zip(used, used[1:]))
        atr = sum(max(used[i]["high"] - used[i]["low"], abs(used[i]["high"] - used[i - 1]["close"]),
                      abs(used[i]["low"] - used[i - 1]["close"])) for i in range(160, 192)) / 32
        t["signalAtrBps"] = atr / used[-1]["close"] * 10_000
        t["signalStopBps"] = 2 * t["signalAtrBps"]
        entry_bar_index = bisect.bisect_left(times[t["symbol"]], t["entryMs"])
        entry_raw = own[entry_bar_index]["open"]
        assert own[entry_bar_index]["openMs"] == t["entryMs"]
        t["entryPriceExecutionCostUsd"] = t["qty"] * t["side"] * (t["entryPx"] - entry_raw)
        assert t["entryPriceExecutionCostUsd"] >= -1e-8
    total = summary(trades)
    for source_key, target_key in [("grossPnlUsd", "grossPnlUsd"), ("feeUsd", "feesUsd"),
                                   ("fundingCashUsd", "fundingCashUsd"), ("netPnlUsd", "netPnlUsd")]:
        assert abs(total[target_key] - replay[source_key]) < 1e-6
    total["meanSignalAtrBps"] = statistics.mean(t["signalAtrBps"] for t in trades)
    total["medianSignalAtrBps"] = statistics.median(t["signalAtrBps"] for t in trades)
    total["medianSignalStopBps"] = statistics.median(t["signalStopBps"] for t in trades)
    total["entryExecutionCostAlreadyInGrossUsd"] = sum(t["entryPriceExecutionCostUsd"] for t in trades)
    total["feesShareOfAbsoluteNetLoss"] = total["feesUsd"] / abs(total["netPnlUsd"])
    total["grossLossShareOfAbsoluteNetLoss"] = -total["grossPnlUsd"] / abs(total["netPnlUsd"])
    total["fundingLossShareOfAbsoluteNetLoss"] = -total["fundingCashUsd"] / abs(total["netPnlUsd"])
    prior = {}
    rapid_reentries = []
    for trade in sorted(trades, key=lambda t: t["entryMs"]):
        previous = prior.get(trade["symbol"])
        if previous and trade["side"] == previous["side"]:
            gap = (trade["entryMs"] - previous["exitMs"]) / HOUR
            if 0 <= gap <= 24:
                rapid_reentries.append({"symbol": trade["symbol"], "side": trade["side"],
                    "gapHours": gap, "previousReason": previous["reason"]})
        prior[trade["symbol"]] = trade
    total["sameSymbolSameSideReentriesWithin24Hours"] = len(rapid_reentries)
    total["sameSymbolSameSideReentriesWithin24HoursAfterStop"] = sum(t["previousReason"] == "SYSTEMATIC_STOP" for t in rapid_reentries)
    results[window] = {
        "total": total,
        "bySymbol": grouped(trades, lambda t: t["symbol"]),
        "bySide": grouped(trades, lambda t: "LONG" if t["side"] == 1 else "SHORT"),
        "bySymbolAndSide": grouped(trades, lambda t: t["symbol"] + (" LONG" if t["side"] == 1 else " SHORT")),
        "byExitReason": grouped(trades, lambda t: t["reason"]),
        "byHoldingTime": grouped(trades, duration_bucket),
        "byRealizationMonth": grouped(trades, lambda t: date_month(t["exitMs"])),
        "ambiguousBars": replay["ambiguousBars"], "blockReasons": replay["blockReasons"],
    }

report = {
    "purpose": "Descriptive attribution of previously rejected hourly v1; no candidate search or new performance evaluation.",
    "dataBoundary": "Only 2024 and 2025 H1 recorded trades and their preceding signal candles. Reserved Jan-Jul 2026 untouched.",
    "sourceSha256": sources, "results": results,
    "limitations": [
        "Gross P&L is signed fill-price movement after modeled adverse execution. It is not frictionless directional alpha.",
        "Explicit fees and funding are exact decompositions of this replay. Exit execution cost cannot be separately recovered from trade rows alone.",
        "Funding timestamps are unverified; this attribution consistently uses the recorded source-plus-hour interpretation.",
        "Candle chronology and liquidity are synthetic execution assumptions, not observed order-book fills.",
        "Calendar groups allocate a completed trade to exit month; these differ from the replay's daily marked-to-market P&L.",
        "Subgroups, holding times and reentry counts are descriptive and post hoc; they do not establish causal effects or justify selection rules.",
        "2024 and 2025 H1 have been inspected repeatedly and cannot support an untouched out-of-sample claim.",
    ],
}
(OUT / "attribution.json").write_text(json.dumps(report, indent=2) + "\n")

money = lambda v: f"{v:,.2f}"
pct = lambda v: f"{100*v:.1f}%"
lines = ["# Rejected hourly v1: loss attribution", "",
    "This report explains recorded losses; it does not establish a profitable replacement. "
    "The input is the already rejected 2024 and 2025 H1 base replay, consistently using the source-plus-hour funding interpretation. "
    "No parameter search or new strategy performance run was performed, and reserved January–July 2026 was not evaluated.", "",
    "| Measure | 2024 | 2025 H1 |", "|---|---:|---:|"]
a, b = [results[w]["total"] for w in results]
for label, key, fmt in [
    ("Trades", "trades", str), ("Gross price P&L after modeled execution ($)", "grossPnlUsd", money),
    ("Explicit fees ($)", "feesUsd", money), ("Funding cash ($)", "fundingCashUsd", money),
    ("Net P&L ($)", "netPnlUsd", money), ("Win rate", "winRate", pct),
    ("Average win ($)", "averageWinUsd", money), ("Average loss magnitude ($)", "averageLossUsd", money),
    ("Payoff-implied break-even win rate", "payoffImpliedBreakevenWinRate", pct),
    ("Profit factor", "profitFactor", money), ("Median hold (hours)", "medianHoldHours", money),
    ("Median signal ATR (bps)", "medianSignalAtrBps", money), ("Median initial stop (bps)", "medianSignalStopBps", money),
    ("Turnover ($)", "turnoverUsd", money), ("Net bps / entry notional", "netBpsPerEntryNotional", money),
    ("Same-side same-symbol reentries within 24h", "sameSymbolSameSideReentriesWithin24Hours", str),
    ("Of those, after a hard stop", "sameSymbolSameSideReentriesWithin24HoursAfterStop", str),
]:
    lines.append(f"| {label} | {fmt(a[key])} | {fmt(b[key])} |")
lines += ["", "## What the recorded losses establish", "",
    f"Explicit fees account for {pct(a['feesShareOfAbsoluteNetLoss'])} / {pct(b['feesShareOfAbsoluteNetLoss'])} "
    f"of the loss, negative price P&L for {pct(a['grossLossShareOfAbsoluteNetLoss'])} / {pct(b['grossLossShareOfAbsoluteNetLoss'])}, "
    f"and funding for {pct(a['fundingLossShareOfAbsoluteNetLoss'])} / {pct(b['fundingLossShareOfAbsoluteNetLoss'])}. "
    "Removing explicit fees would still leave both periods negative under the modeled fill prices. "
    "Increasing the capital cap scales exposure to a negative observed expectancy; it does not repair it.", "",
    "The nominal target is twice the initial stop, but realized winners average less than realized losers. "
    "Most winning trades exit through the trail rather than the target. A stated target/stop ratio is not the realized payoff ratio "
    "and cannot be inserted into an expected-value formula as though every winner reaches its target.", "",
    f"The EMA spans are 16 and 64 hours, while {a['holdsUnder16Hours']}/{a['trades']} and "
    f"{b['holdsUnder16Hours']}/{b['trades']} trades finish within 16 hours. "
    "ATR is an average of one-hour true ranges, even though its estimator averages 32 observations. "
    "A 2×ATR stop and trail remain scaled to one-hour movement, not a 32-hour or 64-hour risk horizon. "
    "The holding-time mismatch and repeated same-side reentry are consistent with churn, but post hoc attribution cannot prove that wider stops would improve returns.", "",
    "Both symbols and both long/short sides lose in both windows. There is no supported fix here that simply drops one losing asset or direction.", "",
    "## Design changes justified for a new falsifiable test", "",
    "1. Align the signal, rebalance cadence and exit horizon. Use volatility measured at the intended holding horizon; "
    "do not interpret a 32-observation hourly ATR as 32-hour volatility. A diffusion approximation gives sigma(H) ≈ sigma(1h)√H, "
    "but crypto clustering and tails require empirical checks and explicit stress bounds.",
    "2. Treat a persistent directional state as one exposure episode. Rebalance only when the target exposure changes enough "
    "to justify round-trip costs; add hysteresis between entry and exit thresholds. Do not close and repurchase unchanged exposure "
    "solely because a new hourly signal ID exists.",
    "3. Evaluate price return, execution costs, explicit fees and funding separately, and optimize no parameter on this attribution. "
    "Use observed realized payoff distributions and net returns; ATR or geometric price room is not an expected-return forecast.",
    "4. Freeze a small economically motivated replacement family before evaluating it, assess stressed net returns and drawdown, "
    "and reserve genuinely uninspected chronological data for final confirmation. A better development result alone does not authorize a profit claim.", "",
    "## Descriptive breakdowns", ""]
for window, result in results.items():
    lines += [f"### {window}", ""]
    for title, key in [("Asset and direction", "bySymbolAndSide"), ("Exit reason", "byExitReason"),
                       ("Holding time", "byHoldingTime"), ("Realization month", "byRealizationMonth")]:
        lines += [f"{title}:", "", "| Group | Trades | Gross ($) | Fees ($) | Funding ($) | Net ($) | Median hold (h) |",
                  "|---|---:|---:|---:|---:|---:|---:|"]
        for group, v in result[key].items():
            lines.append(f"| {group} | {v['trades']} | {money(v['grossPnlUsd'])} | {money(v['feesUsd'])} | "
                         f"{money(v['fundingCashUsd'])} | {money(v['netPnlUsd'])} | {money(v['medianHoldHours'])} |")
        lines.append("")
lines += ["## Reproduction and limits", "", "Run `python3 reports/profit-rebuild-2026-09-09/attribution.py` from the repository root. "
          "The script reconciles trade accounting to the saved replay totals, reconstructs ATR from only the 192 preceding completed bars, "
          "and records SHA-256 input and script hashes in `attribution.json`.", ""]
lines += [f"- {item}" for item in report["limitations"]]
(OUT / "attribution.md").write_text("\n".join(lines) + "\n")
print(json.dumps({window: result["total"] for window, result in results.items()}, indent=2))
