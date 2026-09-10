import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { WEEK_MS } from "../src/spot-trend/data.js";
import { fetchSpotMarketSnapshot, parseSpotMarketBook, parseSpotMarketRules, SPOT_MARKET_SOURCES } from "../src/spot-trend/market.js";

const T = Date.UTC(2026, 7, 27), NOW = T + WEEK_MS + 60_000;
const candle = (at = T): unknown[] => [at / 1000, "100", "110", "90", "105", "102", "12.5", 20];
const rules = () => ({ altname: "XBTUSD", base: "XXBT", quote: "ZUSD", aclass_base: "currency", aclass_quote: "currency",
  lot: "unit", lot_multiplier: 1, status: "online", lot_decimals: 8, pair_decimals: 1,
  ordermin: "0.00005", costmin: "0.5", tick_size: "0.1" });
const book = () => ({ bids: [["100.0", "1.25", 0], ["99.9", "2", 1]], asks: [["100.1", "1.5", 2], ["100.2", "3", 1]] });
const wrap = (pair: unknown) => ({ error: [], result: { XXBTZUSD: pair } });
const documents = (): Record<string, unknown> => ({
  [SPOT_MARKET_SOURCES.ohlc]: { error: [], result: { XXBTZUSD: [candle(), candle(T + WEEK_MS)], last: NOW / 1000 } },
  [SPOT_MARKET_SOURCES.rules]: wrap(rules()),
  [SPOT_MARKET_SOURCES.book]: wrap(book()),
});
const fetchDocuments = (values = documents()): typeof fetch => async input => new Response(JSON.stringify(values[String(input)]));

test("public snapshot validates concurrent context before requesting fresh depth and preserves exact source hashes", async () => {
  const values = documents(), requested: string[] = [];
  let clock = NOW, releaseOhlc!: () => void;
  const ruleStarted = new Promise<void>(resolve => { releaseOhlc = resolve; });
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input); requested.push(url);
    assert.equal(options?.method, "GET");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.cache, "no-store");
    assert.equal(new Headers(options?.headers).has("authorization"), false);
    assert.ok(options?.signal instanceof AbortSignal);
    if (url === SPOT_MARKET_SOURCES.ohlc) await ruleStarted;
    if (url === SPOT_MARKET_SOURCES.rules) releaseOhlc();
    if (url === SPOT_MARKET_SOURCES.book) assert.equal(requested.length, 3);
    return new Response(JSON.stringify(values[url], null, 2) + "\n", { headers: { date: new Date(NOW).toUTCString() } });
  };
  const snapshot = await fetchSpotMarketSnapshot({ fetcher, now: () => clock++ });
  assert.deepEqual(requested, [SPOT_MARKET_SOURCES.ohlc, SPOT_MARKET_SOURCES.rules, SPOT_MARKET_SOURCES.book]);
  assert.equal(snapshot.historyError, undefined);
  assert.equal(snapshot.bars.length, 1);
  assert.equal(snapshot.bars[0]!.availableAtMs, NOW);
  assert.deepEqual(snapshot.rules, { lotSize: 1e-8, minimumQuantity: .00005, minimumNotionalUsd: .5, tickSize: .1 });
  assert.deepEqual(snapshot.book.bids, [[100, 1.25], [99.9, 2]]);
  assert.ok(snapshot.book.receivedAtMs >= NOW);
  assert.equal(snapshot.book.receivedAtMs, snapshot.sources[2]!.receivedAtMs);
  assert.ok(snapshot.sources[2]!.requestedAtMs >= Math.max(snapshot.sources[0]!.receivedAtMs, snapshot.sources[1]!.receivedAtMs));
  assert.ok(snapshot.retrievedAtMs >= snapshot.book.receivedAtMs);
  for (const source of snapshot.sources) {
    assert.equal(source.sha256, createHash("sha256").update(source.rawBody).digest("hex"));
    assert.equal(source.responseBytes, Buffer.byteLength(source.rawBody));
    assert.deepEqual(source.rawDocument, JSON.parse(source.rawBody));
    assert.equal(source.serverDateHeader, new Date(NOW).toUTCString());
  }
});

