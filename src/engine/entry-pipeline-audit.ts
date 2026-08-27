export const ENTRY_PIPELINE_STAGES = [
  "MARKET_EVENT",
  "BOOK_READY",
  "FEATURES_READY",
  "LIQUIDITY_OBSERVATION",
  "MICRO_EVENT",
  "BOOK_GROUP_PASS",
  "FLOW_GROUP_PASS",
  "MOTION_GROUP_PASS",
  "GROUP_QUORUM_PASS",
  "MICRO_ARMED",
  "MICRO_CANDIDATE",
  "DIRECTIONAL_RAW_PASS",
  "DIRECTIONAL_CANDIDATE",
  "CONTINUATION_FEATURES_READY",
  "SLOW_TREND_PASS",
  "DIRECTION_AUTHORIZATION_PASS",
  "HEALTH_PASS",
  "LIQUIDITY_PASS",
  "VENUE_DIRECTION_PASS",
  "EXPOSURE_PASS",
  "COOLDOWN_PASS",
  "EDGE_RESOLVED",
  "COST_PATHS_RESOLVED",
  "COST_QUALITY_PASS",
  "PRELIMINARY_COST_PASS",
  "ANTI_CHASE_PASS",
  "SIZE_PASS",
  "EXECUTION_PLAN_PASS",
  "FINAL_COST_PASS",
  "FINAL_COST_QUALITY_PASS",
  "PORTFOLIO_PASS",
  "RISK_RESERVED",
  "ORDER_SEND_ATTEMPT",
  "ORDER_ACK",
  "PARTIAL_FILL",
  "FULL_FILL",
] as const;

export type EntryPipelineStage = typeof ENTRY_PIPELINE_STAGES[number];

export interface EntryPipelineRejection {
  stage: EntryPipelineStage;
  reason: string;
  atMs: number;
  values: Readonly<Record<string, number | string | boolean | null>>;
}

export interface EntryPipelineSnapshot {
  counts: Readonly<Record<EntryPipelineStage, number>>;
  lastRejection: EntryPipelineRejection | null;
}

/** Per-symbol monotonic counters and the latest fail-closed entry rejection. */
export class EntryPipelineAudit {
  private readonly counts = Object.fromEntries(ENTRY_PIPELINE_STAGES.map((stage) => [stage, 0])) as Record<EntryPipelineStage, number>;
  private lastRejection: EntryPipelineRejection | null = null;
  private readonly lastEmittedBySignature = new Map<string, number>();

  public pass(stage: EntryPipelineStage): void { this.counts[stage] += 1; }

  /** Returns true when an operational event should be emitted (changed reason or periodic reminder). */
  public reject(stage: EntryPipelineStage, reason: string, atMs: number,
    values: Readonly<Record<string, number | string | boolean | null>> = {}): boolean {
    this.lastRejection = { stage, reason, atMs, values: { ...values } };
    const signature = `${stage}:${reason}`;
    const lastEmittedMs = this.lastEmittedBySignature.get(signature) ?? Number.NEGATIVE_INFINITY;
    const shouldEmit = atMs - lastEmittedMs >= 30_000;
    if (shouldEmit) this.lastEmittedBySignature.set(signature, atMs);
    return shouldEmit;
  }

  public snapshot(): EntryPipelineSnapshot {
    return {
      counts: { ...this.counts },
      lastRejection: this.lastRejection ? { ...this.lastRejection, values: { ...this.lastRejection.values } } : null,
    };
  }
}
