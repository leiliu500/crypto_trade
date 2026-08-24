import assert from "node:assert/strict";
import test from "node:test";
import { calculateLatency, LatencyTracker } from "../src/core/latency.js";

test("decision-to-venue latency spans decision completion through acknowledgment", () => {
  const latency = calculateLatency({ decisionCompleteMs: 1_000, sentMs: 1_015, acknowledgedMs: 1_085 });
  assert.equal(latency.sendMs, 15);
  assert.equal(latency.acknowledgmentMs, 70);
  assert.equal(latency.decisionToVenueMs, 85);
});

test("latency tracker restores timestamped decision-to-venue history", () => {
  const tracker = new LatencyTracker();
  const nowMs = 4_000_000;
  assert.equal(tracker.restoreDecisionToVenue([
    { atMs: nowMs - 3_000, milliseconds: 85 },
    { atMs: nowMs - 2_000, milliseconds: 225 },
    { atMs: nowMs - 1_000, milliseconds: 272 },
    { atMs: Number.NaN, milliseconds: 100 },
  ]), 3);
  const summary = tracker.summary(nowMs).decisionToVenue!;
  assert.equal(summary.count, 3);
  assert.equal(summary.p95, 267.3);
});
