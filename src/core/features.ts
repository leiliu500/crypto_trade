import type { BookFlow, BookState, Features, MarketTrade } from "./market.js";
import { clamp } from "./market.js";
import { DecayedSignedFlow, DecayedValue, RobustAgeGate, TimeEwma } from "./statistics.js";

export interface FeatureConfig {
  depthLevels: number;
  depthDecay: number;
  persistenceTauMs: number;
  ofiTauMs: number;
  tradeFlowTauMs: number;
  bookFlowTauMs: number;
  volatilityTauMs: number;
  normalizationTauMs: number;
  efficiencyWindowMs: number;
  forecastHorizonMs: number;
  absoluteMaxProviderAgeMs: number;
  maximumProviderFutureSkewMs: number;
  providerAgeWindowMs: number;
  providerAgeMadMultiplier: number;
  cusumDrift: number;
  cusumThreshold: number;
  minimumWarmupEvents: number;
  minimumWarmupMs: number;
}

export const DEFAULT_FEATURE_CONFIG: FeatureConfig = {
  depthLevels: 10,
  depthDecay: 0.35,
  persistenceTauMs: 1_000,
  ofiTauMs: 2_000,
  tradeFlowTauMs: 2_000,
  bookFlowTauMs: 3_000,
  volatilityTauMs: 30_000,
  normalizationTauMs: 300_000,
  efficiencyWindowMs: 15_000,
  forecastHorizonMs: 5_000,
  absoluteMaxProviderAgeMs: 2_000,
  maximumProviderFutureSkewMs: 100,
  providerAgeWindowMs: 300_000,
  providerAgeMadMultiplier: 6,
  cusumDrift: 0.25,
  cusumThreshold: 5,
  minimumWarmupEvents: 30,
  minimumWarmupMs: 10_000,
};

class AlphaBetaGamma {
  private static readonly MINIMUM_DT_SECONDS = .001;
  private static readonly MAXIMUM_GAP_MS = 5_000;
  private static readonly MAXIMUM_ABSOLUTE_VELOCITY = 1;
  private static readonly MAXIMUM_ABSOLUTE_ACCELERATION = 100;
  private initialized = false;
  private lastMs = 0;
  public x = 0;
  public v = 0;
  public a = 0;
  public constructor(private readonly alpha = .35, private readonly beta = .08, private readonly gamma = .01) {}
  public update(measurement: number, nowMs: number): boolean {
    if (!Number.isFinite(measurement) || !Number.isFinite(nowMs)) return false;
    if (!this.initialized) { this.reset(measurement, nowMs); return true; }
    const elapsedMs = nowMs - this.lastMs;
    if (elapsedMs <= 0) {
      this.x += this.alpha * (measurement - this.x);
      if (!Number.isFinite(this.x)) { this.reset(measurement, nowMs); return false; }
      return true;
    }
    if (elapsedMs > AlphaBetaGamma.MAXIMUM_GAP_MS) { this.reset(measurement, nowMs); return false; }
    const dt = Math.max(elapsedMs / 1000, AlphaBetaGamma.MINIMUM_DT_SECONDS);
    const predictedX = this.x + this.v * dt + .5 * this.a * dt * dt;
    const predictedV = this.v + this.a * dt;
    const residual = measurement - predictedX;
    this.x = predictedX + this.alpha * residual;
    this.v = predictedV + (this.beta / dt) * residual;
    this.a += (2 * this.gamma / (dt * dt)) * residual;
    this.lastMs = nowMs;
    const stable = [this.x, this.v, this.a].every(Number.isFinite)
      && Math.abs(this.v) <= AlphaBetaGamma.MAXIMUM_ABSOLUTE_VELOCITY
      && Math.abs(this.a) <= AlphaBetaGamma.MAXIMUM_ABSOLUTE_ACCELERATION;
    if (!stable) this.reset(measurement, nowMs);
    return stable;
  }
  private reset(measurement: number, nowMs: number): void {
    this.initialized = true;
    this.lastMs = nowMs;
    this.x = measurement;
    this.v = 0;
    this.a = 0;
  }
}

