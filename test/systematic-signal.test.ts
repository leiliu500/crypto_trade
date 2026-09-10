import assert from "node:assert/strict";
import test from "node:test";
import { buildSystematicSignal } from "../src/systematic/signal.js";
import { loadSystematicHistory } from "../src/systematic/history.js";
import { SYSTEMATIC_SPEC as S, type SystematicBar } from "../src/systematic/spec.js";

const HOUR = S.barMs, START = Date.UTC(2026, 7, 20), END = START + S.minimumBars * HOUR;
const products = { "BTC/USD": "PF_XBTUSD", "ETH/USD": "PF_ETHUSD" };
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9,
  `Expected ${actual} near ${expected}`);
function bars(count: number = S.minimumBars, slope = 1, symbol = "BTC/USD"): SystematicBar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = 1000 + slope * i;
    return { symbol, openMs: START + i * HOUR, open: close, high: close + 1,
      low: close - 1, close, volume: 100 };
  });
}
const signal = (input = bars(), asOf = END) => buildSystematicSignal(input, "BTC/USD", asOf)!;
function response(input = bars(), patch: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ candles: input.map(bar => ({ time: bar.openMs,
    open: String(bar.open), high: String(bar.high), low: String(bar.low), close: String(bar.close),
    volume: String(bar.volume) })), more_candles: false, ...patch }), { status: 200 });
}

test("systematic trend independently matches EMA linear-series formula and ATR risk distances", () => {
  for (const slope of [1, -1]) {
    const result = signal(bars(S.minimumBars, slope));
    const expectedEma = (span: number) => {
      const alpha = 2 / (span + 1), last = S.minimumBars - 1;
      return 1000 + slope * last - slope * (1 - alpha) / alpha * (1 - (1 - alpha) ** last);
    };
    near(result.emaFast, expectedEma(16)); near(result.emaSlow, expectedEma(64)); near(result.atr, 2);
    near(result.trendStrength, (expectedEma(16) - expectedEma(64)) / 2);
    near(result.stopBps, 4 / result.close * 10_000); near(result.targetBps, 8 / result.close * 10_000);
    assert.equal(result.side, slope); assert.equal(result.reason, "SYSTEMATIC_TREND_SIGNAL");
    assert.equal(result.barCloseMs, END); assert.equal(result.bars, 192);
    assert.equal(result.availableAtMs, END); assert.equal(result.version, S.version);
    assert.match(result.inputSha256, /^[a-f0-9]{64}$/);
    assert.equal("expectedReturn" in result, false); assert.equal("probability" in result, false);
  }
});

test("flat and zero-range histories return explicit no-entry diagnostics", () => {
  const flat = signal(bars(S.minimumBars, 0));
  assert.equal(flat.side, null); assert.equal(flat.reason, "WEAK_TREND"); near(flat.atr, 2);
  const zero = signal(bars(S.minimumBars, 0).map(bar => ({ ...bar, high: bar.close, low: bar.close })));
  assert.equal(zero.side, null); assert.equal(zero.reason, "NO_VOLATILITY");
  assert.equal(zero.trendStrength, 0); assert.equal(zero.stopBps, 0);
});

test("a price disagreeing with the EMA direction does not enter", () => {
  const input = bars(), last = input.at(-1)!;
  last.close -= 70; last.open = last.close; last.high = last.close + 1; last.low = last.close - 1;
  const result = signal(input);
  assert.ok(result.trendStrength > .5); assert.ok(result.close < result.emaSlow);
  assert.equal(result.side, null); assert.equal(result.reason, "PRICE_TREND_DISAGREEMENT");
});

test("ATR measures gaps from previous close, including current candle", () => {
  const input = bars(S.minimumBars, 0), last = input.at(-1)!;
  last.open = 1020; last.close = 1020; last.low = 1020; last.high = 1022;
  near(signal(input).atr, (31 * 2 + 22) / 32);
});

test("only the fixed causal window affects values or the canonical fingerprint", () => {
  const input = bars(200), asOf = START + 200 * HOUR, before = signal(input, asOf);
  const changed = input.map((bar, i) => i < 8 ? { ...bar, high: 2000, volume: 999 } : { ...bar });
  const future = { ...input.at(-1)!, openMs: asOf, close: NaN, high: Infinity, volume: -1 };
  const reordered = changed.reverse().map(bar => ({ volume: bar.volume, close: bar.close, low: bar.low,
    high: bar.high, open: bar.open, openMs: bar.openMs, symbol: bar.symbol }));
  assert.deepEqual(signal([...reordered, future], asOf), before);
  assert.deepEqual(signal(input.slice(-192), asOf), before);
  assert.deepEqual(signal([...input, ...bars(200, -1, "ETH/USD")], asOf), before);
  const changedUsed = structuredClone(input); changedUsed.at(-1)!.volume += 1;
  assert.notEqual(signal(changedUsed, asOf).inputSha256, before.inputSha256);
  assert.equal(buildSystematicSignal(bars(), "BTC/USD", END - 1), null);
});

test("insufficient and gapped history fails closed, old gaps outside the window do not matter", () => {
  assert.equal(buildSystematicSignal(bars(191), "BTC/USD", END), null);
  const full = bars(200), asOf = START + 200 * HOUR;
  assert.equal(buildSystematicSignal(full.filter((_, i) => i !== 100), "BTC/USD", asOf), null);
  assert.deepEqual(signal(full.filter((_, i) => i !== 0), asOf), signal(full, asOf));
  assert.equal(buildSystematicSignal([], "BTC/USD", END), null);
});

