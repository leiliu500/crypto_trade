import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { crc32, decodeFundingZipMember, downloadHourlyDataset, fundingCoverage, fundingZipDirectory,
  fundingZipMembers, HOUR_MS as H, loadHourlyDataset, mergeHourlyBars, missingHourlyTimes, parseFundingCsv,
  parseHourlyCandles, type HourlyBar } from "../src/research/hourly-data.js";
import { parseHourlyDataArgs } from "../src/research/hourly-data-main.js";

const START = Date.UTC(2024, 0, 1), END = START + 3 * H;
const candle = (time = START) => ({ time, open: "100", high: "102", low: "99", close: "101", volume: "0.25" });
const csv = (product: string) => `timestamp,tradeable,absolute_rate,relative_rate\n2024-01-01 00:00:00,${product},0.01,0.0001\n2024-01-01 02:00:00,${product},-0.02,-0.0002\n`;
function zip() {
  const local: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const product of ["PF_XBTUSD", "PF_ETHUSD"]) {
    const name = Buffer.from(`exports/${product}.csv`), body = Buffer.from(csv(product)), compressed = deflateRawSync(body);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(body), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(body), 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); directory.push(central, name);
    offset += header.length + name.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}

test("hourly candle parsing validates aligned opening times, OHLC bounds and actual string volume", () => {
  const result = parseHourlyCandles({ candles: [candle()], more_candles: true }, "BTC/USD");
  assert.equal(result.more, true); assert.deepEqual(result.bars[0], { symbol: "BTC/USD", openMs: START, open: 100, high: 102, low: 99, close: 101, volume: .25 });
  for (const change of [{ time: START + 1 }, { low: "100.5" }, { high: "100.5" }, { volume: "-1" }, { close: "NaN" }, { volume: null }]) {
    assert.throws(() => parseHourlyCandles({ candles: [{ ...candle(), ...change }], more_candles: false }, "BTC/USD"), /HOURLY/);
  }
  assert.throws(() => parseHourlyCandles({ candles: [candle(START + H), candle()], more_candles: false }, "BTC/USD"), /REVERSED/);
});

test("completed hourly bars deduplicate identical page boundaries and reject conflicting history", () => {
  const rows = parseHourlyCandles({ candles: [candle(), candle(START + H), candle(START + 2 * H), candle(END)], more_candles: false }, "BTC/USD").bars;
  rows[1]!.volume = 0;
  assert.deepEqual(mergeHourlyBars([...rows, rows[0]!], START, END, END), rows.slice(0, 3));
  assert.throws(() => mergeHourlyBars([...rows, { ...rows[0]!, close: 100.5 }], START, END, END), /CONFLICTING/);
  assert.throws(() => mergeHourlyBars(rows, START, END, END - 1), /WINDOW/);
  assert.equal(mergeHourlyBars(rows, START, END, END)[1]!.volume, 0, "zero volume is not converted into a fillable hour");
});

test("coverage counts omitted hours without inventing candles or funding", () => {
  assert.deepEqual(missingHourlyTimes([START, START + 3 * H], START, START + 5 * H), [
    { fromMs: START + H, toMsExclusive: START + 3 * H, hours: 2 }, { fromMs: START + 4 * H, toMsExclusive: START + 5 * H, hours: 1 },
  ]);
  const parsed = parseFundingCsv(csv("PF_XBTUSD"), "BTC/USD", START, END);
  assert.deepEqual(parsed.rows, [{ symbol: "BTC/USD", timestampMs: START + H, rate: .0001, absoluteRate: .01 },
    { symbol: "BTC/USD", timestampMs: END, rate: -.0002, absoluteRate: -.02 }]);
  assert.deepEqual(fundingCoverage(parsed.rows, "BTC/USD", START, END), [{ fromMs: START + 2 * H, toMsExclusive: END, hours: 1 }]);
});

test("funding CSV rejects wrong products, invalid dates and conflicting values and preserves fractional units", () => {
  const text = csv("PF_XBTUSD");
  assert.throws(() => parseFundingCsv(text, "ETH/USD", START, END), /ROW/);
  assert.throws(() => parseFundingCsv(text.replace("2024-01-01 00:00:00", "2024-02-30 00:00:00"), "BTC/USD", START, END), /TIMESTAMP/);
  assert.throws(() => parseFundingCsv(`${text}2024-01-01 00:00:00,PF_XBTUSD,0.02,0.0002\n`, "BTC/USD", START, END), /CONFLICTING/);
  assert.throws(() => parseFundingCsv(text.replace("0.0001", "NaN"), "BTC/USD", START, END), /NUMBER/);
  assert.equal(parseFundingCsv(`${text}2024-01-01 00:00:00,PF_XBTUSD,0.01,0.0001\n`, "BTC/USD", START, END).rows.length, 2);
});

