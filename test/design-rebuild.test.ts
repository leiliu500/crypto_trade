import assert from "node:assert/strict";
import test from "node:test";
import type { BookState } from "../src/core/market.js";
import { BreakoutRetest } from "../src/strategy/breakout-retest.js";
import { fundingCashForInterval, newLinearLedger, recordLinearFill, recordFunding, netLiquidation,
  requiredNetExecutionPrice, newNetProtection, updateNetProtection, liquidationFromBook } from "../src/economics/net-liquidation.js";
import { blockExpectancy } from "../src/research/block-expectancy.js";
import { parseAccountFees, KrakenAccountFees } from "../src/kraken/account-fees.js";
import { findPolicy, policyCandidates, policyProtection, POLICY_VERSION } from "../src/research/trading-policy.js";
import { PositionManager, type Position } from "../src/strategy/position-manager.js";
import { loadConfig } from "../src/config.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";
import { ExecutionStressCase, stressObservation, EXECUTION_SCENARIOS } from "../src/research/execution-stress.js";
import { PolicyCollector } from "../src/research/policy-collector.js";

const book = (at: number, mid: number): BookState => ({ symbol: "BTC/USD", sequence: BigInt(at), valid: true,
  sourceReset: false, receiveTsMs: at, exchangeTsMs: at,
  bids: [{ px: mid - .005, qty: 100 }], asks: [{ px: mid + .005, qty: 100 }] });
const cfg = loadConfig({ TRADING_MODE: "paper", CONFIG_DIR: "config" });
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

for (const side of [1, -1] as const) {
  test(`linear cash ledger and exact protection price reconcile partial exits for side ${side}`, () => {
    const l = newLinearLedger(side);
    recordLinearFill(l, 2, 100, .04, false);
    recordLinearFill(l, 1, 103, .0206, false);
    recordFunding(l, .03);
    recordLinearFill(l, 1, 101 + side * 2, .05, true);
    const required = requiredNetExecutionPrice(l, 2, 5, .01)!;
    near(netLiquidation(l, required, 5, .01), 2);
    const flat = requiredNetExecutionPrice(l, 0, 5)!;
    near(netLiquidation(l, flat, 5), 0);
    recordLinearFill(l, 2, required, 2 * required * .0005, true);
    near(netLiquidation(l, required, 5, .01), 2);
    assert.equal(requiredNetExecutionPrice(l, 0, 5), null);
    assert.throws(() => recordLinearFill(l, 1, 100, 0, true));
    near(fundingCashForInterval(side, 2, 100, .001, 900_000), -side * .05);
  });

  test(`breakout retest reacceleration is causal and mirrored for side ${side}`, () => {
    const detector = new BreakoutRetest();
    const mid = (move: number) => 100 + side * move;
    const quote = (second: number, move: number) => {
      const at = second * 1_000;
      detector.onTrade({ id: `t-${second}`, symbol: "BTC/USD", px: mid(move), qty: 1,
        aggressor: side, exchangeTsMs: at, receiveTsMs: at });
      return detector.observe(book(at, mid(move)));
    };
    for (let i = 1; i <= 61; i++) assert.equal(quote(i, 0), null);
    assert.equal(quote(62, .03), null, "initial burst is not an entry");
    assert.equal(detector.snapshot().boundary, 100);
    assert.equal(quote(63, .08), null);
    assert.equal(detector.snapshot().boundary, 100, "boundary cannot chase the new high/low");
    assert.equal(quote(64, .005), null);
    assert.equal(detector.snapshot().phase, "RETESTED");
    quote(65, .006); quote(66, .007);
    const signal = quote(67, .009);
    assert.equal(signal?.side, side);
    assert.equal(signal?.boundary, 100);
    assert.equal(quote(68, .01), null, "one candidate per setup");
    detector.observe(book(90_000, 100));
    assert.equal(detector.snapshot().samples, 0, "feed gap discards structural history");
  });
}

test("no aggressive flow cannot create a setup and an invalidated retest cannot fire", () => {
  const d = new BreakoutRetest();
  for (let i = 0; i < 62; i++) d.observe(book(i * 1_000, 100));
  d.observe(book(62_000, 100.1));
  assert.equal(d.snapshot().phase, "WATCHING");
  d.onTrade({ id: "buy", symbol: "BTC/USD", px: 100.2, qty: 1, aggressor: 1, receiveTsMs: 63_000, exchangeTsMs: 63_000 });
  d.observe(book(63_000, 100.2));
  assert.equal(d.snapshot().phase, "BREAKOUT");
  d.observe(book(64_000, 99));
  assert.equal(d.snapshot().phase, "WATCHING");
});

test("net floor never loosens, recovery does not force immediate exit, and gap-through exits", () => {
  const p = newNetProtection(10, 1_000);
  assert.equal(updateNetProtection(p, -6, 2), false);
  assert.equal(updateNetProtection(p, 3, 2), false);
  assert.equal(p.floorUsd, 0);
  assert.equal(p.recovered, true);
  updateNetProtection(p, 15, 2);
  const floor = p.floorUsd;
  updateNetProtection(p, 14, 100);
  assert.equal(p.floorUsd, floor);
  assert.equal(updateNetProtection(p, -20, 100), true);
  const l = newLinearLedger(1); recordLinearFill(l, 101, 100, 1, false);
  assert.equal(liquidationFromBook(l, book(1, 100), 5), null, "missing depth is not a fabricated liquidation");
});

