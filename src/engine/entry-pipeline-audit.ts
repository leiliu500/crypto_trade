export const ENTRY_PIPELINE_STAGES = [
  "MARKET_EVENT",
  "BOOK_READY",
  "FEATURES_READY",
  "DIRECTIONAL_RAW_PASS",
  "DIRECTIONAL_CANDIDATE",
  "HEALTH_PASS",
  "LIQUIDITY_PASS",
  "ANTI_CHASE_PASS",
  "VENUE_DIRECTION_PASS",
  "EXPOSURE_PASS",
  "COOLDOWN_PASS",
  "PRELIMINARY_COST_PASS",
  "SIZE_PASS",
  "EXECUTION_PLAN_PASS",
  "FINAL_COST_PASS",
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
