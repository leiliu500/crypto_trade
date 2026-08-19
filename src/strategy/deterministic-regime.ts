import type { DeterministicFeatures } from "./deterministic-features.js";

export type RegimeName = "LIQUIDITY_STRESS" | "REVERSAL_UP" | "REVERSAL_DOWN" | "BREAKOUT_UP" | "BREAKOUT_DOWN" | "TREND_UP" | "TREND_DOWN" | "CHOP" | "UNKNOWN";
export interface RegimeDecision { name: RegimeName; allowLong: boolean; allowShort: boolean; riskScale: number; }
export interface DeterministicRegimeConfig {
  maximumProviderAgeMs: number;
  maximumSpreadBps: number;
  liquidityStressSpreadZ: number;
  liquidityStressDepthZ: number;
  minimumDepthNotional: number;
  trendEfficiency: number;
  chopEfficiency: number;
  maximumTrendFlipRate: number;
  chopFlipRate: number;
  regimeMicroEdgeBps: number;
  regimeQiK: number;
  regimeOfi: number;
  regimeTfi: number;
  regimeVelocityZ: number;
  maximumOpposingAccelerationZ: number;
  breakoutBps: number;
  breakoutCusum: number;
  breakoutOfi: number;
  breakoutTfi: number;
  neutralOfi: number;
  neutralTfi: number;
  hysteresisResetRatio: number;
}

export class DeterministicRegimeEngine {
  private previous: RegimeName = "UNKNOWN";
  public constructor(private readonly cfg: DeterministicRegimeConfig) { validateRegimeConfig(cfg); }

  public classify(features: DeterministicFeatures, dynamicLiquidityStress?: boolean): RegimeDecision {
    if (features.stale || features.providerAgeMs < 0 || features.providerAgeMs > this.cfg.maximumProviderAgeMs
      || (dynamicLiquidityStress ?? features.spreadBps > this.cfg.maximumSpreadBps) || features.spreadZ >= this.cfg.liquidityStressSpreadZ
      || features.depthZ <= -this.cfg.liquidityStressDepthZ || features.usableDepthNotional < this.cfg.minimumDepthNotional) {
      return this.set("LIQUIDITY_STRESS", false, false, 0);
    }
    const up = this.aligned(1, features, 1);
    const down = this.aligned(-1, features, 1);
    const breakoutUp = features.breakoutUpBps >= this.cfg.breakoutBps && features.cusumUpScore >= this.cfg.breakoutCusum
      && features.ofi >= this.cfg.breakoutOfi && features.tfi >= this.cfg.breakoutTfi;
    const breakoutDown = features.breakoutDownBps >= this.cfg.breakoutBps && -features.cusumDownScore >= this.cfg.breakoutCusum
      && -features.ofi >= this.cfg.breakoutOfi && -features.tfi >= this.cfg.breakoutTfi;
    if (breakoutUp !== breakoutDown) return breakoutUp ? this.set("BREAKOUT_UP", true, false, .8) : this.set("BREAKOUT_DOWN", false, true, .8);
    const trendQuality = features.efficiency >= this.cfg.trendEfficiency && features.flowFlipRate <= this.cfg.maximumTrendFlipRate;
    const trendUp = trendQuality && up.flowVotes >= 2 && up.kinematicVotes >= 2;
    const trendDown = trendQuality && down.flowVotes >= 2 && down.kinematicVotes >= 2;
    if (trendUp !== trendDown) return trendUp ? this.set("TREND_UP", true, false, 1) : this.set("TREND_DOWN", false, true, 1);

    // Separate reset thresholds retain a valid directional regime near its enter boundary.
    if (["TREND_UP", "BREAKOUT_UP"].includes(this.previous) && this.retains(1, features)) return this.set("TREND_UP", true, false, .85);
    if (["TREND_DOWN", "BREAKOUT_DOWN"].includes(this.previous) && this.retains(-1, features)) return this.set("TREND_DOWN", false, true, .85);
    const chop = features.efficiency <= this.cfg.chopEfficiency || features.flowFlipRate >= this.cfg.chopFlipRate
      || (Math.abs(features.ofi) < this.cfg.neutralOfi && Math.abs(features.tfi) < this.cfg.neutralTfi);
    return chop ? this.set("CHOP", false, false, 0) : this.set("UNKNOWN", false, false, 0);
  }

  private aligned(direction: 1 | -1, f: DeterministicFeatures, scale: number): { flowVotes: number; kinematicVotes: number } {
    return {
      flowVotes: Number(direction * f.qiK >= scale * this.cfg.regimeQiK) + Number(direction * f.ofi >= scale * this.cfg.regimeOfi) + Number(direction * f.tfi >= scale * this.cfg.regimeTfi),
      kinematicVotes: Number(direction * f.microEdgeBps >= scale * this.cfg.regimeMicroEdgeBps)
        + Number(direction * f.velocityZ >= scale * this.cfg.regimeVelocityZ)
        + Number(direction * f.accelerationZ >= -this.cfg.maximumOpposingAccelerationZ / Math.max(scale, 1e-9)),
    };
  }
  private retains(direction: 1 | -1, f: DeterministicFeatures): boolean {
    const aligned = this.aligned(direction, f, this.cfg.hysteresisResetRatio);
    return f.efficiency >= this.cfg.trendEfficiency * this.cfg.hysteresisResetRatio
      && f.flowFlipRate <= this.cfg.maximumTrendFlipRate / this.cfg.hysteresisResetRatio
      && aligned.flowVotes >= 2 && aligned.kinematicVotes >= 2;
  }
  private set(name: RegimeName, allowLong: boolean, allowShort: boolean, riskScale: number): RegimeDecision {
    this.previous = name; return { name, allowLong, allowShort, riskScale };
  }
}

function validateRegimeConfig(cfg: DeterministicRegimeConfig): void {
  for (const [name, value] of Object.entries(cfg)) if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid deterministic regime configuration: ${name}`);
  if (!(cfg.hysteresisResetRatio > 0 && cfg.hysteresisResetRatio < 1)) throw new Error("hysteresisResetRatio must be in (0,1)");
  if (!(cfg.trendEfficiency > cfg.chopEfficiency && cfg.trendEfficiency <= 1)) throw new Error("trendEfficiency must be above chopEfficiency and at most 1");
  if (!(cfg.maximumTrendFlipRate < cfg.chopFlipRate && cfg.chopFlipRate <= 1)) throw new Error("trend and chop flip thresholds are inconsistent");
}
