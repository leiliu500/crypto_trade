import test from "node:test";
import assert from "node:assert/strict";
import { createPaperState, deriveEth40Signal, ETH40_HISTORY_ANCHOR_MS as ANCHOR,
  runPaperCycle, validatePaperState } from "../src/eth40/engine.js";
import { DAY_MS as D, ETH40_SPEC as S } from "../src/eth40/spec.js";
import type { Asset, DailyBar, MarketSnapshot, PaperState, VerifiedBook } from "../src/eth40/types.js";

function bars(closes: number[]): DailyBar[] {
  return closes.map((close, i) => ({ openTimeMs: ANCHOR + i * D, open: close, high: close, low: close, close, volume: 100_000 }));
}
function book(symbol: Asset, now: number, price = symbol === "ETH/USD" ? 100 : 50_000, depth = 10_000): VerifiedBook {
  const tick = symbol === "ETH/USD" ? .1 : 10;
  return { symbol, receivedAtMs: now, exchangeUpdateAtMs: now, checksumValid: true,
    checksum: "123456", connectionId: `connection-${symbol}`, bids: [[price - tick, depth]], asks: [[price, depth]] };
}
const closes = () => [...Array(90).fill(100) as number[], 105];
const launch = ANCHOR + 90 * D + 12 * 3_600_000;
const first = ANCHOR + 92 * D;
function snapshot(now = first, history = bars(closes())): MarketSnapshot {
  return { observedAtMs: now, histories: { "ETH/USD": history, "BTC/USD": history.map(b => ({ ...b, open: 50_000, high: 50_000, low: 50_000, close: 50_000 })) },
    books: { "ETH/USD": book("ETH/USD", now), "BTC/USD": book("BTC/USD", now) },
    rules: { "ETH/USD": { lotSize: .5, minimumQuantity: .5, minimumNotionalUsd: 1, tickSize: .1 },
      "BTC/USD": { lotSize: .00001, minimumQuantity: .00001, minimumNotionalUsd: 1, tickSize: 10 } },
    rulesFetchedAtMs: now, errors: [], evidenceIds: ["fixture"] };
}
function clone<T>(x: T): T { return structuredClone(x); }
function filledState(): PaperState { return runPaperCycle(createPaperState(launch), snapshot(), "first").state; }

test("ETH40 uses the anchored 90-bar warmup and strict current-close-inclusive entry boundary", () => {
  const c = Array(90).fill(100) as number[];
  c[89] = 10_000;
  assert.equal(deriveEth40Signal(bars(c), ANCHOR + 91 * D).target, "cash");
  const multiplier = 1 + S.entryBandFraction;
  const boundary = 39 * 100 * multiplier / (40 - multiplier);
  for (const [offset, expected] of [[-1e-6, "cash"], [1e-6, "long"]] as const) {
    const signal = deriveEth40Signal(bars([...Array(90).fill(100), boundary + offset]), first);
    assert.equal(signal.target, expected);
    assert.ok(signal.sma40 !== null);
    assert.ok(Math.abs(signal.sma40 - (39 * 100 + boundary + offset) / 40) < 1e-12);
  }
});

test("ETH40 reconstructs hysteresis, exits at the mean and never resets on a rolling slice", () => {
  const c = [...closes(), 100.5];
  assert.equal(deriveEth40Signal(bars(c), first + D).target, "long");
  assert.equal(deriveEth40Signal(bars([...c, ...Array(40).fill(100)]), first + 41 * D).target, "cash");
  assert.throws(() => deriveEth40Signal(bars(c).slice(1), first + D), /HISTORY_GAP/);
});

test("missing, duplicate, reordered or unfinished eligible history blocks signals", () => {
  const original = bars(closes());
  for (const changed of [original.filter((_, i) => i !== 40), [...original.slice(0, 41), original[40]!, ...original.slice(41)],
    [original[1]!, original[0]!, ...original.slice(2)], original.slice(0, -1)]) {
    const result = runPaperCycle(createPaperState(launch), snapshot(first, changed), "bad-history");
    assert.equal(result.decisions[0]!.action, "blocked");
    assert.equal(result.state.portfolios.eth40.account.receipts.length, 0);
  }
});

test("day minus two is the only eligible candle; later rows cannot change a signal", () => {
  const original = bars(closes());
  const expected = deriveEth40Signal(original, first);
  const future = [...original, { ...original[0]!, openTimeMs: first - D, close: 0, high: NaN },
    { ...original[0]!, openTimeMs: first + 100 * D, close: 1e100 }];
  assert.deepEqual(deriveEth40Signal(future, first), expected);
  assert.equal(expected.signalDayMs, first - 2 * D);
});

