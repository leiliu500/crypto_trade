import assert from "node:assert/strict";
import test from "node:test";
import type { BookState } from "../src/core/market.js";
import type { AssetRules } from "../src/execution/planner.js";
import { EfficientDistributionTrainer, EFFICIENT_TRAINING_SPEC } from "../src/distribution/efficient-trainer.js";
import { ConditionalDistributionModel } from "../src/distribution/model.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS, DISTRIBUTION_SPEC as S,
  type DistributionDecision, type DistributionSample } from "../src/distribution/spec.js";

const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const assets: Record<string, AssetRules> = Object.fromEntries(S.symbols.map(symbol => [symbol, {
  symbol, minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .01, maximumOrderQty: 1, shortable: true,
}]));
function book(atMs: number, symbol = "BTC/USD", bid = 100, ask = 100.01): BookState {
  return { symbol, bids: [{ px: bid, qty: 1 }], asks: [{ px: ask, qty: 1 }],
    exchangeTsMs: atMs, receiveTsMs: atMs, sequence: BigInt(atMs + 1), valid: true, sourceReset: false };
}
function context(b: BookState): DistributionDecision {
  return { version: S.version, symbol: b.symbol, atMs: b.receiveTsMs, quoteSequence: String(b.sequence),
    referenceBid: b.bids[0]!.px, referenceAsk: b.asks[0]!.px,
    requestedQty: Math.floor(S.maximumNotional / b.asks[0]!.px / .001 + 1e-12) * .001,
    ...costs[b.symbol as keyof typeof costs], features: Array<number>(S.featureDimension).fill(0),
    estimates: [], actionId: null, reason: "TRAINING_PANEL", paperReady: false,
    validation: { selections: 0, observedDays: 0, lowerNetBps: null, ready: false } };
}
function seed(signalAtMs: number, actionId = "long-5m", symbol = "BTC/USD"): DistributionSample {
  return { id: `${symbol}:${actionId}:${signalAtMs}`, symbol, actionId, signalAtMs,
    completedAtMs: signalAtMs + 750, features: Array<number>(S.featureDimension).fill(0),
    outcomes: DISTRIBUTION_SCENARIOS.map(scenario => ({ scenario: scenario.id, status: "UNFILLED",
      netBps: 0, grossBps: 0, filledFraction: 0, entryAtMs: null,
      exitAtMs: signalAtMs + scenario.latencyMs, reason: "IOC_UNFILLED" })) };
}
function advance(trainer: EfficientDistributionTrainer, first: number, last: number,
  withContext = false): DistributionSample[] {
  const rows: DistributionSample[] = [];
  for (let at = first; at <= last; at += 1000) {
    const quote = book(at); rows.push(...trainer.onBook(quote, withContext ? context(quote) : null));
  }
  return rows;
}

test("five-minute labels learn from observed completion before unrelated horizons, without any further evaluations", () => {
  const trainer = new EfficientDistributionTrainer(costs, assets), quote = book(0), d = context(quote);
  trainer.onBook(quote, d); d.features[0] = 1;
  assert.equal(trainer.stats().pendingActions, 6);
  assert.equal(advance(trainer, 1000, 301_000).length, 0);
  assert.equal(trainer.stats().learning.acceptedSamples, 0);
  const completionBook = book(302_000), invalidContext = context(completionBook); invalidContext.referenceBid++;
  const rows = trainer.onBook(completionBook, invalidContext);
  assert.deepEqual(rows.map(row => row.actionId), ["long-5m", "short-5m"]);
  assert.ok(rows.every(row => row.completedAtMs === 302_000 && row.features[0] === 0
    && row.outcomes.every(outcome => outcome.status === "FILLED" && outcome.reason === "DEADLINE")));
  assert.equal(trainer.stats().learning.acceptedSamples, 2);
  assert.equal(trainer.stats().pendingActions, 4);
  assert.equal(trainer.stats().rejectedContexts, 1, "invalid new context cannot suppress already completed observations");
  assert.equal(trainer.estimate("BTC/USD", "long-5m", Array<number>(12).fill(0), 301_999).samples, 0);
  assert.equal(trainer.estimate("BTC/USD", "long-5m", Array<number>(12).fill(0), 302_000).samples, 1);
  rows[0]!.outcomes[0]!.netBps = 1000;
  assert.ok(trainer.exportSamples()[0]!.outcomes[0]!.netBps! < 0);
});

