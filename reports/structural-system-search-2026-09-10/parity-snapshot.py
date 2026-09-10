#!/usr/bin/env python3
"""Bounded public-data parity observation; no credentials or order capability."""
import argparse
import concurrent.futures
import datetime as dt
import decimal
import email.utils
import hashlib
import json
import math
import re
from pathlib import Path
import time
import urllib.error
import urllib.request

D = decimal.Decimal
ROOT = Path(__file__).resolve().parent
ENDPOINTS = [
    ("Kraken", "BTC/USD", "https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=1", "XXBTZUSD"),
    ("Coinbase", "BTC/USD", "https://api.exchange.coinbase.com/products/BTC-USD/book?level=1", None),
    ("Kraken", "ETH/USD", "https://api.kraken.com/0/public/Depth?pair=ETHUSD&count=1", "XETHZUSD"),
    ("Coinbase", "ETH/USD", "https://api.exchange.coinbase.com/products/ETH-USD/book?level=1", None),
]
PROTOCOL = {
    "version": "bounded-funded-parity-observation-v1",
    "observations": 3,
    "targetStartOffsetsSeconds": [0, 4, 8],
    "perRequestTimeoutSeconds": 1.75,
    "maximumResponseBytes": 200000,
    "receiptSkewDiagnosticLimitMs": 1000,
    "requestDurationDiagnosticLimitMs": 2000,
    "coinbaseBookAgeDiagnosticLimitMs": 2000,
    "futureTimestampToleranceMs": 1000,
    "feeAssumption": "ACCOUNT_FEES_UNKNOWN;PRIMARY_RESULT_IS_MAXIMUM_ALL_IN_COST_BUDGET",
    "positionModel": "BUY_WITH_CASH_AT_ONE_VENUE_AND_SELL_ALREADY_OWNED_INVENTORY_AT_THE_OTHER;NO_BORROWING",
    "atomicExecution": False,
    "quoteSynchronizationProven": False,
}


def utc(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).isoformat()


def iso_ms(value):
    # Python 3.9 rejects Coinbase's nine fractional digits; retain the raw
    # timestamp and parse seconds/fraction separately instead of rounding time.
    match = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z", value)
    if not match:
        raise ValueError("INVALID_UTC_BOOK_TIMESTAMP")
    seconds = dt.datetime.fromisoformat(match[1]+"+00:00").timestamp()
    fraction = D("0."+(match[2] or "0"))
    return float(D(str(seconds))*1000 + fraction*1000)


def positive(value):
    x = D(str(value))
    if not x.is_finite() or x <= 0:
        raise ValueError("NONPOSITIVE_OR_NONFINITE_BOOK_VALUE")
    return str(x)


def normalized_book(venue, payload, key):
    if venue == "Kraken":
        if payload.get("error") != [] or set(payload.get("result", {})) != {key}:
            raise ValueError("KRAKEN_RESPONSE_ERROR_OR_PAIR_MISMATCH")
        book = payload["result"][key]
    else:
        book = payload
        if book.get("auction_mode") is True:
            raise ValueError("COINBASE_INDICATIVE_AUCTION_BOOK")
    bid, ask = book["bids"][0], book["asks"][0]
    normalized = {"bid": positive(bid[0]), "bidQuantity": positive(bid[1]),
                  "ask": positive(ask[0]), "askQuantity": positive(ask[1]),
                  "snapshotTimestampMs": None, "levelLastChangeMs": None,
                  "sequence": book.get("sequence"), "auctionMode": book.get("auction_mode"),
                  "rawSnapshotTimestamp": book.get("time")}
    if D(normalized["bid"]) >= D(normalized["ask"]):
        raise ValueError("CROSSED_OR_LOCKED_SINGLE_VENUE_BOOK")
    if venue == "Kraken":
        normalized["levelLastChangeMs"] = {"bid": float(bid[2])*1000, "ask": float(ask[2])*1000}
        normalized["timestampInterpretation"] = "LEVEL_LAST_CHANGE_IS_NOT_SNAPSHOT_CREATION_OR_HEARTBEAT;SNAPSHOT_AGE_UNKNOWN"
    else:
        normalized["snapshotTimestampMs"] = iso_ms(book["time"]) if book.get("time") else None
        normalized["timestampInterpretation"] = "API_BOOK_TIME_IF_SUPPLIED;AGE_IS_RELATIVE_TO_UNVERIFIED_LOCAL_CLOCK"
    return normalized


