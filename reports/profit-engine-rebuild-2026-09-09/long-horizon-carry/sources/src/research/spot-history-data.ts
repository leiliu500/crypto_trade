import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HourlySymbol } from "./hourly-data.js";

/** Independent Kraken SPOT trade aggregates. These are never executable books. */
export const SPOT_HISTORY_SPEC = Object.freeze({ version: "kraken-independent-spot-history-v1",
  symbols: ["BTC/USD", "ETH/USD"] as const, intervalsMinutes: [1440, 10080] as const,
  startMs: Date.UTC(2022, 11, 29), endMsExclusive: Date.UTC(2025, 6, 1),
  candleFinalizationAssumptionMs: 60_000, maximumResponseBytes: 1024 * 1024,
  source: "https://docs.kraken.com/api-reference/market-data/get-ohlc-data",
  interpretation: "RETROSPECTIVE_SPOT_TRADE_AGGREGATES_NOT_PAIRED_EXECUTION_QUOTES" });
export type SpotIntervalMinutes = 1440 | 10080;
export interface SpotHistoryBar {
  symbol: HourlySymbol; intervalMinutes: SpotIntervalMinutes; openMs: number; endMsExclusive: number;
  assumedAvailableAtMs: number; open: number; high: number; low: number; close: number;
  vwap: number; volume: number; trades: number;
}
interface SourceRecord { symbol: HourlySymbol; intervalMinutes: SpotIntervalMinutes; url: string;
  retrievedAtMs: number; originalResponseSha256: string; originalResponseBytes: number;
  originalRows: number; filteredRows: number; file: string; sha256: string;
  persistedContent: "PERMITTED_COMPLETED_BARS_ONLY_ORIGINAL_RESPONSE_HASH_PRESERVED" }
export interface SpotHistoryDataset { version: string; scope: typeof SPOT_HISTORY_SPEC;
  bars: SpotHistoryBar[]; sources: SourceRecord[];
  coverage: Array<{ symbol: HourlySymbol; intervalMinutes: SpotIntervalMinutes; bars: number;
    firstOpenMs: number | null; lastEndMsExclusive: number | null; missingPeriodsWithinObservedRange: number }>;
  limitations: string[] }
const SHA = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const pairs = { "BTC/USD": { pair: "XBTUSD", key: "XXBTZUSD" }, "ETH/USD": { pair: "ETHUSD", key: "XETHZUSD" } } as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_SPOT_DOCUMENT");
  return value as Record<string, unknown>;
}
function selectedRows(document: unknown, symbol: HourlySymbol, interval: SpotIntervalMinutes, asOfMs: number,
  startMs: number, endMs: number): { originalRows: number; rows: unknown[][] } {
  if (!SPOT_HISTORY_SPEC.symbols.includes(symbol) || !SPOT_HISTORY_SPEC.intervalsMinutes.includes(interval)
    || ![asOfMs, startMs, endMs].every(Number.isSafeInteger) || startMs < 0 || startMs >= endMs || endMs > asOfMs)
    throw new Error("INVALID_SPOT_SCOPE");
  const d = object(document), result = object(d.result);
  if (!Array.isArray(d.error) || d.error.length) throw new Error("SPOT_API_ERROR");
  const source = result[pairs[symbol].key];
  if (!Array.isArray(source) || source.length > 1000) throw new Error("INVALID_SPOT_ROWS");
  const rows: unknown[][] = [], width = interval * 60_000;
  for (const raw of source) {
    if (!Array.isArray(raw) || raw.length !== 8 || !Number.isSafeInteger(raw[0]) || raw[0] < 0)
      throw new Error("INVALID_SPOT_TIMESTAMP");
    const openMs = (raw[0] as number) * 1000;
    // Remove excluded periods before accessing their prices or creating features.
    if (openMs < startMs || openMs + width > endMs || openMs + width + 60_000 > asOfMs) continue;
    rows.push(raw);
  }
  return { originalRows: source.length, rows };
}
export function parseSpotOhlcDocument(document: unknown, symbol: HourlySymbol, interval: SpotIntervalMinutes,
  asOfMs: number, startMs = SPOT_HISTORY_SPEC.startMs, endMs = SPOT_HISTORY_SPEC.endMsExclusive): SpotHistoryBar[] {
  const { rows } = selectedRows(document, symbol, interval, asOfMs, startMs, endMs);
  let prior = -Infinity;
  return rows.map(raw => {
    const openMs = Number(raw[0]) * 1000, width = interval * 60_000;
    if (openMs % width !== 0 || openMs <= prior) throw new Error("DUPLICATE_OR_REVERSED_SPOT_BARS");
    prior = openMs;
    const numeric = raw.slice(1, 7).map(value => typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
    const [open, high, low, close, vwap, volume] = numeric as [number, number, number, number, number, number];
    const trades = raw[7];
    if (!numeric.every(Number.isFinite) || Math.min(open, high, low, close, vwap) <= 0 || volume < 0
      || low > Math.min(open, close, vwap) || high < Math.max(open, close, vwap)
      || !Number.isSafeInteger(trades) || (trades as number) < 0
      || ((trades as number) === 0) !== (volume === 0)) throw new Error("INVALID_SPOT_OHLCVT");
    return { symbol, intervalMinutes: interval, openMs, endMsExclusive: openMs + width,
      assumedAvailableAtMs: openMs + width + SPOT_HISTORY_SPEC.candleFinalizationAssumptionMs,
      open, high, low, close, vwap, volume, trades: trades as number };
  });
}
function sorted(bars: SpotHistoryBar[]): SpotHistoryBar[] {
  return bars.sort((a, b) => a.intervalMinutes - b.intervalMinutes || a.openMs - b.openMs || a.symbol.localeCompare(b.symbol));
}
async function boundedResponse(response: Response): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`SPOT_HTTP_${response.status}`);
  const reader = response.body.getReader(), chunks: Buffer[] = []; let bytes = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > SPOT_HISTORY_SPEC.maximumResponseBytes) throw new Error("SPOT_RESPONSE_LIMIT");
    chunks.push(Buffer.from(part.value));
  } } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
