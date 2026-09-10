import { createHash } from "node:crypto";
import type { SymbolConfig } from "../config.js";
import { FeatureEngine, type FeatureConfig } from "../core/features.js";
import type { BookFlow, BookState, MarketTrade } from "../core/market.js";
import { BookPressureTracker, DeterministicFeatureExtensions, type ExtensionConfig } from "../strategy/deterministic-features.js";
import { assertDistributionSizingPolicy, distributionSizingId, type DistributionSizingContext, type DistributionSizingPolicy } from "./sizing.js";
import { DISTRIBUTION_SPEC } from "./spec.js";

export const RISK_TRAINING_VERSION = `${DISTRIBUTION_SPEC.version}:risk-bounded-training-backfill-v2`;
export interface RiskBoundedTrainingContext {
  version: "distribution-causal-sizing-features-v1";
  sizingPolicy: DistributionSizingPolicy;
  sizingPolicyId: string;
  equity: number;
  equityHighWater: number;
  symbols: Record<string, { feature: FeatureConfig; deterministicExtension: ExtensionConfig }>;
}
export function trainingContextHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
export function createRiskBoundedTrainingContext(configs: Readonly<Record<string, SymbolConfig>>,
  policy: DistributionSizingPolicy, equity: number, equityHighWater = equity): RiskBoundedTrainingContext {
  const context: RiskBoundedTrainingContext = { version: "distribution-causal-sizing-features-v1",
    sizingPolicy: structuredClone(policy), sizingPolicyId: distributionSizingId(policy), equity, equityHighWater,
    symbols: Object.fromEntries(DISTRIBUTION_SPEC.symbols.map(symbol => {
      const cfg = configs[symbol]; if (!cfg) throw new Error(`RISK_TRAINING_SYMBOL_CONFIG_MISSING:${symbol}`);
      return [symbol, { feature: structuredClone(cfg.feature), deterministicExtension: structuredClone(cfg.deterministicExtension) }];
    })) };
  assertRiskBoundedTrainingContext(context); return context;
}
export function assertRiskBoundedTrainingContext(context: RiskBoundedTrainingContext): void {
  if (!context || context.version !== "distribution-causal-sizing-features-v1"
    || ![context.equity, context.equityHighWater].every(n => Number.isFinite(n) && n > 0)
    || context.equity > context.equityHighWater || !context.symbols
    || Object.keys(context.symbols).sort().join(",") !== [...DISTRIBUTION_SPEC.symbols].sort().join(","))
    throw new Error("INVALID_RISK_TRAINING_CONTEXT");
  assertDistributionSizingPolicy(context.sizingPolicy);
  if (distributionSizingId(context.sizingPolicy) !== context.sizingPolicyId) throw new Error("RISK_TRAINING_SIZING_HASH_MISMATCH");
  for (const symbol of DISTRIBUTION_SPEC.symbols) {
    const cfg = context.symbols[symbol];
    if (!cfg?.feature || !cfg.deterministicExtension
      || Object.values(cfg.feature).some(n => !Number.isFinite(n) || n < 0)
      || Object.values(cfg.deterministicExtension).some(n => !Number.isFinite(n) || n < 0)
      || !Number.isInteger(cfg.feature.depthLevels) || cfg.feature.depthLevels <= 0
      || cfg.feature.forecastHorizonMs <= 0 || cfg.feature.maximumKinematicsGapMs <= 0
      || cfg.deterministicExtension.trendSampleIntervalMs <= 0)
      throw new Error(`INVALID_RISK_TRAINING_FEATURE_CONFIG:${symbol}`);
  }
}
/** Same feature updates as TradingEngine.onBook/onTrade, including trade-clock
 * advancement against an unchanged provider quote. No fabricated market input. */
export class RiskTrainingFeaturePath {
  private readonly runtimes;
  public readonly reference: RiskBoundedTrainingContext;
  public constructor(context: RiskBoundedTrainingContext) {
    assertRiskBoundedTrainingContext(context); this.reference = structuredClone(context);
    this.runtimes = new Map(DISTRIBUTION_SPEC.symbols.map(symbol => {
      const cfg = context.symbols[symbol]!;
      return [symbol as string, { feature: new FeatureEngine(cfg.feature),
        extension: new DeterministicFeatureExtensions(cfg.deterministicExtension),
        pressure: new BookPressureTracker(cfg.feature.depthLevels) }];
    }));
  }
  public onBook(book: BookState, flow: BookFlow): DistributionSizingContext | null {
    const runtime = this.runtimes.get(book.symbol); if (!runtime) return null;
    const base = runtime.feature.onBook(book, flow); if (!base) return null;
    const features = runtime.extension.update(base, runtime.pressure.update(book));
    if (!nestedFinite(features)) throw new Error("RISK_TRAINING_NONFINITE_FEATURES");
    return { equity: this.reference.equity, equityHighWater: this.reference.equityHighWater, features };
  }
  public onTrade(trade: MarketTrade, currentBook: BookState | undefined): void {
    const runtime = this.runtimes.get(trade.symbol); if (!runtime) return;
    runtime.feature.onTrade(trade);
    if (!currentBook?.valid) return;
    const book = { ...currentBook, receiveTsMs: trade.receiveTsMs };
    const base = runtime.feature.onBook(book); if (!base) return;
    const features = runtime.extension.update(base, runtime.pressure.update(book));
    if (!nestedFinite(features)) throw new Error("RISK_TRAINING_NONFINITE_FEATURES");
  }
}
function nestedFinite(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  return !value || typeof value !== "object" || Object.values(value).every(nestedFinite);
}
