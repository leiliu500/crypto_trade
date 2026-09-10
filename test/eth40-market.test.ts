import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import test from "node:test";
import WebSocket from "ws";
import { Eth40Market, applyKrakenBookFrame, krakenBookChecksum, mergeEth40Histories, parseEth40DailyHistory, parseEth40Rules,
  type ChecksumLevel } from "../src/eth40/market.js";
import { DAY_MS } from "../src/eth40/spec.js";
import type { Asset, DailyBar } from "../src/eth40/types.js";

const TODAY = Date.UTC(2026, 8, 10), NOW = TODAY + 12 * 3_600_000;
const key = (symbol: Asset) => symbol === "ETH/USD" ? "XETHZUSD" : "XXBTZUSD";
const bar = (openTimeMs: number): DailyBar => ({ openTimeMs, open: 100, high: 110, low: 90, close: 105, volume: 12.5 });
const candle = (atMs: number): unknown[] => [atMs / 1000, "100", "110", "90", "105", "102", "12.5", 20];
const history = (symbol: Asset, rows = [3, 2, 1, 0].map(days => candle(TODAY - days * DAY_MS))) => ({ error: [], result: { [key(symbol)]: rows, last: NOW / 1000 } });
const rule = (symbol: Asset, status = "online") => ({ error: [], result: { [key(symbol)]: {
  altname: symbol === "ETH/USD" ? "ETHUSD" : "XBTUSD", wsname: symbol === "ETH/USD" ? symbol : "XBT/USD",
  base: symbol === "ETH/USD" ? "XETH" : "XXBT", quote: "ZUSD", aclass_base: "currency", aclass_quote: "currency",
  lot: "unit", lot_multiplier: 1, status, lot_decimals: 8, pair_decimals: 1, tick_size: "0.1", ordermin: "0.00005", costmin: "0.5" } } });
const seed = (): Record<Asset, DailyBar[]> => ({ "ETH/USD": [bar(TODAY - 3 * DAY_MS), bar(TODAY - 2 * DAY_MS)],
  "BTC/USD": [bar(TODAY - 3 * DAY_MS), bar(TODAY - 2 * DAY_MS)] });
const levels = { asks: [["101.000", "1.0000"], ["102.000", "2.0000"]] as ChecksumLevel[],
  bids: [["100.000", "3.0000"], ["99.000", "4.0000"]] as ChecksumLevel[] };
const snapshotBlocks = (now = NOW) => [{ as: levels.asks.map(row => [...row, String(now / 1000)]), bs: levels.bids.map(row => [...row, String(now / 1000)]) }];
const updateBlocks = (now = NOW) => [{ a: [[...levels.asks[0]!, String(now / 1000)]], c: krakenBookChecksum(levels.asks, levels.bids) }];

