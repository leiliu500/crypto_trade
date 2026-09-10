import assert from "node:assert/strict";
import test from "node:test";
import { portfolioEvidenceGates, type PortfolioEvidence } from "../src/portfolio/protocol.js";

const evidence = (): PortfolioEvidence => ({ known: true, netPnlUsd: 2, maximumDrawdownUsd: 1,
  maximumOneDayLossUsd: .5, exposureHours: 3000, targetCoverageFraction: 1,
  perAsset: { "BTC/USD": { netPnlUsd: 1, exposureHours: 1800 }, "ETH/USD": { netPnlUsd: 1, exposureHours: 1800 } } });
const reference = () => ({ ...evidence(), netPnlUsd: .5 });
test("persistent portfolio gates use exposure and costs, not a minimum round-trip count", () => {
  assert.ok(Object.values(portfolioEvidenceGates(evidence(), reference())).every(Boolean));
});
test("unknown funding cannot pass profitability as a zero or known partial return", () => {
  const c = { ...evidence(), known: false, netPnlUsd: null };
  const g = portfolioEvidenceGates(c, reference());
  assert.equal(g.completeAccounting, false);
  assert.equal(g.positiveNetBothAssetsAndPortfolio, false);
  assert.equal(g.utilityAboveFlatAndSimpleRule, false);
});
test("one profitable asset cannot conceal the other asset's losses", () => {
  const c = evidence(); c.perAsset["ETH/USD"].netPnlUsd = -.1;
  assert.equal(portfolioEvidenceGates(c, reference()).positiveNetBothAssetsAndPortfolio, false);
});
test("higher profit cannot excuse excessive drawdown or baseline underperformance", () => {
  assert.equal(portfolioEvidenceGates({ ...evidence(), maximumDrawdownUsd: 4 }, reference()).riskWithinLimits, false);
  assert.equal(portfolioEvidenceGates(evidence(), { ...reference(), netPnlUsd: 4 }).utilityAboveFlatAndSimpleRule, false);
});
