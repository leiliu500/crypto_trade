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
      schemaVersion: 1, symbol: "BTC/USD", parameters: { RULE_SCORE_ENTER: 0.9, MAXIMUM_NOTIONAL: 250 },
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

  const paper = loadConfig({
    TRADING_MODE: "paper", ALPACA_PAPER: "true", ALPACA_API_KEY: "paper-key", ALPACA_API_SECRET: "paper-secret",
  });
  assert.equal(paper.symbolConfigs["BTC/USD"]?.dynamicLiquidity.absoluteTradeCapBps, 30);
  assert.equal(paper.symbolConfigs["DOGE/USD"]?.dynamicLiquidity.absoluteTradeCapBps, 30);
});
