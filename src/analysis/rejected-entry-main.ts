import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { analyzeRejectedEntries, DEFAULT_REJECTED_ENTRY_HORIZONS_MS,
  type CounterfactualQuote, type RejectedEntryObservation } from "./rejected-entry-report.js";

interface RunRow { id: string; started_at: Date | string; metadata: unknown; }
interface RouteRow { run_id: string; occurred_at: Date | string; payload: unknown; }
interface MarketRow {
  symbol: string;
  captured_ms: string | number;
  best_bid: string | number;
  best_ask: string | number;
}

loadLocalEnv();
const cfg = loadConfig(process.env, "replay");
const pool = new Pool({ connectionString: cfg.databaseUrl, max: 2, connectionTimeoutMillis: 5_000,
  application_name: "crypto-trade-rejected-entry-report" });
try {
  const requestedRunId = argumentValue(process.argv, "--run-id");
  const runResult = requestedRunId
    ? await pool.query<RunRow>("SELECT id::text,started_at,metadata FROM engine_runs WHERE id=$1", [requestedRunId])
    : await pool.query<RunRow>(`SELECT r.id::text,r.started_at,r.metadata
        FROM engine_runs r
        WHERE EXISTS (SELECT 1 FROM system_events e WHERE e.run_id=r.id AND e.event_type='entryRouteEvaluated')
        ORDER BY r.started_at DESC LIMIT 1`);
  const run = runResult.rows[0];
  if (!run) throw new Error(requestedRunId ? `Engine run not found: ${requestedRunId}` : "No run has rejected route evaluations");
  const routeResult = await pool.query<RouteRow>(`SELECT run_id::text,occurred_at,payload
    FROM system_events
    WHERE run_id=$1 AND event_type='entryRouteEvaluated' AND payload->>'selectedStyle' IS NULL
    ORDER BY occurred_at,id`, [run.id]);
  const routes = routeResult.rows.flatMap(parseRoute);
  if (routes.length === 0) {
    process.stdout.write(`${JSON.stringify({ status: "ok", runId: run.id, startedAt: new Date(run.started_at).toISOString(),
      decisionCount: 0, message: "No rejected route evaluations found" }, null, 2)}\n`);
  } else {
    const horizonsMs = DEFAULT_REJECTED_ENTRY_HORIZONS_MS;
    const firstSignalMs = Math.min(...routes.map((route) => route.signalAtMs));
    const lastSignalMs = Math.max(...routes.map((route) => route.signalAtMs));
    const maximumHorizonMs = Math.max(...horizonsMs);
    const marketResult = await pool.query<MarketRow>(`SELECT symbol,
        round(extract(epoch FROM captured_at) * 1000)::bigint AS captured_ms,best_bid,best_ask
      FROM market_snapshots
      WHERE symbol = ANY($1::text[]) AND captured_at >= $2 AND captured_at <= $3
        AND best_bid > 0 AND best_ask > best_bid
      ORDER BY symbol,captured_at,id`, [
      [...new Set(routes.map((route) => route.symbol))],
      new Date(firstSignalMs - 2_000),
      new Date(lastSignalMs + maximumHorizonMs + 2_000),
    ]);
    const quotesBySymbol = groupQuotes(marketResult.rows);
    const observations: RejectedEntryObservation[] = routes.map((route) => {
      const quotes = quotesBySymbol.get(route.symbol) ?? [];
      return {
        ...route,
        entryQuote: quoteAtOrBefore(quotes, route.signalAtMs, 2_000),
        marks: horizonsMs.map((horizonMs) => ({ horizonMs,
          quote: quoteAtOrAfter(quotes, route.signalAtMs + horizonMs, 2_000) })),
      };
    });
    const feesBySymbol = Object.fromEntries(cfg.symbols.map((symbol) => [symbol, {
      makerFeeBps: cfg.symbolConfigs[symbol]!.cost.makerFeeBps,
      takerFeeBps: cfg.symbolConfigs[symbol]!.cost.takerFeeBps,
    }]));
    const report = analyzeRejectedEntries(observations, feesBySymbol);
    process.stdout.write(`${JSON.stringify({ status: "ok", runId: run.id,
      startedAt: new Date(run.started_at).toISOString(), configuration: run.metadata, ...report }, null, 2)}\n`);
  }
} finally {
  await pool.end();
}

function parseRoute(row: RouteRow): Array<Omit<RejectedEntryObservation, "entryQuote" | "marks">> {
  const payload = object(row.payload);
  const side = Number(payload.side), signalAtMs = new Date(row.occurred_at).getTime();
  const decisionId = text(payload.decisionId), symbol = text(payload.symbol), family = text(payload.family);
  if ((side !== 1 && side !== -1) || !Number.isFinite(signalAtMs) || !decisionId || !symbol || !family) return [];
  const makerRejection = object(payload.makerRejection), takerRejection = object(payload.takerRejection);
  return [{
    runId: row.run_id,
    decisionId,
    signalAtMs,
    symbol,
    side,
    family,
    makerRejection: text(makerRejection.reason),
    takerRejection: text(takerRejection.reason),
    makerFillProbability: nullableNumber(object(makerRejection.values).fillProbability),
  }];
}

function groupQuotes(rows: readonly MarketRow[]): Map<string, CounterfactualQuote[]> {
  const result = new Map<string, CounterfactualQuote[]>();
  for (const row of rows) {
    const quote = { atMs: Number(row.captured_ms), bestBid: Number(row.best_bid), bestAsk: Number(row.best_ask) };
    if (!Number.isFinite(quote.atMs) || !(quote.bestBid > 0) || !(quote.bestAsk > quote.bestBid)) continue;
    const values = result.get(row.symbol) ?? [];
    values.push(quote);
    result.set(row.symbol, values);
  }
  return result;
}

function quoteAtOrBefore(quotes: readonly CounterfactualQuote[], targetMs: number, maximumAgeMs: number): CounterfactualQuote | null {
  const index = lowerBound(quotes, targetMs + 1) - 1;
  const quote = quotes[index];
  return quote && targetMs - quote.atMs <= maximumAgeMs ? quote : null;
}

function quoteAtOrAfter(quotes: readonly CounterfactualQuote[], targetMs: number, maximumDelayMs: number): CounterfactualQuote | null {
  const quote = quotes[lowerBound(quotes, targetMs)];
  return quote && quote.atMs - targetMs <= maximumDelayMs ? quote : null;
}

function lowerBound(quotes: readonly CounterfactualQuote[], targetMs: number): number {
  let low = 0, high = quotes.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (quotes[middle]!.atMs < targetMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function argumentValue(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
