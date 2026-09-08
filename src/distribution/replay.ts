import type { RecordedEvent } from "../backtest/replay.js";
import { LocalOrderBook } from "../core/order-book.js";
import type { AssetRules } from "../execution/planner.js";
import { DistributionController, type SelectedPolicyOutcome } from "./controller.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SCENARIOS, DISTRIBUTION_SPEC,
  type DistributionDecision, type DistributionSample } from "./spec.js";

export interface DistributionReplayOptions {
  validationStartMs: number;
  laterStartMs: number;
  includeOutcomes?: boolean;
}
export type DistributionReplayController = Pick<DistributionController, "onBook" | "onTrade" | "invalidate" | "stats">
  & Partial<Pick<DistributionController, "drainSelections">>;

/** Same controller and complete raw depth/trade paths as live collection. No
 * random split, fill imputation, hindsight action selection, or model promotion. */
export async function replayDistribution(events: AsyncIterable<RecordedEvent> | Iterable<RecordedEvent>,
  costs: Readonly<Record<string, { feeBps: number; reserveBps: number }>>,
  assets: Readonly<Record<string, AssetRules>>, options: DistributionReplayOptions,
  controller: DistributionReplayController = new DistributionController(costs, assets)) {
  if (!Number.isFinite(options.validationStartMs) || !Number.isFinite(options.laterStartMs)
    || options.validationStartMs >= options.laterStartMs) throw new Error("INVALID_DISTRIBUTION_REPLAY_BOUNDARIES");
  const books = new Map<string, LocalOrderBook>();
  const streamTimes = new Map<string, number>();
  const assessment = new StreamingDistributionAssessment(options);
  const decisions: DistributionDecision[] = [], trainingDecisions: DistributionDecision[] = [],
    samples: DistributionSample[] = [], selections: SelectedPolicyOutcome[] = [];
  const acceptSamples = (rows: readonly DistributionSample[]) => {
    assessment.observeTrainingSamples(rows);
    if (options.includeOutcomes) samples.push(...structuredClone(rows));
  };
  const acceptSelections = (rows: readonly SelectedPolicyOutcome[]) => {
    for (const row of rows) assessment.observeSelection(row);
    if (options.includeOutcomes) selections.push(...structuredClone(rows));
  };
  const quality = { events: 0, books: 0, trades: 0, acceptedBooks: 0, duplicates: 0,
    invalidBooks: 0, timestampReversals: 0, crossStreamReceiveRegressions: 0, invalidTimestamps: 0, disconnects: 0,
    recorderGaps: 0, recorderDroppedEvents: 0, firstMs: null as number | null,
    lastMs: null as number | null, maximumEventGapMs: 0,
    invalidBookReasons: {} as Record<string, number>,
    symbols: {} as Record<string, { acceptedBooks: number; resets: number; staleBooks: number; quoteGaps: number;
      maximumQuoteGapMs: number; firstMs: number; lastMs: number }> };
  const invalidate = (now: number, reason: string) => {
    acceptSamples(controller.invalidate(now, reason));
    acceptSelections(controller.drainSelections?.() ?? []);
    for (const book of books.values()) book.invalidate();
  };
  for await (const event of events) {
    quality.events++;
    // Private broker connectivity changes order permission, not the public
    // market path used for hypothetical training outcomes (same as live).
    if (event.kind === "PRIVATE" || (event.kind === "DISCONNECT" && event.stream === "private")) continue;
    if (!["BOOK", "TRADE", "DISCONNECT", "RECORDER_GAP"].includes(event.kind)) throw new Error("INVALID_RECORDED_EVENT_KIND");
    const now = event.kind === "BOOK" ? event.delta.receiveTsMs : event.kind === "TRADE" ? event.trade.receiveTsMs : event.receiveTsMs;
    if (!Number.isFinite(now)) {
      quality.invalidTimestamps++; invalidate(quality.lastMs ?? 0, "INVALID_TIMESTAMP"); continue;
    }
    // Kraken emits each symbol's latest 25 ms book batch in map order, while
    // trades are immediate. Their original receipt timestamps can therefore
    // interleave backwards across streams even though recorder order is causal.
    // Preserve that order; sorting would change what live decisions could see.
    const streamKey = event.kind === "BOOK" ? `BOOK:${event.delta.symbol}` : event.kind === "TRADE" ? `TRADE:${event.trade.symbol}` : null;
    if (streamKey && now < (streamTimes.get(streamKey) ?? -Infinity)) {
      quality.timestampReversals++; invalidate(quality.lastMs ?? now, "RECEIVE_TIMESTAMP_REVERSAL"); continue;
    }
    if (streamKey) streamTimes.set(streamKey, now);
    if (quality.lastMs !== null) {
      quality.crossStreamReceiveRegressions += Number(now < quality.lastMs);
      quality.maximumEventGapMs = Math.max(quality.maximumEventGapMs, now - quality.lastMs);
    }
    quality.firstMs ??= now; quality.lastMs = Math.max(quality.lastMs ?? now, now);
    if (event.kind === "DISCONNECT" || event.kind === "RECORDER_GAP") {
      if (event.kind === "DISCONNECT") quality.disconnects++;
      else { quality.recorderGaps++; quality.recorderDroppedEvents += Math.max(0, event.droppedEvents); }
      invalidate(now, event.kind); continue;
    }
    const symbol = event.kind === "BOOK" ? event.delta.symbol : event.trade.symbol;
    if (!assets[symbol] || !costs[symbol]) continue;
    if (event.kind === "TRADE") { quality.trades++; controller.onTrade(event.trade); continue; }
    quality.books++;
    if (!Number.isFinite(event.delta.exchangeTsMs)) {
      quality.invalidTimestamps++; invalidate(now, "INVALID_EXCHANGE_TIMESTAMP"); continue;
    }
    const local = books.get(symbol) ?? new LocalOrderBook(symbol); books.set(symbol, local);
    const update = local.apply(event.delta);
    if (update.duplicate) { quality.duplicates++; continue; }
    if (!update.accepted || !update.state) {
      quality.invalidBooks++;
      const reason = update.reason ?? "UNKNOWN";
      quality.invalidBookReasons[reason] = (quality.invalidBookReasons[reason] ?? 0) + 1;
      // Controller features are joint BTC/ETH state; either book fault ends all
      // pending paths, but valid peer reconstruction need not lose its snapshot.
      acceptSamples(controller.invalidate(now, `INVALID_BOOK:${reason}`));
      acceptSelections(controller.drainSelections?.() ?? []); continue;
    }
    quality.acceptedBooks++;
    const symbolQuality = quality.symbols[symbol] ?? { acceptedBooks: 0, resets: 0, staleBooks: 0, quoteGaps: 0,
      maximumQuoteGapMs: 0, firstMs: now, lastMs: now };
    const quoteGapMs = now - symbolQuality.lastMs;
    symbolQuality.acceptedBooks++; symbolQuality.resets += Number(update.state.sourceReset);
    symbolQuality.staleBooks += Number(now - update.state.exchangeTsMs > DISTRIBUTION_SPEC.maximumQuoteAgeMs
      || now < update.state.exchangeTsMs);
    symbolQuality.quoteGaps += Number(quoteGapMs > DISTRIBUTION_SPEC.maximumQuoteGapMs);
    symbolQuality.maximumQuoteGapMs = Math.max(symbolQuality.maximumQuoteGapMs, quoteGapMs);
    symbolQuality.lastMs = now; quality.symbols[symbol] = symbolQuality;
    const result = controller.onBook(update.state);
    acceptSamples(result.samples);
    acceptSelections(result.selections ?? []);
    if (result.trainingDecision) {
      assessment.observeTrainingDecision(result.trainingDecision);
      if (options.includeOutcomes) trainingDecisions.push(structuredClone(result.trainingDecision));
    }
    if (result.decision) {
      assessment.observeDecision(result.decision);
      if (options.includeOutcomes) decisions.push(structuredClone(result.decision));
    }
  }
  acceptSamples(controller.invalidate(quality.lastMs ?? 0, "REPLAY_END"));
  acceptSelections(controller.drainSelections?.() ?? []);
  const result = assessment.finish();
  return { version: `${DISTRIBUTION_SPEC.version}:raw-replay-v2`, spec: DISTRIBUTION_SPEC,
    actions: DISTRIBUTION_ACTIONS, scenarios: DISTRIBUTION_SCENARIOS, costs, assets,
    boundaries: { validationStartMs: options.validationStartMs, laterStartMs: options.laterStartMs },
    quality, learning: controller.stats(quality.lastMs ?? 0), ...result,
    outcomeRetention: { mode: options.includeOutcomes ? "FULL_OUTCOMES" : "STREAMING_AGGREGATES",
      retainedInferenceDecisions: decisions.length, retainedTrainingSamples: samples.length,
      retainedSelectedOutcomes: selections.length },
    deploymentReady: false, profitabilityEstablished: false,
    brokerOrdersSubmitted: 0,
    assumptions: [
      "Rebuilt recorded level-2 snapshots/deltas and trades; no quote-only depth substitutes or event downsampling",
      "Recorded engine-emission order is preserved: Kraken batches books across symbols so original receipt timestamps can interleave backwards; true per-symbol/per-stream reversals invalidate",
      "The same causal controller learns only completed preceding paths and freezes each decision before future observations",
      "Inference runs on fresh books at most once per second per symbol; six-action training panels retain their independent 31-minute nonoverlap schedule",
      "All six actions and three execution stresses share each training opportunity; common action comparisons exclude an entire training panel if any path is invalid or missing",
      "Selected policy outcomes run independently of training panels and never supply training labels; their shared portfolio slot lasts until all three execution scenarios finish",
      "Training panels crossing the later-period boundary are purged jointly; selected decisions are purged only when their own selected path crosses that boundary",
      "Selected invalid/missing outcomes are reported separately and never replaced by zero; actual nonfills and flat decisions earn zero",
      "Action rows are prespecified diagnostics, not hindsight-selected strategies; matched actions and scenarios are dependent",
      "Configured paper fees, current supplied instrument rules and execution/funding reserve; no observed funding cash flows or exchange-sequence guarantee",
      "Selected actions share the controller's global research slot; outcomes remain simulated and do not include actual account capital constraints or live fills",
      "Selected mean includes zero for flat inference decisions; selected-action mean uses selected decisions only, and neither is account P&L or an annualized return",
      "Selected-action returns include prospective research selections; paper-eligible counts require the controller's separate completed selected-policy validation and still precede live risk/liquidity permissions",
      "Default replay keeps running aggregates and at most two pending training panels plus one selected policy; full per-inference decisions require explicit includeOutcomes",
      "Recorded data was already available during design; the later chronological period is not an untouched holdout",
      "No trading orders or model installation are performed; zero selected fills do not establish profit",
    ], ...(options.includeOutcomes ? { decisions, trainingDecisions, samples, selections } : {}) };
}

