import assert from "node:assert/strict";
import test from "node:test";
import { FUNDING_HOUR_MS as H, fundingMonthlyCohorts, summarizeFundingCohorts, type FundingObservation } from "../src/carry/funding-model.js";

function rows(rate = 1): FundingObservation[] {
  const result: FundingObservation[] = [];
  for (let t = Date.UTC(2023, 0, 1) + H; t <= Date.UTC(2026, 0, 1); t += H) {
    result.push({ symbol: "BTC/USD", timestampMs: t, absoluteRate: rate });
  }
  return result;
}
test("monthly funding respects source-year boundaries, leap days, and one additional publication hour", () => {
  const data = rows(), decision = Date.UTC(2024, 0, 1);
  data.find(r => r.timestampMs === decision)!.absoluteRate = 1e9; // not yet available and belongs to prior month
  const cohorts = fundingMonthlyCohorts(data, "BTC/USD", 2024);
  assert.equal(cohorts[0]!.forecastsUsdPerBase.adaptive, 744);
  assert.equal(cohorts[0]!.actualUsdPerBase, 744);
  assert.equal(cohorts[1]!.expectedTargetHours, 696);
  assert.equal(cohorts[11]!.actualUsdPerBase, 744);
  const december2025 = fundingMonthlyCohorts(data, "BTC/USD", 2025)[11]!;
  assert.equal(december2025.actualUsdPerBase, 744);
  assert.equal(december2025.targetAvailableAtMs, Date.UTC(2026, 0, 1) + H);
});
test("forecast remains unchanged when target and later observations change", () => {
  const data = rows(), decision = Date.UTC(2024, 0, 1);
  const before = fundingMonthlyCohorts(data, "BTC/USD", 2024)[0]!;
  for (const r of data) if (r.timestampMs >= decision) r.absoluteRate = -10;
  const after = fundingMonthlyCohorts(data, "BTC/USD", 2024)[0]!;
  assert.deepEqual(after.forecastsUsdPerBase, before.forecastsUsdPerBase);
  assert.equal(after.conservativeUsdPerBase, before.conservativeUsdPerBase);
  assert.equal(after.actualUsdPerBase, -7440);
});
test("conservative weekly percentile is second-smallest and negative funding is preserved", () => {
  const data = rows(), cutoff = Date.UTC(2024, 0, 1) - H;
  for (const r of data) if (r.timestampMs > cutoff - 2184 * H && r.timestampMs <= cutoff) {
    r.absoluteRate = Math.floor((r.timestampMs - (cutoff - 2184 * H) - H) / (168 * H)) - 3;
  }
  const c = fundingMonthlyCohorts(data, "BTC/USD", 2024)[0]!;
  assert.equal(c.conservativeUsdPerBase, -2 * 744);
  assert.equal(c.observedHistoryHours, 2184);
});
test("one missing hour makes the complete target unknown, never a partial total", () => {
  const data = rows().filter(r => r.timestampMs !== Date.UTC(2024, 0, 5));
  const cohorts = fundingMonthlyCohorts(data, "BTC/USD", 2024), january = cohorts[0]!, february = cohorts[1]!;
  assert.equal(january.actualUsdPerBase, null);
  assert.equal(january.observedTargetHours, 743);
  assert.equal(january.matched, false);
  assert.equal(february.forecastStatus, "UNKNOWN");
  assert.equal(february.forecastsUsdPerBase.adaptive, null);
  assert.equal(february.forecastsUsdPerBase.last, 696);
  const summary = summarizeFundingCohorts(cohorts);
  assert.equal(summary.calendarCohorts, 12);
  assert.equal(summary.matchedCohorts, 8);
  assert.equal(summary.fullCoverage, false);
});
test("metrics compare identical cohorts and do not credit zero forecasts for positive income", () => {
  const cohorts = fundingMonthlyCohorts(rows(), "BTC/USD", 2024);
  const summary = summarizeFundingCohorts(cohorts);
  assert.equal(summary.metrics.adaptive.maeUsdPerBase, 0);
  assert.equal(summary.metrics.zero.directionAccuracy, 0);
  assert.equal(summary.metrics.adaptive.directionAccuracy, 1);
  assert.equal(summary.candidateLowerMaeThanEveryBaseline, false);
  assert.equal(summary.conservative.violationFrequency, 0);
  assert.throws(() => summarizeFundingCohorts(cohorts.slice(1)), /COMPLETE_CALENDAR/);
});
test("reject duplicates, invalid rates, fractional hours, wrong symbols, and unauthorized periods", () => {
  const data = rows();
  assert.throws(() => fundingMonthlyCohorts([...data, data[0]!], "BTC/USD", 2024), /DUPLICATE/);
  for (const row of [{ ...data[0]!, absoluteRate: NaN }, { ...data[0]!, timestampMs: data[0]!.timestampMs + 1 },
    { ...data[0]!, symbol: "SOL/USD" }, { ...data[0]!, timestampMs: Date.UTC(2026, 0, 1) + H }]) {
    assert.throws(() => fundingMonthlyCohorts([row], "BTC/USD", 2024), /INVALID/);
  }
  assert.throws(() => fundingMonthlyCohorts(data, "BTC/USD", 2026), /NOT_REGISTERED/);
  assert.throws(() => fundingMonthlyCohorts(rows(1e308), "BTC/USD", 2024), /ARITHMETIC_OVERFLOW/);
});
