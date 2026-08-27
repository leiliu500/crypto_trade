import assert from "node:assert/strict";
import test from "node:test";
import { EntryPipelineAudit } from "../src/engine/entry-pipeline-audit.js";

test("entry pipeline audit keeps monotonic stage counts and throttles repeated rejection events", () => {
  const audit = new EntryPipelineAudit();
  audit.pass("MARKET_EVENT");
  audit.pass("MARKET_EVENT");
  audit.pass("BOOK_READY");
  audit.pass("DIRECTION_AUTHORIZATION_PASS");
  assert.equal(audit.reject("DIRECTIONAL_RAW_PASS", "RULE_QUORUM", 1_000, { score: .2 }), true);
  assert.equal(audit.reject("DIRECTIONAL_RAW_PASS", "RULE_QUORUM", 2_000, { score: .3 }), false);
  assert.equal(audit.reject("DIRECTIONAL_RAW_PASS", "SCORE_GATE", 2_001), true);
  assert.equal(audit.reject("DIRECTIONAL_RAW_PASS", "RULE_QUORUM", 2_002), false);
  const snapshot = audit.snapshot();
  assert.equal(snapshot.counts.MARKET_EVENT, 2);
  assert.equal(snapshot.counts.BOOK_READY, 1);
  assert.equal(snapshot.counts.DIRECTION_AUTHORIZATION_PASS, 1);
  assert.equal(snapshot.counts.MICRO_EVENT, 0);
  assert.equal(snapshot.lastRejection?.reason, "RULE_QUORUM");
});
