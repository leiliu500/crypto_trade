import test from "node:test";
import assert from "node:assert/strict";
import { createPaperState } from "../src/eth40/engine.js";
import { eth40Status } from "../src/eth40/status.js";
import { DAY_MS } from "../src/eth40/spec.js";

test("ETH40 status distinguishes ongoing collection from economic qualification", () => {
  const started = Date.UTC(2026, 8, 10, 20), state = createPaperState(started);
  const status = eth40Status({ state, sequence: 1, lastHash: "a".repeat(64), lastCycle: null,
    market: null, processStartedAtMs: started, fatalError: null, nowMs: started + 1000 });
  assert.equal(status.firstExecutionDayMs, Date.UTC(2026, 8, 12));
  assert.equal(status.nextExecutionWindowMs, status.firstExecutionDayMs);
  assert.equal(status.reviewAtMs, Date.UTC(2027, 2, 10, 20));
  assert.equal(status.validatedProfitable, false);
  assert.equal(status.collectorHealthy, false, "genesis alone is not a successful collection cycle");
  assert.equal(status.excessVsPassiveEthUsd, null);
  assert.equal(status.cashBenchmark.netPnlUsd, 0);
  const expired = eth40Status({ state, sequence: 1, lastHash: "a".repeat(64), lastCycle: null,
    market: null, processStartedAtMs: started, fatalError: null, nowMs: state.reviewAtMs + DAY_MS });
  assert.equal(expired.collectorHealthy, false);
  assert.equal(expired.reviewStatus, "INCONCLUSIVE_TOO_FEW_COMPLETED_EPISODES");
  assert.equal(expired.automaticPromotionAllowed, false);
});
