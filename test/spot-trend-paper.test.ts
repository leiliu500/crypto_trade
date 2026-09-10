import assert from "node:assert/strict";
import test from "node:test";
import { advanceSpotPaper, createSpotPaperState, prepareSpotPaperCycle, settleSpotPaperCycle, validateSpotPaperState, SPOT_PAPER_SPEC,
  type SpotPaperState } from "../src/spot-trend/paper.js";
import { WEEK_MS, type SpotWeek } from "../src/spot-trend/data.js";
import type { SpotMarketSnapshot } from "../src/spot-trend/market.js";

const origin = Date.UTC(2020, 0, 2);
const evidence = "a".repeat(64);
const weekOpen = origin + 45 * WEEK_MS;
const start = weekOpen + 120_000;
const close = (actual: number, expected: number): void =>
  assert.ok(Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

function weeks(closes = Array.from({ length: 45 }, (_, i) => 100 + i)): SpotWeek[] {
  return closes.map((value, i) => ({ openMs: origin + i * WEEK_MS, endMs: origin + (i + 1) * WEEK_MS,
    availableAtMs: origin + (i + 1) * WEEK_MS + 60_000, open: value, high: value + 1,
    low: value - 1, close: value, volume: 100, trades: 10 }));
}

function snapshot(nowMs = start, bars = weeks()): SpotMarketSnapshot {
  return { retrievedAtMs: nowMs, bars,
    book: { bids: [[144, 100]], asks: [[144.1, 100]], receivedAtMs: nowMs },
    rules: { lotSize: 0.00000001, minimumQuantity: 0.00005, minimumNotionalUsd: 0.5, tickSize: 0.1 },
    sources: [] };
}

function partialEntry(displayed = 0.2): ReturnType<typeof advanceSpotPaper> {
  const market = snapshot(); market.book.asks[0]![1] = displayed;
  return advanceSpotPaper(createSpotPaperState(evidence, start), market, start);
}

function bearishSnapshot(nowMs: number): SpotMarketSnapshot {
  const market = snapshot(nowMs, weeks([...Array.from({ length: 45 }, (_, i) => 100 + i), 2, 2]));
  market.book = { bids: [[100, 100]], asks: [[100.1, 100]], receivedAtMs: nowMs };
  return market;
}

test("spot paper starts with independent funded cash and makes a fresh, fee-inclusive entry", () => {
  const initial = createSpotPaperState(evidence, start);
  assert.equal(initial.mode, "RESEARCH_PAPER");
  assert.equal(initial.account.cashUsd, 100_000);
  assert.equal(initial.lastCycleMs, start - 1);
  const result = advanceSpotPaper(initial, snapshot(), start);
  assert.equal(result.decision.action, "buy");
  assert.equal(result.decision.reason, "WEEKLY_TREND_ENTER");
  assert.equal(result.decision.signal.state, "long");
  assert.ok(result.decision.fill);
  assert.equal(result.decision.fill.feeBps, 80);
  assert.equal(result.decision.fill.timestampMs, start);
  assert.ok(result.state.account.entryCostUsd <= 100);
  assert.equal(result.state.account.receipts.length, 1);
  assert.equal(result.state.orders.length, 1);
  assert.equal(result.state.orders[0]!.status, "FILLED");
  assert.equal(result.state.orders[0]!.fill!.id, result.decision.fill.id);
  assert.deepEqual(result.state.orders[0]!.events.map(event => event.type), ["SUBMITTED", "ACCEPTED", "FILLED"]);
  close(result.state.account.cashUsd + result.state.account.entryCostUsd, 100_000);
  assert.equal(initial.account.quantity, 0);
  assert.equal(initial.cycles, 0);
  assert.ok(result.decision.mark!.netPnlUsd < 0, "a new entry must recognize spread and both-side fees");
  validateSpotPaperState(result.state);
});

test("spot paper follows the native-week delay and cannot use the newly finalized close", () => {
  const before = snapshot(), changed = snapshot();
  const last = changed.bars.at(-1)!;
  last.close = 1_000_000; last.open = 1_000_000; last.high = 1_000_001; last.low = 999_999;
  const initial = createSpotPaperState(evidence, start);
  const original = advanceSpotPaper(initial, before, start);
  const altered = advanceSpotPaper(initial, changed, start);
  assert.deepEqual(altered, original);
  assert.equal(original.decision.signal.lastWeekEndMs, weekOpen - WEEK_MS);
  assert.ok(original.decision.signal.availableAtMs < weekOpen);
  assert.equal(before.bars.at(-1)!.endMs, weekOpen);
});

test("spot paper may enter on a qualifying cycle after the first native-week hour", () => {
  for (const nowMs of [weekOpen + 3_600_000, weekOpen + 12 * 3_600_000, weekOpen + 3 * 86_400_000]) {
    const result = advanceSpotPaper(createSpotPaperState(evidence, nowMs), snapshot(nowMs), nowMs);
    assert.equal(result.decision.signal.state, "long");
    assert.equal(result.decision.action, "buy");
    assert.equal(result.decision.reason, "WEEKLY_TREND_ENTER");
    assert.ok(result.state.account.quantity > 0);
    assert.ok(result.state.account.cashUsd < 100_000);
    assert.ok(result.state.account.entryCostUsd <= 100);
    assert.equal(result.state.orders[0]!.status, "FILLED");
    assert.equal(result.decision.signal.lastWeekEndMs, weekOpen - WEEK_MS);
  }
});

test("a partial L2 entry consumes the entry and larger fresh depth cannot add inventory", () => {
  const first = partialEntry();
  assert.equal(first.decision.action, "buy");
  close(first.state.account.quantity, 0.01);
  assert.ok(first.state.account.entryCostUsd < 2);
  assert.equal(first.state.orders[0]!.status, "CANCELED");
  assert.equal(first.state.orders[0]!.cancellationReason, "IOC_UNFILLED_REMAINDER");
  assert.ok(first.state.orders[0]!.request.quantity > first.state.orders[0]!.filledQuantity);
  const next = advanceSpotPaper(first.state, snapshot(start + 1_000), start + 1_000);
  assert.equal(next.decision.action, "hold");
  assert.equal(next.decision.reason, "HOLD_SPOT_NO_ADDITIONS");
  assert.equal(next.state.account.receipts.length, 1);
  assert.equal(next.state.account.quantity, first.state.account.quantity);
  assert.equal(next.state.account.cashUsd, first.state.account.cashUsd);
  assert.equal(next.state.orders.length, 1);
});

test("a denied first attempt may retry on a later cycle with executable depth", () => {
  const thin = snapshot(); thin.book.asks[0]![1] = 0.0001;
  const first = advanceSpotPaper(createSpotPaperState(evidence, start), thin, start);
  assert.equal(first.decision.action, "hold");
  assert.match(first.decision.reason, /BELOW_MINIMUM_EXECUTABLE_ORDER/);
  assert.equal(first.state.account.quantity, 0);
  assert.equal(first.state.orders[0]!.status, "CANCELED");
  assert.equal(first.state.orders[0]!.fill, null);
  const second = advanceSpotPaper(first.state, snapshot(start + 1_000), start + 1_000);
  assert.equal(second.decision.action, "buy");
  assert.match(second.decision.fill!.id, /:2:buy$/);
  assert.equal(second.state.account.receipts.length, 1);
  assert.equal(second.state.orders.length, 2);
});

test("preparation persists a submitted request before settlement changes any cash or inventory", () => {
  const initial = createSpotPaperState(evidence, start);
  const prepared = prepareSpotPaperCycle(initial, snapshot(), start);
  assert.equal(prepared.decision.action, "buy");
  assert.equal(prepared.decision.fill, null);
  assert.equal(prepared.state.account, initial.account);
  assert.equal(prepared.state.account.cashUsd, 100_000);
  assert.equal(prepared.state.account.quantity, 0);
  assert.equal(prepared.state.account.receipts.length, 0);
  assert.equal(prepared.state.orders[0]!.status, "SUBMITTED");
  assert.equal(prepared.state.orders[0]!.events.length, 1);
  const restored = JSON.parse(JSON.stringify(prepared.state)) as SpotPaperState;
  validateSpotPaperState(restored);
  const settled = settleSpotPaperCycle(restored, snapshot(start + 1), start + 1);
  assert.equal(settled.state.orders[0]!.status, "FILLED");
  assert.equal(settled.state.orders.length, 1);
  assert.equal(settled.state.account.receipts.length, 1);
  assert.ok(settled.state.account.cashUsd < initial.account.cashUsd);
  assert.equal(settled.state.cycles, prepared.state.cycles);
  assert.equal(settled.state.orders[0]!.orderId, prepared.state.orders[0]!.orderId);
  assert.equal(settled.decision.fill!.timestampMs, start + 1);
  assert.equal(restored.account.cashUsd, 100_000);
  const repeated = settleSpotPaperCycle(settled.state, snapshot(start + 2), start + 2);
  assert.equal(repeated.state, settled.state);
  assert.equal(repeated.state.account.receipts.length, 1);
});

test("a crash after submission recovers the same request without a duplicate order", () => {
  const prepared = prepareSpotPaperCycle(createSpotPaperState(evidence, start), snapshot(), start);
  const restored = JSON.parse(JSON.stringify(prepared.state)) as SpotPaperState;
  const recovered = prepareSpotPaperCycle(restored, snapshot(start + 10), start + 10);
  assert.equal(recovered.decision.reason, "PENDING_ORDER_RECOVERY");
  assert.equal(recovered.state.orders.length, 1);
  assert.equal(recovered.state.orders[0]!.orderId, prepared.state.orders[0]!.orderId);
  assert.equal(recovered.state.account.quantity, 0);
  const settled = settleSpotPaperCycle(recovered.state, snapshot(start + 11), start + 11);
  assert.equal(settled.state.orders[0]!.status, "FILLED");
  assert.equal(settled.state.account.receipts.length, 1);
  const next = advanceSpotPaper(settled.state, snapshot(start + 12), start + 12);
  assert.equal(next.decision.reason, "HOLD_SPOT_NO_ADDITIONS");
  assert.equal(next.state.orders.length, 1);
  assert.equal(next.state.account.receipts.length, 1);
});

test("an old recovered pending order expires without applying a fill", () => {
  const prepared = prepareSpotPaperCycle(createSpotPaperState(evidence, start), snapshot(), start);
  const nowMs = start + 30_001;
  const recovered = prepareSpotPaperCycle(JSON.parse(JSON.stringify(prepared.state)) as SpotPaperState, snapshot(nowMs), nowMs);
  const settled = settleSpotPaperCycle(recovered.state, snapshot(nowMs), nowMs);
  assert.equal(settled.state.orders[0]!.status, "CANCELED");
  assert.equal(settled.state.orders[0]!.cancellationReason, "REQUEST_EXPIRED");
  assert.equal(settled.decision.action, "hold");
  assert.equal(settled.decision.fill, null);
  assert.equal(settled.state.account.cashUsd, 100_000);
  assert.equal(settled.state.account.receipts.length, 0);
});

test("submission before 01:00 UTC can settle afterward when signal and execution checks remain valid", () => {
  const submittedAt = weekOpen + 3_600_000 - 1;
  const prepared = prepareSpotPaperCycle(createSpotPaperState(evidence, submittedAt), snapshot(submittedAt), submittedAt);
  assert.equal(prepared.state.orders[0]!.status, "SUBMITTED");
  const nowMs = submittedAt + 1;
  const settled = settleSpotPaperCycle(prepared.state, snapshot(nowMs), nowMs);
  assert.equal(settled.state.orders[0]!.status, "FILLED");
  assert.equal(settled.state.orders[0]!.cancellationReason, null);
  assert.ok(settled.state.account.quantity > 0);
  assert.ok(settled.state.account.cashUsd < 100_000);
});

test("history failure between submission and settlement cancels the buy", () => {
  const prepared = prepareSpotPaperCycle(createSpotPaperState(evidence, start), snapshot(), start);
  const failed = snapshot(start + 1); failed.historyError = "PUBLIC_HISTORY_UNAVAILABLE";
  const settled = settleSpotPaperCycle(prepared.state, failed, start + 1);
  assert.equal(settled.state.orders[0]!.cancellationReason, "ENTRY_POLICY_INVALIDATED");
  assert.equal(settled.state.account.receipts.length, 0);
  assert.equal(settled.state.account.cashUsd, 100_000);
});

test("bearish eligible weekly signals exit partially and retry with fresh depth", () => {
  const entry = partialEntry();
  const exitMs = origin + 47 * WEEK_MS + 120_000;
  const thin = bearishSnapshot(exitMs); thin.book.bids[0]![1] = 0.1;
  const first = advanceSpotPaper(entry.state, thin, exitMs);
  assert.equal(first.decision.signal.state, "cash");
  assert.equal(first.decision.action, "sell");
  assert.equal(first.decision.reason, "WEEKLY_TREND_EXIT");
  close(first.state.account.quantity, 0.005);
  const nextMs = exitMs + 1_000;
  const second = advanceSpotPaper(first.state, bearishSnapshot(nextMs), nextMs);
  assert.equal(second.decision.action, "sell");
  assert.equal(second.state.account.quantity, 0);
  assert.equal(second.state.account.entryCostUsd, 0);
  assert.equal(second.state.account.receipts.length, 3);
  assert.ok(second.state.account.realizedNetUsd < 0);
  close(second.state.account.cashUsd - 100_000, second.state.account.realizedNetUsd);
  close(second.decision.mark!.netPnlUsd, second.state.account.realizedNetUsd);
});

test("subminimum exit dust stays in inventory and liquidation P&L instead of being discarded", () => {
  const entry = partialEntry(0.201);
  const exitMs = origin + 47 * WEEK_MS + 120_000;
  const thin = bearishSnapshot(exitMs); thin.book.bids[0]![1] = 0.14;
  const first = advanceSpotPaper(entry.state, thin, exitMs);
  assert.equal(first.decision.action, "sell");
  assert.ok(first.state.account.quantity > 0);
  assert.ok(first.state.account.quantity * 100 < thin.rules.minimumNotionalUsd);
  const nextMs = exitMs + 1_000;
  const second = advanceSpotPaper(first.state, bearishSnapshot(nextMs), nextMs);
  assert.equal(second.decision.action, "hold");
  assert.match(second.decision.reason, /BELOW_MINIMUM_EXECUTABLE_ORDER/);
  assert.equal(second.state.account.quantity, first.state.account.quantity);
  assert.equal(second.state.account.receipts.length, 2);
  assert.ok(second.state.account.entryCostUsd > 0);
  assert.ok(second.decision.mark);
  assert.ok(second.decision.mark.unrealizedNetUsd < 0);
  close(second.decision.mark.netPnlUsd, second.state.account.realizedNetUsd + second.decision.mark.unrealizedNetUsd);
});

test("spot paper reduces appreciated marked exposure without adding or flattening the remaining position", () => {
  const first = partialEntry();
  const nextMs = start + 1_000, market = snapshot(nextMs);
  market.book = { bids: [[200_000, 100]], asks: [[200_000.1, 100]], receivedAtMs: nextMs };
  const second = advanceSpotPaper(first.state, market, nextMs);
  assert.equal(second.decision.action, "sell");
  assert.equal(second.decision.reason, "MARKED_NOTIONAL_CAP");
  assert.ok(second.state.account.quantity > 0);
  assert.ok(second.state.account.quantity < first.state.account.quantity);
  assert.ok(second.state.account.quantity * 200_000 <= 1_000 + 1e-8);
  assert.equal(second.state.account.receipts.length, 2);
});

test("a subminimum marked-cap reduction flattens inventory and cannot re-enter that week", () => {
  const entry = partialEntry();
  const nextMs = start + 1_000, market = snapshot(nextMs);
  market.book = { bids: [[100_010, 100]], asks: [[100_010.1, 100]], receivedAtMs: nextMs };
  const excessNotional = entry.state.account.quantity * 100_010 - 1_000;
  assert.ok(excessNotional > 0 && excessNotional < market.rules.minimumNotionalUsd);
  const reduced = advanceSpotPaper(entry.state, market, nextMs);
  assert.equal(reduced.decision.signal.state, "long");
  assert.equal(reduced.decision.action, "sell");
  assert.equal(reduced.decision.reason, "MARKED_NOTIONAL_CAP");
  assert.equal(reduced.decision.fill!.quantity, entry.state.account.quantity);
  assert.equal(reduced.state.account.quantity, 0);
  assert.equal(reduced.state.account.entryCostUsd, 0);
  const retried = advanceSpotPaper(reduced.state, snapshot(nextMs + 1_000), nextMs + 1_000);
  assert.equal(retried.decision.signal.state, "long");
  assert.equal(retried.decision.action, "hold");
  assert.equal(retried.decision.reason, "WEEKLY_ENTRY_ALREADY_CONSUMED");
  assert.equal(retried.state.account.quantity, 0);
  assert.equal(retried.state.account.receipts.length, 2);
  assert.equal(retried.state.account.cashUsd, reduced.state.account.cashUsd);
});

test("stale and future books cannot trade or manufacture a fresh mark", () => {
  const initial = createSpotPaperState(evidence, start);
  for (const receivedAtMs of [start - 5_001, start + 1]) {
    const market = snapshot(); market.book.receivedAtMs = receivedAtMs;
    const result = advanceSpotPaper(initial, market, start);
    assert.equal(result.decision.action, "hold");
    assert.equal(result.decision.reason, "STALE_OR_FUTURE_BOOK");
    assert.equal(result.decision.mark, null);
    assert.equal(result.state.cycles, 1);
    assert.equal(result.state.account.receipts.length, 0);
  }
  const market = snapshot(); market.bars.pop();
  const result = advanceSpotPaper(initial, market, start);
  assert.equal(result.decision.reason, "HISTORY_UNAVAILABLE");
  assert.ok(result.decision.mark, "fresh executable quotes still permit a cash/inventory mark");
  assert.equal(result.decision.mark.netPnlUsd, 0);
});

test("missing, stale, or failed history blocks entries but permits protective exits against fresh books", () => {
  const entry = partialEntry(), nowMs = start + 1_000;
  for (const failure of ["missing", "stale", "error"] as const) {
    const market = snapshot(nowMs);
    if (failure === "missing") market.bars = [];
    else if (failure === "stale") market.bars.pop();
    else market.historyError = "SPOT_MARKET_HISTORY_UNAVAILABLE";
    const flat = advanceSpotPaper(createSpotPaperState(evidence, start), market, nowMs);
    assert.equal(flat.decision.action, "hold");
    assert.equal(flat.decision.reason, "HISTORY_UNAVAILABLE");
    assert.equal(flat.state.account.quantity, 0);
    assert.equal(flat.state.account.cashUsd, 100_000);
    assert.ok(flat.decision.mark);
    const protectedResult = advanceSpotPaper(entry.state, market, nowMs);
    assert.equal(protectedResult.decision.action, "sell");
    assert.equal(protectedResult.decision.reason, "HISTORY_UNAVAILABLE_EXIT");
    assert.equal(protectedResult.state.account.quantity, 0);
    assert.equal(protectedResult.state.account.receipts.length, 2);
    assert.ok(protectedResult.decision.mark);
    close(protectedResult.decision.mark.netPnlUsd, protectedResult.state.account.realizedNetUsd);
  }
  const staleBook = snapshot(nowMs, []);
  staleBook.book.receivedAtMs = nowMs - 5_001;
  const blockedExit = advanceSpotPaper(entry.state, staleBook, nowMs);
  assert.equal(blockedExit.decision.reason, "STALE_OR_FUTURE_BOOK");
  assert.equal(blockedExit.decision.action, "hold");
  assert.equal(blockedExit.decision.mark, null);
  assert.equal(blockedExit.state.account.quantity, entry.state.account.quantity);
});

test("backward cycle clocks are rejected while an exact duplicate remains idempotent", () => {
  const entry = partialEntry();
  const next = advanceSpotPaper(entry.state, snapshot(start + 1_000), start + 1_000);
  assert.throws(() => advanceSpotPaper(next.state, snapshot(start + 500), start + 500), /SPOT_PAPER_REVERSED_CLOCK/);
  assert.throws(() => advanceSpotPaper(next.state, snapshot(start - 1), start - 1), /INVALID_SPOT_PAPER_CLOCK/);
  const duplicate = advanceSpotPaper(next.state, snapshot(start + 1_000), start + 1_000);
  assert.equal(duplicate.state, next.state);
  assert.equal(duplicate.decision, next.decision);
  assert.equal(next.state.cycles, 2);
  assert.equal(next.state.account.receipts.length, 1);
});

test("repeated cycles are idempotent and serialized restarts preserve receipt IDs and cash", () => {
  const first = partialEntry();
  const repeated = advanceSpotPaper(first.state, snapshot(), start);
  assert.equal(repeated.state, first.state);
  assert.equal(repeated.decision, first.decision);
  const restored = JSON.parse(JSON.stringify(first.state)) as SpotPaperState;
  validateSpotPaperState(restored);
  const second = advanceSpotPaper(restored, snapshot(start + 1_000), start + 1_000);
  assert.equal(second.state.account.cashUsd, first.state.account.cashUsd);
  assert.deepEqual(second.state.account.receipts, first.state.account.receipts);
  assert.equal(second.state.cycles, 2);
  assert.equal(second.state.evidenceSha256, evidence);
  const corrupted = JSON.parse(JSON.stringify(second.state)) as SpotPaperState;
  corrupted.account.cashUsd += 1;
  assert.throws(() => validateSpotPaperState(corrupted), /RECONCILIATION_FAILED/);
  const alteredReceipt = JSON.parse(JSON.stringify(second.state)) as SpotPaperState;
  alteredReceipt.account.receipts[0]!.price += 1;
  assert.throws(() => validateSpotPaperState(alteredReceipt), /RECONCILIATION_FAILED/);
});
