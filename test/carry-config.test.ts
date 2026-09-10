import assert from "node:assert/strict";
import test from "node:test";
import { loadCarryResearchConfig, validateCarryResearchConfig } from "../src/carry/config.js";

test("carry research config explicitly reserves both cash legs and cannot activate trading", () => {
  const { config, configurationSha256 } = loadCarryResearchConfig();
  assert.equal(config.mode, "MONITOR_ONLY");
  assert.equal(config.derivativeReserveFraction, 1);
  assert.equal(config.spotTakerFeeBps, 80);
  assert.equal(config.derivativeTakerFeeBps, 5);
  assert.match(configurationSha256, /^[a-f0-9]{64}$/);
  for (const patch of [{ mode: "LIVE" }, { accountFeesVerified: true }, { derivativeReserveFraction: .1 },
    { maximumQuoteAgeMs: 60_000 }, { minimumDatedMaturityDays: 100, maximumDatedMaturityDays: 30 },
    { budgets: [{ id: "broken", availableGrossUsd: 1000, availableCashUsd: 0, availableCollateralUsd: 1 }] },
    { maximumQuoteAgeMs: NaN }, { spotTakerFeeBps: "80" }])
    assert.throws(() => validateCarryResearchConfig({ ...config, ...patch }));
});