test("targeted ZIP members validate names, decompressed size and CRC independently of an entire archive download", () => {
  const bytes = zip(), info = fundingZipDirectory(bytes, bytes.length);
  const members = fundingZipMembers(bytes.subarray(info.offset, info.offset + info.bytes), info.entries);
  const first = members[0]!, size = 30 + Buffer.byteLength(first.name) + first.compressedBytes;
  assert.equal(decodeFundingZipMember(bytes.subarray(first.offset, first.offset + size), first).toString(), csv("PF_XBTUSD"));
  assert.throws(() => decodeFundingZipMember(bytes.subarray(first.offset, first.offset + size), { ...first, crc32: 1 }), /CRC/);
  assert.throws(() => decodeFundingZipMember(bytes.subarray(first.offset, first.offset + size - 1), first), /SIZE/);
  assert.throws(() => fundingZipDirectory(bytes.subarray(0, -1), bytes.length), /DIRECTORY/);
  assert.throws(() => fundingZipMembers(bytes.subarray(info.offset, info.offset + info.bytes), 3), /MEMBERS/);
});

function mockFetcher(archive: Buffer, requests: string[], corruptRange = false): typeof fetch {
  return async (input, init) => {
    const url = String(input); requests.push(url);
    if (url.includes("/trade/")) {
      const from = Number(new URL(url).searchParams.get("from")) * 1000;
      const payload = { candles: from === START ? [candle()] : [candle(START + H), candle(START + 2 * H)], more_candles: from === START };
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    if (url.includes("/analytics/")) return new Response(JSON.stringify({ result: { timestamp: [], data: { rate: [], relativeRate: [] }, more: false }, errors: [] }));
    if (init?.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(archive.length), "accept-ranges": "bytes" } });
    const range = new Headers(init?.headers).get("range")!, match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start = Number(match[1]), end = Number(match[2]);
    return new Response(new Uint8Array(archive.subarray(start, end + 1)), { status: corruptRange ? 200 : 206,
      headers: { "content-range": `bytes ${start}-${end}/${archive.length}` } });
  };
}

test("dataset loader paginates in seconds, saves hashed raw evidence and reports missing funding without zero filling", async () => {
  const root = await mkdtemp(join(tmpdir(), "hourly-data-test-"));
  try {
    const requests: string[] = [], out = join(root, "data"), result = await downloadHourlyDataset({ out, startMs: START, endMs: END },
      { fetcher: mockFetcher(zip(), requests), nowMs: END });
    assert.equal(result.dataset.bars.length, 6); assert.equal(result.dataset.funding.length, 4);
    assert.ok(requests.some(url => url.includes(`/1h?from=${(START + H) / 1000}&to=${(END - H) / 1000}`)));
    assert.ok(result.dataset.metadata.coverage.every(row => row.missingBars.length === 0 && row.missingFunding[0]!.hours === 1));
    assert.equal(result.dataset.metadata.funding.timestampConventionVerified, false);
    assert.ok(result.dataset.metadata.sourceFiles.every(row => /^[a-f0-9]{64}$/.test(row.sha256)));
    assert.deepEqual(await loadHourlyDataset(out), result.dataset);
    const bytes = await readFile(join(out, "dataset.json")); await writeFile(join(out, "dataset.json"), `${bytes.toString()} `);
    await assert.rejects(loadHourlyDataset(out), /HASH/);
    await assert.rejects(downloadHourlyDataset({ out, startMs: START, endMs: END }, { fetcher: mockFetcher(zip(), []), nowMs: END }), /EEXIST/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("funding range rejection fails before publishing any dataset", async () => {
  const root = await mkdtemp(join(tmpdir(), "hourly-data-range-"));
  try {
    const out = join(root, "data");
    await assert.rejects(downloadHourlyDataset({ out, startMs: START, endMs: END },
      { fetcher: mockFetcher(zip(), [], true), nowMs: END }), /HTTP/);
    await assert.rejects(readFile(join(out, "dataset.json")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing hourly candle rejects the dataset before funding can hide the gap", async () => {
  const root = await mkdtemp(join(tmpdir(), "hourly-data-gap-"));
  try {
    const out = join(root, "data"), fetcher: typeof fetch = async () => new Response(JSON.stringify({
      candles: [candle(), candle(START + 2 * H)], more_candles: false,
    }));
    await assert.rejects(downloadHourlyDataset({ out, startMs: START, endMs: END }, { fetcher, nowMs: END }), /CANDLE_GAPS/);
    const diagnostic = JSON.parse(await readFile(join(out, "incomplete.json"), "utf8"));
    assert.equal(diagnostic.barGaps[0].gaps[0].hours, 1);
    await assert.rejects(readFile(join(out, "dataset.json")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("hourly data CLI accepts explicit boundaries and rejects duplicate or unknown options", () => {
  assert.deepEqual(parseHourlyDataArgs(["--out", "/tmp/data", "--start", "2024-01-01T00:00:00Z", "--end", "2024-01-01T03:00:00Z"]),
    { out: "/tmp/data", startMs: START, endMs: END });
  assert.throws(() => parseHourlyDataArgs(["--out", "a", "--out", "b"]), /OPTION/);
  assert.throws(() => parseHourlyDataArgs(["--timeframe", "1m"]), /OPTION/);
});
