export interface DynamicLiquidityConfig {
  maximumSamples: number;
  minimumSamples: number;
  tradeQuantile: number;
  tradeMadMultiple: number;
  stressMadMultiple: number;
  absoluteTradeCapBps: number;
  absoluteStressCapBps: number;
  maximumSpreadZ: number;
  minimumDepthZ: number;
  minimumUsableDepthNotional: number;
  maximumImpactBps: number;
  maximumProviderAgeMs: number;
}

export interface LiquidityInput {
  spreadBps: number;
  spreadZ: number;
  depthZ: number;
  usableDepthNotional: number;
  impactBps: number;
  providerAgeMs: number;
  stale: boolean;
}

export interface LiquidityDecision {
  pass: boolean;
  stress: boolean;
  sampleCount: number;
  medianSpreadBps: number | null;
  tradeThresholdBps: number;
  stressThresholdBps: number;
  reasons: readonly string[];
}

/** Per-symbol, causal spread policy. The current observation never relaxes its own threshold. */
export class DynamicLiquidityPolicy {
  private spreads: number[] = [];
  private cachedThresholds?: {
    sampleCount: number; medianSpreadBps: number | null; tradeThresholdBps: number; stressThresholdBps: number;
  };

  public constructor(private readonly cfg: DynamicLiquidityConfig) {
    if (!Number.isInteger(cfg.maximumSamples) || cfg.maximumSamples < 10) throw new Error("Dynamic liquidity maximumSamples must be at least 10");
    if (!Number.isInteger(cfg.minimumSamples) || cfg.minimumSamples < 2 || cfg.minimumSamples > cfg.maximumSamples) {
      throw new Error("Dynamic liquidity minimumSamples must be between 2 and maximumSamples");
    }
    if (!(cfg.tradeQuantile > 0 && cfg.tradeQuantile <= 1)) throw new Error("Dynamic liquidity tradeQuantile must be in (0,1]");
    if (!(cfg.absoluteStressCapBps >= cfg.absoluteTradeCapBps)) throw new Error("Dynamic liquidity stress cap must cover the trade cap");
  }

  public observe(spreadBps: number): void {
    if (!Number.isFinite(spreadBps) || spreadBps < 0) return;
    this.spreads.push(spreadBps);
    if (this.spreads.length > this.cfg.maximumSamples) this.spreads = this.spreads.slice(-this.cfg.maximumSamples);
    delete this.cachedThresholds;
  }

  public evaluate(input: LiquidityInput): LiquidityDecision {
    const thresholds = this.thresholds();
    const { sampleCount, medianSpreadBps, tradeThresholdBps, stressThresholdBps } = thresholds;
    if (sampleCount < this.cfg.minimumSamples) {
      return {
        pass: false, stress: false, ...thresholds,
        reasons: ["SPREAD_WARMUP"],
      };
    }
    const reasons: string[] = [];
    if (input.stale) reasons.push("FEATURES_STALE");
    if (input.providerAgeMs < 0 || input.providerAgeMs > this.cfg.maximumProviderAgeMs) reasons.push("PROVIDER_AGE_INVALID");
    if (input.spreadBps > tradeThresholdBps) reasons.push("SPREAD_ABOVE_DYNAMIC_TRADE_THRESHOLD");
    if (input.spreadZ > this.cfg.maximumSpreadZ) reasons.push("SPREAD_Z_ABOVE_LIMIT");
    if (input.depthZ < this.cfg.minimumDepthZ || input.usableDepthNotional < this.cfg.minimumUsableDepthNotional) {
      reasons.push("INSUFFICIENT_USABLE_DEPTH");
    }
    if (input.impactBps > this.cfg.maximumImpactBps) reasons.push("IMPACT_ABOVE_LIMIT");
    const stress = input.stale || input.providerAgeMs < 0 || input.providerAgeMs > this.cfg.maximumProviderAgeMs
      || input.spreadBps > stressThresholdBps || input.depthZ < this.cfg.minimumDepthZ
      || input.usableDepthNotional < this.cfg.minimumUsableDepthNotional;
    return { pass: reasons.length === 0, stress, sampleCount, medianSpreadBps, tradeThresholdBps, stressThresholdBps, reasons };
  }

  private thresholds(): NonNullable<DynamicLiquidityPolicy["cachedThresholds"]> {
    if (this.cachedThresholds) return this.cachedThresholds;
    const sampleCount = this.spreads.length;
    if (sampleCount < this.cfg.minimumSamples) {
      this.cachedThresholds = {
        sampleCount, medianSpreadBps: sampleCount ? quantileSorted([...this.spreads].sort((a, b) => a - b), .5) : null,
        tradeThresholdBps: this.cfg.absoluteTradeCapBps, stressThresholdBps: this.cfg.absoluteStressCapBps,
      };
      return this.cachedThresholds;
    }
    const sorted = [...this.spreads].sort((a, b) => a - b);
    const center = quantileSorted(sorted, .5);
    const deviations = sorted.map((value) => Math.abs(value - center)).sort((a, b) => a - b);
    const spreadMad = quantileSorted(deviations, .5);
    const tradeThresholdBps = Math.min(this.cfg.absoluteTradeCapBps, quantileSorted(sorted, this.cfg.tradeQuantile),
      center + this.cfg.tradeMadMultiple * spreadMad);
    const stressThresholdBps = Math.max(tradeThresholdBps,
      Math.min(this.cfg.absoluteStressCapBps, center + this.cfg.stressMadMultiple * spreadMad));
    this.cachedThresholds = { sampleCount, medianSpreadBps: center, tradeThresholdBps, stressThresholdBps };
    return this.cachedThresholds;
  }
}

function quantileSorted(sorted: readonly number[], q: number): number {
  const index = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
  const lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}
