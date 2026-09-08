import assert from "node:assert/strict";
import test from "node:test";
import type { RecordedEvent } from "../src/backtest/replay.js";
import type { AssetRules } from "../src/execution/planner.js";
import { StudyEngine, type StudyProtocol } from "../src/distribution/study.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS, DISTRIBUTION_SPEC as S,
  type DistributionSample } from "../src/distribution/spec.js";

const DAY = 86_400_000, START = 10 * DAY, WARM = 1_800_000;
const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const assets: Record<string, AssetRules> = Object.fromEntries(S.symbols.map(symbol => [symbol, {
  symbol, minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .01, maximumOrderQty: 1, shortable: true,
}]));
function protocol(startMs = START, endMs = startMs + 2 * DAY): StudyProtocol {
  return { version: "conditional-study-v1", startMs, endMs, costs, assets, minimumTrainingDays: 3, mode: "DEVELOPMENT" };
}
function quote(atMs: number, symbol: string = "BTC/USD", mid = 100): RecordedEvent {
  return { kind: "BOOK", delta: { symbol, receiveTsMs: atMs, exchangeTsMs: atMs,
    sourceId: `${symbol}:${atMs}`, reset: true,
    bids: [{ px: mid - .005, qty: 1 }], asks: [{ px: mid + .005, qty: 1 }] } };
}
function feed(engine: StudyEngine, first: number, last: number, step = 1000): void {
  for (let atMs = first; atMs <= last; atMs += step) for (const symbol of S.symbols) engine.onEvent(quote(atMs, symbol));
}
interface AuditRow {
  kind: string; policy?: string; symbol?: string; atMs?: number; actionId?: string;
  trainer?: string; learned?: boolean; sample?: DistributionSample;
  predictions?: Array<{ actionId: string; forecast: Array<{ current: number | null; efficient: number | null }> }>;
}
const drain = (engine: StudyEngine): AuditRow[] => engine.drainAudit() as AuditRow[];
function seeds(): DistributionSample[] {
  const rows: DistributionSample[] = [];
  for (let day = 7; day < 10; day++) for (let i = 0; i < 30; i++) {
    const signalAtMs = day * DAY + i * S.proposalIntervalMs;
    for (const symbol of S.symbols) for (const action of DISTRIBUTION_ACTIONS) {
      const netBps = action.id === "long-5m" ? 25 : -25;
      rows.push({ id: `${symbol}:${action.id}:${signalAtMs}`, symbol, actionId: action.id, signalAtMs,
        completedAtMs: signalAtMs + 1_802_000, features: Array<number>(12).fill(0),
        outcomes: DISTRIBUTION_SCENARIOS.map(scenario => ({ scenario: scenario.id, status: "FILLED",
          netBps, grossBps: netBps + 15, filledFraction: 1,
          entryAtMs: signalAtMs + scenario.latencyMs,
          exitAtMs: signalAtMs + action.horizonMs + 2 * scenario.latencyMs, reason: "DEADLINE" })) });
    }
  }
  return rows;
}

test("actual paired market warmup produces independent training while same-day forecast banks stay frozen", () => {
  const engine = new StudyEngine(protocol(), []);
  feed(engine, START - WARM, START - 1000);
  assert.equal(engine.report().quality.readyEvaluations, 0);
  assert.equal(engine.report().training.efficient.startedActions, 0);
  feed(engine, START, START + 1_862_000);
  const report = engine.report(), audit = drain(engine);
  assert.ok(report.quality.readyEvaluations > 1000);
  assert.ok(report.training.efficient.learning.acceptedSamples > report.training.current.learning.acceptedSamples);
  assert.equal(report.freezes.length, 1);
  assert.equal(report.freezes[0]!.cutoffMs, START);
  assert.equal(report.freezes[0]!.current.samples, 0);
  assert.equal(report.freezes[0]!.efficient.samples, 0);
  const forecasts = audit.filter(row => row.kind === "PROBE_FORECAST");
  assert.ok(forecasts.some(row => row.atMs! >= START + S.proposalIntervalMs));
  assert.ok(forecasts.every(row => row.predictions!.every(path => path.forecast.every(f => f.current === null && f.efficient === null))),
    "newly completed same-day labels cannot enter the frozen inference bank");
  assert.equal(report.brokerOrdersSubmitted, 0);
  assert.equal(report.profitabilityEstablished, false); assert.equal(report.deploymentReady, false);
  assert.deepEqual(drain(engine), [], "audit rows can be drained without retaining an ever-growing event log");
  feed(engine, START + DAY, START + DAY);
  const next = engine.report().freezes.at(-1)!;
  assert.equal(next.cutoffMs, START + DAY);
  assert.ok(next.efficient.samples > next.current.samples && next.current.samples > 0);
  assert.ok(next.current.latestCompletedMs! < next.cutoffMs && next.efficient.latestCompletedMs! < next.cutoffMs);
  engine.finish(START + DAY, "SOURCE_END");
  assert.equal(engine.report().status, "INCONCLUSIVE");
});

