"""Read-only attribution of existing reports; no strategy, trades, or 2026 returns."""
import datetime
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
sources = [Path("reports/carry-feasibility-reviewed-2026-09-09/report.json"),
           Path("reports/carry-fee-frontier-2026-09-09/frontier.json"),
           Path("reports/carry-funding-model-development-2026-09-09/report.json"),
           Path("reports/hourly-adaptive-study-2026-09-08/data-recent/dataset.json")]
feasibility, frontier, historical, dataset = [json.loads(p.read_text()) for p in sources]
rows = []
for symbol in ["BTC/USD", "ETH/USD"]:
    for year, last_month in [(2024, 12), (2025, 6)]:
        cohorts = [r for r in historical["cohorts"]
                   if r["symbol"] == symbol and r["year"] == year and r["month"] <= last_month]
        start_ms = int(datetime.datetime(year, 1, 1, tzinfo=datetime.timezone.utc).timestamp() * 1000)
        reference_price = next(b["open"] for b in dataset["bars"] if b["symbol"] == symbol and b["openMs"] == start_ms)
        complete = len(cohorts) == last_month and all(r["targetStatus"] == "KNOWN" for r in cohorts)
        cash = sum(r["actualUsdPerBase"] for r in cohorts) if complete else None
        rows.append({"symbol": symbol, "year": year, "months": last_month, "fundingCoverageComplete": complete,
                     "fundingCashUsdPerOneBaseShort": cash,
                     "startingPerpetualTradeOpenReferenceUsd": reference_price,
                     "fundingDividedByStartingPerpetualReference": cash / reference_price if cash is not None else None,
                     "negativeFundingMonths": [r["month"] for r in cohorts if r["actualUsdPerBase"] < 0],
                     "completeStrategyPnlUsd": None})
report = {"version": "carry-horizon-source-audit-v1", "scope": "EXISTING_REPORT_AGGREGATION_NOT_NEW_STRATEGY_PERFORMANCE",
          "priorConfiguration": feasibility["configuration"],
          "priorCaptureUtc": feasibility["capturedAtUtc"],
          "datedMaturityDays": sorted(set(r["maturityDays"] for r in feasibility["rows"] if r["maturityDays"] is not None)),
          "priorFeeFrontierCounts": [{"spotTakerFeeBpsPerExecutedSide": s["spotTakerFeeBpsPerExecutedSide"],
                                       "counts": s["counts"]} for s in frontier["scenarios"]],
          "historicalFundingOnly": rows, "activationAllowed": False, "validatedProfitability": False,
          "sourceSha256": [{"path": str(p), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in sources],
          "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
with (root / "audit.json").open("x") as stream:
    stream.write(json.dumps(report, indent=2) + "\n")
print(json.dumps({"output": str(root / "audit.json"), "fundingOnly": rows}, indent=2))
