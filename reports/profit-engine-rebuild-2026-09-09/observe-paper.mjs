/** Bounded read-only paper observation. Uses the local dashboard only.
 * DURATION_SECONDS NEW_JSONL_PATH. Each row is an allowlisted snapshot.
 */
import { open } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const [durationText, path] = process.argv.slice(2), duration = Number(durationText);
if (!Number.isInteger(duration) || duration < 1 || duration > 21_600 || !path)
  throw new Error('DURATION_SECONDS (1..21600) and NEW_JSONL_PATH required');
const output = await open(path, 'wx', 0o600), end = Date.now() + duration * 1000;
let stopped = false, rows = 0;
process.once('SIGTERM', () => { stopped = true; });
process.once('SIGINT', () => { stopped = true; });
const seen = new Map();
try {
  while (!stopped && Date.now() < end) {
    let row;
    try {
      const response = await fetch('http://127.0.0.1:3001/api/dashboard', { signal: AbortSignal.timeout(2500) });
      if (!response.ok) throw new Error(`DASHBOARD_HTTP_${response.status}`);
      const d = await response.json();
      if (d.mode !== 'paper' || d.paper !== true) throw new Error('PAPER_DASHBOARD_REQUIRED');
      row = { observedAtMs: Date.now(), generatedAtMs: d.generatedAtMs, equity: d.equity,
        openOrders: d.orders?.length, openPositions: d.positions?.length,
        markets: (d.markets ?? []).map(market => {
          const stats = market.distributional?.statistics, decision = market.distributional?.decision;
          const key = decision && `${decision.sizingPolicyId}:${decision.selectionPolicyVersion}:${decision.atMs}:${decision.quoteSequence}`;
          const isNew = Boolean(key && seen.get(market.symbol) !== key);
          if (isNew) seen.set(market.symbol, key);
          return { symbol: market.symbol, sizingPolicyId: stats?.sizingPolicyId,
            samples: stats?.learning?.retainedSamples, selected: stats?.selected,
            size: stats?.sizing?.[market.symbol], newDecision: isNew,
            decision: isNew ? { atMs: decision.atMs, actionId: decision.actionId, reason: decision.reason,
              requestedQty: decision.requestedQty, paperReady: decision.paperReady,
              estimates: decision.estimates?.map(e => ({ actionId: e.actionId, samples: e.samples,
                effectiveSamples: e.effectiveSamples, observedDays: e.observedDays, meanNetBps: e.meanNetBps,
                lowerMeanNetBps: e.lowerMeanNetBps, scoreBps: e.scoreBps, reason: e.reason, eligible: e.eligible })) } : null };
        }) };
    } catch (error) { row = { observedAtMs: Date.now(), unavailable: error.message }; }
    await output.write(JSON.stringify(row) + '\n'); rows++;
    await delay(Math.min(10_000, Math.max(0, end - Date.now())));
  }
} finally { await output.sync(); await output.close(); }
process.stdout.write(JSON.stringify({ path, rows, endedAtUtc: new Date().toISOString(), brokerOrdersSubmitted: 0 }) + '\n');
