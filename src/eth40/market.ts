import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { DAY_MS, ETH40_SPEC } from "./spec.js";
import type { Asset, DailyBar, MarketSnapshot, VerifiedBook } from "./types.js";
import type { SpotPaperRules } from "../spot-trend/account.js";

const ASSETS: Asset[] = ["ETH/USD", "BTC/USD"];
const PAIRS = { "ETH/USD": { rest: "ETHUSD", key: "XETHZUSD", base: "XETH", ws: "ETH/USD" },
  "BTC/USD": { rest: "XBTUSD", key: "XXBTZUSD", base: "XXBT", ws: "XBT/USD" } } as const;
const REST_INTERVAL_MS = 300_000, RULE_INTERVAL_MS = 3_600_000, RESPONSE_LIMIT = 1_048_576;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MARKET_EXPECTED_OBJECT");
  return value as Record<string, unknown>;
};
const clock = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("MARKET_INVALID_CLOCK");
  return value;
};
function decimal(value: unknown, zero = false): string {
  if (typeof value !== "string" || value.length > 48 || !/^\d+(?:\.\d+)?$/.test(value)
    || !Number.isFinite(Number(value)) || (zero ? Number(value) < 0 : Number(value) <= 0)) throw new Error("MARKET_INVALID_DECIMAL");
  return value;
}
function priceKey(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  return `${whole.replace(/^0+(?=\d)/, "")}.${fraction.replace(/0+$/, "")}`;
}
function comparePrice(a: string, b: string): number {
  const [ai = "0", af = ""] = a.split("."), [bi = "0", bf = ""] = b.split(".");
  const width = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(width, "0")), y = BigInt(bi + bf.padEnd(width, "0"));
  return x < y ? -1 : x > y ? 1 : 0;
}
export type ChecksumLevel = [string, string];
/** Kraken WS v1: raw decimal digits, asks ascending then bids descending. */
export function krakenBookChecksum(asks: readonly ChecksumLevel[], bids: readonly ChecksumLevel[]): string {
  const digits = (value: string): string => decimal(value).replace(".", "").replace(/^0+/, "");
  const text = [...[...asks].sort((a, b) => comparePrice(a[0], b[0])).slice(0, 10),
    ...[...bids].sort((a, b) => comparePrice(b[0], a[0])).slice(0, 10)]
    .map(([price, quantity]) => digits(price) + digits(quantity)).join("");
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return String((crc ^ 0xffffffff) >>> 0);
}

