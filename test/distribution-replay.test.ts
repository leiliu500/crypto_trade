import assert from "node:assert/strict";
import test from "node:test";
import type { RecordedEvent } from "../src/backtest/replay.js";
import type { BookState } from "../src/core/market.js";
import type { SelectedPolicyOutcome } from "../src/distribution/controller.js";
import { assessDistributionReplay, replayDistribution, type DistributionReplayController } from "../src/distribution/replay.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS, DISTRIBUTION_SPEC,
  type DistributionDecision, type DistributionSample } from "../src/distribution/spec.js";

const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const assets = Object.fromEntries(Object.keys(costs).map(symbol => [symbol,
  { symbol, minOrderSize: .0001, minTradeIncrement: .0001, priceIncrement: .1, maximumOrderQty: 100, shortable: true }]));
const boundaries = { validationStartMs: 1_000, laterStartMs: 10_000 };
function decision(atMs: number, actionId: string | null = "long-5m"): DistributionDecision {
  return { version: DISTRIBUTION_SPEC.version, symbol: "BTC/USD", atMs, quoteSequence: String(atMs),
    referenceBid: 100, referenceAsk: 100.1, requestedQty: .1, feeBps: 5, reserveBps: 3,
    features: Array(12).fill(0), estimates: [], actionId, reason: "TEST", paperReady: false,
    validation: { selections: 0, observedDays: 0, lowerNetBps: null, ready: false } };
}
function panel(atMs: number, completedAtMs: number): DistributionSample[] {
  return DISTRIBUTION_ACTIONS.map(action => ({ id: `${atMs}-${action.id}`, symbol: "BTC/USD", actionId: action.id,
    signalAtMs: atMs, completedAtMs, features: Array(12).fill(0), outcomes: DISTRIBUTION_SCENARIOS.map(scenario => ({
      scenario: scenario.id, status: "FILLED", netBps: action.side === 1 ? 8 : -30, grossBps: 20,
      filledFraction: 1, entryAtMs: atMs + 250, exitAtMs: completedAtMs, reason: "DEADLINE" })) }));
}

test("distribution comparisons exclude an entire opportunity when any of its eighteen paths is unavailable", () => {
  const incomplete = panel(2_000, 4_000);
  incomplete.at(-1)!.outcomes.at(-1)!.status = "INVALID";
  incomplete.at(-1)!.outcomes.at(-1)!.netBps = null;
  const result = assessDistributionReplay([decision(2_000), decision(5_000)], [...incomplete, ...panel(5_000, 8_000)], boundaries);
  assert.equal(result.completeCommonOpportunities, 1);
  assert.equal(result.incompleteOrInvalidOpportunities, 1);
  assert.ok(result.actionComparisons.filter(r => r.symbol === "BTC/USD" && r.period === "VALIDATION")
    .every(r => r.commonOpportunities === 1));
  const selected = result.selected.find(r => r.symbol === "BTC/USD" && r.period === "VALIDATION")!;
  assert.equal(selected.selectedMeanNetBps, 8); // Its chosen path is independently known.
  assert.equal(selected.commonOpportunities, 1);
});

test("invalid selected outcomes remain unknown while flat and genuine nonfills retain zero", () => {
  const samples = panel(2_000, 4_000);
  samples[0]!.outcomes[0]!.status = "INVALID";
  samples[0]!.outcomes[0]!.netBps = null;
  const nofill = panel(5_000, 8_000);
  for (const o of nofill[0]!.outcomes) { o.status = "UNFILLED"; o.netBps = 0; o.grossBps = 0; o.filledFraction = 0; o.entryAtMs = null; }
  const result = assessDistributionReplay([decision(2_000), decision(5_000), decision(8_000, null)], [...samples, ...nofill], boundaries);
  const selected = result.selected.find(r => r.period === "VALIDATION" && r.symbol === "BTC/USD" && r.scenario === "base-250ms")!;
  assert.equal(selected.selectedInvalidOrMissing, 1); assert.equal(selected.selectedMeanNetBps, null);
  assert.equal(selected.unfilled, 1); assert.equal(selected.flat, 1);
  assert.equal(selected.commonSelectedMeanNetBps, 0);
});