test("block bootstrap retains day dependence and a profitable parent cannot hide a losing cell", () => {
  const day = 86_400_000;
  const cell = Array.from({ length: 20 }, (_, i) => ({ atMs: Math.floor(i / 10) * day + i, netBps: i < 10 ? 30 : -40 }));
  const parent = cell.map((r) => ({ ...r, netBps: 100 }));
  const result = blockExpectancy(cell, parent);
  assert.ok(result.lower95! <= -40);
  assert.deepEqual(blockExpectancy(cell, parent), result);
  assert.equal(blockExpectancy(cell.slice(0, 10)).lower95, null);
});

test("contract-specific fee lookup converts percent to bps and rejects missing derivative fees", async () => {
  const response = { error: [], result: { fees: { PF_XBTUSD: { fee: "0.05" } }, fees_maker: { PF_XBTUSD: { fee: "0.02" } } } };
  assert.deepEqual(parseAccountFees(response, ["PF_XBTUSD"], 100)[0], { product: "PF_XBTUSD", makerFeeBps: 2,
    takerFeeBps: 5, source: "KRAKEN_TRADE_VOLUME", observedMs: 100, expiresMs: 900100 });
  assert.throws(() => parseAccountFees(response, ["PF_ETHUSD"], 100));
  const bodies: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://api.kraken.com/0/private/TradeVolume");
    const body = JSON.parse(String(init?.body)); bodies.push(body.nonce);
    assert.deepEqual(body.pair, [{ asset: "PF_XBTUSD", aclass: "derivatives" }]);
    return new Response(JSON.stringify(response));
  };
  const service = new KrakenAccountFees("test-key", Buffer.from("test-secret").toString("base64"), fetcher, () => 100);
  await service.load(["PF_XBTUSD"]); await service.load(["PF_XBTUSD"]);
  assert.ok(BigInt(bodies[1]!) > BigInt(bodies[0]!));
});

test("research exits and paper net-floor exits match for a winning retest followed by reversal", () => {
  const features = (at: number, mid: number): DeterministicFeatures => ({ symbol: "BTC/USD", mid,
    receiveTsMs: at, stale: false, warmedUp: true, kinematicsReady: true, slowTrendReady: true,
    spreadBps: 1, sigmaHBps: 1, retestCandidate: { side: 1, boundary: 100, invalidationPx: 99,
      signalAtMs: at, setupAtMs: 0, volatilityBps: 1, tradeImbalance: .8 },
    trendFastBps: 1, trendMediumBps: 2, trendSlowBps: 3, slowTrendEfficiency: .5, ofi: 1, tfi: 1, velocityZ: 1 } as DeterministicFeatures);
  const asset = { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001, maximumOrderQty: 100, priceIncrement: .001, shortable: true };
  const collector = new PolicyCollector("test", "BTC/USD", 5, 3);
  const start = collector.captureEntry(book(1000, 100), features(1000, 100), asset, policyCandidates(features(1000, 100))[0]!, .1)
    .find((o) => o.policyId === "retest-1m")!;
  assert.ok(start);
  const context = { healthAllowed: true, healthReasons: [], liquidityPass: true, liquidityReasons: [], positionOpen: false,
    pendingOrder: false, cooldownRemainingMs: 0, sizing: "ACTUAL_ORDER_QUANTITY" as const };
  const stress = new ExecutionStressCase(stressObservation(start, EXECUTION_SCENARIOS[0]!, "paired", "retest", context));
  const l = newLinearLedger(1); recordLinearFill(l, .1, 100.005, .1 * 100.005 * .0005, false);
  const p: Position = { symbol: "BTC/USD", side: 1, qty: .1, entryPx: 100.005, openedMs: 1250,
    initialRiskPx: .5, roundTripCostPx: .13, mfePx: 0, maePx: 0, floorPx: -.5, breakEvenArmed: false, phase: "OPEN",
    ledger: l, policy: { version: POLICY_VERSION, id: "retest-1m", feeBps: 5, reserveBps: 3, invalidationPx: 99, volatilityBps: 1 },
    netProtection: policyProtection(findPolicy("retest-1m")!, 5, 3, l.entryNotional) };
  const manager = new PositionManager(cfg.position);
  let completed: ReturnType<ExecutionStressCase["observe"]> = null;
  const outcomes = [];
  for (const [at, mid] of [[1250, 100], [2000, 101], [3000, 100.8], [3250, 100.75]]) {
    const b = book(at!, mid!), f = features(at!, mid!);
    outcomes.push(...collector.observe(b, f, asset));
    completed = stress.observe(b) ?? completed;
    if (at === 2000) assert.equal(manager.update(p, b.bids[0]!.px, at, f, 0, 0).action, "HOLD");
    if (at === 3000) assert.deepEqual(manager.update(p, b.bids[0]!.px, at, f, 0, 0), { action: "EXIT", reason: "POLICY_NET_FLOOR" });
  }
  const outcome = outcomes.find((o) => o.id === start.id && o.status === "COMPLETE")!;
  assert.equal(outcome.reason, "POLICY_NET_FLOOR");
  assert.equal(completed!.reason, outcome.reason);
  near(completed!.netBps!, outcome.netBps!);
});
