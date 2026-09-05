import assert from "node:assert/strict";
import test from "node:test";
import type { BookState } from "../src/core/market.js";
import type { RecordedEvent } from "../src/backtest/replay.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";
import type { AssetRules } from "../src/execution/planner.js";
import { PolicyCollector, type PolicyObservation } from "../src/research/policy-collector.js";
import { POLICY_VERSION, findPolicy } from "../src/research/trading-policy.js";
import { EPISODE_VERSION, EXECUTION_SCENARIOS, ExecutionStressCase, stressObservation,
  type EpisodeContext, type EpisodeObservation } from "../src/research/execution-stress.js";
import { SignalEpisodeCollector } from "../src/research/signal-episodes.js";
import { buildEpisodeReport, episodeStatistics } from "../src/research/episode-report.js";
import { replayEpisodeExecutions } from "../src/research/episode-replay.js";
import { evaluatePolicies, validPolicyOutcome } from "../src/research/policy-validation.js";
import { EpisodeResearchStore } from "../src/research/episode-store.js";
import { PostgresTelemetryStore } from "../src/database/postgres-store.js";
import type { DashboardEvent } from "../src/dashboard/types.js";

const context: EpisodeContext = { healthAllowed: true, healthReasons: [], liquidityPass: true, liquidityReasons: [],
  positionOpen: false, pendingOrder: false, cooldownRemainingMs: 0, sizing: "VENUE_NOTIONAL_ONLY" };
const contexts = { long: context, short: context };
const asset: AssetRules = { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001,
  priceIncrement: .001, maximumOrderQty: 100, shortable: true };
function book(at: number, mid = 100, symbol = "BTC/USD"): BookState {
  return { symbol, bids: [{ px: mid - .005, qty: 10 }], asks: [{ px: mid + .005, qty: 10 }],
    receiveTsMs: at, exchangeTsMs: at, sequence: BigInt(at), sourceReset: false, valid: true };
}
function features(at: number, side: 1 | -1 = 1, mid = 100, symbol = "BTC/USD"): DeterministicFeatures {
  return { symbol, receiveTsMs: at, mid, warmedUp: true, kinematicsReady: true, stale: false, slowTrendReady: true,
    ofi: side, tfi: side, velocityZ: side * 8, impulseBps: side * 1.3, breakoutUpBps: 0, breakoutDownBps: 0,
    trendFastBps: side * 5, trendMediumBps: side * 5, trendSlowBps: side * 5, slowTrendEfficiency: .5,
    spreadBps: 1, anchorDistanceBps: 0, sigmaHBps: 1,
    longPullback: { ready: false }, shortPullback: { ready: false } } as DeterministicFeatures;
}
function source(side: 1 | -1 = 1, at = 1_000): PolicyObservation {
  return { sampling: "ENTRY", id: `source-${at}`, configurationVersion: "config", policyVersion: POLICY_VERSION,
    symbol: "BTC/USD", policyId: "breakout-1m", family: "EARLY_BREAKOUT", side,
    regime: side === 1 ? "BREAKOUT_UP" : "BREAKOUT_DOWN", signalAtMs: at, signalBid: 99.995, signalAsk: 100.005,
    spreadBps: 1, qty: .1, filledQty: 0, entryAtMs: null, entryPrice: null, exitAtMs: null, exitPrice: null,
    feeBps: 5, reserveBps: 3, status: "PENDING", reason: null, grossBps: null, netBps: null, features: {} };
}
function delta(b: BookState, reset = true): RecordedEvent {
  return { kind: "BOOK", delta: { symbol: b.symbol, bids: b.bids, asks: b.asks, reset,
    receiveTsMs: b.receiveTsMs, exchangeTsMs: b.exchangeTsMs, sourceId: `quote-${b.symbol}-${b.receiveTsMs}` } };
}

