import assert from "node:assert/strict";
import test from "node:test";
import { CANDIDATES, PORTFOLIO_SCENARIOS, riskEvidenceGates, riskUtility, selectRiskPolicy,
  type PolicyScenarioEvidence, type RiskEvidence } from "../src/portfolio-v2/protocol.js";

function evidence(net = 3): RiskEvidence {
  return { known: true, netPnlUsd: net, maximumDrawdownUsd: 1, maximumLiquidationDrawdownUsd: 1.1,
    maximumOneDayLossUsd: .3, maximumObservedDailyLiquidationLossUsd: .35, exposureHours: 4000, targetCoverageFraction: 1,
    perAsset: { "BTC/USD": { netPnlUsd: net / 2, exposureHours: 2000 },
      "ETH/USD": { netPnlUsd: net / 2, exposureHours: 2000 } } };
}
function rows(): PolicyScenarioEvidence[] {
  return CANDIDATES.flatMap(policy => PORTFOLIO_SCENARIOS.map(s => ({ policy, scenario: s.id, evidence: evidence() })));
}
test("the simple rule can win without claiming complex model superiority", () => {
  const r = selectRiskPolicy(rows());
  assert.equal(r.selected, "sign-trend-90d"); assert.equal(r.incrementalAlphaClaim, false);
  assert.match(r.selectionMeaning, /NO_COMPLEX_MODEL_SUPERIORITY/);
  assert.equal(r.evaluations.find(e => e.policy === "multiscale-trend")!.eligible, false);
});
test("a complex policy must beat the same-governor simple rule in every scenario", () => {
  const r = rows(); for (const item of r) if (item.policy === "multiscale-trend") item.evidence = evidence(4);
  assert.equal(selectRiskPolicy(r).selected, "multiscale-trend");
  r.find(e => e.policy === "multiscale-trend")!.evidence = evidence(2.9);
  assert.equal(selectRiskPolicy(r).selected, "sign-trend-90d");
});
test("risk limits include liquidation costs and no failed policy is selected", () => {
  const r = rows(); for (const item of r) item.evidence.maximumLiquidationDrawdownUsd = 3.01;
  assert.equal(selectRiskPolicy(r).selected, null);
  const e = evidence(); e.maximumOneDayLossUsd = 1.21; assert.equal(riskEvidenceGates(e).riskWithinLimits, false);
  e.maximumOneDayLossUsd = .2; e.maximumDrawdownUsd = 3.01; assert.equal(riskEvidenceGates(e).riskWithinLimits, false);
  e.maximumDrawdownUsd = 1; e.maximumObservedDailyLiquidationLossUsd = 1.21;
  assert.equal(riskEvidenceGates(e).riskWithinLimits, false);
});
test("missing funding, negative ETH profit, and inadequate exposure cannot qualify", () => {
  const unknown = evidence(); unknown.known = false;
  assert.equal(riskUtility(unknown), null); assert.equal(riskEvidenceGates(unknown).completeAccounting, false);
  const loss = evidence(); loss.perAsset["ETH/USD"].netPnlUsd = -.01;
  assert.equal(riskEvidenceGates(loss).positiveNetBothAssetsAndPortfolio, false);
  loss.perAsset["ETH/USD"].exposureHours = 719;
  assert.equal(riskEvidenceGates(loss).meaningfulExposure, false);
});
test("incomplete and duplicate candidate scenario evidence is rejected", () => {
  assert.throws(() => selectRiskPolicy(rows().slice(1)), /EXACT_SCENARIO_SET/);
  const r = rows(); r.push(r[0]!); assert.throws(() => selectRiskPolicy(r), /EXACT_SCENARIO_SET/);
});