export interface DecimalBook {
  asks: ChecksumLevel[]; bids: ChecksumLevel[];
  checksumValid: boolean; checksum: string; receivedAtMs: number; exchangeUpdateAtMs: number;
}
/** Apply every map/level in wire order. Timestamps never determine update order. */
export function applyKrakenBookFrame(previous: DecimalBook | undefined, blocks: readonly unknown[], nowMs: number): DecimalBook {
  clock(nowMs);
  if (!blocks.length || blocks.length > 8) throw new Error("BOOK_INVALID_FRAME");
  const maps = blocks.map(object), first = maps[0]!;
  const snapshot = "as" in first || "bs" in first;
  if (snapshot && (maps.length !== 1 || !Array.isArray(first.as) || !Array.isArray(first.bs) || "c" in first))
    throw new Error("BOOK_INVALID_SNAPSHOT");
  if (!snapshot && !previous) throw new Error("BOOK_UPDATE_BEFORE_SNAPSHOT");
  const asks = new Map<string, ChecksumLevel>((snapshot ? [] : previous!.asks).map(level => [priceKey(level[0]), [...level]]));
  const bids = new Map<string, ChecksumLevel>((snapshot ? [] : previous!.bids).map(level => [priceKey(level[0]), [...level]]));
  let exchangeUpdateAtMs = -Infinity, checksum: string | undefined;
  for (const [index, block] of maps.entries()) {
    if (Object.keys(block).some(key => !(snapshot ? ["as", "bs"] : ["a", "b", "c"]).includes(key))) throw new Error("BOOK_UNEXPECTED_FIELD");
    if ("c" in block) {
      if (index !== maps.length - 1 || checksum !== undefined || typeof block.c !== "string"
        || !/^\d+$/.test(block.c) || Number(block.c) > 0xffffffff) throw new Error("BOOK_INVALID_CHECKSUM_FIELD");
      checksum = block.c;
    }
    for (const [field, target] of [[snapshot ? "as" : "a", asks], [snapshot ? "bs" : "b", bids]] as const) {
      if (!(field in block)) continue;
      const levels = block[field];
      if (!Array.isArray(levels) || levels.length > 2_000 || snapshot && (levels.length < 1 || levels.length > 10)) throw new Error("BOOK_INVALID_LEVEL_COUNT");
      const seen = new Set<string>();
      for (const value of levels) {
        if (!Array.isArray(value) || value.length < 3 || value.length > 4 || value.length === 4 && value[3] !== "r") throw new Error("BOOK_INVALID_LEVEL");
        const price = decimal(value[0]), quantity = decimal(value[1], !snapshot);
        // Public v1 timestamps may carry micro/nanoseconds. Floor to the
        // integer-millisecond clock required by the portfolio safety gate.
        const timestamp = Math.floor(Number(decimal(value[2])) * 1000);
        if (!Number.isFinite(timestamp) || timestamp > nowMs + ETH40_SPEC.maximumExchangeClockLeadMs) throw new Error("BOOK_FUTURE_LEVEL_TIME");
        exchangeUpdateAtMs = Math.max(exchangeUpdateAtMs, timestamp);
        const key = priceKey(price);
        if (snapshot && seen.has(key)) throw new Error("BOOK_DUPLICATE_SNAPSHOT_PRICE");
        seen.add(key);
        if (Number(quantity) === 0) target.delete(key);
        else target.set(key, [price, quantity]);
      }
    }
  }
  const sortedAsks = [...asks.values()].sort((a, b) => comparePrice(a[0], b[0])).slice(0, 10);
  const sortedBids = [...bids.values()].sort((a, b) => comparePrice(b[0], a[0])).slice(0, 10);
  if (!sortedAsks.length || !sortedBids.length || Number(sortedBids[0]![0]) >= Number(sortedAsks[0]![0])) throw new Error("BOOK_EMPTY_OR_CROSSED");
  for (const [levels, direction] of [[sortedAsks, 1], [sortedBids, -1]] as const) {
    for (let i = 1; i < levels.length; i++) if ((Number(levels[i]![0]) - Number(levels[i - 1]![0])) * direction <= 0) throw new Error("BOOK_UNREPRESENTABLE_PRICE");
  }
  if (!Number.isFinite(exchangeUpdateAtMs)) throw new Error("BOOK_NO_LEVEL_UPDATE");
  if (!snapshot && (checksum === undefined || krakenBookChecksum(sortedAsks, sortedBids) !== checksum)) throw new Error("BOOK_CHECKSUM_MISMATCH");
  return { asks: sortedAsks, bids: sortedBids, checksumValid: !snapshot, checksum: checksum ?? "",
    receivedAtMs: nowMs, exchangeUpdateAtMs };
}

