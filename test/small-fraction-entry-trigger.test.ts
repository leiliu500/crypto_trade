import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DETERMINISTIC_SIGNAL_CONFIG } from "../src/config/deterministic-defaults.js";
import type { SmallFractionCandidate, SmallFractionFeatures } from "../src/strategy/micro-fraction-types.js";
import { SmallFractionEntryTrigger } from "../src/strategy/small-fraction-entry-trigger.js";

const triggerConfig = () => ({ ...DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger });

function bullish(nowMs: number, overrides: Partial<SmallFractionFeatures> = {}): SmallFractionFeatures {
  const mid = overrides.mid ?? 100;
  return {
    symbol: "BTC/USD", nowMs, bestBid: mid - .005, bestAsk: mid + .005, mid,
    microprice: mid + .001, qiK: .30, ofi: .40, tfi: .20, replenishmentPressure: .15,
    velocityZ: .25, accelerationZ: 0, breakoutUpBps: .10, breakoutDownBps: 0,
    cusumUp: 1, cusumDown: 0, efficiency: .8, flowFlipRate: .1, varianceRate: 1e-8,
    providerAgeMs: 10, stale: false, bookReady: true, ...overrides,
  };
}

function bearish(nowMs: number): SmallFractionFeatures {
  return {
    ...bullish(nowMs), microprice: 99.999, qiK: -.30, ofi: -.40, tfi: -.20,
    replenishmentPressure: -.15, velocityZ: -.25, breakoutUpBps: 0, breakoutDownBps: .10,
    cusumUp: 0, cusumDown: -1,
  };
}

test("persistent evidence fires even when each microprice increment is below the absolute movement threshold", () => {
  const trigger = new SmallFractionEntryTrigger(triggerConfig());
  let candidate: SmallFractionCandidate | null = null;
  for (let index = 0; index < 30; index += 1) {
    candidate ??= trigger.update(bullish(index * 20, { microprice: 100.001 + index * .00002 })).candidate;
  }
  assert.equal(candidate?.side, 1);
  assert.ok(candidate && candidate.deltaMicroBps < triggerConfig().minimumMicroMoveBps);
});

test("one isolated microprice spike cannot bypass occupancy and evidence confirmation", () => {
  const trigger = new SmallFractionEntryTrigger(triggerConfig());
  assert.equal(trigger.update(bullish(0, { qiK: 0, ofi: 0, tfi: 0, velocityZ: 0, breakoutUpBps: 0, cusumUp: 0 })).candidate, null);
  assert.equal(trigger.update(bullish(20, { microprice: 100.01, qiK: .5, ofi: .6 })).candidate, null);
});

test("the current movement is measured against prior noise before the estimator observes it", () => {
  const trigger = new SmallFractionEntryTrigger(triggerConfig());
  trigger.update(bullish(0, { microprice: 100 }));
  const spike = trigger.update(bullish(20, { microprice: 100.01 }));
  const after = trigger.update(bullish(40, { microprice: 100.01 }));
  assert.equal(spike.long.sensorThresholdBps, triggerConfig().minimumMicroMoveBps);
  assert.ok(after.long.sensorThresholdBps > spike.long.sensorThresholdBps);
});

test("opposing evidence decays the leaky accumulator", () => {
  const trigger = new SmallFractionEntryTrigger(triggerConfig());
  for (let index = 0; index < 8; index += 1) trigger.update(bullish(index * 20));
  const before = trigger.update(bullish(180)).long.evidence;
  const after = trigger.update(bearish(200)).long.evidence;
  assert.ok(after < before);
});

test("arm-anchored chase blocks a candidate that arrives too late", () => {
  const trigger = new SmallFractionEntryTrigger({ ...triggerConfig(), maximumChaseBps: .20 });
  let latest = trigger.update(bullish(0));
  for (let index = 1; index < 30; index += 1) {
    const mid = 100 * Math.exp(index * .05 / 10_000);
    latest = trigger.update(bullish(index * 20, { mid, bestBid: mid - .005, bestAsk: mid + .005, microprice: mid + .001 }));
  }
  assert.equal(latest.candidate, null);
  assert.ok(latest.long.reasons.includes("MAXIMUM_CHASE_EXCEEDED"));
});

test("a continuous episode produces only one candidate", () => {
  const trigger = new SmallFractionEntryTrigger(triggerConfig());
  let count = 0;
  for (let index = 0; index < 100; index += 1) {
    const candidate = trigger.update(bullish(index * 20)).candidate;
    if (candidate) { count += 1; trigger.commitCandidate(candidate.side, candidate.createdMs); }
  }
  assert.equal(count, 1);
});

test("a downstream-rejected episode can retry, while an accepted episode cannot", () => {
  const cfg = { ...triggerConfig(), candidateRetryMs: 200 };
  const trigger = new SmallFractionEntryTrigger(cfg);
  let first: SmallFractionCandidate | null = null;
  let retry: SmallFractionCandidate | null = null;
  for (let index = 0; index < 80; index += 1) {
    const candidate = trigger.update(bullish(index * 20)).candidate;
    first ??= candidate;
    if (first && candidate && candidate.createdMs >= first.createdMs + cfg.candidateRetryMs) {
      retry = candidate;
      break;
    }
  }
  assert.ok(first);
  assert.ok(retry);
  assert.ok(retry.evidence >= first.evidence);
  trigger.commitCandidate(retry.side, retry.createdMs);
  for (let index = 0; index < 80; index += 1) {
    assert.equal(trigger.update(bullish(retry.createdMs + 20 + index * 20)).candidate, null);
  }
});

test("an excessive event gap resets accumulated episode state", () => {
  const trigger = new SmallFractionEntryTrigger({ ...triggerConfig(), maximumEventGapMs: 500 });
  for (let index = 0; index < 5; index += 1) trigger.update(bullish(index * 20));
  const result = trigger.update(bullish(5_000));
  assert.ok(result.long.reasons.includes("EVENT_GAP_RESET"));
  assert.equal(result.long.occupancy, 0);
  assert.equal(result.long.evidence, 0);
});

test("separate trigger instances never share symbol noise or episode state", () => {
  const btc = new SmallFractionEntryTrigger(triggerConfig());
  const eth = new SmallFractionEntryTrigger(triggerConfig());
  for (let index = 0; index < 20; index += 1) btc.update(bullish(index * 20));
  const ethFirst = eth.update({ ...bullish(1_000), symbol: "ETH/USD" });
  assert.equal(ethFirst.long.occupancy, 0);
  assert.equal(ethFirst.long.evidence, 0);
  assert.equal(ethFirst.long.microNoiseBps, .0001);
});
