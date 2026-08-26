import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import type { Level, MarketTrade } from "../core/market.js";
import type { BookDelta } from "../core/order-book.js";

export interface KrakenFuturesMarketStreamConfig {
  websocketUrl: string;
  productsBySymbol: Readonly<Record<string, string>>;
  reconnectMaximumMs?: number;
  bookBatchMs?: number;
  bookDepth?: number;
}

type KrakenMessage = Record<string, unknown>;
interface BufferedBook {
  bids: Map<number, number>;
  asks: Map<number, number>;
  exchangeTsMs: number;
  receiveTsMs: number;
  sourceId: string;
  dirty: boolean;
}

/** Public production Kraken Futures feed. It has no order-routing capability. */
export class KrakenFuturesMarketStream extends EventEmitter {
  private socket?: WebSocket;
  private stopping = false;
  private attempt = 0;
  private pingTimer: NodeJS.Timeout | undefined;
  private bookFlushTimer: NodeJS.Timeout | undefined;
  private ready = false;
  private readonly subscribedFeeds = new Set<string>();
  private readonly bookSequences = new Map<string, number>();
  private readonly bufferedBooks = new Map<string, BufferedBook>();
  private readonly symbolByProduct: ReadonlyMap<string, string>;

  public constructor(private readonly cfg: KrakenFuturesMarketStreamConfig) {
    super();
    const entries = Object.entries(cfg.productsBySymbol);
    if (entries.length === 0) throw new Error("Kraken Futures symbol mapping cannot be empty");
    const products = entries.map(([, product]) => product);
    if (new Set(products).size !== products.length) throw new Error("Kraken Futures product mapping must be one-to-one");
    this.symbolByProduct = new Map(entries.map(([symbol, product]) => [product, symbol]));
  }

  public connect(): void {
    this.stopping = false;
    this.ready = false;
    this.subscribedFeeds.clear();
    this.bookSequences.clear();
    this.bufferedBooks.clear();
    this.clearBookFlushTimer();
    this.socket = new WebSocket(this.cfg.websocketUrl);
    this.socket.on("open", () => {
      this.attempt = 0;
      const productIds = [...this.symbolByProduct.keys()];
      this.socket?.send(JSON.stringify({ event: "subscribe", feed: "book", product_ids: productIds }));
      this.socket?.send(JSON.stringify({ event: "subscribe", feed: "trade", product_ids: productIds }));
      this.pingTimer = setInterval(() => this.socket?.ping(), 15_000);
      this.pingTimer.unref();
    });
    this.socket.on("message", (raw) => this.onMessage(raw));
    this.socket.on("pong", () => this.emit("heartbeat"));
    this.socket.on("error", (error) => this.emit("streamError", error));
    this.socket.on("close", () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = undefined;
      this.clearBookFlushTimer();
      this.emit("disconnect");
      if (!this.stopping) this.reconnect();
    });
  }

  public close(): void {
    this.stopping = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.clearBookFlushTimer();
    this.socket?.close();
  }

  public reconnectNow(): void {
    if (this.stopping) return;
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) this.connect();
    else this.socket.terminate();
  }

  private onMessage(raw: RawData): void {
    const receiveTsMs = Date.now();
    let message: KrakenMessage;
    try { message = JSON.parse(raw.toString("utf8")) as KrakenMessage; }
    catch (error) { this.emit("streamError", error); return; }
    if (message.event === "subscribed") {
      const feed = String(message.feed ?? "");
      if (feed === "book" || feed === "trade") this.subscribedFeeds.add(feed);
      if (!this.ready && this.subscribedFeeds.has("book") && this.subscribedFeeds.has("trade")) {
        this.ready = true;
        this.emit("authenticated");
      }
      return;
    }
    if (message.event === "subscribed_failed" || message.event === "error") {
      this.emit("streamError", new Error(`Kraken Futures stream error: ${String(message.message ?? message.event)}`));
      return;
    }
    if (message.feed === "heartbeat") { this.emit("heartbeat"); return; }
    const decoded = decodeKrakenFuturesMessage(message, receiveTsMs, this.symbolByProduct, this.bookSequences);
    if (decoded.kind === "sequence_gap") {
      this.emit("streamError", new Error(decoded.message));
      this.socket?.terminate();
    } else if (decoded.kind === "book") this.bufferBook(decoded.delta);
    else if (decoded.kind === "trade") this.emit("trade", decoded.trade);
  }

  private bufferBook(delta: BookDelta): void {
    const buffered = this.bufferedBooks.get(delta.symbol) ?? {
      bids: new Map(), asks: new Map(), exchangeTsMs: 0, receiveTsMs: 0, sourceId: "", dirty: false,
    };
    if (delta.reset) { buffered.bids.clear(); buffered.asks.clear(); }
    applyBufferedLevels(buffered.bids, delta.bids);
    applyBufferedLevels(buffered.asks, delta.asks);
    buffered.exchangeTsMs = delta.exchangeTsMs;
    buffered.receiveTsMs = delta.receiveTsMs;
    buffered.sourceId = delta.sourceId;
    buffered.dirty = true;
    this.bufferedBooks.set(delta.symbol, buffered);
    if (this.bookFlushTimer) return;
    this.bookFlushTimer = setTimeout(() => this.flushBooks(), Math.max(1, this.cfg.bookBatchMs ?? 25));
    this.bookFlushTimer.unref();
  }

  private flushBooks(): void {
    this.bookFlushTimer = undefined;
    const depth = Math.max(1, Math.floor(this.cfg.bookDepth ?? 200));
    for (const [symbol, buffered] of this.bufferedBooks) {
      if (!buffered.dirty) continue;
      buffered.dirty = false;
      this.emit("book", {
        symbol,
        bids: sortedBufferedLevels(buffered.bids, true, depth),
        asks: sortedBufferedLevels(buffered.asks, false, depth),
        reset: true,
        exchangeTsMs: buffered.exchangeTsMs,
        receiveTsMs: buffered.receiveTsMs,
        sourceId: `${buffered.sourceId}-batch`,
      } satisfies BookDelta);
    }
  }

  private clearBookFlushTimer(): void {
    if (this.bookFlushTimer) clearTimeout(this.bookFlushTimer);
    this.bookFlushTimer = undefined;
  }

  private reconnect(): void {
    const delayMs = Math.min(this.cfg.reconnectMaximumMs ?? 30_000, 250 * 2 ** this.attempt++);
    setTimeout(() => { if (!this.stopping) this.connect(); }, delayMs).unref();
  }
}