class EfficiencyWindow {
  private points: Array<{ t: number; x: number }> = [];
  private head = 0;
  private pathLength = 0;
  public constructor(private readonly windowMs: number) {}
  public add(t: number, x: number): number {
    const last = this.points.at(-1);
    if (last) this.pathLength += Math.abs(x - last.x);
    this.points.push({ t, x });
    const cutoff = t - this.windowMs;
    while (this.head + 1 < this.points.length && this.points[this.head + 1]!.t < cutoff) {
      this.pathLength -= Math.abs(this.points[this.head + 1]!.x - this.points[this.head]!.x);
      this.head += 1;
    }
    if (this.head > 1024) { this.points = this.points.slice(this.head); this.head = 0; }
    const first = this.points[this.head];
    const current = this.points.at(-1);
    return first && current ? clamp(Math.abs(current.x - first.x) / Math.max(this.pathLength, 1e-12), 0, 1) : 0;
  }
}

class CusumDetector {
  private positive = 0;
  private negative = 0;
  public constructor(private readonly drift: number, private readonly threshold: number) {}
  public update(z: number): { up: boolean; down: boolean } {
    this.positive = Math.max(0, this.positive + z - this.drift);
    this.negative = Math.min(0, this.negative + z + this.drift);
    const up = this.positive > this.threshold;
    const down = this.negative < -this.threshold;
    if (up) this.positive = 0;
    if (down) this.negative = 0;
    return { up, down };
  }
}

export class FeatureEngine {
  private previousBook?: BookState;
  private previousLogMicro?: number;
  private previousReceiveMs?: number;
  private firstReceiveMs?: number;
  private eventCount = 0;
  private previousCompositeSign = 0;

  private readonly ofi: DecayedValue;
  private readonly tradeFlow: DecayedSignedFlow;
  private readonly bidAdds: DecayedValue;
  private readonly bidCancels: DecayedValue;
  private readonly askAdds: DecayedValue;
  private readonly askCancels: DecayedValue;
  private readonly bidReplenishment: DecayedValue;
  private readonly askReplenishment: DecayedValue;
  private readonly flips: DecayedValue;
  private readonly observations: DecayedValue;
  private readonly varianceRate: TimeEwma;
  private readonly spreadStats: TimeEwma;
  private readonly depthStats: TimeEwma;
  private readonly replenishmentStats: TimeEwma;
  private readonly trend = new AlphaBetaGamma();
  private readonly efficiency: EfficiencyWindow;
  private readonly cusum: CusumDetector;
  private readonly ageGate: RobustAgeGate;

  public constructor(private readonly cfg: FeatureConfig = DEFAULT_FEATURE_CONFIG) {
    this.ofi = new DecayedValue(cfg.ofiTauMs);
    this.tradeFlow = new DecayedSignedFlow(cfg.tradeFlowTauMs);
    this.bidAdds = new DecayedValue(cfg.bookFlowTauMs);
    this.bidCancels = new DecayedValue(cfg.bookFlowTauMs);
    this.askAdds = new DecayedValue(cfg.bookFlowTauMs);
    this.askCancels = new DecayedValue(cfg.bookFlowTauMs);
    this.bidReplenishment = new DecayedValue(cfg.bookFlowTauMs);
    this.askReplenishment = new DecayedValue(cfg.bookFlowTauMs);
    this.flips = new DecayedValue(cfg.bookFlowTauMs);
    this.observations = new DecayedValue(cfg.bookFlowTauMs);
    this.varianceRate = new TimeEwma(cfg.volatilityTauMs, 1e-16);
    this.spreadStats = new TimeEwma(cfg.normalizationTauMs, 1e-12);
    this.depthStats = new TimeEwma(cfg.normalizationTauMs, 1e-12);
    this.replenishmentStats = new TimeEwma(cfg.normalizationTauMs, 1e-12);
    this.efficiency = new EfficiencyWindow(cfg.efficiencyWindowMs);
    this.cusum = new CusumDetector(cfg.cusumDrift, cfg.cusumThreshold);
    this.ageGate = new RobustAgeGate(cfg.absoluteMaxProviderAgeMs, cfg.providerAgeWindowMs, cfg.providerAgeMadMultiplier, 20, cfg.maximumProviderFutureSkewMs);
  }

  public onTrade(trade: MarketTrade): void {
    this.tradeFlow.add(trade.aggressor * trade.qty, trade.receiveTsMs);
  }

