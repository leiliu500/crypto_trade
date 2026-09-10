import type { DatabaseHealth } from "../dashboard/types.js";

/** A connected socket alone does not establish progress committing audit records. */
export class PersistenceWatch {
  private backlogSinceMs: number | null = null;
  public constructor(private readonly maximumWriteLagMs: number) {
    if (!Number.isFinite(maximumWriteLagMs) || maximumWriteLagMs <= 0) throw new Error("INVALID_PERSISTENCE_WRITE_LAG");
  }
  public observe(health: DatabaseHealth, nowMs: number): DatabaseHealth {
    if (!Number.isFinite(nowMs) || !Number.isSafeInteger(health.queuedRecords) || health.queuedRecords < 0
      || health.lastPersistedAtMs !== null && (!Number.isFinite(health.lastPersistedAtMs) || health.lastPersistedAtMs > nowMs)) {
      return { ...health, connected: false, status: "degraded", lastError: "INVALID_PERSISTENCE_PROGRESS" };
    }
    if (health.queuedRecords === 0) this.backlogSinceMs = null;
    else this.backlogSinceMs ??= nowMs;
    const progressMs = Math.max(this.backlogSinceMs ?? nowMs, health.lastPersistedAtMs ?? -Infinity);
    if (health.queuedRecords > 0 && nowMs - progressMs >= this.maximumWriteLagMs) {
      return { ...health, connected: false, status: "degraded", lastError: "DATABASE_PERSISTENCE_WRITE_STALLED" };
    }
    return { ...health };
  }
}
