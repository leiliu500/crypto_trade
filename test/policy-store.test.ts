import assert from "node:assert/strict";
import test from "node:test";
import { PolicyStore } from "../src/research/policy-store.js";
import { POLICY_VERSION } from "../src/research/trading-policy.js";

for (const persist of [true, false]) test(`policy refresh serializes and ${persist ? "replaces even an empty model set" : "supports read-only evaluation"}`, async () => {
  const store = new PolicyStore("postgres://unused");
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  let released = false;
  const internals = store as unknown as { pool: { connect: () => Promise<unknown>; end: () => Promise<void> } };
  const original = internals.pool;
  internals.pool = { connect: async () => ({ query: async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, ...(values ? { values } : {}) }); return { rows: [] };
  }, release: () => { released = true; } }), end: async () => undefined };
  try {
    const report = await store.evaluate("config-v1", persist);
    assert.equal(calls[0]!.sql, "BEGIN");
    assert.match(calls[1]!.sql, /pg_advisory_xact_lock/);
    assert.match(calls[2]!.sql, /database_dropped_records/);
    assert.match(calls[2]!.sql, /paperEntryExercise/);
    assert.deepEqual(calls[2]!.values, ["config-v1", POLICY_VERSION]);
    assert.equal(calls.some((call) => call.sql.startsWith("DELETE FROM policy_models")), persist);
    assert.equal(calls.some((call) => call.sql.startsWith("INSERT INTO policy_evaluations")), persist);
    assert.equal(calls.at(-1)!.sql, "COMMIT");
    assert.deepEqual(report.models, []);
    assert.ok(released);
  } finally { await store.close(); await original.end(); }
});

test("failed model replacement rolls back and releases its connection", async () => {
  const store = new PolicyStore("postgres://unused");
  const calls: string[] = [];
  let released = false;
  const internals = store as unknown as { pool: { connect: () => Promise<unknown>; end: () => Promise<void> } };
  const original = internals.pool;
  internals.pool = { connect: async () => ({ query: async (sql: string) => {
    calls.push(sql);
    if (sql.startsWith("DELETE")) throw new Error("database failure");
    return { rows: [] };
  }, release: () => { released = true; } }), end: async () => undefined };
  try {
    await assert.rejects(store.evaluate("config-v1"), /database failure/);
    assert.equal(calls.at(-1), "ROLLBACK");
    assert.equal(calls.includes("COMMIT"), false);
    assert.ok(released);
  } finally { await store.close(); await original.end(); }
});
