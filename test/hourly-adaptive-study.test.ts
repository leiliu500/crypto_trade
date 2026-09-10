import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ADAPTIVE_STUDY_PROTOCOL, runAdaptiveStudy } from "../src/research/hourly-adaptive-study-main.js";
import { ADAPTIVE_SELECTION_RULE, adaptiveAssetEligible, adaptivePortfolioGates, adaptiveUtility,
  type AdaptiveAccountSummary, type AdaptiveScenarioSummary } from "../src/research/hourly-adaptive-study-gates.js";

function account(): AdaptiveAccountSummary {
  return { netPnlUsd: 4, maximumDrawdownUsd: 3, maximumOneDayLossUsd: 1, completed: 100,
    activeUtcDates: 40, unknownTrades: 0, perAsset: [
      { symbol: "BTC/USD", completed: 50, netPnlUsd: 2, unknownTrades: 0 },
      { symbol: "ETH/USD", completed: 50, netPnlUsd: 2, unknownTrades: 0 },
    ] };
}
const pair = (): AdaptiveScenarioSummary => ({ base: account(), stress: account() });
const baseline = (): AdaptiveScenarioSummary => {
  const value = pair(); value.base.netPnlUsd = 3; value.stress.netPnlUsd = 3; return value;
};
const passed = (value: ReturnType<typeof adaptivePortfolioGates>) => Object.values(value).every(Boolean);

test("baseline utility remains arithmetic above candidate risk limits", () => {
  const value = { ...account(), netPnlUsd: 30, maximumDrawdownUsd: 20, maximumOneDayLossUsd: 15 };
  assert.equal(adaptiveUtility(value), 20);
  assert.equal(adaptiveAssetEligible({ base: value, stress: value }, "BTC/USD"), false);
  for (const invalid of [{ netPnlUsd: null }, { netPnlUsd: NaN }, { maximumDrawdownUsd: null },
    { maximumDrawdownUsd: Infinity }, { unknownTrades: 1 }])
    assert.equal(adaptiveUtility({ ...account(), ...invalid }), -Infinity);
});

test("asset eligibility requires 20 profitable completed trades in each scenario", () => {
  const threshold = pair();
  for (const scenario of ["base", "stress"] as const) threshold[scenario].perAsset[0]!.completed = 20;
  assert.equal(adaptiveAssetEligible(threshold, "BTC/USD"), true);
  for (const scenario of ["base", "stress"] as const) for (const change of [
    { completed: 19 }, { netPnlUsd: 0 }, { netPnlUsd: -.01 }, { netPnlUsd: null }, { unknownTrades: 1 },
  ]) {
    const invalid = structuredClone(threshold); Object.assign(invalid[scenario].perAsset[0]!, change);
    assert.equal(adaptiveAssetEligible(invalid, "BTC/USD"), false);
  }
  assert.equal(adaptiveAssetEligible(threshold, "OTHER/USD"), false);
});

test("asset and portfolio risk gates include the exact dollar boundary and reject unknown accounting", () => {
  const threshold = pair();
  for (const scenario of ["base", "stress"] as const) {
    threshold[scenario].maximumDrawdownUsd = 12; threshold[scenario].maximumOneDayLossUsd = 12;
  }
  assert.ok(adaptiveAssetEligible(threshold, "BTC/USD"));
  assert.ok(passed(adaptivePortfolioGates(threshold, baseline())));
  for (const scenario of ["base", "stress"] as const) for (const change of [
    { maximumDrawdownUsd: 12.00001 }, { maximumOneDayLossUsd: 12.00001 },
    { maximumDrawdownUsd: -1 }, { maximumDrawdownUsd: null }, { maximumOneDayLossUsd: NaN },
    { netPnlUsd: null }, { netPnlUsd: Infinity }, { unknownTrades: 1 },
  ]) {
    const invalid = structuredClone(threshold); Object.assign(invalid[scenario], change);
    assert.equal(adaptiveAssetEligible(invalid, "BTC/USD"), false);
    assert.equal(adaptivePortfolioGates(invalid, baseline()).fullPeriodKnownAndRiskWithinLimits, false);
  }
});