function pairResult(payload: unknown, symbol: Asset, ohlc = false): Record<string, unknown> {
  const document = object(payload), result = object(document.result);
  if (!Array.isArray(document.error) || document.error.length) throw new Error("REST_API_ERROR");
  const allowed = [PAIRS[symbol].key, ...(ohlc ? ["last"] : [])];
  if (Object.keys(result).some(key => !allowed.includes(key)) || !(PAIRS[symbol].key in result)) throw new Error("REST_PAIR_MISMATCH");
  return result;
}
function validateBar(bar: DailyBar): void {
  if (!Number.isSafeInteger(bar.openTimeMs) || bar.openTimeMs < 0 || bar.openTimeMs % DAY_MS !== 0
    || ![bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(value) && value > 0)
    || !Number.isFinite(bar.volume) || bar.volume < 0 || bar.high < Math.max(bar.open, bar.close)
    || bar.low > Math.min(bar.open, bar.close) || bar.low > bar.high) throw new Error("HISTORY_INVALID_BAR");
}
export function parseEth40DailyHistory(payload: unknown, symbol: Asset, nowMs: number): DailyBar[] {
  clock(nowMs);
  const result = pairResult(payload, symbol, true), rows = result[PAIRS[symbol].key];
  // Captured native responses include 720 completed rows plus a current row.
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 721 || !Number.isSafeInteger(result.last)) throw new Error("HISTORY_INVALID_RESPONSE");
  const bars: DailyBar[] = [];
  let prior = -Infinity;
  for (const [index, row] of rows.entries()) {
    if (!Array.isArray(row) || row.length !== 8 || !Number.isSafeInteger(row[0]) || !Number.isSafeInteger(row[7]) || row[7] < 0) throw new Error("HISTORY_INVALID_ROW");
    const bar = { openTimeMs: Number(row[0]) * 1000, open: Number(decimal(row[1])), high: Number(decimal(row[2])),
      low: Number(decimal(row[3])), close: Number(decimal(row[4])), volume: Number(decimal(row[6], true)) };
    decimal(row[5], true);
    validateBar(bar);
    if (prior !== -Infinity && bar.openTimeMs !== prior + DAY_MS) throw new Error("HISTORY_GAP_OR_DUPLICATE");
    prior = bar.openTimeMs;
    // Kraken documents the final REST row as uncommitted, regardless of since.
    if (index < rows.length - 1 && bar.openTimeMs + DAY_MS + ETH40_SPEC.finalizationDelayMs <= nowMs) bars.push(bar);
  }
  const latestRequired = Math.floor((nowMs - ETH40_SPEC.finalizationDelayMs) / DAY_MS) * DAY_MS - DAY_MS;
  if (bars.at(-1)?.openTimeMs !== latestRequired) throw new Error("HISTORY_LATEST_FINALIZED_DAY_MISSING");
  return bars;
}
/** Strict numeric equality: no tolerance silently revises an anchored OHLCV bar. */
export function mergeEth40Histories(seed: readonly DailyBar[], fresh: readonly DailyBar[]): DailyBar[] {
  const byTime = new Map<number, DailyBar>();
  for (const list of [seed, fresh]) {
    let prior = -Infinity;
    for (const bar of list) {
      validateBar(bar);
      if (prior !== -Infinity && bar.openTimeMs !== prior + DAY_MS) throw new Error("HISTORY_GAP_OR_DUPLICATE");
      prior = bar.openTimeMs;
      const existing = byTime.get(bar.openTimeMs);
      if (existing && (["open", "high", "low", "close", "volume"] as const).some(key => existing[key] !== bar[key])) throw new Error(`HISTORY_REVISION_CONFLICT:${bar.openTimeMs}`);
      byTime.set(bar.openTimeMs, { ...bar });
    }
  }
  const merged = [...byTime.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
  for (let i = 1; i < merged.length; i++) if (merged[i]!.openTimeMs !== merged[i - 1]!.openTimeMs + DAY_MS) throw new Error("HISTORY_ANCHOR_GAP");
  return merged;
}
export function parseEth40Rules(payload: unknown, symbol: Asset): SpotPaperRules {
  const pair = PAIRS[symbol], raw = object(pairResult(payload, symbol)[pair.key]);
  if (raw.altname !== pair.rest || raw.wsname !== pair.ws || raw.base !== pair.base || raw.quote !== "ZUSD"
    || raw.aclass_base !== "currency" || raw.aclass_quote !== "currency" || raw.lot !== "unit" || raw.lot_multiplier !== 1) throw new Error("RULES_INSTRUMENT_MISMATCH");
  if (raw.status !== "online") throw new Error(`RULES_NOT_ONLINE:${String(raw.status)}`);
  const precision = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 12) throw new Error("RULES_INVALID_PRECISION");
    return value;
  };
  const lotSize = 10 ** -precision(raw.lot_decimals), priceStep = 10 ** -precision(raw.pair_decimals);
  const minimumQuantity = Number(decimal(raw.ordermin)), minimumNotionalUsd = Number(decimal(raw.costmin));
  const tickSize = raw.tick_size === undefined ? priceStep : Number(decimal(raw.tick_size));
  for (const units of [minimumQuantity / lotSize, tickSize / priceStep])
    if (!Number.isSafeInteger(Math.round(units)) || Math.abs(units - Math.round(units)) > 1e-8) throw new Error("RULES_INVALID_INCREMENT");
  return { lotSize, minimumQuantity, minimumNotionalUsd, tickSize };
}

