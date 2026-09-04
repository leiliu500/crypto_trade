import assert from "node:assert/strict";
import test from "node:test";
import { AlphaResearchStore } from "../src/research/alpha-research-store.js";
import { DEFAULT_ALPHA_PROMOTION_POLICY, type AlphaResearchReport } from "../src/research/alpha-research.js";

test("a scoped alpha evaluation atomically demotes stale promotions before saving fresh cohorts", async () => {
  const store = new AlphaResearchStore("postgres://unused");
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const internals = store as unknown as { pool: {
    connect: () => Promise<{
      query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
      release: () => void;
    }>;
    end: () => Promise<void>;
  } };
  const originalPool = internals.pool;
  internals.pool = {
    connect: async () => ({
      query: async (sql, values) => {
        queries.push({ sql, ...(values === undefined ? {} : { values }) });
        return { rows: [] };
      },
      release: () => undefined,
    }),
    end: async () => undefined,
  };
  const report: AlphaResearchReport = {
    generatedAtMs: 1_700_000_000_000,
    policy: DEFAULT_ALPHA_PROMOTION_POLICY,
    observations: 0,
    configurationVersions: [],
    cohorts: [],
    promotedCohorts: 0,
    rejectedCohorts: 0,
  };
  try {
    await store.saveReport(report, ["config-v1"]);
    assert.equal(queries[0]?.sql, "BEGIN");
    assert.match(queries[1]?.sql ?? "", /UPDATE alpha_calibrations SET promoted=false/);
    assert.match(queries[1]?.sql ?? "", /SUPERSEDED_BY_NEW_EVALUATION/);
    assert.deepEqual(queries[1]?.values?.[0], ["config-v1"]);
    assert.equal(queries[2]?.sql, "COMMIT");
  } finally {
    await store.close();
    await originalPool.end();
  }
});
