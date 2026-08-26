import assert from "node:assert/strict";
import test from "node:test";
import { PostgresTelemetryStore } from "../src/database/postgres-store.js";
import type { TelemetryRecord } from "../src/dashboard/types.js";

test("a full telemetry queue preserves fills and decisions over sampled state", async () => {
  const store = new PostgresTelemetryStore({
    connectionString: "postgres://unused",
    flushIntervalMs: 60_000,
    maximumQueue: 3,
  });
  const record = (kind: TelemetryRecord["kind"]): TelemetryRecord => ({ kind, atMs: 1, payload: {} });
  store.enqueue(record("health"));
  store.enqueue(record("market"));
  store.enqueue(record("position"));
  store.enqueue(record("fill"));
  store.enqueue(record("market"));
  store.enqueue(record("decision"));

  const queue = (store as unknown as { queue: TelemetryRecord[] }).queue;
  assert.deepEqual(queue.map((item) => item.kind), ["position", "fill", "decision"]);
  assert.equal(store.health().queuedRecords, 3);
  assert.equal(store.health().droppedRecords, 3);
  await store.close();
});
