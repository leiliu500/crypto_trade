import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downloadSpotWeeks, loadSpotWeeks, parseSpotWeeks, SPOT_WEEK_DATA_SPEC, WEEK_MS } from "../src/spot-trend/data.js";

const T = Date.UTC(2016, 11, 29), NOW = T + 3 * WEEK_MS + 60_000;
const row = (at = T): unknown[] => [at / 1000, "100", "110", "90", "105", "102", "12.5", 20];
const doc = (rows: unknown[][]) => ({ error: [], result: { XXBTZUSD: rows, last: NOW / 1000 } });
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

test("native spot weekly bars preserve pre-2017 warmup and causal availability", () => {
  const bars = parseSpotWeeks(doc([row(), row(T + WEEK_MS)]), NOW);
  assert.equal(bars.length, 2);
  assert.deepEqual(bars[0], { openMs: T, endMs: T + WEEK_MS, availableAtMs: T + WEEK_MS + 60_000,
    open: 100, high: 110, low: 90, close: 105, volume: 12.5, trades: 20 });
  assert.equal(bars[0]!.openMs % WEEK_MS, 0);
  assert.equal(new Date(bars[0]!.openMs).getUTCDay(), 4);
  assert.equal(parseSpotWeeks(doc([row()]), T + WEEK_MS + 59_999).length, 0);
  assert.equal(parseSpotWeeks(doc([row()]), T + WEEK_MS + 60_000).length, 1);
});

test("incomplete and future prices are excluded before their fields are read", () => {
  const future = row(T + WEEK_MS);
  Object.defineProperty(future, 1, { get() { throw new Error("FUTURE_PRICE_ACCESSED"); } });
  assert.equal(parseSpotWeeks(doc([row(), future]), T + WEEK_MS + 60_000).length, 1);
});

test("missing weeks, reversed or duplicate times, and nonnative boundaries fail closed", () => {
  for (const rows of [[row(), row()], [row(T + WEEK_MS), row()], [row(T + 86400_000)], [row(0.5)]])
    assert.throws(() => parseSpotWeeks(doc(rows), NOW), /SPOT_WEEK/);
  assert.throws(() => parseSpotWeeks(doc([row(), row(T + 2 * WEEK_MS)]), NOW), /MISSING_COMPLETED_SPOT_WEEK/);
  assert.throws(() => parseSpotWeeks(doc([row(Number.MAX_SAFE_INTEGER)]), NOW), /SPOT_WEEK/);
  assert.throws(() => parseSpotWeeks(doc([row()]), NaN), /AS_OF/);
});

test("malformed OHLCVT, wrong pairs, oversized row counts and API errors are rejected", () => {
  for (const [index, value] of [[1, ""], [1, 100], [1, "NaN"], [1, "Infinity"], [1, "0"],
    [2, "99"], [3, "106"], [5, "120"], [6, "-1"], [7, -1], [7, 1.5], [7, 0]] as const) {
    const bad = row(); bad[index] = value;
    assert.throws(() => parseSpotWeeks(doc([bad]), NOW), /OHLCVT/);
  }
  const zero = row(); zero[6] = "0"; zero[7] = 0;
  assert.equal(parseSpotWeeks(doc([zero]), NOW)[0]!.volume, 0);
  assert.throws(() => parseSpotWeeks({ error: [], result: { XETHZUSD: [row()], last: 0 } }, NOW), /SOURCE/);
  assert.throws(() => parseSpotWeeks({ error: ["EAPI:Rate limit exceeded"], result: {} }, NOW), /API_ERROR/);
  assert.throws(() => parseSpotWeeks(doc(Array.from({ length: 722 }, () => row())), NOW), /SOURCE/);
});

