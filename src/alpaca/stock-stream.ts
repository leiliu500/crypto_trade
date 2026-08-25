import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import type { AlpacaCredentials } from "./types.js";

export interface AlpacaStockStreamConfig {
  credentials: AlpacaCredentials;
  symbols: readonly string[];
  feed: "iex" | "sip";
  reconnectMaximumMs?: number;
}

export interface AlpacaStockStreamQuote {
  symbol: string;
  timestampMs: number;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
}

/** Real-time proxy ETF quotes used by the crypto options route. */
export class AlpacaStockStream extends EventEmitter {
  private socket?: WebSocket;
  private stopping = false;
  private authenticated = false;
  private attempt = 0;

  public constructor(private readonly cfg: AlpacaStockStreamConfig) { super(); }

  public connect(): void {
    this.stopping = false;
    this.authenticated = false;
    this.socket = new WebSocket(`wss://stream.data.alpaca.markets/v2/${this.cfg.feed}`);
    this.socket.on("open", () => {
      this.attempt = 0;
      this.socket!.send(JSON.stringify({ action: "auth", key: this.cfg.credentials.keyId, secret: this.cfg.credentials.secretKey }));
    });
    this.socket.on("message", (raw) => this.onMessage(raw));
    this.socket.on("error", (error) => this.emit("streamError", error));
    this.socket.on("close", () => {
      const wasReady = this.authenticated;
      this.authenticated = false;
      this.emit("disconnect", { wasReady });
      if (!this.stopping) this.reconnect();
    });
  }

  public close(): void { this.stopping = true; this.socket?.close(); }
  public ready(): boolean { return this.authenticated; }

  private onMessage(raw: RawData): void {
    let messages: Array<Record<string, unknown>>;
    try {
      const parsed = JSON.parse(raw.toString("utf8")) as unknown;
      messages = Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
    } catch (error) { this.emit("streamError", error); return; }
    for (const message of messages) {
      if (message.T === "success" && message.msg === "authenticated") {
        this.authenticated = true;
        this.socket?.send(JSON.stringify({ action: "subscribe", quotes: [...this.cfg.symbols] }));
        this.emit("authenticated");
      } else if (message.T === "error") {
        this.emit("streamError", new Error(`Alpaca stock stream ${String(message.code ?? "error")}: ${String(message.msg ?? "unknown")}`));
      } else if (message.T === "q") {
        const quote: AlpacaStockStreamQuote = {
          symbol: String(message.S ?? ""), timestampMs: Date.parse(String(message.t ?? "")),
          bidPrice: Number(message.bp), bidSize: Number(message.bs), askPrice: Number(message.ap), askSize: Number(message.as),
        };
        if (quote.symbol && Number.isFinite(quote.timestampMs) && quote.bidPrice > 0 && quote.askPrice > quote.bidPrice
          && quote.bidSize > 0 && quote.askSize > 0) this.emit("quote", quote);
      }
    }
  }

  private reconnect(): void {
    const delayMs = Math.min(this.cfg.reconnectMaximumMs ?? 30_000, 250 * 2 ** this.attempt++);
    setTimeout(() => { if (!this.stopping) this.connect(); }, delayMs).unref();
  }
}
