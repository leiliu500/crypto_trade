import assert from "node:assert/strict";
import test from "node:test";
import { advanceSpotPaper, createSpotPaperState, prepareSpotPaperCycle, settleSpotPaperCycle,
  validateSpotPaperState, SPOT_PAPER_SPEC } from "../src/spot-trend/paper.js";
import { WEEK_MS, type SpotWeek } from "../src/spot-trend/data.js";
import type { SpotMarketSnapshot } from "../src/spot-trend/market.js";

const origin = Date.UTC(2020, 0, 2), weekOpen = origin + 45 * WEEK_MS;
const evidence = "c".repeat(64), hour = 3_600_000, day = 86_400_000;
const closes = Array.from({ length: 45 }, (_, index) => 100 + index);
const history = (values = closes): SpotWeek[] => values.map((close, index) => ({
  openMs: origin + index * WEEK_MS, endMs: origin + (index + 1) * WEEK_MS,
  availableAtMs: origin + (index + 1) * WEEK_MS + 60_000,
  open: close, high: close + 1, low: close - 1, close, volume: 100, trades: 10 }));
function market(nowMs: number, values = closes, bid = 144, ask = 144.1): SpotMarketSnapshot {
  return { retrievedAtMs: nowMs, bars: history(values), sources: [],
    book: { bids: [[bid, 100]], asks: [[ask, 100]], receivedAtMs: nowMs },
    rules: { lotSize: 0.00000001, minimumQuantity: 0.00005, minimumNotionalUsd: .5, tickSize: .1 } };
}
const close = (actual: number, expected: number): void => assert.ok(Math.abs(actual - expected)
  <= 1e-10 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

test("continuous entry cadence retains delayed weekly signals and pays fees on late and midweek entries", () => {
  assert.equal(SPOT_PAPER_SPEC.entrySchedule, "CONTINUOUS_EACH_CYCLE");
  assert.equal(SPOT_PAPER_SPEC.entryWindowMs, null);
  assert.equal(SPOT_PAPER_SPEC.cycleIntervalMs, 300_000);
  for (const offset of [18 * hour, 3 * day, 6 * day + 23 * hour]) {
    const nowMs = weekOpen + offset;
    const result = advanceSpotPaper(createSpotPaperState(evidence, nowMs), market(nowMs), nowMs);
    assert.equal(result.decision.action, "buy");
    assert.equal(result.decision.reason, "WEEKLY_TREND_ENTER");
    assert.equal(result.decision.signal.lastWeekEndMs, weekOpen - WEEK_MS);
    assert.ok(result.decision.signal.availableAtMs < weekOpen);
    assert.equal(result.state.orders.length, 1);
    assert.equal(result.state.orders[0]!.status, "FILLED");
    assert.equal(result.state.account.receipts.length, 1);
    assert.ok(result.state.account.feesUsd > 0);
    assert.ok(result.state.account.entryCostUsd <= 100);
    assert.ok(result.decision.mark!.netPnlUsd < 0, "A fill recognizes its spread and fees immediately; it is not proof of profit");
    validateSpotPaperState(result.state);
  }
});

test("midweek eligibility does not bypass stale data, insufficient history or depth requirements", () => {
  const nowMs = weekOpen + 3 * day, initial = createSpotPaperState(evidence, nowMs);
  for (const cause of ["stale-book", "history-error", "missing-history", "thin-book"] as const) {
    const snapshot = market(nowMs);
    if (cause === "stale-book") snapshot.book.receivedAtMs = nowMs - 5_001;
    else if (cause === "history-error") snapshot.historyError = "HISTORY_UNAVAILABLE";
    else if (cause === "missing-history") snapshot.bars.pop();
    else snapshot.book.asks[0]![1] = .0001;
    const result = advanceSpotPaper(initial, snapshot, nowMs);
    assert.equal(result.decision.action, "hold");
    assert.equal(result.decision.fill, null);
    assert.equal(result.state.account.cashUsd, 100_000);
    assert.equal(result.state.account.quantity, 0);
    assert.equal(result.state.account.receipts.length, 0);
    if (cause === "thin-book") assert.equal(result.state.orders[0]!.status, "CANCELED");
  }
});

test("a fresh pending buy may cross the native-week boundary when the new delayed signal remains long", () => {
  const submittedAt = weekOpen + WEEK_MS - 1, settledAt = submittedAt + 2;
  const prepared = prepareSpotPaperCycle(createSpotPaperState(evidence, submittedAt), market(submittedAt), submittedAt);
  assert.equal(prepared.state.orders[0]!.status, "SUBMITTED");
  assert.equal(prepared.state.account.quantity, 0);
  // During the first minute, the just-ended bar is not finalized yet. Existing finalized
  // history is still current, and the delayed cutoff advances to the new native-week open.
  const settled = settleSpotPaperCycle(prepared.state, market(settledAt), settledAt);
  assert.equal(settled.decision.signal.state, "long");
  assert.equal(settled.decision.signal.lastWeekEndMs, weekOpen);
  assert.equal(settled.state.orders[0]!.status, "FILLED");
  assert.equal(settled.state.orders[0]!.orderId, prepared.state.orders[0]!.orderId);
  assert.equal(settled.state.account.receipts.length, 1);
  assert.equal(settled.state.account.receipts[0]!.timestampMs, settledAt);
  validateSpotPaperState(settled.state);
});

test("a pending prior-week buy is canceled when the newly eligible weekly signal is cash", () => {
  const submittedAt = weekOpen + WEEK_MS - 1, settledAt = submittedAt + 2;
  const turningCash = [...closes.slice(0, -1), 2];
  const prepared = prepareSpotPaperCycle(createSpotPaperState(evidence, submittedAt), market(submittedAt, turningCash), submittedAt);
  assert.equal(prepared.decision.signal.state, "long");
  assert.equal(prepared.state.orders[0]!.status, "SUBMITTED");
  const settled = settleSpotPaperCycle(prepared.state, market(settledAt, turningCash), settledAt);
  assert.equal(settled.decision.signal.state, "cash");
  assert.equal(settled.state.orders[0]!.status, "CANCELED");
  assert.equal(settled.state.orders[0]!.cancellationReason, "ENTRY_POLICY_INVALIDATED");
  assert.equal(settled.state.account.cashUsd, 100_000);
  assert.equal(settled.state.account.receipts.length, 0);
});

test("synthetic completed round trips realize higher-price profit and unchanged-price losses after both fees", () => {
  const enteredAt = weekOpen + 3 * day;
  const entry = advanceSpotPaper(createSpotPaperState(evidence, enteredAt), market(enteredAt), enteredAt);
  assert.equal(entry.state.orders[0]!.status, "FILLED");
  const entryFill = entry.state.account.receipts[0]!;
  // A later decline from elevated weekly prices supplies a genuine cash-state exit
  // while allowing either test execution price. These fixtures are accounting checks.
  const exitCloses = [...closes, ...Array.from({ length: 18 }, () => 220), 150, 150];
  const exitAt = origin + exitCloses.length * WEEK_MS + 3 * day;
  for (const exitBid of [160, entryFill.price]) {
    const result = advanceSpotPaper(entry.state, market(exitAt, exitCloses, exitBid, exitBid + .1), exitAt);
    assert.equal(result.decision.signal.state, "cash");
    assert.equal(result.decision.action, "sell");
    assert.equal(result.decision.reason, "WEEKLY_TREND_EXIT");
    assert.equal(result.state.orders.length, 2);
    assert.equal(result.state.orders[1]!.status, "FILLED");
    assert.equal(result.state.account.receipts.length, 2);
    assert.equal(result.state.account.quantity, 0);
    assert.equal(result.state.account.entryCostUsd, 0);
    const exitFill = result.state.account.receipts[1]!;
    const entryNotional = entryFill.quantity * entryFill.price, exitNotional = exitFill.quantity * exitFill.price;
    const entryFee = entryNotional * entryFill.feeBps / 10_000, exitFee = exitNotional * exitFill.feeBps / 10_000;
    const expectedNet = exitNotional - exitFee - entryNotional - entryFee;
    close(result.state.account.realizedNetUsd, expectedNet);
    close(result.state.account.feesUsd, entryFee + exitFee);
    close(result.state.account.cashUsd - 100_000, expectedNet);
    close(result.decision.mark!.netPnlUsd, expectedNet);
    if (exitBid > entryFill.price) assert.ok(expectedNet > 0);
    else { assert.ok(expectedNet < 0); close(expectedNet, -(entryFee + exitFee)); }
    validateSpotPaperState(result.state);
  }
});

test("a midweek protective exit cannot trigger another buy in the same native week", () => {
  const enteredAt = weekOpen + 3 * day;
  const entry = advanceSpotPaper(createSpotPaperState(evidence, enteredAt), market(enteredAt), enteredAt);
  const exitAt = enteredAt + SPOT_PAPER_SPEC.cycleIntervalMs;
  const failedHistory = market(exitAt, closes, 160, 160.1); failedHistory.historyError = "PUBLIC_HISTORY_UNAVAILABLE";
  const exited = advanceSpotPaper(entry.state, failedHistory, exitAt);
  assert.equal(exited.decision.reason, "HISTORY_UNAVAILABLE_EXIT");
  assert.equal(exited.state.account.quantity, 0);
  assert.ok(exited.state.account.realizedNetUsd > 0);
  const retryAt = exitAt + SPOT_PAPER_SPEC.cycleIntervalMs;
  const retry = advanceSpotPaper(exited.state, market(retryAt), retryAt);
  assert.equal(retry.decision.signal.state, "long");
  assert.equal(retry.decision.action, "hold");
  assert.equal(retry.decision.reason, "WEEKLY_ENTRY_ALREADY_CONSUMED");
  assert.equal(retry.state.orders.length, 2);
  assert.equal(retry.state.account.receipts.length, 2);
  assert.equal(retry.state.account.cashUsd, exited.state.account.cashUsd);
});
