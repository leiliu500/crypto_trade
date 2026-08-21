import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

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

    const cfg = loadConfig({ TRADING_MODE: "replay", CONFIG_DIR: directory, RULE_SCORE_ENTER: "9" });
    assert.equal(cfg.deterministicSignal.scoreEnter, 0.3);
    assert.equal(cfg.symbolConfigs["BTC/USD"]?.deterministicSignal.scoreEnter, 0.9);
    assert.equal(cfg.symbolConfigs["BTC/USD"]?.maximumNotional, 250);
    assert.equal(cfg.symbolConfigs["ETH/USD"]?.deterministicSignal.scoreEnter, 0.3);
    assert.equal(cfg.symbolConfigs["LINK/USD"]?.deterministicSignal.scoreEnter, 0.3);
    assert.equal(cfg.symbolConfigs["SOL/USD"]?.deterministicSignal.scoreEnter, 0.3);
    assert.equal(cfg.symbolConfigs["XRP/USD"]?.deterministicSignal.scoreEnter, 0.3);
    assert.equal(cfg.symbolConfigs["DOGE/USD"]?.deterministicSignal.scoreEnter, 0.3);
    assert.equal(cfg.feature.maximumProviderFutureSkewMs, 250);
    assert.equal(cfg.feature.maximumKinematicsGapMs, 5_000);
    assert.equal(cfg.symbolConfigs["BTC/USD"]?.feature.maximumProviderFutureSkewMs, 250);
    assert.equal(cfg.symbolConfigs["BTC/USD"]?.feature.maximumKinematicsGapMs, 5_000);
    assert.equal(cfg.deterministicSignal.microTrigger.minimumMicroMoveBps, 0.01);
    assert.equal(cfg.deterministicSignal.microTrigger.candidateRetryMs, 250);
    assert.equal(cfg.forecast.intendedHoldMs, 1_800_000);
    assert.equal(cfg.deterministicSignal.analyticEdge.economicHorizonMs, cfg.forecast.intendedHoldMs);
    assert.equal(cfg.position.maximumHoldMs, 3_600_000);
    assert.deepEqual(cfg.deterministicSignal.analyticHorizons.map((item) => item.horizonMs), [300_000, 900_000, 1_800_000, 3_600_000]);
    assert.equal(cfg.recall.opportunityHorizonMs, cfg.forecast.intendedHoldMs);
    assert.equal(cfg.symbolConfigs["BTC/USD"]?.deterministicSignal.microTrigger.minimumMicroMoveBps, 0.008);
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
    assert.throws(() => loadConfig({ TRADING_MODE: "replay", CONFIG_DIR: directory }), /DASHBOARD_PORT is global/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("wide per-symbol spread caps are restricted to shadow and replay verification", () => {
  const replay = loadConfig({ TRADING_MODE: "replay" });
  assert.equal(replay.symbolConfigs["BTC/USD"]?.dynamicLiquidity.absoluteTradeCapBps, 25);
  assert.equal(replay.symbolConfigs["DOGE/USD"]?.dynamicLiquidity.absoluteTradeCapBps, 60);
  assert.equal(replay.symbolConfigs["BTC/USD"]?.deterministicSignal.microTrigger.minimumMicroMoveBps, 0.008);
  assert.equal(replay.symbolConfigs["LINK/USD"]?.deterministicSignal.microTrigger.maximumChaseBps, 3);
  assert.equal(replay.symbolConfigs["DOGE/USD"]?.deterministicSignal.microTrigger.noiseMovementMultiplier, 0.4);

  const paper = loadConfig({
    TRADING_MODE: "paper", ALPACA_PAPER: "true", ALPACA_API_KEY: "paper-key", ALPACA_API_SECRET: "paper-secret",
  });
  assert.equal(paper.symbolConfigs["BTC/USD"]?.dynamicLiquidity.absoluteTradeCapBps, 30);
  assert.equal(paper.symbolConfigs["DOGE/USD"]?.dynamicLiquidity.absoluteTradeCapBps, 30);
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
  assert.equal(paper.deterministicSignal.positiveCostErrorP95Bps, 0);
  assert.ok(paper.deterministicSignal.analyticHorizons.every((horizon) => horizon.sigmaCaptureFraction === 1
    && horizon.breakoutWeight === 1 && horizon.baseUncertaintyBps === 0 && horizon.sigmaUncertaintyFraction === 0));
  assert.equal(paper.deterministicSignal.analyticEdge.spreadUncertaintyWeight, 0);
  assert.equal(paper.deterministicSignal.analyticEdge.flipUncertaintyWeight, 0);
  assert.throws(() => loadConfig({ TRADING_MODE: "replay", PAPER_ENTRY_EXERCISE: "true" }), /restricted to the Alpaca paper endpoint/);
});