test("later-period boundary purges all actions together, including a short action that already completed", () => {
  const crossed = panel(9_000, 11_000); crossed[0]!.completedAtMs = 9_800;
  for (const o of crossed[0]!.outcomes) o.exitAtMs = 9_800;
  const result = assessDistributionReplay([decision(9_000), decision(12_000, null)], [...crossed, ...panel(12_000, 15_000)], boundaries);
  assert.equal(result.boundaryPurgedOpportunities, 1);
  assert.ok(result.actionComparisons.filter(r => r.period === "VALIDATION").every(r => r.commonOpportunities === 0 && r.meanNetBps === null));
  const later = result.selected.find(r => r.period === "LATER" && r.symbol === "BTC/USD")!;
  assert.equal(later.filled, 0); assert.equal(later.commonSelectedMeanNetBps, 0); assert.equal(later.flat, 1);
});

test("raw replay rebuilds depth, skips duplicates, and requires reset after explicit missing or reversed events", async () => {
  const seen: BookState[] = [], invalidated: string[] = [];
  let trades = 0;
  const controller = { onBook: (b: BookState) => { seen.push(b); return { decision: null, samples: [] }; },
    onTrade: () => { trades++; }, invalidate: (_now: number, reason: string) => { invalidated.push(reason); return []; },
    stats: () => ({}) } as unknown as DistributionReplayController;
  const book = (now: number, reset: boolean, id = String(now)): RecordedEvent => ({ kind: "BOOK", delta: {
    symbol: "BTC/USD", bids: reset ? [{ px: 100, qty: 1 }, { px: 99, qty: 2 }] : [{ px: 99, qty: 5 }],
    asks: reset ? [{ px: 101, qty: 3 }] : [], exchangeTsMs: now, receiveTsMs: now, reset, sourceId: id } });
  const events: RecordedEvent[] = [book(1_000, true), book(1_100, false), book(1_100, false),
    { kind: "TRADE", trade: { id: "t1", symbol: "BTC/USD", px: 101, qty: 1, aggressor: 1, exchangeTsMs: 1_200, receiveTsMs: 1_200 } },
    { kind: "RECORDER_GAP", receiveTsMs: 1_300, droppedEvents: 10, droppedBytes: 100 },
    book(1_400, false), book(1_500, true), book(1_450, false), book(1_600, false), book(1_700, true)];
  const report = await replayDistribution(events, costs, assets, boundaries, controller);
  assert.equal(trades, 1); assert.equal(seen.length, 4);
  assert.deepEqual(seen[1]!.bids.map(l => [l.px, l.qty]), [[100, 1], [99, 5]]);
  assert.equal(report.quality.duplicates, 1); assert.equal(report.quality.recorderDroppedEvents, 10);
  assert.equal(report.quality.timestampReversals, 1); assert.equal(report.quality.invalidBooks, 2);
  assert.ok(invalidated.includes("RECORDER_GAP")); assert.ok(invalidated.includes("RECEIVE_TIMESTAMP_REVERSAL"));
  assert.equal(invalidated.at(-1), "REPLAY_END"); assert.equal(report.profitabilityEstablished, false);
});

test("empty distribution data and malformed splits cannot manufacture a profitable replay", async () => {
  await assert.rejects(replayDistribution([], costs, assets, { validationStartMs: 10, laterStartMs: 9 }), /INVALID.*BOUNDARIES/);
  const report = await replayDistribution([], costs, assets, boundaries);
  assert.equal(report.opportunities, 0); assert.equal(report.deploymentReady, false);
  assert.ok(report.selected.every(r => r.selectedMeanNetBps === null && r.filled === 0));
  await assert.rejects(replayDistribution([{ kind: "quotes" } as never], costs, assets, boundaries), /INVALID_RECORDED_EVENT_KIND/);
});

