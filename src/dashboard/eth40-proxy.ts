const DEFAULT_ETH40_BASE_URL = "http://crypto-eth40-paper:3003";
const MAXIMUM_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_RECEIPTS = 10_000;
const VERSION = "eth40-forward-v1";
const ACCOUNTS = { eth40: "ETH/USD", passiveEth: "ETH/USD", passiveBtc: "BTC/USD" } as const;
const PATHS = { status: "/api/status", receipts: "/api/receipts", manifest: "/api/manifest" } as const;
type ObjectValue = Record<string, unknown>;
export type Eth40Endpoint = keyof typeof PATHS;
type AccountId = keyof typeof ACCOUNTS;
interface ProxyResult { statusCode: 200 | 503; body: ObjectValue; fetchedAtMs: number }
export interface Eth40PaperProxyOptions { baseUrl?: string; timeoutMs?: number; cacheMs?: number }

const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const positive = (value: unknown): value is number => finite(value) && value > 0;
const timestamp = (value: unknown): value is number => nonnegative(value) && Number.isSafeInteger(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4_096;
const nullableNumber = (value: unknown): boolean => value === null || finite(value);
const hash = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const accountId = (value: unknown): value is AccountId => typeof value === "string" && Object.hasOwn(ACCOUNTS, value);
const paperFlags = (value: ObjectValue): boolean => value.liveTradingEnabled === false
  && value.automaticPromotionAllowed === false && value.validatedProfitable === false && value.historicalScreenPassed === false;

function validSpec(value: unknown): boolean {
  return object(value) && value.version === VERSION && value.candidateId === "sma_eth-040" && paperFlags(value)
    && value.initialCashUsd === 10_000 && value.entryFeeBps === 80 && value.exitFeeBps === 80
    && value.movingAverageDays === 40 && value.maximumEntryUsd === 1_000;
}
function validFill(value: unknown, id: AccountId): boolean {
  return object(value) && text(value.id) && ["buy", "sell"].includes(String(value.side))
    && (id === "eth40" || value.side === "buy") && positive(value.quantity) && positive(value.price)
    && value.feeBps === 80 && timestamp(value.timestampMs)
    && value.id === `${VERSION}:${id}:${Math.floor(value.timestampMs / 86_400_000) * 86_400_000}:${value.side}`;
}
function validStatus(value: unknown): value is ObjectValue {
  if (!object(value) || value.service !== "ETH40 isolated spot paper observation" || !paperFlags(value)
    || !validSpec(value.spec) || typeof value.collectorHealthy !== "boolean"
    || !(value.fatalError === null || text(value.fatalError))
    || ![value.processStartedAtMs, value.startedAtMs, value.recordedAtMs, value.sequence,
      value.firstExecutionDayMs, value.nextExecutionWindowMs, value.reviewAtMs].every(timestamp)
    || !hash(value.lastHash) || !nullableNumber(value.heartbeatAgeMs)
    || !Array.isArray(value.accounts) || ![0, 3].includes(value.accounts.length)
    || !Array.isArray(value.lastDecisions) || ![0, 3].includes(value.lastDecisions.length)) return false;
  const seen = new Set<AccountId>();
  for (const row of value.accounts) {
    if (!object(row) || !accountId(row.accountId) || seen.has(row.accountId) || row.symbol !== ACCOUNTS[row.accountId]
      || row.initialCashUsd !== 10_000 || ![row.cashUsd, row.quantity, row.feesUsd].every(nonnegative)
      || !finite(row.realizedNetUsd) || ![row.liquidationEquityUsd, row.netPnlUsd, row.quoteAgeMs,
        row.returnOnAccountPct, row.firstFillAtMs].every(nullableNumber)
      || ![row.fills, row.completedEpisodes].every(timestamp) || typeof row.fresh !== "boolean") return false;
    seen.add(row.accountId);
  }
  const decisions = new Set<AccountId>();
  for (const row of value.lastDecisions) {
    if (!object(row) || !accountId(row.accountId) || decisions.has(row.accountId) || row.symbol !== ACCOUNTS[row.accountId]
      || !["buy", "sell", "hold", "blocked"].includes(String(row.action)) || !text(row.reason)
      || !["long", "cash", null].includes(row.target as string | null)
      || !(row.fill === null || validFill(row.fill, row.accountId))) return false;
    decisions.add(row.accountId);
  }
  if (value.capturedMarkets !== null) {
    const market = value.capturedMarkets;
    if (!object(market) || !timestamp(market.observedAtMs) || !Array.isArray(market.quotes) || market.quotes.length > 2
      || !Array.isArray(market.errors) || !market.errors.every(text)) return false;
    const pairs = new Set<string>();
    for (const quote of market.quotes) {
      if (!object(quote) || typeof quote.symbol !== "string" || !["ETH/USD", "BTC/USD"].includes(quote.symbol)
        || pairs.has(quote.symbol) || ![quote.bid, quote.ask].every(positive)
        || ![quote.receivedAtMs, quote.exchangeUpdateAtMs].every(timestamp) || quote.checksumValid !== true
        || !text(quote.checksum) || !text(quote.connectionId)) return false;
      pairs.add(quote.symbol);
    }
  }
  return [value.excessVsCashUsd, value.excessVsPassiveEthUsd, value.excessVsPassiveBtcUsd].every(nullableNumber);
}
function validReceipts(value: unknown): value is ObjectValue {
  if (!object(value) || Object.keys(value).sort().join() !== Object.keys(ACCOUNTS).sort().join()) return false;
  return (Object.keys(ACCOUNTS) as AccountId[]).every(id => {
    const row = value[id];
    if (!object(row) || row.symbol !== ACCOUNTS[id] || !object(row.account)) return false;
    const account = row.account;
    return account.initialCashUsd === 10_000 && [account.cashUsd, account.quantity, account.entryCostUsd, account.feesUsd].every(nonnegative)
      && finite(account.realizedNetUsd) && Array.isArray(account.receipts) && account.receipts.length <= MAXIMUM_RECEIPTS
      && account.receipts.every(fill => validFill(fill, id));
  });
}
function validManifest(value: unknown): value is ObjectValue {
  return object(value) && value.version === "eth40-frozen-runtime-v1" && validSpec(value.spec)
    && hash(value.runtimeSha256) && text(value.researchStatus) && Array.isArray(value.fingerprints)
    && value.fingerprints.length > 0 && value.fingerprints.length <= 1_000
    && value.fingerprints.every(item => object(item) && text(item.file) && hash(item.sha256));
}

/** Three fixed public-paper reads. Client URLs, headers, credentials and methods are never forwarded. */
export class Eth40PaperProxy {
  private readonly baseUrl: URL | null;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly cached = new Map<Eth40Endpoint, { result: ProxyResult; expiresAtMs: number }>();
  private readonly inFlight = new Map<Eth40Endpoint, Promise<ProxyResult>>();

  public constructor(options: Eth40PaperProxyOptions = {}) {
    let url: URL | null = null;
    try {
      const candidate = new URL(options.baseUrl ?? DEFAULT_ETH40_BASE_URL);
      if (["http:", "https:"].includes(candidate.protocol) && !candidate.username && !candidate.password
        && !candidate.search && !candidate.hash && candidate.pathname === "/") url = candidate;
    } catch { /* A bad internal address makes only ETH40 unavailable. */ }
    this.baseUrl = url;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.cacheMs = options.cacheMs ?? 3_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_000
      || !Number.isFinite(this.cacheMs) || this.cacheMs < 0 || this.cacheMs > 3_000)
      throw new Error("INVALID_ETH40_PROXY_LIMITS");
  }

  public async read(endpoint: Eth40Endpoint): Promise<{ statusCode: 200 | 503; body: ObjectValue }> {
    const unavailable = () => ({ statusCode: 503 as const, body: { available: false, error: "ETH40_PAPER_UNAVAILABLE" } });
    if (!Object.hasOwn(PATHS, endpoint)) return unavailable();
    // Auxiliary payloads have no mode flag: establish paper identity through the same fixed upstream status.
    if (endpoint !== "status" && (await this.load("status")).statusCode !== 200) return unavailable();
    const result = await this.load(endpoint);
    if (result.statusCode !== 200) return unavailable();
    return { statusCode: 200, body: endpoint === "status"
      ? { ...structuredClone(result.body), available: true, dashboardFetchedAtMs: result.fetchedAtMs }
      : structuredClone(result.body) };
  }

  private async load(endpoint: Eth40Endpoint): Promise<ProxyResult> {
    const cached = this.cached.get(endpoint);
    if (cached && cached.expiresAtMs > Date.now()) return cached.result;
    let pending = this.inFlight.get(endpoint);
    if (!pending) {
      pending = this.fetchEndpoint(endpoint).then(result => {
        this.cached.set(endpoint, { result, expiresAtMs: Date.now() + this.cacheMs });
        return result;
      }).finally(() => { this.inFlight.delete(endpoint); });
      this.inFlight.set(endpoint, pending);
    }
    return pending;
  }

  private async fetchEndpoint(endpoint: Eth40Endpoint): Promise<ProxyResult> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (!this.baseUrl) throw new Error("ETH40_PROXY_URL_UNAVAILABLE");
      const response = await fetch(new URL(PATHS[endpoint], this.baseUrl), { method: "GET", redirect: "error",
        signal: controller.signal, cache: "no-store", credentials: "omit", headers: { Accept: "application/json" } });
      if (!response.ok || !response.body || !(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json"))
        throw new Error("ETH40_PROXY_UPSTREAM_UNAVAILABLE");
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAXIMUM_RESPONSE_BYTES))
        throw new Error("ETH40_PROXY_BODY_TOO_LARGE");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAXIMUM_RESPONSE_BYTES) throw new Error("ETH40_PROXY_BODY_TOO_LARGE");
        chunks.push(chunk.value);
      }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
      const valid = endpoint === "status" ? validStatus(value) : endpoint === "receipts" ? validReceipts(value) : validManifest(value);
      if (!valid || !object(value)) throw new Error("ETH40_PROXY_INVALID_PAPER_RESPONSE");
      return { statusCode: 200, body: value, fetchedAtMs: Date.now() };
    } catch {
      return { statusCode: 503, body: {}, fetchedAtMs: Date.now() };
    } finally {
      clearTimeout(timer); controller.abort();
      if (reader) { try { await reader.cancel(); } catch { /* The deadline may have already cancelled the stream. */ } }
    }
  }
}
