import type { DeterministicTradeIntent, SignalMode } from "./deterministic-entry.js";
import type { DeterministicFeatures } from "./deterministic-features.js";

export interface OptionalModelDecision { accept: boolean; rankingScore: number; sizeMultiplier: number; modelVersion: string; }
export interface OptionalSignalModel { evaluate(features: DeterministicFeatures, intent: DeterministicTradeIntent): OptionalModelDecision; }
export interface RoutedIntent { intent: DeterministicTradeIntent; rankingScore: number; sizeMultiplier: number; modelVersion?: string; }

/** Enforces the invariant that an optional model can never turn null into exposure. */
export class SignalRouter {
  public constructor(private readonly mode: SignalMode, private readonly optionalModel?: OptionalSignalModel) {}
  public route(deterministicIntent: DeterministicTradeIntent | null, features: DeterministicFeatures): RoutedIntent | null {
    if (!deterministicIntent) return null;
    if (this.mode === "DETERMINISTIC_ONLY") return { intent: deterministicIntent, rankingScore: deterministicIntent.deterministicScore, sizeMultiplier: 1 };
    if (!this.optionalModel) return null;
    const model = this.optionalModel.evaluate(features, deterministicIntent);
    if (this.mode === "DETERMINISTIC_WITH_MODEL_VETO" && !model.accept) return null;
    return { intent: deterministicIntent, rankingScore: model.rankingScore, sizeMultiplier: clampUnit(model.sizeMultiplier), modelVersion: model.modelVersion };
  }
}
function clampUnit(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
