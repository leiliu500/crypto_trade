import type { RecordedEvent } from "../backtest/replay.js";
import { LocalOrderBook } from "../core/order-book.js";
import type { AssetRules } from "../execution/planner.js";
import { BreakoutRetest, RETEST_RULES } from "../strategy/breakout-retest.js";
import { TRADING_POLICIES, POLICY_VERSION, policyQuantity } from "./trading-policy.js";
import { EXECUTION_SCENARIOS, ExecutionStressCase, stressObservation, type EpisodeObservation } from "./execution-stress.js";

/** Discover entries causally from raw events, with paired fixed/floor exits.
 * Signal-conditional research, not a portfolio backtest or model promotion. */
export async function replayRetest(events: AsyncIterable<RecordedEvent> | Iterable<RecordedEvent>,
  rules: ReadonlyMap<string, { asset: AssetRules; feeBps: number; reserveBps: number }>) {
  const books = new Map<string, LocalOrderBook>(), detectors = new Map<string, BreakoutRetest>();
  const cases = new Map<string, { simulation: ExecutionStressCase; control: boolean; symbol: string }>();
  const outcomes: Array<{ observation: EpisodeObservation; control: boolean }> = [];
  const quality = { events: 0, candidates: 0, gaps: 0, invalidBooks: 0, firstMs: null as number | null, lastMs: null as number | null };
  const finish = (now: number, reason: string, symbol?: string) => {
    for (const [id, c] of cases) if (!symbol || symbol === c.symbol) {
      const observation = c.simulation.invalidate(now, reason);
      if (observation) outcomes.push({ observation, control: c.control });
      cases.delete(id);
    }
  };
  for await (const event of events) {
    quality.events++;
    if (event.kind === "PRIVATE") continue;
    const now = event.kind === "BOOK" ? event.delta.receiveTsMs : event.kind === "TRADE" ? event.trade.receiveTsMs : event.receiveTsMs;
    quality.firstMs ??= now; quality.lastMs = now;
    if (event.kind === "DISCONNECT" || event.kind === "RECORDER_GAP") {
      quality.gaps++; finish(now, event.kind);
      for (const b of books.values()) b.invalidate();
      for (const d of detectors.values()) d.reset();
      continue;
    }
    const symbol = event.kind === "BOOK" ? event.delta.symbol : event.trade.symbol, rule = rules.get(symbol);
    if (!rule) continue;
    const detector = detectors.get(symbol) ?? new BreakoutRetest(); detectors.set(symbol, detector);
    if (event.kind === "TRADE") { detector.onTrade(event.trade); continue; }
    const local = books.get(symbol) ?? new LocalOrderBook(symbol); books.set(symbol, local);
    const update = local.apply(event.delta);
    if (update.duplicate) continue;
    if (!update.accepted || !update.state) { quality.invalidBooks++; detector.reset(); finish(now, "INVALID_BOOK", symbol); continue; }
    const b = update.state;
    const stale = now - b.exchangeTsMs > 2_000 || b.exchangeTsMs - now > 250;
    for (const [id, c] of cases) if (c.symbol === symbol) {
      const observation = c.simulation.observe(b, stale);
      if (observation) { outcomes.push({ observation, control: c.control }); cases.delete(id); }
    }
    const candidate = detector.observe(b, stale);
    if (!candidate) continue;
    quality.candidates++;
    const qty = policyQuantity(candidate.side === 1 ? b.asks[0]!.px : b.bids[0]!.px, rule.asset);
    if (!(qty > 0)) continue;
    for (const policy of TRADING_POLICIES.filter((p) => p.family === "BREAKOUT_RETEST")) {
      for (const scenario of EXECUTION_SCENARIOS) for (const control of [false, true]) {
        const start = stressObservation({ id: `retest-${symbol}-${now}-${policy.id}`, sampling: "ENTRY",
          policyVersion: POLICY_VERSION, configurationVersion: `raw-retest-replay:${RETEST_RULES.version}`, symbol,
          family: "BREAKOUT_RETEST", regime: candidate.side === 1 ? "RETEST_UP" : "RETEST_DOWN", side: candidate.side,
          policyId: policy.id, signalAtMs: now, entryAtMs: null, exitAtMs: null, entryPrice: null, exitPrice: null,
          qty, filledQty: 0, signalBid: b.bids[0]!.px, signalAsk: b.asks[0]!.px,
          spreadBps: (b.asks[0]!.px - b.bids[0]!.px) / ((b.asks[0]!.px + b.bids[0]!.px) / 2) * 10_000,
          feeBps: rule.feeBps, reserveBps: rule.reserveBps, grossBps: null, netBps: null, status: "PENDING", reason: null,
          features: { invalidationPx: candidate.invalidationPx, policyVolatilityBps: candidate.volatilityBps } },
        scenario, `retest-${symbol}-${now}`, "breakout-retest", { healthAllowed: true, healthReasons: [], liquidityPass: true,
          liquidityReasons: [], positionOpen: false, pendingOrder: false, cooldownRemainingMs: 0, sizing: "VENUE_NOTIONAL_ONLY" });
        const simulation = new ExecutionStressCase(start, control);
        if (cases.size >= 1024) outcomes.push({ observation: simulation.invalidate(now, "REPLAY_CAPACITY")!, control });
        else cases.set(start.id, { simulation, control, symbol });
      }
    }
  }
  finish(quality.lastMs ?? 0, "REPLAY_END");
  const groups = new Map<string, typeof outcomes>();
  for (const o of outcomes) {
    const r = o.observation, key = `${r.symbol}|${r.side}|${r.policyId}|${r.scenario.id}|${o.control ? "fixed" : "net-floor"}`;
    const group = groups.get(key) ?? []; group.push(o); groups.set(key, group);
  }
  return { detectorVersion: RETEST_RULES.version, quality, deploymentReady: false, assumptions: ["Current instrument increments and configured paper fees",
    "No portfolio or live liquidity-permission simulation", "Fixed control retains structural invalidation, stop and deadline",
    "Additional funding/execution reserve, not observed funding cash flows", "Shared candidate paths and scenarios are dependent"],
    cohorts: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => {
      const complete = values.filter((v) => v.observation.status === "COMPLETE").map((v) => v.observation);
      const filled = complete.filter((o) => o.filledQty > 0);
      return { key, attempts: values.length, complete: complete.length, invalid: values.length - complete.length,
        filled: filled.length, wins: complete.filter((o) => o.netBps! > 0).length,
        meanFilledNetBps: filled.length ? filled.reduce((s, o) => s + o.netBps!, 0) / filled.length : null,
        meanNetBps: complete.length ? complete.reduce((s, o) => s + o.netBps!, 0) / complete.length : null };
    }) };
}
