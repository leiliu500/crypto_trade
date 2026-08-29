import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRejectedEntries, type RejectedEntryObservation } from "../src/analysis/rejected-entry-report.js";

test("rejected-entry audit separates executable taker returns from conditional maker returns", () => {
  const observations: RejectedEntryObservation[] = [{
    runId: "run", decisionId: "long", signalAtMs: 10_000, symbol: "BTC/USD", side: 1,
    family: "CONTINUATION", makerRejection: "REWARD_RISK_BELOW_MINIMUM",
    takerRejection: "REWARD_RISK_BELOW_MINIMUM", makerFillProbability: null,
    entryQuote: { atMs: 9_900, bestBid: 100, bestAsk: 101 },
    marks: [{ horizonMs: 1_000, quote: { atMs: 11_050, bestBid: 110, bestAsk: 111 } }],
  }, {
    runId: "run", decisionId: "short", signalAtMs: 20_000, symbol: "BTC/USD", side: -1,
    family: "CONTINUATION", makerRejection: "MAKER_FILL_PROBABILITY_BELOW_MINIMUM",
    takerRejection: "EXACT_COST_REVALIDATION_FAILED", makerFillProbability: .01,
    entryQuote: { atMs: 19_950, bestBid: 100, bestAsk: 101 },
    marks: [{ horizonMs: 1_000, quote: { atMs: 21_010, bestBid: 90, bestAsk: 91 } }],
  }];
  const report = analyzeRejectedEntries(observations, { "BTC/USD": { makerFeeBps: 2, takerFeeBps: 5 } }, 30_000);
  assert.equal(report.decisionCount, 2);
  assert.deepEqual(report.directions, { LONG: 1, SHORT: 1 });
  assert.equal(report.horizons[0]?.taker.samples, 2);
  assert.equal(report.horizons[0]?.taker.wins, 2);
  assert.ok((report.horizons[0]?.makerIfFilled.averageBps ?? 0) > (report.horizons[0]?.taker.averageBps ?? 0));
  assert.equal(report.results[0]?.entryQuoteAgeMs, 100);
  assert.equal(report.results[0]?.markDelayMs, 50);
});

test("rejected-entry audit reports unavailable future marks without inventing returns", () => {
  const report = analyzeRejectedEntries([{
    runId: "run", decisionId: "missing", signalAtMs: 10_000, symbol: "ETH/USD", side: 1,
    family: "CONTINUATION", makerRejection: null, takerRejection: null, makerFillProbability: null,
    entryQuote: null, marks: [{ horizonMs: 1_000, quote: null }],
  }], { "ETH/USD": { makerFeeBps: 2, takerFeeBps: 5 } }, 20_000);
  assert.equal(report.horizons[0]?.taker.samples, 0);
  assert.equal(report.results[0]?.takerNetBps, null);
  assert.equal(report.results[0]?.makerIfFilledNetBps, null);
});