for (const side of [1, -1] as const) test(`stress baseline matches existing collector for ${side === 1 ? "long" : "short"} fills`, () => {
  const collector = new PolicyCollector("config", "BTC/USD", 5, 3);
  const starts = collector.captureEntry(book(1_000), features(1_000, side), asset,
    { family: "EARLY_BREAKOUT", side, regime: side === 1 ? "BREAKOUT_UP" : "BREAKOUT_DOWN" }, .1);
  const original = starts.find((o) => o.policyId === "breakout-1m")!;
  const start = stressObservation(original, EXECUTION_SCENARIOS[0]!, "episode", "current-breakout", context);
  const c = new ExecutionStressCase(start);
  start.features.changed = 99;
  const expected: PolicyObservation[] = [];
  let outcome: EpisodeObservation | null = null;
  for (const [at, mid] of [[1_249, 100], [1_250, 100], [1_500, 100 + side * .5], [1_750, 100 + side * .5]]) {
    expected.push(...collector.observe(book(at!, mid!), features(at!, side, mid!), asset));
    outcome = c.observe(book(at!, mid!)) ?? outcome;
  }
  const actual = expected.find((o) => o.id === original.id)!;
  assert.ok(outcome);
  for (const field of ["entryPrice", "exitPrice", "entryAtMs", "exitAtMs", "netBps", "grossBps", "reason"] as const) {
    assert.equal(outcome[field], actual[field], field);
  }
  assert.equal(outcome.features.changed, undefined);
  assert.ok(validPolicyOutcome(outcome));
});

test("stress retains nonfills, weights partial fills, and fails closed on missing depth or quotes", () => {
  const create = (scenario = EXECUTION_SCENARIOS[0]!) => new ExecutionStressCase(stressObservation(source(), scenario, "e", "current-breakout", context));
  const nonfill = create();
  assert.equal(nonfill.observe(book(1_249, 101)), null);
  const no = nonfill.observe(book(1_250, 101))!;
  assert.equal(no.reason, "ENTRY_NOT_FILLED"); assert.equal(no.netBps, 0);
  assert.ok(validPolicyOutcome(no));
  const half = create(EXECUTION_SCENARIOS.at(-1)!);
  half.observe({ ...book(1_500), asks: [{ px: 100.005, qty: .06 }, { px: 100.015, qty: 10 }] });
  assert.equal(half.snapshot().filledQty, .03);
  half.observe(book(1_750, 99));
  const partial = half.observe(book(2_250, 99))!;
  assert.equal(partial.reason, "POLICY_STOP");
  assert.ok(validPolicyOutcome(partial, 500));
  const stats = episodeStatistics([no, partial]);
  assert.equal(stats.partialFills, 1); assert.equal(stats.unfilled, 1);
  assert.equal(stats.meanNetBpsPerAttempt, partial.netBps! / 2);
  assert.equal(stats.meanNetBpsPerFill, partial.netBps! / .3);
  const missing = create(); missing.observe(book(1_250));
  assert.equal(missing.observe({ ...book(1_500), bids: [{ px: 99.995, qty: .001 }] })!.reason, "EXIT_DEPTH_UNAVAILABLE");
  assert.equal(create().observe(book(7_000))!.status, "INVALID");
  assert.equal(create().observe(book(2_251))!.reason, "ENTRY_NOT_EXECUTABLE");
  assert.equal(create().observe(book(999))!.status, "INVALID");
  assert.equal(create().observe({ ...book(1_250), asks: [{ px: NaN, qty: 1 }] })!.status, "INVALID");
  assert.throws(() => stressObservation(source(), { ...EXECUTION_SCENARIOS[0]!, latencyMs: -1 }, "e", "h", context));
});

