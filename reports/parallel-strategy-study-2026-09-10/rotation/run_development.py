"""Run only the registered development comparison and freeze its selection."""

import datetime as dt
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from common import evaluate, load_data
from candidate import VARIANTS, generate


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(name, value):
    (HERE / name).write_text(json.dumps(value, indent=2) + "\n")


def main():
    registration = {
        "registeredAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "specSha256": digest(HERE / "spec.md"),
        "candidateSha256": digest(HERE / "candidate.py"),
        "commonSha256": digest(HERE.parent / "common.py"),
        "variants": VARIANTS,
        "selectionRule": "Maximum development stress netPnlUsd minus 0.5*maxDrawdownUsd; ties use registered variant order",
        "developmentStart": "2025-01-01",
        "developmentEndExclusive": "2025-07-01",
        "developmentOnly": True,
    }
    write_json("registration.json", registration)
    data = load_data(development_only=True)
    end_ms = int(dt.datetime(2025, 7, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)
    assert all(bar["openMs"] < end_ms for bars in data.values() for bar in bars)
    results = []
    for params in VARIANTS:
        targets = generate(data, params)
        scores = {
            scenario: evaluate(targets, data, start="2025-01-01", end="2025-07-01", scenario=scenario)
            for scenario in ("base", "stress")
        }
        results.append({"id": params["id"], "params": params, "results": scores})
    chosen = max(results, key=lambda item: item["results"]["stress"]["selectionUtility"])
    selection = {
        **registration,
        "chosenId": chosen["id"],
        "params": chosen["params"],
        "developmentStressSelectionUtility": chosen["results"]["stress"]["selectionUtility"],
        "developmentBaseNetPnlUsd": chosen["results"]["base"]["netPnlUsd"],
        "developmentStressNetPnlUsd": chosen["results"]["stress"]["netPnlUsd"],
        "developmentStressClosedTrades": chosen["results"]["stress"]["closedTrades"],
        "developmentStressPositive": chosen["results"]["stress"]["netPnlUsd"] > 0,
        "noFutureEvaluationOrReselection": True,
    }
    write_json("development-results.json", {"registration": registration, "variants": results})
    write_json("selection.json", selection)
    for row in results:
        b, s = row["results"]["base"], row["results"]["stress"]
        print(f"{row['id']}: base ${b['netPnlUsd']:.2f}; stress ${s['netPnlUsd']:.2f}; stress DD ${s['maxDrawdownUsd']:.2f}; stress trades {s['closedTrades']}; utility {s['selectionUtility']:.2f}")
    print("Selected: " + chosen["id"])


if __name__ == "__main__":
    main()