test("acquisition preserves full raw bytes, seals complete bars, and reconstructs from source", async () => {
  const base = await mkdtemp(join(tmpdir(), "spot-week-data-")), out = join(base, "data");
  const original = JSON.stringify(doc([row(), row(T + WEEK_MS), row(T + 2 * WEEK_MS), row(T + 3 * WEEK_MS)])) + "\n";
  let calls = 0;
  try {
    const fetcher: typeof fetch = async (input, options) => {
      calls++;
      assert.equal(String(input), SPOT_WEEK_DATA_SPEC.sourceUrl);
      assert.equal(options?.redirect, "error");
      const registration = JSON.parse(await readFile(join(out, "registration.json"), "utf8"));
      assert.equal(registration.strategyPerformanceComputed, false);
      return new Response(original);
    };
    const dataset = await downloadSpotWeeks(out, { fetcher, nowMs: NOW });
    assert.equal(dataset.bars.length, 3);
    assert.equal(dataset.coverage.originalRows, 4);
    assert.equal(dataset.coverage.excludedIncomplete, 1);
    assert.deepEqual(dataset.coverage.gaps, []);
    assert.equal(await readFile(join(out, "source.json"), "utf8"), original);
    assert.equal(dataset.sourceSha256, hash(original));
    assert.deepEqual(await loadSpotWeeks(out), dataset);
    await assert.rejects(downloadSpotWeeks(out, { fetcher, nowMs: NOW }), /EEXIST/);
    assert.equal(calls, 1);
    await writeFile(join(out, "source.json"), "{}\n");
    await assert.rejects(loadSpotWeeks(out), /SOURCE_HASH_MISMATCH/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("cached prices cannot be forged by changing the dataset hash alone", async () => {
  const base = await mkdtemp(join(tmpdir(), "spot-week-forgery-")), out = join(base, "data");
  try {
    await downloadSpotWeeks(out, { fetcher: async () => new Response(JSON.stringify(doc([row()]))), nowMs: NOW });
    const cached = JSON.parse(await readFile(join(out, "dataset.json"), "utf8"));
    cached.bars[0].close = 109;
    const bytes = JSON.stringify(cached) + "\n";
    await writeFile(join(out, "dataset.json"), bytes);
    const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
    manifest.datasetSha256 = hash(bytes); manifest.datasetBytes = Buffer.byteLength(bytes);
    await writeFile(join(out, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(loadSpotWeeks(out), /SOURCE_DATASET_MISMATCH/);
    manifest.sourceFile = "../source.json";
    await writeFile(join(out, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(loadSpotWeeks(out), /INVALID_SPOT_WEEK_MANIFEST/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("failed, oversized or empty data cannot publish a successful manifest", async () => {
  const base = await mkdtemp(join(tmpdir(), "spot-week-http-"));
  try {
    const cases: Array<[string, Response, RegExp]> = [
      ["http", new Response("rate limited", { status: 429 }), /HTTP_429/],
      ["stream", new Response("x".repeat(SPOT_WEEK_DATA_SPEC.maximumResponseBytes + 1)), /RESPONSE_LIMIT/],
      ["header", new Response("{}", { headers: { "content-length": String(SPOT_WEEK_DATA_SPEC.maximumResponseBytes + 1) } }), /RESPONSE_LIMIT/],
      ["empty", new Response(JSON.stringify(doc([]))), /NO_COMPLETED_SPOT_WEEKS/],
      ["gap", new Response(JSON.stringify(doc([row(), row(T + 2 * WEEK_MS)]))), /MISSING_COMPLETED_SPOT_WEEK/],
    ];
    for (const [name, response, failure] of cases) {
      const out = join(base, name);
      await assert.rejects(downloadSpotWeeks(out, { fetcher: async () => response, nowMs: NOW }), failure);
      await assert.rejects(loadSpotWeeks(out), /ENOENT/);
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("retrieval registration must precede source time and remain acquisition only", async () => {
  const base = await mkdtemp(join(tmpdir(), "spot-week-registration-")), out = join(base, "data");
  try {
    await downloadSpotWeeks(out, { fetcher: async () => new Response(JSON.stringify(doc([row()]))), nowMs: NOW });
    const path = join(out, "registration.json"), original = JSON.parse(await readFile(path, "utf8"));
    for (const mutation of [{ registeredAtMs: NOW + 1 }, { activationAllowed: true }, { strategyPerformanceComputed: true }]) {
      await writeFile(path, JSON.stringify({ ...original, ...mutation }));
      await assert.rejects(loadSpotWeeks(out), /INVALID_SPOT_WEEK_REGISTRATION/);
    }
  } finally { await rm(base, { recursive: true, force: true }); }
});
