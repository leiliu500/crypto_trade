import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import type { Level, MarketTrade } from "../core/market.js";
import type { BookDelta } from "../core/order-book.js";
import type { AlpacaCredentials } from "./types.js";

export interface MarketStreamConfig { credentials: AlpacaCredentials; symbols: readonly string[]; location: string; sandbox?: boolean; reconnectMaximumMs?: number; }
type AlpacaStreamMessage = Record<string, unknown> & { T?: string; S?: string; t?: string };

export class AlpacaMarketStream extends EventEmitter {
  private socket?: WebSocket;
  private stopping = false;
  private attempt = 0;
  private pingTimer?: NodeJS.Timeout;
  public constructor(private readonly cfg: MarketStreamConfig) { super(); }
  public connect(): void {
    this.stopping = false;
    const host = this.cfg.sandbox ? "stream.data.sandbox.alpaca.markets" : "stream.data.alpaca.markets";
    this.socket = new WebSocket(`wss://${host}/v1beta3/crypto/${this.cfg.location}`);
    this.socket.on("open", () => {
      this.attempt = 0;
      this.socket!.send(JSON.stringify({ action: "auth", key: this.cfg.credentials.keyId, secret: this.cfg.credentials.secretKey }));
      this.pingTimer = setInterval(() => this.socket?.ping(), 15_000);
    });
    this.socket.on("message", (raw) => this.onMessage(raw));
    this.socket.on("pong", () => this.emit("heartbeat"));
    this.socket.on("error", (error) => this.emit("streamError", error));
    this.socket.on("close", () => { if (this.pingTimer) clearInterval(this.pingTimer); this.emit("disconnect"); if (!this.stopping) this.reconnect(); });
  }
  public close(): void { this.stopping = true; if (this.pingTimer) clearInterval(this.pingTimer); this.socket?.close(); }
  /** Force a fresh subscription so the next order-book event is a reset snapshot. */
  public reconnectNow(): void {
    if (this.stopping) return;
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) { this.connect(); return; }
    this.socket.terminate();
  }
  private onMessage(raw: RawData): void {
    const receiveTsMs = Date.now();
    const text = raw.toString("utf8");
    let messages: AlpacaStreamMessage[];
    try { const parsed = JSON.parse(text) as unknown; messages = Array.isArray(parsed) ? parsed as AlpacaStreamMessage[] : [parsed as AlpacaStreamMessage]; }
    catch (error) { this.emit("streamError", error); return; }
    messages.forEach((message, index) => {
      if (message.T === "success" && message.msg === "authenticated") {
        this.socket?.send(JSON.stringify({ action: "subscribe", trades: this.cfg.symbols, quotes: this.cfg.symbols, orderbooks: this.cfg.symbols }));
        this.emit("authenticated"); return;
      }
      if (message.T === "error") { this.emit("streamError", new Error(`Alpaca market stream error: ${String(message.msg)}`)); return; }
      const sourceId = createHash("sha256").update(`${text}:${index}`).digest("hex");
      if (message.T === "o") {
        const delta = parseBook(message, receiveTsMs, sourceId);
        if (delta) this.emit("book", delta);
      } else if (message.T === "t") {
        const trade = parseTrade(message, receiveTsMs, sourceId);
        if (trade) this.emit("trade", trade);
      } else if (message.T === "q") this.emit("quote", message);
    });
  }
  private reconnect(): void {
    const delayMs = Math.min(this.cfg.reconnectMaximumMs ?? 30_000, 250 * 2 ** this.attempt++);
    setTimeout(() => { if (!this.stopping) this.connect(); }, delayMs).unref();
  }
}

function parseBook(message: AlpacaStreamMessage, receiveTsMs: number, sourceId: string): BookDelta | null {
  if (typeof message.S !== "string" || typeof message.t !== "string") return null;
  const exchangeTsMs = Date.parse(message.t);
  if (!Number.isFinite(exchangeTsMs)) return null;
  return {
    symbol: message.S,
    bids: parseLevels(message.b), asks: parseLevels(message.a), reset: message.r === true,
    exchangeTsMs, receiveTsMs, sourceId,
  };
}
function parseLevels(value: unknown): Level[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const p = Number((item as Record<string, unknown>).p), s = Number((item as Record<string, unknown>).s);
    return Number.isFinite(p) && p > 0 && Number.isFinite(s) && s >= 0 ? [{ px: p, qty: s }] : [];
  });
}
function parseTrade(message: AlpacaStreamMessage, receiveTsMs: number, sourceId: string): MarketTrade | null {
  const px = Number(message.p), qty = Number(message.s), exchangeTsMs = typeof message.t === "string" ? Date.parse(message.t) : NaN;
  if (typeof message.S !== "string" || !(px > 0) || !(qty > 0) || !Number.isFinite(exchangeTsMs)) return null;
  return { id: sourceId, symbol: message.S, px, qty, aggressor: message.tks === "S" ? -1 : 1, exchangeTsMs, receiveTsMs };
}
