export const DEFAULT_REJECTED_ENTRY_HORIZONS_MS = [
  1_000, 5_000, 30_000, 60_000, 300_000, 900_000, 3_600_000, 7_200_000, 14_400_000,
] as const;

export interface CounterfactualQuote {
  atMs: number;
  bestBid: number;
  bestAsk: number;
}

export interface RejectedEntryMark {
  horizonMs: number;
  quote: CounterfactualQuote | null;
}

export interface RejectedEntryObservation {
  runId: string;
  decisionId: string;
  signalAtMs: number;
  symbol: string;
  side: 1 | -1;
  family: string;
  makerRejection: string | null;
  takerRejection: string | null;
  makerFillProbability: number | null;
  entryQuote: CounterfactualQuote | null;
  marks: readonly RejectedEntryMark[];
}

export interface FeeSchedule { makerFeeBps: number; takerFeeBps: number; }

export interface CounterfactualResult {
  runId: string;
  decisionId: string;
  signalAtMs: number;
  symbol: string;
  side: 1 | -1;
  family: string;
  makerRejection: string | null;
  takerRejection: string | null;
  makerFillProbability: number | null;
  entryQuoteAgeMs: number | null;
  horizonMs: number;
  markDelayMs: number | null;
  takerNetBps: number | null;
  makerIfFilledNetBps: number | null;
}

export interface CounterfactualSummary {
  samples: number;
  wins: number;
  losses: number;
  flat: number;
  winRate: number | null;
  averageBps: number | null;
  medianBps: number | null;
  minimumBps: number | null;
  maximumBps: number | null;
}

export interface RejectedEntryReport {
  generatedAtMs: number;
  decisionCount: number;
  symbols: Readonly<Record<string, number>>;
  directions: Readonly<Record<string, number>>;
  rejectionCounts: {
    maker: Readonly<Record<string, number>>;
    taker: Readonly<Record<string, number>>;
  };
  assumptions: readonly string[];
  horizons: ReadonlyArray<{
    horizonMs: number;
    taker: CounterfactualSummary;
    makerIfFilled: CounterfactualSummary;
  }>;
  results: readonly CounterfactualResult[];
}

/** Price-follow-through audit. It does not claim that a rejected maker order would have filled. */
export function analyzeRejectedEntries(observations: readonly RejectedEntryObservation[],
  feesBySymbol: Readonly<Record<string, FeeSchedule>>, generatedAtMs = Date.now()): RejectedEntryReport {
  const results = observations.flatMap((observation) => observation.marks.map((mark) =>
    evaluateMark(observation, mark, feesBySymbol[observation.symbol])));
  const horizons = [...new Set(results.map((result) => result.horizonMs))].sort((left, right) => left - right);
  return {
    generatedAtMs,
    decisionCount: observations.length,
    symbols: counts(observations.map((observation) => observation.symbol)),
    directions: counts(observations.map((observation) => observation.side === 1 ? "LONG" : "SHORT")),
    rejectionCounts: {
      maker: counts(observations.map((observation) => observation.makerRejection ?? "UNKNOWN")),
      taker: counts(observations.map((observation) => observation.takerRejection ?? "UNKNOWN")),
    },
    assumptions: [
      "Taker entry uses the last recorded bid/ask at or before the signal; exit uses the first recorded bid/ask at or after each horizon.",
      "Taker net return crosses the spread at entry and exit and deducts configured taker fees on both legs.",
      "Maker-if-filled return assumes a fill at the entry touch, then a taker exit; it is conditional and does not model queue position or fill probability.",
      "Market impact, latency, adverse selection, funding, stops, and overlapping-position constraints are excluded.",
      "Clustered signals are not independent trades; averages are diagnostic and must not be summed as portfolio P&L.",
    ],
    horizons: horizons.map((horizonMs) => {
      const matching = results.filter((result) => result.horizonMs === horizonMs);
      return {
        horizonMs,
        taker: summarize(matching.flatMap((result) => result.takerNetBps === null ? [] : [result.takerNetBps])),
        makerIfFilled: summarize(matching.flatMap((result) => result.makerIfFilledNetBps === null ? [] : [result.makerIfFilledNetBps])),
      };
    }),
    results,
  };
}

function evaluateMark(observation: RejectedEntryObservation, mark: RejectedEntryMark,
  fees: FeeSchedule | undefined): CounterfactualResult {
  const entry = observation.entryQuote, exit = mark.quote;
  const valid = entry !== null && exit !== null && fees !== undefined && validQuote(entry) && validQuote(exit)
    && Number.isFinite(fees.makerFeeBps) && fees.makerFeeBps >= 0
    && Number.isFinite(fees.takerFeeBps) && fees.takerFeeBps >= 0;
  let takerNetBps: number | null = null, makerIfFilledNetBps: number | null = null;
  if (valid) {
    const exitPx = observation.side === 1 ? exit.bestBid : exit.bestAsk;
    const takerEntryPx = observation.side === 1 ? entry.bestAsk : entry.bestBid;
    const makerEntryPx = observation.side === 1 ? entry.bestBid : entry.bestAsk;
    takerNetBps = netReturnBps(observation.side, takerEntryPx, exitPx, fees.takerFeeBps, fees.takerFeeBps);
    makerIfFilledNetBps = netReturnBps(observation.side, makerEntryPx, exitPx, fees.makerFeeBps, fees.takerFeeBps);
  }
  return {
    runId: observation.runId,
    decisionId: observation.decisionId,
    signalAtMs: observation.signalAtMs,
    symbol: observation.symbol,
    side: observation.side,
    family: observation.family,
    makerRejection: observation.makerRejection,
    takerRejection: observation.takerRejection,
    makerFillProbability: observation.makerFillProbability,
    entryQuoteAgeMs: entry ? observation.signalAtMs - entry.atMs : null,
    horizonMs: mark.horizonMs,
    markDelayMs: exit ? exit.atMs - (observation.signalAtMs + mark.horizonMs) : null,
    takerNetBps,
    makerIfFilledNetBps,
  };
}

function netReturnBps(side: 1 | -1, entryPx: number, exitPx: number,
  entryFeeBps: number, exitFeeBps: number): number {
  const grossBps = side * (exitPx - entryPx) / entryPx * 10_000;
  const feeBps = entryFeeBps + exitFeeBps * exitPx / entryPx;
  return grossBps - feeBps;
}

function validQuote(quote: CounterfactualQuote): boolean {
  return Number.isFinite(quote.atMs) && quote.bestBid > 0 && quote.bestAsk > quote.bestBid;
}

function summarize(values: readonly number[]): CounterfactualSummary {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  const wins = finite.filter((value) => value > 0).length;
  const losses = finite.filter((value) => value < 0).length;
  const flat = finite.length - wins - losses;
  if (finite.length === 0) return { samples: 0, wins: 0, losses: 0, flat: 0, winRate: null,
    averageBps: null, medianBps: null, minimumBps: null, maximumBps: null };
  const middle = Math.floor(finite.length / 2);
  const median = finite.length % 2 === 1 ? finite[middle]! : (finite[middle - 1]! + finite[middle]!) / 2;
  return {
    samples: finite.length,
    wins,
    losses,
    flat,
    winRate: wins / finite.length,
    averageBps: finite.reduce((sum, value) => sum + value, 0) / finite.length,
    medianBps: median,
    minimumBps: finite[0]!,
    maximumBps: finite.at(-1)!,
  };
}

function counts(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}