test("UTC refresh excludes outcomes completing on the cutoff quote and admits only strictly preceding labels", () => {
  const boundary = START + DAY, origin = boundary - 302_000, first = origin - WARM;
  const engine = new StudyEngine(protocol(first), []);
  feed(engine, first, boundary - 1000);
  assert.equal(engine.report().training.efficient.learning.acceptedSamples, 0);
  feed(engine, boundary, boundary);
  const report = engine.report(), frozen = report.freezes.at(-1)!;
  assert.equal(frozen.cutoffMs, boundary);
  assert.equal(frozen.efficient.samples, 0);
  assert.equal(report.training.efficient.learning.acceptedSamples, 4);
  const completed = drain(engine).filter(row => row.kind === "TRAINING" && row.trainer === "efficient" && row.learned);
  assert.equal(completed.length, 4);
  assert.ok(completed.every(row => row.sample!.completedAtMs === boundary));
  feed(engine, boundary + 1000, boundary + 2000);
  assert.deepEqual(engine.report().freezes.at(-1), frozen, "later quotes in that day cannot revise the cutoff snapshot");
  engine.finish(boundary + 2000, "SOURCE_END");
});

test("policy positions share a BTC/ETH slot and cannot reenter on their completion quote", () => {
  const engine = new StudyEngine(protocol(), []);
  feed(engine, START - WARM, START + 902_000);
  const first = drain(engine).filter(row => row.kind === "SELECTION");
  for (const policy of ["long-15m", "short-15m"]) {
    assert.deepEqual(first.filter(row => row.policy === policy).map(row => [row.symbol, row.atMs]), [["BTC/USD", START]],
      "the peer symbol and both completion-time quotes must leave the same global slot unavailable");
    const row = engine.report().policies.find(row => row.policy === policy && row.symbol === "BTC/USD" && row.scenario === "base-250ms")!;
    assert.equal(row.filled, 1); assert.equal(row.selections, 1); assert.ok(row.knownNetBpsSum < 0);
  }
  feed(engine, START + 903_000, START + 903_000);
  const second = drain(engine).filter(row => row.kind === "SELECTION");
  for (const policy of ["long-15m", "short-15m"]) {
    assert.deepEqual(second.filter(row => row.policy === policy).map(row => [row.symbol, row.atMs]), [["BTC/USD", START + 903_000]]);
  }
  assert.ok(engine.report().policies.filter(row => row.policy === "flat").every(row => row.selections === 0 && row.knownNetBpsSum === 0));
  engine.finish(START + 903_000, "SOURCE_END");
  assert.equal(engine.report().pendingSelections, 0); assert.equal(engine.report().pendingProbes, 0);
});

