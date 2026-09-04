import assert from "node:assert/strict";
import test from "node:test";
import type { AlphaResearchObservation } from "../src/research/alpha-research.js";
import { DEFAULT_ALPHA_PROMOTION_POLICY, evaluateAlphaResearch, independentAlphaSamples, rocAuc } from "../src/research/alpha-research.js";

const HOUR = 3_600_000;

test("alpha promotion requires 100 independent samples, seven days, and positive purged OOS expectancy", () => {
  const tooSmall = observations(99, { spacingMs: 2 * HOUR, realizedNetBps: 8 });
  const report = evaluateAlphaResearch(tooSmall, DEFAULT_ALPHA_PROMOTION_POLICY, 1);
  assert.equal(report.promotedCohorts, 0);
  assert.ok(report.cohorts[0]?.rejectionReasons.includes("INSUFFICIENT_INDEPENDENT_SAMPLES"));

  const tooShort = observations(120, { spacingMs: HOUR, realizedNetBps: 8 });
  const shortReport = evaluateAlphaResearch(tooShort, DEFAULT_ALPHA_PROMOTION_POLICY, 1);
  assert.equal(shortReport.promotedCohorts, 0);
  assert.ok(shortReport.cohorts[0]?.rejectionReasons.includes("INSUFFICIENT_TIME_COVERAGE"));
});

test("purged walk-forward promotion selects the best route and emits an empirical edge bucket", () => {
  const maker = observations(150, { spacingMs: 2 * HOUR, routeStyle: "maker", executionPath: "MAKER_TAKER",
    realizedNetBps: (index) => index % 2 === 0 ? 14 : 0,
    makerFillProbability: (index) => index % 2 === 0 ? .9 : .1,
    makerFilled: (index) => index % 2 === 0 });
  const taker = observations(150, { spacingMs: 2 * HOUR, routeStyle: "taker", executionPath: "TAKER_TAKER",
    realizedNetBps: (index) => 4 + (index % 3) });
  const report = evaluateAlphaResearch([...maker, ...taker], DEFAULT_ALPHA_PROMOTION_POLICY, 1);
  assert.equal(report.promotedCohorts, 1);
  const promoted = report.cohorts.find((cohort) => cohort.promoted)!;
  assert.equal(promoted.routeStyle, "maker");
  assert.equal(promoted.independentSamples, 150);
  assert.equal(promoted.validationFolds, 3);
  assert.ok((promoted.lowerConfidenceNetBps ?? 0) > 0);
  assert.equal(promoted.makerFillAuc, 1);
  assert.equal(promoted.calibratedBucket?.effectiveSampleCount, 150);
  assert.ok((promoted.calibratedBucket?.lowerConfidenceGrossReturnBps ?? 0)
    > (promoted.lowerConfidenceNetBps ?? 0));
  const nonWinner = report.cohorts.find((cohort) => cohort.routeStyle === "taker")!;
  assert.deepEqual(nonWinner.rejectionReasons, ["NOT_BEST_ROUTE_HORIZON"]);
});

test("negative OOS expectancy and worse-than-random maker ranking fail closed", () => {
  const negative = observations(150, { spacingMs: 2 * HOUR, routeStyle: "taker",
    executionPath: "TAKER_TAKER", realizedNetBps: -3 });
  const negativeReport = evaluateAlphaResearch(negative, DEFAULT_ALPHA_PROMOTION_POLICY, 1);
  assert.ok(negativeReport.cohorts[0]?.rejectionReasons.includes("NON_POSITIVE_OUT_OF_SAMPLE_LOWER_BOUND"));

  const reversed = observations(150, { spacingMs: 2 * HOUR, routeStyle: "maker", executionPath: "MAKER_TAKER",
    realizedNetBps: 5, makerFillProbability: (index) => index % 2 === 0 ? .1 : .9,
    makerFilled: (index) => index % 2 === 0 });
  const makerReport = evaluateAlphaResearch(reversed, DEFAULT_ALPHA_PROMOTION_POLICY, 1);
  assert.equal(makerReport.cohorts[0]?.makerFillAuc, 0);
  assert.ok(makerReport.cohorts[0]?.rejectionReasons.includes("MAKER_FILL_AUC_BELOW_MINIMUM"));
});

test("overlapping labels are purged and configuration versions never pool", () => {
  const clustered = observations(10, { spacingMs: 10_000, horizonMs: HOUR, realizedNetBps: 5 });
  assert.equal(independentAlphaSamples(clustered).length, 1);
  const versionTwo = observations(10, { spacingMs: 10_000, horizonMs: HOUR, realizedNetBps: 5,
    configurationVersion: "v2" });
  const report = evaluateAlphaResearch([...clustered, ...versionTwo], {
    ...DEFAULT_ALPHA_PROMOTION_POLICY, minimumIndependentSamples: 2, minimumCoverageMs: 1,
    minimumOutOfSampleSamples: 2,
  }, 1);
  assert.equal(report.cohorts.length, 2);
  assert.deepEqual(report.configurationVersions, ["v1", "v2"]);
});

test("ROC AUC handles ties without inflating maker-fill skill", () => {
  assert.equal(rocAuc([.5, .5, .5, .5], [true, false, true, false]), .5);
  assert.equal(rocAuc([.9, .8, .2, .1], [true, true, false, false]), 1);
  assert.equal(rocAuc([.1, .2, .8, .9], [true, true, false, false]), 0);
  assert.equal(rocAuc([.5], [true]), null);
});

interface ObservationOptions {
  spacingMs?: number;
  horizonMs?: number;
  configurationVersion?: string;
  routeStyle?: "maker" | "taker";
  executionPath?: "MAKER_TAKER" | "TAKER_TAKER";
  realizedNetBps: number | ((index: number) => number);
  makerFillProbability?: number | ((index: number) => number);
  makerFilled?: boolean | ((index: number) => boolean);
}

function observations(count: number, options: ObservationOptions): AlphaResearchObservation[] {
  const spacingMs = options.spacingMs ?? 2 * HOUR;
  const horizonMs = options.horizonMs ?? HOUR;
  const routeStyle = options.routeStyle ?? "taker";
  return Array.from({ length: count }, (_, index) => ({
    decisionId: `${options.configurationVersion ?? "v1"}-${routeStyle}-${index}`,
    configurationVersion: options.configurationVersion ?? "v1", symbol: "BTC/USD",
    family: "CONTINUATION", side: 1, regime: "TREND_UP",
    executionPath: options.executionPath ?? "TAKER_TAKER", routeStyle, horizonMs,
    signalAtMs: index * spacingMs, signalSpreadBps: 1, signalQuality: .8,
    predictedNetBps: 10, modeledCostBps: 5,
    realizedNetBps: valueAt(options.realizedNetBps, index),
    makerFillProbability: routeStyle === "maker" ? valueAt(options.makerFillProbability ?? .5, index) : null,
    makerFilled: routeStyle === "maker" ? valueAt(options.makerFilled ?? true, index) : null,
    makerFillOutcomeKnown: routeStyle === "maker" ? true : null,
  }));
}

function valueAt<T>(value: T | ((index: number) => T), index: number): T {
  return typeof value === "function" ? (value as (index: number) => T)(index) : value;
}