test("disconnect invalidates unfinished paths and preserves already learned five-minute outcomes", () => {
  const trainer = new EfficientDistributionTrainer(costs, assets), quote = book(0);
  trainer.onBook(quote, context(quote)); advance(trainer, 1000, 302_000);
  const before = trainer.exportSamples(), invalid = trainer.invalidate(308_000, "PUBLIC_FEED_DISCONNECTED");
  assert.equal(invalid.length, 4);
  assert.ok(invalid.every(row => row.outcomes.some(outcome => outcome.status === "INVALID")));
  assert.deepEqual(trainer.exportSamples(), before);
  assert.equal(trainer.stats().learning.acceptedSamples, 2);
  assert.equal(trainer.stats().invalidActions, 4);
  assert.equal(trainer.stats().pendingCases, 0);
  assert.deepEqual(trainer.invalidate(309_000, "PUBLIC_FEED_DISCONNECTED"), []);
  trainer.onBook(book(359_999), context(book(359_999)));
  assert.equal(trainer.stats().pendingActions, 0);
  trainer.onBook(book(360_000), context(book(360_000)));
  assert.equal(trainer.stats().pendingActions, 2, "only the six-minute horizon clock is due");
});

test("fixed six/sixteen/thirty-one-minute clocks pair sides and forbid early-exit oversampling or overlapping origins", () => {
  const trainer = new EfficientDistributionTrainer(costs, assets);
  const rows = advance(trainer, 0, 1_862_000, true);
  const byAction = trainer.stats().byAction.filter(row => row.symbol === "BTC/USD");
  assert.deepEqual(byAction.map(row => [row.actionId, row.started]), [
    ["long-5m", 6], ["short-5m", 6], ["long-15m", 2], ["short-15m", 2], ["long-30m", 2], ["short-30m", 2],
  ]);
  for (const action of DISTRIBUTION_ACTIONS) {
    const samples = rows.filter(row => row.actionId === action.id);
    for (let i = 1; i < samples.length; i++) {
      assert.ok(samples[i]!.signalAtMs >= samples[i - 1]!.completedAtMs);
      assert.equal(samples[i]!.signalAtMs - samples[i - 1]!.signalAtMs, action.horizonMs + 60_000);
    }
    const peerId = action.id.replace(action.side === 1 ? "long" : "short", action.side === 1 ? "short" : "long");
    assert.deepEqual(samples.map(row => row.signalAtMs), rows.filter(row => row.actionId === peerId).map(row => row.signalAtMs));
  }
  assert.equal(trainer.stats().learning.rejectedSamples, 0);
  const early = new EfficientDistributionTrainer(costs, assets);
  early.onBook(book(0), context(book(0)));
  early.onBook(book(250, "BTC/USD", 100.02, 100.04), null);
  const done = early.onBook(book(750, "BTC/USD", 100.02, 100.04), null);
  assert.ok(done.some(row => row.actionId === "long-5m" && row.outcomes.every(outcome => outcome.status === "UNFILLED")));
  early.invalidate(1000, "RECORDING_END");
  early.estimate("BTC/USD", "long-5m", Array<number>(12).fill(0), 10_000_000);
  assert.equal(early.stats().startedHorizons, 3, "queries and elapsed time do not launch cases");
  early.onBook(book(2000), context(book(2000)));
  assert.equal(early.stats().startedHorizons, 3, "early nonfills do not speed up sampling");
});

test("one missing stressed scenario excludes its action while fully observed opposite-side labels remain learned", () => {
  const trainer = new EfficientDistributionTrainer(costs, assets);
  trainer.onBook(book(0), context(book(0)));
  trainer.onBook(book(250), null);
  trainer.onBook(book(500, "BTC/USD", 100.6, 100.61), null);
  const valid = trainer.onBook(book(750, "BTC/USD", 100.6, 100.61), null);
  const long = valid.find(row => row.actionId === "long-5m")!;
  assert.deepEqual(long.outcomes.map(outcome => outcome.status), ["FILLED", "FILLED", "UNFILLED"]);
  const invalid = trainer.onBook(book(7000, "BTC/USD", 100.6, 100.61), null);
  const short = invalid.find(row => row.actionId === "short-5m")!;
  assert.deepEqual(short.outcomes.map(outcome => outcome.status), ["FILLED", "FILLED", "INVALID"]);
  assert.equal(short.outcomes[2]!.reason, "QUOTE_GAP");
  assert.ok(trainer.exportSamples().some(row => row.id === long.id));
  assert.equal(trainer.exportSamples().some(row => row.id === short.id), false);
  assert.equal(trainer.stats().learning.rejectedSamples, 0, "invalid executions never enter the estimator");
});