test("pair rules require online native spot identity, unit lots and usable increments", () => {
  const fallback = rules() as Record<string, unknown>; delete fallback.tick_size;
  assert.equal(parseSpotMarketRules(wrap(fallback)).tickSize, .1);
  const invalid: Array<Record<string, unknown>> = [
    { status: "cancel_only" }, { status: "post_only" }, { status: "limit_only" }, { status: "offline" },
    { base: "XETH" }, { quote: "USDT" }, { altname: "PF_XBTUSD" }, { aclass_base: "tokenized_asset" },
    { lot_multiplier: 2 }, { lot: "contract" }, { lot_decimals: 13 }, { lot_decimals: -1 }, { pair_decimals: 1.5 },
    { ordermin: "0" }, { ordermin: "NaN" }, { costmin: "" }, { tick_size: "0.01" },
    { tick_size: -1 }, { ordermin: "0.000000005" },
  ];
  for (const mutation of invalid) assert.throws(() => parseSpotMarketRules(wrap({ ...rules(), ...mutation })), /SPOT_MARKET/);
  assert.throws(() => parseSpotMarketRules({ error: [], result: { XETHZUSD: rules() } }), /PAIR_MISMATCH/);
});

test("book parsing rejects crossed, unsorted, duplicate, empty, oversized and invalid levels", () => {
  const valid = book();
  for (const bids of [[], Array.from({ length: 101 }, () => ["100", "1", 0]),
    [["99", "1", 0], ["100", "1", 0]], [["100", "1", 0], ["100", "2", 1]],
    [["100.1", "1", 0]], [["100.2", "1", 0]], [["100", "0", 0]], [["NaN", "1", 0]],
    [["100", "1", "0"]], [["100", "1", -1]], [["100", "1", Infinity]], [["100", "1"]]])
    assert.throws(() => parseSpotMarketBook(wrap({ ...valid, bids }), NOW), /SPOT_MARKET/);
  assert.throws(() => parseSpotMarketBook(wrap({ ...valid, asks: [["101", "1", 0], ["100", "1", 0]] }), NOW), /SPOT_MARKET/);
  assert.throws(() => parseSpotMarketBook({ error: ["EGeneral:Invalid arguments"], result: {} }, NOW), /API_ERROR/);
  assert.throws(() => parseSpotMarketBook(wrap(valid), NaN), /CLOCK/);
});

test("level change timestamps never replace receipt clocks or reject quiet levels as stale", () => {
  const parsed = parseSpotMarketBook(wrap(book()), NOW);
  assert.equal(parsed.receivedAtMs, NOW);
  assert.deepEqual(parsed.asks[0], [100.1, 1.5]);
});

test("failed rules prevent any depth request", async () => {
  const values: Record<string, unknown> = documents(), requested: string[] = [];
  values[SPOT_MARKET_SOURCES.rules] = wrap({ ...rules(), status: "cancel_only" });
  await assert.rejects(fetchSpotMarketSnapshot({ fetcher: async input => {
    requested.push(String(input)); return new Response(JSON.stringify(values[String(input)]));
  }, now: () => NOW }), /SPOT_MARKET_NOT_ONLINE/);
  assert.equal(requested.includes(SPOT_MARKET_SOURCES.book), false);
});

test("HTTP errors and both declared and streamed response-size excesses fail closed", async () => {
  for (const response of [new Response("limited", { status: 429 }),
    new Response("{}", { headers: { "content-length": "1048577" } }), new Response("x".repeat(1048577))]) {
    let depthRequests = 0;
    const fetcher: typeof fetch = async input => {
      if (String(input) === SPOT_MARKET_SOURCES.book) depthRequests++;
      return String(input) === SPOT_MARKET_SOURCES.rules ? response : fetchDocuments()(input);
    };
    await assert.rejects(fetchSpotMarketSnapshot({ fetcher, now: () => NOW }), /SPOT_MARKET_(HTTP_429|RESPONSE_LIMIT)/);
    assert.equal(depthRequests, 0);
  }
});

