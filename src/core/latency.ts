import { LatencyHistogram } from "./statistics.js";

export interface LatencyTimestamps {
  exchangeEventMs?: number;
  localReceiptMs?: number;
  featureCompleteMs?: number;
  decisionCompleteMs?: number;
  sentMs?: number;
  acknowledgedMs?: number;
  firstFillMs?: number;
  finalFillMs?: number;
}

export interface LatencyComponents {
  feedMs?: number;
  computeMs?: number;
  sendMs?: number;
  acknowledgmentMs?: number;
  decisionToVenueMs?: number;
  fillMs?: number;
  totalMs?: number;
}

export interface TimedLatencySample { atMs: number; milliseconds: number; }

export function calculateLatency(t: LatencyTimestamps): LatencyComponents {
  const difference = (end?: number, start?: number): number | undefined =>
    end === undefined || start === undefined ? undefined : Math.max(0, end - start);
  const result: LatencyComponents = {};
  const feedMs = difference(t.localReceiptMs, t.exchangeEventMs);
  const computeMs = difference(t.decisionCompleteMs, t.localReceiptMs);
  const sendMs = difference(t.sentMs, t.decisionCompleteMs);
  const acknowledgmentMs = difference(t.acknowledgedMs, t.sentMs);
  const decisionToVenueMs = difference(t.acknowledgedMs, t.decisionCompleteMs);
  const fillMs = difference(t.firstFillMs, t.sentMs);
  const totalMs = difference(t.firstFillMs, t.exchangeEventMs);
  if (feedMs !== undefined) result.feedMs = feedMs;
  if (computeMs !== undefined) result.computeMs = computeMs;
  if (sendMs !== undefined) result.sendMs = sendMs;
  if (acknowledgmentMs !== undefined) result.acknowledgmentMs = acknowledgmentMs;
  if (decisionToVenueMs !== undefined) result.decisionToVenueMs = decisionToVenueMs;
  if (fillMs !== undefined) result.fillMs = fillMs;
  if (totalMs !== undefined) result.totalMs = totalMs;
  return result;
}

export class LatencyTracker {
  private readonly feed = new LatencyHistogram();
  private readonly compute = new LatencyHistogram();
  private readonly send = new LatencyHistogram();
  private readonly acknowledgment = new LatencyHistogram();
  private readonly decisionToVenue = new LatencyHistogram();
  private readonly fill = new LatencyHistogram();
  private readonly total = new LatencyHistogram();
  public record(timestamps: LatencyTimestamps, nowMs: number): void {
    const c = calculateLatency(timestamps);
    if (c.feedMs !== undefined) this.feed.record(c.feedMs, nowMs);
    if (c.computeMs !== undefined) this.compute.record(c.computeMs, nowMs);
    if (c.sendMs !== undefined) this.send.record(c.sendMs, nowMs);
    if (c.acknowledgmentMs !== undefined) this.acknowledgment.record(c.acknowledgmentMs, nowMs);
    if (c.decisionToVenueMs !== undefined) this.decisionToVenue.record(c.decisionToVenueMs, nowMs);
    if (c.fillMs !== undefined) this.fill.record(c.fillMs, nowMs);
    if (c.totalMs !== undefined) this.total.record(c.totalMs, nowMs);
  }
  public restoreDecisionToVenue(samples: readonly TimedLatencySample[]): number {
    let restored = 0;
    for (const sample of samples) {
      if (!Number.isFinite(sample.atMs) || !Number.isFinite(sample.milliseconds) || sample.milliseconds < 0) continue;
      this.decisionToVenue.record(sample.milliseconds, sample.atMs);
      restored += 1;
    }
    return restored;
  }
  public p95Total(nowMs: number): number { return this.total.summary(nowMs).p95; }
  public summary(nowMs: number): Record<string, ReturnType<LatencyHistogram["summary"]>> {
    return { feed: this.feed.summary(nowMs), compute: this.compute.summary(nowMs), send: this.send.summary(nowMs),
      acknowledgment: this.acknowledgment.summary(nowMs), decisionToVenue: this.decisionToVenue.summary(nowMs),
      fill: this.fill.summary(nowMs), total: this.total.summary(nowMs) };
  }
}