test("malformed admitted data and duplicates throw without mutating caller input", () => {
  const input = bars(), copy = structuredClone(input);
  for (const patch of [{ open: 0 }, { high: NaN }, { low: 10000 }, { volume: -1 }, { openMs: START + 1 }]) {
    assert.throws(() => signal([{ ...input[0]!, ...patch }, ...input.slice(1)]), /SYSTEMATIC_SIGNAL_INVALID_BAR/);
  }
  assert.throws(() => signal([...input, input[0]!]), /DUPLICATE_BAR/);
  assert.throws(() => buildSystematicSignal(input, "SOL/USD", END), /INVALID_ARGUMENT/);
  assert.throws(() => buildSystematicSignal(input, "BTC/USD", END, END + 1), /INVALID_ARGUMENT/);
  assert.throws(() => buildSystematicSignal(input, "BTC/USD", END, END - 1), /UNAVAILABLE_AT_RECEIPT/);
  signal(input).emaFast = 0;
  assert.deepEqual(input, copy);
  const later = buildSystematicSignal(input, "BTC/USD", END + 10_000, END + 8_000)!;
  assert.equal(later.inputSha256, signal(input).inputSha256); assert.equal(later.availableAtMs, END + 8_000);
});

test("HTTP history requests correct fixed-host products and only complete finalized hours", async () => {
  const urls: URL[] = [];
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource)); urls.push(url);
    assert.equal(url.origin, "https://futures.kraken.com"); assert.equal(init?.method, undefined);
    assert.ok(init?.signal); assert.equal(url.searchParams.get("from"), String(START / 1000));
    assert.equal(url.searchParams.get("to"), String(END / 1000));
    return response(bars(194));
  };
  const result = await loadSystematicHistory(products, END + 60_000, { fetcher });
  assert.equal(result.length, 384); assert.equal(urls.length, 2);
  assert.deepEqual(urls.map(url => url.pathname).sort(), [
    "/api/charts/v1/trade/PF_ETHUSD/1h", "/api/charts/v1/trade/PF_XBTUSD/1h"]);
  for (const symbol of Object.keys(products)) {
    const own = result.filter(bar => bar.symbol === symbol);
    assert.equal(own.length, 192); assert.equal(own[0]!.openMs, START);
    assert.equal(own.at(-1)!.openMs + HOUR, END);
    assert.equal(buildSystematicSignal(result, symbol, END + 60_000)?.side, 1);
  }
});

test("hour-finalization grace excludes the just-closed source candle for sixty seconds", async () => {
  let queriedEnd = 0;
  const fetcher: typeof fetch = async resource => {
    const url = new URL(String(resource)); queriedEnd = Number(url.searchParams.get("to")) * 1000;
    return response(bars().map(bar => ({ ...bar, openMs: bar.openMs - HOUR })));
  };
  const result = await loadSystematicHistory({ "BTC/USD": "PF_XBTUSD" }, END + 59_999, { fetcher });
  assert.equal(queriedEnd, END - HOUR); assert.equal(result.at(-1)!.openMs + HOUR, END - HOUR);
});

test("history retries transient transport, rate limit and server errors with bounded backoff", async () => {
  let calls = 0; const delays: number[] = [];
  const fetcher: typeof fetch = async () => {
    calls++;
    if (calls === 1) throw new Error("temporary network failure");
    if (calls === 2) return new Response("busy", { status: 429 });
    return response();
  };
  const result = await loadSystematicHistory({ "BTC/USD": "PF_XBTUSD" }, END + 60_000,
    { fetcher, sleep: async ms => { delays.push(ms); } });
  assert.equal(result.length, 192); assert.equal(calls, 3); assert.deepEqual(delays, [250, 500]);
  calls = 0;
  await assert.rejects(loadSystematicHistory({ "BTC/USD": "PF_XBTUSD" }, END + 60_000,
    { fetcher: async () => { calls++; return new Response("down", { status: 503 }); }, sleep: async () => {} }), /HTTP_503/);
  assert.equal(calls, 3);
});

test("history rejects bad requests without retries or network and rejects incomplete source data", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response("no", { status: 404 }); };
  await assert.rejects(loadSystematicHistory({ "BTC/USD": "PF_XBTUSD" }, END + 60_000, { fetcher }), /HTTP_404/);
  assert.equal(calls, 1);
  await assert.rejects(loadSystematicHistory({ "BTC/USD": "https://wrong.example" }, END, { fetcher }), /UNSUPPORTED_PRODUCT/);
  assert.equal(calls, 1);
  for (const [input, pattern] of [[bars(191), /GAP/], [[...bars().slice(0, 5), bars()[4]!, ...bars().slice(5)], /DUPLICATE/]] as const)
    await assert.rejects(loadSystematicHistory({ "BTC/USD": "PF_XBTUSD" }, END + 60_000,
      { fetcher: async () => response([...input]) }), pattern);
  await assert.rejects(loadSystematicHistory({ "BTC/USD": "PF_XBTUSD" }, END + 60_000,
    { fetcher: async () => response(bars(), { more_candles: true }) }), /TRUNCATED/);
  await assert.rejects(loadSystematicHistory({ "BTC/USD": "PF_XBTUSD" }, END + 60_000,
    { fetcher: async () => response(bars().map((bar, i) => i === 20 ? { ...bar, high: 1 } : bar)) }), /INVALID_HOURLY/);
});
