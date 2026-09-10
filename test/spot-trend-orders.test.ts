import assert from "node:assert/strict";
import test from "node:test";
import { createSpotAccount, type SpotAccount } from "../src/spot-trend/account.js";
import { cancelSpotPaperOrder, executeSpotPaperOrder, SPOT_ORDER_SPEC, submitSpotPaperOrder, validateSpotOrderLedger,
  type SpotOrderExecutionSnapshot, type SpotOrderRequest, type SpotPaperOrder } from "../src/spot-trend/orders.js";

const request = (overrides: Partial<SpotOrderRequest> = {}): SpotOrderRequest => ({ clientOrderId: "weekly:1:buy", symbol: "BTC/USD",
  side: "buy", quantity: 1, limitPrice: 100.1, timeInForce: "ioc", reduceOnly: false, createdAtMs: 10_000, feeBps: 80, ...overrides });
const snapshot = (overrides: Partial<SpotOrderExecutionSnapshot> = {}): SpotOrderExecutionSnapshot => ({
  book: { bids: [[99.9, 100]], asks: [[100, 100]], receivedAtMs: 10_000 },
  rules: { lotSize: 0.001, minimumQuantity: 0.001, minimumNotionalUsd: 1, tickSize: 0.01 }, feeBps: 80, ...overrides });
const pending = (account = createSpotAccount(1_000), input = request()): SpotPaperOrder => submitSpotPaperOrder([], input, account)[0]!;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const buy = (): { order: SpotPaperOrder; account: SpotAccount } => {
  const account = createSpotAccount(1_000);
  return executeSpotPaperOrder(pending(account), account, snapshot(), 10_000);
};

test("paper submission creates a durable order without changing cash or inventing a fill", () => {
  const account = createSpotAccount(1_000), input = request(), orders = submitSpotPaperOrder([], input, account);
  assert.equal(orders[0]!.status, "SUBMITTED");
  assert.match(orders[0]!.orderId, /^paper-spot-[a-f0-9]{32}$/);
  assert.notEqual(orders[0]!.orderId, input.clientOrderId);
  assert.deepEqual(orders[0]!.events, [{ type: "SUBMITTED", timestampMs: 10_000 }]);
  assert.equal(orders[0]!.fill, null);
  assert.equal(account.receipts.length, 0);
  assert.equal(account.cashUsd, 1_000);
  input.quantity = 20;
  assert.equal(orders[0]!.request.quantity, 1);
  validateSpotOrderLedger(clone(orders), clone(account));
});

test("client IDs retry idempotently and reject conflicting quantity, price, fee or time", () => {
  const account = createSpotAccount(1_000), input = request(), orders = submitSpotPaperOrder([], input, account);
  assert.equal(submitSpotPaperOrder(orders, { ...input }, account), orders);
  for (const difference of [{ quantity: 0.9 }, { limitPrice: 100 }, { feeBps: 40 }, { createdAtMs: 10_001 }, { reduceOnly: true }])
    assert.throws(() => submitSpotPaperOrder(orders, { ...input, ...difference }, account), /CONFLICTING_CLIENT_ORDER_ID/);
  const filled = executeSpotPaperOrder(orders[0]!, account, snapshot(), 10_000);
  const terminal = [filled.order];
  assert.equal(submitSpotPaperOrder(terminal, input, filled.account), terminal);
  assert.equal(filled.account.receipts.length, 1);
});

test("one pending order prevents double reservation without destroying the first request", () => {
  const account = createSpotAccount(1_000), orders = submitSpotPaperOrder([], request(), account);
  const second = submitSpotPaperOrder(orders, request({ clientOrderId: "weekly:2:buy" }), account);
  assert.equal(second[0], orders[0]);
  assert.equal(second[1]!.status, "REJECTED");
  assert.equal(second[1]!.rejectionReason, "PENDING_ORDER_EXISTS");
  assert.deepEqual(second[1]!.events.map(event => event.type), ["SUBMITTED", "REJECTED"]);
  validateSpotOrderLedger(second, account);
});

test("fully funded request reserves fees at its limit and cannot request excess cash or inventory", () => {
  const account = createSpotAccount(100);
  const orders = submitSpotPaperOrder([], request(), account);
  assert.equal(orders[0]!.rejectionReason, "INSUFFICIENT_CASH_AT_LIMIT");
  assert.equal(orders[0]!.status, "REJECTED");
  const oversell = submitSpotPaperOrder([], request({ side: "sell", reduceOnly: true }), account);
  assert.equal(oversell[0]!.rejectionReason, "INSUFFICIENT_INVENTORY");
  assert.equal(account.cashUsd, 100);
  assert.equal(account.receipts.length, 0);
});