  public onBook(book: BookState, flow?: BookFlow): Features | null {
    const bid = book.bids[0];
    const ask = book.asks[0];
    if (!bid || !ask || bid.qty <= 0 || ask.qty <= 0 || !(bid.px < ask.px)) return null;
    this.firstReceiveMs ??= book.receiveTsMs;
    this.eventCount += 1;
    if (flow) this.updateBookFlows(flow, book.receiveTsMs);

    const mid = (bid.px + ask.px) / 2;
    const spread = ask.px - bid.px;
    const spreadBps = spread / mid * 10_000;
    const qi1 = (bid.qty - ask.qty) / Math.max(bid.qty + ask.qty, 1e-12);
    const microprice = (ask.px * bid.qty + bid.px * ask.qty) / Math.max(bid.qty + ask.qty, 1e-12);

    let weightedBid = 0, weightedAsk = 0, persistentBid = 0, persistentAsk = 0, visibleDepth = 0;
    const levels = Math.min(this.cfg.depthLevels, book.bids.length, book.asks.length);
    for (let i = 0; i < levels; i += 1) {
      const bidLevel = book.bids[i]!;
      const askLevel = book.asks[i]!;
      const weight = Math.exp(-this.cfg.depthDecay * i);
      weightedBid += weight * bidLevel.qty;
      weightedAsk += weight * askLevel.qty;
      visibleDepth += bidLevel.qty + askLevel.qty;
      persistentBid += weight * this.persistenceAdjusted(bidLevel.qty, bidLevel.ageMs, bidLevel.cancellationHazard);
      persistentAsk += weight * this.persistenceAdjusted(askLevel.qty, askLevel.ageMs, askLevel.cancellationHazard);
    }
    const qiK = (weightedBid - weightedAsk) / Math.max(weightedBid + weightedAsk, 1e-12);
    const persistentQiK = (persistentBid - persistentAsk) / Math.max(persistentBid + persistentAsk, 1e-12);
    this.updateOfi(book, bid, ask);

    const logMicro = Math.log(microprice);
    const kinematicsValid = this.trend.update(logMicro, book.receiveTsMs);
    let cusumState = { up: false, down: false };
    if (this.previousLogMicro !== undefined && this.previousReceiveMs !== undefined) {
      const dtSec = Math.max((book.receiveTsMs - this.previousReceiveMs) / 1000, 1e-4);
      const r = logMicro - this.previousLogMicro;
      const previousVariance = Math.max(this.varianceRate.mean, 1e-16);
      cusumState = this.cusum.update(r / Math.sqrt(previousVariance * dtSec));
      this.varianceRate.update(r * r / dtSec, book.receiveTsMs);
    }

    const varianceRate = Math.max(this.varianceRate.mean, 1e-16);
    const horizonSec = this.cfg.forecastHorizonMs / 1000;
    const sigmaH = Math.sqrt(varianceRate * horizonSec);
    const sigmaHBps = sigmaH * 10_000;
    const velocity = Number.isFinite(this.trend.v) ? this.trend.v : 0;
    const acceleration = Number.isFinite(this.trend.a) ? this.trend.a : 0;
    const microEdgeZ = Math.log(microprice / mid) / Math.max(sigmaH, 1e-8);
    const velocityZ = velocity * horizonSec / Math.max(sigmaH, 1e-8);
    const accelerationZ = .5 * acceleration * horizonSec * horizonSec / Math.max(sigmaH, 1e-8);
    const efficiency = this.efficiency.add(book.receiveTsMs, logMicro);
    const spreadZ = this.spreadStats.zAndUpdate(spreadBps, book.receiveTsMs);
    const depthZ = this.depthStats.zAndUpdate(Math.log(Math.max(visibleDepth, 1e-12)), book.receiveTsMs);

    const bidAdds = this.bidAdds.get(book.receiveTsMs), bidCancels = this.bidCancels.get(book.receiveTsMs);
    const askAdds = this.askAdds.get(book.receiveTsMs), askCancels = this.askCancels.get(book.receiveTsMs);
    const bidCancellationRatio = bidCancels / Math.max(bidAdds + bidCancels, 1e-12);
    const askCancellationRatio = askCancels / Math.max(askAdds + askCancels, 1e-12);
    const rawReplenishment = this.bidReplenishment.get(book.receiveTsMs) - this.askReplenishment.get(book.receiveTsMs);
    const replenishmentPressure = this.replenishmentStats.zAndUpdate(rawReplenishment, book.receiveTsMs);

    const composite = persistentQiK + this.ofi.get(book.receiveTsMs) + this.tradeFlow.ratio(book.receiveTsMs);
    const compositeSign = Math.abs(composite) < .05 ? 0 : Math.sign(composite);
    if (compositeSign !== 0 && this.previousCompositeSign !== 0 && compositeSign !== this.previousCompositeSign) this.flips.add(1, book.receiveTsMs);
    this.observations.add(1, book.receiveTsMs);
    if (compositeSign !== 0) this.previousCompositeSign = compositeSign;
    const signalFlipRate = this.flips.get(book.receiveTsMs) / Math.max(this.observations.get(book.receiveTsMs), 1e-12);

    const rawProviderAgeMs = book.receiveTsMs - book.exchangeTsMs;
    const age = this.ageGate.observe(rawProviderAgeMs, book.receiveTsMs);
    const providerAgeMs = age.adjustedAgeMs;
    const warmedUp = this.eventCount >= this.cfg.minimumWarmupEvents
      && book.receiveTsMs - this.firstReceiveMs >= this.cfg.minimumWarmupMs
      && this.varianceRate.ready && this.spreadStats.ready && this.depthStats.ready;
    const stale = !book.valid || age.stale || !kinematicsValid;

    this.previousBook = book;
    this.previousLogMicro = logMicro;
    this.previousReceiveMs = book.receiveTsMs;
    return finalizeFeatures({
      symbol: book.symbol, mid, spread, spreadBps, microprice, visibleDepth,
      qi1: clamp(qi1, -1, 1), qiK: clamp(qiK, -1, 1), persistentQiK: clamp(persistentQiK, -1, 1),
      ofi: clamp(this.ofi.get(book.receiveTsMs), -10, 10), tfi: clamp(this.tradeFlow.ratio(book.receiveTsMs), -1, 1),
      bidCancellationRatio, askCancellationRatio, replenishmentPressure: clamp(replenishmentPressure, -8, 8),
      velocity, acceleration, varianceRate, sigmaHBps,
      microEdgeZ: clamp(microEdgeZ, -8, 8), velocityZ: clamp(velocityZ, -8, 8), accelerationZ: clamp(accelerationZ, -8, 8),
      efficiency, cusumUp: cusumState.up, cusumDown: cusumState.down, spreadZ, depthZ, signalFlipRate,
      providerAgeMs, staleThresholdMs: age.thresholdMs, warmedUp, stale, receiveTsMs: book.receiveTsMs,
    }, kinematicsValid);
  }