type ReplayPeriod = "VALIDATION" | "LATER";
interface SelectedAggregate {
  period: ReplayPeriod; symbol: string; scenario: string; originalOpportunities: number;
  boundaryPurged: number; evaluatedOpportunities: number; selectedActions: number;
  paperEligibleDecisions: number; paperEligibleFilled: number; paperEligibleInvalidOrMissing: number;
  selectedInvalidOrMissing: number; selectedPolicyInvalid: number;
  flat: number; filled: number; unfilled: number; netSum: number; dates: Set<number>;
}
interface ActionAggregate {
  period: ReplayPeriod; symbol: string; scenario: string; actionId: string;
  commonOpportunities: number; filled: number; unfilled: number; netSum: number; dates: Set<number>;
}

/** Inference may emit hundreds of thousands of decisions per day. Keep only
 * unresolved ex-ante selections/panels; completed paths reduce into fixed rows. */
class StreamingDistributionAssessment {
  private readonly training = new Map<string, Pick<DistributionDecision, "symbol" | "atMs">>();
  private selection: DistributionDecision | null = null;
  private readonly selected: SelectedAggregate[] = [];
  private readonly comparisons: ActionAggregate[] = [];
  private readonly decisionReasons: Record<string, number> = {};
  private readonly sampleInvalidReasons: Record<string, number> = {};
  private readonly selectedInvalidReasons: Record<string, number> = {};
  private opportunities = 0;
  private inferenceDecisions = 0;
  private selectedDecisions = 0;
  private selectedOutcomes = 0;
  private missingSelectedOutcomes = 0;
  private complete = 0;
  private incomplete = 0;
  private purged = 0;
  private maximumPendingTrainingPanels = 0;
  private maximumPendingSelections = 0;

