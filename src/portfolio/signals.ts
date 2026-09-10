import { createHash } from "node:crypto";
import { PORTFOLIO_DAY_MS as DAY, PORTFOLIO_HOUR_MS as HOUR, PORTFOLIO_SPEC as SPEC,
  PORTFOLIO_SYMBOLS as SYMBOLS, PORTFOLIO_VERSION, type HourlyBar, type Pair,
  type PortfolioPolicy, type PortfolioSignal, type PortfolioTarget } from "./types.js";

const POLICIES: readonly PortfolioPolicy[] = ["multiscale-trend", "sign-trend-90d", "constant-btc", "constant-eth", "flat"];
const REQUIRED_CLOSES = Math.max(...SPEC.trendLookbackDays) + 1;
interface DailyBucket { count: number; close: number | null }
interface DailyPair { decisionMs: number; closes: Pair<number> }
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;

function validateBar(bar: HourlyBar): void {
  if (!bar || !SYMBOLS.includes(bar.symbol) || !validTime(bar.openMs) || bar.openMs % HOUR !== 0
    || !validTime(bar.openMs + HOUR)
    || ![bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(value) && value > 0)
    || !Number.isFinite(bar.volume) || bar.volume < 0 || bar.low > Math.min(bar.open, bar.close)
    || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high) throw new Error("PORTFOLIO_SIGNALS_INVALID_BAR");
}

function dailyPairs(bars: readonly HourlyBar[]): DailyPair[] {
  const seen = new Set<string>();
  const days: Pair<Map<number, DailyBucket>> = { "BTC/USD": new Map(), "ETH/USD": new Map() };
  for (const bar of bars) {
    validateBar(bar);
    const key = `${bar.symbol}:${bar.openMs}`;
    if (seen.has(key)) throw new Error("PORTFOLIO_SIGNALS_DUPLICATE_BAR");
    seen.add(key);
    const day = Math.floor(bar.openMs / DAY) * DAY;
    const bucket = days[bar.symbol].get(day) ?? { count: 0, close: null };
    bucket.count++;
    if (bar.openMs + HOUR === day + DAY) bucket.close = bar.close;
    days[bar.symbol].set(day, bucket);
  }
  const paired: DailyPair[] = [];
  for (const [day, btc] of days["BTC/USD"]) {
    const eth = days["ETH/USD"].get(day);
    // UTC alignment and uniqueness make 24 bars exactly the complete day.
    // Missing hours are unknown, including otherwise plausible final closes.
    if (btc.count !== 24 || btc.close === null || eth?.count !== 24 || eth.close === null) continue;
    paired.push({ decisionMs: day + DAY, closes: { "BTC/USD": btc.close, "ETH/USD": eth.close } });
  }
  return paired.sort((a, b) => a.decisionMs - b.decisionMs);
}

/** Deterministic inventory targets, not return forecasts or probabilities.
 *
 * A UTC day is final only when all 24 distinct hourly bars exist for both
 * assets. The last hourly close is that day's close. Every policy requires
 * 361 consecutive paired daily closes; any missing own/peer hour resets this
 * support. Targets are emitted in [startMs, endMs) at the final day's close.
 * Historical normalized data assumes availability at that same timestamp.
 * Live callers must separately enforce actual source receipt/finalization.
 *
 * RMS60 includes the 60 completed daily log returns ending now (no centering),
 * floored at .0001. Each 30/90/360-day log return is divided by RMS60*sqrt(h)
 * then clipped to [-1,1]. Relative inverse-volatility weights sum to one;
 * averaging the clipped scores does not rescale unused capacity into risk.
 */
export function buildPortfolioTargets(bars: readonly HourlyBar[], startMs: number, endMs: number,
  policy: PortfolioPolicy = "multiscale-trend"): PortfolioTarget[] {
  if (!Array.isArray(bars)) throw new Error("PORTFOLIO_SIGNALS_INVALID_INPUT");
  if (!validTime(startMs) || !validTime(endMs) || startMs % DAY !== 0 || endMs % DAY !== 0
    || endMs <= startMs || !validTime(endMs + SPEC.targetValidityMs)) throw new Error("PORTFOLIO_SIGNALS_INVALID_WINDOW");
  if (!POLICIES.includes(policy)) throw new Error("PORTFOLIO_SIGNALS_INVALID_POLICY");
  const pairs = dailyPairs(bars), targets: PortfolioTarget[] = [];
  let consecutive = 0;
  for (let i = 0; i < pairs.length; i++) {
    const current = pairs[i]!;
    consecutive = i > 0 && current.decisionMs === pairs[i - 1]!.decisionMs + DAY ? consecutive + 1 : 1;
    if (consecutive < REQUIRED_CLOSES || current.decisionMs < startMs || current.decisionMs >= endMs) continue;
    const signals: PortfolioSignal[] = SYMBOLS.map(symbol => {
      let squares = 0;
      for (let lag = 0; lag < SPEC.volatilityLookbackDays; lag++) {
        const ret = Math.log(pairs[i - lag]!.closes[symbol]) - Math.log(pairs[i - lag - 1]!.closes[symbol]);
        squares += ret * ret / SPEC.volatilityLookbackDays;
      }
      const dailyVolatility = Math.max(SPEC.minimumDailyVolatility, Math.sqrt(squares));
      const trendScores = SPEC.trendLookbackDays.map(horizon => {
        const ret = Math.log(current.closes[symbol]) - Math.log(pairs[i - horizon]!.closes[symbol]);
        return Math.max(-SPEC.signalClip, Math.min(SPEC.signalClip, ret / (dailyVolatility * Math.sqrt(horizon))));
      });
      const score = policy === "multiscale-trend" ? trendScores.reduce((sum, value) => sum + value, 0) / trendScores.length
        : policy === "sign-trend-90d" ? Math.sign(current.closes[symbol] - pairs[i - 90]!.closes[symbol])
          : policy === "constant-btc" && symbol === "BTC/USD" || policy === "constant-eth" && symbol === "ETH/USD" ? 1 : 0;
      return { symbol, close: current.closes[symbol], dailyVolatility, trendScores, score, relativeRiskWeight: 0 };
    });
    const inverseSum = signals.reduce((sum, signal) => sum + 1 / signal.dailyVolatility, 0);
    const targetUsd: Pair<number> = { "BTC/USD": 0, "ETH/USD": 0 };
    for (const signal of signals) {
      signal.relativeRiskWeight = (1 / signal.dailyVolatility) / inverseSum;
      targetUsd[signal.symbol] = policy === "constant-btc" || policy === "constant-eth"
        ? SPEC.maximumGrossNotionalUsd * signal.score
        : SPEC.maximumGrossNotionalUsd * signal.relativeRiskWeight * signal.score;
    }
    // Canonical signal inputs only: no future rows, population statistics,
    // pre-lookback prices or arbitrary input ordering enter this fingerprint.
    const inputSha256 = createHash("sha256").update(JSON.stringify({ version: PORTFOLIO_VERSION,
      lookbacks: SPEC.trendLookbackDays, volatilityLookbackDays: SPEC.volatilityLookbackDays,
      minimumDailyVolatility: SPEC.minimumDailyVolatility, signalClip: SPEC.signalClip,
      finalizedDailyPairs: pairs.slice(i - REQUIRED_CLOSES + 1, i + 1) })).digest("hex");
    targets.push({ version: PORTFOLIO_VERSION, policy, decisionMs: current.decisionMs,
      availableAtMs: current.decisionMs, validUntilMs: current.decisionMs + SPEC.targetValidityMs,
      inputSha256, targetUsd, signals });
  }
  return targets;
}
