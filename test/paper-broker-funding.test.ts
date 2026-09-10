import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionPlan } from "../src/execution/planner.js";
import { KrakenPaperBroker, type KrakenPaperBrokerConfig } from "../src/kraken/paper-broker.js";
import type { PaperFundingRate } from "../src/kraken/paper-funding.js";
import { RollingRealizedPnlLedger } from "../src/risk/rolling-pnl.js";

const T = Date.UTC(2026, 8, 9), H = 3_600_000, SYMBOL = "BTC/USD";
function config(now: () => number, extra: Partial<KrakenPaperBrokerConfig> = {}): KrakenPaperBrokerConfig {
  return { initialEquity: 100_000, productsBySymbol: { [SYMBOL]: "PF_XBTUSD" },
    instruments: new Map([[SYMBOL, { symbol: SYMBOL, productId: "PF_XBTUSD", tickSize: 1,
      quantityIncrement: .001, maximumOrderQty: 1_000 }]]), makerFeeBpsBySymbol: { [SYMBOL]: 5 },
    takerFeeBpsBySymbol: { [SYMBOL]: 5 }, fundingEnabled: true, now, ...extra };
}
function plan(id: string, at: number, side: 1 | -1, qty: number, price: number, reduce = false): ExecutionPlan {
  return { clientOrderId: id, decisionId: `${id}-decision`, riskApprovalId: `${id}-risk`, symbol: SYMBOL,
    side, qty, limitPx: price, style: "taker", timeInForce: "ioc", createdMs: at, expiresMs: at + 2_000,
    originatingSequence: 1n, featureHash: "test", strategyVersion: "test", modelVersion: "none",
    expectedCost: { roundTripBps: 0, spreadBps: 0, feeBps: 0, impactBps: 0, latencyBps: 0,
      adverseSelectionBps: 0, fundingBps: 0, borrowBps: 0 },
    risk: { qty, riskBudget: 1, maximumLossPerUnit: 1, modeledMaximumLoss: qty,
      drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit: "risk" },
    fillProbability: 1, expectedValue: 0, reduceOnlyIntent: reduce };
}
function book(broker: KrakenPaperBroker, at: number, bid = 99, ask = 100) {
  broker.onBook({ symbol: SYMBOL, bids: [{ px: bid, qty: 10 }], asks: [{ px: ask, qty: 10 }],
    reset: true, exchangeTsMs: at, receiveTsMs: at, sourceId: `book-${at}` });
}
function rate(from = T, amount = 2, known = from): PaperFundingRate {
  return { id: `rate:${from}`, symbol: SYMBOL, productId: "PF_XBTUSD", effectiveFromMs: from,
    effectiveToMs: from + H, knownAtMs: known, absoluteUsdPerBasePerHour: amount, sourceResponseSha256: "a".repeat(64) };
}
async function trade(broker: KrakenPaperBroker, at: number, id: string, side: 1 | -1, qty: number, price: number, reduce = false) {
  book(broker, at, side === 1 ? price - 1 : price, side === 1 ? price : price + 1);
  await broker.send(plan(id, at, side, qty, price, reduce)); await Promise.resolve();
}
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
async function cash(broker: KrakenPaperBroker) { return Number((await broker.getAccount()).data.cash); }

test("broker commits actual long funding and fees with fill identities while strict fill history remains valid", async () => {
  let now = T; const broker = new KrakenPaperBroker(config(() => now));
  broker.applyFundingRates([rate()]);
  now = T + H / 4; await trade(broker, now, "long", 1, 2, 100);
  now = T + H * .75; await trade(broker, now, "close", -1, 2, 100, true);
  near(await cash(broker), 100_000 - 2 - .2);
  const history = broker.history(), funding = broker.fundingHistory()!;
  near(funding.snapshot.postedFundingCashUsd, -2);
  assert.equal(funding.snapshot.lifetimeFundingAccountingKnown, true);
  assert.equal(funding.snapshot.venueCashReceiptsVerified, false);
  assert.deepEqual(history.activities.map(row => row.activity_type), ["FILL", "FILL"]);
  const fundingFills = funding.state.events.flatMap(event => event.type === "FILL" ? [event.fill] : []);
  assert.deepEqual(fundingFills.map(fill => fill.id).sort(), history.activities.map(row => row.id).sort());
  assert.deepEqual(fundingFills.map(fill => fill.occurredAtMs), [T + H / 4, T + H * .75]);
  const ledger = new RollingRealizedPnlLedger();
  assert.equal(ledger.restore(history, now, (await broker.listPositions()).data), true);
  near(ledger.snapshot(now).fees24hUsd!, .2);
  near(ledger.snapshot(now).netRealizedPnl24hUsd!, -2.2);
});

