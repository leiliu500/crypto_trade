import type { BookState, MarketTrade } from "../core/market.js";
import type { AssetRules } from "../execution/planner.js";
import { policyQuantity } from "../research/trading-policy.js";
import { ConditionalDistributionModel } from "./model.js";
import { REGIME_DISTRIBUTION_SPEC } from "./regime-model.js";
import { DistributionMarket, distributionBookReason } from "./market.js";
import { DistributionExecutionCase } from "./execution.js";
import { EfficientDistributionTrainer, EFFICIENT_TRAINING_SPEC } from "./efficient-trainer.js";
import { DISTRIBUTION_SPEC as S, DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS,
  distributionEntryProfile, isDistributionEntryProfile, type DistributionEntryProfile, type DistributionDecision, type DistributionSample } from "./spec.js";

interface Batch { decision: DistributionDecision; cases: Array<{ actionId: string; execution: DistributionExecutionCase }> }
export interface ValidationSelection { sampleId: string; signalAtMs: number; completedAtMs: number; netBps: number[];
  decision: DistributionDecision; sample?: DistributionSample }
export interface SelectedPolicyOutcome { sample: DistributionSample; decision: DistributionDecision; valid: boolean }
export type DistributionCosts = Readonly<Record<string, { feeBps: number; reserveBps: number }>>;
export const LEGACY_DISTRIBUTION_TRAINING_VERSION = "btc-eth-common-panel-training-v1";
export interface DistributionTrainingOptions { efficientTraining?: boolean; regimeModel?: boolean }

/** The same controller drives recorded-event replay and the running engine.
 * Training opportunities are collected independently of actual order permissions. */
