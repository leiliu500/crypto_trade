import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AssetRules } from "../execution/planner.js";
import { DistributionController, LEGACY_DISTRIBUTION_TRAINING_VERSION, type DistributionCosts } from "./controller.js";
import { EFFICIENT_TRAINING_SPEC } from "./efficient-trainer.js";
import { distributionTrainingOnlyState } from "./training-backfill.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SPEC, DISTRIBUTION_ENTRY_PROFILES,
  type DistributionEntryProfile, type DistributionSample } from "./spec.js";

type State = ReturnType<DistributionController["exportState"]>;
interface Panel { symbol: string; signalAtMs: number; completedAtMs: number; rows: DistributionSample[] }

/** Startup import is read-only; reject filesystem aliases to anything the
 * engine will later mutate, including hard links and resolved symlinks. */
export async function readDistributionTrainingArtifact(path: string, protectedPaths: readonly string[]) {
  const absolute = resolve(path), source = await stat(absolute), resolved = await realpath(absolute);
  if (!source.isFile() || source.size > 64 * 1024 * 1024) throw new Error("INVALID_TRAINING_ARTIFACT_FILE");
  for (const protectedPath of protectedPaths) {
    if (resolve(protectedPath) === absolute) throw new Error("TRAINING_ARTIFACT_MUTABLE_PATH_ALIAS");
    try {
      const protectedStat = await stat(protectedPath);
      if ((protectedStat.dev === source.dev && protectedStat.ino === source.ino)
        || await realpath(protectedPath) === resolved) throw new Error("TRAINING_ARTIFACT_MUTABLE_PATH_ALIAS");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const bytes = await readFile(absolute), after = await stat(absolute);
  if (after.dev !== source.dev || after.ino !== source.ino || after.size !== source.size
    || after.mtimeMs !== source.mtimeMs || after.ctimeMs !== source.ctimeMs) throw new Error("TRAINING_ARTIFACT_CHANGED");
  return { artifact: JSON.parse(bytes.toString("utf8")) as unknown,
    file: { path: absolute, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
}

/** Build a replacement in isolation. Live complete panels have priority over
 * duplicate/overlapping historical panels. New labels reset live validation. */
export function mergeDistributionTraining(currentValue: unknown, artifactValue: unknown,
  costs: DistributionCosts, assets: Readonly<Record<string, AssetRules>>, cutoffMs: number,
  profile: DistributionEntryProfile = DISTRIBUTION_ENTRY_PROFILES.VALIDATED) {
  if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) throw new Error("INVALID_TRAINING_IMPORT_CUTOFF");
  const current = structuredClone(currentValue) as State;
  const artifact = artifactValue as State & { trainingBackfill?: Record<string, unknown> };
  const provenance = artifact?.trainingBackfill;
  const artifactCutoff = provenance?.cutoffMs;
  if (!provenance || provenance.version !== `${DISTRIBUTION_SPEC.version}:training-backfill-v1`
    || provenance.trainingOnly !== true || provenance.prospectiveSelectionsCreated !== 0
    || provenance.brokerOrdersSubmitted !== 0 || provenance.profitabilityEstablished !== false
    || provenance.deploymentReady !== false || !Number.isSafeInteger(artifactCutoff)
    || (artifact.trainingPolicyVersion !== undefined && artifact.trainingPolicyVersion !== LEGACY_DISTRIBUTION_TRAINING_VERSION)
    || Boolean(artifact.efficientTraining)
    || (artifactCutoff as number) < 0 || (artifactCutoff as number) > cutoffMs
    || !compatibleTrainingSpec(provenance.spec)
    || canonical(provenance.costs) !== canonical(costs)
    || canonical(provenance.assets) !== canonical(assets)
    || provenance.instrumentRulesSha256 !== createHash("sha256").update(JSON.stringify(provenance.assets)).digest("hex")
    || !Array.isArray(provenance.inputFiles) || provenance.inputFiles.length === 0
    || provenance.inputFiles.some((f: { path?: unknown; bytes?: unknown; sha256?: unknown }) => !f || typeof f.path !== "string"
      || !f.path || !Number.isSafeInteger(f.bytes) || (f.bytes as number) <= 0 || typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256))
    || !Array.isArray(artifact.validationSelections) || artifact.validationSelections.length !== 0
    || !Array.isArray(artifact.pendingSelections) || artifact.pendingSelections.length !== 0)
    throw new Error("INVALID_TRAINING_ARTIFACT_PROVENANCE");
  const historical = distributionTrainingOnlyState(artifact);
  const regime = profile.selectionPolicyVersion === DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL_REGIME.selectionPolicyVersion;
  const efficient = regime || profile.selectionPolicyVersion === DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL_EFFICIENT.selectionPolicyVersion;
  const verifyCurrent = new DistributionController(costs, structuredClone(assets), profile, { efficientTraining: efficient, regimeModel: regime });
  verifyCurrent.restoreState(current, cutoffMs);
  // An efficient live bank can have different action origins and completion
  // times. Its historical import is still the original full-panel artifact and
  // must pass that stricter provenance/label contract before any action merge.
  const historicalProfile = profile.entryMode === "PAPER_TRIAL" ? DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL
    : DISTRIBUTION_ENTRY_PROFILES.VALIDATED;
  const verifyHistorical = new DistributionController(costs, structuredClone(assets), historicalProfile);
  verifyHistorical.restoreState(historical, artifactCutoff as number);
  const quality = provenance.quality as { firstMs?: unknown; lastMs?: unknown } | undefined;
  if (!quality || !Number.isSafeInteger(quality.firstMs) || !Number.isSafeInteger(quality.lastMs)
    || (quality.firstMs as number) < 0 || (quality.lastMs as number) < (quality.firstMs as number)
    || (quality.lastMs as number) > (artifactCutoff as number)
    || historical.samples.some(sample => sample.completedAtMs > (quality.lastMs as number))
    || provenance.retainedSamples !== historical.samples.length
    || provenance.retainedPanels !== historical.samples.length / DISTRIBUTION_ACTIONS.length)
    throw new Error("INVALID_TRAINING_ARTIFACT_COVERAGE");
  if (efficient) return mergeEfficientTraining(current, historical.samples, costs, assets, cutoffMs, profile);
  const livePanels = panels(current.samples), historicalPanels = panels(historical.samples);
  const liveById = new Map(livePanels.map(panel => [`${panel.symbol}:${panel.signalAtMs}`, panel]));
  const additions: Panel[] = [];
  let duplicatePanels = 0, skippedOverlapPanels = 0;
  for (const panel of historicalPanels) {
    const duplicate = liveById.get(`${panel.symbol}:${panel.signalAtMs}`);
    if (duplicate) {
      if (canonical(duplicate.rows) !== canonical(panel.rows)) throw new Error("TRAINING_DUPLICATE_PANEL_CONFLICT");
      duplicatePanels++; continue;
    }
    if (livePanels.some(other => overlaps(panel, other)) || additions.some(other => overlaps(panel, other))) {
      skippedOverlapPanels++; continue;
    }
    additions.push(panel);
  }
  const mergedPanels = [...livePanels, ...additions].sort(panelOrder);
  const retained = DISTRIBUTION_SPEC.symbols.flatMap(symbol => mergedPanels.filter(panel => panel.symbol === symbol)
    .slice(-DISTRIBUTION_SPEC.maximumSamples)).sort(panelOrder);
  const retainedIds = new Set(retained.map(panel => `${panel.symbol}:${panel.signalAtMs}`));
  const addedPanels = additions.filter(panel => retainedIds.has(`${panel.symbol}:${panel.signalAtMs}`));
  const addedSamples = addedPanels.length * DISTRIBUTION_ACTIONS.length;
  // An idempotent import must not erase validation collected since the original
  // import. Capacity-only old additions do not change the effective model.
  const merged = addedSamples ? { ...distributionTrainingOnlyState(current), samples: retained.flatMap(panel => panel.rows) } : current;
  const verifyMerged = new DistributionController(costs, structuredClone(assets), profile);
  verifyMerged.restoreState(merged, cutoffMs);
  const dates = [...new Set(merged.samples.map(sample => new Date(sample.signalAtMs).toISOString().slice(0, 10)))].sort();
  return { state: merged, report: { imported: addedSamples > 0, addedSamples, addedPanels: addedPanels.length,
    duplicatePanels, skippedOverlapPanels, capacityDiscardedHistoricalPanels: additions.length - addedPanels.length,
    retainedSamples: merged.samples.length, trainingDates: dates, prospectiveValidationReset: addedSamples > 0,
    validation: verifyMerged.stats(cutoffMs).validation, brokerOrdersSubmitted: 0 } };
}

/** The legacy artifact supplies eligible action labels independently to the
 * efficient bank. Existing live labels win conflicts in time, and a duplicate
 * id with different content is rejected. Other actions may overlap by design. */
function mergeEfficientTraining(current: State, historical: readonly DistributionSample[], costs: DistributionCosts,
  assets: Readonly<Record<string, AssetRules>>, cutoffMs: number, profile: DistributionEntryProfile) {
  if (current.trainingPolicyVersion !== EFFICIENT_TRAINING_SPEC.version || !current.efficientTraining)
    throw new Error("INVALID_EFFICIENT_TRAINING_IMPORT_STATE");
  const key = (sample: DistributionSample) => `${sample.symbol}:${sample.actionId}`;
  const banks = new Map<string, DistributionSample[]>();
  const existing = new Map(current.samples.map(sample => [sample.id, sample]));
  for (const sample of current.samples) {
    const bank = banks.get(key(sample)) ?? []; bank.push(sample); banks.set(key(sample), bank);
  }
  const disposition = new Map<string, "duplicate" | "overlap" | "capacity" | "added">();
  const additions: DistributionSample[] = [];
  for (const sample of historical) {
    const duplicate = existing.get(sample.id);
    if (duplicate) {
      if (canonical(duplicate) !== canonical(sample)) throw new Error("TRAINING_DUPLICATE_ACTION_CONFLICT");
      disposition.set(sample.id, "duplicate"); continue;
    }
    const bank = banks.get(key(sample)) ?? [];
    if (bank.some(other => actionOverlaps(sample, other))) { disposition.set(sample.id, "overlap"); continue; }
    bank.push(sample); banks.set(key(sample), bank); additions.push(sample);
  }
  const retained = [...banks.values()].flatMap(bank => bank.sort(sampleOrder).slice(-DISTRIBUTION_SPEC.maximumSamples)).sort(sampleOrder);
  const retainedIds = new Set(retained.map(sample => sample.id));
  const added = additions.filter(sample => retainedIds.has(sample.id));
  for (const sample of additions) disposition.set(sample.id, retainedIds.has(sample.id) ? "added" : "capacity");
  const addedSamples = added.length;
  // Do not pass current through distributionTrainingOnlyState: that function
  // intentionally emits legacy historical metadata and removes live clocks.
  const merged = addedSamples ? { ...current, samples: structuredClone(retained), validationSelections: [],
    pendingSelections: [], selectedSlotUntilMs: null, efficientTraining: structuredClone(current.efficientTraining) } : current;
  if (addedSamples) for (const sample of added) {
    const action = DISTRIBUTION_ACTIONS.find(action => action.id === sample.actionId)!;
    const clock = `${sample.symbol}:${action.horizonMs}`;
    merged.efficientTraining!.nextOrigins[clock] = Math.max(merged.efficientTraining!.nextOrigins[clock] ?? 0,
      sample.signalAtMs + action.horizonMs + EFFICIENT_TRAINING_SPEC.completionBufferMs, sample.completedAtMs);
  }
  const verifyMerged = new DistributionController(costs, structuredClone(assets), profile, { efficientTraining: true,
    regimeModel: profile.selectionPolicyVersion === DISTRIBUTION_ENTRY_PROFILES.PAPER_TRIAL_REGIME.selectionPolicyVersion });
  verifyMerged.restoreState(merged, cutoffMs);
  const historyPanels = panels(historical);
  const completePanels = (kind: "duplicate" | "overlap" | "capacity" | "added") => historyPanels
    .filter(panel => panel.rows.every(sample => disposition.get(sample.id) === kind)).length;
  const count = (kind: "duplicate" | "overlap" | "capacity" | "added") => [...disposition.values()].filter(value => value === kind).length;
  return { state: merged, report: { imported: addedSamples > 0, addedSamples,
    addedPanels: completePanels("added"), duplicatePanels: completePanels("duplicate"),
    skippedOverlapPanels: completePanels("overlap"), capacityDiscardedHistoricalPanels: completePanels("capacity"),
    addedActionLabels: addedSamples, duplicateActionLabels: count("duplicate"), skippedOverlapActionLabels: count("overlap"),
    capacityDiscardedHistoricalActionLabels: count("capacity"),
    partiallyAddedHistoricalPanels: historyPanels.filter(panel => {
      const count = panel.rows.filter(sample => disposition.get(sample.id) === "added").length;
      return count > 0 && count < DISTRIBUTION_ACTIONS.length;
    }).length,
    mergeGranularity: "ACTION" as const, retainedSamples: merged.samples.length,
    trainingDates: [...new Set(merged.samples.map(sample => new Date(sample.signalAtMs).toISOString().slice(0, 10)))].sort(),
    prospectiveValidationReset: addedSamples > 0, validation: verifyMerged.stats(cutoffMs).validation, brokerOrdersSubmitted: 0 } };
}

function sampleOrder(a: DistributionSample, b: DistributionSample) {
  return a.signalAtMs - b.signalAtMs || a.symbol.localeCompare(b.symbol) || a.actionId.localeCompare(b.actionId);
}
function actionOverlaps(a: DistributionSample, b: DistributionSample): boolean {
  const action = DISTRIBUTION_ACTIONS.find(action => action.id === a.actionId)!;
  const end = (sample: DistributionSample) => Math.max(sample.completedAtMs,
    sample.signalAtMs + action.horizonMs + EFFICIENT_TRAINING_SPEC.completionBufferMs);
  return a.signalAtMs < end(b) && b.signalAtMs < end(a);
}

function panels(samples: readonly DistributionSample[]): Panel[] {
  const grouped = new Map<string, Panel>();
  for (const sample of samples) {
    const id = `${sample.symbol}:${sample.signalAtMs}`;
    const panel = grouped.get(id) ?? { symbol: sample.symbol, signalAtMs: sample.signalAtMs,
      completedAtMs: sample.completedAtMs, rows: [] };
    panel.rows.push(structuredClone(sample)); grouped.set(id, panel);
  }
  for (const panel of grouped.values()) panel.rows.sort((a, b) => a.actionId.localeCompare(b.actionId));
  return [...grouped.values()].sort(panelOrder);
}
function panelOrder(a: Panel, b: Panel) { return a.signalAtMs - b.signalAtMs || a.symbol.localeCompare(b.symbol); }
function overlaps(a: Panel, b: Panel) {
  return a.symbol === b.symbol && a.signalAtMs < Math.max(b.completedAtMs, b.signalAtMs + DISTRIBUTION_SPEC.proposalIntervalMs)
    && b.signalAtMs < Math.max(a.completedAtMs, a.signalAtMs + DISTRIBUTION_SPEC.proposalIntervalMs);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

/** Entry cadence and disconnect recovery change selection evidence, but not the fixed
 * 31-minute training contexts or action outcomes. Accept the exact original
 * v1 training specification as well as the current one; no other differences
 * in costs, support, feature geometry or execution assumptions are ignored. */
function compatibleTrainingSpec(value: unknown): boolean {
  const { evaluationIntervalMs: _cadence, selectionPolicyVersion: _policy, ...legacy } = DISTRIBUTION_SPEC;
  const previous = { ...DISTRIBUTION_SPEC, selectionPolicyVersion: "btc-eth-selected-policy-v2" };
  return canonical(value) === canonical(DISTRIBUTION_SPEC) || canonical(value) === canonical(previous)
    || canonical(value) === canonical(legacy);
}