test("portfolio coverage requires 100 trades, 40 entry dates and 20 trades per asset in both scenarios", () => {
  const threshold = pair();
  for (const scenario of ["base", "stress"] as const) {
    threshold[scenario].perAsset[0]!.completed = 20; threshold[scenario].perAsset[1]!.completed = 80;
  }
  assert.ok(passed(adaptivePortfolioGates(threshold, baseline())));
  for (const scenario of ["base", "stress"] as const) for (const mutation of [
    (a: AdaptiveAccountSummary) => { a.completed = 99; },
    (a: AdaptiveAccountSummary) => { a.activeUtcDates = 39; },
    (a: AdaptiveAccountSummary) => { a.perAsset[0]!.completed = 19; },
    (a: AdaptiveAccountSummary) => { a.perAsset[1]!.completed = 19; },
    (a: AdaptiveAccountSummary) => { a.perAsset = a.perAsset.slice(0, 1); },
  ]) {
    const invalid = structuredClone(threshold); mutation(invalid[scenario]);
    assert.equal(adaptivePortfolioGates(invalid, baseline()).sufficientTrades, false);
  }
});

test("aggregate gains cannot conceal an unprofitable or unknown asset", () => {
  for (const scenario of ["base", "stress"] as const) for (const assetIndex of [0, 1]) for (const change of [
    { netPnlUsd: 0 }, { netPnlUsd: -.01 }, { netPnlUsd: null }, { netPnlUsd: NaN }, { unknownTrades: 1 },
  ]) {
    const invalid = pair(); Object.assign(invalid[scenario].perAsset[assetIndex]!, change);
    assert.ok(invalid[scenario].netPnlUsd! > 0);
    assert.equal(adaptivePortfolioGates(invalid, baseline()).positiveBaseAndStressForBothAssets, false);
  }
});

test("the selected nonflat baseline must be beaten strictly in each scenario", () => {
  assert.ok(adaptivePortfolioGates(pair(), baseline()).beatsSelectedBaseline);
  for (const scenario of ["base", "stress"] as const) for (const value of [4, 4.01, null, NaN, Infinity]) {
    const reference = baseline(); reference[scenario].netPnlUsd = value;
    assert.equal(adaptivePortfolioGates(pair(), reference).beatsSelectedBaseline, false);
  }
});

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
// Match the actual evaluation sources, never any financial dataset. This lets
// stage-denial tests reach integrity checks without opening historical returns.
const SOURCES = ["src/research/hourly-data.ts", "src/research/hourly-model.ts", "src/research/hourly-adaptive-model.ts",
  "src/research/hourly-price-setups.ts", "src/research/hourly-retry-simulator.ts", "src/research/hourly-adaptive-study-main.ts",
  "src/research/hourly-adaptive-study-gates.ts", "src/research/hourly-study-statistics.ts",
  "reports/distribution-instrument-rules-2026-09-07.json", "package.json", "package-lock.json"];
async function directory(t: TestContext) {
  const output = await mkdtemp(join(tmpdir(), "adaptive-study-gates-"));
  t.after(() => rm(output, { recursive: true, force: true })); return output;
}
async function receipt(output: string, stage: "develop" | "confirm", summary: "selection.json" | "confirmation.json") {
  await writeJson(join(output, `${stage}-start.json`), {});
  await writeJson(join(output, `${stage}-portfolio.json`), {});
  const names = [summary, `${stage}-start.json`, `${stage}-portfolio.json`];
  const artifacts = Object.fromEntries(await Promise.all(names.map(async name => [name, digest(await readFile(join(output, name)))])));
  await writeJson(join(output, `${stage}-integrity.json`), { stage, completedAtUtc: "2000-01-01T00:00:00.000Z", artifacts });
}
async function selectionFixture(output: string) {
  await writeJson(join(output, "protocol.json"), { definition: ADAPTIVE_STUDY_PROTOCOL });
  const sourceHashes = Object.fromEntries(await Promise.all(SOURCES.map(async path => [path, digest(await readFile(path))])));
  const seal = { sourceHashes, protocolSha256: digest(await readFile(join(output, "protocol.json"))), dataSeal: {} };
  await writeJson(join(output, "selection.json"), { ...seal, developmentGatePassed: true,
    selectedByAsset: { "BTC/USD": "adaptive-trend-4h", "ETH/USD": "channel-breakout-24h" }, selectedBaseline: "fixed-trend-168h-held-24h" });
  await receipt(output, "develop", "selection.json"); return seal;
}
const runMissing = (stage: "develop" | "confirm" | "test", output: string) => runAdaptiveStudy(stage,
  join(output, "UNOPENED_MISSING_OLDER_DATA"), join(output, "UNOPENED_MISSING_RECENT_DATA"), output);
const noMarker = (output: string, stage: "develop" | "confirm" | "test") =>
  assert.rejects(readFile(join(output, `${stage}-start.json`)), { code: "ENOENT" });