test("invalid JSON, lossy UTF-8 and reversed or invalid local clocks are rejected", async () => {
  for (const body of ["{invalid", new Uint8Array([0xff, 0xfe])]) {
    await assert.rejects(fetchSpotMarketSnapshot({ fetcher: async input => String(input) === SPOT_MARKET_SOURCES.rules
      ? new Response(body) : fetchDocuments()(input), now: () => NOW }));
  }
  let clock = NOW;
  await assert.rejects(fetchSpotMarketSnapshot({ fetcher: fetchDocuments(), now: () => clock-- }), /REVERSED_SPOT_MARKET_CLOCK/);
  await assert.rejects(fetchSpotMarketSnapshot({ fetcher: fetchDocuments(), now: () => Infinity }), /SPOT_MARKET_CLOCK/);
});

test("valid context cannot make an invalid final depth snapshot executable", async () => {
  const values: Record<string, unknown> = documents();
  values[SPOT_MARKET_SOURCES.book] = { error: [], result: { XETHZUSD: book() } };
  await assert.rejects(fetchSpotMarketSnapshot({ fetcher: async input => new Response(JSON.stringify(values[String(input)])),
    now: () => NOW }), /PAIR_MISMATCH/);
});

test("fresh HTTP receipt cannot disguise a source missing the most recent completed week", async () => {
  let depthRequests = 0;
  const snapshot = await fetchSpotMarketSnapshot({ fetcher: async input => {
    if (String(input) === SPOT_MARKET_SOURCES.book) depthRequests++;
    return fetchDocuments()(input);
  }, now: () => NOW + 2 * WEEK_MS });
  assert.equal(snapshot.historyError, "STALE_COMPLETED_SPOT_MARKET_WEEKS");
  assert.deepEqual(snapshot.bars, []);
  assert.equal(depthRequests, 1);
  assert.equal(snapshot.sources.length, 3);
  assert.equal(snapshot.book.receivedAtMs, NOW + 2 * WEEK_MS);
});

test("received malformed OHLC remains auditable while valid depth remains available for exits", async () => {
  const failures: Array<[BodyInit, number, RegExp]> = [
    [JSON.stringify({ error: [], result: { XXBTZUSD: [candle(), candle()], last: NOW / 1000 } }), 200, /SPOT_WEEK/],
    [JSON.stringify({ error: ["EAPI:Rate limit exceeded"], result: {} }), 200, /SPOT_WEEK_API_ERROR/],
    ["rate limited", 429, /SPOT_MARKET_HTTP_429/],
    ["invalid JSON", 200, /SPOT_MARKET_INVALID_JSON/],
    [new Uint8Array([0xff, 0xfe]), 200, /INVALID_SPOT_MARKET_UTF8/],
  ];
  for (const [body, status, failure] of failures) {
    const snapshot = await fetchSpotMarketSnapshot({ now: () => NOW, fetcher: async input =>
      String(input) === SPOT_MARKET_SOURCES.ohlc ? new Response(body, { status }) : fetchDocuments()(input) });
    assert.match(snapshot.historyError!, failure);
    assert.deepEqual(snapshot.bars, []);
    assert.deepEqual(snapshot.book.bids[0], [100, 1.25]);
    assert.equal(snapshot.sources.length, 3);
    const source = snapshot.sources[0]!;
    const exactBytes = source.rawBodyBase64 ? Buffer.from(source.rawBodyBase64, "base64") : Buffer.from(source.rawBody);
    assert.equal(source.sha256, createHash("sha256").update(exactBytes).digest("hex"));
    assert.equal(source.httpStatus, status);
  }
});

test("failed OHLC network requests do not invent a source or discard fresh exit quotes", async () => {
  const snapshot = await fetchSpotMarketSnapshot({ now: () => NOW, fetcher: async input => {
    if (String(input) === SPOT_MARKET_SOURCES.ohlc) throw new Error("SPOT_HISTORY_NETWORK_UNAVAILABLE");
    return fetchDocuments()(input);
  } });
  assert.equal(snapshot.historyError, "SPOT_HISTORY_NETWORK_UNAVAILABLE");
  assert.deepEqual(snapshot.bars, []);
  assert.deepEqual(snapshot.sources.map(source => source.url), [SPOT_MARKET_SOURCES.rules, SPOT_MARKET_SOURCES.book]);
  assert.equal(snapshot.book.receivedAtMs, NOW);
});
