export interface TimedReturn { atMs: number; netBps: number }
const DAY = 86_400_000;
/** Deterministic UTC-day block bootstrap. Each draw resamples entire days,
 * including cell/parent dependence, rather than independent nearby trades. */
export function blockExpectancy(cell: readonly TimedReturn[], parent: readonly TimedReturn[] = cell,
  shrinkage = 20, replicates = 1_000) {
  if (!(shrinkage >= 0) || !Number.isInteger(replicates) || replicates < 100
    || [...cell, ...parent].some((r) => !Number.isFinite(r.atMs) || !Number.isFinite(r.netBps))) throw new Error("INVALID_BLOCK_EVIDENCE");
  const days = [...new Set(cell.map((r) => Math.floor(r.atMs / DAY)))].sort((a, b) => a - b);
  parent = parent.filter((r) => days.includes(Math.floor(r.atMs / DAY)));
  const weight = cell.length / (cell.length + shrinkage);
  const mean = (rows: readonly TimedReturn[]) => rows.reduce((s, r) => s + r.netBps, 0) / rows.length;
  const parentMean = parent.length ? mean(parent) : cell.length ? mean(cell) : null;
  const shrunkMean = cell.length ? weight * mean(cell) + (1 - weight) * parentMean! : null;
  if (days.length < 2 || !cell.length) return { samples: cell.length, days: days.length, shrunkMean, lower95: null };
  const blocks = days.map((day) => {
    const c = cell.filter((r) => Math.floor(r.atMs / DAY) === day);
    const p = parent.filter((r) => Math.floor(r.atMs / DAY) === day);
    return { n: c.length, sum: c.reduce((s, r) => s + r.netBps, 0),
      pn: p.length, psum: p.reduce((s, r) => s + r.netBps, 0) };
  });
  let seed = 0x516f23ab;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const values: number[] = [];
  for (let i = 0; i < replicates; i++) {
    let n = 0, sum = 0, pn = 0, psum = 0;
    for (let j = 0; j < days.length; j++) {
      const b = blocks[Math.floor(random() * blocks.length)]!;
      n += b.n; sum += b.sum; pn += b.pn; psum += b.psum;
    }
    const w = n / (n + shrinkage);
    // A profitable parent must never conceal a losing cell.
    values.push(Math.min(sum / n, w * sum / n + (1 - w) * (pn ? psum / pn : sum / n)));
  }
  values.sort((a, b) => a - b);
  return { samples: cell.length, days: days.length, shrunkMean, lower95: values[Math.floor(.05 * (values.length - 1))]! };
}