  public constructor(private readonly options: Pick<DistributionReplayOptions, "validationStartMs" | "laterStartMs">) {
    for (const period of ["VALIDATION", "LATER"] as const) for (const symbol of DISTRIBUTION_SPEC.symbols) {
      for (const scenario of DISTRIBUTION_SCENARIOS) {
        this.selected.push({ period, symbol, scenario: scenario.id, originalOpportunities: 0, boundaryPurged: 0,
          evaluatedOpportunities: 0, selectedActions: 0, paperEligibleDecisions: 0, paperEligibleFilled: 0,
          paperEligibleInvalidOrMissing: 0, selectedInvalidOrMissing: 0, selectedPolicyInvalid: 0,
          flat: 0, filled: 0, unfilled: 0, netSum: 0, dates: new Set() });
        for (const action of DISTRIBUTION_ACTIONS) this.comparisons.push({ period, symbol, scenario: scenario.id,
          actionId: action.id, commonOpportunities: 0, filled: 0, unfilled: 0, netSum: 0, dates: new Set() });
      }
    }
  }
  public observeTrainingDecision(decision: DistributionDecision): void {
    if (this.training.has(decision.symbol)) throw new Error("REPLAY_OVERLAPPING_TRAINING_PANEL");
    this.opportunities++;
    this.training.set(decision.symbol, { symbol: decision.symbol, atMs: decision.atMs });
    this.maximumPendingTrainingPanels = Math.max(this.maximumPendingTrainingPanels, this.training.size);
  }
  public observeTrainingSamples(samples: readonly DistributionSample[]): void {
    const panels = new Map<string, DistributionSample[]>();
    for (const sample of samples) {
      const key = `${sample.symbol}|${sample.signalAtMs}`, group = panels.get(key) ?? [];
      group.push(sample); panels.set(key, group);
      for (const outcome of sample.outcomes) if (outcome.status === "INVALID") {
        this.sampleInvalidReasons[outcome.reason] = (this.sampleInvalidReasons[outcome.reason] ?? 0) + 1;
      }
    }
    for (const panel of panels.values()) {
      const decision = this.training.get(panel[0]!.symbol);
      if (!decision || decision.atMs !== panel[0]!.signalAtMs) throw new Error("REPLAY_TRAINING_PANEL_WITHOUT_DECISION");
      this.completeTraining(decision, panel);
    }
  }
  private completeTraining(decision: Pick<DistributionDecision, "symbol" | "atMs">, paths: readonly DistributionSample[]) {
    this.training.delete(decision.symbol);
    const complete = paths.length === DISTRIBUTION_ACTIONS.length
      && DISTRIBUTION_ACTIONS.every(a => paths.filter(p => p.actionId === a.id).length === 1)
      && paths.every(p => p.outcomes.length === DISTRIBUTION_SCENARIOS.length
        && DISTRIBUTION_SCENARIOS.every(s => p.outcomes.filter(o => o.scenario === s.id).length === 1)
        && p.outcomes.every(o => o.status !== "INVALID" && Number.isFinite(o.netBps)));
    if (complete) this.complete++; else this.incomplete++;
    const period = this.period(decision.atMs);
    const crossed = period === "VALIDATION" && paths.some(path => this.crossesBoundary(path));
    if (crossed) this.purged++;
    if (!period || crossed || !complete) return;
    for (const row of this.comparisons) if (row.period === period && row.symbol === decision.symbol) {
      const outcome = paths.find(path => path.actionId === row.actionId)!.outcomes.find(o => o.scenario === row.scenario)!;
      row.commonOpportunities++;
      row.filled += Number(outcome.status === "FILLED"); row.unfilled += Number(outcome.status === "UNFILLED");
      row.netSum += outcome.netBps!; row.dates.add(Math.floor(decision.atMs / 86_400_000));
    }
  }
  public observeDecision(decision: DistributionDecision): void {
    this.inferenceDecisions++;
    this.decisionReasons[decision.reason] = (this.decisionReasons[decision.reason] ?? 0) + 1;
    if (decision.actionId !== null) {
      if (this.selection) throw new Error("REPLAY_OVERLAPPING_SELECTED_POLICY");
      this.selection = structuredClone(decision); this.selectedDecisions++;
      this.maximumPendingSelections = Math.max(this.maximumPendingSelections, 1);
    }
    const period = this.period(decision.atMs);
    for (const row of this.selected) if (row.period === period && row.symbol === decision.symbol) {
      row.originalOpportunities++;
      if (decision.actionId === null) {
        row.evaluatedOpportunities++; row.flat++; row.dates.add(Math.floor(decision.atMs / 86_400_000));
      }
    }
  }
  public observeSelection(outcome: SelectedPolicyOutcome): void {
    const original = this.selection, d = outcome.decision, sample = outcome.sample;
    if (!original || d.symbol !== original.symbol || d.atMs !== original.atMs || d.actionId !== original.actionId
      || sample.symbol !== original.symbol || sample.signalAtMs !== original.atMs || sample.actionId !== original.actionId
      || JSON.stringify(d) !== JSON.stringify(original) || JSON.stringify(sample.features) !== JSON.stringify(original.features)) {
      throw new Error("REPLAY_SELECTED_OUTCOME_WITHOUT_EX_ANTE_DECISION");
    }
    this.selectedOutcomes++;
    for (const path of sample.outcomes) if (path.status === "INVALID") {
      this.selectedInvalidReasons[path.reason] = (this.selectedInvalidReasons[path.reason] ?? 0) + 1;
    }
    this.completeSelection(original, outcome);
  }
  private completeSelection(decision: DistributionDecision, result: SelectedPolicyOutcome | null) {
    this.selection = null;
    const period = this.period(decision.atMs);
    const crossed = period === "VALIDATION" && result !== null && this.crossesBoundary(result.sample);
    for (const row of this.selected) if (row.period === period && row.symbol === decision.symbol) {
      if (crossed) { row.boundaryPurged++; continue; }
      row.evaluatedOpportunities++; row.selectedActions++;
      row.paperEligibleDecisions += Number(decision.paperReady);
      row.selectedPolicyInvalid += Number(!result?.valid);
      row.dates.add(Math.floor(decision.atMs / 86_400_000));
      const paths = result?.sample.outcomes.filter(outcome => outcome.scenario === row.scenario) ?? [];
      const path = paths.length === 1 ? paths[0] : undefined;
      if (!path || path.status === "INVALID" || !Number.isFinite(path.netBps)) {
        row.selectedInvalidOrMissing++;
        row.paperEligibleInvalidOrMissing += Number(decision.paperReady);
      } else {
        row.netSum += path.netBps!;
        row.filled += Number(path.status === "FILLED"); row.unfilled += Number(path.status === "UNFILLED");
        row.paperEligibleFilled += Number(decision.paperReady && path.status === "FILLED");
      }
    }
  }
  public finish() {
    for (const pending of this.training.values()) this.completeTraining(pending, []);
    if (this.selection) { this.missingSelectedOutcomes++; this.completeSelection(this.selection, null); }
    return { opportunities: this.opportunities, trainingOpportunities: this.opportunities,
      inferenceDecisions: this.inferenceDecisions, selectedDecisions: this.selectedDecisions,
      selectedOutcomes: this.selectedOutcomes, missingSelectedOutcomes: this.missingSelectedOutcomes,
      completeCommonOpportunities: this.complete, incompleteOrInvalidOpportunities: this.incomplete,
      boundaryPurgedOpportunities: this.purged,
      decisionReasons: this.decisionReasons, sampleInvalidReasons: this.sampleInvalidReasons,
      selectedInvalidReasons: this.selectedInvalidReasons,
      maximumPendingTrainingPanels: this.maximumPendingTrainingPanels,
      maximumPendingSelections: this.maximumPendingSelections,
      selected: this.selected.map(({ netSum, dates, ...row }) => ({ ...row,
        selectedMeanNetBps: row.selectedInvalidOrMissing || !row.evaluatedOpportunities ? null : netSum / row.evaluatedOpportunities,
        selectedActionMeanNetBps: row.selectedInvalidOrMissing || !row.selectedActions ? null : netSum / row.selectedActions,
        flatMeanNetBps: row.evaluatedOpportunities ? 0 : null, observedDays: dates.size })),
      actionComparisons: this.comparisons.map(({ netSum, dates, ...row }) => ({ ...row,
        meanNetBps: row.commonOpportunities ? netSum / row.commonOpportunities : null,
        flatMeanNetBps: row.commonOpportunities ? 0 : null, observedDays: dates.size })),
    };
  }
  private period(atMs: number): ReplayPeriod | null {
    return atMs < this.options.validationStartMs ? null : atMs < this.options.laterStartMs ? "VALIDATION" : "LATER";
  }
  private crossesBoundary(sample: DistributionSample): boolean {
    return sample.completedAtMs >= this.options.laterStartMs || sample.outcomes.some(o => o.exitAtMs >= this.options.laterStartMs);
  }
}

