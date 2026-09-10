/** Synthetic calculation benchmark only; no strategy outcomes or market input.
 * Run from repository root with node --import tsx <this file>. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RobustAgeGate } from '../../src/core/statistics.ts';
import { ReferenceRobustAgeGate } from '../../test/fixtures/robust-age-gate-reference.ts';
const sha = p => createHash('sha256').update(readFileSync(new URL(p, import.meta.url))).digest('hex');
let seed = 0x39090ade;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const warmup = 5000, count = 4000;
const mixed = Array.from({length: warmup + count}, (_, i) => i % 11 ? random() * 1600 : 100);
const duplicates = Array.from({length: warmup + count}, (_, i) => [100, 100, 100, 99, 101, 102, 100, 98][i % 8]);
function run(Factory, rows, window) {
  const gate = new Factory(2000, window, 6, 20, 250);
  for (let i = 0; i < warmup; i++) gate.observe(rows[i], i * 10);
  const outputs = new Array(count), start = performance.now();
  for (let i = 0; i < count; i++) outputs[i] = gate.observe(rows[warmup + i], (warmup + i) * 10);
  return { elapsedMs: performance.now() - start, outputs };
}
const cases = [];
for (const [name, rows, windowMs] of [['mixed ages, FIFO capacity 4096', mixed, Infinity],
  ['duplicate ages, FIFO capacity 4096', duplicates, Infinity], ['mixed ages, 256-observation time window', mixed, 2560]]) {
  const baseline = run(ReferenceRobustAgeGate, rows, windowMs), optimized = run(RobustAgeGate, rows, windowMs);
  assert.deepEqual(optimized.outputs, baseline.outputs);
  cases.push({ name, measuredObservations: count, warmupObservations: warmup, exactOutputParity: true,
    baselineElapsedMs: baseline.elapsedMs, optimizedElapsedMs: optimized.elapsedMs,
    speedup: baseline.elapsedMs / optimized.elapsedMs,
    optimizedMicrosecondsPerObservation: optimized.elapsedMs * 1000 / count });
}
const result = { generatedAtUtc: new Date().toISOString(), method: 'Same fixed synthetic ages/clocks; warmed calculations only; exact deep equality of all measured output fields. One local wall-clock measurement per case, not a service latency guarantee.',
  node: process.version, sourceSha256: sha('../../src/core/statistics.ts'), referenceSha256: sha('../../test/fixtures/robust-age-gate-reference.ts'),
  strategyOutcomesEvaluated: false, eventDownsampling: false, cases };
writeFileSync(new URL('robust-age-gate-benchmark.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
