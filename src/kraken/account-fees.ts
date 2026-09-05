import { createHash, createHmac } from "node:crypto";
import { percentToBps } from "../economics/fee-validation.js";

export interface AccountFeeSnapshot { product: string; makerFeeBps: number; takerFeeBps: number;
  source: "KRAKEN_TRADE_VOLUME"; observedMs: number; expiresMs: number }
/** Read-only Spot-key authentication for derivatives fee lookup. Never uses
 * the deprecated Futures fee-schedule endpoint and never submits orders. */
export class KrakenAccountFees {
  private nonce = 0n;
  public constructor(private readonly apiKey: string, private readonly secret: string,
    private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {}
  public async load(products: readonly string[]): Promise<AccountFeeSnapshot[]> {
    if (!this.apiKey || !this.secret || !products.length || products.some((p) => !/^PF_[A-Z0-9]+$/.test(p))) {
      throw new Error("ACCOUNT_FEE_CREDENTIALS_OR_LINEAR_PRODUCTS_MISSING");
    }
    const timestamp = BigInt(this.now()) * 1_000n;
    this.nonce = timestamp > this.nonce ? timestamp : this.nonce + 1n;
    const nonce = this.nonce.toString(), path = "/0/private/TradeVolume";
    const body = JSON.stringify({ nonce, pair: products.map((asset) => ({ asset, aclass: "derivatives" })) });
    const hash = createHash("sha256").update(nonce + body).digest();
    const signature = createHmac("sha512", Buffer.from(this.secret, "base64")).update(path).update(hash).digest("base64");
    const response = await this.fetcher(`https://api.kraken.com${path}`, { method: "POST", body,
      headers: { "API-Key": this.apiKey, "API-Sign": signature, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`ACCOUNT_FEE_HTTP_${response.status}`);
    return parseAccountFees(await response.json(), products, this.now());
  }
}
export function parseAccountFees(payload: unknown, products: readonly string[], now: number): AccountFeeSnapshot[] {
  const data = payload as { error?: unknown[]; result?: { fees?: Record<string, { fee?: unknown }>;
    fees_maker?: Record<string, { fee?: unknown }> } };
  if (!data || !Array.isArray(data.error) || data.error.length || !data.result) throw new Error("ACCOUNT_FEE_RESPONSE_INVALID");
  return products.map((product) => {
    const taker = data.result!.fees?.[product]?.fee, maker = data.result!.fees_maker?.[product]?.fee;
    if (taker === undefined || taker === null || maker === undefined || maker === null
      || ![taker, maker].every((v) => (typeof v === "number" || typeof v === "string") && String(v).trim() !== "")) {
      throw new Error("CONTRACT_SPECIFIC_FEES_MISSING");
    }
    return { product, makerFeeBps: percentToBps(Number(maker)), takerFeeBps: percentToBps(Number(taker)),
      source: "KRAKEN_TRADE_VOLUME", observedMs: now, expiresMs: now + 15 * 60_000 };
  });
}