test("seeds are chronological, immutable and reject future, invalid, duplicate or overlapping outcomes", () => {
  const first = seed(0), second = seed(360_000);
  const trainer = new EfficientDistributionTrainer(costs, assets, [second, first], second.completedAtMs);
  assert.deepEqual(trainer.exportSamples().map(row => row.signalAtMs), [0, 360_000]);
  const reference = new ConditionalDistributionModel(); reference.observe(first); reference.observe(second);
  assert.deepEqual(trainer.estimate("BTC/USD", "long-5m", first.features, second.completedAtMs),
    reference.estimate("BTC/USD", "long-5m", first.features, second.completedAtMs, 3));
  second.features[0] = 1;
  assert.equal(trainer.exportSamples()[1]!.features[0], 0);
  assert.throws(() => new EfficientDistributionTrainer(costs, assets, [seed(0)], 749), /SEED_FUTURE/);
  assert.throws(() => new EfficientDistributionTrainer(costs, assets, [seed(0), seed(0)], 1000), /SEED_LABEL/);
  assert.throws(() => new EfficientDistributionTrainer(costs, assets, [seed(0), seed(500)], 2000), /SEED_LABEL/);
  const invalid = seed(0); invalid.outcomes[1]!.status = "INVALID";
  assert.throws(() => new EfficientDistributionTrainer(costs, assets, [invalid], 1000), /SEED_LABEL/);
  trainer.onBook(book(719_999), context(book(719_999)));
  assert.equal(trainer.stats().byAction.find(row => row.symbol === "BTC/USD" && row.actionId === "long-5m")!.started, 0);
  trainer.onBook(book(720_000), context(book(720_000)));
  assert.equal(trainer.stats().byAction.find(row => row.symbol === "BTC/USD" && row.actionId === "short-5m")!.pendingSignalAtMs, 720_000,
    "an unseeded opposite side still waits for the seeded side's nonoverlap clock");
});

test("training origins require matching fresh quote, costs, size and bounded features regardless of action eligibility", () => {
  const corruptions: Array<(d: DistributionDecision) => void> = [
    d => { d.version = "different"; }, d => { d.symbol = "ETH/USD"; }, d => { d.atMs++; },
    d => { d.quoteSequence = "999"; }, d => { d.referenceBid++; }, d => { d.referenceAsk++; },
    d => { d.feeBps++; }, d => { d.reserveBps++; }, d => { d.requestedQty -= .001; },
    d => { d.requestedQty = Infinity; }, d => { d.features.pop(); }, d => { d.features[0] = NaN; },
    d => { d.features[0] = 1.01; }, d => { d.actionId = "unrecognized"; },
  ];
  for (const corrupt of corruptions) {
    const trainer = new EfficientDistributionTrainer(costs, assets), quote = book(0), d = context(quote);
    corrupt(d); assert.deepEqual(trainer.onBook(quote, d), []);
    assert.equal(trainer.stats().startedActions, 0); assert.equal(trainer.stats().rejectedContexts, 1);
  }
  for (const quote of [{ ...book(0), valid: false }, { ...book(2000), exchangeTsMs: 0 }]) {
    const trainer = new EfficientDistributionTrainer(costs, assets);
    trainer.onBook(quote, context(quote)); assert.equal(trainer.stats().startedActions, 0);
  }
  const trainer = new EfficientDistributionTrainer(costs, assets);
  trainer.onBook(book(1000), null);
  trainer.onBook(book(1000), context(book(1000)));
  trainer.onBook(book(999), context(book(999)));
  assert.equal(trainer.stats().startedActions, 0);
  trainer.onBook(book(1001), { ...context(book(1001)), actionId: "long-5m" });
  assert.equal(trainer.stats().startedActions, 6, "a selected or abstained decision uses the same prescribed training origin");
  assert.throws(() => new EfficientDistributionTrainer(costs, { ...assets, "BTC/USD": { ...assets["BTC/USD"]!, priceIncrement: 0 } }), /CONFIG/);
});