test("launch waits two UTC days and the execution window excludes exactly second 60", () => {
  const initial = createPaperState(launch);
  assert.equal(initial.firstExecutionDayMs, first);
  const waiting = runPaperCycle(initial, snapshot(first - 1), "wait");
  assert.ok(waiting.decisions.every(d => d.reason === "WAITING_FOR_FIRST_PROSPECTIVE_EXECUTION_DAY"));
  const missed = runPaperCycle(initial, snapshot(first + 60_000), "missed");
  assert.ok(missed.decisions.every(d => d.reason === "EXECUTION_WINDOW_MISSED_NO_RETROFILL"));
  assert.ok(Object.values(missed.state.portfolios).every(p => !p.entered));
});

test("fresh asset-specific books create fee-inclusive funded entries with no additions", () => {
  const initial = createPaperState(launch), before = clone(initial);
  const result = runPaperCycle(initial, snapshot(), "first");
  assert.deepEqual(initial, before);
  assert.ok(result.decisions.every(d => d.action === "buy"));
  for (const id of ["eth40", "passiveEth", "passiveBtc"] as const) {
    const p = result.state.portfolios[id], fill = p.account.receipts[0]!;
    assert.equal(p.account.initialCashUsd, 10_000);
    assert.ok(fill.quantity * fill.price * 1.008 <= 1_000);
    assert.ok(Math.abs(p.account.feesUsd - fill.quantity * fill.price * .008) < 1e-10);
    assert.equal(p.account.quantity, fill.quantity);
    assert.equal(p.completedEpisodes, 0);
  }
  assert.equal(result.state.portfolios.eth40.account.receipts[0]!.price, 100);
  assert.equal(result.state.portfolios.passiveBtc.account.receipts[0]!.price, 50_000);
  const again = runPaperCycle(result.state, snapshot(first + 1_000), "different-cycle");
  assert.ok(again.decisions.every(d => d.reason === "HOLD_LONG_NO_ADDITIONS"));
  assert.ok(Object.values(again.state.portfolios).every(p => p.account.receipts.length === 1));
});

test("entry volume cap consumes signal-day volume and never later volume", () => {
  const market = snapshot();
  market.histories["ETH/USD"][90]!.volume = 1_000;
  market.histories["ETH/USD"].push({ ...market.histories["ETH/USD"][90]!, openTimeMs: first - D, volume: 1e12 });
  const result = runPaperCycle(createPaperState(launch), market, "volume");
  assert.equal(result.decisions[0]!.budgetUsd, 105);
  assert.ok(result.state.portfolios.eth40.account.entryCostUsd <= 105);
});

test("stale local/exchange timestamps, excessive future lead and failed checksum deny fills", () => {
  const mutate = [
    (b: VerifiedBook) => { b.receivedAtMs -= 5_001; },
    (b: VerifiedBook) => { b.exchangeUpdateAtMs -= 5_001; },
    (b: VerifiedBook) => { b.exchangeUpdateAtMs += 1_001; },
    (b: VerifiedBook) => { b.receivedAtMs += 1; },
    (b: VerifiedBook) => { b.checksumValid = false; },
    (b: VerifiedBook) => { b.symbol = "BTC/USD"; },
  ];
  for (const change of mutate) {
    const market = snapshot(); change(market.books["ETH/USD"]!);
    const result = runPaperCycle(createPaperState(launch), market, "bad-quote");
    assert.equal(result.decisions[0]!.action, "blocked");
    assert.equal(result.decisions[1]!.action, "blocked");
    assert.equal(result.decisions[2]!.action, "buy");
  }
  const permitted = snapshot(); permitted.books["ETH/USD"]!.exchangeUpdateAtMs += 1_000;
  assert.equal(runPaperCycle(createPaperState(launch), permitted, "lead-limit").decisions[0]!.action, "buy");
});

test("stale instrument rules deny execution and fresh retry within the window can fill", () => {
  const stale = snapshot(); stale.rulesFetchedAtMs -= D + 1;
  const rejected = runPaperCycle(createPaperState(launch), stale, "rules-stale");
  assert.ok(rejected.decisions.every(d => d.reason === "STALE_OR_FUTURE_INSTRUMENT_RULES"));
  const retry = runPaperCycle(rejected.state, snapshot(first + 59_999), "retry");
  assert.ok(retry.decisions.every(d => d.action === "buy"));
});

test("a missed first passive window can buy at the next valid daily window only once", () => {
  const initial = runPaperCycle(createPaperState(launch), snapshot(first + 60_000), "miss").state;
  const next = snapshot(first + D, bars([...closes(), 106]));
  const result = runPaperCycle(initial, next, "next-day");
  assert.ok(result.decisions.every(d => d.action === "buy"));
  const later = runPaperCycle(result.state, snapshot(first + 2 * D, bars([...closes(), 106, 107])), "following-day");
  assert.ok(later.decisions.every(d => d.action === "hold"));
});

