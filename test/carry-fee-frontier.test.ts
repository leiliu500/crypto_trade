import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { evaluateCarryFeeFrontier, runCarryFeeFrontier, CARRY_FEE_FRONTIER_SPEC } from "../src/carry/fee-frontier-main.js";
import { loadCarryResearchConfig } from "../src/carry/config.js";
import { carryMonitorReport, type CarryPublicSnapshot } from "../src/carry/monitor.js";

const T = Date.UTC(2026, 0, 1), DAY = 86_400_000;
const sha = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
function fixture(): CarryPublicSnapshot {
  const response = (payload: unknown) => ({ url: "https://synthetic.invalid/public", startedAtMs: T,
    receivedAtMs: T, httpDateMs: T, payload });
  const instrument = (base: string, symbol: string, precision: number, expiry?: number) => ({ base, symbol,
    quote: "USD", type: "flexible_futures", contractSize: 1, tradeable: true, isExpired: false,
    contractValueTradePrecision: precision, maxPositionSize: 1000,
    ...(expiry === undefined ? {} : { lastTradingTime: new Date(expiry).toISOString() }) });
  const ticker = (symbol: string, bid: number, fundingRate = .02) => ({ symbol, bid, ask: bid + 1,
    bidSize: 1, askSize: 1, fundingRate });
  return { collectedAtMs: T, responses: {
    instruments: response({ result: "success", instruments: [instrument("BTC", "PF_XBTUSD", 4),
      instrument("ETH", "PF_ETHUSD", 3), instrument("ETH", "FF_ETHUSD_260302", 3, T + 60 * DAY)] }),
    tickers: response({ result: "success", serverTime: new Date(T).toISOString(),
      tickers: [ticker("PF_XBTUSD", 80003), ticker("PF_ETHUSD", 2503), ticker("FF_ETHUSD_260302", 2550)] }),
    spotRules: response({ error: [], result: {
      XXBTZUSD: { ordermin: "0.00005", costmin: "0.5", lot_decimals: 8, status: "online" },
      XETHZUSD: { ordermin: "0.001", costmin: "0.5", lot_decimals: 8, status: "online" } } }),
    BTC: response({ error: [], result: { XXBTZUSD: { bids: [["80000", "1", T / 1000]], asks: [["80001", "1", T / 1000]] } } }),
    ETH: response({ error: [], result: { XETHZUSD: { bids: [["2500", "1", T / 1000]], asks: [["2501", "1", T / 1000]] } } }),
  } };
}

test("fixed fee frontier is exactly the unchanged monitor with only the prescribed spot-fee override", () => {
  const snapshot = fixture(), config = loadCarryResearchConfig().config;
  const beforeSnapshot = structuredClone(snapshot), beforeConfig = structuredClone(config);
  const sourceBefore = JSON.stringify({ snapshot, config });
  const results = evaluateCarryFeeFrontier(snapshot, config);
  assert.deepEqual(results.map(r => r.spotTakerFeeBps), [0, 20, 40, 80]);
  for (const r of results) {
    assert.deepEqual(r.report, carryMonitorReport(snapshot, { ...config, spotTakerFeeBps: r.spotTakerFeeBps }));
    const { spotTakerFeeBps: _, ...other } = r.report.configuration;
    const { spotTakerFeeBps: __, ...original } = config; assert.deepEqual(other, original);
    assert.equal(r.report.capturedAtUtc, new Date(T).toISOString()); assert.equal(r.actualFeeVerified, false);
    assert.equal(r.report.activationAllowed, false);
  }
  assert.deepEqual(snapshot, beforeSnapshot); assert.deepEqual(config, beforeConfig);
  assert.equal(JSON.stringify({ snapshot, config }), sourceBefore);
});

test("zero spot fee retains futures fees, spread, slippage, capital hurdle, collateral and loss reserves", () => {
  const zero = evaluateCarryFeeFrontier(fixture(), loadCarryResearchConfig().config)[0]!;
  const row = zero.report.rows.find(r => r.product === "PF_ETHUSD" && r.budgetId === "1000-usd-sensitivity")!;
  assert.equal(row.economics.status, "FEASIBLE");
  assert.ok(row.economics.requiredCashUsd > 0); assert.ok(row.economics.requiredCollateralUsd > 0);
  assert.equal(row.economics.reservedCapitalUsd, row.economics.requiredCashUsd + row.economics.requiredCollateralUsd);
  const s = row.economics.scenarios.find(s => s.name === "PERPETUAL_ZERO_FUNDING")!;
  assert.equal(s.fees.spotEntryUsd, 0); assert.equal(s.fees.spotExitUsd, 0);
  assert.ok(s.fees.derivativeEntryUsd > 0); assert.ok(s.fees.derivativeExitUsd > 0);
  assert.ok(s.executionSpreadCostUsd > 0); assert.ok(s.slippageCostUsd > 0); assert.ok(s.capitalHurdleCostUsd > 0);
  assert.ok(s.settlementBasisReserveUsd > 0); assert.ok(s.unwindReserveUsd > 0);
  assert.equal(s.fundingIncomeUsd, 0); assert.ok(s.netAfterCostsUsd < 0);
});