test("semantically invalid requests have explicit durable rejections", () => {
  const account = createSpotAccount(1_000);
  const cases: [Partial<SpotOrderRequest>, string][] = [[{ quantity: 0 }, "INVALID_QUANTITY_OR_PRICE"],
    [{ limitPrice: -1 }, "INVALID_QUANTITY_OR_PRICE"], [{ feeBps: -1 }, "INVALID_FEE"], [{ feeBps: 10_000 }, "INVALID_FEE"],
    [{ reduceOnly: true }, "INVALID_REDUCE_ONLY"], [{ side: "sell", reduceOnly: false }, "INVALID_REDUCE_ONLY"],
    [{ symbol: "ETH/USD" as "BTC/USD" }, "UNSUPPORTED_SYMBOL"], [{ timeInForce: "gtc" as "ioc" }, "UNSUPPORTED_TIME_IN_FORCE"]];
  for (const [changed, reason] of cases) {
    const orders = submitSpotPaperOrder([], request(changed), account);
    assert.equal(orders[0]!.rejectionReason, reason);
    validateSpotOrderLedger(clone(orders), clone(account));
  }
});

test("non-JSON requests and forged restored account balances fail closed", () => {
  const account = createSpotAccount(1_000);
  for (const changed of [{ quantity: NaN }, { limitPrice: Infinity }, { createdAtMs: 0.5 }, { clientOrderId: " " }])
    assert.throws(() => submitSpotPaperOrder([], request(changed), account), /UNSERIALIZABLE_ORDER_REQUEST/);
  assert.throws(() => submitSpotPaperOrder([], { ...request(), extra: 1 } as SpotOrderRequest, account), /UNSERIALIZABLE_ORDER_REQUEST/);
  const forged = clone(account); forged.cashUsd += 1;
  assert.throws(() => submitSpotPaperOrder([], request(), forged), /RECONCILIATION_FAILED/);
  assert.throws(() => executeSpotPaperOrder(pending(account), forged, snapshot(), 10_000), /RECONCILIATION_FAILED/);
});

test("execution accepts and fills requested quantity with one fee-bearing receipt", () => {
  const { order, account } = buy();
  assert.equal(order.status, "FILLED");
  assert.deepEqual(order.events.map(event => event.type), ["SUBMITTED", "ACCEPTED", "FILLED"]);
  assert.equal(order.filledQuantity, 1);
  assert.equal(order.averageFillPrice, 100);
  assert.equal(order.feeUsd, 0.8);
  assert.equal(account.cashUsd, 899.2);
  assert.equal(account.quantity, 1);
  assert.equal(account.receipts.length, 1);
  assert.equal(order.fill!.id, order.request.clientOrderId);
  assert.deepEqual(account.receipts[0], order.fill);
  validateSpotOrderLedger([order], account);
});

test("IOC keeps nominal request independent of depth and cancels an unfilled partial remainder", () => {
  const account = createSpotAccount(1_000), order = pending(account);
  const result = executeSpotPaperOrder(order, account, snapshot({ book: { bids: [[99.9, 100]],
    asks: [[100, 0.01], [100.05, 1], [100.1, 8.99], [100.11, 1_000]], receivedAtMs: 10_000 } }), 10_000);
  assert.equal(result.order.request.quantity, 1);
  assert.equal(result.order.filledQuantity, 0.5);
  assert.equal(result.order.status, "CANCELED");
  assert.equal(result.order.cancellationReason, "IOC_UNFILLED_REMAINDER");
  assert.deepEqual(result.order.events.map(event => event.type), ["SUBMITTED", "ACCEPTED", "PARTIAL_FILL", "CANCELED"]);
  assert.equal(result.account.quantity, 0.5);
  assert.equal(result.account.receipts.length, 1);
  assert.ok(result.order.averageFillPrice! > 100 && result.order.averageFillPrice! <= 100.1);
  validateSpotOrderLedger([result.order], result.account);
});

test("buy matching respects a stricter submitted limit and never borrows out-of-limit depth", () => {
  const account = createSpotAccount(1_000), order = pending(account, request({ limitPrice: 100.05 }));
  const result = executeSpotPaperOrder(order, account, snapshot({ book: { bids: [[99.9, 100]],
    asks: [[100, 0.01], [100.05, 0.99], [100.1, 100]], receivedAtMs: 10_000 } }), 10_000);
  assert.equal(result.order.filledQuantity, 0.05);
  assert.ok(result.order.averageFillPrice! <= 100.05);
  assert.equal(result.order.status, "CANCELED");
  validateSpotOrderLedger([result.order], result.account);
});

