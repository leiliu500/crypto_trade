import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { PostgresTelemetryStore } from "../src/database/postgres-store.js";
import type { DatabaseHealth, TelemetryRecord } from "../src/dashboard/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function harness(maximumQueue = 10) {
  const store = new PostgresTelemetryStore({ connectionString: "postgres://unused",
    flushIntervalMs: 60_000, maximumQueue });
  const internal = store as unknown as { runId: string | null; status: string; queue: TelemetryRecord[];
    pool: { connect(): Promise<PoolClient>; query(): Promise<unknown>; end(): Promise<void> } };
  const original = internal.pool;
  const calls: string[] = [];
  let releases = 0;
  const client = { query: async (sql: string) => { calls.push(sql); return { rows: [] }; },
    release: () => { releases++; } } as unknown as PoolClient;
  internal.pool = { connect: async () => client, query: async () => ({ rows: [] }), end: async () => undefined };
  internal.runId = "test-run";
  internal.status = "connected";
  const health: DatabaseHealth[] = [];
  store.on("health", row => health.push(row));
  const record = (id: number): TelemetryRecord => ({ kind: "event", atMs: id,
    payload: { type: "test", severity: "info", symbol: null, clientOrderId: null, payload: { id } } });
  return { store, internal, client, calls, health, record, releases: () => releases,
    close: async () => { internal.pool.connect = async () => client; await store.close(); await original.end(); } };
}

test("connection acquisition failure preserves the complete batch and publishes degraded health", async t => {
  const h = harness(); t.after(h.close);
  const first = h.record(1), second = h.record(2);
  h.store.enqueue(first); h.store.enqueue(second);
  h.internal.pool.connect = async () => { throw new Error("pool acquire failed"); };
  await h.store.flush();
  assert.deepEqual(h.internal.queue, [first, second]);
  assert.equal(h.store.health().queuedRecords, 2);
  assert.equal(h.store.health().droppedRecords, 0);
  assert.equal(h.store.health().connected, false);
  assert.match(h.store.health().lastError!, /pool acquire failed/);
  assert.equal(h.health.at(-1)?.status, "degraded");
  assert.equal(h.releases(), 0);
  h.internal.pool.connect = async () => h.client;
  await h.store.flush();
  assert.equal(h.store.health().queuedRecords, 0);
  assert.equal(h.store.health().droppedRecords, 0);
  assert.equal(h.store.health().connected, true);
  assert.equal(h.calls.filter(sql => sql.startsWith("INSERT INTO system_events")).length, 2);
  assert.equal(h.releases(), 1);
});

test("pending connection and transaction work remain visible even after the queue was spliced", async t => {
  const h = harness(); t.after(h.close);
  const acquired = deferred<PoolClient>(), committed = deferred<unknown>();
  const client = { query: async (sql: string) => sql === "COMMIT" ? committed.promise : { rows: [] },
    release: () => undefined } as unknown as PoolClient;
  h.internal.pool.connect = () => acquired.promise;
  h.store.enqueue(h.record(1)); h.store.enqueue(h.record(2));
  const flushing = h.store.flush();
  assert.equal(h.internal.queue.length, 0);
  assert.equal(h.store.health().queuedRecords, 2);
  acquired.resolve(client);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.store.health().queuedRecords, 2);
  assert.equal(h.store.health().lastPersistedAtMs, null);
  committed.resolve({ rows: [] }); await flushing;
  assert.equal(h.store.health().queuedRecords, 0);
  assert.ok(h.store.health().lastPersistedAtMs !== null);
});

test("acquisition failure with a refilled queue counts every unrecoverable record", async t => {
  const h = harness(2); t.after(h.close);
  const acquired = deferred<PoolClient>(); h.internal.pool.connect = () => acquired.promise;
  h.store.enqueue(h.record(1)); h.store.enqueue(h.record(2));
  const flushing = h.store.flush();
  h.store.enqueue(h.record(3)); h.store.enqueue(h.record(4));
  assert.equal(h.store.health().queuedRecords, 4);
  acquired.reject(new Error("acquire failed")); await flushing;
  assert.equal(h.store.health().queuedRecords, 2);
  assert.equal(h.store.health().droppedRecords, 2);
  assert.equal(h.health.at(-1)?.droppedRecords, 2);
  assert.equal(h.store.health().connected, false);
});

test("transaction failure rolls back and retains its records for retry", async t => {
  const h = harness(); t.after(h.close);
  const sql: string[] = [];
  h.internal.pool.connect = async () => ({ query: async (statement: string) => {
    sql.push(statement); if (statement.startsWith("INSERT")) throw new Error("write failed");
    return { rows: [] };
  }, release: () => undefined }) as unknown as PoolClient;
  const record = h.record(1); h.store.enqueue(record);
  await h.store.flush();
  assert.deepEqual(h.internal.queue, [record]);
  assert.equal(h.store.health().queuedRecords, 1);
  assert.equal(h.store.health().droppedRecords, 0);
  assert.equal(h.store.health().status, "degraded");
  assert.equal(sql.at(-1), "ROLLBACK");
});