/** Legacy batch assessment for previously exported panel-per-decision reports.
 * Current raw replay uses the streaming assessment above with separate clocks. */
export function assessDistributionReplay(decisions: readonly DistributionDecision[], samples: readonly DistributionSample[],
  options: Pick<DistributionReplayOptions, "validationStartMs" | "laterStartMs">) {
  const grouped = new Map<string, DistributionSample[]>();
  for (const sample of samples) {
    const key = `${sample.symbol}|${sample.signalAtMs}`;
    const group = grouped.get(key) ?? []; group.push(sample); grouped.set(key, group);
  }
  const opportunities = decisions.map(decision => {
    const paths = grouped.get(`${decision.symbol}|${decision.atMs}`) ?? [];
    const complete = paths.length === DISTRIBUTION_ACTIONS.length
      && DISTRIBUTION_ACTIONS.every(a => paths.filter(p => p.actionId === a.id).length === 1)
      && paths.every(p => p.outcomes.length === DISTRIBUTION_SCENARIOS.length
        && DISTRIBUTION_SCENARIOS.every(s => p.outcomes.filter(o => o.scenario === s.id).length === 1)
        && p.outcomes.every(o => o.status !== "INVALID" && Number.isFinite(o.netBps)));
    const boundaryCrossed = decision.atMs < options.laterStartMs
      && paths.some(p => p.completedAtMs >= options.laterStartMs || p.outcomes.some(o => o.exitAtMs >= options.laterStartMs));
    return { decision, paths, complete, boundaryCrossed };
  });
  const periods = ["VALIDATION", "LATER"] as const;
  const selected = [], actionComparisons = [];
  for (const period of periods) for (const symbol of DISTRIBUTION_SPEC.symbols) {
    const original = opportunities.filter(o => o.decision.symbol === symbol && o.decision.atMs >= options.validationStartMs
      && (period === "VALIDATION" ? o.decision.atMs < options.laterStartMs : o.decision.atMs >= options.laterStartMs));
    const notCrossed = original.filter(o => !o.boundaryCrossed);
    const common = notCrossed.filter(o => o.complete);
    for (const scenario of DISTRIBUTION_SCENARIOS) {
      const values = notCrossed.map(o => {
        if (o.decision.actionId === null) return { status: "FLAT", netBps: 0 };
        const path = o.paths.find(p => p.actionId === o.decision.actionId);
        const outcome = path?.outcomes.find(outcome => outcome.scenario === scenario.id);
        return outcome?.status !== "INVALID" && outcome && Number.isFinite(outcome.netBps)
          ? { status: outcome.status, netBps: outcome.netBps! } : { status: "INVALID", netBps: null };
      });
      const valid = values.filter(v => v.netBps !== null);
      const commonSelected = common.map(o => o.decision.actionId === null ? 0
        : o.paths.find(p => p.actionId === o.decision.actionId)!.outcomes.find(out => out.scenario === scenario.id)!.netBps!);
      selected.push({ period, symbol, scenario: scenario.id, originalOpportunities: original.length,
        boundaryPurged: original.length - notCrossed.length, evaluatedOpportunities: notCrossed.length,
        selectedActions: notCrossed.filter(o => o.decision.actionId !== null).length,
        paperEligibleDecisions: notCrossed.filter(o => o.decision.paperReady).length,
        paperEligibleFilled: notCrossed.filter((o, index) => o.decision.paperReady && values[index]!.status === "FILLED").length,
        paperEligibleInvalidOrMissing: notCrossed.filter((o, index) => o.decision.paperReady && values[index]!.status === "INVALID").length,
        selectedInvalidOrMissing: values.filter(v => v.status === "INVALID").length,
        selectedWithIncompletePanel: notCrossed.filter(o => o.decision.actionId !== null && !o.complete).length,
        flat: values.filter(v => v.status === "FLAT").length, filled: values.filter(v => v.status === "FILLED").length,
        unfilled: values.filter(v => v.status === "UNFILLED").length,
        // Full original-denominator selected mean is unknowable with missing selected paths.
        selectedMeanNetBps: valid.length !== values.length || !values.length ? null : mean(valid.map(v => v.netBps!)),
        commonOpportunities: common.length, commonSelectedMeanNetBps: mean(commonSelected), flatMeanNetBps: common.length ? 0 : null,
        observedDays: new Set(common.map(o => Math.floor(o.decision.atMs / 86_400_000))).size });
      for (const action of DISTRIBUTION_ACTIONS) {
        const outcomes = common.map(o => o.paths.find(p => p.actionId === action.id)!.outcomes.find(out => out.scenario === scenario.id)!);
        actionComparisons.push({ period, symbol, scenario: scenario.id, actionId: action.id,
          commonOpportunities: outcomes.length, filled: outcomes.filter(o => o.status === "FILLED").length,
          unfilled: outcomes.filter(o => o.status === "UNFILLED").length,
          meanNetBps: mean(outcomes.map(o => o.netBps!)), flatMeanNetBps: outcomes.length ? 0 : null });
      }
    }
  }
  return { opportunities: opportunities.length, completeCommonOpportunities: opportunities.filter(o => o.complete).length,
    incompleteOrInvalidOpportunities: opportunities.filter(o => !o.complete).length,
    boundaryPurgedOpportunities: opportunities.filter(o => o.boundaryCrossed && o.decision.atMs >= options.validationStartMs).length,
    decisionReasons: decisions.reduce((counts, d) => { counts[d.reason] = (counts[d.reason] ?? 0) + 1; return counts; }, {} as Record<string, number>),
    sampleInvalidReasons: samples.flatMap(s => s.outcomes).filter(o => o.status === "INVALID").reduce((counts, o) => {
      counts[o.reason] = (counts[o.reason] ?? 0) + 1; return counts; }, {} as Record<string, number>),
    selected, actionComparisons };
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