test("abundant depth cannot overfill even at much better prices than the request limit", () => {
  const account = createSpotAccount(100_000), order = pending(account, request({ quantity: 0.123, limitPrice: 200 }));
  const result = executeSpotPaperOrder(order, account, snapshot(), 10_000);
  assert.ok(result.order.filledQuantity > 0);
  assert.ok(result.order.filledQuantity <= 0.123);
  assert.equal(result.account.quantity, result.order.filledQuantity);
  validateSpotOrderLedger([result.order], result.account);
});

test("eight-decimal lot boundaries fill the requested lots without numerical dust", () => {
  const account = createSpotAccount(100_000), lotSize = 0.00000001;
  for (const count of [49, 59, 98, 107, 109, 118, 196, 205, 678_901, 1_234_567]) {
    const quantity = count * lotSize, order = pending(account, request({ quantity }));
    const result = executeSpotPaperOrder(order, account, snapshot({ rules: { lotSize, minimumQuantity: lotSize,
      minimumNotionalUsd: 0, tickSize: 0.01 } }), 10_000);
    assert.equal(result.order.filledQuantity, quantity);
    assert.equal(result.order.status, "FILLED");
    validateSpotOrderLedger([result.order], result.account);
  }
});

test("nonmarketable limits and insufficient executable liquidity cancel without cash changes", () => {
  const account = createSpotAccount(1_000);
  const unmarketable = executeSpotPaperOrder(pending(account, request({ limitPrice: 99.9 })), account, snapshot(), 10_000);
  assert.equal(unmarketable.order.cancellationReason, "IOC_LIMIT_NOT_MARKETABLE");
  assert.equal(unmarketable.account, account);
  const thin = executeSpotPaperOrder(pending(account), account,
    snapshot({ book: { bids: [[99.9, 100]], asks: [[100, 0.01]], receivedAtMs: 10_000 } }), 10_000);
  assert.equal(thin.order.cancellationReason, "BELOW_MINIMUM_EXECUTABLE_ORDER");
  assert.equal(thin.order.fill, null);
  assert.equal(thin.account, account);
  validateSpotOrderLedger([thin.order], account);
});

test("sell IOC only reduces inventory and matches the submitted sell price limit", () => {
  const bought = buy(), input = request({ clientOrderId: "weekly:2:sell", side: "sell", reduceOnly: true,
    quantity: 1, limitPrice: 99.95, createdAtMs: 20_000 });
  const orders = submitSpotPaperOrder([bought.order], input, bought.account);
  const result = executeSpotPaperOrder(orders[1]!, bought.account, snapshot({ book: { bids: [[100, 0.01], [99.95, 0.99], [99.9, 100]],
    asks: [[100.1, 100]], receivedAtMs: 20_000 } }), 20_000);
  assert.equal(result.order.filledQuantity, 0.05);
  assert.equal(result.account.quantity, 0.95);
  assert.ok(result.order.averageFillPrice! >= 99.95);
  assert.ok(result.account.realizedNetUsd < 0);
  validateSpotOrderLedger([bought.order, result.order], result.account);
});

test("order quantities and limits must match current lot, tick and minimum rules", () => {
  const account = createSpotAccount(1_000);
  for (const changed of [{ quantity: 1.0005 }, { limitPrice: 100.105 }]) {
    const result = executeSpotPaperOrder(pending(account, request(changed)), account, snapshot(), 10_000);
    assert.equal(result.order.cancellationReason, "ORDER_RULE_STEP_MISMATCH");
    assert.equal(result.account, account);
  }
  const result = executeSpotPaperOrder(pending(account, request({ quantity: 0.001 })), account, snapshot(), 10_000);
  assert.equal(result.order.cancellationReason, "BELOW_MINIMUM_ORDER");
});

test("freshness, fee policy and full original depth are validated before matching", () => {
  const account = createSpotAccount(1_000), order = pending(account);
  for (const receivedAtMs of [4_999, 10_001]) {
    const data = snapshot(); data.book.receivedAtMs = receivedAtMs;
    const result = executeSpotPaperOrder(order, account, data, 10_000);
    assert.equal(result.order.cancellationReason, "STALE_OR_FUTURE_BOOK");
    assert.equal(result.account, account);
  }
  assert.equal(executeSpotPaperOrder(order, account, snapshot({ feeBps: 0 }), 10_000).order.cancellationReason, "FEE_POLICY_MISMATCH");
  const malformed = snapshot(); malformed.book.asks.push([101, -1]);
  assert.equal(executeSpotPaperOrder(order, account, malformed, 10_000).order.cancellationReason, "INVALID_BOOK");
});