test("short positive funding credits and negative funding debits cash by actual held base quantity", async () => {
  let now = T; const broker = new KrakenPaperBroker(config(() => now, { takerFeeBpsBySymbol: { [SYMBOL]: 0 } }));
  broker.applyFundingRates([rate()]);
  await trade(broker, now, "short", -1, 2, 100);
  now += H; broker.settleFunding(); near(await cash(broker), 100_004);
  broker.applyFundingRates([rate(now, -3)]);
  now += H; broker.settleFunding(); near(await cash(broker), 99_998);
  near(broker.fundingSnapshot()!.postedFundingCashUsd, -2);
});

test("missing funding remains unknown and backfill cash cannot be charged twice across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paper-funding-restart-"));
  try {
    let now = T; const cfg = config(() => now, { stateFile: join(directory, "state.json"), takerFeeBpsBySymbol: { [SYMBOL]: 0 } });
    const first = new KrakenPaperBroker(cfg); await trade(first, now, "entry", 1, 1, 100);
    now += H; assert.deepEqual(first.settleFunding(), []);
    assert.equal(first.fundingSnapshot()!.fundingCashUsd, null); near(await cash(first), 100_000);
    const postings = first.applyFundingRates([rate(T, 2, now)]);
    assert.equal(postings.length, 1); near(await cash(first), 99_998);
    assert.equal(JSON.parse(readFileSync(cfg.stateFile!, "utf8")).schemaVersion, 4);
    const restarted = new KrakenPaperBroker(cfg);
    assert.deepEqual(restarted.settleFunding(), []);
    assert.deepEqual(restarted.applyFundingRates([rate(T, 2, now)]), []);
    near(await cash(restarted), 99_998);
    assert.equal(restarted.fundingSnapshot()!.fundingAccountingKnown, true);
    assert.equal(restarted.fundingHistory()!.state.events.filter(event => event.type === "POSTING").length, 1);
    const omittedFlag = new KrakenPaperBroker({ ...cfg, fundingEnabled: false });
    assert.ok(omittedFlag.fundingHistory(), "existing funding evidence survives omitted startup enable flag");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("legacy position migration declares its funding epoch and preserves all earlier cash", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paper-funding-migration-"));
  try {
    let now = T; const cfg = config(() => now, { stateFile: join(directory, "state.json"), takerFeeBpsBySymbol: { [SYMBOL]: 0 } });
    const legacy = new KrakenPaperBroker({ ...cfg, fundingEnabled: false });
    await trade(legacy, now, "old-entry", 1, 1, 100);
    assert.equal(legacy.fundingHistory(), undefined);
    now += H;
    const migrated = new KrakenPaperBroker(cfg);
    near(await cash(migrated), 100_000);
    assert.equal(migrated.fundingHistory()!.state.config.startedAtMs, now);
    assert.equal(migrated.fundingSnapshot()!.priorHistoryFundingUnknown, true);
    assert.equal(migrated.fundingSnapshot()!.lifetimeFundingAccountingKnown, false);
    migrated.applyFundingRates([rate(T, 100, now), rate(now, 2, now)]);
    now += H; migrated.settleFunding(); near(await cash(migrated), 99_998);
    const restarted = new KrakenPaperBroker(cfg);
    assert.equal(restarted.fundingSnapshot()!.priorHistoryFundingUnknown, true); near(await cash(restarted), 99_998);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("failed settlement persistence rolls back cash and evidence before announcing a posting", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paper-funding-atomic-"));
  try {
    let now = T; const cfg = config(() => now, { stateFile: join(directory, "state.json"), takerFeeBpsBySymbol: { [SYMBOL]: 0 } });
    const broker = new KrakenPaperBroker(cfg); await trade(broker, now, "entry", 1, 1, 100);
    const oldHash = broker.fundingHistory()!.state.stateSha256, events: unknown[] = [];
    broker.tradeStream.on("funding", event => events.push(event)); now += H;
    const obstruction = `${cfg.stateFile}.${process.pid}.tmp`; mkdirSync(obstruction);
    assert.throws(() => broker.applyFundingRates([rate(T, 2, now)]));
    near(await cash(broker), 100_000); assert.equal(broker.fundingHistory()!.state.stateSha256, oldHash);
    assert.deepEqual(events, []); rmSync(obstruction, { recursive: true });
    broker.applyFundingRates([rate(T, 2, now)]); near(await cash(broker), 99_998); assert.equal(events.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("failed fill persistence rolls back position, fees, funding, activity and order quantities together", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paper-funding-fill-atomic-"));
  try {
    let now = T; const cfg = config(() => now, { stateFile: join(directory, "state.json") });
    const broker = new KrakenPaperBroker(cfg); broker.applyFundingRates([rate()]);
    await trade(broker, now, "entry", 1, 1, 100);
    now += H / 2; book(broker, now, 99, 101);
    const order = await broker.send({ ...plan("maker-close", now, -1, 1, 100, true), style: "maker", timeInForce: "gtc" });
    const oldCash = await cash(broker), oldHash = broker.fundingHistory()!.state.stateSha256;
    const obstruction = `${cfg.stateFile}.${process.pid}.tmp`; mkdirSync(obstruction);
    const marketTrade = { id: "close-trade", symbol: SYMBOL, px: 100, qty: 1, aggressor: 1 as const, exchangeTsMs: now, receiveTsMs: now };
    assert.throws(() => broker.onTrade(marketTrade));
    near(await cash(broker), oldCash); assert.equal(broker.fundingHistory()!.state.stateSha256, oldHash);
    assert.equal((await broker.getOrder(order.id)).data.filled_qty, "0");
    assert.equal((await broker.listPositions()).data[0]!.qty, "1"); assert.equal(broker.history().activities.length, 1);
    rmSync(obstruction, { recursive: true }); broker.onTrade(marketTrade);
    near(await cash(broker), 100_000 - .1 - 1); assert.equal(broker.history().activities.length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("funding snapshot cache is immutable, expires within one second, and invalidates on a fill", async () => {
  let now = T; const broker = new KrakenPaperBroker(config(() => now));
  const first = broker.fundingHistory()!; assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.state));
  assert.ok(Object.isFrozen(first.snapshot.perSymbol));
  now += 999; assert.equal(broker.fundingSnapshot(), first.snapshot);
  assert.equal(broker.fundingSnapshot(now), first.snapshot);
  now += 1; assert.notEqual(broker.fundingSnapshot(), first.snapshot);
  const before = broker.fundingSnapshot(); await trade(broker, now, "new-entry", 1, 1, 100);
  assert.notEqual(broker.fundingSnapshot(), before);
  assert.equal(broker.fundingSnapshot()!.perSymbol[0]!.signedBaseQty, 1);
});

test("corrupted funding inventory and ledger evidence are rejected on checkpoint restore", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paper-funding-corrupt-"));
  try {
    let now = T; const cfg = config(() => now, { stateFile: join(directory, "state.json") });
    const broker = new KrakenPaperBroker(cfg); await trade(broker, now, "entry", 1, 1, 100);
    const raw = JSON.parse(readFileSync(cfg.stateFile!, "utf8")); raw.positions[0].qty = 2;
    writeFileSync(cfg.stateFile!, JSON.stringify(raw)); assert.throws(() => new KrakenPaperBroker(cfg), /funding inventory/);
    raw.positions[0].qty = 1; raw.funding.state.stateSha256 = "0".repeat(64);
    writeFileSync(cfg.stateFile!, JSON.stringify(raw)); assert.throws(() => new KrakenPaperBroker(cfg), /funding checkpoint/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("public funding refresh uses the fixed Kraken endpoint and never fetches in the constructor", async () => {
  let now = T, calls = 0;
  const fetcher: typeof fetch = async input => {
    calls++; assert.equal(String(input), "https://futures.kraken.com/derivatives/api/v3/historical-funding-rates?symbol=PF_XBTUSD");
    return new Response(JSON.stringify({ result: "success", serverTime: new Date(now).toISOString(),
      rates: [{ timestamp: new Date(T).toISOString(), fundingRate: 2, relativeFundingRate: .02 }] }));
  };
  const broker = new KrakenPaperBroker(config(() => now, { takerFeeBpsBySymbol: { [SYMBOL]: 0 } }), fetcher);
  assert.equal(calls, 0); await trade(broker, now, "entry", 1, 1, 100); now += H;
  const result = await broker.refreshFunding(); assert.equal(calls, 1); assert.equal(result.postings.length, 1);
  near(await cash(broker), 99_998); assert.equal(result.snapshot.fundingAccountingKnown, true);
});

test("funding settlement at UTC midnight enters the new cash session and stays there after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "paper-funding-session-"));
  try {
    let now = T + 23 * H;
    const cfg = config(() => now, { stateFile: join(directory, "state.json") });
    const broker = new KrakenPaperBroker(cfg); broker.applyFundingRates([rate(now)]);
    now += H * .75; await trade(broker, now, "late-entry", 1, 2, 100);
    now = T + 24 * H; broker.settleFunding();
    const history = (await broker.getPortfolioHistory()).data as { profit_loss: number[] };
    near(history.profit_loss[1]!, -1);
    const restarted = new KrakenPaperBroker(cfg);
    near(((await restarted.getPortfolioHistory()).data as { profit_loss: number[] }).profit_loss[1]!, -1);
    assert.deepEqual(restarted.settleFunding(), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a sub-second cached funding snapshot cannot hide a newly due UTC hourly settlement", async () => {
  let now = T; const broker = new KrakenPaperBroker(config(() => now));
  broker.applyFundingRates([rate()]); await trade(broker, now, "entry", 1, 1, 100);
  now = T + H - 1; const before = broker.fundingSnapshot(now)!;
  assert.equal(before.dueModelPostings.length, 0); assert.equal(before.fundingAccountingKnown, true);
  now = T + H; const due = broker.fundingSnapshot(now)!;
  assert.notEqual(due, before); assert.equal(due.dueModelPostings.length, 1);
  assert.equal(due.fundingAccountingKnown, false);
});