test("retained samples, case count and exported copies remain bounded independently for every asset and action", () => {
  const rows: DistributionSample[] = [];
  for (let i = 0; i <= S.maximumSamples; i++) for (const symbol of S.symbols) for (const action of DISTRIBUTION_ACTIONS) {
    rows.push(seed(i * S.proposalIntervalMs, action.id, symbol));
  }
  const cutoff = S.maximumSamples * S.proposalIntervalMs + 750;
  const trainer = new EfficientDistributionTrainer(costs, assets, rows, cutoff);
  assert.equal(trainer.stats().learning.acceptedSamples, rows.length);
  assert.equal(trainer.stats().learning.retainedSamples, S.maximumSamples * 12);
  const exported = trainer.exportSamples(); assert.equal(exported.length, S.maximumSamples * 12);
  assert.ok(exported.every(row => row.signalAtMs > 0));
  exported[0]!.features[0] = 1; exported[0]!.outcomes[0]!.reason = "MUTATED";
  assert.equal(trainer.exportSamples()[0]!.features[0], 0);
  assert.equal(trainer.exportSamples()[0]!.outcomes[0]!.reason, "IOC_UNFILLED");
  const at = (S.maximumSamples + 1) * S.proposalIntervalMs;
  for (const symbol of S.symbols) trainer.onBook(book(at, symbol), context(book(at, symbol)));
  assert.equal(trainer.stats().pendingActions, EFFICIENT_TRAINING_SPEC.maximumPendingActions);
  assert.equal(trainer.stats().pendingCases, EFFICIENT_TRAINING_SPEC.maximumPendingCases);
  for (const symbol of S.symbols) trainer.onBook(book(at + 250, symbol, 100.02, 100.04), null);
  for (const symbol of S.symbols) trainer.onBook(book(at + 750, symbol, 100.02, 100.04), null);
  assert.equal(trainer.exportSamples().length, S.maximumSamples * 12, "new labels evict only their own bank's oldest entry");
  assert.ok(trainer.stats().byAction.every(row => row.samples === S.maximumSamples));
});

test("unique recording error messages cannot create an unbounded diagnostic bank", () => {
  const trainer = new EfficientDistributionTrainer(costs, assets);
  for (let i = 0; i < 40; i++) {
    const quote = book(i * S.proposalIntervalMs);
    trainer.onBook(quote, context(quote));
    trainer.invalidate(quote.receiveTsMs + 100, `RECORDING_ERROR_${i}`);
  }
  const stats = trainer.stats();
  assert.equal(stats.invalidActions, 40 * 6);
  assert.equal(Object.keys(stats.invalidByReason).length, EFFICIENT_TRAINING_SPEC.maximumInvalidReasonCategories);
  assert.ok(stats.invalidByReason.OTHER_INVALID_REASON! > 0);
  assert.equal(stats.pendingCases, 0); assert.equal(stats.learning.retainedSamples, 0);
});

test("a disconnect retains receipt floors without treating ordinary peer timestamp interleaving as reversed history", () => {
  const trainer = new EfficientDistributionTrainer(costs, assets);
  trainer.onBook(book(0), context(book(0))); advance(trainer, 1000, 302_000);
  trainer.invalidate(2_000_000, "PUBLIC_FEED_DISCONNECTED");
  trainer.onBook(book(1_000_000), context(book(1_000_000)));
  assert.equal(trainer.stats().startedActions, 6, "old quotes cannot relaunch a shorter action that completed before disconnect");
  trainer.onBook(book(2_000_000), context(book(2_000_000)));
  assert.equal(trainer.stats().startedActions, 12);
  const paired = new EfficientDistributionTrainer(costs, assets);
  paired.onBook(book(1000), context(book(1000)));
  paired.onBook(book(999, "ETH/USD"), context(book(999, "ETH/USD")));
  assert.equal(paired.stats().startedActions, 12, "ordinary cross-symbol receipt order remains valid");
});
