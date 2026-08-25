import { EventEmitter } from "node:events";
import { decode, encode } from "@msgpack/msgpack";
import WebSocket, { type RawData } from "ws";
import type { AlpacaCredentials } from "./types.js";

export interface AlpacaOptionStreamConfig {
  credentials: AlpacaCredentials;
  feed: "opra" | "indicative";
  reconnectMaximumMs?: number;
}

export interface AlpacaOptionStreamQuote {
  symbol: string;
  timestampMs: number;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
}

export interface AlpacaOptionStreamTrade { symbol: string; timestampMs: number; price: number; size: number; }

/** Alpaca options stream. Options data is msgpack-only and never authorizes from a REST snapshot. */
export class AlpacaOptionStream extends EventEmitter {
  private socket?: WebSocket;
  private stopping = false;
  private authenticated = false;
  private attempt = 0;
  private desiredSymbols = new Set<string>();
  private subscribedSymbols = new Set<string>();

  public constructor(private readonly cfg: AlpacaOptionStreamConfig) { super(); }

  public connect(): void {
    this.stopping = false;
    this.authenticated = false;
    this.subscribedSymbols.clear();
    this.socket = new WebSocket(`wss://stream.data.alpaca.markets/v1beta1/${this.cfg.feed}`, {
      headers: { "Content-Type": "application/msgpack" },
    });
    this.socket.on("open", () => {
      this.attempt = 0;
      this.send({ action: "auth", key: this.cfg.credentials.keyId, secret: this.cfg.credentials.secretKey });
    });
    this.socket.on("message", (raw) => this.onMessage(raw));
    this.socket.on("error", (error) => this.emit("streamError", error));
    this.socket.on("close", () => {
      const wasReady = this.authenticated;
      this.authenticated = false;
      this.subscribedSymbols.clear();
      this.emit("disconnect", { wasReady });
      if (!this.stopping) this.reconnect();
    });
  }

  public close(): void { this.stopping = true; this.socket?.close(); }
  public ready(): boolean { return this.authenticated; }

  public setSymbols(symbols: readonly string[]): void {
    const next = new Set(symbols);
    const subscribe = [...next].filter((symbol) => !this.subscribedSymbols.has(symbol));
    const unsubscribe = [...this.subscribedSymbols].filter((symbol) => !next.has(symbol));
    this.desiredSymbols = next;
    if (!this.authenticated) return;
    if (unsubscribe.length) this.send({ action: "unsubscribe", quotes: unsubscribe, trades: unsubscribe });
    if (subscribe.length) this.send({ action: "subscribe", quotes: subscribe, trades: subscribe });
  }

  private onMessage(raw: RawData): void {
    let messages: Array<Record<string, unknown>>;
    try { messages = decodeOptionStreamMessages(rawDataBytes(raw)); }
    catch (error) { this.emit("streamError", error); return; }
    for (const message of messages) {
      if (message.T === "success" && message.msg === "authenticated") {
        this.authenticated = true;
        this.emit("authenticated");
        this.setSymbols([...this.desiredSymbols]);
      } else if (message.T === "subscription") {
        this.subscribedSymbols = new Set(Array.isArray(message.quotes) ? message.quotes.map(String) : []);
        this.emit("subscription", { symbols: [...this.subscribedSymbols] });
      } else if (message.T === "error") {
        this.emit("streamError", new Error(`Alpaca option stream ${String(message.code ?? "error")}: ${String(message.msg ?? "unknown")}`));
      } else if (message.T === "q") {
        const quote: AlpacaOptionStreamQuote = {
          symbol: String(message.S ?? ""), timestampMs: Date.parse(String(message.t ?? "")),
          bidPrice: Number(message.bp), bidSize: Number(message.bs), askPrice: Number(message.ap), askSize: Number(message.as),
        };
        if (quote.symbol && Number.isFinite(quote.timestampMs) && quote.bidPrice >= 0 && quote.askPrice > 0
          && quote.askPrice >= quote.bidPrice && quote.askSize > 0) this.emit("quote", quote);
      } else if (message.T === "t") {
        const trade: AlpacaOptionStreamTrade = {
          symbol: String(message.S ?? ""), timestampMs: Date.parse(String(message.t ?? "")),
          price: Number(message.p), size: Number(message.s),
        };
        if (trade.symbol && Number.isFinite(trade.timestampMs) && trade.price > 0 && trade.size > 0) this.emit("trade", trade);
      }
    }
  }

  private send(value: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(encode(value));
  }

  private reconnect(): void {
    const delayMs = Math.min(this.cfg.reconnectMaximumMs ?? 30_000, 250 * 2 ** this.attempt++);
    setTimeout(() => { if (!this.stopping) this.connect(); }, delayMs).unref();
  }
}

export function decodeOptionStreamMessages(bytes: Uint8Array): Array<Record<string, unknown>> {
  const decoded: unknown = decode(bytes);
  return Array.isArray(decoded) ? decoded as Array<Record<string, unknown>> : [];
}

function rawDataBytes(raw: RawData): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}