test("private broker disconnects preserve public training paths; public disconnects invalidate them", async () => {
  const faults: string[] = [];
  const controller = { onBook: () => ({ decision: null, samples: [] }), onTrade: () => {},
    invalidate: (_at: number, reason: string) => { faults.push(reason); return []; },
    stats: () => ({}) } as unknown as DistributionReplayController;
  const report = await replayDistribution([
    { kind: "DISCONNECT", stream: "private", receiveTsMs: 1_000 },
    { kind: "DISCONNECT", stream: "public", receiveTsMs: 1_100 },
  ], costs, assets, boundaries, controller);
  assert.deepEqual(faults, ["DISCONNECT", "REPLAY_END"]);
  assert.equal(report.quality.disconnects, 1);
});

test("batched cross-symbol receipt times preserve recorded engine order without false outage or sorting", async () => {
  const seen: string[] = [], faults: string[] = [];
  const controller = { onBook: (b: BookState) => { seen.push(`${b.symbol}:${b.receiveTsMs}`); return { decision: null, samples: [] }; },
    onTrade: () => {}, invalidate: (_at: number, reason: string) => { faults.push(reason); return []; },
    stats: () => ({}) } as unknown as DistributionReplayController;
  const events: RecordedEvent[] = [["ETH/USD", 1_010], ["BTC/USD", 1_005], ["ETH/USD", 1_020], ["BTC/USD", 1_015]].map(([symbol, at]) => ({
    kind: "BOOK", delta: { symbol: String(symbol), receiveTsMs: Number(at), exchangeTsMs: Number(at),
      sourceId: `${symbol}-${at}`, reset: true, bids: [{ px: 100, qty: 1 }], asks: [{ px: 101, qty: 1 }] } }));
  const report = await replayDistribution(events, costs, assets, boundaries, controller);
  assert.deepEqual(seen, ["ETH/USD:1010", "BTC/USD:1005", "ETH/USD:1020", "BTC/USD:1015"]);
  assert.deepEqual(faults, ["REPLAY_END"]);
  assert.equal(report.quality.timestampReversals, 0); assert.equal(report.quality.crossStreamReceiveRegressions, 2);
  assert.equal(report.quality.lastMs, 1_020);
});

function rawBook(atMs: number): RecordedEvent {
  return { kind: "BOOK", delta: { symbol: "BTC/USD", receiveTsMs: atMs, exchangeTsMs: atMs,
    sourceId: String(atMs), reset: true, bids: [{ px: 100, qty: 1 }], asks: [{ px: 101, qty: 1 }] } };
}
function chosenOutcome(d: DistributionDecision, completedAtMs: number): SelectedPolicyOutcome {
  const sample = panel(d.atMs, completedAtMs).find(s => s.actionId === d.actionId)!;
  return { sample, decision: structuredClone(d), valid: true };
}
type Update = ReturnType<DistributionReplayController["onBook"]>;
function scriptedController(updates: ReadonlyMap<number, Partial<Update>>,
  invalidation?: (reason: string) => SelectedPolicyOutcome[]) {
  let selections: SelectedPolicyOutcome[] = [];
  return { onBook: (book: BookState) => ({ decision: null, trainingDecision: null, samples: [], selections: [],
    ...updates.get(book.receiveTsMs) }), onTrade: () => {},
  invalidate: (_atMs: number, reason: string) => { selections = invalidation?.(reason) ?? []; return []; },
  drainSelections: () => { const rows = selections; selections = []; return rows; },
  stats: () => ({}) } as unknown as DistributionReplayController;
}

