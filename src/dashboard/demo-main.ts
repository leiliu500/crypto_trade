import type { DeterministicFeatures } from "../strategy/deterministic-features.js";
import type { EngineOperationalSnapshot } from "../engine/trading-engine.js";
import type { TrackedOrder } from "../execution/order-state.js";
import type { ExecutionPlan } from "../execution/planner.js";
import { OperationsMonitor } from "./operations-monitor.js";
import { DashboardServer } from "./server.js";

const startedAtMs = Date.now() - 2_847_000;
const positionOpenedAtMs = Date.now() - 128_000;
const monitor = new OperationsMonitor({ pollIntervalMs: 500, marketSampleMs: 1_000 });
monitor.setDatabaseHealth({ connected: true, status: "connected", queuedRecords: 4, droppedRecords: 0, lastPersistedAtMs: Date.now() - 180, lastError: null });
const port = Number(process.env.DASHBOARD_PORT ?? 3_001);
const host = process.env.DASHBOARD_HOST ?? "0.0.0.0";
const server = new DashboardServer(monitor, { host, port: Number.isInteger(port) ? port : 3_001 });
const url = await server.start();

monitor.recordEvent("publicStreamReady", { feed: "Alpaca crypto v1beta3", symbols: ["BTC/USD", "ETH/USD", "SOL/USD"] }, Date.now() - 20_000);
monitor.recordEvent("privateStreamReady", { stream: "trade_updates" }, Date.now() - 19_800);
monitor.recordEvent("reconciled", { orders: 4, positions: 1 }, Date.now() - 19_400);

let tick = 0;
const update = (): void => {
  tick += 1;
  const snapshot = demoSnapshot(Date.now(), tick);
  monitor.ingestEngineSnapshot(snapshot);
  if (tick % 5 === 0) {
    monitor.recordEvent("positionDecision", {
      position: { symbol: "BTC/USD" }, decision: { action: "HOLD", floorPx: 67_428.40 },
      regime: { name: "TREND", reversalProbability: .18 + Math.sin(tick / 8) * .04 }, holdLowerBoundBps: 8.4 + Math.sin(tick / 5) * 1.2,
    });
  }
};
update();
const timer = setInterval(update, 800);
process.stdout.write(`${JSON.stringify({ type: "dashboard-demo-started", url })}\n`);

const shutdown = async (): Promise<void> => { clearInterval(timer); monitor.stop(); await server.stop(); };
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

function demoSnapshot(nowMs: number, sequence: number): EngineOperationalSnapshot {
  const btc = 68_240 + Math.sin(sequence / 3) * 54 + Math.sin(sequence / 11) * 18;
  const eth = 3_642 + Math.sin(sequence / 4) * 5.2;
  const sol = 178.42 + Math.sin(sequence / 5) * .44;
  const fillProgress = Math.min(.82, .27 + sequence * .013);
  const orders = demoOrders(nowMs, fillProgress, btc);
  const healthSummary = { count: 100, p50: 12, p90: 31, p95: 38 + Math.sin(sequence / 7) * 3, p99: 52, max: 71 };
  return {
    generatedAtMs: nowMs, started: true, startedAtMs, uptimeMs: nowMs - startedAtMs,
    mode: "paper", paper: true, paperEntryExercise: false, strategyVersion: "2.4.1", modelVersion: "micro-alpha-2026.08",
    symbols: ["BTC/USD", "ETH/USD", "SOL/USD"], equity: 102_483.76, equityHighWater: 102_511.04, realizedSessionPnl: 184.62,
    risk: { health: { publicStream: true, privateStream: true, accountReconciled: true, bookValid: true, clockValid: true, riskRecomputed: true }, reasons: [], equity: 102_483.76, equityHighWater: 102_511.04 },
    orders,
    positions: [{ symbol: "BTC/USD", side: 1, qty: .0824, entryPx: 67_912.2, openedMs: positionOpenedAtMs, initialRiskPx: 410,
      roundTripCostPx: 34.1, mfePx: 442 + Math.sin(sequence / 6) * 14, maePx: 96, floorPx: -61.2 + Math.min(180, sequence * 2.5), breakEvenArmed: true, phase: "TREND_HOLD" }],
    markets: [market("BTC/USD", btc, 1.4, sequence, nowMs, 12.8), market("ETH/USD", eth, .12, sequence + 7, nowMs, 15.1), market("SOL/USD", sol, .018, sequence + 13, nowMs, 19.4)],
    latency: { feed: { ...healthSummary, p95: 18 }, compute: { ...healthSummary, p95: 2.4 }, send: { ...healthSummary, p95: .8 },
      acknowledgment: healthSummary, decisionToVenue: { ...healthSummary, p95: 41.7 },
      fill: { ...healthSummary, p95: 82 }, total: { ...healthSummary, p95: 41.7 } },
  };
}

