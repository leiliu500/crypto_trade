import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BookState } from "../src/core/market.js";
import { DistributionHistoryCheckpoint } from "../src/distribution/history-checkpoint.js";
import { DistributionMarket } from "../src/distribution/market.js";
import { DistributionController } from "../src/distribution/controller.js";
import { DISTRIBUTION_SPEC as S } from "../src/distribution/spec.js";

const start = 1_800_000_000_000, end = start + 1_800_000;
const book = (atMs: number, symbol: string): BookState => ({ symbol, receiveTsMs: atMs, exchangeTsMs: atMs,
  bids: [{ px: symbol === "BTC/USD" ? 100 : 10, qty: 10 }],
  asks: [{ px: symbol === "BTC/USD" ? 100.01 : 10.01, qty: 10 }],
  sequence: BigInt(atMs), sourceReset: true, valid: true });
function warmed() {
  const market = new DistributionMarket();
  for (let atMs = start; atMs <= end; atMs += 1_000) for (const symbol of S.symbols) market.onBook(book(atMs, symbol));
  return market;
}
const target = (market: DistributionMarket, now = end + 1_000) => ({
  exportDistributionalMarketHistory: () => market.exportHistory(),
  restoreDistributionalMarketHistory: (value: unknown) => market.restoreHistory(value, now),
});

test("history captured before shutdown survives feed invalidation and restores no executable quote", async t => {
  const directory = await mkdtemp(join(tmpdir(), "distribution-history-checkpoint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "market.json"), market = warmed(), expected = market.exportHistory(), errors: unknown[] = [];
  const checkpoint = new DistributionHistoryCheckpoint(file, target(market), error => errors.push(error));
  checkpoint.save(); market.invalidate(); await checkpoint.flush();
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), expected);
  const resumed = new DistributionMarket();
  const result = await new DistributionHistoryCheckpoint(file, target(resumed), error => errors.push(error)).restore();
  assert.equal(result?.restoredSamples, 362);
  assert.equal(resumed.snapshot("BTC/USD", end + 1000)?.ready, false);
  assert.equal(resumed.snapshot("BTC/USD", end + 1000)?.reason, "BOOK_NOT_READY");
  assert.deepEqual(errors, []);
});

test("missing, corrupt and stale history cannot create market readiness", async t => {
  const directory = await mkdtemp(join(tmpdir(), "distribution-history-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "market.json"), market = new DistributionMarket();
  const checkpoint = new DistributionHistoryCheckpoint(file, target(market), () => {});
  assert.equal(await checkpoint.restore(), null);
  await writeFile(file, "{broken"); await assert.rejects(checkpoint.restore());
  await writeFile(file, JSON.stringify(warmed().exportHistory()));
  const old = await new DistributionHistoryCheckpoint(file, target(market, end + 100_000), () => {}).restore();
  assert.equal(old?.restoredSamples, 0); assert.equal(old?.rejectedSymbols.length, 2);
  assert.equal(market.snapshot("BTC/USD", end + 100_000)?.ready, false);
});

test("history warmup enables the first causal evaluation after fresh flow without granting validation", () => {
  const costs = Object.fromEntries(S.symbols.map(symbol => [symbol, { feeBps: 5, reserveBps: 3 }]));
  const assets = Object.fromEntries(S.symbols.map(symbol => [symbol, {
    symbol, minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .001, maximumOrderQty: 100, shortable: true,
  }]));
  const controller = new DistributionController(costs, assets), before = controller.exportState();
  assert.equal(controller.restoreMarketHistory(warmed().exportHistory(), end + 1000).restoredSamples, 362);
  assert.deepEqual(controller.exportState(), before, "history does not manufacture labels or validation");
  for (let elapsed = 1_000; elapsed <= 30_000; elapsed += 1_000) for (const symbol of S.symbols)
    assert.equal(controller.onBook(book(end + elapsed, symbol)).decision, null);
  const decisions = [];
  for (let elapsed = 31_000; elapsed <= 32_000; elapsed += 1_000) for (const symbol of S.symbols) {
    const update = controller.onBook(book(end + elapsed, symbol));
    if (update.decision) decisions.push(update.decision);
  }
  assert.equal(decisions.length, 4, "fresh flow enables repeated one-second decisions during pending training");
  for (const symbol of S.symbols) assert.deepEqual(decisions.filter(d => d.symbol === symbol).map(d => d.atMs),
    [end + 31_000, end + 32_000]);
  assert.equal(controller.stats(end + 32_000).proposals, 2, "each symbol still has only one training panel");
  assert.ok(decisions.every(d => d.actionId === null && !d.paperReady && !d.validation.ready));
  assert.equal(controller.stats(end + 32_000).learning.acceptedSamples, 0);
  assert.equal(controller.stats(end + 32_000).validation.selections, 0);
});
