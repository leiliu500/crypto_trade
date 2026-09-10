import { createHash } from "node:crypto";
import { evaluateCarryEconomics, type CarryLeg } from "./economics.js";
import { validateCarryResearchConfig, type CarryResearchConfig } from "./config.js";

interface PublicResponse { url: string; startedAtMs: number; receivedAtMs: number; httpDateMs: number | null; payload: unknown }
export interface CarryPublicSnapshot { collectedAtMs: number; responses: Record<string, PublicResponse> }
const endpoints = {
  instruments: "https://futures.kraken.com/derivatives/api/v3/instruments",
  tickers: "https://futures.kraken.com/derivatives/api/v3/tickers",
  spotRules: "https://api.kraken.com/0/public/AssetPairs?pair=XBTUSD,ETHUSD",
  BTC: "https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=1",
  ETH: "https://api.kraken.com/0/public/Depth?pair=ETHUSD&count=1",
};

/** Five public GETs, no credentials, broker, recurring recorder, or order API. */
export async function collectCarryPublicSnapshot(fetcher: typeof fetch = fetch, now: () => number = Date.now): Promise<CarryPublicSnapshot> {
  const responses = Object.fromEntries(await Promise.all(Object.entries(endpoints).map(async ([key, url]) => {
    const startedAtMs = now();
    const response = await fetcher(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!response.ok) throw new Error(`CARRY_PUBLIC_HTTP_${response.status}:${key}`);
    const raw = await response.text();
    if (raw.length > 5_000_000) throw new Error(`CARRY_PUBLIC_RESPONSE_TOO_LARGE:${key}`);
    const receivedAtMs = now(), httpDate = Date.parse(response.headers.get("date") ?? "");
    return [key, { url, startedAtMs, receivedAtMs, httpDateMs: Number.isFinite(httpDate) ? httpDate : null,
      payload: JSON.parse(raw) as unknown } satisfies PublicResponse];
  })));
  return { collectedAtMs: now(), responses };
}

