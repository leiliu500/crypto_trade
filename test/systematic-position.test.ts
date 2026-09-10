import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEMATIC_SPEC as S, type SystematicPositionSpec } from "../src/systematic/spec.js";
import { evaluateSystematicExit, validSystematicPositionSpec } from "../src/systematic/position.js";
import { newLinearLedger, recordLinearFill, netLiquidation } from "../src/economics/net-liquidation.js";
import { PositionManager, type Position } from "../src/strategy/position-manager.js";
import type { Features } from "../src/core/market.js";
import { loadConfig } from "../src/config.js";
import { KrakenPaperBroker, type KrakenPaperBrokerConfig } from "../src/kraken/paper-broker.js";
import { recoverPolicyPositions } from "../src/research/policy-restore.js";
import type { ExecutionPlan } from "../src/execution/planner.js";
import type { PrivateOrderEvent } from "../src/execution/order-state.js";
import { PostgresTelemetryStore } from "../src/database/postgres-store.js";

function spec(): SystematicPositionSpec {
  return { version: S.version, signalId: "test-signal", signalBarCloseMs: 0, stopBps: 200,
    targetBps: 400, trailingBps: 200, trailActivationR: 1, maximumHoldMs: S.maximumHoldMs,
    feeBps: 5, fundingReserveBps: 9 };
}
function position(side: 1 | -1 = 1): Position {
  const ledger = newLinearLedger(side);
  recordLinearFill(ledger, 1, 100, .05, false);
  return { symbol: "BTC/USD", side, qty: 1, entryPx: 100, openedMs: 1000, initialRiskPx: 2,
    roundTripCostPx: .19, mfePx: 0, maePx: 0, floorPx: -2, breakEvenArmed: false,
    phase: "OPEN", systematic: spec(), ledger };
}
function close(a: number | undefined, b: number): void { assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} != ${b}`); }

test("systematic exits preserve the frozen ATR stop and ignore unrelated micro hold predictions", () => {
  const manager = new PositionManager(loadConfig({ CONFIG_DIR: "config", TRADING_MODE: "replay" }).position);
  const f = { stale: false, mid: 100 } as Features;
  for (const side of [1, -1] as const) {
    const p = position(side), original = structuredClone(p);
    assert.equal(manager.update(p, 100, 2000, f, -500, 1).action, "HOLD");
    close(p.initialRiskPx, 2); close(p.systematicProtection?.referenceEntryPx, 100);
    const adverse = 100 - side * 2;
    assert.deepEqual(manager.update(p, adverse, 3000, f, 500, 0), { action: "EXIT", reason: "SYSTEMATIC_STOP" });
    assert.deepEqual(manager.update(p, 100 + side * 3, 4000, f, 500, 0), { action: "EXIT", reason: "SYSTEMATIC_EXIT_LATCHED" });
    assert.deepEqual(p.systematic, original.systematic, "exit management cannot change entry ATR parameters");
  }
});

test("systematic targets charge actual fees and the funding reserve once at executable prices", () => {
  const p = position();
  const grossTarget = evaluateSystematicExit(p, 104, 2000);
  assert.equal(grossTarget.action, "HOLD", "four percent gross does not meet four percent net");
  close(grossTarget.netLiquidationUsd, 4 - .05 - 104 * .0005 - .09);
  assert.equal(evaluateSystematicExit(p, 104.2, 3000).reason, "SYSTEMATIC_TARGET");
  assert.equal(evaluateSystematicExit(position(-1), 95.8, 3000).reason, "SYSTEMATIC_TARGET");
});

test("systematic net trail persists across partial exits without resetting original risk or notional", () => {
  const p = position(), input = structuredClone(p);
  const first = evaluateSystematicExit(p, 103, 2000);
  assert.deepEqual(p, input, "the shared evaluator is pure");
  assert.equal(first.protection?.activated, true);
  close(first.protection?.floorNetUsd, 3 - .05 - .0515 - .09 - 2);
  p.systematicProtection = first.protection!;
  recordLinearFill(p.ledger!, .5, 103, .5 * 103 * .0005, true);
  p.qty = .5;
  const reduced = evaluateSystematicExit(p, 102, 3000);
  assert.equal(reduced.action, "HOLD");
  close(reduced.netLiquidationUsd, netLiquidation(p.ledger!, 102, 5, .09));
  close(reduced.protection?.entryNotional, 100);
  close(reduced.protection?.initialRiskUsd, 2);
  close(reduced.protection?.floorNetUsd, first.protection!.floorNetUsd);
  p.systematicProtection = reduced.protection!;
  const restarted = JSON.parse(JSON.stringify(p)) as Position;
  assert.deepEqual(evaluateSystematicExit(restarted, 98.9, 4000), evaluateSystematicExit(p, 98.9, 4000));
  assert.equal(evaluateSystematicExit(restarted, 98.9, 4000).reason, "SYSTEMATIC_TRAIL");
});

test("systematic metadata, ledger and persisted trail uncertainty fail closed; duration is unconditional", () => {
  const p = position();
  assert.equal(evaluateSystematicExit(p, 101, p.openedMs + S.maximumHoldMs).reason, "SYSTEMATIC_DEADLINE");
  assert.equal(evaluateSystematicExit(p, 101, p.openedMs + S.maximumHoldMs - 1).action, "HOLD");
  for (const changed of [{ version: "unknown" }, { stopBps: NaN }, { maximumHoldMs: S.maximumHoldMs + 1 },
    { feeBps: -1 }, { trailingBps: 0 }, { signalId: "" }]) {
    const invalid = { ...p, systematic: { ...p.systematic!, ...changed } };
    assert.equal(validSystematicPositionSpec(invalid.systematic), false);
    assert.equal(evaluateSystematicExit(invalid, 100, 2000).reason, "SYSTEMATIC_INVALID_METADATA");
  }
  const noLedger = { ...p }; delete noLedger.ledger;
  assert.equal(evaluateSystematicExit(noLedger, 100, 2000).reason, "SYSTEMATIC_LEDGER_UNCERTAIN");
  const manager = new PositionManager(loadConfig({ CONFIG_DIR: "config", TRADING_MODE: "replay" }).position);
  const corrupt = { ...position(), systematic: null } as unknown as Position;
  assert.deepEqual(manager.update(corrupt, 100, 2000, { stale: false } as Features, 100, 0),
    { action: "EXIT", reason: "SYSTEMATIC_INVALID_METADATA" });
  p.systematicProtection = evaluateSystematicExit(p, 103, 2000).protection!;
  p.systematicProtection.entryNotional = 50;
  assert.equal(evaluateSystematicExit(p, 102, 3000).reason, "SYSTEMATIC_PROTECTION_UNCERTAIN");
  const missingProtectedTrail = position(); missingProtectedTrail.phase = "PROTECTED";
  assert.equal(evaluateSystematicExit(missingProtectedTrail, 100, 3000).reason, "SYSTEMATIC_PROTECTION_UNCERTAIN");
});

function brokerConfig(stateFile?: string): KrakenPaperBrokerConfig {
  return { initialEquity: 100_000, productsBySymbol: { "BTC/USD": "PF_XBTUSD" },
    instruments: new Map([["BTC/USD", { symbol: "BTC/USD", productId: "PF_XBTUSD", tickSize: .01,
      quantityIncrement: .001, maximumOrderQty: 10 }]]),
    makerFeeBpsBySymbol: { "BTC/USD": 2 }, takerFeeBpsBySymbol: { "BTC/USD": 5 },
    ...(stateFile ? { stateFile } : {}) };
}
function plan(id: string, atMs = 1000, side: 1 | -1 = 1, qty = 1, limitPx = 100, reduceOnlyIntent = false): ExecutionPlan {
  return { clientOrderId: id, decisionId: id, riskApprovalId: id, symbol: "BTC/USD", side, qty, limitPx,
    style: "taker", timeInForce: "ioc", createdMs: atMs, expiresMs: atMs + S.entryTtlMs,
    originatingSequence: BigInt(atMs), featureHash: "test", strategyVersion: S.version, modelVersion: S.version,
    systematic: spec(), expectedCost: { roundTripBps: 19, spreadBps: 0, feeBps: 10, impactBps: 0,
      latencyBps: 0, adverseSelectionBps: 0, fundingBps: 9, borrowBps: 0 },
    risk: { qty, riskBudget: 100, maximumLossPerUnit: 2.19, modeledMaximumLoss: qty * 2.19,
      drawdownScale: 1, qualityScale: 1, volatilityScale: 1, bindingLimit: "risk" },
    fillProbability: 1, expectedValue: 0, reduceOnlyIntent, economicHorizonMs: S.maximumHoldMs,
    executionPath: "TAKER_TAKER", researchOnly: true };
}
function observe(broker: KrakenPaperBroker, atMs: number, bid = 99.98, ask = 100, qty = 10, sequence = atMs): void {
  broker.onBook({ symbol: "BTC/USD", bids: [{ px: bid, qty }], asks: [{ px: ask, qty }],
    exchangeTsMs: atMs, receiveTsMs: atMs, reset: true,
    sourceId: `snapshot-${sequence}` });
}

test("systematic paper entries and exits wait for a later book and retain partial fills/nonfills", async () => {
  const broker = new KrakenPaperBroker(brokerConfig());
  const events: PrivateOrderEvent[] = [];
  broker.tradeStream.on("order", (event: PrivateOrderEvent) => events.push(event));
  observe(broker, 1000);
  const entry = await broker.send(plan("entry")); await Promise.resolve();
  assert.equal((await broker.getOrder(entry.id)).data.status, "new");
  observe(broker, 1249); assert.equal((await broker.listPositions()).data.length, 0);
  observe(broker, 1250, 99.98, 100, .4);
  close(Number((await broker.listPositions()).data[0]!.qty), .4);
  assert.equal(events.find(e => e.event === "partial_fill")?.timestampMs, 1250);
  observe(broker, 1500, 102, 102.02);
  const exit = await broker.send(plan("exit", 1500, -1, .4, 102, true)); await Promise.resolve();
  assert.equal((await broker.getOrder(exit.id)).data.status, "new");
  observe(broker, 1750, 101.99, 102.01);
  assert.equal((await broker.getOrder(exit.id)).data.status, "canceled", "an adverse arrival does not receive an invented fill");
  close(Number((await broker.listPositions()).data[0]!.qty), .4);
  await broker.send(plan("retry-exit", 1750, -1, .4, 101.98, true));
  observe(broker, 2000, 101.99, 102.01);
  assert.equal((await broker.listPositions()).data.length, 0);
  close(Number((await broker.getAccount()).data.equity) - 100_000, .4 * 1.99 - .4 * (100 + 101.99) * .0005);
});

test("systematic paper IOC requires an advancing sequence and expires without a synthetic quote", async () => {
  const broker = new KrakenPaperBroker(brokerConfig()); observe(broker, 1000);
  const order = await broker.send(plan("sequence"));
  observe(broker, 1250, 99.98, 100, 10, 1000);
  assert.equal((await broker.listPositions()).data.length, 0);
  observe(broker, 3001);
  assert.equal((await broker.getOrder(order.id)).data.status, "canceled");
  await assert.rejects(broker.send({ ...plan("invalid-window"), expiresMs: 1100 }), /arrival window/);
});

test("systematic arrivals cannot execute levels carried by an ignored duplicate snapshot", async () => {
  const broker = new KrakenPaperBroker(brokerConfig()); observe(broker, 1000);
  const order = await broker.send(plan("duplicate-depth"));
  observe(broker, 1100, 98.98, 99, 10, 1000);
  broker.onBook({ symbol: "BTC/USD", bids: [], asks: [], reset: false,
    exchangeTsMs: 1250, receiveTsMs: 1250, sourceId: "accepted-empty-delta" });
  assert.equal((await broker.getOrder(order.id)).data.filled_avg_price, "100");
  close(Number((await broker.listPositions()).data[0]!.avg_entry_price), 100);
});

test("systematic pending entries are canceled across restart and cannot fill unobserved downtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "systematic-pending-restart-"));
  try {
    const cfg = brokerConfig(join(dir, "paper.json"));
    const broker = new KrakenPaperBroker(cfg); observe(broker, 1000);
    const order = await broker.send(plan("restart-pending"));
    const restarted = new KrakenPaperBroker(cfg);
    observe(restarted, 1250, 98.98, 99);
    assert.equal((await restarted.getOrder(order.id)).data.status, "canceled");
    assert.equal((await restarted.listPositions()).data.length, 0);
    assert.equal(restarted.history().activities.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("systematic recovery preserves complete stored trails and closes when a durable trail is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "systematic-recovery-"));
  try {
    const cfg = brokerConfig(join(dir, "paper.json"));
    const broker = new KrakenPaperBroker(cfg); observe(broker, 1000);
    await broker.send(plan("durable-entry")); observe(broker, 1250);
    const restarted = new KrakenPaperBroker(cfg);
    const remote = (await restarted.listPositions()).data;
    const recovered = recoverPolicyPositions(restarted.history(), remote, []);
    assert.equal(recovered.length, 1); assert.deepEqual(recovered[0]!.systematic, spec());
    close(recovered[0]!.initialRiskPx, 2); close(recovered[0]!.ledger?.entryFees, .05);
    assert.equal(recovered[0]!.phase, "EXITING", "missing prior peak must not loosen a possible prior trail");
    assert.equal(evaluateSystematicExit(recovered[0]!, 100, 2000).reason, "SYSTEMATIC_EXIT_LATCHED");
    const prior = position(); prior.systematicProtection = evaluateSystematicExit(prior, 103, 2000).protection!;
    prior.phase = "PROTECTED";
    assert.deepEqual(recoverPolicyPositions(restarted.history(), remote, [prior]), [prior]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("systematic partial-entry recovery uses observed fill time and cannot reuse another signal's stored position", async () => {
  const broker = new KrakenPaperBroker(brokerConfig()); observe(broker, 1000);
  await broker.send(plan("partial-recovery")); observe(broker, 1250, 99.98, 100, .4);
  const remote = (await broker.listPositions()).data;
  const unrelated = position(); unrelated.systematic!.signalId = "older-signal-at-the-same-price";
  unrelated.qty = .4;
  const recovered = recoverPolicyPositions(broker.history(), remote, [unrelated]);
  assert.equal(recovered.length, 1); assert.equal(recovered[0]!.openedMs, 1250);
  assert.equal(recovered[0]!.systematic!.signalId, "test-signal");
  assert.equal(recovered[0]!.phase, "EXITING");
  close(recovered[0]!.ledger!.remainingQty, .4); close(recovered[0]!.ledger!.entryFees, .02);
});

test("damaged systematic order metadata remains recognizable during recovery for protective closure", async () => {
  const broker = new KrakenPaperBroker(brokerConfig()); observe(broker, 1000);
  await broker.send(plan("damaged-recovery")); observe(broker, 1250);
  const remote = (await broker.listPositions()).data;
  for (const metadata of [null, { ...spec(), stopBps: NaN }]) {
    const history = structuredClone(broker.history());
    (history.orders[0]!.plan as unknown as { systematic: unknown }).systematic = metadata;
    const restored = recoverPolicyPositions(history, remote, [])[0]!;
    assert.ok(restored); assert.equal(restored.phase, "EXITING");
    assert.ok(Number.isFinite(restored.initialRiskPx) && restored.initialRiskPx > 0);
    assert.deepEqual(restored.systematic, metadata);
    assert.equal(evaluateSystematicExit(restored, 100, 2000).reason, "SYSTEMATIC_INVALID_METADATA");
  }
});

test("database restoration preserves systematic metadata, trail and latched exit including unknown versions", async () => {
  const store = new PostgresTelemetryStore({ connectionString: "postgres://unused", flushIntervalMs: 60_000, maximumQueue: 3 });
  const internals = store as unknown as { pool: { query: () => Promise<{ rows: unknown[] }>; end: () => Promise<void> } };
  const original = internals.pool, p = position();
  p.systematicProtection = evaluateSystematicExit(p, 103, 2000).protection!;
  p.phase = "EXITING"; p.systematic!.version = "unknown-future-version";
  internals.pool = { query: async () => ({ rows: [{ position: p }] }), end: async () => undefined };
  try {
    const restored = (await store.loadLatestPositionStates([p.symbol]))[0]!;
    assert.deepEqual(restored.systematic, p.systematic);
    assert.deepEqual(restored.systematicProtection, p.systematicProtection);
    assert.deepEqual(restored.ledger, p.ledger); assert.equal(restored.phase, "EXITING");
    assert.equal(evaluateSystematicExit(restored, 103, 3000).reason, "SYSTEMATIC_INVALID_METADATA");
    p.systematic = spec(); p.phase = "OPEN";
    (p as unknown as { systematicProtection: unknown }).systematicProtection = "corrupt";
    const corrupt = (await store.loadLatestPositionStates([p.symbol]))[0]!;
    assert.equal(evaluateSystematicExit(corrupt, 103, 3000).reason, "SYSTEMATIC_PROTECTION_UNCERTAIN");
  } finally { await store.close(); await original.end(); }
});