export interface Eth40MarketDependencies { fetcher?: typeof fetch; now?: () => number; socketFactory?: () => WebSocket }
export class Eth40Market {
  private readonly histories: Record<Asset, DailyBar[]>;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly socketFactory: () => WebSocket;
  private socket: WebSocket | undefined;
  private running = false;
  private connectionId = "";
  private connectedAtMs = 0;
  private channels = new Map<number, Asset>();
  private decimalBooks: Partial<Record<Asset, DecimalBook>> = {};
  private rules: Partial<Record<Asset, SpotPaperRules>> = {};
  private ruleTimes: Partial<Record<Asset, number>> = {};
  private errors = new Map<string, string>();
  private evidenceIds = new Map<string, string>();
  private lastHistoryAttempt = -Infinity;
  private lastRulesAttempts: Partial<Record<Asset, number>> = {};
  private refreshInFlight: Promise<void> | undefined;
  private fatal: Error | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  public constructor(seedHistories: Record<Asset, DailyBar[]>, private readonly onEvidence: (kind: string, payload: unknown) => Promise<string>, dependencies: Eth40MarketDependencies = {}) {
    this.histories = { "ETH/USD": mergeEth40Histories(seedHistories["ETH/USD"], []), "BTC/USD": mergeEth40Histories(seedHistories["BTC/USD"], []) };
    if (ASSETS.some(asset => !this.histories[asset].length)) throw new Error("HISTORY_EMPTY_SEED");
    this.fetcher = dependencies.fetcher ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.socketFactory = dependencies.socketFactory ?? (() => new WebSocket("wss://ws.kraken.com", { handshakeTimeout: 10_000, maxPayload: RESPONSE_LIMIT, perMessageDeflate: false }));
  }
  public start(): void {
    if (this.running) return;
    if (this.fatal) throw this.fatal;
    this.running = true;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.running && this.now() - this.connectedAtMs > 15_000
        && ASSETS.some(asset => this.now() - (this.decimalBooks[asset]?.receivedAtMs ?? this.connectedAtMs) > 15_000)) this.disconnect("WS_BOOK_WATCHDOG");
    }, 1_000);
    this.watchdog.unref();
    void this.ensureRefresh().catch(error => this.failFatal(error));
  }
  public stop(): void {
    this.running = false;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
    clearInterval(this.watchdog); this.watchdog = undefined;
    this.clearSocket();
  }
  /** Accepted immutable-value archive, including anchors withheld from an invalid snapshot. */
  public get acceptedHistories(): Record<Asset, DailyBar[]> {
    return { "ETH/USD": this.histories["ETH/USD"].map(bar => ({ ...bar })), "BTC/USD": this.histories["BTC/USD"].map(bar => ({ ...bar })) };
  }
  private failFatal(error: unknown): void {
    this.fatal = error instanceof Error ? error : new Error(String(error));
    this.stop();
  }
  private clearSocket(): void {
    const socket = this.socket; this.socket = undefined;
    this.channels.clear(); this.decimalBooks = {};
    if (socket) { socket.removeAllListeners(); socket.on("error", () => {}); socket.terminate(); }
  }
  private disconnect(reason: string): void {
    this.errors.set("ws", reason); this.clearSocket();
    if (this.running && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect(); }, 1_000);
      this.reconnectTimer.unref();
    }
  }
  private connect(): void {
    if (!this.running || this.socket) return;
    this.connectionId = randomUUID(); this.connectedAtMs = clock(this.now());
    let socket: WebSocket;
    try { socket = this.socketFactory(); } catch (error) { this.disconnect(`WS_CONNECT:${message(error)}`); return; }
    this.socket = socket;
    socket.on("open", () => {
      if (socket !== this.socket || !this.running) return;
      socket.send(JSON.stringify({ event: "subscribe", pair: ASSETS.map(asset => PAIRS[asset].ws), subscription: { name: "book", depth: 10 } }));
    });
    socket.on("message", data => {
      if (socket !== this.socket || !this.running) return;
      try { this.receive(JSON.parse(data.toString()) as unknown, clock(this.now())); }
      catch (error) { this.disconnect(`WS_INVALID:${message(error)}`); }
    });
    socket.on("error", error => { if (socket === this.socket) this.disconnect(`WS_ERROR:${message(error)}`); });
    socket.on("close", () => { if (socket === this.socket) this.disconnect("WS_CLOSED"); });
  }
  private receive(value: unknown, atMs: number): void {
    if (!Array.isArray(value)) {
      const event = object(value);
      if (event.event === "heartbeat" || event.event === "pong") return;
      if (event.event === "systemStatus") { if (event.status !== "online") throw new Error("WS_NOT_ONLINE"); return; }
      if (event.event !== "subscriptionStatus") throw new Error("WS_UNKNOWN_EVENT");
      const subscription = object(event.subscription);
      const symbol = event.pair === "ETH/USD" ? "ETH/USD" : event.pair === "XBT/USD" || event.pair === "BTC/USD" ? "BTC/USD" : null;
      if (!symbol || event.status !== "subscribed" || event.channelName !== "book-10" || subscription.name !== "book" || subscription.depth !== 10
        || typeof event.channelID !== "number" || !Number.isSafeInteger(event.channelID) || event.channelID < 0) throw new Error("WS_SUBSCRIPTION_MISMATCH");
      if (this.channels.has(event.channelID) || [...this.channels.values()].includes(symbol)) throw new Error("WS_DUPLICATE_SUBSCRIPTION");
      this.channels.set(event.channelID, symbol); return;
    }
    if (value.length < 4 || value.at(-2) !== "book-10" || typeof value[0] !== "number") throw new Error("WS_INVALID_CHANNEL_FRAME");
    const symbol = this.channels.get(value[0]);
    if (!symbol || ![PAIRS[symbol].ws, symbol].includes(value.at(-1) as Asset)) throw new Error("WS_CHANNEL_PAIR_MISMATCH");
    this.decimalBooks[symbol] = applyKrakenBookFrame(this.decimalBooks[symbol], value.slice(1, -2), atMs);
    if (ASSETS.every(asset => this.decimalBooks[asset]?.checksumValid)) this.errors.delete("ws");
  }
  private async source(url: string, kind: string): Promise<{ payload: unknown; error: string | null; receivedAtMs: number }> {
    const requestedAtMs = clock(this.now());
    let receivedAtMs = requestedAtMs, rawBody: string | null = null, rawBodyBase64: string | null = null;
    let httpStatus: number | null = null, error: string | null = null, payload: unknown = null;
    let responseBytes = 0, sha256: string | null = null, serverDate: string | null = null;
    try {
      const response = await this.fetcher(url, { method: "GET", redirect: "error", cache: "no-store",
        headers: { Accept: "application/json", "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(10_000) });
      httpStatus = response.status; serverDate = response.headers.get("date");
      if (!response.body) throw new Error("REST_NO_BODY");
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      try { for (;;) { const part = await reader.read(); if (part.done) break;
        responseBytes += part.value.length; if (responseBytes > RESPONSE_LIMIT) throw new Error("REST_RESPONSE_LIMIT"); chunks.push(part.value); }
      } finally { await reader.cancel(); }
      receivedAtMs = clock(this.now());
      if (receivedAtMs < requestedAtMs) throw new Error("REST_REVERSED_CLOCK");
      const bytes = Buffer.concat(chunks); sha256 = createHash("sha256").update(bytes).digest("hex"); rawBody = bytes.toString("utf8");
      if (!Buffer.from(rawBody).equals(bytes)) { rawBodyBase64 = bytes.toString("base64"); throw new Error("REST_INVALID_UTF8"); }
      if (!response.ok) throw new Error(`REST_HTTP_${response.status}`);
      payload = JSON.parse(rawBody) as unknown;
    } catch (cause) { error = message(cause); }
    // Deliberately outside the network/JSON catch: durable evidence failures are fatal.
    const evidenceId = await this.onEvidence(kind, { url, requestedAtMs, receivedAtMs, httpStatus, rawBody, rawBodyBase64, sha256, responseBytes, serverDate, error });
    if (typeof evidenceId !== "string" || !evidenceId.length) throw new Error("REST_EVIDENCE_ID_MISSING");
    this.evidenceIds.set(kind, evidenceId);
    return { payload, error, receivedAtMs };
  }
  private ensureRefresh(): Promise<void> {
    if (this.fatal) return Promise.reject(this.fatal);
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh().catch(error => { this.failFatal(error); throw error; }).finally(() => { this.refreshInFlight = undefined; });
    }
    return this.refreshInFlight;
  }
  private async refresh(): Promise<void> {
    const atMs = clock(this.now());
    for (const symbol of ASSETS) {
      const retryMs = this.rules[symbol] ? RULE_INTERVAL_MS : REST_INTERVAL_MS;
      if (atMs - (this.lastRulesAttempts[symbol] ?? -Infinity) >= retryMs) {
        this.lastRulesAttempts[symbol] = atMs;
        const result = await this.source(`https://api.kraken.com/0/public/AssetPairs?pair=${PAIRS[symbol].rest}`, `rules-${PAIRS[symbol].rest}`);
        try {
          if (result.error) throw new Error(result.error);
          this.rules[symbol] = parseEth40Rules(result.payload, symbol); this.ruleTimes[symbol] = result.receivedAtMs; this.errors.delete(`rules-${symbol}`);
        } catch (error) { delete this.rules[symbol]; delete this.ruleTimes[symbol]; this.errors.set(`rules-${symbol}`, `${symbol}:${message(error)}`); }
      }
    }
    if (atMs - this.lastHistoryAttempt >= REST_INTERVAL_MS) {
      this.lastHistoryAttempt = atMs;
      for (const symbol of ASSETS) {
        const result = await this.source(`https://api.kraken.com/0/public/OHLC?pair=${PAIRS[symbol].rest}&interval=1440`, `history-${PAIRS[symbol].rest}`);
        try {
          if (result.error) throw new Error(result.error);
          const completed = parseEth40DailyHistory(result.payload, symbol, result.receivedAtMs);
          this.histories[symbol] = mergeEth40Histories(this.histories[symbol], completed); this.errors.delete(`history-${symbol}`);
        } catch (error) { this.errors.set(`history-${symbol}`, `${symbol}:${message(error)}`); }
      }
    }
  }
  public async snapshot(nowMs?: number): Promise<MarketSnapshot> {
    const requestedAtMs = clock(nowMs ?? this.now());
    await this.ensureRefresh();
    if (this.fatal) throw this.fatal;
    const observedAtMs = Math.max(requestedAtMs, clock(this.now()));
    const books: Partial<Record<Asset, VerifiedBook>> = {}, rules: Partial<Record<Asset, SpotPaperRules>> = {};
    const errors = [...this.errors.values()];
    for (const symbol of ASSETS) {
      const book = this.decimalBooks[symbol];
      if (this.running && this.socket?.readyState === WebSocket.OPEN && book?.checksumValid
        && observedAtMs - book.receivedAtMs >= 0 && observedAtMs - book.receivedAtMs <= ETH40_SPEC.maximumQuoteAgeMs
        && observedAtMs - book.exchangeUpdateAtMs >= -ETH40_SPEC.maximumExchangeClockLeadMs
        && observedAtMs - book.exchangeUpdateAtMs <= ETH40_SPEC.maximumQuoteAgeMs) {
        books[symbol] = { symbol, checksumValid: true, checksum: book.checksum, receivedAtMs: book.receivedAtMs,
          exchangeUpdateAtMs: book.exchangeUpdateAtMs, connectionId: this.connectionId,
          asks: book.asks.map(([price, quantity]) => [Number(price), Number(quantity)]),
          bids: book.bids.map(([price, quantity]) => [Number(price), Number(quantity)]),
          ...{ checksumAsks: book.asks.map(level => [...level] as ChecksumLevel), checksumBids: book.bids.map(level => [...level] as ChecksumLevel), checksumVerification: "LOCAL_TOP10_CRC32" as const } };
      } else errors.push(`${symbol}:BOOK_UNVERIFIED_OR_STALE`);
      const fetchedAt = this.ruleTimes[symbol];
      if (this.rules[symbol] && fetchedAt !== undefined && observedAtMs >= fetchedAt && observedAtMs - fetchedAt <= ETH40_SPEC.maximumRulesAgeMs) rules[symbol] = { ...this.rules[symbol]! };
      else errors.push(`${symbol}:RULES_UNAVAILABLE_OR_STALE`);
    }
    return { observedAtMs, histories: {
      "ETH/USD": this.errors.has("history-ETH/USD") ? [] : this.histories["ETH/USD"].map(bar => ({ ...bar })),
      "BTC/USD": this.errors.has("history-BTC/USD") ? [] : this.histories["BTC/USD"].map(bar => ({ ...bar })) },
      books, rules, rulesFetchedAtMs: Math.min(...ASSETS.map(symbol => this.ruleTimes[symbol] ?? 0)),
      rulesFetchedAtMsByAsset: Object.fromEntries(ASSETS.filter(symbol => rules[symbol]).map(symbol => [symbol, this.ruleTimes[symbol]!])), errors,
      evidenceIds: [...this.evidenceIds.values()] };
  }
}