  private persistenceAdjusted(qty: number, ageMs = 0, cancellationHazard = 0): number {
    return qty * Math.min(1, Math.max(0, ageMs) / this.cfg.persistenceTauMs) * (1 - clamp(cancellationHazard, 0, 1));
  }

  private updateBookFlows(flow: BookFlow, nowMs: number): void {
    this.bidAdds.add(flow.bidAdded, nowMs); this.bidCancels.add(flow.bidCanceled, nowMs);
    this.askAdds.add(flow.askAdded, nowMs); this.askCancels.add(flow.askCanceled, nowMs);
    this.bidReplenishment.add(flow.bidReplenishmentRate, nowMs);
    this.askReplenishment.add(flow.askReplenishmentRate, nowMs);
  }

  private updateOfi(book: BookState, bid: { px: number; qty: number }, ask: { px: number; qty: number }): void {
    const previous = this.previousBook;
    if (!previous) return;
    const pb = previous.bids[0], pa = previous.asks[0];
    if (!pb || !pa) return;
    let eventOfi = 0;
    if (bid.px >= pb.px) eventOfi += bid.qty;
    if (bid.px <= pb.px) eventOfi -= pb.qty;
    if (ask.px <= pa.px) eventOfi -= ask.qty;
    if (ask.px >= pa.px) eventOfi += pa.qty;
    const averageTopDepth = (bid.qty + ask.qty + pb.qty + pa.qty) / 4;
    this.ofi.add(eventOfi / Math.max(averageTopDepth, 1e-12), book.receiveTsMs);
  }
}

function finalizeFeatures(features: Features, sourceValid: boolean): Features {
  const normalized = { ...features };
  const values = normalized as unknown as Record<string, unknown>;
  let finite = sourceValid;
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      values[key] = 0;
      finite = false;
    }
  }
  normalized.warmedUp = normalized.warmedUp && finite;
  normalized.stale = normalized.stale || !finite;
  return normalized;
}
