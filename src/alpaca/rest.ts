import type {
  ActivitiesQuery, AlpacaAccount, AlpacaAccountConfiguration, AlpacaActivity, AlpacaApiResponse,
  AlpacaAsset, AlpacaClientConfig, AlpacaClock, AlpacaCreateOrder, AlpacaOrder, AlpacaOrderbook,
  AlpacaPosition, AlpacaReplaceOrder, AlpacaSnapshot, HistoricalQuery, ListOrdersQuery,
} from "./types.js";

export class AlpacaApiError extends Error {
  public constructor(message: string, public readonly status: number, public readonly requestId?: string, public readonly timedOut = false) { super(message); }
}

export class AlpacaRestClient {
  private readonly tradingBaseUrl: string;
  private readonly dataBaseUrl: string;
  private readonly location: string;
  private readonly timeoutMs: number;
  private readonly maximumGetRetries: number;
  public constructor(private readonly cfg: AlpacaClientConfig, private readonly fetcher: typeof fetch = fetch) {
    this.tradingBaseUrl = cfg.tradingBaseUrl ?? (cfg.paper ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets");
    this.dataBaseUrl = cfg.dataBaseUrl ?? "https://data.alpaca.markets";
    this.location = cfg.cryptoLocation ?? "us";
    this.timeoutMs = cfg.requestTimeoutMs ?? 5_000;
    this.maximumGetRetries = cfg.maximumGetRetries ?? 2;
  }

  public getAccount(): Promise<AlpacaApiResponse<AlpacaAccount>> { return this.trading("GET", "/v2/account"); }
  public getAccountConfiguration(): Promise<AlpacaApiResponse<AlpacaAccountConfiguration>> { return this.trading("GET", "/v2/account/configurations"); }
  public updateAccountConfiguration(patch: Partial<AlpacaAccountConfiguration>): Promise<AlpacaApiResponse<AlpacaAccountConfiguration>> { return this.trading("PATCH", "/v2/account/configurations", patch); }
  public getClock(): Promise<AlpacaApiResponse<AlpacaClock>> { return this.trading("GET", "/v2/clock"); }
  public listAssets(query: { status?: string; asset_class?: string; exchange?: string } = {}): Promise<AlpacaApiResponse<AlpacaAsset[]>> { return this.trading("GET", `/v2/assets${queryString(query)}`); }
  public getAsset(symbolOrId: string): Promise<AlpacaApiResponse<AlpacaAsset>> { return this.trading("GET", `/v2/assets/${encodeURIComponent(symbolOrId)}`); }

  public listOrders(query: ListOrdersQuery = {}): Promise<AlpacaApiResponse<AlpacaOrder[]>> { return this.trading("GET", `/v2/orders${queryString(query)}`); }
  public getOrder(orderId: string): Promise<AlpacaApiResponse<AlpacaOrder>> { return this.trading("GET", `/v2/orders/${encodeURIComponent(orderId)}`); }
  public getOrderByClientId(clientOrderId: string): Promise<AlpacaApiResponse<AlpacaOrder>> { return this.trading("GET", `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`); }
  public createOrder(order: AlpacaCreateOrder): Promise<AlpacaApiResponse<AlpacaOrder>> { return this.trading("POST", "/v2/orders", order); }
  public replaceOrder(orderId: string, replacement: AlpacaReplaceOrder): Promise<AlpacaApiResponse<AlpacaOrder>> { return this.trading("PATCH", `/v2/orders/${encodeURIComponent(orderId)}`, replacement); }
  public async cancelOrder(orderId: string): Promise<AlpacaApiResponse<void>> { return this.trading("DELETE", `/v2/orders/${encodeURIComponent(orderId)}`); }
  public cancelAllOrders(): Promise<AlpacaApiResponse<Array<{ id: string; status: number; body?: unknown }>>> { return this.trading("DELETE", "/v2/orders"); }

  public listPositions(): Promise<AlpacaApiResponse<AlpacaPosition[]>> { return this.trading("GET", "/v2/positions"); }
  public getPosition(symbolOrAssetId: string): Promise<AlpacaApiResponse<AlpacaPosition>> { return this.trading("GET", `/v2/positions/${encodeURIComponent(symbolOrAssetId)}`); }
  public closePosition(symbolOrAssetId: string, options: { qty?: string; percentage?: string } = {}): Promise<AlpacaApiResponse<AlpacaOrder>> { return this.trading("DELETE", `/v2/positions/${encodeURIComponent(symbolOrAssetId)}${queryString(options)}`); }
  public closeAllPositions(cancelOrders = true): Promise<AlpacaApiResponse<Array<{ symbol: string; status: number; body?: unknown }>>> { return this.trading("DELETE", `/v2/positions?cancel_orders=${String(cancelOrders)}`); }
  public getActivities(query: ActivitiesQuery = {}): Promise<AlpacaApiResponse<AlpacaActivity[]>> { return this.trading("GET", `/v2/account/activities${queryString(query)}`); }
  public getPortfolioHistory(query: { period?: string; timeframe?: string; date_end?: string; extended_hours?: boolean } = {}): Promise<AlpacaApiResponse<unknown>> { return this.trading("GET", `/v2/account/portfolio/history${queryString(query)}`); }

  public latestOrderbooks(symbols: readonly string[]): Promise<AlpacaApiResponse<{ orderbooks: Record<string, AlpacaOrderbook> }>> { return this.data("GET", `/v1beta3/crypto/${this.location}/latest/orderbooks?symbols=${encodeURIComponent(symbols.join(","))}`); }
  public latestQuotes(symbols: readonly string[]): Promise<AlpacaApiResponse<unknown>> { return this.data("GET", `/v1beta3/crypto/${this.location}/latest/quotes?symbols=${encodeURIComponent(symbols.join(","))}`); }
  public latestTrades(symbols: readonly string[]): Promise<AlpacaApiResponse<unknown>> { return this.data("GET", `/v1beta3/crypto/${this.location}/latest/trades?symbols=${encodeURIComponent(symbols.join(","))}`); }
  public latestBars(symbols: readonly string[]): Promise<AlpacaApiResponse<unknown>> { return this.data("GET", `/v1beta3/crypto/${this.location}/latest/bars?symbols=${encodeURIComponent(symbols.join(","))}`); }
  public snapshots(symbols: readonly string[]): Promise<AlpacaApiResponse<{ snapshots: Record<string, AlpacaSnapshot> }>> { return this.data("GET", `/v1beta3/crypto/${this.location}/snapshots?symbols=${encodeURIComponent(symbols.join(","))}`); }
  public bars(query: HistoricalQuery): Promise<AlpacaApiResponse<unknown>> { return this.data("GET", `/v1beta3/crypto/${this.location}/bars${queryString(query)}`); }
  public quotes(query: HistoricalQuery): Promise<AlpacaApiResponse<unknown>> { return this.data("GET", `/v1beta3/crypto/${this.location}/quotes${queryString(query)}`); }
  public trades(query: HistoricalQuery): Promise<AlpacaApiResponse<unknown>> { return this.data("GET", `/v1beta3/crypto/${this.location}/trades${queryString(query)}`); }

  private trading<T>(method: string, path: string, body?: unknown): Promise<AlpacaApiResponse<T>> { return this.request(method, this.tradingBaseUrl + path, body); }
  private data<T>(method: string, path: string, body?: unknown): Promise<AlpacaApiResponse<T>> { return this.request(method, this.dataBaseUrl + path, body); }
  private async request<T>(method: string, url: string, body?: unknown): Promise<AlpacaApiResponse<T>> {
    const retries = method === "GET" ? this.maximumGetRetries : 0;
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetcher(url, {
          method,
          headers: {
            "APCA-API-KEY-ID": this.cfg.credentials.keyId,
            "APCA-API-SECRET-KEY": this.cfg.credentials.secretKey,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        });
        const requestId = response.headers.get("x-request-id") ?? undefined;
        const text = await response.text();
        const payload = text ? safeJson(text) : undefined;
        if (!response.ok) {
          if (attempt < retries && (response.status === 429 || response.status >= 500)) {
            await delay(retryDelay(response.headers.get("retry-after"), attempt));
            continue;
          }
          throw new AlpacaApiError(errorMessage(payload, response.status), response.status, requestId);
        }
        return { data: payload as T, status: response.status, ...(requestId ? { requestId } : {}) };
      } catch (error) {
        if (error instanceof AlpacaApiError) throw error;
        const timedOut = error instanceof Error && error.name === "AbortError";
        if (attempt < retries) { await delay(100 * 2 ** attempt); continue; }
        throw new AlpacaApiError(timedOut ? "Alpaca request timed out" : `Alpaca request failed: ${error instanceof Error ? error.message : String(error)}`, 0, undefined, timedOut);
      } finally { clearTimeout(timer); }
    }
  }
}

function queryString(query: object): string {
  const entries = Object.entries(query).filter(([, value]) => value !== undefined && value !== null);
  if (!entries.length) return "";
  return `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&")}`;
}
function safeJson(text: string): unknown { try { return JSON.parse(text); } catch { return text; } }
function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string") return payload.message;
  return `Alpaca API returned HTTP ${status}`;
}
function retryDelay(retryAfter: string | null, attempt: number): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1_000) : 100 * 2 ** attempt;
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
