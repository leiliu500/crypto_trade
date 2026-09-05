import { createHash } from "node:crypto";
import { LocalOrderBook } from "../core/order-book.js";
import type { RecordedEvent } from "../backtest/replay.js";
import type { PolicyObservation } from "./policy-collector.js";
import { EXECUTION_SCENARIOS, ExecutionStressCase, stressObservation,
  type EpisodeObservation, type EpisodeContext } from "./execution-stress.js";

const replayContext: EpisodeContext = { healthAllowed: true, healthReasons: [], liquidityPass: true,
  liquidityReasons: [], positionOpen: false, pendingOrder: false, cooldownRemainingMs: 0, sizing: "ACTUAL_ORDER_QUANTITY" };

/** Replays already-recorded decisions, not hindsight-selected entry times.
 * Reconstruct from a reset; a missing signal quote or path cannot score zero. */
export async function replayEpisodeExecutions(events: AsyncIterable<RecordedEvent> | Iterable<RecordedEvent>,
  sources: readonly PolicyObservation[]) {
  if (new Set(sources.map((o) => o.id)).size !== sources.length) throw new Error("Duplicate replay observation IDs");
  const cases = sources.flatMap((source) => EXECUTION_SCENARIOS.map((scenario) => {
    const episode = source.sampling === "EPISODE" ? source as EpisodeObservation : null;
    const start = stressObservation(source, scenario,
      episode?.episodeId ?? digest(`${source.configurationVersion}|${source.symbol}|${source.signalAtMs}`),
      episode?.hypothesisId ?? "executed-entry", episode?.context ?? replayContext);
    start.id = digest(`${source.id}|${scenario.id}`);
    const simulation = new ExecutionStressCase(start);
    if (source.reason === "UNCLEAN_TELEMETRY_RUN") simulation.invalidate(source.signalAtMs, source.reason);
    return { source, scenario, simulation, started: false };
  }));
  const books = new Map<string, LocalOrderBook>();
  const quality = { events: 0, books: 0, duplicates: 0, invalidBooks: 0, gaps: 0, disconnects: 0,
    firstTsMs: null as number | null, lastTsMs: null as number | null };
  for await (const event of events) {
    if (cases.every((c) => !c.simulation.pending)) break;
    quality.events++;
    const now = event.kind === "BOOK" ? event.delta.receiveTsMs : event.kind === "TRADE" ? event.trade.receiveTsMs
      : event.kind === "DISCONNECT" || event.kind === "RECORDER_GAP" ? event.receiveTsMs : undefined;
    if (now !== undefined) { quality.firstTsMs ??= now; quality.lastTsMs = now; }
    if (event.kind === "DISCONNECT" || event.kind === "RECORDER_GAP") {
      if (event.kind === "DISCONNECT") quality.disconnects++; else quality.gaps++;
      for (const book of books.values()) book.invalidate();
      for (const c of cases) if (c.started) c.simulation.invalidate(event.receiveTsMs, event.kind);
      continue;
    }
    if (event.kind !== "BOOK") continue;
    quality.books++;
    const delta = event.delta, at = delta.receiveTsMs;
    const book = books.get(delta.symbol) ?? new LocalOrderBook(delta.symbol); books.set(delta.symbol, book);
    const result = book.apply(delta);
    if (result.duplicate) { quality.duplicates++; continue; }
    if (!result.accepted || !result.state) {
      quality.invalidBooks++;
      for (const c of cases) if (c.started && c.source.symbol === delta.symbol) c.simulation.invalidate(at, "INVALID_REPLAY_BOOK");
      continue;
    }
    for (const c of cases) {
      if (!c.simulation.pending || c.source.symbol !== delta.symbol || at < c.source.signalAtMs) continue;
      if (!c.started) {
        if (at > c.source.signalAtMs) { c.simulation.invalidate(at, "SIGNAL_QUOTE_MISSING"); continue; }
        if (Math.abs(result.state.bids[0]!.px - c.source.signalBid) > 1e-8
          || Math.abs(result.state.asks[0]!.px - c.source.signalAsk) > 1e-8) continue;
        c.started = true;
        continue;
      }
      c.simulation.observe(result.state);
    }
  }
  for (const c of cases) c.simulation.invalidate(Math.max(quality.lastTsMs ?? 0, c.source.signalAtMs),
    c.started ? "REPLAY_ENDED_BEFORE_OUTCOME" : "SIGNAL_QUOTE_MISSING");
  const observations = cases.map((c) => c.simulation.snapshot());
  const comparisons = cases.filter((c) => c.scenario.id === "base-250ms" && c.source.status === "COMPLETE").map((c) => {
    const actual = c.simulation.snapshot(), expected = c.source;
    const fields = ["entryAtMs", "exitAtMs", "entryPrice", "exitPrice", "filledQty", "grossBps", "netBps", "reason", "status"] as const;
    const differences = fields.filter((field) => {
      const a = actual[field], e = expected[field];
      return typeof a === "number" && typeof e === "number" ? Math.abs(a - e) > 1e-7 : a !== e;
    });
    return { sourceId: c.source.id, differences };
  });
  return { quality, observations,
    baselineParity: { compared: comparisons.length, mismatches: comparisons.filter((c) => c.differences.length > 0) } };
}

function digest(value: string): string {
  const h = createHash("sha256").update(value).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