export type DecodedKrakenFuturesMessage =
  | { kind: "book"; delta: BookDelta }
  | { kind: "trade"; trade: MarketTrade }
  | { kind: "sequence_gap"; message: string }
  | { kind: "ignored" };

export function decodeKrakenFuturesMessage(message: KrakenMessage, receiveTsMs: number,
  symbolByProduct: ReadonlyMap<string, string>, bookSequences: Map<string, number>): DecodedKrakenFuturesMessage {
  const feed = String(message.feed ?? "");
  const product = String(message.product_id ?? "");
  const symbol = symbolByProduct.get(product);
  if (!symbol) return { kind: "ignored" };
  if (feed === "book_snapshot") {
    const sequence = positiveInteger(message.seq);
    const exchangeTsMs = finiteTimestamp(message.timestamp);
    if (sequence === null || exchangeTsMs === null) return { kind: "ignored" };
    bookSequences.set(product, sequence);
    return { kind: "book", delta: {
      symbol, bids: parseLevels(message.bids), asks: parseLevels(message.asks), reset: true,
      exchangeTsMs, receiveTsMs, sourceId: `kraken-book-${product}-${sequence}`,
    } };
  }
  if (feed === "book") {
    const sequence = positiveInteger(message.seq);
    const previous = bookSequences.get(product);
    const exchangeTsMs = finiteTimestamp(message.timestamp);
    if (sequence === null || previous === undefined || exchangeTsMs === null) return { kind: "ignored" };
    if (sequence !== previous + 1) return { kind: "sequence_gap", message: `Kraken ${product} book sequence gap: expected ${previous + 1}, received ${sequence}` };
    bookSequences.set(product, sequence);
    const level = parseLevel(message);
    if (!level) return { kind: "ignored" };
    return { kind: "book", delta: {
      symbol, bids: message.side === "buy" ? [level] : [], asks: message.side === "sell" ? [level] : [], reset: false,
      exchangeTsMs, receiveTsMs, sourceId: `kraken-book-${product}-${sequence}`,
    } };
  }
  // A trade snapshot is retrospective and must not advance causal live features.
  if (feed !== "trade") return { kind: "ignored" };
  const price = Number(message.price), qty = Number(message.qty);
  const exchangeTsMs = finiteTimestamp(message.time);
  if (!(price > 0) || !(qty > 0) || exchangeTsMs === null) return { kind: "ignored" };
  const id = typeof message.uid === "string" ? message.uid : `kraken-trade-${product}-${String(message.seq ?? exchangeTsMs)}`;
  return { kind: "trade", trade: {
    id, symbol, px: price, qty, aggressor: message.side === "sell" ? -1 : 1,
    exchangeTsMs, receiveTsMs,
  } };
}

function parseLevels(value: unknown): Level[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const level = item && typeof item === "object" ? parseLevel(item as KrakenMessage) : null;
    return level ? [level] : [];
  }) : [];
}

function parseLevel(value: KrakenMessage): Level | null {
  const px = Number(value.price), qty = Number(value.qty);
  return px > 0 && Number.isFinite(qty) && qty >= 0 ? { px, qty } : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function finiteTimestamp(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function applyBufferedLevels(target: Map<number, number>, levels: readonly Level[]): void {
  for (const level of levels) {
    if (level.qty === 0) target.delete(level.px);
    else target.set(level.px, level.qty);
  }
}

function sortedBufferedLevels(levels: Map<number, number>, descending: boolean, depth: number): Level[] {
  return [...levels.entries()]
    .sort((left, right) => descending ? right[0] - left[0] : left[0] - right[0])
    .slice(0, depth)
    .map(([px, qty]) => ({ px, qty }));
}
