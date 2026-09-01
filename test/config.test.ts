import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("dashboard defaults are ready for the EC2 container endpoint", () => {
  const cfg = loadConfig({ TRADING_MODE: "replay" });
  assert.equal(cfg.dashboardHost, "0.0.0.0");
  assert.equal(cfg.dashboardPort, 3_001);
});

test("empty custom credential variables fall back to standard Alpaca aliases", () => {
  const cfg = loadConfig({
    TRADING_MODE: "paper",
    ALPACA_PAPER: "true",
    ALPACA_API_KEY: "",
    ALPACA_API_SECRET: "",
    APCA_API_KEY_ID: "paper-key",
    APCA_API_SECRET_KEY: "paper-secret",
  });
  assert.deepEqual(cfg.credentials, { keyId: "paper-key", secretKey: "paper-secret" });
});

test("JSON baseline wins over legacy tunable environment values and symbol overlays stay isolated", () => {
  const directory = mkdtempSync(join(tmpdir(), "crypto-trade-config-"));
  try {
    writeFileSync(join(directory, "base.json"), readFileSync("config/base.json", "utf8"));
    writeFileSync(join(directory, "btc_usd.json"), JSON.stringify({
      schemaVersion: 1, symbol: "BTC/USD", parameters: {
        RULE_SCORE_ENTER: 0.9, MAXIMUM_NOTIONAL: 250, MICRO_MIN_MOVE_BPS: 0.008,
      },
    }));
    writeFileSync(join(directory, "eth_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "ETH/USD", parameters: {} }));
    writeFileSync(join(directory, "link_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "LINK/USD", parameters: {} }));
    writeFileSync(join(directory, "sol_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "SOL/USD", parameters: {} }));
    writeFileSync(join(directory, "xrp_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "XRP/USD", parameters: {} }));
    writeFileSync(join(directory, "doge_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "DOGE/USD", parameters: {} }));
    writeFileSync(join(directory, "ada_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "ADA/USD", parameters: {} }));
    writeFileSync(join(directory, "ltc_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "LTC/USD", parameters: {} }));
    writeFileSync(join(directory, "avax_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "AVAX/USD", parameters: {} }));
    writeFileSync(join(directory, "hype_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "HYPE/USD", parameters: {} }));
    writeFileSync(join(directory, "pepe_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "PEPE/USD", parameters: {} }));

    const cfg = loadConfig({ TRADING_MODE: "replay", CONFIG_DIR: directory, RULE_SCORE_ENTER: "9" });
    assert.deepEqual(cfg.symbols, ["BTC/USD", "ETH/USD"]);
    assert.equal(cfg.deterministicSignal.scoreEnter, 0.3);
    assert.equal(cfg.symbolConfigs["BTC/USD"]?.deterministicSignal.scoreEnter, 0.9);
    assert.equal(cfg.symbolConfigs["BTC/USD"]?.maximumNotional, 250);
    assert.equal(cfg.symbolConfigs["ETH/USD"]?.deterministicSignal.scoreEnter, 0.3);
    assert.equal(cfg.feature.maximumProviderFutureSkewMs, 250);
    assert.equal(cfg.feature.maximumKinematicsGapMs, 5_000);
    assert.equal(cfg.symbolConfigs["BTC/USD"]?.feature.maximumProviderFutureSkewMs, 250);
    assert.equal(cfg.symbolConfigs["BTC/USD"]?.feature.maximumKinematicsGapMs, 5_000);
    assert.equal(cfg.deterministicSignal.microTrigger.minimumMicroMoveBps, 0.01);
    assert.equal(cfg.deterministicSignal.microTrigger.candidateRetryMs, 250);
    assert.equal(cfg.forecast.intendedHoldMs, 1_800_000);
    assert.equal(cfg.deterministicSignal.analyticEdge.economicHorizonMs, cfg.forecast.intendedHoldMs);
    assert.equal(cfg.position.maximumHoldMs, 14_400_000);
    assert.deepEqual(cfg.deterministicSignal.analyticHorizons.map((item) => item.horizonMs),
      [3_600_000, 7_200_000, 14_400_000]);
    assert.equal(cfg.deterministicSignal.requireMakerEntry, true);
    assert.equal(cfg.deterministicSignal.allowTakerContinuation, true);
    assert.equal(cfg.configurationVersion, "btc-eth-evidence-routing-v8.0.0");
    assert.equal(cfg.position.minimumHoldMs, 60_000);
    assert.equal(cfg.position.unproductiveExitMs, 900_000);
    assert.equal(cfg.position.reentryCooldownMs, 900_000);
    assert.equal(cfg.position.evidenceConfirmationMs, 5_000);
    assert.equal(cfg.position.profitActivationCostMultiple, 2.5);
    assert.equal(cfg.deterministicSignal.microTrigger.cooldownMs, 60_000);
    assert.equal(cfg.planner.pullbackMakerTtlMs, 20_000);
    assert.equal(cfg.planner.pullbackKinematicsGraceMs, 5_000);
    assert.equal(cfg.planner.pullbackKinematicsGraceEvents, 2);
    assert.equal(cfg.planner.pullbackSignalInvalidationGraceMs, 5_000);
    assert.equal(cfg.planner.pullbackSignalInvalidationGraceEvents, 3);
    assert.equal(cfg.planner.continuationSignalInvalidationGraceMs, 750);
    assert.equal(cfg.planner.continuationSignalInvalidationGraceEvents, 3);
    assert.equal(cfg.planner.continuationAdverseFlowConfirmationMs, 100);
    assert.equal(cfg.planner.continuationAdverseFlowConfirmationEvents, 2);
    assert.equal(cfg.planner.adverseFlowConfirmationMs, 2_000);
    assert.equal(cfg.planner.adverseFlowConfirmationEvents, 3);
    assert.equal(cfg.planner.adverseOfiThreshold, .3);
    assert.equal(cfg.planner.adverseTfiThreshold, .15);
    assert.equal(cfg.planner.fillHazardIntercept, -3.25);
    assert.equal(cfg.planner.minimumExpectedValueBps, .25);
    assert.equal(cfg.planner.minimumRewardRiskRatio, .2);
    assert.equal(cfg.planner.hybridEntry.continuationTakerEnabled, true);
    assert.equal(cfg.planner.hybridEntry.continuationTakerSizeMultiplier, .25);
    assert.equal(cfg.planner.hybridEntry.continuationTakerMinimumNetEdgeBps, 8);
    assert.equal(cfg.planner.hybridEntry.continuationTakerMinimumLatencySamples, 0);
    assert.equal(cfg.planner.hybridEntry.routeShadowEnabled, true);
    assert.deepEqual(cfg.planner.hybridEntry.routeShadowHorizonsMs,
      [1_000, 5_000, 30_000, 60_000, 300_000, 3_600_000, 7_200_000, 14_400_000]);
    assert.equal(cfg.deterministicSignal.minimumSlowTrendAlignment, 0.1);
    assert.equal(cfg.deterministicSignal.minimumSlowTrendEfficiency, 0.05);
    assert.equal(cfg.deterministicSignal.minimumSlowTrendMoveBps, 7.5);
    assert.equal(cfg.symbolConfigs["BTC/USD"]?.dynamicLiquidity.tradeQuantile, 0.65);
    assert.equal(cfg.deterministicExtension.trendSlowWindowMs, 3_600_000);
    assert.equal(cfg.deterministicExtension.pullbackWindowMs, 14_400_000);
    assert.equal(cfg.deterministicExtension.pullbackSampleIntervalMs, 30_000);
    assert.equal(cfg.deterministicSignal.pullbackRecovery.minimumPullbackDepthBps, 45);
    assert.equal(cfg.deterministicSignal.continuationQuality.volatilityTargetBps, 75);
    assert.equal(cfg.recall.opportunityHorizonMs, cfg.position.maximumHoldMs);
    assert.equal(cfg.symbolConfigs["BTC/USD"]?.deterministicSignal.microTrigger.minimumMicroMoveBps, 0.008);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("continuation taker activation remains fail-closed in live mode", () => {
  const cfg = loadConfig({
    TRADING_MODE: "live", ALPACA_PAPER: "false", ALPACA_API_KEY: "key", ALPACA_API_SECRET: "secret",
    ALLOW_LIVE_TRADING: "true", LIVE_TRADING_CONFIRMATION: "I_UNDERSTAND_LIVE_ORDERS_USE_REAL_MONEY",
    CRYPTO_SHORT_OPTIONS_ENABLED: "false", CONTINUATION_TAKER_ENABLED: "true",
  });
  assert.equal(cfg.planner.hybridEntry.continuationTakerEnabled, false);
  assert.equal(cfg.planner.hybridEntry.continuationTakerMinimumLatencySamples, 20);
  assert.equal(cfg.planner.hybridEntry.routeShadowEnabled, true);
});

test("route shadow must cover every configured economic horizon", () => {
  const directory = mkdtempSync(join(tmpdir(), "crypto-trade-config-"));
  try {
    const base = JSON.parse(readFileSync("config/base.json", "utf8")) as { parameters: Record<string, unknown> };
    base.parameters.ENTRY_ROUTE_SHADOW_HORIZONS_MS = "1000,5000,30000,60000,300000";
    writeFileSync(join(directory, "base.json"), JSON.stringify(base));
    for (const stem of ["btc_usd", "eth_usd", "link_usd", "sol_usd", "xrp_usd", "doge_usd",
      "ada_usd", "ltc_usd", "avax_usd", "hype_usd", "pepe_usd"]) {
      writeFileSync(join(directory, `${stem}.json`), readFileSync(`config/${stem}.json`, "utf8"));
    }
    assert.throws(() => loadConfig({ TRADING_MODE: "replay", CONFIG_DIR: directory }),
      /must include every economic horizon; missing 3600000,7200000,14400000/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("legacy calibrated buckets are scoped to continuation and cannot authorize pullback entries", () => {
  const bucket = {
    symbol: "BTC/USD", side: 1, regime: "TREND_UP", minimumQuality: 0, maximumQuality: 1,
    minimumSpreadBps: 0, maximumSpreadBps: 10, horizonMs: 3_600_000, path: "MAKER_TAKER",
    meanGrossReturnBps: 20, lowerConfidenceGrossReturnBps: 10, effectiveSampleCount: 100,
  };
  const directory = mkdtempSync(join(tmpdir(), "crypto-trade-config-"));
  try {
    const base = JSON.parse(readFileSync("config/base.json", "utf8")) as { parameters: Record<string, unknown> };
    base.parameters.RULE_CALIBRATED_EDGE_TABLE_JSON = JSON.stringify([bucket]);
    writeFileSync(join(directory, "base.json"), JSON.stringify(base));
    for (const stem of ["btc_usd", "eth_usd", "link_usd", "sol_usd", "xrp_usd", "doge_usd",
      "ada_usd", "ltc_usd", "avax_usd", "hype_usd", "pepe_usd"]) {
      writeFileSync(join(directory, `${stem}.json`), readFileSync(`config/${stem}.json`, "utf8"));
    }
    const cfg = loadConfig({ TRADING_MODE: "replay", CONFIG_DIR: directory });
    assert.equal(cfg.deterministicSignal.calibratedEdges[0]?.family, "CONTINUATION");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("symbol files cannot override global or runtime-only parameters", () => {
  const directory = mkdtempSync(join(tmpdir(), "crypto-trade-config-"));
  try {
    writeFileSync(join(directory, "base.json"), readFileSync("config/base.json", "utf8"));
    writeFileSync(join(directory, "btc_usd.json"), JSON.stringify({
      schemaVersion: 1, symbol: "BTC/USD", parameters: { DASHBOARD_PORT: 9999 },
    }));
    writeFileSync(join(directory, "eth_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "ETH/USD", parameters: {} }));
    writeFileSync(join(directory, "link_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "LINK/USD", parameters: {} }));
    writeFileSync(join(directory, "sol_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "SOL/USD", parameters: {} }));
    writeFileSync(join(directory, "xrp_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "XRP/USD", parameters: {} }));
    writeFileSync(join(directory, "doge_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "DOGE/USD", parameters: {} }));
    writeFileSync(join(directory, "ada_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "ADA/USD", parameters: {} }));
    writeFileSync(join(directory, "ltc_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "LTC/USD", parameters: {} }));
    writeFileSync(join(directory, "avax_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "AVAX/USD", parameters: {} }));
    writeFileSync(join(directory, "hype_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "HYPE/USD", parameters: {} }));
    writeFileSync(join(directory, "pepe_usd.json"), JSON.stringify({ schemaVersion: 1, symbol: "PEPE/USD", parameters: {} }));
    assert.throws(() => loadConfig({ TRADING_MODE: "replay", CONFIG_DIR: directory }), /DASHBOARD_PORT is global/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("per-symbol spread caps are restricted to active symbols and paper safety limits", () => {
  const replay = loadConfig({ TRADING_MODE: "replay" });
  assert.equal(replay.symbolConfigs["BTC/USD"]?.dynamicLiquidity.absoluteTradeCapBps, 25);
  assert.equal(replay.symbolConfigs["ETH/USD"]?.dynamicLiquidity.absoluteTradeCapBps, 25);
  assert.equal(replay.symbolConfigs["BTC/USD"]?.deterministicSignal.microTrigger.minimumMicroMoveBps, 0.008);
  assert.equal(replay.symbolConfigs["DOGE/USD"], undefined);
  assert.equal(replay.symbolConfigs["LINK/USD"], undefined);

  const paper = loadConfig({
    TRADING_MODE: "paper", ALPACA_PAPER: "true", ALPACA_API_KEY: "paper-key", ALPACA_API_SECRET: "paper-secret",
  });
  assert.equal(paper.symbolConfigs["BTC/USD"]?.dynamicLiquidity.absoluteTradeCapBps, 30);
  assert.equal(paper.symbolConfigs["ETH/USD"]?.dynamicLiquidity.absoluteTradeCapBps, 30);
});

test("paper entry exercise is isolated, capped, labeled, and rejected outside paper", () => {
  const paper = loadConfig({
    TRADING_MODE: "paper", ALPACA_PAPER: "true", ALPACA_API_KEY: "paper-key", ALPACA_API_SECRET: "paper-secret",
    PAPER_ENTRY_EXERCISE: "true",
  });
  assert.equal(paper.paperEntryExercise, true);
  assert.match(paper.configurationVersion, /paper-entry-exercise$/);
  assert.equal(paper.maximumNotional, 25);
  assert.equal(paper.cost.makerFeeBps, 0);
  assert.equal(paper.cost.takerFeeBps, 0);
  assert.equal(paper.cost.latencyAdverseFraction, 0);
  assert.equal(paper.cost.adverseSelectionBps, 0);
  assert.equal(paper.deterministicSignal.costSafetyFactor, 1);
  assert.equal(paper.deterministicSignal.minimumNetEdgeBps, 0);
  assert.equal(paper.deterministicSignal.minimumMakerFillProbability, 1);
  assert.equal(paper.planner.takerLimitBufferBps, 5);
  assert.equal(paper.planner.minimumExpectedValueBps, 0);
  assert.equal(paper.planner.minimumRewardRiskRatio, 0);
  assert.equal(paper.deterministicSignal.positiveCostErrorP95Bps, 0);
  assert.ok(paper.deterministicSignal.analyticHorizons.every((horizon) => horizon.sigmaCaptureFraction === 1
    && horizon.breakoutWeight === 1 && horizon.baseUncertaintyBps === 0 && horizon.sigmaUncertaintyFraction === 0));
  assert.equal(paper.deterministicSignal.analyticEdge.spreadUncertaintyWeight, 0);
  assert.equal(paper.deterministicSignal.analyticEdge.flipUncertaintyWeight, 0);
  assert.throws(() => loadConfig({ TRADING_MODE: "replay", PAPER_ENTRY_EXERCISE: "true" }), /restricted to the Alpaca paper endpoint/);
});
