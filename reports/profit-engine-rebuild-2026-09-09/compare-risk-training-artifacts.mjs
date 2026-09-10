#!/usr/bin/env node
// Read-only parity audit. Source identities and output locations may differ;
// every retained label, observed origin, cost, rule, clock and decision count
// must match exactly. This does not measure trading profitability.
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [baselinePath, candidatePath, baselineReportPath, candidateReportPath] = process.argv.slice(2);
if (![baselinePath, candidatePath, baselineReportPath, candidateReportPath].every(Boolean))
  throw new Error('Usage: compare-risk-training-artifacts.mjs BASE_ARTIFACT NEW_ARTIFACT BASE_REPORT NEW_REPORT');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const base = read(baselinePath), candidate = read(candidatePath);
const reports = [read(baselineReportPath), read(candidateReportPath)];
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function withoutSource(provenance) {
  const copy = structuredClone(provenance);
  delete copy.sourceCodeHashes; delete copy.sourceCodeSha256;
  return copy;
}
function withoutOutput(report) {
  const copy = withoutSource(report);
  delete copy.stateFile; delete copy.stateSha256;
  return copy;
}
const oldSources = new Map(base.trainingBackfill.sourceCodeHashes.map(row => [row.path, row.sha256]));
const newSources = new Map(candidate.trainingBackfill.sourceCodeHashes.map(row => [row.path, row.sha256]));
const changedSources = [...new Set([...oldSources.keys(), ...newSources.keys()])]
  .filter(path => oldSources.get(path) !== newSources.get(path)).sort();
const artifacts = [base, candidate].map(value => ({ ...value, trainingBackfill: withoutSource(value.trainingBackfill) }));
const byteLength = value => Buffer.byteLength(JSON.stringify(value));
const originBytes = base.trainingBackfill.origins.map(byteLength);
const sampleBytes = base.samples.map(byteLength);
const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const labels = base.samples.length, origins = originBytes.length, maximumLabels = 12 * 1024;
const result = {
  baselinePath, candidatePath, sameSamples: canonical(base.samples) === canonical(candidate.samples),
  sameOrigins: canonical(base.trainingBackfill.origins) === canonical(candidate.trainingBackfill.origins),
  sameArtifactApartFromSourceIdentity: canonical(artifacts[0]) === canonical(artifacts[1]),
  sameReportApartFromSourceAndOutputIdentity: canonical(withoutOutput(reports[0])) === canonical(withoutOutput(reports[1])),
  changedSources, onlyApprovedStatisticsSourceChanged: changedSources.length === 1 && changedSources[0] === 'src/core/statistics.ts',
  sampleSha256: hash(base.samples), originsSha256: hash(base.trainingBackfill.origins), labels, origins,
  artifactBytes: statSync(baselinePath).size, meanOriginBytes: mean(originBytes),
  maximumOriginBytes: Math.max(0, ...originBytes), meanLabelBytes: mean(sampleBytes),
  observedLabelsPerOrigin: labels / Math.max(1, origins), maximumRetainedLabels: maximumLabels,
  // Estimates are disclosed arithmetic, not assertions of future retention.
  projectedBytesAtObservedOriginSharing: mean(sampleBytes) * maximumLabels
    + mean(originBytes) * maximumLabels / Math.max(1, labels / Math.max(1, origins)),
  conservativeBytesAtOneOriginPerLabel: (mean(sampleBytes) + Math.max(0, ...originBytes)) * maximumLabels,
  importLimitBytes: 64 * 1024 * 1024, profitEstablished: false, productionImportPerformed: false,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.sameSamples || !result.sameOrigins || !result.sameArtifactApartFromSourceIdentity
  || !result.sameReportApartFromSourceAndOutputIdentity || !result.onlyApprovedStatisticsSourceChanged) process.exitCode = 1;