function market(symbol: string, mid: number, spread: number, sequence: number, nowMs: number, sigma: number): EngineOperationalSnapshot["markets"][number] {
  const bid = mid - spread / 2, ask = mid + spread / 2;
  return { symbol, bookValid: true, bestBid: bid, bestAsk: ask, sequence: String(980_000 + sequence), exchangeTsMs: nowMs - 22, receiveTsMs: nowMs - 14,
    features: features(symbol, mid, spread, nowMs, sigma, sequence) };
}
function features(symbol: string, mid: number, spread: number, nowMs: number, sigma: number, sequence: number): DeterministicFeatures {
  return { symbol, mid, spread, spreadBps: spread / mid * 10_000, microprice: mid + Math.sin(sequence) * spread / 5, visibleDepth: 32.4,
    qi1: .22 + Math.sin(sequence / 4) * .16, qiK: .18, persistentQiK: .14, ofi: .42 + Math.sin(sequence / 3) * .2,
    tfi: .31 + Math.sin(sequence / 5) * .18, bidCancellationRatio: .12, askCancellationRatio: .18, replenishmentPressure: .24,
    velocity: .003, acceleration: .0001, varianceRate: .00002, sigmaHBps: sigma, microEdgeZ: .8, velocityZ: .46 + Math.sin(sequence / 4) * .22, accelerationZ: .12,
    efficiency: .74, cusumUp: true, cusumDown: false, spreadZ: -.24, depthZ: .82, signalFlipRate: .08,
    providerAgeMs: 18 + sequence % 9, staleThresholdMs: 2_000, warmedUp: true, kinematicsReady: true,
    stale: false, staleReason: null, receiveTsMs: nowMs - 14,
    microEdgeBps: .3, impulseBps: 1.2, breakoutUpBps: .8, breakoutDownBps: 0,
    anchorDistanceBps: 12, sigmaImpulseBps: 1.5, cusumUpScore: 4, cusumDownScore: 0,
    flowFlipRate: .08, usableDepthQty: 32.4, usableDepthNotional: 2_000_000,
    slowTrendReady: true, trendFastBps: 18, trendMediumBps: 34, trendSlowBps: 72,
    slowTrendAlignment: .68, slowTrendEfficiency: .42, slowVarianceRate: 4e-8, slowSigmaBps: 120,
    longPullback: { ready: false, structuralMoveBps: 0, pullbackDepthBps: 0, recoveryBps: 0, remainingRoomBps: 0,
      structuralExtremeAgeMs: 0, reversalExtremeAgeMs: 0 },
    shortPullback: { ready: false, structuralMoveBps: 0, pullbackDepthBps: 0, recoveryBps: 0, remainingRoomBps: 0,
      structuralExtremeAgeMs: 0, reversalExtremeAgeMs: 0 } };
}

function demoOrders(nowMs: number, progress: number, btc: number): readonly TrackedOrder[] {
  const activeQty = .12, activeFilled = activeQty * progress;
  return [
    tracked(plan("mlce-btc-entry-a41f8c", "decision-01", "BTC/USD", 1, activeQty, 68_180, nowMs - 8_400, false, .78, 22.45), "PARTIALLY_FILLED", activeFilled, 68_176.4, nowMs - 180, "alpaca-paper-1001"),
    tracked(plan("mlce-eth-entry-f92d31", "decision-02", "ETH/USD", 1, 1.85, 3_628.1, nowMs - 42_000, false, 1, 16.82), "FILLED", 1.85, 3_626.8, nowMs - 39_100, "alpaca-paper-1002"),
    tracked(plan("mlce-sol-entry-7cc210", "decision-03", "SOL/USD", 1, 22, 177.82, nowMs - 78_000, false, .71, 11.12), "CANCELED", 0, 0, nowMs - 76_800, "alpaca-paper-1003"),
    tracked(plan("mlce-exit-btc-91aa04", "decision-04", "BTC/USD", -1, .025, btc - 1.1, nowMs - 1_700, true, 1, -1.64), "OPEN", 0, 0, nowMs - 240, "alpaca-paper-1004"),
  ];
}
function plan(clientOrderId: string, decisionId: string, symbol: string, side: 1 | -1, qty: number, limitPx: number, createdMs: number, reduceOnlyIntent: boolean, fillProbability: number, expectedValue: number): ExecutionPlan {
  return { clientOrderId, decisionId, riskApprovalId: `risk-${decisionId}`, symbol, side, qty, limitPx, style: reduceOnlyIntent ? "taker" : "maker", timeInForce: reduceOnlyIntent ? "ioc" : "gtc",
    createdMs, expiresMs: createdMs + (reduceOnlyIntent ? 4_000 : 30_000), originatingSequence: 980_110n, featureHash: "7d81a9f2c5e451e180cc4591", strategyVersion: "2.4.1", modelVersion: "micro-alpha-2026.08",
    expectedCost: { roundTripBps: 6.84, spreadBps: .24, feeBps: 5, impactBps: .18, latencyBps: .42, adverseSelectionBps: 1, fundingBps: 0, borrowBps: 0 },
    risk: { qty, riskBudget: 102.48, maximumLossPerUnit: 441.2, modeledMaximumLoss: Math.min(102.48, qty * 441.2), drawdownScale: .99, qualityScale: .84, volatilityScale: .92, bindingLimit: "risk" },
    fillProbability, expectedValue, reduceOnlyIntent };
}
function tracked(planValue: ExecutionPlan, status: TrackedOrder["status"], filledQty: number, averageFillPx: number, lastUpdateMs: number, alpacaOrderId: string): TrackedOrder {
  return { plan: planValue, alpacaOrderId, status, filledQty, averageFillPx, lastUpdateMs };
}
