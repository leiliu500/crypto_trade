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

test("position restoration supplements legacy snapshots with entry-order economics", async () => {
  const store = new PostgresTelemetryStore({
    connectionString: "postgres://unused",
    flushIntervalMs: 60_000,
    maximumQueue: 3,
  });
  const internals = store as unknown as { pool: {
    query: (sql: string) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  } };
  const originalPool = internals.pool;
  let query = "";
  internals.pool = {
    query: async (sql) => {
      query = sql;
      return { rows: [{
        position: { symbol: "BTC/USD", side: -1, qty: .0063, entryPx: 78_476, openedMs: 1_787_767_585_764,
          initialRiskPx: 1_241.5763680212274, mfePx: 40, maePx: 178, floorPx: -1_241.5763680212274,
          breakEvenArmed: false, phase: "OPEN" },
        round_trip_bps: "8.408372678433441", economic_horizon_ms: "7200000",
        execution_path: "MAKER_MAKER_TAKER_FALLBACK",
      }] };
    },
    end: async () => undefined,
  };
  try {
    const states = await store.loadLatestPositionStates(["BTC/USD"]);
    assert.match(query, /snapshot_positions/);
    assert.equal(states.length, 1);
    assert.ok(Math.abs(states[0]!.roundTripCostPx - 65.98554543127428) < 1e-12);
    assert.equal(states[0]!.selectedHorizonMs, 7_200_000);
    assert.equal(states[0]!.executionPath, "MAKER_MAKER_TAKER_FALLBACK");
  } finally {
    await store.close();
    await originalPool.end();
  }
});

test("realized session restoration deduplicates exit legs instead of dropping partial exits", async () => {
  const store = new PostgresTelemetryStore({
    connectionString: "postgres://unused",
    flushIntervalMs: 60_000,
    maximumQueue: 3,
  });
  const internals = store as unknown as { pool: {
    query: (sql: string) => Promise<{ rows: Array<{ realized_pnl: string }> }>;
    end: () => Promise<void>;
  } };
  const originalPool = internals.pool;
  let query = "";
  internals.pool = {
    query: async (sql) => {
      query = sql;
      return { rows: [{ realized_pnl: "2.75" }] };
    },
    end: async () => undefined,
  };
  try {
    assert.equal(await store.loadRealizedSessionPnl(Date.parse("2026-08-27T00:00:00.000Z")), 2.75);
    assert.match(query, /DISTINCT ON \(plan#>>'\{livePosition,exitOrderId\}'\)/);
    assert.match(query, /plan#>>'\{livePosition,exitOrderId\}' IS NOT NULL/);
  } finally {
    await store.close();
    await originalPool.end();
  }
});

test("paper-history backfill is transactional and keeps unknown original run ids null", async () => {
  const store = new PostgresTelemetryStore({
    connectionString: "postgres://unused",
    flushIntervalMs: 60_000,
    maximumQueue: 3,
  });
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const internals = store as unknown as { pool: {
    connect: () => Promise<{ query: (sql: string, values?: readonly unknown[]) => Promise<{ rowCount: number | null }>; release: () => void }>;
    end: () => Promise<void>;
  } };
  const originalPool = internals.pool;
  internals.pool = {
    connect: async () => ({
      query: async (sql, values) => {
        queries.push({ sql, ...(values === undefined ? {} : { values }) });
        return { rowCount: /^INSERT INTO (orders|fills)/.test(sql.trim()) ? 1 : 0 };
      },
      release: () => undefined,
    }),
    end: async () => undefined,
  };
  try {
    const atMs = Date.parse("2026-08-28T16:00:00.000Z");
    const result = await store.backfillHistoricalOrders([{
      clientOrderId: "paper-history", decisionId: "decision", alpacaOrderId: "remote", historical: true,
      symbol: "BTC/USD", side: 1, style: "maker", timeInForce: "gtc", status: "FILLED",
      statusLabel: "Filled", terminal: true, requestedQty: .001, filledQty: .001, remainingQty: 0,
      fillPercent: 100, averageFillPx: 80_000, limitPx: 80_000, expectedValue: 1, fillProbability: .1,
      expectedCost: { roundTripBps: 7, spreadBps: 1, feeBps: 7, impactBps: 0, latencyBps: 0,
        adverseSelectionBps: 0, fundingBps: 0, borrowBps: 0 },
      reduceOnlyIntent: false, createdMs: atMs, expiresMs: atMs + 1_000, updatedMs: atMs + 500,
      ageMs: 1_000, expiresInMs: 0, error: null, cancelRequestReason: null, cancellationReason: null,
      timeline: [], livePosition: null,
    }], [{ id: "fill-history", clientOrderId: "paper-history", symbol: "BTC/USD", side: 1,
      qty: .001, price: 80_000, final: true, atMs: atMs + 500 }]);
    assert.deepEqual(result, { ordersInserted: 1, fillsInserted: 1 });
    assert.equal(queries[0]?.sql, "BEGIN");
    assert.match(queries[1]?.sql ?? "", /VALUES \(\$1,NULL/);
    assert.match(queries.at(-2)?.sql ?? "", /ON CONFLICT \(execution_id\) DO NOTHING/);
    assert.equal(queries.at(-1)?.sql, "COMMIT");
  } finally {
    await store.close();
    await originalPool.end();
  }
});
