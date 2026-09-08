export interface DailyPnl { date: string; netPnlUsd: number; }

/** Paired moving-block interval on full calendar days, including days without orders. */
export function pairedWeeklyPnlInterval(candidate: readonly DailyPnl[], reference: readonly DailyPnl[],
  repetitions = 2000, initialSeed = 20260908) {
  if (candidate.length !== reference.length || candidate.some((row, i) => row.date !== reference[i]?.date)) {
    throw new Error("HOURLY_PAIRED_CALENDAR_MISMATCH");
  }
  if (candidate.some((row, i) => !Number.isFinite(row.netPnlUsd) || !Number.isFinite(reference[i]!.netPnlUsd))) {
    throw new Error("HOURLY_NONFINITE_DAILY_PNL");
  }
  const differences = candidate.map((row, i) => row.netPnlUsd - reference[i]!.netPnlUsd);
  if (differences.length < 28) return { days: differences.length, meanDailyImprovementUsd: null, lower95DailyUsd: null,
    lower95TotalUsd: null, repetitions: 0, blockDays: 7, seed: initialSeed };
  for (let i = 1; i < candidate.length; i++) {
    if (Date.parse(candidate[i]!.date) - Date.parse(candidate[i - 1]!.date) !== 86_400_000) {
      throw new Error("HOURLY_NONCONTIGUOUS_DAILY_PNL");
    }
  }
  let seed = initialSeed >>> 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const means: number[] = [], n = differences.length;
  for (let repetition = 0; repetition < repetitions; repetition++) {
    let total = 0, count = 0;
    while (count < n) {
      const start = Math.floor(random() * (n - 6));
      for (let j = 0; j < 7 && count < n; j++, count++) total += differences[start + j]!;
    }
    means.push(total / n);
  }
  means.sort((a, b) => a - b);
  const lower = means[Math.max(0, Math.floor(.05 * means.length) - 1)]!;
  return { days: n, meanDailyImprovementUsd: differences.reduce((a, b) => a + b, 0) / n,
    lower95DailyUsd: lower, lower95TotalUsd: lower * n, repetitions, blockDays: 7, seed: initialSeed };
}

export function predictionErrorSummary(rows: readonly { actual: number; predicted: number; unconditional: number }[]) {
  if (!rows.length) return { count: 0, modelMseBps2: null, zeroMseBps2: null, unconditionalMseBps2: null,
    modelBeatsZero: false, modelBeatsUnconditional: false };
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const modelMseBps2 = mean(rows.map(row => (row.actual - row.predicted) ** 2));
  const zeroMseBps2 = mean(rows.map(row => row.actual ** 2));
  const unconditionalMseBps2 = mean(rows.map(row => (row.actual - row.unconditional) ** 2));
  return { count: rows.length, modelMseBps2, zeroMseBps2, unconditionalMseBps2,
    modelBeatsZero: modelMseBps2 < zeroMseBps2, modelBeatsUnconditional: modelMseBps2 < unconditionalMseBps2 };
}