test("continuous inference and standalone selected paths do not fabricate missing six-action training panels", async () => {
  const selected = decision(3_000), updates = new Map<number, Partial<Update>>();
  for (let atMs = 2_000; atMs <= 9_000; atMs += 1_000) updates.set(atMs, {
    decision: atMs === 3_000 ? selected : decision(atMs, null),
    ...(atMs === 2_000 ? { trainingDecision: decision(atMs, null) } : {}),
    ...(atMs === 6_000 ? { selections: [chosenOutcome(selected, atMs)] } : {}),
    ...(atMs === 9_000 ? { samples: panel(2_000, atMs) } : {}),
  });
  const report = await replayDistribution([...updates.keys()].map(rawBook), costs, assets,
    { ...boundaries, includeOutcomes: true }, scriptedController(updates));
  assert.equal(report.inferenceDecisions, 8); assert.equal(report.trainingOpportunities, 1);
  assert.equal(report.completeCommonOpportunities, 1); assert.equal(report.incompleteOrInvalidOpportunities, 0);
  assert.equal(report.selectedDecisions, 1); assert.equal(report.selectedOutcomes, 1);
  assert.equal(report.decisions?.length, 8); assert.equal(report.trainingDecisions?.length, 1);
  assert.equal(report.samples?.length, 6); assert.equal(report.selections?.length, 1);
  assert.equal(report.samples?.some(s => s.signalAtMs === selected.atMs), false, "selected path is not a training label");
  const row = report.selected.find(r => r.period === "VALIDATION" && r.symbol === "BTC/USD" && r.scenario === "base-250ms")!;
  assert.equal(row.selectedActions, 1); assert.equal(row.flat, 7);
  assert.equal(row.selectedInvalidOrMissing, 0); assert.equal(row.selectedMeanNetBps, 1);
  assert.equal(row.selectedActionMeanNetBps, 8);
  assert.ok(report.actionComparisons.filter(r => r.period === "VALIDATION" && r.symbol === "BTC/USD")
    .every(r => r.commonOpportunities === 1));
});

test("selected boundary purge follows the chosen path even when its independent 30-minute training panel crosses", async () => {
  const selected = decision(9_000);
  const report = await replayDistribution([9_000, 9_800, 11_000].map(rawBook), costs, assets, boundaries,
    scriptedController(new Map([
      [9_000, { decision: selected, trainingDecision: decision(9_000, null) }],
      [9_800, { selections: [chosenOutcome(selected, 9_800)] }],
      [11_000, { samples: panel(9_000, 11_000) }],
    ])));
  assert.equal(report.boundaryPurgedOpportunities, 1);
  assert.ok(report.actionComparisons.filter(r => r.period === "VALIDATION").every(r => r.commonOpportunities === 0));
  const row = report.selected.find(r => r.period === "VALIDATION" && r.symbol === "BTC/USD")!;
  assert.equal(row.boundaryPurged, 0); assert.equal(row.selectedActions, 1);
  assert.equal(row.selectedMeanNetBps, 8);
  const crossed = await replayDistribution([9_000, 11_000].map(rawBook), costs, assets, boundaries,
    scriptedController(new Map([[9_000, { decision: selected }], [11_000, { selections: [chosenOutcome(selected, 11_000)] }]])));
  const purged = crossed.selected.find(r => r.period === "VALIDATION" && r.symbol === "BTC/USD")!;
  assert.equal(purged.boundaryPurged, 1); assert.equal(purged.evaluatedOpportunities, 0);
  assert.equal(purged.selectedMeanNetBps, null);
});

test("standalone selected invalids remain unknown while genuine nonfills and flat decisions remain zero", async () => {
  const first = decision(2_000), second = decision(5_000), bad = chosenOutcome(first, 4_000), unfilled = chosenOutcome(second, 8_000);
  bad.valid = false; bad.sample.outcomes[0]!.status = "INVALID"; bad.sample.outcomes[0]!.netBps = null;
  bad.sample.outcomes[0]!.reason = "MISSING_EXIT_BOOK";
  for (const path of unfilled.sample.outcomes) Object.assign(path, {
    status: "UNFILLED", netBps: 0, grossBps: 0, filledFraction: 0, entryAtMs: null, reason: "IOC_UNFILLED",
  });
  const report = await replayDistribution([2_000, 4_000, 5_000, 8_000, 9_000].map(rawBook), costs, assets, boundaries,
    scriptedController(new Map([
      [2_000, { decision: first }], [4_000, { selections: [bad] }], [5_000, { decision: second }],
      [8_000, { selections: [unfilled] }], [9_000, { decision: decision(9_000, null) }],
    ])));
  const row = report.selected.find(r => r.period === "VALIDATION" && r.symbol === "BTC/USD" && r.scenario === "base-250ms")!;
  assert.equal(row.selectedInvalidOrMissing, 1); assert.equal(row.selectedPolicyInvalid, 1);
  assert.equal(row.selectedMeanNetBps, null); assert.equal(row.selectedActionMeanNetBps, null);
  assert.equal(row.unfilled, 1); assert.equal(row.flat, 1);
  assert.equal(report.selectedInvalidReasons.MISSING_EXIT_BOOK, 1);
  assert.equal(report.trainingOpportunities, 0); assert.equal(report.incompleteOrInvalidOpportunities, 0);
});

