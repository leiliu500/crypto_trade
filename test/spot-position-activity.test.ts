import assert from "node:assert/strict";
import test from "node:test";
import { projectSpotOrderActivity, type SpotCommittedActivityCycle } from "../src/dashboard/spot-position-activity.js";
import { createSpotPaperState, type SpotPaperDecision, type SpotPaperState } from "../src/spot-trend/paper.js";
import { executeSpotPaperOrder, submitSpotPaperOrder, type SpotOrderRequest } from "../src/spot-trend/orders.js";
import { markSpotAccount } from "../src/spot-trend/account.js";

const start = 10_000, feeBps = 80;
const initial = (): SpotPaperState => createSpotPaperState("a".repeat(64), start);
const signal: SpotPaperDecision["signal"] = { version: "fixture", state: "long", reason: "TREND_ENTER",
  availableAtMs: 0, lastWeekEndMs: null, close: 100, movingAverage: 90 };
const close = (actual: number | null | undefined, expected: number): void => assert.ok(typeof actual === "number"
  && Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

function submit(state: SpotPaperState, side: "buy" | "sell", quantity: number, price: number, nowMs: number): {
  state: SpotPaperState; cycle: SpotCommittedActivityCycle;
} {
  const request: SpotOrderRequest = { clientOrderId: `activity-${nowMs}-${side}`, symbol: "BTC/USD", side, quantity,
    limitPrice: side === "buy" ? price + .1 : price - .1, createdAtMs: nowMs, feeBps, timeInForce: "ioc", reduceOnly: side === "sell" };
  const orders = submitSpotPaperOrder(state.orders, request, state.account), order = orders.at(-1)!;
  const bid = side === "buy" ? price - .1 : price;
  const decision: SpotPaperDecision = { timestampMs: nowMs, action: side, reason: side === "buy" ? "WEEKLY_TREND_ENTER" : "WEEKLY_TREND_EXIT",
    fill: null, orderId: order.orderId, signal, mark: markSpotAccount(state.account, bid, feeBps) };
  const next = { ...state, orders, cycles: state.cycles + 1, lastCycleMs: nowMs, lastDecision: decision, lastSignal: signal };
  return { state: next, cycle: { before: state, after: next, decision, recordedAtMs: nowMs,
    market: { book: { bids: [[bid, 100]], receivedAtMs: nowMs } } } };
}
function settle(state: SpotPaperState, price: number, nowMs: number): { state: SpotPaperState; cycle: SpotCommittedActivityCycle } {
  const order = state.orders.at(-1)!, side = order.request.side;
  const bid = side === "buy" ? price - .1 : price, ask = side === "buy" ? price : price + .1;
  const book = { bids: [[bid, 100] as [number, number]], asks: [[ask, 100] as [number, number]], receivedAtMs: nowMs };
  const executed = executeSpotPaperOrder(order, state.account, { book, feeBps,
    rules: { lotSize: .001, minimumQuantity: .001, minimumNotionalUsd: 1, tickSize: .1 } }, nowMs);
  const decision: SpotPaperDecision = { ...state.lastDecision!, timestampMs: nowMs,
    fill: executed.order.fill, mark: markSpotAccount(executed.account, bid, feeBps) };
  const next = { ...state, account: executed.account, orders: state.orders.map(value => value.orderId === order.orderId ? executed.order : value),
    lastCycleMs: nowMs, lastDecision: decision };
  return { state: next, cycle: { before: state, after: next, decision, recordedAtMs: nowMs, phase: "BROKER_SETTLEMENT", market: { book } } };
}
function trade(state: SpotPaperState, side: "buy" | "sell", quantity: number, price: number, nowMs: number) {
  const submitted = submit(state, side, quantity, price, nowMs), settled = settle(submitted.state, price, nowMs + 1);
  return { state: settled.state, cycles: [submitted.cycle, settled.cycle], orderId: settled.state.orders.at(-1)!.orderId };
}
function hold(state: SpotPaperState, bid: number, nowMs: number, receivedAtMs = nowMs) {
  const decision: SpotPaperDecision = { timestampMs: nowMs, action: "hold", reason: "HOLD_SPOT_NO_ADDITIONS", fill: null,
    signal, mark: markSpotAccount(state.account, bid, feeBps) };
  const next = { ...state, cycles: state.cycles + 1, lastCycleMs: nowMs, lastDecision: decision };
  const cycle: SpotCommittedActivityCycle = { before: state, after: next, decision, recordedAtMs: nowMs,
    market: { book: { bids: [[bid, 100]], receivedAtMs } } };
  return { state: next, cycle };
}

test("a held long shows real holding evaluations and evolving marks with fee-inclusive P&L", () => {
  const entry = trade(initial(), "buy", 1, 100, start), first = hold(entry.state, 110, start + 1_000), second = hold(first.state, 120, start + 2_000);
  const activity = projectSpotOrderActivity(second.state, [...entry.cycles, first.cycle, second.cycle])[entry.orderId]!;
  assert.equal(activity.direction, "LONG"); assert.equal(activity.intent, "OPEN_LONG"); assert.equal(activity.positionStatus, "OPEN");
  assert.equal(activity.remainingQuantity, 1); close(activity.remainingEntryCostUsd, 100.8); close(activity.realizedNetUsd, 0);
  close(activity.unrealizedNetUsd, 18.24); close(activity.totalNetUsd, 18.24);
  assert.equal(activity.markPrice, 120); assert.equal(activity.markAtMs, start + 2_000);
  const evaluations = activity.events.filter(event => event.type === "STRATEGY_EVALUATION");
  assert.equal(evaluations.length, 2); assert.deepEqual(evaluations.map(event => event.markPrice), [110, 120]);
  assert.ok(evaluations.every(event => event.reason === "HOLD_SPOT_NO_ADDITIONS"));
  close(evaluations[0]!.unrealizedNetUsd, 8.32);
  assert.ok(activity.events.some(event => event.type === "BROKER_SETTLEMENT"));
});

test("partial exits allocate acquisition fees and remaining basis and keep sell cards long", () => {
  const entry = trade(initial(), "buy", 1, 100, start), partial = trade(entry.state, "sell", .4, 110, start + 1_000);
  const observed = hold(partial.state, 120, start + 2_000);
  const projected = projectSpotOrderActivity(observed.state, [...entry.cycles, ...partial.cycles, observed.cycle]);
  for (const id of [entry.orderId, partial.orderId]) {
    const activity = projected[id]!;
    assert.equal(activity.direction, "LONG"); assert.equal(activity.entryOrderId, entry.orderId);
    assert.equal(activity.positionStatus, "PARTIALLY_EXITED"); close(activity.remainingQuantity, .6);
    close(activity.remainingEntryCostUsd, 60.48); close(activity.realizedNetUsd, 3.328);
    close(activity.unrealizedNetUsd, 10.944); close(activity.totalNetUsd, 14.272);
  }
  assert.equal(projected[partial.orderId]!.intent, "CLOSE_LONG");
  assert.deepEqual(projected[partial.orderId]!.events, projected[entry.orderId]!.events);
});

test("closed episodes preserve their own realized results when a later long position opens", () => {
  const entry = trade(initial(), "buy", 1, 100, start), partial = trade(entry.state, "sell", .4, 110, start + 1_000);
  const exit = trade(partial.state, "sell", .6, 90, start + 2_000), reentry = trade(exit.state, "buy", 2, 50, start + 3_000);
  const observed = hold(reentry.state, 60, start + 4_000);
  const activity = projectSpotOrderActivity(observed.state, [...entry.cycles, ...partial.cycles, ...exit.cycles, ...reentry.cycles, observed.cycle]);
  for (const id of [entry.orderId, partial.orderId, exit.orderId]) {
    assert.equal(activity[id]!.positionStatus, "CLOSED"); assert.equal(activity[id]!.remainingQuantity, 0);
    assert.equal(activity[id]!.closedAtMs, start + 2_001); close(activity[id]!.remainingEntryCostUsd, 0);
    close(activity[id]!.realizedNetUsd, -3.584); close(activity[id]!.unrealizedNetUsd, 0); close(activity[id]!.totalNetUsd, -3.584);
    assert.ok(activity[id]!.events.every(event => event.timestampMs <= start + 2_001));
  }
  assert.equal(activity[reentry.orderId]!.positionStatus, "OPEN"); assert.equal(activity[reentry.orderId]!.entryOrderId, reentry.orderId);
  close(activity[reentry.orderId]!.realizedNetUsd, 0); close(activity[reentry.orderId]!.totalNetUsd, 18.24);
  assert.ok(activity[reentry.orderId]!.events.every(event => event.timestampMs >= start + 3_000));
});

test("unchanged-price completed trades show both entry and exit fees as a realized loss", () => {
  const entry = trade(initial(), "buy", 1, 100, start), exit = trade(entry.state, "sell", 1, 100, start + 1_000);
  const activity = projectSpotOrderActivity(exit.state, [...entry.cycles, ...exit.cycles])[entry.orderId]!;
  assert.equal(activity.positionStatus, "CLOSED"); close(activity.totalNetUsd, -1.6); close(activity.realizedNetUsd, -1.6);
  close(activity.unrealizedNetUsd, 0); close(exit.state.account.feesUsd, 1.6);
});

test("stale, future or missing current books give unknown open valuation instead of reusing an older mark", () => {
  const entry = trade(initial(), "buy", 1, 100, start), prior = hold(entry.state, 110, start + 1_000);
  for (const receivedAtMs of [start - 5_001, start + 3_000]) {
    const latest = hold(prior.state, 120, start + 2_000, receivedAtMs);
    const activity = projectSpotOrderActivity(latest.state, [...entry.cycles, prior.cycle, latest.cycle])[entry.orderId]!;
    assert.equal(activity.markPrice, null); assert.equal(activity.markAtMs, null);
    assert.equal(activity.unrealizedNetUsd, null); assert.equal(activity.totalNetUsd, null); close(activity.realizedNetUsd, 0);
  }
  const latest = hold(prior.state, 120, start + 2_000); delete latest.cycle.market;
  const activity = projectSpotOrderActivity(latest.state, [...entry.cycles, prior.cycle, latest.cycle])[entry.orderId]!;
  assert.equal(activity.unrealizedNetUsd, null); assert.equal(activity.totalNetUsd, null);
  assert.equal(projectSpotOrderActivity(latest.state, [prior.cycle])[entry.orderId]!.unrealizedNetUsd, null);
});

test("a recorded invalid valuation remains unknown even when the compact cycle contains a fresh positive bid", () => {
  const entry = trade(initial(), "buy", 1, 100, start), observed = hold(entry.state, 110, start + 1_000);
  observed.cycle.decision.mark = null;
  const activity = projectSpotOrderActivity(observed.state, [...entry.cycles, observed.cycle])[entry.orderId]!;
  assert.equal(activity.markPrice, null); assert.equal(activity.markAtMs, null);
  assert.equal(activity.unrealizedNetUsd, null); assert.equal(activity.totalNetUsd, null);
  const inconsistent = hold(entry.state, 110, start + 1_000);
  inconsistent.cycle.decision.mark!.unrealizedNetUsd += 1;
  assert.throws(() => projectSpotOrderActivity(inconsistent.state, [...entry.cycles, inconsistent.cycle]), /MARK_MISMATCH/);
});

test("lifecycle and committed phases deduplicate by stable identity and projection never changes input", () => {
  const entry = trade(initial(), "buy", 1, 100, start), partial = trade(entry.state, "sell", .4, 110, start + 1_000);
  const cycles = [...entry.cycles, ...partial.cycles], stateBefore = JSON.stringify(partial.state), cyclesBefore = JSON.stringify(cycles);
  const first = projectSpotOrderActivity(partial.state, cycles), duplicate = projectSpotOrderActivity(partial.state, [...cycles].reverse().concat(cycles));
  assert.deepEqual(duplicate, first);
  const events = first[entry.orderId]!.events;
  assert.equal(new Set(events.map(event => event.id)).size, events.length);
  assert.equal(events.filter(event => event.type === "SUBMITTED").length, 2);
  assert.equal(events.filter(event => event.type === "ACCEPTED").length, 2);
  assert.equal(events.filter(event => event.type === "FILLED").length, 2);
  assert.equal(events.filter(event => event.type === "BROKER_SETTLEMENT").length, 2);
  assert.equal(events.filter(event => event.type === "STRATEGY_EVALUATION").length, 1);
  assert.equal(JSON.stringify(partial.state), stateBefore); assert.equal(JSON.stringify(cycles), cyclesBefore);
});

test("pending and unfilled rejected reductions link to the held long episode without inventing fills", () => {
  const entry = trade(initial(), "buy", 1, 100, start), pending = submit(entry.state, "sell", .4, 110, start + 1_000);
  const current = projectSpotOrderActivity(pending.state, [...entry.cycles, pending.cycle]);
  assert.equal(current[entry.orderId]!.positionStatus, "EXIT_PENDING");
  assert.equal(current[pending.state.orders.at(-1)!.orderId]!.intent, "CLOSE_LONG");
  assert.equal(current[pending.state.orders.at(-1)!.orderId]!.direction, "LONG");
  const rejected = submit(entry.state, "sell", 2, 110, start + 2_000);
  assert.equal(rejected.state.orders.at(-1)!.status, "REJECTED");
  const activity = projectSpotOrderActivity(rejected.state, [...entry.cycles, rejected.cycle]);
  assert.equal(activity[rejected.state.orders.at(-1)!.orderId]!.entryOrderId, entry.orderId);
  assert.equal(activity[entry.orderId]!.positionStatus, "OPEN"); assert.equal(rejected.state.account.receipts.length, 1);
  assert.ok(activity[entry.orderId]!.events.some(event => event.type === "REJECTED"));
});

test("unfilled buys have no position episode and invalid account or cycle evidence fails closed", () => {
  const pending = submit(initial(), "buy", 1, 100, start);
  assert.deepEqual(Object.keys(projectSpotOrderActivity(pending.state, [pending.cycle])), []);
  const entry = trade(initial(), "buy", 1, 100, start), altered = JSON.parse(JSON.stringify(entry.state)) as SpotPaperState;
  altered.account.cashUsd += 1;
  assert.throws(() => projectSpotOrderActivity(altered, entry.cycles), /RECONCILIATION/);
  const badCycle = JSON.parse(JSON.stringify(entry.cycles[1])) as SpotCommittedActivityCycle;
  badCycle.after.account.quantity += 1;
  assert.throws(() => projectSpotOrderActivity(entry.state, [badCycle]), /CYCLE_ACCOUNT_MISMATCH/);
  const missingOrder = { ...entry.state, orders: [] };
  assert.throws(() => projectSpotOrderActivity(missingOrder, entry.cycles), /RECEIPT_COUNT_MISMATCH/);
});

test("compact committed account totals retain the same activity as complete cycle states", () => {
  const entry = trade(initial(), "buy", 1, 100, start), observed = hold(entry.state, 110, start + 1_000), cycles = [...entry.cycles, observed.cycle];
  const compact = cycles.map(cycle => {
    const state = (value: SpotCommittedActivityCycle["after"]) => {
      const { initialCashUsd, cashUsd, quantity, entryCostUsd, realizedNetUsd, feesUsd } = value.account;
      return { startedAtMs: value.startedAtMs, lastCycleMs: value.lastCycleMs, cycles: value.cycles,
        account: { initialCashUsd, cashUsd, quantity, entryCostUsd, realizedNetUsd, feesUsd } };
    };
    return { ...cycle, before: state(cycle.before), after: state(cycle.after) };
  });
  assert.deepEqual(projectSpotOrderActivity(observed.state, compact), projectSpotOrderActivity(observed.state, cycles));
});
