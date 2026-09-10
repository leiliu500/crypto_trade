import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { carryMonitorReport, type CarryPublicSnapshot } from "./monitor.js";
import { validateCarryResearchConfig, type CarryResearchConfig } from "./config.js";

export const CARRY_FEE_FRONTIER_SPEC = Object.freeze({ version: "saved-carry-spot-fee-frontier-v1", researchOnly: true,
  spotTakerFeeBpsPerExecutedSide: Object.freeze([0, 20, 40, 80]),
  kernel: "UNCHANGED_CARRY_MONITOR_REPORT_AND_EVALUATE_CARRY_ECONOMICS",
  changedAssumption: "SPOT_TAKER_FEE_PER_EXECUTED_SIDE_ONLY",
  retainedAssumptions: "FUTURES_FEES_FOUR_EXECUTIONS_SPREAD_SLIPPAGE_CAPITAL_HURDLE_COLLATERAL_BASIS_UNWIND_RESERVES_AND_SETTLEMENT_SCENARIOS",
  freshness: "AS_SAVED_CAPTURE_ONLY_NOT_CURRENT_QUOTES",
  interpretation: "INDIVIDUAL_PRODUCT_AND_BUDGET_SENSITIVITIES_NOT_SIMULTANEOUS_PORTFOLIO_ALLOCATIONS",
  zeroSpotFee: "HYPOTHETICAL_LOWER_BOUND_NOT_DEFAULT_OR_ACCOUNT_ENTITLEMENT",
  actualFeeVerified: false, activationAllowed: false, validatedProfitability: false,
});
const SOURCES = ["src/carry/fee-frontier-main.ts", "src/carry/monitor.ts", "src/carry/economics.ts",
  "src/carry/config.ts", "src/economics/fee-validation.ts", "tsconfig.json", "package-lock.json"];
const DEFAULT_INPUT = "reports/carry-feasibility-reviewed-2026-09-09/public-input.json.gz";
const DEFAULT_CONFIG = "config/carry-research.json";
const DEFAULT_PROTOCOL = "docs/FUNDING_ECONOMIC_PROTOCOL.md";
const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const jsonHash = (v: unknown) => hash(JSON.stringify(v));
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
type Monitor = ReturnType<typeof carryMonitorReport>;
type Row = Monitor["rows"][number];
function counts(rows: readonly Row[]) {
  const scenarios = rows.flatMap(r => r.economics.scenarios);
  return { productBudgetRows: rows.length, individuallyFeasibleRows: rows.filter(r => r.economics.status === "FEASIBLE").length,
    infeasibleRows: rows.filter(r => r.economics.status === "INFEASIBLE").length,
    invalidRows: rows.filter(r => r.economics.status === "INVALID").length,
    declaredPaths: scenarios.length, positiveNetPaths: scenarios.filter(s => s.netAfterCostsUsd > 0).length,
    negativeNetPaths: scenarios.filter(s => s.netAfterCostsUsd < 0).length,
    zeroNetPaths: scenarios.filter(s => s.netAfterCostsUsd === 0).length,
    rowsPositiveInAllDeclaredPaths: rows.filter(r => r.economics.scenarios.length > 0
      && r.economics.scenarios.every(s => s.netAfterCostsUsd > 0)).length };
}
function summarize(report: Monitor) {
  return { counts: counts(report.rows),
    byAssetAndBudget: ["BTC", "ETH"].flatMap(base => report.configuration.budgets.map(budget => {
      const rows = report.rows.filter(r => r.base === base && r.budgetId === budget.id);
      return { base, budgetId: budget.id, allProducts: counts(rows),
        datedPolicyEligibleProducts: counts(rows.filter(r => r.datedPolicyEligible)),
        perpetualProducts: counts(rows.filter(r => r.product.startsWith("PF_"))) };
    })),
    products: report.rows.map(row => ({ base: row.base, product: row.product, budgetId: row.budgetId,
      datedPolicyEligible: row.datedPolicyEligible, maturityDays: row.maturityDays, status: row.economics.status,
      reasons: row.economics.reasons, allocatedBaseQty: row.economics.allocatedBaseQty,
      allocatedPairedGrossUsd: row.economics.allocatedPairedGrossUsd, requiredCashUsd: row.economics.requiredCashUsd,
      requiredCollateralUsd: row.economics.requiredCollateralUsd, reservedCapitalUsd: row.economics.reservedCapitalUsd,
      minimumPairedGrossUsd: row.economics.minimumPairedGrossUsd, holdingHours: row.economics.holdingHours,
      breakEvenAbsoluteFundingUsdPerBasePerHour: row.economics.breakEvenAbsoluteFundingUsdPerBasePerHour,
      paths: row.economics.scenarios.map(s => ({ name: s.name,
        assumedSettlementSpotPriceUsd: s.assumedSettlementSpotPriceUsd,
        assumedAbsoluteFundingUsdPerBasePerHour: s.assumedAbsoluteFundingUsdPerBasePerHour,
        grossBasisCaptureUsd: s.grossBasisCaptureUsd, fundingIncomeUsd: s.fundingIncomeUsd,
        executionSpreadCostUsd: s.executionSpreadCostUsd, slippageCostUsd: s.slippageCostUsd, fees: s.fees,
        capitalHurdleCostUsd: s.capitalHurdleCostUsd, settlementBasisReserveUsd: s.settlementBasisReserveUsd,
        unwindReserveUsd: s.unwindReserveUsd, netAfterCostsUsd: s.netAfterCostsUsd,
        annualizedNetOnReservedCapitalFraction: s.annualizedNetOnReservedCapitalFraction })) })) };
}

