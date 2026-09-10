import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { loadPaperFundingRates, newPaperFundingState, observePaperFundingFill, observePaperFundingRates,
  paperFundingSnapshot, postPaperFunding, restorePaperFundingState, validatePaperFundingState,
  type PaperFundingFill, type PaperFundingRate, type PaperFundingState } from "../src/kraken/paper-funding.js";

const H = 3_600_000, T = Date.UTC(2026, 8, 9), BTC = "BTC/USD", ETH = "ETH/USD";
const PRODUCTS: Record<string, string> = { [BTC]: "PF_XBTUSD", [ETH]: "PF_ETHUSD" };
function fresh(initial: Record<string, number> = {}) {
  return newPaperFundingState({ startedAtMs: T, productsBySymbol: PRODUCTS, initialSignedQtyBySymbol: initial });
}
function rate(symbol = BTC, fromMs = T, amount = 2, knownAtMs = fromMs): PaperFundingRate {
  return { id: `rate:${symbol}:${fromMs}`, symbol, productId: PRODUCTS[symbol]!, effectiveFromMs: fromMs,
    effectiveToMs: fromMs + H, knownAtMs, absoluteUsdPerBasePerHour: amount, sourceResponseSha256: "a".repeat(64) };
}
function fill(state: PaperFundingState, atMs: number, side: 1 | -1, qty: number,
  options: { symbol?: string; id?: string; observedAtMs?: number } = {}) {
  return observePaperFundingFill(state, { id: options.id ?? `fill:${state.events.length}`, symbol: options.symbol ?? BTC,
    occurredAtMs: atMs, side, qty }, options.observedAtMs ?? atMs);
}
function near(actual: number | null, expected: number) { assert.ok(actual !== null && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`); }

test("ninety days of rates keep recurring quote projections bounded and reuse exact settled evidence", () => {
  const hours = 2_160, at = T + hours * H;
  let state = fresh({ [BTC]: 1 });
  // One hundred actual inventory changes, with exactly represented decimals.
  for (let i = 0; i < 100; i++) state = fill(state, T + Math.floor(i * hours * H / 100),
    i % 2 ? -1 : 1, .001, { id: `latency-fill-${i}` });
  state = observePaperFundingRates(state, Array.from({ length: hours }, (_, i) => rate(BTC, T + i * H, .01, at)), at);
  const first = paperFundingSnapshot(state, at + 1_000), durations: number[] = [];
  for (let i = 2; i < 9; i++) {
    const began = performance.now(), next = paperFundingSnapshot(state, at + i * 1_000);
    durations.push(performance.now() - began);
    assert.equal(next.perSymbol[0]!.obligations, first.perSymbol[0]!.obligations);
  }
  durations.sort((a, b) => a - b);
  assert.ok(durations[3]! < 100, `Median recurring quote projection ${durations[3]} ms exceeds the generous regression bound`);
  const crossed = paperFundingSnapshot(state, at + H);
  assert.equal(first.perSymbol[0]!.obligations.length + 1, crossed.perSymbol[0]!.obligations.length);
  assert.equal(crossed.fundingCashUsd, null, "future missing rate remains unknown despite cached history");
});

test("partial fills and reductions accrue only actual signed inventory holding intervals", () => {
  let state = fresh();
  state = fill(state, T + H / 4, 1, 2);
  state = fill(state, T + H / 2, 1, 1);
  state = fill(state, T + H * .75, -1, 1);
  state = fill(state, T + H * 1.5, -1, 2);
  state = observePaperFundingRates(state, [rate(), rate(BTC, T + H, 4)], T + 2 * H);
  const before = paperFundingSnapshot(state, T + 2 * H);
  near(before.fundingCashUsd, -7.5);
  assert.equal(before.perSymbol.find(row => row.symbol === BTC)!.signedBaseQty, 0);
  assert.equal(before.fundingAccountingKnown, false, "known due funding must be posted to model cash");
  const result = postPaperFunding(state, T + 2 * H);
  assert.equal(result.postings.length, 1); near(result.postings[0]!.cashDeltaUsd, -7.5);
  const after = paperFundingSnapshot(result.state);
  assert.equal(after.fundingAccountingKnown, true); near(after.postedFundingCashUsd, -7.5);
  assert.equal(after.venueCashReceiptsVerified, false);
  assert.equal(after.model, "PAPER_MODEL_NOT_VENUE_CASH_RECEIPTS");
});

test("shorts receive positive rates and pay negative rates without using market price", () => {
  let state = fresh({ [BTC]: -2, [ETH]: 3 });
  state = observePaperFundingRates(state, [rate(BTC, T, 2), rate(ETH, T, -4)], T);
  const open = paperFundingSnapshot(state, T + H / 2);
  near(open.fundingCashUsd, 8); near(open.postedFundingCashUsd, 0);
  assert.equal(open.dueModelPostings.length, 0, "open-hour accrual is not a cash settlement");
  const closed = postPaperFunding(state, T + H);
  near(closed.postings.reduce((n, row) => n + row.cashDeltaUsd, 0), 16);
});

test("partial-hour round trip settles on inventory change even without an hour boundary", () => {
  let state = observePaperFundingRates(fresh(), [rate()], T);
  state = fill(state, T + H / 4, -1, 2);
  state = fill(state, T + H * .75, 1, 2);
  const result = postPaperFunding(state, T + H * .75);
  near(result.postings[0]!.cashDeltaUsd, 2);
  assert.equal(result.postings[0]!.settledThroughMs, T + H * .75);
  near(paperFundingSnapshot(result.state, T + 24 * H).fundingCashUsd, 2);
});

test("missing held rates during an outage remain unknown until a genuine backfill arrives", () => {
  let state = fresh({ [BTC]: 1 });
  state = observePaperFundingRates(state, [rate()], T);
  const outage = paperFundingSnapshot(state, T + 2 * H);
  assert.equal(outage.fundingCashUsd, null); assert.equal(outage.fundingAccountingKnown, false);
  near(outage.knownPartialFundingCashUsd, -2);
  assert.equal(outage.perSymbol.find(row => row.symbol === BTC)!.missingRateMs, H);
  assert.deepEqual(postPaperFunding(state, T + 2 * H).postings, []);
  state = observePaperFundingRates(state, [rate(BTC, T + H, 0, T + 2 * H)], T + 2 * H);
  const posted = postPaperFunding(state, T + 2 * H);
  near(posted.postings[0]!.cashDeltaUsd, -2);
  assert.equal(paperFundingSnapshot(posted.state).fundingAccountingKnown, true);
});

test("fills, rates, and cash postings remain idempotent across replay and JSON restart", () => {
  const entry: PaperFundingFill = { id: "entry", symbol: BTC, occurredAtMs: T, side: 1, qty: 1 };
  let state = observePaperFundingFill(fresh(), entry, T);
  state = observePaperFundingRates(state, [rate()], T);
  const posted = postPaperFunding(state, T + H); state = posted.state;
  const restored = restorePaperFundingState(JSON.parse(JSON.stringify(state)), T + H);
  assert.equal(validatePaperFundingState(restored, T + H), true);
  assert.deepEqual(postPaperFunding(restored, T + H).postings, []);
  assert.equal(observePaperFundingFill(restored, entry, T + H), restored);
  assert.equal(observePaperFundingRates(restored, [{ ...rate(), knownAtMs: T + H, sourceResponseSha256: "b".repeat(64) }], T + H), restored);
  near(paperFundingSnapshot(restored).postedFundingCashUsd, -2);
  assert.throws(() => observePaperFundingFill(restored, { ...entry, qty: 2 }, T + H), /CONFLICTING_FILL/);
  assert.throws(() => observePaperFundingRates(restored, [{ ...rate(), absoluteUsdPerBasePerHour: 4 }], T + H), /CONFLICTING_RATE/);
});

test("late recovered fills correct cumulative cash instead of double charging old intervals", () => {
  let state = observePaperFundingRates(fresh({ [BTC]: 1 }), [rate()], T);
  state = postPaperFunding(state, T + H).state;
  state = fill(state, T + H / 2, 1, 1, { id: "late-entry", observedAtMs: T + H });
  const corrected = postPaperFunding(state, T + H);
  near(corrected.postings[0]!.cashDeltaUsd, -1);
  near(corrected.postings[0]!.targetSettledCashUsd, -3);
  near(paperFundingSnapshot(corrected.state).postedFundingCashUsd, -3);
  assert.deepEqual(postPaperFunding(corrected.state, T + H).postings, []);
});

test("late closure reverses excess model accrual while preserving the original cash events", () => {
  let state = fresh({ [BTC]: 1 });
  state = observePaperFundingRates(state, [rate(), rate(BTC, T + H, 2)], T + H);
  state = postPaperFunding(state, T + 2 * H).state;
  state = fill(state, T + H, -1, 1, { id: "late-close", observedAtMs: T + 2 * H });
  const correction = postPaperFunding(state, T + 2 * H);
  near(correction.postings[0]!.cashDeltaUsd, 2);
  near(paperFundingSnapshot(correction.state).postedFundingCashUsd, -2);
  assert.equal(correction.state.events.filter(row => row.type === "POSTING").length, 2);
});

test("same-time netting and decimal quantity sums avoid artificial residual inventory", () => {
  let state = fresh();
  state = fill(state, T, 1, .1); state = fill(state, T, 1, .2);
  state = fill(state, T + H / 2, -1, .3);
  state = observePaperFundingRates(state, [rate(BTC, T, 10)], T + H);
  const snap = paperFundingSnapshot(state);
  near(snap.fundingCashUsd, -1.5);
  assert.equal(snap.perSymbol.find(row => row.symbol === BTC)!.signedBaseQty, 0);
  assert.equal(paperFundingSnapshot(state, T + 2 * H).fundingCashUsd, -1.5);
});

test("a same-millisecond close and reopening still settle the preceding holding interval", () => {
  let state = observePaperFundingRates(fresh({ [BTC]: 1 }), [rate()], T);
  state = fill(state, T + H / 2, -1, 1, { id: "a-close" });
  state = fill(state, T + H / 2, 1, 1, { id: "b-reopen" });
  const posted = postPaperFunding(state, T + H / 2);
  near(posted.postings[0]!.cashDeltaUsd, -1);
  assert.equal(paperFundingSnapshot(posted.state).perSymbol.find(row => row.symbol === BTC)!.signedBaseQty, 1);
});

test("future knowledge, overlapping rates, wrong products, and altered checkpoints fail closed", () => {
  const state = fresh();
  assert.throws(() => observePaperFundingRates(state, [rate(BTC, T, 2, T + 1)], T), /FUTURE_RATE/);
  assert.throws(() => fill(state, T + 1, 1, 1, { observedAtMs: T }), /CLOCK/);
  assert.throws(() => observePaperFundingRates(state, [{ ...rate(), productId: "PF_ETHUSD" }], T), /RATE/);
  const known = observePaperFundingRates(state, [rate()], T);
  assert.throws(() => observePaperFundingRates(known, [{ ...rate(), id: "other" }], T), /CONFLICTING_RATE/);
  const saved = JSON.parse(JSON.stringify(known)); saved.events[0].rates[0].absoluteUsdPerBasePerHour = 100;
  assert.equal(validatePaperFundingState(saved), false);
  assert.throws(() => restorePaperFundingState(saved, T), /CHECKPOINT/);
  assert.throws(() => paperFundingSnapshot(known, T - 1), /CLOCK/);
  assert.equal(validatePaperFundingState(known, T - 1), false);
});

function responseRows(rows = [{ timestamp: new Date(T).toISOString(), fundingRate: 2, relativeFundingRate: .00002 }]) {
  return JSON.stringify({ result: "success", serverTime: new Date(T + H / 2).toISOString(), rates: rows });
}
test("public historical API rates normalize period starts and preserve receipt-time provenance", async () => {
  const urls: string[] = [], bytes = responseRows();
  const result = await loadPaperFundingRates({ productsBySymbol: { [BTC]: PRODUCTS[BTC]! }, fromMs: T + H / 4 }, {
    now: () => T + H / 2, fetcher: async input => { urls.push(String(input)); return new Response(bytes); } });
  assert.deepEqual(urls, ["https://futures.kraken.com/derivatives/api/v3/historical-funding-rates?symbol=PF_XBTUSD"]);
  assert.equal(result.observedAtMs, T + H / 2); assert.equal(result.rates.length, 1);
  assert.equal(result.rates[0]!.effectiveFromMs, T); assert.equal(result.rates[0]!.effectiveToMs, T + H);
  assert.equal(result.rates[0]!.knownAtMs, T + H / 2); assert.equal(result.rates[0]!.absoluteUsdPerBasePerHour, 2);
  assert.match(result.rates[0]!.sourceResponseSha256, /^[a-f0-9]{64}$/);
});

test("downloader rejects bad or failed source responses and leaves gaps visible", async () => {
  const request = { productsBySymbol: { [BTC]: PRODUCTS[BTC]! }, fromMs: T };
  for (const response of [new Response("unavailable", { status: 503 }),
    new Response(responseRows([{ timestamp: new Date(T + H).toISOString(), fundingRate: 2, relativeFundingRate: .00002 }])),
    new Response(responseRows([{ timestamp: new Date(T).toISOString(), fundingRate: 2, relativeFundingRate: -.00002 }])),
  ]) await assert.rejects(loadPaperFundingRates(request, { now: () => T + H / 2, fetcher: async () => response }), /PAPER_FUNDING/);
  const empty = await loadPaperFundingRates(request, { now: () => T + H / 2,
    fetcher: async () => new Response(responseRows([])) });
  assert.deepEqual(empty.rates, []);
  assert.equal(paperFundingSnapshot(fresh({ [BTC]: 1 }), T + H / 2).fundingCashUsd, null);
});
