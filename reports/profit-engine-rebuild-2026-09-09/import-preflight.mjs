/** Read-only check inside the final image. Context is an allowlisted snapshot of
 * the running paper configuration and freshly fetched public instrument rules.
 * No engine is started and no broker or order API is constructed.
 * node import-preflight.mjs ARTIFACT CURRENT_BANK CONTEXT DASHBOARD NEW_REPORT
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const moduleAt = path => import(pathToFileURL(resolve('dist/src', path)).href);
const { readDistributionTrainingArtifact, mergeDistributionTraining } = await moduleAt('distribution/training-import.js');
const { createRiskBoundedTrainingContext, trainingContextHash } = await moduleAt('distribution/risk-training-context.js');
const { readRiskTrainingSourceHashes } = await moduleAt('distribution/risk-training-source.js');
const { distributionEntryProfile, DISTRIBUTION_ACTIONS, DISTRIBUTION_SPEC } = await moduleAt('distribution/spec.js');
const { EfficientDistributionTrainer } = await moduleAt('distribution/efficient-trainer.js');
const args = process.argv.slice(2);
if (args.length !== 5 || args.some(arg => !arg.trim())) throw new Error('Exactly five nonempty paths required');
const [artifactPath, bankPath, contextPath, dashboardPath, outputPath] = args;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const nowMs = Date.now(), source = readRiskTrainingSourceHashes();
const expectedSource = 'c57475ab04ce281cbd83f86f95f0099d56d24ef5edcee758e293be197f8d036b';
if (trainingContextHash(source) !== expectedSource) throw new Error('PREFLIGHT_UNREVIEWED_RUNTIME_SOURCE');
const contextBytes = await readFile(contextPath), bankBytes = await readFile(bankPath), dashboardBytes = await readFile(dashboardPath);
const context = JSON.parse(contextBytes), current = JSON.parse(bankBytes), dashboard = JSON.parse(dashboardBytes);
const fresh = atMs => Number.isSafeInteger(atMs) && atMs >= 0 && atMs <= nowMs && nowMs - atMs <= 60_000;
if (context.mode !== 'paper' || context.paperTrial !== true || context.efficientTraining !== true || context.regimeModel !== false
    || !fresh(context.generatedAtMs))
  throw new Error('PREFLIGHT_CURRENT_PAPER_CONTEXT_REQUIRED');
if (dashboard.mode !== 'paper' || dashboard.paper !== true || !fresh(dashboard.generatedAtMs)
    || !Number.isFinite(dashboard.equity) || dashboard.equity <= 0)
  throw new Error('PREFLIGHT_CURRENT_PAPER_DASHBOARD_REQUIRED');
const profile = distributionEntryProfile(context.paperTrial, context.efficientTraining, context.regimeModel);
const risk = createRiskBoundedTrainingContext(context.symbolConfigs, context.sizingPolicy,
  context.initialEquity, context.initialEquity);
const prepared = await readDistributionTrainingArtifact(artifactPath, [bankPath,
  `${bankPath}.pending`, `${bankPath}.tmp`, `${bankPath}.pending.tmp`]);
const artifact = prepared.artifact;
const merged = mergeDistributionTraining(current, artifact, context.costs, context.assets, nowMs, profile, risk, source);
const repeated = mergeDistributionTraining(merged.state, artifact, context.costs, context.assets, nowMs, profile, risk, source);
if (repeated.report.addedSamples !== 0 || trainingContextHash(repeated.state) !== trainingContextHash(merged.state))
  throw new Error('PREFLIGHT_IMPORT_NOT_IDEMPOTENT');
const models = [current, merged.state].map(state => new EfficientDistributionTrainer(context.costs, context.assets,
  state.samples, nowMs, { sizingPolicy: context.sizingPolicy, regimeModel: false }));
const probes = [];
for (const market of dashboard.markets ?? []) {
  const query = market.distributional?.decision;
  if (!query || !fresh(query.atMs) || query.symbol !== market.symbol || !context.assets[market.symbol]
      || query.sizingPolicyId !== risk.sizingPolicyId || query.selectionPolicyVersion !== profile.selectionPolicyVersion
      || !Array.isArray(query.features) || query.features.length !== DISTRIBUTION_SPEC.featureDimension
      || !query.features.every(Number.isFinite)) {
    probes.push({ symbol: market.symbol, status: 'NO_COMPATIBLE_FRESH_RECORDED_QUERY' });
    continue;
  }
  probes.push({ symbol: market.symbol, queryAtMs: query.atMs, status: 'DIAGNOSTIC_ONLY_NO_ORDER_PERMISSION',
    before: DISTRIBUTION_ACTIONS.map(action => models[0].estimate(market.symbol, action.id, query.features, nowMs, profile.minimumTrainingDays)),
    after: DISTRIBUTION_ACTIONS.map(action => models[1].estimate(market.symbol, action.id, query.features, nowMs, profile.minimumTrainingDays)) });
}
const report = {
  verifiedAtUtc: new Date(nowMs).toISOString(), sourceCodeSha256: expectedSource,
  sourceFiles: source.length, artifact: prepared.file,
  currentBankSha256: sha(bankBytes), runtimeContextSha256: sha(contextBytes), dashboardSha256: sha(dashboardBytes),
  sizingPolicyId: risk.sizingPolicyId, referenceEquity: risk.equity,
  currentRuntimeEquity: dashboard.equity, profile, import: merged.report,
  repeatedImportAddedSamples: 0, mergedStateSha256: trainingContextHash(merged.state), probes,
  labelFundingInterpretation: 'EXECUTION_FEES_AND_FIXED_RESERVE;NO_OBSERVED_FUNDING_CASH_LABELS',
  originalRecordingsReplayedByThisPreflight: false, brokerOrdersSubmitted: 0,
  runningBankModified: false, prospectiveProfitEstablished: false,
};
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ verified: true, addedSamples: merged.report.addedSamples,
  retainedSamples: merged.report.retainedSamples, artifactSha256: prepared.file.sha256,
  repeatedImportAddedSamples: 0, brokerOrdersSubmitted: 0 }) + '\n');
