import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import type { BookState, Features } from "../src/core/market.js";
import { CHANNEL_PRICE_PROTECTED_SPEC as P, CHANNEL_STUDY_SPEC as D } from "../src/channel/spec.js";
import { buildChannelPlan, channelPlannerContextSha256, channelSourceIdentity, verifyChannelEligibility,
  type ChannelPlannerAccount, type ChannelPlannerContext, type ChannelQualification, type VerifiedChannelEligibility } from "../src/channel/planner.js";
const HASH = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const END = Date.UTC(2026, 8, 9), NOW = END + 3600000;
function fixture(side: 1 | -1 = 1) {
  const config = structuredClone(loadConfig({ TRADING_MODE: "paper" }).symbolConfigs["BTC/USD"]!);
  config.cost.takerFeeBps = 5; config.cost.borrowBps = 0; config.maximumNotional = 1000;
  config.sizing.maximumBookParticipation = .01; config.sizing.baseRiskFraction = .001; config.sizing.maximumDrawdown = .05;
  const book: BookState = { symbol: "BTC/USD", valid: true, sourceReset: false, sequence: 1n,
    exchangeTsMs: NOW, receiveTsMs: NOW, bids: [{ px: 80000, qty: .0001 }, { px: 79999, qty: 10 }],
    asks: [{ px: 80001, qty: .0001 }, { px: 80002, qty: 10 }, { px: 80100, qty: 100 }] };
  const account: ChannelPlannerAccount = { known: true, fundingKnown: true, entriesAllowed: true, reconciledAtMs: NOW,
    equity: 100000, equityHighWater: 100000, sessionStartingEquity: 100000, rolling24HourStartingEquity: 100000,
    sessionStartMs: END, rolling24HourReferenceAtMs: NOW - 86400000, positions: [], pendingGrossNotionalUsd: 0,
    pendingRiskUsd: 0, pendingSymbols: [], lastConsumedSignalEndMsBySymbol: {} };
  const sources = { "synthetic-test-source.ts": "synthetic source for planner mechanics only" };
  const sourceHashes = Object.fromEntries(Object.entries(sources).map(([p, s]) => [p, HASH(s)]));
  return { mode: "paper", config, book, account, sources, sourceHashes,
    sourceIdentitySha256: channelSourceIdentity(sourceHashes),
    portfolio: { maximumGrossNotional: 2000, maximumClusterPositions: 2, rollingLossFraction: .0075, sessionLossFraction: .0075 },
    asset: { symbol: "BTC/USD", minOrderSize: .0001, minTradeIncrement: .0001, priceIncrement: 1, maximumOrderQty: 1000, shortable: true },
    features: { symbol: "BTC/USD", mid: 80000.5, receiveTsMs: NOW, stale: false } as Features,
    signal: { strategyVersion: P.version, inputSha256: HASH("synthetic finalized inputs"),
      value: { symbol: "BTC/USD" as const, endMs: END, close: 80000, atr: 800, entrySide: side, longExit: false, shortExit: false } },
    nowMs: NOW, eligibility: null as VerifiedChannelEligibility | null };
}
/** Synthetic positive reports exercise plumbing only; no test bundle is installed. */
function bundle(x: ReturnType<typeof fixture>, changeReport?: (r: Record<string, unknown>) => void) {
  const report: Record<string, unknown> = { strategyVersion: P.version, sourceHashes: x.sourceHashes,
    historicalDevelopmentEligible: true, baseEpisodes: 19,
    checks: { allRunsAccounted: true, bothPeriodsPositiveBaseAndStress: true, enoughEpisodes: true, lowerBootstrapWeeklyNetPositive: true },
    bootstrap: { lowerMeanWeeklyNetUsd: 1 }, runs: D.windows.flatMap(w => ["base", "stress"].map(scenario => ({
      startMs: w.startMs, endMs: w.endMs, scenario, policy: "channel", accountingKnown: true, netPnlUsd: 1, unresolved: [] }))) };
  changeReport?.(report);
  const reportJson = JSON.stringify(report), protocolJson = JSON.stringify({ strategy: P, sourceHashes: x.sourceHashes });
  const qualification: ChannelQualification = { schemaVersion: 1, status: "VERIFIED", mode: "paper", strategyVersion: P.version,
    reportSha256: HASH(reportJson), protocolSha256: HASH(protocolJson), sourceIdentitySha256: x.sourceIdentitySha256,
    runtimeContextSha256: channelPlannerContextSha256(x), checkedAtMs: NOW - 1000, expiresAtMs: NOW + 86400000,
    currentAccountFeesAndRulesVerified: true };
  const qualificationJson = JSON.stringify(qualification);
  return { reportJson, protocolJson, qualificationJson,
    trusted: { reportSha256: HASH(reportJson), protocolSha256: HASH(protocolJson), qualificationSha256: HASH(qualificationJson), sourceIdentitySha256: x.sourceIdentitySha256 },
    currentSources: x.sources, context: x as ChannelPlannerContext, nowMs: x.nowMs };
}
function eligible(x: ReturnType<typeof fixture>) {
  const verified = verifyChannelEligibility(bundle(x)); assert.ok(verified.eligibility, verified.reason); x.eligibility = verified.eligibility; return x;
}
test("missing, asserted, copied or failed validation cannot authorize a channel entry", () => {
  const x = fixture(); assert.equal(buildChannelPlan(x).plan, null);
  x.eligibility = { status: "VERIFIED" } as VerifiedChannelEligibility;
  assert.equal(buildChannelPlan(x).decision.reason, "CHANNEL_PROFITABILITY_NOT_VERIFIED");
  eligible(x); x.eligibility = { ...x.eligibility! };
  assert.equal(buildChannelPlan(x).plan, null);
  for (const mutate of [(r: Record<string, unknown>) => { r.historicalDevelopmentEligible = false; },
    (r: Record<string, unknown>) => { r.bootstrap = { lowerMeanWeeklyNetUsd: -2.93 }; },
    (r: Record<string, unknown>) => { r.baseEpisodes = 7; },
    (r: Record<string, unknown>) => { (r.runs as Array<Record<string, unknown>>)[0]!.netPnlUsd = -1; }])
    assert.equal(verifyChannelEligibility(bundle(fixture(), mutate)).eligibility, null);
});
test("hashes bind reviewed source, report, qualification, current fees and runtime sizing context", () => {
  const x = fixture(), b = bundle(x);
  assert.equal(verifyChannelEligibility({ ...b, reportJson: b.reportJson + " " }).reason, "CHANNEL_VALIDATION_HASH_MISMATCH");
  assert.equal(verifyChannelEligibility({ ...b, currentSources: { "synthetic-test-source.ts": "changed" } }).reason, "CHANNEL_CURRENT_SOURCE_NOT_VALIDATED");
  eligible(x); x.config.maximumNotional = 1200;
  assert.equal(buildChannelPlan(x).decision.reason, "CHANNEL_VALIDATED_CONTEXT_CHANGED");
  const fee = fixture(); fee.config.cost.takerFeeBps = 6; eligible(fee);
  assert.equal(buildChannelPlan(fee).decision.reason, "CHANNEL_FROZEN_FEES_OR_RULES_MISMATCH");
});
test("the real current V2 statistical failure remains ineligible even with a synthetic review assertion", async () => {
  const root = "reports/profit-engine-rebuild-2026-09-09/channel-price-protected-v2";
  const reportJson = await readFile(join(root, "report.json"), "utf8"), protocolJson = await readFile(join(root, "protocol.json"), "utf8");
  const protocol = JSON.parse(protocolJson) as { sourceHashes: Record<string, string> };
  const x = fixture(); x.sourceIdentitySha256 = channelSourceIdentity(protocol.sourceHashes);
  const b = bundle(x), q = JSON.parse(b.qualificationJson) as ChannelQualification;
  q.reportSha256 = HASH(reportJson); q.protocolSha256 = HASH(protocolJson); q.sourceIdentitySha256 = x.sourceIdentitySha256;
  const qualificationJson = JSON.stringify(q), currentSources: Record<string, Buffer> = {};
  for (const path of Object.keys(protocol.sourceHashes)) currentSources[path] = await readFile(join(root, "sources", path));
  const result = verifyChannelEligibility({ reportJson, protocolJson, qualificationJson, context: x, nowMs: NOW, currentSources,
    trusted: { reportSha256: HASH(reportJson), protocolSha256: HASH(protocolJson), qualificationSha256: HASH(qualificationJson), sourceIdentitySha256: x.sourceIdentitySha256 } });
  assert.equal(result.eligibility, null); assert.equal(result.reason, "CHANNEL_PROFITABILITY_NOT_VERIFIED");
});
test("verified synthetic eligibility produces a costed fixed-stop IOC using selected-side cumulative depth", () => {
  for (const side of [1, -1] as const) {
    const x = eligible(fixture(side)), { plan: p, decision: d } = buildChannelPlan(x);
    assert.ok(p, d.reason); assert.equal(p.strategyVersion, P.version); assert.equal(p.modelVersion, P.version);
    assert.equal(d.visibleExecutableQty, 10.0001); assert.ok(p.qty > .0001);
    assert.ok(p.qty <= 10.0001 * .01); assert.ok(p.qty * Math.max(80001, p.limitPx) <= 1000);
    assert.ok(p.risk.modeledMaximumLoss <= 50); assert.equal(p.timeInForce, "ioc"); assert.equal(p.expiresMs - p.createdMs, 2000);
    assert.equal(p.channel.entryProtection.fixedStopPx, 80000 - side * 1600);
    assert.equal(p.expectedValue, 0); assert.equal(p.edgeSource, "UNRESOLVED"); assert.equal(p.conservativeNetEdgeBps, undefined);
    assert.equal(p.channel.requiresPreFillRevalidation, true); assert.equal(p.channel.entryLatencyMs, 250);
    assert.ok(d.additionalRuntimeRiskReservePerUnit > 0); assert.ok(p.expectedCost.spreadBps > 0);
    assert.ok(Math.abs(p.expectedCost.roundTripBps - (p.expectedCost.spreadBps + p.expectedCost.feeBps + p.expectedCost.impactBps + p.expectedCost.adverseSelectionBps)) < 1e-8);
    assert.equal(d.consumeSignal, true);
  }
});
test("insufficient matching depth never borrows liquidity beyond the limit or from the opposite book", () => {
  const x = eligible(fixture()); x.book.asks = [{ px: 80001, qty: .0001 }, { px: 80100, qty: 10000 }];
  assert.equal(buildChannelPlan(x).decision.reason, "CHANNEL_MINIMUM_ORDER_BLOCKED_BY_LIQUIDITY");
  const single = eligible(fixture(-1)); single.book.bids = [{ px: 80000, qty: 10 }];
  assert.ok(buildChannelPlan(single).plan);
});
test("remaining account and pending position risk lower quantity and never increase per-asset allocation", () => {
  const base = eligible(fixture()), full = buildChannelPlan(base).plan!;
  const x = eligible(fixture()); x.account.pendingRiskUsd = 90; x.account.pendingGrossNotionalUsd = 500; x.account.pendingSymbols = ["ETH/USD"];
  const partial = buildChannelPlan(x).plan!; assert.ok(partial); assert.ok(partial.qty < full.qty); assert.ok(partial.risk.modeledMaximumLoss <= 10);
  const loss = eligible(fixture()); loss.account.equity = 99260;
  const limited = buildChannelPlan(loss).plan!; assert.ok(limited); assert.ok(limited.risk.modeledMaximumLoss <= 10);
  loss.account.equity = 99250; assert.equal(buildChannelPlan(loss).plan, null);
});
test("paper-only, daily timing, account freshness and quote validation all remain mandatory", () => {
  const mutations: Array<(x: ReturnType<typeof fixture>) => void> = [
    x => { x.mode = "live"; }, x => { x.signal.value.endMs -= 86400000; }, x => { x.nowMs = END + 60000; },
    x => { x.account.fundingKnown = false; }, x => { x.account.reconciledAtMs -= 1001; },
    x => { x.account.sessionStartMs -= 86400000; }, x => { x.account.rolling24HourReferenceAtMs -= 1001; },
    x => { x.book.exchangeTsMs -= 1001; }, x => { x.book.valid = false; }, x => { x.book.asks = [...x.book.asks].reverse(); },
    x => { x.account.lastConsumedSignalEndMsBySymbol["BTC/USD"] = END; }, x => { x.account.pendingSymbols = ["BTC/USD"]; },
  ];
  for (const mutate of mutations) { const x = eligible(fixture()); mutate(x); assert.equal(buildChannelPlan(x).plan, null); }
});
test("a quote outside the signal half-ATR band consumes the signal without moving its stop", () => {
  const x = eligible(fixture());
  x.book.bids = [{ px: 80500, qty: 10 }]; x.book.asks = [{ px: 80501, qty: 10 }]; x.features.mid = 80500.5;
  const result = buildChannelPlan(x); assert.equal(result.plan, null);
  assert.equal(result.decision.reason, "CHANNEL_ENTRY_PRICE_DISPLACEMENT"); assert.equal(result.decision.consumeSignal, true);
});