export class DistributionController {
  private model = new ConditionalDistributionModel();
  private efficient: EfficientDistributionTrainer | null = null;
  private readonly market = new DistributionMarket();
  private readonly pending = new Map<string, Batch>();
  private readonly nextProposal = new Map<string, number>();
  private readonly nextEvaluation = new Map<string, number>();
  private readonly evaluationQuotes = new Map<string, { sequence: bigint; atMs: number; exchangeAtMs: number }>();
  private selectedBatch: Batch | null = null;
  private selectionResults: SelectedPolicyOutcome[] = [];
  private lastSelectionCompletionMs = -Infinity;
  private readonly decisions = new Map<string, DistributionDecision>();
  private readonly samples: DistributionSample[] = [];
  private validationSelections: ValidationSelection[] = [];
  private counters = { evaluations: 0, proposals: 0, selected: 0, completePanels: 0, invalidPanels: 0, invalidSelected: 0 };
  private readonly regimeModel: boolean;
  public constructor(private readonly costs: DistributionCosts, private readonly assets: Record<string, AssetRules> = {},
    private readonly profile: Readonly<DistributionEntryProfile> = distributionEntryProfile(),
    options: DistributionTrainingOptions = {}) {
    if (!isDistributionEntryProfile(profile)) throw new Error("INVALID_DISTRIBUTION_ENTRY_PROFILE");
    if (options.efficientTraining !== undefined && typeof options.efficientTraining !== "boolean") throw new Error("INVALID_DISTRIBUTION_TRAINING_OPTIONS");
    if (options.regimeModel !== undefined && typeof options.regimeModel !== "boolean") throw new Error("INVALID_DISTRIBUTION_TRAINING_OPTIONS");
    if (options.efficientTraining && profile.entryMode !== "PAPER_TRIAL") throw new Error("EFFICIENT_TRAINING_REQUIRES_PAPER_TRIAL");
    if (profile.selectionPolicyVersion === distributionEntryProfile(true, true, true).selectionPolicyVersion && !options.regimeModel) {
      throw new Error("REGIME_MODEL_PROFILE_REQUIRES_OPTION");
    }
    const selectedProfile = distributionEntryProfile(profile.entryMode === "PAPER_TRIAL", options.efficientTraining === true, options.regimeModel === true);
    this.regimeModel = options.regimeModel === true;
    if (!options.efficientTraining && profile.selectionPolicyVersion !== selectedProfile.selectionPolicyVersion) {
      throw new Error("EFFICIENT_TRAINING_PROFILE_REQUIRES_OPTION");
    }
    this.profile = selectedProfile;
    for (const symbol of S.symbols) {
      if (!costs[symbol] || ![costs[symbol]!.feeBps, costs[symbol]!.reserveBps].every(x => Number.isFinite(x) && x >= 0)) {
        throw new Error("INVALID_DISTRIBUTION_COSTS");
      }
    }
    if (options.efficientTraining) this.efficient = new EfficientDistributionTrainer(costs, assets, [], Date.now(), { regimeModel: this.regimeModel });
  }
  public onTrade(trade: MarketTrade): void { this.market.onTrade(trade); }
  public onBook(book: BookState, asset?: AssetRules): { decision: DistributionDecision | null;
    trainingDecision: DistributionDecision | null; samples: DistributionSample[]; selections: SelectedPolicyOutcome[] } {
    if (asset) { this.efficient?.assertAssetRules(asset); this.assets[asset.symbol] = asset; }
    const completed: DistributionSample[] = [];
    const batch = this.pending.get(book.symbol);
    if (batch && this.observeBatch(batch, book)) completed.push(...this.complete(batch, book.receiveTsMs));
    const selected = this.selectedBatch;
    if (selected?.decision.symbol === book.symbol && this.observeBatch(selected, book)) {
      this.completeSelection(selected, book.receiveTsMs);
    }
    const rules = this.assets[book.symbol], previous = this.evaluationQuotes.get(book.symbol);
    const fresh = !previous || (book.sequence > previous.sequence && book.receiveTsMs >= previous.atMs
      && book.exchangeTsMs >= previous.exchangeAtMs);
    const evaluationDue = Boolean(rules) && fresh && book.receiveTsMs >= (this.nextEvaluation.get(book.symbol) ?? -Infinity);
    const trainingDue = Boolean(rules) && (this.efficient ? this.efficient.hasDueTraining(book.symbol, book.receiveTsMs)
      : book.receiveTsMs >= (this.nextProposal.get(book.symbol) ?? -Infinity) && !this.pending.has(book.symbol));
    // Outcome collection observes every book. Inference has its own clock and
    // never waits for the longest uncompleted training action.
    const snapshot = this.market.onBook(book, evaluationDue || trainingDue);
    let trainingDecision: DistributionDecision | null = null;
    const output = (decision: DistributionDecision | null) => ({ decision, trainingDecision,
      samples: completed, selections: this.drainSelections() });
    const contextReady = (evaluationDue || trainingDue) && snapshot?.ready && rules && !distributionBookReason(book);
    const qty = contextReady ? policyQuantity(book.asks[0]!.px, rules) : 0;
    if (!contextReady || !(qty > 0)) {
      if (this.efficient) completed.push(...this.efficient.onBook(book, null));
      return output(null);
    }
    const context: DistributionDecision = { version: S.version, selectionPolicyVersion: this.profile.selectionPolicyVersion,
      entryMode: this.profile.entryMode,
      symbol: book.symbol, atMs: book.receiveTsMs, quoteSequence: String(book.sequence),
      referenceBid: book.bids[0]!.px, referenceAsk: book.asks[0]!.px, requestedQty: qty,
      feeBps: this.costs[book.symbol]!.feeBps, reserveBps: this.costs[book.symbol]!.reserveBps,
      features: [...snapshot.features], estimates: [], actionId: null, reason: "TRAINING_PANEL",
      paperReady: false, validation: this.validation(book.receiveTsMs) };
    if (this.efficient) {
      const before = this.efficient.proposalCount;
      completed.push(...this.efficient.onBook(book, context));
      const started = this.efficient.proposalCount - before;
      this.counters.proposals += started;
      if (started) trainingDecision = structuredClone(context);
    } else if (trainingDue) {
      this.nextProposal.set(book.symbol, book.receiveTsMs + S.proposalIntervalMs);
      this.counters.proposals++;
      this.pending.set(book.symbol, this.makeBatch(context, DISTRIBUTION_ACTIONS, book, rules));
      trainingDecision = structuredClone(context);
    }
    if (!evaluationDue) return output(null);
    this.nextEvaluation.set(book.symbol, book.receiveTsMs + S.evaluationIntervalMs);
    this.evaluationQuotes.set(book.symbol, { sequence: book.sequence, atMs: book.receiveTsMs, exchangeAtMs: book.exchangeTsMs });
    this.counters.evaluations++;
    const estimates = DISTRIBUTION_ACTIONS.map(a => (this.efficient ?? this.model).estimate(book.symbol, a.id, snapshot.features, book.receiveTsMs, this.profile.minimumTrainingDays));
    const best = estimates.filter(e => e.eligible && (rules.shortable || DISTRIBUTION_ACTIONS.find(a => a.id === e.actionId)!.side === 1))
      .sort((a, b) => b.scoreBps! - a.scoreBps! || a.actionId.localeCompare(b.actionId))[0];
    // An opportunity on the completion quote must not reuse that quote as a
    // fresh entry after observing its selected predecessor's outcome.
    const canSelect = !this.selectedBatch && book.receiveTsMs > this.lastSelectionCompletionMs;
    const action = best && canSelect ? DISTRIBUTION_ACTIONS.find(a => a.id === best.actionId)! : null;
    const decision: DistributionDecision = { ...context, estimates, actionId: action?.id ?? null,
      reason: action ? this.profile.entryMode === "PAPER_TRIAL" ? "PAPER_TRIAL_NET_RETURN"
        : context.validation.ready ? "VALIDATED_NET_RETURN" : "PROSPECTIVE_VALIDATION"
        : best ? this.selectedBatch ? "PORTFOLIO_RESEARCH_SLOT" : "SELECTED_PATH_COMPLETED"
          : estimates[0]?.reason ?? "NO_SUPPORTED_ACTION",
      paperReady: Boolean(action && (!this.profile.requiresProspectiveValidation || context.validation.ready)) };
    if (action) { this.selectedBatch = this.makeBatch(decision, [action], book, rules); this.counters.selected++; }
    if (trainingDecision) trainingDecision = structuredClone(decision);
    this.decisions.set(book.symbol, structuredClone(decision));
    return output(decision);
  }
  private makeBatch(decision: DistributionDecision, actions: readonly typeof DISTRIBUTION_ACTIONS[number][],
    book: BookState, rules: AssetRules): Batch {
    return { decision: structuredClone(decision), cases: actions.flatMap(action => DISTRIBUTION_SCENARIOS.map(scenario => ({
      actionId: action.id, execution: new DistributionExecutionCase(action, scenario, book, decision.requestedQty,
        this.costs[book.symbol]!, rules.priceIncrement) }))) };
  }
  private observeBatch(batch: Batch, book: BookState): boolean {
    DistributionExecutionCase.observeAll(batch.cases.map(item => item.execution), book);
    if (batch.cases.some(item => item.execution.snapshot().outcome?.status === "INVALID")) {
      for (const item of batch.cases) item.execution.invalidate(book.receiveTsMs, "JOINT_EXECUTION_PATH_INVALID");
    }
    return batch.cases.every(item => item.execution.snapshot().outcome !== null);
  }
  public drainSelections(): SelectedPolicyOutcome[] {
    const rows = this.selectionResults; this.selectionResults = []; return structuredClone(rows);
  }
  public invalidate(atMs: number, reason: string): DistributionSample[] {
    // Live transport loss and its recorded replay equivalent retain only recent
    // observed prices. Missing/corrupt recorded data still requires full warmup.
    if (reason === "PUBLIC_STREAM_DOWN" || reason === "DISCONNECT") this.market.onDisconnect(atMs);
    else this.market.invalidate();
    this.decisions.clear(); this.evaluationQuotes.clear();
    const output: DistributionSample[] = [];
    if (this.efficient) output.push(...this.efficient.invalidate(atMs, reason));
    for (const batch of [...this.pending.values()]) {
      for (const item of batch.cases) item.execution.invalidate(atMs, reason);
      output.push(...this.complete(batch, atMs));
    }
    if (this.selectedBatch) {
      for (const item of this.selectedBatch.cases) item.execution.invalidate(atMs, reason);
      this.completeSelection(this.selectedBatch, atMs);
    }
    return output;
  }
  public prepareForLive(): void {
    if (this.selectedBatch) this.invalidateValidation();
    this.selectedBatch = null; this.selectionResults = [];
    this.pending.clear(); this.market.invalidate(); this.decisions.clear();
    this.efficient?.prepareForLive();
    this.nextEvaluation.clear(); this.evaluationQuotes.clear();
  }
  public invalidateValidation(): void { this.validationSelections = []; this.decisions.clear(); }
  public exportMarketHistory() { return this.market.exportHistory(); }
  public restoreMarketHistory(value: unknown, cutoffMs: number) {
    if (this.pending.size || this.efficient?.pendingCount || this.selectedBatch) throw new Error("MARKET_HISTORY_REQUIRES_IDLE_CONTROLLER");
    const result = this.market.restoreHistory(value, cutoffMs);
    this.decisions.clear();
    return result;
  }
  public currentDecision(symbol: string): DistributionDecision | null {
    return this.decisions.has(symbol) ? structuredClone(this.decisions.get(symbol)!) : null;
  }
  public stats(nowMs = Date.now()) {
    const efficient = this.efficient?.stats() ?? null;
    return { version: S.version, selectionPolicyVersion: this.profile.selectionPolicyVersion,
      predictionModelVersion: this.regimeModel ? REGIME_DISTRIBUTION_SPEC.version : S.version,
      trainingPolicyVersion: this.trainingPolicyVersion(), trainingMode: this.efficient ? "INDEPENDENT_HORIZONS" : "LEGACY_PANEL",
      entryMode: this.profile.entryMode, minimumTrainingDays: this.profile.minimumTrainingDays,
      minimumValidationDays: S.minimumDays, requiresProspectiveValidation: this.profile.requiresProspectiveValidation,
      evaluationIntervalMs: S.evaluationIntervalMs, trainingIntervalMs: this.efficient ? null : S.proposalIntervalMs,
      trainingIntervals: this.efficient ? EFFICIENT_TRAINING_SPEC.horizons : [], efficientTraining: efficient,
      ...this.counters, pendingPanels: this.pending.size, pendingSelected: this.selectedBatch ? 1 : 0,
      pendingTrainingActions: efficient?.pendingActions ?? this.pending.size * DISTRIBUTION_ACTIONS.length,
      learning: efficient?.learning ?? this.model.stats(), validation: this.validation(nowMs),
      minimumSamples: S.minimumSamples, minimumEffectiveSamples: S.minimumEffectiveSamples,
      minimumDays: this.profile.minimumTrainingDays, minimumValidationSelections: S.minimumValidationSelections,
      markets: S.symbols.map(symbol => ({ symbol, ...this.market.historyStats(symbol, nowMs) })),
      nextProposals: Object.fromEntries(this.nextProposal), nextEvaluations: Object.fromEntries(this.nextEvaluation) };
  }
  private trainingPolicyVersion(): string {
    return this.efficient ? EFFICIENT_TRAINING_SPEC.version : LEGACY_DISTRIBUTION_TRAINING_VERSION;
  }
  private complete(batch: Batch, atMs: number): DistributionSample[] {
    this.pending.delete(batch.decision.symbol);
    const rows = DISTRIBUTION_ACTIONS.map(action => ({ id: `${batch.decision.symbol}:${action.id}:${batch.decision.atMs}`,
      symbol: batch.decision.symbol, actionId: action.id, signalAtMs: batch.decision.atMs, completedAtMs: atMs,
      features: [...batch.decision.features], outcomes: batch.cases.filter(c => c.actionId === action.id)
        .map(c => c.execution.snapshot().outcome!) }));
    const valid = rows.every(row => row.outcomes.every(o => o.status !== "INVALID"));
    if (valid) {
      this.counters.completePanels++;
      for (const row of rows) {
        if (!this.model.observe(row)) throw new Error("DISTRIBUTION_LABEL_CONTRACT");
        this.samples.push(structuredClone(row));
      }
      // Keep the same bounded suffix as the model, separately for each action.
      const seen = new Map<string, number>();
      for (let i = this.samples.length - 1; i >= 0; i--) {
        const row = this.samples[i]!, key = `${row.symbol}|${row.actionId}`, count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count); if (count > S.maximumSamples) this.samples.splice(i, 1);
      }
    } else this.counters.invalidPanels++;
    return rows;
  }
  private completeSelection(batch: Batch, atMs: number): void {
    const d = batch.decision;
    const sample: DistributionSample = { id: `${d.symbol}:${d.actionId}:${d.atMs}`, symbol: d.symbol,
      actionId: d.actionId!, signalAtMs: d.atMs, completedAtMs: atMs, features: [...d.features],
      outcomes: batch.cases.map(c => c.execution.snapshot().outcome!) };
    const valid = sample.outcomes.every(o => o.status !== "INVALID");
    this.selectedBatch = null;
    this.lastSelectionCompletionMs = Math.max(this.lastSelectionCompletionMs, atMs);
    if (valid) {
      this.validationSelections.push({ sampleId: sample.id, signalAtMs: sample.signalAtMs, completedAtMs: atMs,
        netBps: sample.outcomes.map(o => o.netBps!), decision: structuredClone(d), sample: structuredClone(sample) });
      this.validationSelections = this.validationSelections.slice(-S.maximumSamples);
    } else {
      this.invalidateValidation(); this.counters.invalidSelected++;
    }
    // Selected paths belong only to prospective validation. They can overlap
    // training panels and therefore must never enter the model's sample banks.
    this.selectionResults.push({ sample, decision: structuredClone(d), valid });
  }
  private validation(nowMs: number): DistributionDecision["validation"] {
    const rows = this.validationSelections.filter(r => r.completedAtMs <= nowMs
      && nowMs - r.completedAtMs <= 2 * S.memoryHalfLifeMs);
    const dates = [...new Set(rows.map(r => Math.floor(r.signalAtMs / 86_400_000)))];
    let lowerNetBps: number | null = null;
    if (rows.length && dates.length >= 2) {
      lowerNetBps = Math.min(...DISTRIBUTION_SCENARIOS.map((_, index) => {
        const blocks = dates.map(day => {
          const values = rows.filter(r => Math.floor(r.signalAtMs / 86_400_000) === day).map(r => r.netBps[index]!);
          return values.reduce((a, b) => a + b, 0) / values.length;
        });
        const mean = blocks.reduce((a, b) => a + b, 0) / blocks.length;
        const variance = blocks.reduce((a, b) => a + (b - mean) ** 2, 0) / (blocks.length - 1);
        return mean - S.uncertaintyMultiplier * Math.sqrt(Math.max(1, variance) / blocks.length);
      }));
    }
    const last = rows.at(-1)?.completedAtMs;
    return { selections: rows.length, observedDays: dates.length, lowerNetBps,
      ready: rows.length >= S.minimumValidationSelections && dates.length >= S.minimumDays
        && last !== undefined && nowMs - last <= S.maximumTrainingAgeMs
        && lowerNetBps !== null && lowerNetBps > S.minimumScoreBps };
  }
  public exportState() {
    return structuredClone({ version: S.version, selectionPolicyVersion: this.profile.selectionPolicyVersion,
      trainingPolicyVersion: this.trainingPolicyVersion(), efficientTraining: this.efficient?.exportSchedulerState() ?? null,
      costs: this.costs, samples: this.efficient?.exportSamples() ?? this.samples,
      validationSelections: this.validationSelections, counters: this.counters,
      pendingSelections: this.selectedBatch ? [{ symbol: this.selectedBatch.decision.symbol,
        actionId: this.selectedBatch.decision.actionId!, atMs: this.selectedBatch.decision.atMs,
        selectionPolicyVersion: this.profile.selectionPolicyVersion }] : [],
      nextProposals: Object.fromEntries(this.nextProposal), nextEvaluations: Object.fromEntries(this.nextEvaluation),
      selectedSlotUntilMs: null as number | null });
  }
  public restoreState(value: unknown, cutoffMs: number): number {
    const state = value as ReturnType<DistributionController["exportState"]>;
    if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0 || !state || state.version !== S.version || JSON.stringify(state.costs) !== JSON.stringify(this.costs)
      || !Array.isArray(state.samples) || state.samples.length > S.maximumSamples * 12) throw new Error("INVALID_DISTRIBUTION_CHECKPOINT");
    const sourceTrainingVersion = state.trainingPolicyVersion ?? LEGACY_DISTRIBUTION_TRAINING_VERSION;
    const sourceEfficient = sourceTrainingVersion === EFFICIENT_TRAINING_SPEC.version;
    if (sourceTrainingVersion !== LEGACY_DISTRIBUTION_TRAINING_VERSION && !sourceEfficient
      || sourceEfficient && !this.efficient || !sourceEfficient && state.efficientTraining) {
      throw new Error("INCOMPATIBLE_DISTRIBUTION_TRAINING_POLICY");
    }
    const replacement = new ConditionalDistributionModel();
    const panels = new Map<string, DistributionSample[]>();
    for (const sample of state.samples) {
      if (!sample || typeof sample !== "object") throw new Error("INVALID_DISTRIBUTION_CHECKPOINT_LABEL");
      const key = `${sample.symbol}:${sample.signalAtMs}`, rows = panels.get(key) ?? [];
      rows.push(sample); panels.set(key, rows);
    }
    for (const rows of sourceEfficient ? [] : panels.values()) {
      if (rows.length !== DISTRIBUTION_ACTIONS.length || new Set(rows.map(r => r.actionId)).size !== DISTRIBUTION_ACTIONS.length
        || rows.some(r => r.completedAtMs !== rows[0]!.completedAtMs || JSON.stringify(r.features) !== JSON.stringify(rows[0]!.features)
          || !Array.isArray(r.outcomes) || r.outcomes.some((o, i) => o.scenario !== DISTRIBUTION_SCENARIOS[i]?.id))) {
        throw new Error("INVALID_DISTRIBUTION_CHECKPOINT_PANEL");
      }
    }
    for (const sample of state.samples) if (sample.completedAtMs > cutoffMs || !replacement.observe(sample)) throw new Error("INVALID_DISTRIBUTION_CHECKPOINT_LABEL");
    const replacementEfficient = this.efficient ? new EfficientDistributionTrainer(this.costs, this.assets, state.samples, cutoffMs,
      { regimeModel: this.regimeModel }) : null;
    if (replacementEfficient) {
      if (sourceEfficient) replacementEfficient.restoreSchedulerState(state.efficientTraining, cutoffMs);
      else {
        const scheduler = replacementEfficient.exportSchedulerState();
        const legacyClocks = state.nextProposals ?? {};
        if (typeof legacyClocks !== "object" || Array.isArray(legacyClocks)) throw new Error("INVALID_DISTRIBUTION_LEGACY_TRAINING_CLOCK");
        for (const [symbol, next] of Object.entries(legacyClocks)) {
          if (!S.symbols.some(s => s === symbol) || !Number.isSafeInteger(next) || next < 0 || next > cutoffMs + S.proposalIntervalMs) {
            throw new Error("INVALID_DISTRIBUTION_LEGACY_TRAINING_CLOCK");
          }
          const origin = next - S.proposalIntervalMs;
          if (origin >= 0) for (const horizon of EFFICIENT_TRAINING_SPEC.horizons) {
            const key = `${symbol}:${horizon.horizonMs}`;
            scheduler.nextOrigins[key] = Math.max(scheduler.nextOrigins[key] ?? 0, origin + horizon.intervalMs);
          }
        }
        replacementEfficient.restoreSchedulerState(scheduler, cutoffMs);
      }
    }
    if (!Array.isArray(state.validationSelections) || state.validationSelections.length > S.maximumSamples) throw new Error("INVALID_DISTRIBUTION_VALIDATION");
    if (!Array.isArray(state.pendingSelections) || state.pendingSelections.length > 1
      || state.pendingSelections.some(d => !d || !S.symbols.some(s => s === d.symbol) || !DISTRIBUTION_ACTIONS.some(a => a.id === d.actionId)
        || !Number.isSafeInteger(d.atMs) || d.atMs < 0 || d.atMs > cutoffMs)) throw new Error("INVALID_DISTRIBUTION_PENDING_SELECTION");
    const compatible = state.selectionPolicyVersion === this.profile.selectionPolicyVersion
      && sourceTrainingVersion === this.trainingPolicyVersion();
    // Legacy training is portable. Its older selection cadence is a different
    // policy and cannot restore readiness under this decision schedule.
    const validationSelections = compatible ? state.validationSelections : [];
    let previousEnd = -Infinity;
    const validationIds = new Set<string>(), previousSignals = new Map<string, number>();
    for (const row of validationSelections) {
      const sample = row?.sample, d = row?.decision;
      const e = Array.isArray(d?.estimates) ? d.estimates.find(e => e.actionId === d.actionId) : undefined;
      const validEstimates = Array.isArray(d?.estimates) && d.estimates.length === DISTRIBUTION_ACTIONS.length
        && new Set(d.estimates.map(x => x?.actionId)).size === DISTRIBUTION_ACTIONS.length
        && d.estimates.every(x => x && DISTRIBUTION_ACTIONS.some(a => a.id === x.actionId)
          && typeof x.eligible === "boolean" && typeof x.reason === "string"
          && [x.samples, x.observedDays].every(n => Number.isSafeInteger(n) && n >= 0) && x.observedDays <= x.samples
          && Number.isFinite(x.effectiveSamples) && x.effectiveSamples >= 0 && x.effectiveSamples <= x.samples + 1e-8
          && Number.isFinite(x.fillProbability) && x.fillProbability >= 0 && x.fillProbability <= 1
          && [x.meanNetBps, x.lowerMeanNetBps, x.tailLossBps, x.scoreBps].every(n => n === null || Number.isFinite(n)));
      const v = d?.validation;
      const validValidation = v && [v.selections, v.observedDays].every(n => Number.isSafeInteger(n) && n >= 0)
        && v.observedDays <= v.selections && typeof v.ready === "boolean"
        && (v.lowerNetBps === null || Number.isFinite(v.lowerNetBps))
        && (!v.ready || (v.selections >= S.minimumValidationSelections && v.observedDays >= S.minimumDays
          && v.lowerNetBps !== null && v.lowerNetBps > S.minimumScoreBps));
      if (!sample || !d || d.version !== S.version || d.selectionPolicyVersion !== this.profile.selectionPolicyVersion
        || (d.entryMode ?? "VALIDATED") !== this.profile.entryMode
        || d.symbol !== sample.symbol || d.actionId !== sample.actionId || d.atMs !== sample.signalAtMs
        || row.sampleId !== sample.id || row.signalAtMs !== sample.signalAtMs || row.completedAtMs !== sample.completedAtMs
        || sample.completedAtMs > cutoffMs || sample.signalAtMs <= previousEnd
        || sample.signalAtMs < (previousSignals.get(sample.symbol) ?? -Infinity) + S.evaluationIntervalMs
        || validationIds.has(sample.id) || !new ConditionalDistributionModel().observe(sample)
        || sample.outcomes.some((o, i) => o.scenario !== DISTRIBUTION_SCENARIOS[i]?.id)
        || !validEstimates || !validValidation || d.paperReady !== (!this.profile.requiresProspectiveValidation || v.ready)
        || d.reason !== (this.profile.entryMode === "PAPER_TRIAL" ? "PAPER_TRIAL_NET_RETURN"
          : v.ready ? "VALIDATED_NET_RETURN" : "PROSPECTIVE_VALIDATION")
        || !e?.eligible || e.reason !== "POSITIVE_DISTRIBUTIONAL_SCORE" || !Number.isFinite(e.scoreBps)
        || e.scoreBps! <= S.minimumScoreBps || e.observedDays < this.profile.minimumTrainingDays || e.effectiveSamples < S.minimumEffectiveSamples
        || ![e.samples, e.observedDays].every(x => Number.isSafeInteger(x) && x >= 0) || e.samples < S.minimumSamples
        || !Number.isFinite(e.effectiveSamples) || e.effectiveSamples > e.samples + 1e-8
        || ![e.meanNetBps, e.lowerMeanNetBps, e.tailLossBps].every(x => x !== null && Number.isFinite(x))
        || e.tailLossBps! < 0 || e.lowerMeanNetBps! > e.meanNetBps! + 1e-8
        || Math.abs(e.scoreBps! - (e.lowerMeanNetBps! - S.tailPenalty * e.tailLossBps!)) > 1e-8
        || ![d.referenceBid, d.referenceAsk, d.requestedQty].every(x => Number.isFinite(x) && x > 0)
        || d.requestedQty * d.referenceAsk > S.maximumNotional + 1e-8
        || d.referenceBid >= d.referenceAsk || typeof d.quoteSequence !== "string" || !/^\d+$/.test(d.quoteSequence)
        || d.feeBps !== this.costs[d.symbol]?.feeBps || d.reserveBps !== this.costs[d.symbol]?.reserveBps
        || JSON.stringify(d.features) !== JSON.stringify(sample.features)
        || JSON.stringify(row.netBps) !== JSON.stringify(sample.outcomes.map(o => o.netBps))) {
        throw new Error("INVALID_DISTRIBUTION_VALIDATION");
      }
      validationIds.add(sample.id); previousEnd = sample.completedAtMs; previousSignals.set(sample.symbol, sample.signalAtMs);
    }
    if (compatible && state.pendingSelections.some(d => d.selectionPolicyVersion !== this.profile.selectionPolicyVersion
      || d.atMs <= previousEnd || d.atMs < (previousSignals.get(d.symbol) ?? -Infinity) + S.evaluationIntervalMs)) {
      throw new Error("INVALID_DISTRIBUTION_PENDING_SELECTION");
    }
    this.model = replacementEfficient ? new ConditionalDistributionModel() : replacement;
    this.efficient = replacementEfficient;
    this.samples.splice(0, this.samples.length, ...structuredClone(replacementEfficient ? [] : state.samples));
    this.selectedBatch = null;
    this.validationSelections = state.pendingSelections.length ? [] : structuredClone(validationSelections);
    this.nextProposal.clear();
    if (!replacementEfficient) for (const sample of state.samples) this.nextProposal.set(sample.symbol,
      Math.max(this.nextProposal.get(sample.symbol) ?? -Infinity, sample.signalAtMs + S.proposalIntervalMs, sample.completedAtMs));
    this.lastSelectionCompletionMs = cutoffMs;
    this.prepareForLive();
    return state.samples.length;
  }
}