for (const symbol of ["BTC/USD", "ETH/USD"]) for (const side of [1, -1] as const) {
  test(`${symbol} ${side} shadow episodes are distinct, capture through cooldown, and require liquidity`, () => {
    const c = new SignalEpisodeCollector("config", symbol, 5, 3);
    const ctx = { ...context, cooldownRemainingMs: 1_800_000, positionOpen: true, pendingOrder: true };
    const obs = (at: number, f = features(at, side, 100, symbol), allowed = true) => c.observe(book(at, 100, symbol), f,
      { ...asset, symbol }, { long: { ...ctx, liquidityPass: allowed }, short: { ...ctx, liquidityPass: allowed } });
    assert.deepEqual(obs(1_000, undefined, false), []);
    const starts = obs(1_001).filter((o) => o.status === "PENDING");
    assert.equal(starts.length, 10);
    assert.ok(starts.every((o) => o.context.positionOpen && o.context.cooldownRemainingMs > 0));
    for (let at = 2_001; at < 70_000; at += 1_000) assert.equal(obs(at).filter((o) => o.status === "PENDING").length, 0);
    for (let at = 70_001; at <= 76_001; at += 1_000) obs(at, { ...features(at, side, 100, symbol), impulseBps: 0 });
    assert.equal(obs(77_001).filter((o) => o.status === "PENDING").length, 10);
    assert.equal(c.stats().episodes, 2);
    assert.ok(c.invalidate(78_000, "DISCONNECT").every((o) => o.status === "INVALID"));
    assert.equal(c.stats().pending, 0);
    assert.equal(c.observe(book(79_000, 100, symbol), { ...features(79_000, side, 100, symbol), stale: true }, asset, contexts).length, 0);
  });
}

for (const side of [1, -1] as const) test(`multi-minute ${side} hypothesis requires full past range, alignment and persistence`, () => {
  const c = new SignalEpisodeCollector("config", "BTC/USD", 5, 3);
  // A prior 20bps range; no current impulse baseline signals during warmup.
  for (let at = 1_000; at <= 301_000; at += 5_000) {
    const mid = 100 + .1 * Math.sin(at / 10_000);
    c.observe(book(at, mid), { ...features(at, side, mid), impulseBps: 0 }, asset, contexts);
  }
  const mid = 100 + side * .2;
  const obs = (at: number) => c.observe(book(at, mid), { ...features(at, side, mid), impulseBps: 0 }, asset, contexts);
  assert.equal(obs(302_000).filter((o) => o.status === "PENDING").length, 0);
  assert.equal(obs(303_000).filter((o) => o.status === "PENDING").length, 0);
  const starts = obs(304_000).filter((o) => o.status === "PENDING");
  assert.equal(starts.length, 10);
  assert.ok(starts.every((o) => o.hypothesisId === "range-5m-confirmed" && o.side === side));
  assert.equal(obs(305_000).filter((o) => o.status === "PENDING").length, 0);
  assert.ok(starts.every((o) => o.features.rangeBoundary !== mid));
  c.invalidate(306_000, "GAP");
  assert.equal(obs(307_000).filter((o) => o.status === "PENDING").length, 0, "a gap discards range history");
});

test("replay matches baseline, includes every latency scenario, and is deterministic", async () => {
  const original = source();
  const baseline = new ExecutionStressCase(stressObservation(original, EXECUTION_SCENARIOS[0]!, "e", "h", context));
  const quotes = [book(1_000), book(1_250), book(1_500), book(2_000), book(2_250, 100.5), book(2_500, 100.5), book(3_250, 100.5)];
  for (const b of quotes.slice(1)) baseline.observe(b);
  const finished: PolicyObservation = { ...original, ...baseline.snapshot(), id: original.id, sampling: "ENTRY", policyVersion: POLICY_VERSION };
  const replay = await replayEpisodeExecutions(quotes.map((b) => delta(b)), [finished]);
  assert.equal(replay.observations.length, 5);
  assert.equal(replay.baselineParity.compared, 1);
  assert.deepEqual(replay.baselineParity.mismatches, []);
  assert.ok(replay.observations.every((o) => o.status === "COMPLETE"));
  assert.deepEqual(replay, await replayEpisodeExecutions(quotes.map((b) => delta(b)), [finished]));
  assert.equal((await replayEpisodeExecutions([], [finished])).observations[0]!.reason, "SIGNAL_QUOTE_MISSING");
  assert.ok((await replayEpisodeExecutions([delta(book(1_000))], [finished])).observations.every((o) => o.status === "INVALID"));
  const gap: RecordedEvent = { kind: "RECORDER_GAP", receiveTsMs: 1_300, droppedEvents: 1, droppedBytes: 10 };
  assert.ok((await replayEpisodeExecutions([delta(book(1_000)), delta(book(1_250)), gap], [finished])).observations.every((o) => o.status === "INVALID"));
  await assert.rejects(replayEpisodeExecutions([], [original, original]), /Duplicate/);
});