test("recorder invalidation drains the selected ledger and a missing final selected path is reported as unknown", async () => {
  const selected = decision(2_000), invalid = chosenOutcome(selected, 3_000);
  invalid.valid = false;
  for (const path of invalid.sample.outcomes) Object.assign(path, { status: "INVALID", netBps: null, reason: "RECORDER_GAP" });
  const report = await replayDistribution([rawBook(2_000), { kind: "RECORDER_GAP", receiveTsMs: 3_000,
    droppedEvents: 1, droppedBytes: 10 }], costs, assets, boundaries,
  scriptedController(new Map([[2_000, { decision: selected }]]), reason => reason === "RECORDER_GAP" ? [invalid] : []));
  assert.equal(report.selectedOutcomes, 1); assert.equal(report.missingSelectedOutcomes, 0);
  assert.equal(report.selectedInvalidReasons.RECORDER_GAP, 3);
  assert.ok(report.selected.filter(r => r.period === "VALIDATION" && r.symbol === "BTC/USD")
    .every(r => r.selectedInvalidOrMissing === 1 && r.selectedMeanNetBps === null));
  const missing = await replayDistribution([rawBook(2_000)], costs, assets, boundaries,
    scriptedController(new Map([[2_000, { decision: selected }]])));
  assert.equal(missing.missingSelectedOutcomes, 1);
  assert.ok(missing.selected.filter(r => r.period === "VALIDATION" && r.symbol === "BTC/USD")
    .every(r => r.selectedInvalidOrMissing === 1 && r.selectedActionMeanNetBps === null));
});

test("default replay aggregates frequent flat decisions without retaining them and matches explicit full outcomes", async () => {
  const count = 2_000;
  function* events() { for (let i = 0; i < count; i++) yield rawBook(2_000 + i * 1_000); }
  const controller = () => ({ onBook: (book: BookState) => ({ decision: decision(book.receiveTsMs, null),
    trainingDecision: book.receiveTsMs === 2_000 ? decision(2_000, null) : null, samples: [], selections: [] }),
  onTrade: () => {}, invalidate: () => [], drainSelections: () => [], stats: () => ({}) }) as unknown as DistributionReplayController;
  const options = { validationStartMs: 1_000, laterStartMs: 10_000_000 };
  const aggregated = await replayDistribution(events(), costs, assets, options, controller());
  const full = await replayDistribution(events(), costs, assets, { ...options, includeOutcomes: true }, controller());
  assert.equal(aggregated.inferenceDecisions, count); assert.equal(aggregated.decisionReasons.TEST, count);
  assert.equal(aggregated.outcomeRetention.retainedInferenceDecisions, 0);
  assert.equal(aggregated.outcomeRetention.retainedTrainingSamples, 0);
  assert.equal(Object.hasOwn(aggregated, "decisions"), false);
  assert.equal(aggregated.maximumPendingTrainingPanels, 1); assert.equal(aggregated.maximumPendingSelections, 0);
  assert.equal(aggregated.incompleteOrInvalidOpportunities, 1, "unresolved training panel is counted once, not once per inference");
  assert.equal(full.decisions?.length, count);
  assert.deepEqual(aggregated.selected, full.selected);
  assert.deepEqual(aggregated.actionComparisons, full.actionComparisons);
  const row = aggregated.selected.find(r => r.period === "VALIDATION" && r.symbol === "BTC/USD")!;
  assert.equal(row.flat, count); assert.equal(row.selectedMeanNetBps, 0); assert.equal(row.selectedActionMeanNetBps, null);
});
