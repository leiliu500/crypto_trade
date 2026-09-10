import { setTimeout as sleep } from "node:timers/promises";
import { parseHourlyCandles, type HourlySymbol } from "../research/hourly-data.js";
import { SYSTEMATIC_SPEC as S, type SystematicBar } from "./spec.js";

const PRODUCTS: Readonly<Record<string, string>> = { "BTC/USD": "PF_XBTUSD", "ETH/USD": "PF_ETHUSD" };
const FINALIZATION_DELAY_MS = 60_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export interface SystematicHistoryDependencies {
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

/** Public, read-only Kraken Futures hourly trade candles. A one-minute source
 * finalization grace precedes the exact 192-hour closed-candle window. Missing
 * hours are rejected rather than filled with manufactured observations. HTTP
 * 429/5xx and transport errors get at most three attempts; callers may schedule
 * later refreshes independently of position/quote management. A fresh return is
 * not an execution quote: callers record actual receipt time separately.
 */
export async function loadSystematicHistory(productsBySymbol: Readonly<Record<string, string>>, nowMs: number,
  dependencies: SystematicHistoryDependencies = {}): Promise<SystematicBar[]> {
  if (!productsBySymbol || typeof productsBySymbol !== "object" || Array.isArray(productsBySymbol)
    || !Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new Error("SYSTEMATIC_HISTORY_INVALID_ARGUMENT");
  const entries = Object.entries(productsBySymbol).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length || entries.some(([symbol, product]) => PRODUCTS[symbol] !== product))
    throw new Error("SYSTEMATIC_HISTORY_UNSUPPORTED_PRODUCT");
  const endMs = Math.floor((nowMs - FINALIZATION_DELAY_MS) / S.barMs) * S.barMs;
  const startMs = endMs - S.minimumBars * S.barMs;
  if (!Number.isSafeInteger(startMs) || startMs < 0) throw new Error("SYSTEMATIC_HISTORY_INVALID_WINDOW");
  const fetcher = dependencies.fetcher ?? fetch, pause = dependencies.sleep ?? sleep;
  const requests = await Promise.allSettled(entries.map(async ([symbol, product]) => {
    const url = `https://futures.kraken.com/api/charts/v1/trade/${product}/1h?from=${startMs / 1000}&to=${endMs / 1000}`;
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { response = await fetcher(url, { signal: AbortSignal.timeout(20_000) }); }
      catch (error) {
        if (attempt === 2) throw new Error(`SYSTEMATIC_HISTORY_TRANSPORT:${symbol}`, { cause: error });
        await pause(250 * 2 ** attempt); continue;
      }
      if (response.ok) break;
      if (attempt === 2 || response.status !== 429 && response.status < 500)
        throw new Error(`SYSTEMATIC_HISTORY_HTTP_${response.status}:${symbol}`);
      await response.body?.cancel();
      await pause(250 * 2 ** attempt);
    }
    if (!response?.ok) throw new Error(`SYSTEMATIC_HISTORY_UNAVAILABLE:${symbol}`);
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error("SYSTEMATIC_HISTORY_RESPONSE_LIMIT");
    const parsed = parseHourlyCandles(JSON.parse(body), symbol as HourlySymbol);
    // Reject truncation; the requested window is far below the API page limit.
    if (parsed.more) throw new Error(`SYSTEMATIC_HISTORY_TRUNCATED:${symbol}`);
    const bars = parsed.bars.filter(bar => bar.openMs >= startMs && bar.openMs + S.barMs <= endMs);
    const seen = new Set<number>();
    for (const bar of bars) {
      if (seen.has(bar.openMs)) throw new Error(`SYSTEMATIC_HISTORY_DUPLICATE:${symbol}`);
      seen.add(bar.openMs);
    }
    if (bars.length !== S.minimumBars || bars.some((bar, i) => bar.openMs !== startMs + i * S.barMs))
      throw new Error(`SYSTEMATIC_HISTORY_GAP:${symbol}`);
    return bars;
  }));
  const failed = requests.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  return requests.flatMap(result => result.status === "fulfilled" ? result.value : [])
    .sort((a, b) => a.openMs - b.openMs || a.symbol.localeCompare(b.symbol));
}