test("restored pending orders expire instead of executing against a later market", () => {
  const account = createSpotAccount(1_000), order = clone(pending(account));
  const nowMs = order.request.createdAtMs + SPOT_ORDER_SPEC.maximumLifetimeMs + 1;
  const data = snapshot(); data.book.receivedAtMs = nowMs;
  const result = executeSpotPaperOrder(order, clone(account), data, nowMs);
  assert.equal(result.order.cancellationReason, "REQUEST_EXPIRED");
  assert.equal(result.account.receipts.length, 0);
  validateSpotOrderLedger([result.order], result.account);
});

test("filled and partially filled restart retries never apply a second cash debit", () => {
  for (const depth of [100, 10]) {
    const account = createSpotAccount(1_000), data = snapshot(); data.book.asks = [[100, depth]];
    const result = executeSpotPaperOrder(pending(account), account, data, 10_000);
    const restoredOrder = clone(result.order), restoredAccount = clone(result.account);
    const retried = executeSpotPaperOrder(restoredOrder, restoredAccount, data, 100_000);
    assert.equal(retried.order, restoredOrder);
    assert.equal(retried.account, restoredAccount);
    assert.equal(retried.account.receipts.length, 1);
    validateSpotOrderLedger([retried.order], retried.account);
    assert.throws(() => executeSpotPaperOrder(restoredOrder, account, data, 100_000), /ORDER_RECEIPT_MISMATCH/);
  }
});

test("accepted recovery continues once and a pending order with a preexisting receipt is rejected", () => {
  const account = createSpotAccount(1_000), order = pending(account);
  const accepted: SpotPaperOrder = { ...order, status: "ACCEPTED", events: [...order.events, { type: "ACCEPTED", timestampMs: 10_000 }] };
  const result = executeSpotPaperOrder(clone(accepted), clone(account), snapshot(), 10_001);
  assert.deepEqual(result.order.events.map(event => event.type), ["SUBMITTED", "ACCEPTED", "FILLED"]);
  assert.throws(() => executeSpotPaperOrder(order, result.account, snapshot(), 10_002), /PENDING_ORDER_ALREADY_HAS_RECEIPT/);
});

test("explicit strategy cancellation is terminal and reversible request retries cannot reopen it", () => {
  const account = createSpotAccount(1_000), canceled = cancelSpotPaperOrder(pending(account), "STRATEGY_INVALIDATED", 10_001);
  assert.equal(canceled.status, "CANCELED");
  assert.equal(canceled.cancellationReason, "STRATEGY_INVALIDATED");
  assert.equal(executeSpotPaperOrder(canceled, account, snapshot(), 10_002).account, account);
  assert.equal(cancelSpotPaperOrder(canceled, "OTHER_REASON", 10_002), canceled);
  validateSpotOrderLedger([canceled], account);
  assert.throws(() => cancelSpotPaperOrder(pending(account), "", 10_001), /INVALID_ORDER_CANCELLATION/);
  assert.throws(() => cancelSpotPaperOrder(pending(account), "STOP", 9_999), /INVALID_ORDER_CANCELLATION/);
});

test("ledger validation rejects missing, orphaned, duplicated, altered and nonterminal fill evidence", () => {
  const bought = buy();
  assert.throws(() => validateSpotOrderLedger([], bought.account), /ORDER_RECEIPT_COUNT_MISMATCH/);
  assert.throws(() => validateSpotOrderLedger([bought.order], createSpotAccount(1_000)), /ORDER_RECEIPT_COUNT_MISMATCH/);
  assert.throws(() => validateSpotOrderLedger([bought.order, bought.order], bought.account), /DUPLICATE_ORDER_ID/);
  for (const mutate of [
    (order: SpotPaperOrder) => { order.filledQuantity += 1; },
    (order: SpotPaperOrder) => { order.feeUsd = 0; },
    (order: SpotPaperOrder) => { order.events[1]!.timestampMs = 9_999; },
    (order: SpotPaperOrder) => { order.status = "SUBMITTED"; },
    (order: SpotPaperOrder) => { order.fill!.price = 101; },
    (order: SpotPaperOrder) => { order.orderId += "x"; },
  ]) {
    const changed = clone(bought.order); mutate(changed);
    assert.throws(() => validateSpotOrderLedger([changed], clone(bought.account)), /SPOT_/);
  }
});

test("execution rejects reversed clocks without mutating pending order or account", () => {
  const account = createSpotAccount(1_000), order = pending(account);
  for (const nowMs of [9_999, -1, NaN, 10_000.5])
    assert.throws(() => executeSpotPaperOrder(order, account, snapshot(), nowMs), /INVALID_EXECUTION_CLOCK/);
  assert.equal(order.status, "SUBMITTED");
  assert.equal(account.cashUsd, 1_000);
});
