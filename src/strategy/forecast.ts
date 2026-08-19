import type { Direction, Features } from "../core/market.js";
import { clamp, sigmoid } from "../core/market.js";
import { quantile, RollingWindow } from "../core/statistics.js";

export interface LinearHead { intercept: number; weights: readonly number[]; }
export interface ForecastConfig {
  alphaDecayTauMs: number;
  intendedHoldMs: number;
  residualWindowMs: number;
  fallbackResidualQ95Bps: number;
}
export interface Forecast {
  side: Direction;
  probability: number;
  pUp: number;
  grossAtObservationBps: number;
  grossAtArrivalBps: number;
  residualQ95Bps: number;
  horizonMs: number;
  expectedLatencyMs: number;
  expired: boolean;
  vector: readonly number[];
}

export function featureVector(f: Features): number[] {
  return [
    f.microEdgeZ, f.qi1, f.qiK, f.persistentQiK, f.ofi, f.tfi,
    f.bidCancellationRatio - f.askCancellationRatio, f.replenishmentPressure,
    f.velocityZ, f.accelerationZ, f.efficiency, f.cusumUp ? 1 : f.cusumDown ? -1 : 0,
    -f.spreadZ, f.depthZ, -f.signalFlipRate,
  ].map((value) => clamp(value, -8, 8));
}

export function dot(weights: readonly number[], values: readonly number[]): number {
  if (weights.length !== values.length) throw new Error(`Model dimension mismatch: ${weights.length} != ${values.length}`);
  return weights.reduce((total, weight, index) => total + weight * values[index]!, 0);
}

export class ForecastEngine {
  private readonly residuals: RollingWindow;
  public constructor(
    private readonly probabilityHead: LinearHead,
    private readonly returnHead: LinearHead,
    private readonly cfg: ForecastConfig,
  ) { this.residuals = new RollingWindow(cfg.residualWindowMs, 20_000); }

  public evaluate(features: Features, expectedLatencyMs: number): Forecast {
    const vector = featureVector(features);
    const pUp = sigmoid(this.probabilityHead.intercept + dot(this.probabilityHead.weights, vector));
    const signedGrossBps = this.returnHead.intercept + dot(this.returnHead.weights, vector);
    const side: Direction = signedGrossBps >= 0 ? 1 : -1;
    const probability = side === 1 ? pUp : 1 - pUp;
    const decay = Math.exp(-Math.max(0, expectedLatencyMs) / this.cfg.alphaDecayTauMs);
    const halfLifeMs = this.cfg.alphaDecayTauMs * Math.log(2);
    const errors = this.residuals.snapshot(features.receiveTsMs);
    return {
      side, probability, pUp,
      grossAtObservationBps: Math.abs(signedGrossBps),
      grossAtArrivalBps: Math.abs(signedGrossBps) * decay,
      residualQ95Bps: errors.length >= 30 ? quantile(errors, .95) : this.cfg.fallbackResidualQ95Bps,
      horizonMs: expectedLatencyMs + this.cfg.intendedHoldMs,
      expectedLatencyMs,
      expired: expectedLatencyMs > halfLifeMs,
      vector,
    };
  }

  public recordOutcome(predictedSignedBps: number, realizedSignedBps: number, nowMs: number): void {
    this.residuals.add(Math.abs(realizedSignedBps - predictedSignedBps), nowMs);
  }
}

/** Recursive least squares for offline/shadow adaptation after delayed labels mature. */
export class RecursiveLeastSquares {
  private readonly theta: number[];
  private readonly covariance: number[][];
  public constructor(dimension: number, private readonly forgettingFactor = .999, initialVariance = 1_000) {
    this.theta = Array.from({ length: dimension }, () => 0);
    this.covariance = Array.from({ length: dimension }, (_, i) => Array.from({ length: dimension }, (_, j) => i === j ? initialVariance : 0));
  }
  public predict(x: readonly number[]): number { return dot(this.theta, x); }
  public update(x: readonly number[], y: number): void {
    if (x.length !== this.theta.length) throw new Error("RLS model dimension mismatch");
    const px = this.covariance.map((row) => dot(row, x));
    const denominator = this.forgettingFactor + dot(x, px);
    const gain = px.map((value) => value / Math.max(denominator, 1e-12));
    const error = y - this.predict(x);
    for (let i = 0; i < this.theta.length; i += 1) this.theta[i] = this.theta[i]! + gain[i]! * error;
    const xTP = this.covariance[0]!.map((_, column) => this.covariance.reduce((sum, row, index) => sum + x[index]! * row[column]!, 0));
    for (let i = 0; i < this.theta.length; i += 1) {
      for (let j = 0; j < this.theta.length; j += 1) {
        this.covariance[i]![j] = (this.covariance[i]![j]! - gain[i]! * xTP[j]!) / this.forgettingFactor;
      }
    }
  }
  public coefficients(): readonly number[] { return this.theta; }
}