const day = 86_400_000, end = Date.UTC(2026, 8, 20);
function researchData(netFor: (policy: string, scenario: string, at: number) => number = (policy) => policy === "breakout-1m" ? 20 : 10) {
  const rows: EpisodeObservation[] = [];
  for (let hour = 0; hour < 14 * 24; hour++) {
    const at = end - 14 * day + hour * 3_600_000 + 60_000;
    for (const policyId of ["breakout-1m", "breakout-3m"]) for (const scenario of EXECUTION_SCENARIOS) {
      const row = stressObservation({ ...source(1, at), policyId }, scenario, `episode-${hour}`, "range-5m-confirmed", context);
      const net = netFor(policyId, scenario.id, at);
      const entry = row.signalAsk, exit = entry * (10_000 + row.feeBps + row.reserveBps + net) / (10_000 - row.feeBps);
      Object.assign(row, { status: "COMPLETE", reason: "POLICY_DEADLINE", entryAtMs: at + scenario.latencyMs,
        exitAtMs: at + 2 * scenario.latencyMs + findPolicy(policyId)!.horizonMs, entryPrice: entry, exitPrice: exit,
        filledQty: row.qty, netBps: net, grossBps: (exit / entry - 1) * 10_000 });
      rows.push(row);
    }
  }
  return rows;
}

test("research validation requires all paired stresses and never installs an episode model", () => {
  const rows = researchData();
  const report = buildEpisodeReport(rows, end + 1_000);
  assert.equal(report.cohorts.length, 1);
  assert.equal(report.cohorts[0]!.researchQualified, true, JSON.stringify(report.cohorts[0]));
  assert.equal(report.cohorts[0]!.deploymentReady, false);
  assert.equal(report.deploymentReady, false);
  assert.equal(report.episodes, 336, "variants and stresses are not independent episodes");
  assert.equal(evaluatePolicies(rows, "config", end + 1_000).models.length, 0);
  assert.equal(buildEpisodeReport(rows.slice(1), end + 1_000).cohorts[0]!.researchQualified, false);
  const bad = structuredClone(rows); bad[0]!.netBps = 999;
  assert.equal(buildEpisodeReport(bad, end + 1_000).cohorts[0]!.researchQualified, false);
  const sameDay = rows.map((o) => ({ ...o, signalAtMs: end + 1, entryAtMs: end + 251, exitAtMs: end + 180_501 }));
  assert.equal(buildEpisodeReport(sameDay, end + 200_000).cohorts[0]!.researchQualified, false);
});

test("stress and untouched holdout cannot choose a different winning exit", () => {
  const rows = researchData((policy, scenario, at) => {
    if (scenario === "latency-500ms") return policy === "breakout-1m" ? -20 : 100;
    if (at >= end - 3.5 * day) return policy === "breakout-1m" ? -10 : 200;
    return policy === "breakout-1m" ? 20 : 10;
  });
  const report = buildEpisodeReport(rows, end + 1_000), cohort = report.cohorts[0]!;
  assert.equal(cohort.selectedPolicyId, "breakout-1m");
  assert.ok(cohort.scenarios.every((s) => s.evaluation?.selectedPolicyId === "breakout-1m"));
  assert.equal(cohort.researchQualified, false);
  assert.ok(cohort.scenarios[0]!.evaluation!.reasons.includes("NON_POSITIVE_FINAL_HOLDOUT_RETURN"));
});

