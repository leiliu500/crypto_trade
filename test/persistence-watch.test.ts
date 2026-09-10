import assert from "node:assert/strict";
import test from "node:test";
import { PersistenceWatch } from "../src/database/persistence-watch.js";
import type { DatabaseHealth } from "../src/dashboard/types.js";
const empty: DatabaseHealth = { connected: true, status: "connected", queuedRecords: 0,
  droppedRecords: 0, lastPersistedAtMs: null, lastError: null };

test("connected but stalled persistence blocks after the deadline and clears only with progress", () => {
  const watch = new PersistenceWatch(5_000), pending = { ...empty, queuedRecords: 1 };
  assert.equal(watch.observe(pending, 1_000).connected, true);
  assert.equal(watch.observe(pending, 5_999).connected, true);
  assert.equal(watch.observe(pending, 6_000).lastError, "DATABASE_PERSISTENCE_WRITE_STALLED");
  assert.equal(watch.observe(pending, 7_000).connected, false);
  assert.equal(watch.observe({ ...pending, lastPersistedAtMs: 7_000 }, 7_001).connected, true);
});
test("an idle period does not make the next record immediately stale", () => {
  const watch = new PersistenceWatch(5_000);
  watch.observe({ ...empty, lastPersistedAtMs: 1_000 }, 1_000);
  const pending = { ...empty, queuedRecords: 2, lastPersistedAtMs: 1_000 };
  assert.equal(watch.observe(pending, 100_000).connected, true);
  assert.equal(watch.observe(pending, 105_000).connected, false);
  assert.equal(watch.observe(empty, 106_000).connected, true);
  assert.equal(watch.observe(pending, 200_000).connected, true);
});
test("future progress and invalid queue counts fail closed without clearing provider errors", () => {
  const watch = new PersistenceWatch(5_000);
  assert.equal(watch.observe({ ...empty, lastPersistedAtMs: 2_000 }, 1_000).connected, false);
  assert.equal(watch.observe({ ...empty, queuedRecords: NaN }, 1_000).connected, false);
  assert.equal(watch.observe({ ...empty, connected: false, status: "degraded", lastError: "offline" }, 1_000).lastError, "offline");
});