export function carryMonitorReport(snapshot: CarryPublicSnapshot, config: CarryResearchConfig) {
  const c = validateCarryResearchConfig(config);
  const responses = snapshot.responses;
  const instrumentPayload = object(responses.instruments!.payload);
  const tickerPayload = object(responses.tickers!.payload);
  if (instrumentPayload.result !== "success" || tickerPayload.result !== "success") throw new Error("CARRY_FUTURES_API_ERROR");
  const instruments = array(instrumentPayload.instruments).map(object);
  const tickers = array(tickerPayload.tickers).map(object);
  const rules = object(spotResult(responses.spotRules!));
  const rows = [];
  for (const base of ["BTC", "ETH"] as const) {
    const spotKey = base === "BTC" ? "XXBTZUSD" : "XETHZUSD";
    const spotRule = object(rules[spotKey]);
    const spotResponse = responses[base]!;
    const depth = object(spotResult(spotResponse));
    const levels = object(depth[spotKey]);
    const bid = array(array(levels.bids)[0]), ask = array(array(levels.asks)[0]);
    const spot: CarryLeg = { instrumentId: `kraken:spot:${spotKey}`, base, quote: "USD", kind: "SPOT",
      book: { bid: number(bid[0]), ask: number(ask[0]), bidBaseQty: number(bid[1]), askBaseQty: number(ask[1]),
        exchangeAtMs: spotResponse.httpDateMs ?? NaN, receivedAtMs: spotResponse.receivedAtMs },
      rules: { minimumBaseQty: number(spotRule.ordermin), quantityStep: decimalStep(spotRule.lot_decimals),
        minimumNotionalUsd: number(spotRule.costmin) } };
    for (const instrument of instruments.filter(i => i.base === base && i.quote === "USD"
      && i.type === "flexible_futures" && i.contractSize === 1 && /^(PF|FF)_/.test(String(i.symbol)))) {
      const product = String(instrument.symbol);
      const ticker = tickers.find(t => t.symbol === product);
      if (!ticker || instrument.tradeable !== true || instrument.isExpired === true || instrument.postOnly === true
        || ticker.suspended === true || ticker.postOnly === true || spotRule.status !== "online") continue;
      const expiryMs = instrument.lastTradingTime === undefined ? undefined : Date.parse(String(instrument.lastTradingTime));
      const maturityDays = expiryMs === undefined ? null : (expiryMs - snapshot.collectedAtMs) / 86_400_000;
      const maturityEligible = maturityDays !== null && maturityDays >= c.minimumDatedMaturityDays && maturityDays <= c.maximumDatedMaturityDays;
      const step = decimalStep(instrument.contractValueTradePrecision);
      const derivative: CarryLeg = { instrumentId: `kraken:futures:${product}`, base, quote: "USD",
        kind: product.startsWith("PF_") ? "LINEAR_PERPETUAL" : "LINEAR_DATED",
        ...(expiryMs === undefined ? {} : { expiryMs }),
        book: { bid: number(ticker.bid), ask: number(ticker.ask), bidBaseQty: number(ticker.bidSize), askBaseQty: number(ticker.askSize),
          exchangeAtMs: Date.parse(String(tickerPayload.serverTime)), receivedAtMs: responses.tickers!.receivedAtMs },
        rules: { minimumBaseQty: Number(step), quantityStep: step, minimumNotionalUsd: 0, maximumBaseQty: number(instrument.maxPositionSize) } };
      for (const budget of c.budgets) {
        const economics = evaluateCarryEconomics({ nowMs: snapshot.collectedAtMs, spot, derivative,
          fees: { spotTakerBps: c.spotTakerFeeBps, derivativeTakerBps: c.derivativeTakerFeeBps, accountVerified: false },
          executionEvidenceVerified: false,
          budget: { ...budget, derivativeReserveFraction: c.derivativeReserveFraction },
          assumptions: { holdingHours: maturityDays === null ? c.perpetualScenarioHoldingHours : Math.max(0, maturityDays * 24),
            annualCapitalHurdleFraction: c.annualCapitalHurdleFraction, slippageBpsPerExecution: c.slippageBpsPerExecution,
            settlementBasisReserveBps: c.settlementBasisReserveBps, unwindReserveBps: c.unwindReserveBps,
            maximumQuoteAgeMs: c.maximumQuoteAgeMs, maximumQuoteSkewMs: c.maximumQuoteSkewMs,
            maximumFundingAgeMs: c.maximumFundingAgeMs,
            settlementSpotPriceScenariosUsd: c.settlementPriceMultipliers.map(m => spot.book.ask * m) },
          ...(derivative.kind !== "LINEAR_PERPETUAL" || !Number.isFinite(number(ticker.fundingRate)) ? {} : {
            currentFunding: { absoluteUsdPerBasePerHour: number(ticker.fundingRate), knownAtMs: derivative.book.exchangeAtMs } }),
        });
        rows.push({ base, product, budgetId: budget.id, maturityDays, datedPolicyEligible: maturityEligible,
          economics });
      }
    }
  }
  return { schemaVersion: 1, mode: "MONITOR_ONLY", capturedAtUtc: new Date(snapshot.collectedAtMs).toISOString(),
    inputSha256: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), configuration: c,
    activationAllowed: false, validatedProfitability: false,
    interpretation: "INDEPENDENT_BUDGET_SCENARIOS_NOT_SIMULTANEOUS_ALLOCATIONS_OR_BACKTEST_RETURNS",
    quoteEvidence: "REST_SNAPSHOTS_NOT_ATOMIC_PAIRED_FILLS;SPOT_HTTP_DATE_HAS_ONE_SECOND_PRECISION",
    limitations: ["ACCOUNT_FEES_UNVERIFIED", "NO_PAIRED_HISTORICAL_EXECUTION_EVIDENCE",
      "FUTURE_FUNDING_VARIABLE", "MARGIN_AND_SETTLEMENT_PATH_NOT_VALIDATED"], rows };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_CARRY_PUBLIC_OBJECT");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error("INVALID_CARRY_PUBLIC_ARRAY"); return value; }
function number(value: unknown): number { return typeof value === "number" || typeof value === "string" && value.trim() ? Number(value) : NaN; }
function decimalStep(value: unknown): string {
  const precision = number(value);
  if (!Number.isInteger(precision) || precision < 0 || precision > 12) throw new Error("INVALID_CARRY_QUANTITY_PRECISION");
  return `1e-${precision}`;
}
function spotResult(response: PublicResponse): unknown {
  const value = object(response.payload);
  if (array(value.error).length) throw new Error("CARRY_SPOT_API_ERROR");
  return value.result;
}
