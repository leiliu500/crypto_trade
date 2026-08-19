import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket, { type RawData } from "ws";
import type { PrivateOrderEvent } from "../execution/order-state.js";
import type { AlpacaCredentials, AlpacaOrder } from "./types.js";

export interface TradeStreamConfig { credentials: AlpacaCredentials; paper: boolean; reconnectMaximumMs?: number; }
interface Envelope { stream?: string; data?: Record<string, unknown>; action?: string; }

export class AlpacaTradeStream extends EventEmitter {
  private socket?: WebSocket;
  private stopping = false;
  private attempt = 0;
  private pingTimer?: NodeJS.Timeout;
  public constructor(private readonly cfg: TradeStreamConfig) { super(); }
  public connect(): void {
    this.stopping = false;
    this.socket = new WebSocket(this.cfg.paper ? "wss://paper-api.alpaca.markets/stream" : "wss://api.alpaca.markets/stream");
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
  private onMessage(raw: RawData): void {
    const text = raw.toString("utf8");
    let envelope: Envelope;
    try { envelope = JSON.parse(text) as Envelope; } catch (error) { this.emit("streamError", error); return; }
    if (envelope.stream === "authorization" && envelope.data?.status === "authorized") {
      this.socket?.send(JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } }));
      this.emit("authenticated"); return;
    }
    if (envelope.action === "error") { this.emit("streamError", new Error(String(envelope.data?.error_message ?? "trade stream error"))); return; }
    if (envelope.stream !== "trade_updates" || !envelope.data) return;
    const data = envelope.data;
    const order = data.order as unknown as AlpacaOrder | undefined;
    if (!order) return;
    const event = String(data.event ?? "unknown");
    const eventId = String(data.event_id ?? data.execution_id ?? createHash("sha256").update(text).digest("hex"));
    const parsed: PrivateOrderEvent = {
      id: eventId, event, orderId: order.id, clientOrderId: order.client_order_id, symbol: order.symbol,
      filledQty: Number(order.filled_qty ?? 0), eventQty: Number(data.qty ?? 0), eventPx: Number(data.price ?? order.filled_avg_price ?? 0),
      timestampMs: Date.parse(String(data.timestamp ?? order.updated_at ?? new Date().toISOString())),
    };
    this.emit("order", parsed);
  }
  private reconnect(): void {
    const delayMs = Math.min(this.cfg.reconnectMaximumMs ?? 30_000, 250 * 2 ** this.attempt++);
    setTimeout(() => { if (!this.stopping) this.connect(); }, delayMs).unref();
  }
}