test("counts distinguish infeasible product budgets from positive and negative individual declared paths", () => {
  for (const r of evaluateCarryFeeFrontier(fixture(), loadCarryResearchConfig().config)) {
    const counts = r.summary.counts;
    assert.equal(counts.productBudgetRows, 6); assert.equal(counts.infeasibleRows, 1);
    assert.equal(counts.individuallyFeasibleRows, 5);
    assert.equal(counts.declaredPaths, counts.positiveNetPaths + counts.negativeNetPaths + counts.zeroNetPaths);
    const btcSmall = r.summary.byAssetAndBudget.find(x => x.base === "BTC" && x.budgetId === "prior-12-usd-research")!;
    assert.equal(btcSmall.allProducts.infeasibleRows, 1); assert.equal(btcSmall.allProducts.declaredPaths, 0);
    assert.ok(r.summary.byAssetAndBudget.some(x => x.datedPolicyEligibleProducts.individuallyFeasibleRows > 0));
    assert.equal(r.summary.products.filter(p => p.status === "FEASIBLE").every(p => p.allocatedBaseQty > 0), true);
  }
});

async function savedFixture() {
  const directory = await mkdtemp(join(tmpdir(), "carry-fee-frontier-"));
  const inputPath = join(directory, "input.json.gz"), configPath = join(directory, "config.json");
  await writeFile(inputPath, gzipSync(JSON.stringify(fixture())));
  await writeFile(configPath, JSON.stringify(loadCarryResearchConfig().config));
  return { directory, inputPath, configPath, outputDirectory: join(directory, "report") };
}

test("CLI seals hashes before evaluation, preserves snapshot date and refuses to overwrite its artifacts", async () => {
  const options = await savedFixture();
  const originalSources = await Promise.all(["src/carry/monitor.ts", "src/carry/economics.ts", "src/carry/config.ts"].map(async path => [path, sha(await readFile(path))]));
  const originalInput = sha(await readFile(options.inputPath));
  const result = await runCarryFeeFrontier(options);
  assert.equal(result.capturedAtUtc, new Date(T).toISOString()); assert.equal(result.actualFeeVerified, false);
  const protocolRaw = await readFile(join(options.outputDirectory, "protocol.json"));
  const protocol = JSON.parse(protocolRaw.toString()), reportRaw = await readFile(join(options.outputDirectory, "frontier.json"));
  const report = JSON.parse(reportRaw.toString()), integrity = JSON.parse(await readFile(join(options.outputDirectory, "integrity.json"), "utf8"));
  assert.equal(protocol.outcomesCalculated, false); assert.deepEqual(protocol.spec, CARRY_FEE_FRONTIER_SPEC);
  assert.equal(protocol.sealedInputs.compressedInputSha256, originalInput);
  assert.equal(report.protocolSha256, sha(protocolRaw)); assert.equal(integrity.reportSha256, sha(reportRaw));
  assert.equal(report.sourceAndInputHashesUnchanged, true); assert.equal(report.historicalSnapshotOnly, true);
  assert.equal(report.futuresTakerFeeBpsPerExecutedSide, 5);
  for (const [path, digest] of originalSources) assert.equal(sha(await readFile(path!)), digest);
  for (const [name, digest] of Object.entries(report.artifacts)) assert.equal(sha(await readFile(join(options.outputDirectory, name))), digest);
  await assert.rejects(runCarryFeeFrontier(options), /EEXIST/);
  assert.equal(sha(await readFile(join(options.outputDirectory, "frontier.json"))), sha(reportRaw));
});

test("an invalid market payload leaves a sealed protocol and no completed economic report", async () => {
  const options = await savedFixture(), snapshot = fixture();
  snapshot.responses.instruments!.payload = { result: "error" };
  await writeFile(options.inputPath, gzipSync(JSON.stringify(snapshot)));
  await assert.rejects(runCarryFeeFrontier(options), /FUTURES_API_ERROR/);
  const protocol = JSON.parse(await readFile(join(options.outputDirectory, "protocol.json"), "utf8"));
  assert.equal(protocol.outcomesCalculated, false);
  await assert.rejects(access(join(options.outputDirectory, "frontier.json")));
});
