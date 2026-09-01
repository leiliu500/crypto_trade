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
    assert.match(query, /SELECT DISTINCT ON \(symbol\)/);
    assert.match(query, /closed\.closed_at >= candidates\.observed_at/);
    assert.equal(states.length, 1);
    assert.ok(Math.abs(states[0]!.roundTripCostPx - 65.98554543127428) < 1e-12);
    assert.equal(states[0]!.selectedHorizonMs, 7_200_000);
    assert.equal(states[0]!.executionPath, "MAKER_MAKER_TAKER_FALLBACK");
  } finally {
    await store.close();
    await originalPool.end();
  }
});

test("position persistence writes closures and clears closed_at for a newer active position", async () => {
  const store = new PostgresTelemetryStore({
    connectionString: "postgres://unused",
    flushIntervalMs: 60_000,
    maximumQueue: 3,
  });
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = {
    query: async (sql: string, values: readonly unknown[]) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  };
  const persistPosition = (store as unknown as {
    persistPosition: (databaseClient: unknown, position: Record<string, unknown>, runId: string, atMs: number) => Promise<void>;
  }).persistPosition.bind(store);
  const base = {
    active: false,
    closedAtMs: 2_000,
    symbol: "BTC/USD",
    side: 1,
    qty: 0,
    entryPx: 100,
    currentPx: 99,
    marketValue: 0,
    unrealizedPnl: 0,
    unrealizedPnlBps: 0,
    phase: "CLOSED",
    openedMs: 1_000,
    ageMs: 1_000,
    initialRiskPx: 2,
    roundTripCostPx: .2,
    floorPx: -2,
    stopPx: 98,
    mfePx: 1,
    maePx: 1,
    breakEvenArmed: false,
    selectedHorizonMs: 3_600_000,
    executionPath: "TAKER_TAKER",
    latestAction: "EXIT",
    latestReason: "EVIDENCE_EXIT",
    holdEdgeBps: -1,
    reversalProbability: .8,
  };
  try {
    await persistPosition(client, base, "run-1", 2_000);
    assert.match(calls[0]!.sql, /closed_at,payload/);
    assert.match(calls[0]!.sql, /closed_at=EXCLUDED\.closed_at/);
    assert.match(calls[0]!.sql, /positions\.opened_at <= EXCLUDED\.opened_at/);
    assert.deepEqual(calls[0]!.values[14], new Date(2_000));

    await persistPosition(client, { ...base, active: true, closedAtMs: null, qty: 1, phase: "OPEN",
      openedMs: 3_000, ageMs: 0, latestAction: "MONITOR", latestReason: null }, "run-1", 3_000);
    assert.equal(calls[2]!.values[14], null);
  } finally {
    await store.close();
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

test("dashboard order restoration is bounded to the requested UTC session", async () => {
  const store = new PostgresTelemetryStore({
    connectionString: "postgres://unused",
    flushIntervalMs: 60_000,
    maximumQueue: 3,
  });
  const internals = store as unknown as { pool: {
    query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  } };
  const originalPool = internals.pool;
  let query = "";
  let values: readonly unknown[] = [];
  internals.pool = {
    query: async (sql, parameters) => {
      query = sql;
      values = parameters ?? [];
      return { rows: [] };
    },
    end: async () => undefined,
  };
  try {
    const sinceMs = Date.parse("2026-08-30T00:00:00.000Z");
    const untilMs = sinceMs + 86_400_000;
    assert.deepEqual(await store.loadOrders(sinceMs, untilMs), []);
    assert.match(query, /created_at >= \$1 AND created_at < \$2/);
    assert.deepEqual(values, [new Date(sinceMs), new Date(untilMs)]);
    await assert.rejects(store.loadOrders(untilMs, sinceMs), /Invalid order-history interval/);
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
  const insertedOrderIds = new Set<string>();
  const insertedFillIds = new Set<string>();
  internals.pool = {
    connect: async () => ({
      query: async (sql, values) => {
        queries.push({ sql, ...(values === undefined ? {} : { values }) });
        if (/^INSERT INTO orders/.test(sql.trim())) {
          const id = String(values?.[0]);
          if (insertedOrderIds.has(id)) return { rowCount: 0 };
          insertedOrderIds.add(id);
          return { rowCount: 1 };
        }
        if (/^INSERT INTO fills/.test(sql.trim())) {
          const id = String(values?.[0]);
          if (insertedFillIds.has(id)) return { rowCount: 0 };
          insertedFillIds.add(id);
          return { rowCount: 1 };
        }
        return { rowCount: 0 };
      },
      release: () => undefined,
    }),
    end: async () => undefined,
  };
  try {
    const atMs = Date.parse("2026-08-28T16:00:00.000Z");
    const historicalOrder = {
      clientOrderId: "paper-history", decisionId: "decision", alpacaOrderId: "remote", historical: true,
      symbol: "BTC/USD", side: 1 as const, style: "maker", timeInForce: "gtc", status: "FILLED",
      statusLabel: "Filled", terminal: true, requestedQty: .001, filledQty: .001, remainingQty: 0,
      fillPercent: 100, averageFillPx: 80_000, limitPx: 80_000, expectedValue: 1, fillProbability: .1,
      expectedCost: { roundTripBps: 7, spreadBps: 1, feeBps: 7, impactBps: 0, latencyBps: 0,
        adverseSelectionBps: 0, fundingBps: 0, borrowBps: 0 },
      reduceOnlyIntent: false, createdMs: atMs, expiresMs: atMs + 1_000, updatedMs: atMs + 500,
      ageMs: 1_000, expiresInMs: 0, error: null, cancelRequestReason: null, cancellationReason: null,
      timeline: [], livePosition: null,
    };
    const historicalFill = { id: "fill-history", clientOrderId: "paper-history", symbol: "BTC/USD", side: 1 as const,
      qty: .001, price: 80_000, final: true, atMs: atMs + 500 };
    const result = await store.backfillHistoricalOrders([historicalOrder], [historicalFill]);
    assert.deepEqual(result, { ordersInserted: 1, fillsInserted: 1 });
    assert.equal(queries[0]?.sql, "BEGIN");
    assert.match(queries[1]?.sql ?? "", /VALUES \(\$1,NULL/);
    assert.match(queries.at(-2)?.sql ?? "", /ON CONFLICT \(execution_id\) DO NOTHING/);
    assert.equal(queries.at(-1)?.sql, "COMMIT");
    queries.length = 0;
    const repeated = await store.backfillHistoricalOrders([historicalOrder], [historicalFill]);
    assert.deepEqual(repeated, { ordersInserted: 0, fillsInserted: 0 });
    const refresh = queries.find(({ sql }) => /^UPDATE orders/.test(sql.trim()));
    assert.match(refresh?.sql ?? "", /run_id IS NULL/);
    assert.match(refresh?.sql ?? "", /plan IS DISTINCT FROM/);
  } finally {
    await store.close();
    await originalPool.end();
  }
});