export async function downloadSpotHistoryDataset(out: string, dependencies: { fetcher?: typeof fetch; nowMs?: number } = {}) {
  const fetcher = dependencies.fetcher ?? fetch, nowMs = dependencies.nowMs ?? Date.now();
  if (!out || !Number.isSafeInteger(nowMs) || nowMs < SPOT_HISTORY_SPEC.endMsExclusive + 60_000)
    throw new Error("INVALID_SPOT_DOWNLOAD_ARGUMENTS");
  await mkdir(out, { recursive: false }); await mkdir(join(out, "sources"));
  await writeFile(join(out, "registration.json"), JSON.stringify({ registeredAtMs: nowMs, spec: SPOT_HISTORY_SPEC,
    activationAllowed: false, strategyPerformanceComputed: false }, null, 2) + "\n", { flag: "wx" });
  const bars: SpotHistoryBar[] = [], sources: SourceRecord[] = [];
  for (const symbol of SPOT_HISTORY_SPEC.symbols) for (const intervalMinutes of SPOT_HISTORY_SPEC.intervalsMinutes) {
    const url = `https://api.kraken.com/0/public/OHLC?pair=${pairs[symbol].pair}&interval=${intervalMinutes}`;
    const original = await boundedResponse(await fetcher(url, { signal: AbortSignal.timeout(25_000) }));
    const document: unknown = JSON.parse(original.toString("utf8"));
    const selection = selectedRows(document, symbol, intervalMinutes, nowMs, SPOT_HISTORY_SPEC.startMs, SPOT_HISTORY_SPEC.endMsExclusive);
    const selected = parseSpotOhlcDocument(document, symbol, intervalMinutes, nowMs);
    if (!selected.length) throw new Error(`SPOT_NO_PERMITTED_DATA:${symbol}:${intervalMinutes}`);
    const filtered = JSON.stringify({ error: [], result: { [pairs[symbol].key]: selection.rows } }) + "\n";
    const file = `sources/${pairs[symbol].pair}-${intervalMinutes}.json`;
    await writeFile(join(out, file), filtered, { flag: "wx" });
    sources.push({ symbol, intervalMinutes, url, retrievedAtMs: nowMs, originalResponseSha256: SHA(original),
      originalResponseBytes: original.length, originalRows: selection.originalRows, filteredRows: selected.length,
      file, sha256: SHA(filtered), persistedContent: "PERMITTED_COMPLETED_BARS_ONLY_ORIGINAL_RESPONSE_HASH_PRESERVED" });
    bars.push(...selected);
  }
  const coverage = sources.map(source => { const selected = bars.filter(b => b.symbol === source.symbol && b.intervalMinutes === source.intervalMinutes);
    const first = selected[0]!, last = selected.at(-1)!, width = source.intervalMinutes * 60_000;
    return { symbol: source.symbol, intervalMinutes: source.intervalMinutes, bars: selected.length,
      firstOpenMs: first.openMs, lastEndMsExclusive: last.endMsExclusive,
      missingPeriodsWithinObservedRange: (last.endMsExclusive - first.openMs) / width - selected.length }; });
  const dataset: SpotHistoryDataset = { version: SPOT_HISTORY_SPEC.version, scope: SPOT_HISTORY_SPEC, bars: sorted(bars), sources, coverage,
    limitations: ["DAILY_COVERAGE_IS_LIMITED_TO_RECENT_720_PERIODS_AND_IS_NOT_COMPLETE_2024_HISTORY",
      "WEEKLY_BARS_START_AT_VENDOR_THURSDAY_UTC_BOUNDARY_AND_KEEP_ORIGINAL_TIMESTAMPS",
      "SPOT_AND_PERPETUAL_TRADES_ARE_INDEPENDENT_AND_NOT_SYNCHRONOUS_EXECUTABLE_QUOTES",
      "OHLC_EXTREMA_DO_NOT_REVEAL_INTRAPERIOD_ORDER_OR_CONTEMPORANEOUS_BASIS",
      "FINALIZATION_LAG_IS_A_RESEARCH_ASSUMPTION_NOT_HISTORICAL_RECEIPT_EVIDENCE",
      "ORIGINAL_RESPONSES_HASHED_BUT_ONLY_PERMITTED_COMPLETE_BARS_PERSISTED",
      "NO_MISSING_PERIOD_IS_FILLED_WITH_SYNTHETIC_PRICES_OR_ZERO_VOLUME"] };
  const content = JSON.stringify(dataset) + "\n";
  await writeFile(join(out, "dataset.json"), content, { flag: "wx" });
  await writeFile(join(out, "manifest.json"), JSON.stringify({ version: SPOT_HISTORY_SPEC.version,
    datasetSha256: SHA(content), datasetBytes: Buffer.byteLength(content), sources, coverage }, null, 2) + "\n", { flag: "wx" });
  return dataset;
}
export async function loadSpotHistoryDataset(root: string): Promise<SpotHistoryDataset> {
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as { version: string; datasetSha256: string };
  const bytes = await readFile(join(root, "dataset.json"));
  if (manifest.version !== SPOT_HISTORY_SPEC.version || SHA(bytes) !== manifest.datasetSha256) throw new Error("SPOT_DATASET_HASH_MISMATCH");
  const dataset = JSON.parse(bytes.toString("utf8")) as SpotHistoryDataset;
  if (dataset.version !== SPOT_HISTORY_SPEC.version || JSON.stringify(dataset.scope) !== JSON.stringify(SPOT_HISTORY_SPEC)
    || !Array.isArray(dataset.sources) || dataset.sources.length !== 4) throw new Error("INVALID_SPOT_DATASET");
  const recovered: SpotHistoryBar[] = [], identities = new Set<string>();
  for (const source of dataset.sources) {
    const key = `${source.symbol}:${source.intervalMinutes}`;
    if (!SPOT_HISTORY_SPEC.symbols.includes(source.symbol) || !SPOT_HISTORY_SPEC.intervalsMinutes.includes(source.intervalMinutes)
      || source.file !== `sources/${pairs[source.symbol].pair}-${source.intervalMinutes}.json` || identities.has(key))
      throw new Error("INVALID_SPOT_SOURCE_IDENTITY");
    identities.add(key); const original = await readFile(join(root, source.file));
    if (SHA(original) !== source.sha256) throw new Error("SPOT_SOURCE_HASH_MISMATCH");
    const selected = parseSpotOhlcDocument(JSON.parse(original.toString("utf8")), source.symbol, source.intervalMinutes, source.retrievedAtMs);
    if (selected.length !== source.filteredRows) throw new Error("SPOT_SOURCE_COUNT_MISMATCH");
    recovered.push(...selected);
  }
  if (JSON.stringify(sorted(recovered)) !== JSON.stringify(dataset.bars)) throw new Error("SPOT_SOURCE_DATASET_MISMATCH");
  return dataset;
}