class FakeSocket extends EventEmitter {
  public readyState: number = WebSocket.OPEN;
  public sent: string[] = [];
  public send(value: string): void { this.sent.push(value); }
  public terminate(): void { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  public frame(value: unknown): void { this.emit("message", Buffer.from(JSON.stringify(value))); }
}
function subscribe(socket: FakeSocket): void {
  socket.emit("open");
  for (const [channelID, pair] of [[1, "ETH/USD"], [2, "XBT/USD"]] as const)
    socket.frame({ event: "subscriptionStatus", status: "subscribed", channelID, channelName: "book-10", pair, subscription: { name: "book", depth: 10 } });
}
function prime(socket: FakeSocket, now = NOW): void {
  subscribe(socket);
  for (const [channel, pair] of [[1, "ETH/USD"], [2, "XBT/USD"]] as const) {
    socket.frame([channel, ...snapshotBlocks(now), "book-10", pair]);
    socket.frame([channel, ...updateBlocks(now), "book-10", pair]);
  }
}
function fixture(options: { failEvidence?: boolean } = {}) {
  let now = NOW, offline = false, revised = false;
  const calls: string[] = [], receipts: Array<{ kind: string; payload: unknown }> = [], socket = new FakeSocket();
  const failure = new Error("TEST_DURABLE_WRITE_FAILED");
  const market = new Eth40Market(seed(), async (kind, payload) => {
    if (options.failEvidence) throw failure;
    receipts.push({ kind, payload }); return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }, { now: () => now, socketFactory: () => socket as unknown as WebSocket,
    fetcher: async (input, options) => {
      const url = String(input); calls.push(url);
      assert.equal(options?.method, "GET"); assert.equal(options?.redirect, "error");
      assert.equal(new Headers(options?.headers).has("authorization"), false);
      const symbol: Asset = url.includes("ETHUSD") ? "ETH/USD" : "BTC/USD";
      const payload = url.includes("AssetPairs") ? rule(symbol, offline && symbol === "ETH/USD" ? "offline" : "online") : history(symbol);
      if (revised && symbol === "ETH/USD" && url.includes("OHLC")) (payload.result[key(symbol)] as unknown[][])[0]![4] = "106";
      return new Response(JSON.stringify(payload));
    } });
  return { market, socket, calls, receipts, failure, advance: (ms: number) => { now += ms; },
    setOffline: (value: boolean) => { offline = value; }, setRevised: (value: boolean) => { revised = value; } };
}

test("Kraken's published top-ten raw decimal checksum vector is reproduced", () => {
  const asks = ["0.05005", "0.05010", "0.05015", "0.05020", "0.05025", "0.05030", "0.05035", "0.05040", "0.05045", "0.05050"].map(price => [price, "0.00000500"] as ChecksumLevel);
  const bids = ["0.05000", "0.04995", "0.04990", "0.04980", "0.04975", "0.04970", "0.04965", "0.04960", "0.04955", "0.04950"].map(price => [price, "0.00000500"] as ChecksumLevel);
  assert.equal(krakenBookChecksum(asks, bids), "974947235");
  assert.equal(krakenBookChecksum([...asks].reverse(), [...bids].reverse()), "974947235");
  assert.notEqual(krakenBookChecksum(asks.map(([p, q]) => [String(Number(p)), q]), bids), "974947235");
});

test("snapshot is unverified; all maps and repeated same-price updates apply before checksum", () => {
  const initial = applyKrakenBookFrame(undefined, snapshotBlocks(), NOW);
  assert.equal(initial.checksumValid, false);
  const asks: ChecksumLevel[] = [["101.000", "7.0000"], ["102.000", "2.0000"]];
  const bids: ChecksumLevel[] = [["100.000", "8.0000"], ["99.000", "4.0000"]];
  const blocks = [{ a: [["101.000", "5.0000", `${NOW/1000}.123456789`], ["101.000", "7.0000", `${NOW/1000}.123456788`]] },
    { b: [["100.000", "8.0000", `${NOW/1000}.123456789`]], c: krakenBookChecksum(asks, bids) }];
  const updated = applyKrakenBookFrame(initial, blocks, NOW + 500);
  assert.deepEqual(updated.asks, asks); assert.deepEqual(updated.bids, bids);
  assert.equal(updated.exchangeUpdateAtMs, NOW + 123); assert.ok(Number.isSafeInteger(updated.exchangeUpdateAtMs));
  assert.equal(updated.checksumValid, true); assert.deepEqual(initial.asks, levels.asks);
  assert.throws(() => applyKrakenBookFrame(initial, [{ ...blocks[0], c: "0" }, blocks[1]], NOW+500), /CHECKSUM_FIELD/);
});

test("zero deletions, insertion and depth truncation precede final checksum", () => {
  const as: ChecksumLevel[] = Array.from({ length: 10 }, (_, i) => [String(101+i), "1"]);
  const bs: ChecksumLevel[] = Array.from({ length: 10 }, (_, i) => [String(100-i), "1"]);
  const initial = applyKrakenBookFrame(undefined, [{ as: as.map(r => [...r, String(NOW/1000)]), bs: bs.map(r => [...r, String(NOW/1000)]) }], NOW);
  const expected = ([["100.5", "2"], ...as.filter(r => r[0] !== "103"), ["111", "1"]] satisfies ChecksumLevel[]).slice(0, 10);
  const result = applyKrakenBookFrame(initial, [{ a: [["103", "0.0000", String(NOW/1000)], ["100.5", "2", String(NOW/1000)], ["111", "1", String(NOW/1000)]],
    c: krakenBookChecksum(expected, bs) }], NOW);
  assert.deepEqual(result.asks, expected); assert.equal(result.asks.length, 10);
  assert.throws(() => applyKrakenBookFrame(initial, [{ a: [["101", "2", String(NOW/1000)]], c: "0" }], NOW), /CHECKSUM/);
  assert.throws(() => applyKrakenBookFrame(undefined, updateBlocks(), NOW), /BEFORE_SNAPSHOT/);
  assert.throws(() => applyKrakenBookFrame(initial, updateBlocks(NOW+2000), NOW), /FUTURE/);
});

test("daily data accepts 720 completed plus current row, excludes unfinished/finalization boundary", () => {
  const rows = Array.from({ length: 721 }, (_, i) => candle(TODAY - (720-i)*DAY_MS));
  const parsed = parseEth40DailyHistory(history("ETH/USD", rows), "ETH/USD", NOW);
  assert.equal(parsed.length, 720); assert.equal(parsed.at(-1)!.openTimeMs, TODAY-DAY_MS);
  assert.equal(parseEth40DailyHistory(history("ETH/USD"), "ETH/USD", TODAY+59_999).at(-1)!.openTimeMs, TODAY-2*DAY_MS);
  assert.equal(parseEth40DailyHistory(history("ETH/USD"), "ETH/USD", TODAY+60_000).at(-1)!.openTimeMs, TODAY-DAY_MS);
  assert.throws(() => parseEth40DailyHistory(history("ETH/USD", [candle(TODAY-3*DAY_MS), candle(TODAY-DAY_MS), candle(TODAY)]), "ETH/USD", NOW), /GAP/);
  assert.throws(() => parseEth40DailyHistory(history("BTC/USD"), "ETH/USD", NOW), /PAIR/);
});

test("anchored histories reject revisions and gaps; returned bars never mutate seeds", () => {
  const old = seed()["ETH/USD"], next = parseEth40DailyHistory(history("ETH/USD"), "ETH/USD", NOW);
  const merged = mergeEth40Histories(old, next); merged[0]!.close = 106;
  assert.equal(old[0]!.close, 105);
  assert.throws(() => mergeEth40Histories(old, [{ ...old[0]!, volume: 12.5000000001 }]), /REVISION/);
  assert.throws(() => mergeEth40Histories(old, [bar(TODAY)]), /ANCHOR_GAP/);
});

test("pair metadata requires online exact native identity and meaningful increments", () => {
  assert.deepEqual(parseEth40Rules(rule("ETH/USD"), "ETH/USD"), { lotSize: 1e-8, minimumQuantity: .00005, minimumNotionalUsd: .5, tickSize: .1 });
  for (const status of ["offline", "post_only", "cancel_only", "limit_only"]) assert.throws(() => parseEth40Rules(rule("ETH/USD", status), "ETH/USD"), /NOT_ONLINE/);
  for (const patch of [{ base: "XXBT" }, { wsname: "ETH/EUR" }, { ordermin: "0.000000001" }, { tick_size: ".1" }, { lot_decimals: 20 }]) {
    const r = rule("ETH/USD"); Object.assign(r.result.XETHZUSD!, patch); assert.throws(() => parseEth40Rules(r, "ETH/USD"));
  }
});

test("memory-only WS state exposes fresh CRC proofs and stops trusting stale/exited epochs", async () => {
  const f = fixture(); f.market.start();
  try {
    subscribe(f.socket);
    f.socket.frame([1, ...snapshotBlocks(), "book-10", "ETH/USD"]);
    assert.equal((await f.market.snapshot()).books["ETH/USD"], undefined);
    f.socket.frame([1, ...updateBlocks(), "book-10", "ETH/USD"]);
    const snap = await f.market.snapshot(), verified = snap.books["ETH/USD"]!;
    assert.equal(verified.checksumValid, true); assert.equal(verified.checksumVerification, "LOCAL_TOP10_CRC32");
    assert.equal(krakenBookChecksum(verified.checksumAsks!, verified.checksumBids!), verified.checksum);
    assert.equal(f.receipts.length, 4); assert.equal(f.calls.length, 4);
    f.advance(5001); assert.equal((await f.market.snapshot()).books["ETH/USD"], undefined);
    f.socket.frame([1, ...updateBlocks(), "book-10", "ETH/USD"]); // New receipt cannot rejuvenate old exchange time.
    assert.equal((await f.market.snapshot()).books["ETH/USD"], undefined);
    f.market.stop(); f.socket.frame([1, ...updateBlocks(NOW+5001), "book-10", "ETH/USD"]);
    assert.equal((await f.market.snapshot()).books["ETH/USD"], undefined);
  } finally { f.market.stop(); }
});

test("wrong pair/checksum tears down and clears both books immediately", async () => {
  for (const bad of [[1, ...updateBlocks(), "book-10", "XBT/USD"], [1, { a: [["101.000", "2", String(NOW/1000)]], c: "0" }, "book-10", "ETH/USD"]]) {
    const f = fixture(); f.market.start();
    try { prime(f.socket); assert.ok((await f.market.snapshot()).books["ETH/USD"]);
      f.socket.frame(bad); const snapshot = await f.market.snapshot();
      assert.equal(Object.keys(snapshot.books).length, 0); assert.equal(f.socket.readyState, WebSocket.CLOSED);
      assert.ok(snapshot.errors.some(error => error.includes("WS_INVALID")));
    } finally { f.market.stop(); }
  }
});

test("REST cache cadence, failed-rule invalidation/recovery, retained anchors and copied outputs", async () => {
  const f = fixture();
  try {
    const first = await f.market.snapshot(); assert.equal(f.calls.length, 4);
    first.histories["ETH/USD"][0]!.close = 1; assert.equal(f.market.acceptedHistories["ETH/USD"][0]!.close, 105);
    await f.market.snapshot(); assert.equal(f.calls.length, 4);
    f.advance(300_000); await f.market.snapshot(); assert.equal(f.calls.length, 6);
    f.advance(3_600_000); f.setOffline(true); f.setRevised(true);
    const bad = await f.market.snapshot(); assert.equal(bad.rules["ETH/USD"], undefined); assert.ok(bad.rules["BTC/USD"]);
    assert.equal(bad.rulesFetchedAtMs, 0); assert.ok(bad.rulesFetchedAtMsByAsset?.["BTC/USD"]);
    assert.equal(bad.histories["ETH/USD"].length, 0); assert.equal(f.market.acceptedHistories["ETH/USD"].length, 3);
    const calls = f.calls.length; f.advance(300_000); f.setOffline(false); f.setRevised(false);
    const recovered = await f.market.snapshot(); assert.ok(recovered.rules["ETH/USD"]); assert.equal(recovered.histories["ETH/USD"].length, 3);
    assert.equal(f.calls.length-calls, 3); // Failed ETH metadata retries; valid BTC metadata stays cached.
    assert.ok(recovered.rulesFetchedAtMs < recovered.rulesFetchedAtMsByAsset!["ETH/USD"]!);
    for (const receipt of f.receipts) {
      const value = receipt.payload as { rawBody: string; sha256: string };
      assert.equal(createHash("sha256").update(value.rawBody).digest("hex"), value.sha256);
    }
  } finally { f.market.stop(); }
});

test("evidence callback write failures propagate identically and latch fatal", async () => {
  const f = fixture({ failEvidence: true }); f.market.start();
  await assert.rejects(f.market.snapshot(), error => error === f.failure);
  await assert.rejects(f.market.snapshot(), error => error === f.failure);
  assert.equal(f.socket.readyState, WebSocket.CLOSED); assert.equal(f.calls.length, 1);
  assert.throws(() => f.market.start(), error => error === f.failure);
});

test("snapshot samples its observation clock after REST/evidence work", async () => {
  let now = NOW;
  const m = new Eth40Market(seed(), async () => { now += 11; return "evidence"; }, { now: () => now,
    fetcher: async input => { now += 7; const url = String(input), symbol = url.includes("ETHUSD") ? "ETH/USD" : "BTC/USD";
      return new Response(JSON.stringify(url.includes("OHLC") ? history(symbol) : rule(symbol))); } });
  const s = await m.snapshot(NOW); assert.equal(s.observedAtMs, NOW+4*18);
  assert.ok(s.rulesFetchedAtMs < s.observedAtMs);
});