def attach_ages(row):
    if row["book"]:
        stamp = row["book"]["snapshotTimestampMs"]
        row["book"]["apparentSnapshotAgeMs"] = None if stamp is None else row["responseReceivedMs"]-stamp
        levels = row["book"]["levelLastChangeMs"]
        row["book"]["levelLastChangeApparentAgeMs"] = None if levels is None else {k: row["responseReceivedMs"]-v for k, v in levels.items()}


def fetch(endpoint):
    venue, symbol, url, key = endpoint
    start_ms = time.time_ns() / 1e6
    start_mono = time.monotonic_ns()
    row = {"venue": venue, "symbol": symbol, "url": url,
           "requestStartedMs": start_ms, "requestStartedUtc": utc(start_ms),
           "httpStatus": None, "rawBody": None, "bodySha256": None,
           "book": None, "error": None}
    headers = {}
    try:
        request = urllib.request.Request(url, headers={
            "User-Agent": "bounded-public-parity-research/1.0",
            "Accept": "application/json", "Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=PROTOCOL["perRequestTimeoutSeconds"]) as response:
            row["httpStatus"] = response.status
            headers = {k.lower(): v for k, v in response.headers.items()
                       if k.lower() in {"date", "age", "cache-control", "cf-cache-status", "content-type", "etag"}}
            body = response.read(PROTOCOL["maximumResponseBytes"] + 1)
        row["bodySha256"] = hashlib.sha256(body).hexdigest()
        if len(body) > PROTOCOL["maximumResponseBytes"]:
            raise ValueError("RESPONSE_SIZE_LIMIT")
        row["rawBody"] = body.decode("utf-8")
        payload = json.loads(row["rawBody"])
        row["book"] = normalized_book(venue, payload, key)
    except urllib.error.HTTPError as exc:
        row["httpStatus"] = exc.code
        row["error"] = type(exc).__name__ + ": " + str(exc)
        raw = exc.read(PROTOCOL["maximumResponseBytes"])
        row["rawBody"] = raw.decode("utf-8", errors="replace")
        row["bodySha256"] = hashlib.sha256(raw).hexdigest()
    except Exception as exc:
        row["error"] = type(exc).__name__ + ": " + str(exc)
    received_ms = time.time_ns() / 1e6
    row.update(responseReceivedMs=received_ms, responseReceivedUtc=utc(received_ms),
               requestDurationMs=(time.monotonic_ns() - start_mono) / 1e6,
               selectedResponseHeaders=headers, httpDateMs=None, httpDateApparentAgeMs=None)
    if headers.get("date"):
        try:
            row["httpDateMs"] = email.utils.parsedate_to_datetime(headers["date"]).timestamp() * 1000
            row["httpDateApparentAgeMs"] = received_ms - row["httpDateMs"]
        except Exception:
            row["httpDateParseError"] = True
    attach_ages(row)
    return row


def comparisons(observation):
    result = []
    quotes = {(x["venue"], x["symbol"]): x for x in observation["responses"]}
    for symbol in ("BTC/USD", "ETH/USD"):
        for buy_venue, sell_venue in (("Kraken", "Coinbase"), ("Coinbase", "Kraken")):
            buy, sell = quotes[(buy_venue, symbol)], quotes[(sell_venue, symbol)]
            row = {"symbol": symbol, "buyVenue": buy_venue, "sellVenue": sell_venue,
                   "status": "UNKNOWN_MISSING_OR_INVALID_BOOK", "grossSpreadUsdPerBase": None,
                   "maximumAllInCostBudgetBpsOfBuyNotional": None, "equalPerSideFeeBreakEvenBps": None,
                   "actualFeesVerified": False, "netProfitAfterActualCostsUsd": None,
                   "executableOpportunityVerified": False, "quoteSynchronizationProven": False}
            if not buy["book"] or not sell["book"]:
                row["failureReasons"] = [x["venue"]+": "+str(x["error"]) for x in (buy, sell) if not x["book"]]
                result.append(row)
                continue
            ask, bid = D(buy["book"]["ask"]), D(sell["book"]["bid"])
            quantity = min(D(buy["book"]["askQuantity"]), D(sell["book"]["bidQuantity"]))
            receipt_skew = abs(buy["responseReceivedMs"] - sell["responseReceivedMs"])
            issues = []
            if receipt_skew > PROTOCOL["receiptSkewDiagnosticLimitMs"]:
                issues.append("RECEIPT_SKEW_LIMIT")
            for response in (buy, sell):
                if response["requestDurationMs"] > PROTOCOL["requestDurationDiagnosticLimitMs"]:
                    issues.append(response["venue"]+"_SLOW_RESPONSE")
                age = response["book"]["apparentSnapshotAgeMs"]
                if age is not None and not -PROTOCOL["futureTimestampToleranceMs"] <= age <= PROTOCOL["coinbaseBookAgeDiagnosticLimitMs"]:
                    issues.append(response["venue"]+"_SNAPSHOT_TIME_OUTSIDE_DIAGNOSTIC_LIMIT")
            row.update(status="DISPLAYED_GROSS_COMPARISON_ONLY", buyAsk=str(ask), sellBid=str(bid),
                       grossSpreadUsdPerBase=str(bid-ask),
                       maximumAllInCostBudgetBpsOfBuyNotional=str((bid/ask-1)*10000),
                       equalPerSideFeeBreakEvenBps=str((bid-ask)/(bid+ask)*10000),
                       sumEqualFeeRatesBreakEvenBps=str(2*(bid-ask)/(bid+ask)*10000),
                       topLevelQuantityUpperBound=str(quantity), grossSurplusAtTopLevelQuantityUsd=str(quantity*(bid-ask)),
                       buyerCashRequiredBeforeFeesUsd=str(quantity*ask), sellerOwnedBaseRequired=str(quantity),
                       positiveGrossSpread=bid>ask, receiptSkewMs=receipt_skew,
                       requestStartSkewMs=abs(buy["requestStartedMs"]-sell["requestStartedMs"]),
                       timingDiagnosticIssues=issues, allVenueSnapshotAgesKnown=False,
                       timestampInterpretation="RECEIPT_SKEW_AND_COINBASE_BOOK_TIME_ONLY;KRAKEN_SNAPSHOT_CREATION_UNKNOWN")
            result.append(row)
    return result


def build_report(data):
    rows = [r for o in data["observations"] for r in o["comparisons"]]
    known = [r for r in rows if r["grossSpreadUsdPerBase"] is not None]
    positives = [r for r in known if r["positiveGrossSpread"]]
    failures = [x for o in data["observations"] for x in o["responses"] if x["error"]]
    scenario = []
    for r in known:
        ratio = D(r["sellBid"])/D(r["buyAsk"])
        net = ratio - 1 - (D("0.008") if r["buyVenue"] == "Kraken" else ratio*D("0.008"))
        scenario.append(net*10000)
    data["summary"] = {"requestedDirections": len(rows), "availableDisplayedComparisons": len(known),
                       "positiveDisplayedGrossComparisons": len(positives), "failedRequests": len(failures),
                       "actualNetProfitKnown": False, "executableOpportunitiesVerified": 0,
                       "bestDisplayedCostBudgetBps": None if not known else str(max(D(r["maximumAllInCostBudgetBpsOfBuyNotional"]) for r in known)),
                       "diagnosticFeeScenario": {"source": "https://www.kraken.com/features/fee-schedule",
                           "interpretation": "PUBLIC_KRAKEN_ENTRY_TIER_TAKER_80BP;HYPOTHETICAL_COINBASE_ZERO_FEE;NOT_ACCOUNT_ENTITLEMENT;NO_OTHER_COSTS",
                           "chosenAfterObservingQuotes": True, "purpose": "COST_SCALE_DIAGNOSTIC_NOT_SELECTED_STRATEGY_OR_VALIDATION",
                           "bestNetBpsOfBuyNotional": None if not scenario else str(max(scenario)),
                           "positiveComparisons": sum(x>0 for x in scenario)}}
    return data


def markdown(data):
    s = data["summary"]
    if s["availableDisplayedComparisons"] == 0:
        lead = "Both-venue comparisons are unavailable; request failures are retained and no missing quote is treated as zero."
    elif s["positiveDisplayedGrossComparisons"] == 0:
        lead = "None of the available crossed-venue displayed comparisons had positive gross surplus, even before fees."
    else:
        lead = "Some displayed cross-venue prices show positive gross surplus; synchronized execution and positive net profit remain unverified."
    lines = [lead, "", "This is one contemporaneous EC02 feasibility observation: three requested rounds at 0, 4 and 8 seconds, covering BTC/USD and ETH/USD at Kraken and Coinbase Exchange in both buy/sell directions. It is not a backtest, a completed arbitrage trade, evidence of a lasting edge, or thousands of new systems.", "",
             f"Capture: {data['startedAtUtc']} to {data['completedAtUtc']}; elapsed {data['elapsedSeconds']:.3f} seconds. Available displayed comparisons: {s['availableDisplayedComparisons']}/12; request failures after offline parsing correction: {s['failedRequests']}; positive gross comparisons: {s['positiveDisplayedGrossComparisons']}.", "",
             "| Round | Asset | Buy → sell | Gross USD/base | Maximum all-in cost budget, bp of buy notional | Receipt skew, ms |", "|---|---|---|---:|---:|---:|"]
    for o in data["observations"]:
        for r in o["comparisons"]:
            if r["grossSpreadUsdPerBase"] is None:
                cells = ["unknown", "unknown", "unknown"]
            else:
                cells = [f"{D(r['grossSpreadUsdPerBase']):.5f}", f"{D(r['maximumAllInCostBudgetBpsOfBuyNotional']):.5f}", f"{r['receiptSkewMs']:.1f}"]
            lines.append(f"| {o['round']} | {r['symbol']} | {r['buyVenue']} → {r['sellVenue']} | {' | '.join(cells)} |")
    lines += ["", "The cost budget is `(sell bid / buy ask − 1) × 10,000`. It is the maximum combined fees, slippage, inventory recycling and other costs, expressed against buy notional. For actual fractional fee rates, nonnegative surplus requires `buyFee + (sellBid/buyAsk)×sellFee + otherCost/buyNotional ≤ sellBid/buyAsk − 1`. The JSON also retains the exact break-even equal fee per side, `(sellBid−buyAsk)/(sellBid+buyAsk)`. Negative budgets cannot support any nonnegative cost scenario at those displayed prices.", "",
              "No account fee is assumed, no rebate entitlement is inferred, and actual net profit is **unknown**. The model buys with pre-funded cash at one venue and sells already-owned base inventory at the other. Top-level quantity is only a displayed upper bound: venue lots/minimums, wallet balances, order acceptance, atomic fills and subsequent inventory relocation were not established.", "",
              "Requests within each round ran concurrently. Local completion timestamps were recorded after reading and parsing each response, so they bound body receipt from above and include parsing time. Starts, monotonic durations, selected HTTP cache/date headers, source bodies and hashes are retained. Coinbase's returned book time is compared with the unverified local clock. Kraken's per-level timestamps indicate last changes, not snapshot creation or a continuous heartbeat, so Kraken snapshot age remains unknown. HTTP Date has coarse precision and is not a matching-engine quote timestamp. Small local completion skew does not establish simultaneous books or prevent either quote changing before an order arrives.", "",
              "Predeclared diagnostic limits were 1,000 ms receipt skew, 2,000 ms response duration, and Coinbase apparent book age from −1,000 to +2,000 ms. Diagnostic issues remain in each JSON comparison; they never authorize a trade. REST caching and unknown clock offsets can make apparent crosses misleading.", ""]
    if s["bestDisplayedCostBudgetBps"] is not None:
        lines += [f"The best displayed cost budget was **{D(s['bestDisplayedCostBudgetBps']):.5f} basis points**. A separate scale diagnostic charges the published Kraken entry-tier taker fee of 80 bp on its leg while hypothetically charging zero on Coinbase and ignoring other costs. {s['diagnosticFeeScenario']['positiveComparisons']} of {s['availableDisplayedComparisons']} comparisons are positive under that scenario; the best is {D(s['diagnosticFeeScenario']['bestNetBpsOfBuyNotional']):.5f} bp. This fee scenario was added after observing the quotes to show cost scale; it is neither account-specific pricing nor an independently selected strategy. [Kraken fee schedule](https://www.kraken.com/features/fee-schedule).", ""]
    if data.get("offlineReanalysis"):
        lines += ["The initial sandbox attempt failed DNS resolution and is preserved inside the JSON. The subsequent authorized public capture returned HTTP 200 for all twelve responses. Python 3.9 initially rejected Coinbase's nanosecond timestamps; [the original failed analysis](parity-snapshot-unparsed.json) and every raw response are retained. The timestamp correction and all final comparisons were computed offline from the same sample, with no additional market requests.", ""]
    ages = [x["book"]["apparentSnapshotAgeMs"] for o in data["observations"] for x in o["responses"] if x["book"] and x["book"]["apparentSnapshotAgeMs"] is not None]
    if ages:
        age_issues = [f"round {o['round']} {x['symbol']}" for o in data["observations"] for x in o["responses"]
                      if x["book"] and x["book"]["apparentSnapshotAgeMs"] is not None
                      and not -PROTOCOL["futureTimestampToleranceMs"] <= x["book"]["apparentSnapshotAgeMs"] <= PROTOCOL["coinbaseBookAgeDiagnosticLimitMs"]]
        cached = any(x["selectedResponseHeaders"].get("cf-cache-status") == "HIT" for o in data["observations"] for x in o["responses"])
        lines += [f"Coinbase apparent book ages ranged from {min(ages):.1f} to {max(ages):.1f} ms. Out-of-limit book timestamps: {', '.join(age_issues) or 'none'}. Cached responses observed: {cached}. No comparison is represented as synchronized executable arbitrage.", ""]
    for o in data["observations"]:
        for x in o["responses"]:
            if x["error"]:
                lines.append(f"- Round {o['round']}, {x['venue']} {x['symbol']}: {x['error']}")
    lines += ["", "Sources: [Kraken L2 order book](https://docs.kraken.com/api-reference/market-data/get-order-book), [Coinbase product book](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-book). Coinbase L1 sizes are aggregate quantities and were not multiplied by order counts; indicative auction books are rejected.", "",
              "[Raw evidence and calculations](parity-snapshot.json), [reproducible collector and analyzer](parity-snapshot.py). `python3 parity-snapshot.py --verify` recomputes saved comparisons offline. `--capture` fetches a new bounded sample and refuses to overwrite an existing report. No authenticated request, order, borrowing, transfer or deployment is available in this script.", ""]
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture", action="store_true")
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--retry-network-failures", action="store_true")
    parser.add_argument("--reanalyze", action="store_true")
    parser.add_argument("--output-dir", type=Path, default=ROOT)
    args = parser.parse_args()
    destination = args.output_dir / "parity-snapshot.json"
    if args.reanalyze:
        data = json.loads(destination.read_text())
        backup = destination.with_name("parity-snapshot-unparsed.json")
        if not backup.exists():
            backup.write_bytes(destination.read_bytes())
        else:
            assert data["offlineReanalysis"]["originalAnalysisSha256"] == hashlib.sha256(backup.read_bytes()).hexdigest()
        keys = {(venue, symbol): key for venue, symbol, _, key in ENDPOINTS}
        for o in data["observations"]:
            for row in o["responses"]:
                if row["httpStatus"] != 200 or row["rawBody"] is None:
                    continue
                assert hashlib.sha256(row["rawBody"].encode()).hexdigest() == row["bodySha256"]
                row.setdefault("originalParseError", row["error"])
                row["receiptTimingSemantics"] = "LOCAL_COMPLETION_AFTER_BODY_READ_AND_PARSE;UPPER_BOUND_ON_BODY_RECEIPT"
                try:
                    row["book"] = normalized_book(row["venue"], json.loads(row["rawBody"]), keys[(row["venue"], row["symbol"])])
                    row["error"] = None
                    attach_ages(row)
                except Exception as exc:
                    row["book"] = None
                    row["error"] = type(exc).__name__+": "+str(exc)
            o["comparisons"] = comparisons(o)
        data["offlineReanalysis"] = {"reason": "Parse Coinbase nanosecond UTC timestamps on Python3.9", "newNetworkRequests": 0,
                                      "originalAnalysis": backup.name, "originalAnalysisSha256": hashlib.sha256(backup.read_bytes()).hexdigest(),
                                      "analyzerScriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
        build_report(data)
        destination.write_text(json.dumps(data, indent=2)+"\n")
        (args.output_dir / "parity-snapshot.md").write_text(markdown(data))
        print(json.dumps(data["summary"], indent=2))
        return
    if args.verify:
        data = json.loads(destination.read_text())
        keys = {(venue, symbol): key for venue, symbol, _, key in ENDPOINTS}
        for o in data["observations"]:
            for x in o["responses"]:
                if x["rawBody"] is not None and x["error"] is None:
                    assert hashlib.sha256(x["rawBody"].encode()).hexdigest() == x["bodySha256"]
                    rebuilt = {"book": normalized_book(x["venue"], json.loads(x["rawBody"]), keys[(x["venue"], x["symbol"])]), "responseReceivedMs": x["responseReceivedMs"]}
                    attach_ages(rebuilt)
                    assert rebuilt["book"] == x["book"]
            assert comparisons(o) == o["comparisons"]
        saved = data["summary"]
        assert build_report(data)["summary"] == saved
        print(json.dumps({"verified": True, "summary": saved}, indent=2))
        return
    if not args.capture:
        parser.error("select --capture or --verify")
    prior_attempts = []
    if destination.exists() or (args.output_dir / "parity-snapshot.md").exists():
        if not args.retry_network_failures or not destination.exists():
            raise SystemExit("Refusing to overwrite existing parity evidence")
        previous = json.loads(destination.read_text())
        if previous["summary"]["availableDisplayedComparisons"] != 0 or previous["summary"]["failedRequests"] != 12:
            raise SystemExit("Network retry requires an entirely failed previous capture")
        prior_attempts = [previous]
    started = time.time_ns() / 1e6
    mono = time.monotonic()
    observations = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for index, offset in enumerate(PROTOCOL["targetStartOffsetsSeconds"], start=1):
            remaining = mono + offset - time.monotonic()
            if remaining > 0:
                time.sleep(remaining)
            responses = list(pool.map(fetch, ENDPOINTS))
            observation = {"round": index, "targetStartOffsetSeconds": offset, "responses": responses}
            observation["comparisons"] = comparisons(observation)
            observations.append(observation)
    completed = time.time_ns() / 1e6
    data = build_report({"protocol": PROTOCOL, "startedAtUtc": utc(started), "completedAtUtc": utc(completed),
                         "elapsedSeconds": time.monotonic()-mono,
                         "sourceScriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                         "observations": observations, "preservedFailedCaptureAttempts": prior_attempts,
                         "ordersSubmitted": False,
                         "authenticatedRequests": False, "borrowed": False})
    args.output_dir.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(data, indent=2)+"\n")
    (args.output_dir / "parity-snapshot.md").write_text(markdown(data))
    print(json.dumps(data["summary"], indent=2))


if __name__ == "__main__":
    main()
