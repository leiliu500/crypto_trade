import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import type { OperationsMonitor } from "./operations-monitor.js";
import type { DashboardSnapshot } from "./types.js";
import { SpotPaperStatusProxy } from "./spot-proxy.js";
import { SpotPaperActivityReader } from "./spot-activity-reader.js";
import { Eth40PaperProxy, type Eth40Endpoint } from "./eth40-proxy.js";

export interface DashboardServerOptions {
  host: string;
  port: number;
  publicDirectory?: string;
  spotPaperStatusUrl?: string;
  spotPaperJournalDirectory?: string;
  eth40PaperBaseUrl?: string;
}

const MIME = new Map([
  ["index.html", "text/html; charset=utf-8"],
  ["app.js", "text/javascript; charset=utf-8"],
  ["spot.js", "text/javascript; charset=utf-8"],
  ["eth40.js", "text/javascript; charset=utf-8"],
  ["styles.css", "text/css; charset=utf-8"],
]);
const MAXIMUM_WEBSOCKET_BUFFERED_BYTES = 1024 * 1024;

export class DashboardServer {
  private server?: Server;
  private sockets?: WebSocketServer;
  private snapshotListener?: (snapshot: DashboardSnapshot) => void;
  private urlValue: string | null = null;
  private readonly spotPaperProxy: SpotPaperStatusProxy;
  private readonly spotPaperActivityReader: SpotPaperActivityReader;
  private readonly eth40PaperProxy: Eth40PaperProxy;

  public constructor(private readonly monitor: OperationsMonitor, private readonly options: DashboardServerOptions) {
    this.spotPaperProxy = new SpotPaperStatusProxy(options.spotPaperStatusUrl === undefined ? {}
      : { statusUrl: options.spotPaperStatusUrl });
    this.spotPaperActivityReader = new SpotPaperActivityReader(options.spotPaperJournalDirectory === undefined ? {}
      : { root: options.spotPaperJournalDirectory });
    this.eth40PaperProxy = new Eth40PaperProxy(options.eth40PaperBaseUrl === undefined ? {}
      : { baseUrl: options.eth40PaperBaseUrl });
  }

  public get url(): string | null { return this.urlValue; }

  public async start(): Promise<string> {
    if (this.server && this.urlValue) return this.urlValue;
    const publicDirectory = this.options.publicDirectory ?? join(dirname(fileURLToPath(import.meta.url)), "public");
    this.sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
    this.server = createServer((request, response) => { void this.route(request, response, publicDirectory); });
    this.server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/ws" || !this.sockets) { socket.destroy(); return; }
      this.sockets.handleUpgrade(request, socket, head, (client) => {
        this.sockets?.emit("connection", client, request);
      });
    });
    this.sockets.on("connection", (client) => {
      client.send(JSON.stringify({ type: "snapshot", data: this.monitor.snapshot() }));
    });
    this.snapshotListener = (snapshot): void => this.broadcast(snapshot);
    this.monitor.on("snapshot", this.snapshotListener);
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
      const onListening = (): void => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port, this.options.host);
    });
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : this.options.port;
    const displayHost = this.options.host === "0.0.0.0" ? "127.0.0.1" : this.options.host;
    this.urlValue = `http://${displayHost}:${port}`;
    return this.urlValue;
  }

  public async stop(): Promise<void> {
    if (this.snapshotListener) this.monitor.off("snapshot", this.snapshotListener);
    delete this.snapshotListener;
    if (this.sockets) {
      for (const client of this.sockets.clients) client.close(1001, "Dashboard shutting down");
      this.sockets.close();
      delete this.sockets;
    }
    if (this.server) {
      const server = this.server;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      delete this.server;
    }
    this.urlValue = null;
  }

  private broadcast(snapshot: DashboardSnapshot): void {
    if (!this.sockets || this.sockets.clients.size === 0) return;
    const clients = [...this.sockets.clients].filter((client) => client.readyState === WebSocket.OPEN);
    if (clients.length === 0) return;
    const message = JSON.stringify({ type: "snapshot", data: snapshot });
    for (const client of clients) {
      if (client.bufferedAmount > MAXIMUM_WEBSOCKET_BUFFERED_BYTES) continue;
      client.send(message);
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse, publicDirectory: string): Promise<void> {
    this.headers(response);
    const url = new URL(request.url ?? "/", "http://dashboard.local");
    const eth40Endpoint = new Map<string, Eth40Endpoint>([
      ["/api/eth40/status", "status"], ["/api/eth40/receipts", "receipts"], ["/api/eth40/manifest", "manifest"],
    ]).get(url.pathname);
    if (eth40Endpoint) {
      if (request.method !== "GET" && request.method !== "HEAD") { this.json(response, 405, { error: "method_not_allowed" }); return; }
      const result = await this.eth40PaperProxy.read(eth40Endpoint);
      this.json(response, result.statusCode, result.body); return;
    }
    if (request.method !== "GET") { this.json(response, 405, { error: "method_not_allowed" }); return; }
    if (url.pathname === "/healthz") {
      const snapshot = this.monitor.snapshot();
      this.json(response, snapshot.overall === "critical" ? 503 : 200, {
        status: snapshot.overall, generatedAtMs: snapshot.generatedAtMs, entriesAllowed: snapshot.entriesAllowed,
        database: snapshot.database.status,
      });
      return;
    }
    if (url.pathname === "/api/dashboard") { this.json(response, 200, this.monitor.snapshot()); return; }
    if (url.pathname === "/api/spot-dashboard") {
      const snapshot = await this.spotPaperProxy.snapshot();
      const body = snapshot.statusCode === 200 ? { ...snapshot.body,
        orderActivity: await this.spotPaperActivityReader.snapshot(snapshot.body.state) } : snapshot.body;
      this.json(response, snapshot.statusCode, body); return;
    }
    if (url.pathname === "/api/spot-order-activity") {
      const orderId = url.searchParams.get("orderId"), before = url.searchParams.get("before");
      if (!orderId || orderId.length > 240 || before !== null && before.length > 512) {
        this.json(response, 400, { available: false, error: "INVALID_SPOT_ACTIVITY_QUERY" }); return;
      }
      const result = await this.spotPaperActivityReader.page(orderId, before);
      this.json(response, result.available ? 200 : 503, result); return;
    }
    const dashboardPaths = new Set(["/", "/index.html", "/dashboard", "/dashboard/"]);
    const acceptsHtml = (request.headers.accept ?? "").includes("text/html");
    const isBrowserNavigation = acceptsHtml && !url.pathname.startsWith("/api/") && !url.pathname.split("/").at(-1)?.includes(".");
    const file = dashboardPaths.has(url.pathname) || isBrowserNavigation ? "index.html" : url.pathname === "/app.js" ? "app.js"
      : url.pathname === "/spot.js" ? "spot.js" : url.pathname === "/eth40.js" ? "eth40.js"
        : url.pathname === "/styles.css" ? "styles.css" : null;
    if (!file) { this.json(response, 404, { error: "not_found" }); return; }
    const path = join(publicDirectory, file);
    try { await access(path); }
    catch { this.json(response, 404, { error: "asset_not_found" }); return; }
    response.statusCode = 200;
    response.setHeader("Content-Type", MIME.get(file) ?? "application/octet-stream");
    createReadStream(path).pipe(response);
  }

  private headers(response: ServerResponse): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(value));
  }
}
