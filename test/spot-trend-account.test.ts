import assert from "node:assert/strict";
import test from "node:test";
import { applySpotFill, createSpotAccount, markSpotAccount, planSpotPaperFill,
  type SpotAccount, type SpotFill, type SpotPaperFillInput } from "../src/spot-trend/account.js";

const close = (actual: number, expected: number): void =>
  assert.ok(Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
const fill = (overrides: Partial<SpotFill> = {}): SpotFill => ({ id: "buy-1", side: "buy", quantity: 1,
  price: 100, feeBps: 40, timestampMs: 1_000, ...overrides });
const planInput = (overrides: Partial<SpotPaperFillInput> = {}): SpotPaperFillInput => ({
  account: createSpotAccount(1_000), side: "buy", budgetUsd: 100,
  book: { bids: [[99.9, 100]], asks: [[100, 100]], receivedAtMs: 10_000 }, nowMs: 10_000,
  feeBps: 40, rules: { lotSize: 0.001, minimumQuantity: 0.001, minimumNotionalUsd: 1, tickSize: 0.01 },
  id: "planned-1", ...overrides });

test("spot ledger preserves cash identity through a profitable complete round trip", () => {
  const initial = createSpotAccount(1_000), receipt = fill();
  const bought = applySpotFill(initial, receipt);
  assert.equal(initial.cashUsd, 1_000);
  assert.equal(initial.receipts.length, 0);
  close(bought.cashUsd, 899.6);
  close(bought.entryCostUsd, 100.4);
  close(bought.feesUsd, 0.4);
  const sold = applySpotFill(bought, fill({ id: "sell-1", side: "sell", price: 110, timestampMs: 2_000 }));
  close(sold.cashUsd, 1_009.16);
  close(sold.realizedNetUsd, 9.16);
  close(sold.feesUsd, 0.84);
  assert.equal(sold.quantity, 0);
  assert.equal(sold.entryCostUsd, 0);
  assert.equal(sold.receipts.length, 2);
  close(markSpotAccount(sold, 110, 40).netPnlUsd, 9.16);
  receipt.price = 1;
  assert.equal(bought.receipts[0]!.price, 100);
});

test("spot weighted entry cost includes fees and allocates them on partial exits", () => {
  let account = applySpotFill(createSpotAccount(1_000), fill());
  account = applySpotFill(account, fill({ id: "buy-2", quantity: 2, price: 120, timestampMs: 2_000 }));
  close(account.entryCostUsd, 341.36);
  account = applySpotFill(account, fill({ id: "sell-1", side: "sell", quantity: 1.5, price: 90, timestampMs: 3_000 }));
  close(account.cashUsd, 793.1);
  close(account.entryCostUsd, 170.68);
  close(account.realizedNetUsd, -36.22);
  close(account.feesUsd, 1.9);
  assert.equal(account.quantity, 1.5);
  const mark = markSpotAccount(account, 80, 40);
  close(mark.equityUsd, 913.1);
  close(mark.liquidationEquityUsd, 912.62);
  close(mark.unrealizedNetUsd, -51.16);
  close(mark.netPnlUsd, -87.38);
  close(mark.netPnlUsd, account.realizedNetUsd + mark.unrealizedNetUsd);
});

test("spot marks count entry and hypothetical exit fees exactly once", () => {
  const account = applySpotFill(createSpotAccount(1_000), fill());
  const mark = markSpotAccount(account, 100, 40);
  close(mark.equityUsd, 999.6);
  close(mark.liquidationEquityUsd, 999.2);
  close(mark.netPnlUsd, -0.8);
  close(mark.unrealizedNetUsd, -0.8);
  assert.equal(account.realizedNetUsd, 0);
});

test("exact duplicate fills remain idempotent even after a newer fill", () => {
  const first = fill();
  const account = applySpotFill(applySpotFill(createSpotAccount(), first),
    fill({ id: "buy-2", timestampMs: 2_000 }));
  assert.equal(applySpotFill(account, { ...first }), account);
  for (const changed of [{ quantity: 2 }, { price: 101 }, { feeBps: 0 }, { timestampMs: 1_001 }, { side: "sell" as const }])
    assert.throws(() => applySpotFill(account, { ...first, ...changed }), /CONFLICTING_FILL_ID/);
});

test("spot ledger rejects overspending, overselling, and reversed new receipts without mutation", () => {
  const initial = createSpotAccount(100);
  assert.throws(() => applySpotFill(initial, fill()), /INSUFFICIENT_CASH/);
  assert.throws(() => applySpotFill(initial, fill({ feeBps: 0, price: 100 + 1e-12 })), /INSUFFICIENT_CASH/);
  assert.throws(() => applySpotFill(initial, fill({ side: "sell" })), /INSUFFICIENT_INVENTORY/);
  const account = applySpotFill(initial, fill({ feeBps: 0 }));
  assert.equal(account.cashUsd, 0);
  assert.throws(() => applySpotFill(account, fill({ id: "sell-1", side: "sell", quantity: 1 + 1e-14 })), /INSUFFICIENT_INVENTORY/);
  assert.throws(() => applySpotFill(account, fill({ id: "sell-1", side: "sell", timestampMs: 999 })), /REVERSED_FILL_TIME/);
  assert.equal(account.quantity, 1);
  assert.equal(account.receipts.length, 1);
});

test("spot ledger rejects invalid quantities, prices, fees, clocks, and overflow", () => {
  for (const initial of [0, -1, NaN, Infinity]) assert.throws(() => createSpotAccount(initial), /INVALID_INITIAL_CASH/);
  const account = createSpotAccount();
  for (const invalid of [{ quantity: 0 }, { quantity: -1 }, { quantity: NaN }, { price: Infinity }, { price: 0 },
    { feeBps: -1 }, { feeBps: NaN }, { feeBps: 10_000 }, { feeBps: 20_000 },
    { timestampMs: -1 }, { timestampMs: 0.5 }, { id: " " }])
    assert.throws(() => applySpotFill(account, fill(invalid)), /INVALID_FILL/);
  assert.throws(() => applySpotFill(account, fill({ quantity: 1e200, price: 1e200 })), /ARITHMETIC_OVERFLOW/);
  assert.throws(() => markSpotAccount(account, NaN, 0), /INVALID_MARK/);
  assert.throws(() => markSpotAccount(account, 100, -1), /INVALID_MARK/);
  assert.throws(() => markSpotAccount(account, 100, 10_000), /INVALID_MARK/);
  assert.throws(() => markSpotAccount(account, 100, 20_000), /INVALID_MARK/);
});

test("spot ledger fails closed when floating precision would grant inventory without a cash debit", () => {
  const rich = createSpotAccount(1e20);
  assert.throws(() => applySpotFill(rich, fill({ feeBps: 0, price: 1 })), /UNREPRESENTABLE_FILL/);
  const input = planInput({ account: rich, budgetUsd: 100 });
  assert.equal(planSpotPaperFill(input).reason, "UNREPRESENTABLE_FILL");
});

test("restored spot accounts reconcile their receipts and cannot manufacture cash from rounded aggregates", () => {
  const original = applySpotFill(createSpotAccount(1_000), fill());
  const restored = JSON.parse(JSON.stringify(original)) as SpotAccount;
  assert.deepEqual(markSpotAccount(restored, 100, 40), markSpotAccount(original, 100, 40));
  restored.cashUsd += 1;
  assert.throws(() => markSpotAccount(restored, 100, 40), /RECONCILIATION_FAILED/);
  restored.cashUsd = original.cashUsd + 1e-12;
  assert.throws(() => applySpotFill(restored, fill({ id: "buy-2", quantity: 1, price: restored.cashUsd,
    feeBps: 0, timestampMs: 2_000 })), /INSUFFICIENT_CASH/);
  restored.cashUsd = original.cashUsd;
  restored.receipts.push({ ...restored.receipts[0]! });
  assert.throws(() => markSpotAccount(restored, 100, 40), /DUPLICATE_RECEIPT/);
});

test("L2 purchases round down to lots and respect the all-in budget including fees", () => {
  const input = planInput(), result = planSpotPaperFill(input);
  assert.equal(result.reason, "PAPER_FILL_PLANNED");
  assert.ok(result.fill);
  assert.equal(result.fill.quantity, 0.996);
  assert.equal(result.fill.price, 100);
  const debit = result.fill.quantity * result.fill.price * 1.004;
  assert.ok(debit <= 100);
  assert.ok((result.fill.quantity + input.rules.lotSize) * 100 * 1.004 > 100);
  const account = applySpotFill(input.account, result.fill);
  close(account.cashUsd, 900.0016);
  assert.equal(result.visibleNotionalUsd, 10_000);
});

test("L2 cash caps a larger requested budget and omitted budgets use available cash", () => {
  for (const budget of [1_000, undefined]) {
    const input = planInput({ account: createSpotAccount(100) });
    if (budget === undefined) delete input.budgetUsd; else input.budgetUsd = budget;
    const result = planSpotPaperFill(input);
    assert.ok(result.fill);
    const account = applySpotFill(input.account, result.fill);
    assert.ok(account.cashUsd >= 0);
    assert.equal(result.fill.quantity, 0.996);
  }
});

test("L2 walks actual depth and caps fills at five percent of depth inside ten basis points", () => {
  const result = planSpotPaperFill(planInput({ budgetUsd: 1_000,
    book: { bids: [[99.9, 100]], asks: [[100, 0.01], [100.05, 1], [100.1, 8.99], [100.11, 1_000]], receivedAtMs: 10_000 } }));
  assert.ok(result.fill);
  assert.equal(result.fill.quantity, 0.5);
  close(result.fill.price, (0.01 * 100 + 0.49 * 100.05) / 0.5);
  close(result.visibleNotionalUsd, 0.01 * 100 + 100.05 + 8.99 * 100.1);
  assert.ok(result.fill.price > 100);
  assert.ok(result.fill.price <= 100.1);
});

test("L2 sale book walks toward lower bids and cannot exceed actual inventory", () => {
  const account = applySpotFill(createSpotAccount(1_000), fill({ quantity: 0.25, feeBps: 0 }));
  const input = planInput({ account, side: "sell",
    book: { bids: [[100, 0.01], [99.95, 1], [99.9, 8.99], [99.89, 1_000]], asks: [[100.1, 100]], receivedAtMs: 10_000 } });
  delete input.budgetUsd;
  const result = planSpotPaperFill(input);
  assert.ok(result.fill);
  assert.equal(result.fill.quantity, 0.25);
  close(result.fill.price, (0.01 * 100 + 0.24 * 99.95) / 0.25);
  const sold = applySpotFill(account, result.fill);
  assert.equal(sold.quantity, 0);
  assert.equal(sold.entryCostUsd, 0);
  assert.ok(sold.realizedNetUsd < 0);
});

test("L2 quantity bounds permit partial inventory reductions without flattening", () => {
  const account = applySpotFill(createSpotAccount(1_000), fill({ quantity: 2, feeBps: 0 }));
  const input = planInput({ account, side: "sell", quantity: 0.1259 });
  delete input.budgetUsd;
  const result = planSpotPaperFill(input);
  assert.ok(result.fill);
  assert.equal(result.fill.quantity, 0.125);
  assert.equal(applySpotFill(account, result.fill).quantity, 1.875);
  input.quantity = 20;
  assert.equal(planSpotPaperFill(input).fill?.quantity, 2);
  assert.equal(planSpotPaperFill(planInput({ quantity: 1 })).reason, "INVALID_INPUT");
});

test("L2 rejects insufficient liquidity, lot quantity, and gross minimum notional", () => {
  const examples = [planInput({ book: { bids: [[99.9, 100]], asks: [[100, 0.01]], receivedAtMs: 10_000 } }),
    planInput({ budgetUsd: 0.5 }),
    planInput({ rules: { lotSize: 0.001, minimumQuantity: 2, minimumNotionalUsd: 1, tickSize: 0.01 } }),
    planInput({ rules: { lotSize: 0.001, minimumQuantity: 0.001, minimumNotionalUsd: 100, tickSize: 0.01 } }),
    planInput({ side: "sell" })];
  for (const example of examples) assert.equal(planSpotPaperFill(example).reason, "BELOW_MINIMUM_EXECUTABLE_ORDER");
});

test("L2 rejects stale and future data; exactly five seconds is allowed", () => {
  for (const receivedAtMs of [4_999, 10_001, NaN, -1]) {
    const input = planInput(); input.book.receivedAtMs = receivedAtMs;
    assert.equal(planSpotPaperFill(input).reason, "STALE_OR_FUTURE_BOOK");
  }
  const input = planInput(); input.book.receivedAtMs = 5_000;
  assert.ok(planSpotPaperFill(input).fill);
});

test("L2 validates both sides, ordering, tick alignment, and positive real depth", () => {
  const invalidBooks: SpotPaperFillInput["book"][] = [
    { bids: [], asks: [[100, 100]], receivedAtMs: 10_000 },
    { bids: [[100, 100]], asks: [[100, 100]], receivedAtMs: 10_000 },
    { bids: [[101, 100]], asks: [[100, 100]], receivedAtMs: 10_000 },
    { bids: [[99, 100], [99.5, 1]], asks: [[100, 100]], receivedAtMs: 10_000 },
    { bids: [[99, 100]], asks: [[100, 100], [99.9, 1]], receivedAtMs: 10_000 },
    { bids: [[99, 100]], asks: [[100, 100], [100, 1]], receivedAtMs: 10_000 },
    { bids: [[99, 100]], asks: [[100.005, 100]], receivedAtMs: 10_000 },
    { bids: [[99, -1]], asks: [[100, 100]], receivedAtMs: 10_000 },
    { bids: [[99, 1]], asks: [[100, Infinity]], receivedAtMs: 10_000 },
  ];
  for (const book of invalidBooks) assert.equal(planSpotPaperFill(planInput({ book })).reason, "INVALID_BOOK");
});

test("L2 planner rejects malformed rules, reused IDs, and account time reversal", () => {
  assert.equal(planSpotPaperFill(planInput({ feeBps: -1 })).reason, "INVALID_INPUT");
  assert.equal(planSpotPaperFill(planInput({ feeBps: 10_000 })).reason, "INVALID_INPUT");
  assert.equal(planSpotPaperFill(planInput({ feeBps: 20_000 })).reason, "INVALID_INPUT");
  assert.equal(planSpotPaperFill(planInput({ budgetUsd: Infinity })).reason, "INVALID_INPUT");
  const input = planInput(); input.rules.lotSize = 0;
  assert.equal(planSpotPaperFill(input).reason, "INVALID_RULES");
  const account = applySpotFill(createSpotAccount(), fill({ id: "planned-1" }));
  assert.equal(planSpotPaperFill(planInput({ account })).reason, "FILL_ID_ALREADY_USED");
  assert.equal(planSpotPaperFill(planInput({ account, id: "new", nowMs: 999 })).reason, "REVERSED_FILL_TIME");
  const corrupted = { ...account, cashUsd: account.cashUsd + 1 };
  assert.equal(planSpotPaperFill(planInput({ account: corrupted })).reason, "INVALID_ACCOUNT");
});

test("L2 discrete search never rounds purchases above cash over varied fractional budgets", () => {
  for (let index = 1; index <= 250; index++) {
    const cash = 1 + index * 0.137, input = planInput({ account: createSpotAccount(cash), budgetUsd: cash,
      feeBps: 40 + index % 7, rules: { lotSize: 0.0001, minimumQuantity: 0.0001, minimumNotionalUsd: 0, tickSize: 0.01 } });
    const result = planSpotPaperFill(input);
    assert.ok(result.fill);
    assert.ok(result.fill.quantity * result.fill.price * (1 + input.feeBps / 10_000) <= cash + 1e-14);
    const after = applySpotFill(input.account, result.fill);
    assert.ok(after.cashUsd >= 0);
    close(after.cashUsd + after.entryCostUsd, cash);
  }
});