test("registration records the fixed six-candidate protocol without reading any data", async t => {
  const output = await directory(t);
  const result = await runAdaptiveStudy("register", "MISSING_OLDER_DATA", "MISSING_RECENT_DATA", output);
  assert.equal(result.status, "PROTOCOL_REGISTERED_NO_RETURNS_EVALUATED");
  assert.deepEqual(await readdir(output), ["protocol.json"]);
  const saved = JSON.parse(await readFile(join(output, "protocol.json"), "utf8"));
  assert.equal(saved.definition.candidates.length, 6);
  assert.equal(saved.definition.trainingDecisionPurgeHours, 26);
  assert.equal(saved.definition.periods.test.endMs, Date.UTC(2026, 7, 1));
  assert.equal(saved.definition.selection.finalConfidence, ADAPTIVE_SELECTION_RULE.finalConfidence);
  assert.equal(saved.definition.realOrdersAllowed, false);
  await assert.rejects(runAdaptiveStudy("register", "MISSING_OLDER_DATA", "MISSING_RECENT_DATA", output), { code: "EEXIST" });
});

test("failed development denies both later stages before any source seal or data access", async t => {
  for (const stage of ["confirm", "test"] as const) {
    const output = await directory(t);
    await writeJson(join(output, "selection.json"), { developmentGatePassed: false });
    await assert.rejects(runMissing(stage, output), /ADAPTIVE_STAGE_DENIED_DEVELOPMENT_FAILED/);
    await noMarker(output, stage);
  }
});

test("a changed protocol prevents development before dataset access", async t => {
  const output = await directory(t);
  await writeJson(join(output, "protocol.json"), { definition: { ...ADAPTIVE_STUDY_PROTOCOL, trainingDecisionPurgeHours: 0 } });
  await assert.rejects(runMissing("develop", output), /ADAPTIVE_PROTOCOL_CHANGED/);
  await noMarker(output, "develop");
});

test("source seal mismatch prevents confirmation before dataset access", async t => {
  const output = await directory(t); await selectionFixture(output);
  const path = join(output, "selection.json"), selected = JSON.parse(await readFile(path, "utf8"));
  selected.sourceHashes[SOURCES[0]!] = "changed"; await writeJson(path, selected);
  await assert.rejects(runMissing("confirm", output), /ADAPTIVE_STUDY_SEAL_MISMATCH/);
  await noMarker(output, "confirm");
});

test("edited selected assets fail the development artifact receipt before confirmation data access", async t => {
  const output = await directory(t); await selectionFixture(output);
  const path = join(output, "selection.json"), selected = JSON.parse(await readFile(path, "utf8"));
  selected.selectedByAsset["BTC/USD"] = "trend-recovery-24h"; await writeJson(path, selected);
  await assert.rejects(runMissing("confirm", output), /ADAPTIVE_ARTIFACT_CHANGED/);
  await noMarker(output, "confirm");
});

test("a missing required development receipt artifact denies confirmation", async t => {
  const output = await directory(t); await selectionFixture(output);
  const path = join(output, "develop-integrity.json"), integrity = JSON.parse(await readFile(path, "utf8"));
  delete integrity.artifacts["develop-portfolio.json"]; await writeJson(path, integrity);
  await assert.rejects(runMissing("confirm", output), /ADAPTIVE_INCOMPLETE_ARTIFACT_RECEIPT/);
  await noMarker(output, "confirm");
});

test("failed confirmation keeps the final period closed before dataset access", async t => {
  const output = await directory(t); await selectionFixture(output);
  await writeJson(join(output, "confirmation.json"), { confirmationGatePassed: false });
  await assert.rejects(runMissing("test", output), /ADAPTIVE_FINAL_DENIED_CONFIRMATION_FAILED/);
  await noMarker(output, "test");
});

test("final evaluation requires the same selection receipt and unchanged confirmation artifacts", async t => {
  for (const changed of ["selection-reference", "confirmation-artifact"] as const) {
    const output = await directory(t), seal = await selectionFixture(output);
    const confirmation = { ...seal, confirmationGatePassed: true,
      selectionSha256: changed === "selection-reference" ? "changed" : digest(await readFile(join(output, "selection.json"))) };
    await writeJson(join(output, "confirmation.json"), confirmation); await receipt(output, "confirm", "confirmation.json");
    if (changed === "confirmation-artifact") await writeJson(join(output, "confirm-portfolio.json"), { changed: true });
    await assert.rejects(runMissing("test", output), changed === "selection-reference" ? /ADAPTIVE_SELECTION_CHANGED/ : /ADAPTIVE_ARTIFACT_CHANGED/);
    await noMarker(output, "test");
  }
});