test("malformed research assumptions or missing context fail qualification without hiding the cohort", () => {
  for (const field of ["scenario", "context"] as const) {
    const rows = researchData();
    Reflect.deleteProperty(rows[0]!, field);
    const cohort = buildEpisodeReport(rows, end + 1_000).cohorts[0]!;
    assert.equal(cohort.researchQualified, false);
    assert.ok(cohort.qualityReasons.includes(field === "scenario" ? "UNKNOWN_EXECUTION_ASSUMPTIONS" : "INELIGIBLE_CANDIDATES"));
  }
  const rows = researchData(); rows[0]!.scenario.depthMultiplier = 10;
  const cohort = buildEpisodeReport(rows, end + 1_000).cohorts[0]!;
  assert.equal(cohort.researchQualified, false);
  assert.equal(cohort.scenarios[0]!.policies[0]!.invalid, 1);
});

test("research episode starts and outcomes use the durable version-isolated observation upsert", async () => {
  const store = new PostgresTelemetryStore({ connectionString: "postgres://unused", flushIntervalMs: 60_000, maximumQueue: 10 });
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = { query: async (sql: string, values: readonly unknown[]) => { calls.push({ sql, values }); return { rows: [] }; } };
  const internals = store as unknown as {
    persistEvent: (client: unknown, event: DashboardEvent, runId: string, atMs: number) => Promise<void>;
  };
  const start = stressObservation(source(), EXECUTION_SCENARIOS[0]!, "episode", "current-breakout", context);
  const simulation = new ExecutionStressCase(start);
  const outcome = simulation.observe(book(1_250, 101))!;
  try {
    for (const payload of [start, outcome]) {
      await internals.persistEvent(client, { type: "researchEpisode", payload } as unknown as DashboardEvent, "run", 1_250);
    }
    const upserts = calls.filter((c) => c.sql.includes("INSERT INTO policy_observations"));
    assert.equal(upserts.length, 2);
    assert.deepEqual(upserts.map((c) => c.values[7]), ["PENDING", "COMPLETE"]);
    for (const call of upserts) {
      assert.equal(call.values[0], start.id);
      assert.equal(call.values[3], EPISODE_VERSION);
      assert.equal(JSON.parse(String(call.values[8])).sampling, "EPISODE");
      assert.match(call.sql, /ON CONFLICT\(id\) DO UPDATE/);
      assert.match(call.sql, /WHERE policy_observations.status='PENDING'/);
    }
  } finally { await store.close(); }
});

test("research store is database-enforced read-only and marks dropped runs invalid", async () => {
  const store = new EpisodeResearchStore("postgres://unused");
  const internals = store as unknown as { pool: { options: { options: string }; query: (sql: string, args: unknown[]) => Promise<unknown>; end: () => Promise<void> } };
  const original = internals.pool;
  assert.equal(original.options.options, "-c default_transaction_read_only=on");
  const calls: string[] = [];
  internals.pool = { options: original.options, query: async (sql, args) => {
    calls.push(sql); assert.deepEqual(args, ["config", EPISODE_VERSION, "EPISODE"]);
    return { rows: [{ payload: stressObservation(source(), EXECUTION_SCENARIOS[0]!, "e", "h", context), clean: false }] };
  }, end: async () => undefined };
  try {
    const rows = await store.loadEpisodes("config");
    assert.equal(rows[0]!.status, "INVALID"); assert.equal(rows[0]!.reason, "UNCLEAN_TELEMETRY_RUN");
    assert.ok(calls.every((sql) => !/INSERT|DELETE|UPDATE/.test(sql)));
  } finally { await store.close(); await original.end(); }
});
