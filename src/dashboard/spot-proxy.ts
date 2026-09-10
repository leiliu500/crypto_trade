const DEFAULT_SPOT_PAPER_STATUS_URL = "http://crypto-spot-trend-paper:3002/status";
const MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_LEDGER_ITEMS = 10_000;

type ObjectValue = Record<string, unknown>;
interface ProxyResult { statusCode: 200 | 503; body: ObjectValue; fetchedAtMs: number }
export interface SpotPaperProxyOptions { statusUrl?: string; timeoutMs?: number; cacheMs?: number }

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function nonnegative(value: unknown): value is number { return finite(value) && value >= 0; }
function timestamp(value: unknown): value is number { return nonnegative(value) && Number.isSafeInteger(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512; }
const ORDER_STATUSES = ["SUBMITTED", "ACCEPTED", "FILLED", "CANCELED", "REJECTED"];
function validOrders(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAXIMUM_LEDGER_ITEMS && value.every(order => {
    if (!object(order) || !object(order.request) || !text(order.orderId) || !ORDER_STATUSES.includes(String(order.status))
      || !nonnegative(order.filledQuantity) || !(order.averageFillPrice === null || nonnegative(order.averageFillPrice))
      || !nonnegative(order.feeUsd) || !(order.rejectionReason === null || text(order.rejectionReason))
      || !(order.cancellationReason === null || text(order.cancellationReason)) || !Array.isArray(order.events)
      || order.events.length > 100) return false;
    const request = order.request;
    // Rejected requests may contain finite invalid quantities or unsupported symbols.
    return text(request.clientOrderId) && text(request.symbol) && text(request.side) && text(request.timeInForce)
      && [request.quantity, request.limitPrice, request.feeBps].every(finite) && typeof request.reduceOnly === "boolean"
      && timestamp(request.createdAtMs) && order.events.every(event => object(event)
        && [...ORDER_STATUSES, "PARTIAL_FILL"].includes(String(event.type)) && timestamp(event.timestampMs)
        && (event.detail === undefined || text(event.detail)));
  });
}

/** This endpoint accepts paper telemetry, never an order destination or a live account. */
function validStatus(value: unknown): value is ObjectValue {
  if (!object(value) || value.mode !== "RESEARCH_PAPER" || value.liveTradingEnabled !== false
    || value.provenProfitable !== false || typeof value.healthy !== "boolean"
    || !timestamp(value.lastSuccessMs) || !(value.lastError === null || typeof value.lastError === "string")
    || !object(value.strategy) || !finite(value.strategy.cycleIntervalMs)
    || value.strategy.cycleIntervalMs <= 0 || value.strategy.cycleIntervalMs > 3_600_000
    || !object(value.state)) return false;
  const state = value.state;
  if (state.mode !== "RESEARCH_PAPER" || !text(state.version) || !timestamp(state.startedAtMs)
    || !timestamp(state.lastCycleMs) || !timestamp(state.cycles) || !object(state.account)) return false;
  const account = state.account;
  if (![account.initialCashUsd, account.cashUsd, account.quantity, account.entryCostUsd, account.feesUsd].every(nonnegative)
    || !finite(account.realizedNetUsd) || !Array.isArray(account.receipts) || account.receipts.length > MAXIMUM_LEDGER_ITEMS)
    return false;
  if (!account.receipts.every(receipt => object(receipt) && text(receipt.id)
    && ["buy", "sell"].includes(String(receipt.side))
    && finite(receipt.quantity) && receipt.quantity > 0 && finite(receipt.price) && receipt.price > 0
    && nonnegative(receipt.feeBps) && receipt.feeBps < 10_000 && timestamp(receipt.timestampMs))) return false;
  if ((state.orders !== undefined || value.orderSubmissionEnabled === true) && !validOrders(state.orders)) return false;
  if (value.orderSubmissionEnabled !== undefined && typeof value.orderSubmissionEnabled !== "boolean") return false;
  return true;
}

/** Fixed operator-selected upstream; requests cannot override its URL or forward credentials. */
export class SpotPaperStatusProxy {
  private readonly statusUrl: URL | null;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private cached: { result: ProxyResult; expiresAtMs: number } | undefined;
  private inFlight: Promise<ProxyResult> | undefined;

  public constructor(options: SpotPaperProxyOptions = {}) {
    let url: URL | null = null;
    try {
      const candidate = new URL(options.statusUrl ?? process.env.SPOT_PAPER_STATUS_URL ?? DEFAULT_SPOT_PAPER_STATUS_URL);
      if (["http:", "https:"].includes(candidate.protocol) && !candidate.username && !candidate.password
        && !candidate.hash) url = candidate;
    } catch { /* A configuration error makes only the spot panel unavailable. */ }
    this.statusUrl = url;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.cacheMs = options.cacheMs ?? 3_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_000
      || !Number.isFinite(this.cacheMs) || this.cacheMs < 0 || this.cacheMs > 3_000)
      throw new Error("INVALID_SPOT_PROXY_LIMITS");
  }

  public async snapshot(): Promise<{ statusCode: 200 | 503; body: ObjectValue }> {
    let result: ProxyResult;
    if (this.cached && this.cached.expiresAtMs > Date.now()) result = this.cached.result;
    else {
      if (!this.inFlight) {
        this.inFlight = this.fetchStatus().then(fetched => {
          this.cached = { result: fetched, expiresAtMs: Date.now() + this.cacheMs };
          return fetched;
        }).finally(() => { this.inFlight = undefined; });
      }
      result = await this.inFlight;
    }
    const generatedAtMs = Date.now();
    if (result.statusCode !== 200) return { statusCode: 503,
      body: { available: false, generatedAtMs, error: "SPOT_PAPER_UNAVAILABLE" } };
    const body: ObjectValue = { ...result.body, available: true, generatedAtMs, upstreamFetchedAtMs: result.fetchedAtMs };
    const lastSuccessMs = result.body.lastSuccessMs as number;
    const interval = (result.body.strategy as ObjectValue).cycleIntervalMs as number;
    if (body.healthy === true && (lastSuccessMs <= 0 || lastSuccessMs > generatedAtMs + 5_000
      || generatedAtMs - lastSuccessMs >= 2 * interval)) {
      body.healthy = false;
      if (body.lastError === null) body.lastError = "SPOT_PAPER_STATUS_STALE";
    }
    return { statusCode: 200, body };
  }

  private async fetchStatus(): Promise<ProxyResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (!this.statusUrl) throw new Error("SPOT_PROXY_URL_UNAVAILABLE");
      const response = await fetch(this.statusUrl, { method: "GET", redirect: "error", signal: controller.signal,
        headers: { Accept: "application/json" } });
      if (!response.ok || !response.body || !(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json"))
        throw new Error("SPOT_PROXY_UPSTREAM_UNAVAILABLE");
      const declaredLength = Number(response.headers.get("content-length"));
      if (declaredLength > MAXIMUM_RESPONSE_BYTES) throw new Error("SPOT_PROXY_BODY_TOO_LARGE");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.byteLength;
        if (length > MAXIMUM_RESPONSE_BYTES) throw new Error("SPOT_PROXY_BODY_TOO_LARGE");
        chunks.push(item.value);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
      if (!validStatus(value)) throw new Error("SPOT_PROXY_INVALID_PAPER_STATUS");
      return { statusCode: 200, body: value, fetchedAtMs: Date.now() };
    } catch {
      return { statusCode: 503, body: {}, fetchedAtMs: Date.now() };
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) { try { await reader.cancel(); } catch { /* The deadline may already have cancelled it. */ } }
    }
  }
}