test("a recorded missing path remains unknown and cannot be counted as zero-return performance", () => {
  const engine = new StudyEngine(protocol(), []);
  feed(engine, START - WARM, START);
  feed(engine, START + 250, START + 750, 250);
  engine.onEvent({ kind: "DISCONNECT", stream: "private", receiveTsMs: START + 800 });
  assert.equal(engine.report().quality.disconnects, 0);
  engine.onEvent({ kind: "RECORDER_GAP", receiveTsMs: START + 1000, droppedEvents: 6, droppedBytes: 200 });
  const report = engine.report();
  assert.equal(report.quality.recorderGaps, 1);
  for (const policy of ["long-15m", "short-15m"]) {
    const rows = report.policies.filter(row => row.policy === policy && row.symbol === "BTC/USD");
    assert.ok(rows.every(row => row.selections === 1 && row.unknown === 1 && row.filled === 0 && row.unfilled === 0));
    assert.ok(rows.every(row => row.knownNetBpsSum === 0 && row.fullPathKnownNetBpsSum === null && row.knownMeanNetBps === null));
  }
  assert.ok(report.predictions.every(row => row.probes === 1 && row.unknown === 1 && row.paired === 0));
  engine.finish(START + 1000, "SOURCE_END");
  assert.equal(engine.report().status, "INCONCLUSIVE");
});

test("seed admission rejects future labels and replay starting before training completion", () => {
  const rows = seeds(), future = structuredClone(rows.at(-1)!);
  future.completedAtMs = START;
  assert.throws(() => new StudyEngine(protocol(), [...rows.slice(0, -1), future]), /FUTURE_SEED/);
  assert.throws(() => new StudyEngine(protocol(), [...rows, rows[0]!]), /TRAINING_BANK/);
  const engine = new StudyEngine(protocol(), rows);
  assert.throws(() => engine.onEvent(quote(rows.at(-1)!.completedAtMs)), /SEED_LEAKS_INTO_INPUT/);
  assert.throws(() => new StudyEngine({ ...protocol(), minimumTrainingDays: 4 } as never, []), /PROTOCOL/);
  assert.throws(() => new StudyEngine({ ...protocol(), mode: "PROSPECTIVE", endMs: START + DAY }, []), /PROTOCOL/);
});

test("both conditional policies use the identical frozen seed until the next daily refresh", () => {
  const rows = seeds(), engine = new StudyEngine(protocol(), rows);
  feed(engine, START - WARM, START + 1_862_000);
  const report = engine.report(), audit = drain(engine), freeze = report.freezes[0]!;
  assert.equal(freeze.current.samples, rows.length); assert.equal(freeze.efficient.samples, rows.length);
  assert.ok(report.training.efficient.learning.acceptedSamples > rows.length);
  const forecasts = audit.filter(row => row.kind === "PROBE_FORECAST");
  assert.ok(forecasts.length >= 4);
  for (const forecast of forecasts) for (const path of forecast.predictions!) for (const f of path.forecast) {
    assert.ok(Number.isFinite(f.current) && Number.isFinite(f.efficient));
    assert.equal(f.current, f.efficient, "different same-day collection cannot alter either frozen seed forecast");
  }
  for (const policy of ["current", "efficient"]) {
    assert.ok(audit.some(row => row.kind === "SELECTION" && row.policy === policy), "seeded positive conditional scores are exercised");
  }
  const original = structuredClone(freeze);
  rows[0]!.features[0] = 1; rows[0]!.outcomes[0]!.netBps = -1000;
  assert.deepEqual(engine.report().freezes[0], original);
  engine.finish(START + 1_862_000, "SOURCE_END");
});

test("study end cannot use later quotes to complete a pending observed path or imply effectiveness", () => {
  const endMs = START + 2 * S.proposalIntervalMs, engine = new StudyEngine(protocol(START, endMs), []);
  feed(engine, START - WARM, START);
  engine.onEvent(quote(endMs + 1000));
  assert.equal(engine.report().quality.lastMs, endMs + 1000);
  assert.equal(engine.report().quality.readyEvaluations, 2);
  engine.finish(endMs + 1000, "STUDY_END");
  const report = engine.report();
  assert.equal(report.status, "INCONCLUSIVE");
  assert.equal(report.pendingSelections, 0); assert.equal(report.brokerOrdersSubmitted, 0);
  assert.ok(report.policies.filter(row => row.policy === "long-15m" && row.symbol === "BTC/USD").every(row => row.unknown === 1));
  assert.throws(() => engine.onEvent(quote(endMs + 2000)), /ALREADY_FINISHED/);
});
