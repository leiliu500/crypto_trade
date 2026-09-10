import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { configurationAudit } from "../src/config/audit.js";

function withConfig(patch: Record<string, unknown>, run: (directory: string) => void,
  symbolPatch: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "operational-config-"));
  try {
    const base = JSON.parse(readFileSync("config/base.json", "utf8"));
    Object.assign(base.parameters, patch);
    writeFileSync(join(directory, "base.json"), JSON.stringify(base));
    for (const symbol of base.symbols as string[]) {
      const stem = symbol.toLowerCase().replace("/", "_");
      const overlay = JSON.parse(readFileSync(`config/${stem}.json`, "utf8"));
      if (symbol === "BTC/USD") Object.assign(overlay.parameters, symbolPatch);
      writeFileSync(join(directory, `${stem}.json`), JSON.stringify(overlay));
    }
    run(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test("risk parameters reach portfolio and per-symbol sizing with the same loss budget", () => {
  withConfig({ BASE_RISK_FRACTION: .002, ROLLING_LOSS_FRACTION: .01, SESSION_LOSS_FRACTION: .015,
    MAXIMUM_DRAWDOWN_FRACTION: .04, MAXIMUM_CLUSTER_POSITIONS: 2, MAXIMUM_BOOK_PARTICIPATION: .02,
    FRACTIONAL_KELLY: .15, MAXIMUM_KELLY_FRACTION: .03, TARGET_SIGMA_H_BPS: 30, MINIMUM_QUALITY_SCALE: .2 }, directory => {
    const cfg = loadConfig({ CONFIG_DIR: directory });
    assert.equal(cfg.portfolio.rollingLossBudgetFraction, cfg.rollingLossFraction);
    assert.equal(cfg.sessionLossFraction, .015);
    assert.equal(cfg.portfolio.maximumClusterPositions, 2);
    assert.deepEqual(cfg.symbolConfigs["ETH/USD"]!.sizing, { baseRiskFraction: .002,
      maximumDrawdown: .04, maximumBookParticipation: .02, fractionalKelly: .15,
      maximumKellyFraction: .03, targetSigmaHBps: 30, minimumQualityScale: .2 });
  });
});

test("conflicting or ineffective operational limits are rejected", () => {
  for (const [patch, reason] of [
    [{ DATABASE_ENABLED: false, DATABASE_REQUIRED: true }, /DATABASE_REQUIRED_REQUIRES/],
    [{ DATABASE_FLUSH_INTERVAL_MS: 5_000, DATABASE_MAXIMUM_WRITE_LAG_MS: 5_000 }, /DATABASE_FLUSH_INTERVAL_MUST_BE_BELOW/],
    [{ BASE_RISK_FRACTION: .02 }, /RISK_LIMITS_REQUIRE/],
    [{ ROLLING_LOSS_FRACTION: .1 }, /RISK_LIMITS_REQUIRE/],
    [{ MAXIMUM_NOTIONAL: 6_000 }, /SYMBOL_NOTIONAL_EXCEEDS/],
    [{ MAXIMUM_GROSS_NOTIONAL: 0 }, /positive configuration/],
    [{ MAXIMUM_BOOK_PARTICIPATION: 1.01 }, /fractional configuration/],
    [{ MAXIMUM_DRAWDOWN_FRACTION: 0 }, /positive configuration/],
    [{ MAXIMUM_CLUSTER_POSITIONS: 3 }, /integer configuration/],
  ] as const) withConfig(patch, directory => assert.throws(() => loadConfig({ CONFIG_DIR: directory }), reason));
});

test("global risk thresholds cannot be silently overridden in a symbol file", () => {
  for (const key of ["MAXIMUM_DRAWDOWN_FRACTION", "ROLLING_LOSS_FRACTION", "SESSION_LOSS_FRACTION", "MAXIMUM_CLUSTER_POSITIONS"])
    withConfig({}, directory => assert.throws(() => loadConfig({ CONFIG_DIR: directory }), /global and cannot/), { [key]: .02 });
});

test("malformed booleans, blank numbers and invalid fee units fail configuration loading", () => {
  assert.throws(() => loadConfig({ DISTRIBUTIONAL_PAPER_ENTRIES_ENABLED: "tru" }), /Invalid boolean/);
  assert.throws(() => loadConfig({ PAPER_ENTRY_EXERCISE: "1" }), /Invalid boolean/);
  assert.throws(() => loadConfig({ KRAKEN_FUTURES_TAKER_FEE_BPS: " " }), /Invalid numeric/);
  assert.throws(() => loadConfig({ KRAKEN_FUTURES_TAKER_FEE_BPS: "10000" }), /basis-point/);
  assert.equal(loadConfig({ MODEL_ONLY_ENTRIES: "FALSE" }).modelOnlyEntries, false);
});

test("effective audit is deterministic, cost-sensitive and excludes secrets and connection URLs", () => {
  const a = configurationAudit(loadConfig({ DATABASE_URL: "postgres://user:DO_NOT_LOG@host/db" }));
  const b = configurationAudit(loadConfig({ DATABASE_URL: "postgres://other:SECRET@elsewhere/db", UNRELATED_SECRET: "TOKEN" }));
  assert.equal(a.configurationSha256, b.configurationSha256);
  assert.doesNotMatch(JSON.stringify(a), /DO_NOT_LOG|postgres:\/\//);
  assert.notEqual(a.configurationSha256, configurationAudit(loadConfig({ KRAKEN_FUTURES_TAKER_FEE_BPS: "6" })).configurationSha256);
  assert.equal(a.settings.persistence.requiredForEntries, true);
  assert.equal(a.settings.costs.accountFeeTierVerified, false);
  assert.equal(a.settings.distribution.effectiveOrderCapsUsd["BTC/USD"], 1000);
});

test("audit distinguishes an unvalidated paper experiment from prospective validation", () => {
  const cfg = loadConfig({ TRADING_MODE: "paper", DISTRIBUTIONAL_ENGINE_ENABLED: "true",
    DISTRIBUTIONAL_PAPER_ENTRIES_ENABLED: "true", DISTRIBUTIONAL_PAPER_TRIAL_ENABLED: "true",
    DISTRIBUTIONAL_EFFICIENT_TRAINING_ENABLED: "true" });
  const audit = configurationAudit(cfg);
  assert.equal(audit.settings.distribution.entryProfile.requiresProspectiveValidation, false);
  assert.equal(audit.settings.realOrdersSupported, false);
  assert.equal(audit.settings.distribution.evaluationIntervalMs, 1_000);
});