test("fresh liquidation marks charge exit fees; stale held inventory has unknown PnL", () => {
  const state = filledState(), market = snapshot(first + 1_000);
  const fresh = runPaperCycle(state, market, "mark");
  const p = fresh.state.portfolios.eth40.account, value = fresh.valuations[0]!;
  assert.ok(Math.abs(value.liquidationEquityUsd! - (p.cashUsd + p.quantity * 99.9 * .992)) < 1e-10);
  const peak = fresh.state.portfolios.eth40.peakLiquidationEquityUsd;
  market.observedAtMs = first + 10_000;
  const stale = runPaperCycle(fresh.state, market, "stale-mark");
  assert.equal(stale.valuations[0]!.liquidationEquityUsd, null);
  assert.equal(stale.valuations[0]!.netPnlUsd, null);
  assert.equal(stale.valuations[0]!.fresh, false);
  assert.equal(stale.state.portfolios.eth40.peakLiquidationEquityUsd, peak);
});

test("partial exits wait for a later cash-signal day and count only a full flatten", () => {
  const next = snapshot(first + D, bars([...closes(), 80]));
  next.books["ETH/USD"] = book("ETH/USD", next.observedAtMs, 80, 10);
  const partial = runPaperCycle(filledState(), next, "partial");
  assert.equal(partial.decisions[0]!.action, "sell");
  assert.equal(partial.decisions[0]!.reason, "PARTIAL_EXIT_RESIDUAL_REMAINS");
  assert.equal(partial.state.portfolios.eth40.account.quantity, 9);
  assert.equal(partial.state.portfolios.eth40.completedEpisodes, 0);
  next.observedAtMs += 1_000; next.books["ETH/USD"] = book("ETH/USD", next.observedAtMs, 80);
  const retry = runPaperCycle(partial.state, next, "same-day");
  assert.equal(retry.decisions[0]!.reason, "ACCOUNT_ALREADY_FILLED_THIS_DAY");
  const full = runPaperCycle(retry.state, snapshot(first + 2 * D, bars([...closes(), 80, 80])), "flatten");
  assert.equal(full.state.portfolios.eth40.account.quantity, 0);
  assert.equal(full.state.portfolios.eth40.completedEpisodes, 1);
  assert.equal(full.state.portfolios.passiveEth.account.receipts.length, 1);
});

test("untradeable residual dust stays open and never fabricates a completed episode", () => {
  const next = snapshot(first + D, bars([...closes(), 80]));
  next.rules["ETH/USD"] = { ...next.rules["ETH/USD"]!, lotSize: 1, minimumQuantity: 1 };
  const partial = runPaperCycle(filledState(), next, "dust");
  assert.equal(partial.state.portfolios.eth40.account.quantity, .5);
  assert.equal(partial.state.portfolios.eth40.completedEpisodes, 0);
  const after = snapshot(first + 2 * D, bars([...closes(), 80, 80])); after.rules["ETH/USD"] = next.rules["ETH/USD"];
  const blocked = runPaperCycle(partial.state, after, "dust-remains");
  assert.equal(blocked.decisions[0]!.action, "blocked");
  assert.equal(blocked.state.portfolios.eth40.account.quantity, .5);
  assert.equal(blocked.state.portfolios.eth40.completedEpisodes, 0);
});

test("serialized restart replays idempotently and rejects forged receipts or aggregates", () => {
  const state = JSON.parse(JSON.stringify(filledState())) as PaperState;
  validatePaperState(state);
  const again = runPaperCycle(state, snapshot(first), "restart-same-time");
  assert.deepEqual(again.state, state);
  assert.ok(again.decisions.every(d => d.fill === null));
  for (const mutate of [
    (s: PaperState) => { s.portfolios.eth40.account.cashUsd += 1; },
    (s: PaperState) => { s.portfolios.eth40.completedEpisodes = 1; },
    (s: PaperState) => { s.portfolios.eth40.lastFillDayMs = null; },
    (s: PaperState) => { s.portfolios.eth40.entered = false; },
    (s: PaperState) => { s.portfolios.eth40.account.receipts[0]!.feeBps = 0; },
    (s: PaperState) => { s.portfolios.eth40.account.receipts[0]!.timestampMs += 60_000; },
  ]) {
    const forged = clone(state); mutate(forged); assert.throws(() => validatePaperState(forged));
  }
  assert.throws(() => runPaperCycle(state, snapshot(first - 1), "backwards"), /REVERSED_CYCLE/);
});
