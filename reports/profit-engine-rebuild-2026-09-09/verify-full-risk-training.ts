/** Read-only final-artifact audit. It does not load or mutate production state,
 * submit orders, or equate raw after-reserve labels with account profitability. */
import { readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { loadConfig } from "../../src/config.js";
import { DistributionController } from "../../src/distribution/controller.js";
import { DISTRIBUTION_ENTRY_PROFILES, DISTRIBUTION_SPEC } from "../../src/distribution/spec.js";
import { mergeDistributionTraining } from "../../src/distribution/training-import.js";
import { createRiskBoundedTrainingContext, trainingContextHash } from "../../src/distribution/risk-training-context.js";
import { readRiskTrainingSourceHashes } from "../../src/distribution/risk-training-source.js";
import { readRiskTrainingOrigins } from "../../src/distribution/risk-training-origins.js";
import { policyReserveBps } from "../../src/research/policy-planner.js";
import type { AssetRules } from "../../src/execution/planner.js";

const [artifactPath, replayReportPath, protocolPath, manifestPath, outputPath] = process.argv.slice(2);
if (!artifactPath || !replayReportPath || !protocolPath || !manifestPath || !outputPath)
  throw new Error("Usage: verify-full-risk-training.ts ARTIFACT REPORT PROTOCOL INPUT_MANIFEST NEW_AUDIT_OUTPUT");
const [bytes, reportText, protocolText, manifestText, assetText] = await Promise.all([
  readFile(artifactPath), readFile(replayReportPath, "utf8"), readFile(protocolPath, "utf8"), readFile(manifestPath, "utf8"),
  readFile("reports/distribution-instrument-rules-2026-09-07.json", "utf8")]);
const artifact = JSON.parse(bytes.toString("utf8")), report = JSON.parse(reportText), protocol = JSON.parse(protocolText);
const manifest = JSON.parse(manifestText) as Array<{ name: string; bytes: number; firstAt: string; lastAt: string }>;
const assets = JSON.parse(assetText) as Record<string, AssetRules>;
const cfg = loadConfig({}, "replay"), profile = DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL_EFFICIENT;
const context = createRiskBoundedTrainingContext(cfg.symbolConfigs, cfg.distributionalSizingPolicy!, 100_000);
const expectedSourceCodeHashes = readRiskTrainingSourceHashes(), sourceSha = trainingContextHash(expectedSourceCodeHashes);
const artifactSha = createHash("sha256").update(bytes).digest("hex"), p = artifact.trainingBackfill;
if (bytes.length > 64 * 1024 * 1024 || report.stateSha256 !== artifactSha || p.sourceCodeSha256 !== sourceSha
  || protocol.sourceCodeSha256 !== sourceSha || p.riskContext.equity !== 100_000 || p.riskContext.equityHighWater !== 100_000
  || p.cutoffMs !== Date.parse(protocol.cutoff) || p.stateInput !== null || p.inputFiles.length !== manifest.length
  || manifest.length !== 34 || p.quality.firstMs !== Date.parse(manifest[0]!.firstAt)
  || p.quality.lastMs !== Date.parse(manifest.at(-1)!.lastAt)) throw new Error("FULL_REPLAY_PROTOCOL_MISMATCH");
for (let i = 0; i < manifest.length; i++) if (basename(p.inputFiles[i].path) !== manifest[i]!.name
  || p.inputFiles[i].bytes !== manifest[i]!.bytes) throw new Error("FULL_REPLAY_INPUT_MANIFEST_MISMATCH");
const costs = Object.fromEntries(DISTRIBUTION_SPEC.symbols.map(symbol => [symbol,
  { feeBps: cfg.symbolConfigs[symbol]!.cost.takerFeeBps, reserveBps: policyReserveBps(cfg.symbolConfigs[symbol]!) }]));
const fresh = () => new DistributionController(costs, assets, profile, { efficientTraining: true, sizingPolicy: context.sizingPolicy });
const now = Date.now(), merged = mergeDistributionTraining(fresh().exportState(), artifact, costs, assets, now,
  profile, context, expectedSourceCodeHashes);
const repeated = mergeDistributionTraining(merged.state, artifact, costs, assets, now, profile, context, expectedSourceCodeHashes);
if (merged.report.addedSamples !== artifact.samples.length || repeated.report.addedSamples !== 0)
  throw new Error("FULL_REPLAY_RESTORE_OR_IDEMPOTENCE_FAILURE");
const origins = readRiskTrainingOrigins(p), byAction: Record<string, { count: number; dates: Set<string>; sum: number; positive: number }> = {};
for (const sample of merged.state.samples) {
  const key = `${sample.symbol}:${sample.actionId}`, row = byAction[key] ??= { count: 0, dates: new Set(), sum: 0, positive: 0 };
  const worst = Math.min(...sample.outcomes.map(outcome => outcome.netBps!));
  row.count++; row.dates.add(new Date(sample.signalAtMs).toISOString().slice(0, 10)); row.sum += worst; row.positive += Number(worst > 0);
}
const originNotionals = origins.map(origin => origin.requestedQty * origin.referenceAsk);
const endedAt = (await stat(artifactPath)).mtimeMs;
const result = { artifactPath, artifactBytes: bytes.length, artifactSha256: artifactSha, sourceCodeSha256: sourceSha,
  fullFrozenSourceVerified: true, inputFiles: manifest.length, compressedInputBytes: manifest.reduce((sum, file) => sum + file.bytes, 0),
  quality: p.quality, retainedLabels: artifact.samples.length, retainedOrigins: origins.length, retainedDays: p.retainedDays,
  originEncoding: p.originsPacked?.encoding ?? "ORIGINAL_UNCOMPRESSED_V2", originDecodedBytes: p.originsPacked?.decodedBytes ?? null,
  originNotionalUsd: { minimum: Math.min(...originNotionals), maximum: Math.max(...originNotionals),
    mean: originNotionals.reduce((sum, n) => sum + n, 0) / Math.max(1, origins.length) },
  isolatedImport: { addedSamples: merged.report.addedSamples, repeatedAddedSamples: repeated.report.addedSamples,
    brokerOrdersSubmitted: merged.report.brokerOrdersSubmitted, validation: merged.report.validation },
  diagnosticsOnly: Object.fromEntries(Object.entries(byAction).map(([key, row]) => [key, { count: row.count,
    dates: [...row.dates].sort(), meanWorstScenarioNetBps: row.sum / row.count, positiveWorstScenarioFraction: row.positive / row.count }])),
  endedAt: new Date(endedAt).toISOString(), elapsedSeconds: (endedAt - Date.parse(protocol.startedAt)) / 1000,
  productionStateReadOrMutated: false, currentConditionalEntryGateAssessed: false, observedFundingCashIncluded: false,
  profitabilityEstablished: false, limitation: "Counterfactual public-book labels after configured fees/reserve. Raw action means are dependent diagnostics; production merge and current conditional entry checks remain separate." };
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ artifactBytes: bytes.length, retainedLabels: artifact.samples.length,
  origins: origins.length, dates: p.retainedDays, isolatedAdded: merged.report.addedSamples, repeatedAdded: repeated.report.addedSamples })}\n`);