/** Fixed, descriptive sensitivity only. The original snapshot and all config
 * assumptions except per-side spot fee remain untouched. */
export function evaluateCarryFeeFrontier(snapshot: CarryPublicSnapshot, baseConfig: CarryResearchConfig) {
  const config = validateCarryResearchConfig(baseConfig), before = jsonHash({ snapshot, baseConfig });
  const scenarios = CARRY_FEE_FRONTIER_SPEC.spotTakerFeeBpsPerExecutedSide.map(spotTakerFeeBps => {
    const configuration = { ...config, spotTakerFeeBps };
    const report = carryMonitorReport(snapshot, configuration);
    return { spotTakerFeeBps, actualFeeVerified: false, report, summary: summarize(report) };
  });
  if (before !== jsonHash({ snapshot, baseConfig })) throw new Error("CARRY_FRONTIER_MUTATED_INPUT");
  return scenarios;
}
export interface CarryFeeFrontierOptions { outputDirectory: string; inputPath?: string; configPath?: string; protocolPath?: string }
async function sourceHashes() { return Object.fromEntries(await Promise.all(SOURCES.map(async p => [p, hash(await readFile(p))]))); }

export async function runCarryFeeFrontier(options: CarryFeeFrontierOptions) {
  const inputPath = options.inputPath ?? DEFAULT_INPUT, configPath = options.configPath ?? DEFAULT_CONFIG;
  const protocolPath = options.protocolPath ?? DEFAULT_PROTOCOL, output = resolve(options.outputDirectory);
  const [inputBytes, configBytes, documentBytes, sourcesBefore] = await Promise.all([
    readFile(inputPath), readFile(configPath), readFile(protocolPath), sourceHashes()]);
  if (inputBytes.length > 32_000_000) throw new Error("CARRY_FRONTIER_INPUT_TOO_LARGE");
  const decoded = gunzipSync(inputBytes, { maxOutputLength: 32_000_000 });
  const snapshot = JSON.parse(decoded.toString("utf8")) as CarryPublicSnapshot;
  const config = validateCarryResearchConfig(JSON.parse(configBytes.toString("utf8")));
  if (!Number.isSafeInteger(snapshot.collectedAtMs) || snapshot.collectedAtMs < 0)
    throw new Error("CARRY_FRONTIER_INVALID_CAPTURE_TIME");
  const sealedInputs = { inputPath: resolve(inputPath), compressedInputSha256: hash(inputBytes),
    decodedInputSha256: hash(decoded), normalizedSnapshotSha256: jsonHash(snapshot),
    configurationPath: resolve(configPath), configurationSha256: hash(configBytes), normalizedConfigurationSha256: jsonHash(config),
    documentPath: resolve(protocolPath), documentSha256: hash(documentBytes) };
  // Exclusive directory creation and protocol write precede every economics call.
  await mkdir(output, { recursive: false });
  const registration = { version: CARRY_FEE_FRONTIER_SPEC.version, registeredAtUtc: new Date().toISOString(),
    capturedAtUtc: new Date(snapshot.collectedAtMs).toISOString(), spec: CARRY_FEE_FRONTIER_SPEC,
    document: documentBytes.toString("utf8"), sourceHashes: sourcesBefore, sealedInputs, baseConfiguration: config,
    changes: CARRY_FEE_FRONTIER_SPEC.spotTakerFeeBpsPerExecutedSide.map(spotTakerFeeBps => ({ spotTakerFeeBps })),
    outcomesCalculated: false, actualFeeVerified: false, activationAllowed: false };
  await save(join(output, "protocol.json"), registration);
  const protocolSha256 = hash(await readFile(join(output, "protocol.json")));
  const scenarios = evaluateCarryFeeFrontier(snapshot, config);
  const artifacts: Record<string, string> = {};
  for (const scenario of scenarios) {
    const file = `spot-fee-${scenario.spotTakerFeeBps}bps.json`;
    await save(join(output, file), { ...scenario.report, actualFeeVerified: false,
      feeInterpretation: scenario.spotTakerFeeBps === 0 ? CARRY_FEE_FRONTIER_SPEC.zeroSpotFee
        : "HYPOTHETICAL_SPOT_TAKER_FEE_SENSITIVITY_NOT_ACCOUNT_TIER_VERIFICATION",
      historicalSnapshotOnly: true, protocolSha256 });
    artifacts[file] = hash(await readFile(join(output, file)));
  }
  const [inputAfter, configAfter, documentAfter, sourcesAfter] = await Promise.all([
    readFile(inputPath), readFile(configPath), readFile(protocolPath), sourceHashes()]);
  if (hash(inputAfter) !== sealedInputs.compressedInputSha256 || hash(configAfter) !== sealedInputs.configurationSha256
    || hash(documentAfter) !== sealedInputs.documentSha256 || jsonHash(sourcesAfter) !== jsonHash(sourcesBefore)
    || hash(await readFile(join(output, "protocol.json"))) !== protocolSha256)
    throw new Error("CARRY_FRONTIER_SEALED_INPUT_CHANGED_DURING_RUN");
  const report = { version: CARRY_FEE_FRONTIER_SPEC.version, generatedAtUtc: new Date().toISOString(),
    capturedAtUtc: registration.capturedAtUtc, capturedAtMs: snapshot.collectedAtMs,
    freshness: CARRY_FEE_FRONTIER_SPEC.freshness, protocolSha256, spec: CARRY_FEE_FRONTIER_SPEC,
    sourceHashes: sourcesBefore, sealedInputs, sourceAndInputHashesUnchanged: true, artifacts,
    actualFeeVerified: false, historicalSnapshotOnly: true, activationAllowed: false, validatedProfitability: false,
    futuresTakerFeeBpsPerExecutedSide: config.derivativeTakerFeeBps,
    scenarios: scenarios.map(s => ({ spotTakerFeeBpsPerExecutedSide: s.spotTakerFeeBps,
      configurationSha256: jsonHash(s.report.configuration), ...s.summary })),
    limitations: ["Saved public quotes are evaluated only at their original capture time, not as current executable prices.",
      "Spot fees of 0/20/40/80 bp are fixed sensitivities; no account, tier or jurisdiction eligibility was authenticated.",
      "Zero spot fee retains futures entry/exit fees, spread, slippage, capital hurdle, collateral, basis and unwind reserves.",
      "Original financing/capital assumptions are unchanged; this is not verification of every account-specific financing or conversion charge.",
      "Rows are individually feasible quantities under separate research budgets, not simultaneous allocations; do not sum row profits.",
      "Positive scenario counts are arithmetic sensitivities, not probabilities, forecasts, backtest returns or deployment permission.",
      "Dated eligibility is reported separately from all-product diagnostics; perpetual current/zero/adverse funding scenarios remain intact."] };
  await save(join(output, "frontier.json"), report);
  await save(join(output, "integrity.json"), { completedAtUtc: new Date().toISOString(), protocolSha256,
    reportSha256: hash(await readFile(join(output, "frontier.json"))), sourceHashes: sourcesBefore, sealedInputs, artifacts });
  return { output, capturedAtUtc: report.capturedAtUtc, actualFeeVerified: false, activationAllowed: false,
    scenarios: report.scenarios.map(s => ({ spotTakerFeeBpsPerExecutedSide: s.spotTakerFeeBpsPerExecutedSide, ...s.counts })) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [outputDirectory, inputPath, configPath] = process.argv.slice(2);
  if (!outputDirectory) throw new Error("Usage: carry:fee-frontier NEW_OUTPUT_DIRECTORY [SAVED_PUBLIC_INPUT_JSON_GZ] [CONFIG_PATH]");
  const result = await runCarryFeeFrontier({ outputDirectory, ...(inputPath === undefined ? {} : { inputPath }),
    ...(configPath === undefined ? {} : { configPath }) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
