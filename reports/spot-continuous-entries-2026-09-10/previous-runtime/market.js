import { createHash } from "node:crypto";
import { parseSpotWeeks, SPOT_WEEK_DATA_SPEC, WEEK_MS } from "./data.js";
export const SPOT_MARKET_SOURCES = Object.freeze({
    ohlc: SPOT_WEEK_DATA_SPEC.sourceUrl,
    rules: "https://api.kraken.com/0/public/AssetPairs?pair=XBTUSD",
    book: "https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=100",
});
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;
function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("INVALID_SPOT_MARKET_DOCUMENT");
    return value;
}
function pairResult(document) {
    const value = object(document);
    if (Object.keys(value).some(key => key !== "error" && key !== "result")
        || !Array.isArray(value.error) || value.error.length !== 0)
        throw new Error("SPOT_MARKET_API_ERROR");
    const result = object(value.result);
    if (Object.keys(result).length !== 1 || !("XXBTZUSD" in result))
        throw new Error("SPOT_MARKET_PAIR_MISMATCH");
    return object(result.XXBTZUSD);
}
function positiveDecimal(value) {
    if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))
        throw new Error("INVALID_SPOT_MARKET_DECIMAL");
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        throw new Error("INVALID_SPOT_MARKET_DECIMAL");
    return parsed;
}
function decimals(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 12)
        throw new Error("INVALID_SPOT_MARKET_PRECISION");
    return value;
}
function isStepMultiple(value, step) {
    const units = value / step;
    return Number.isFinite(units) && Number.isSafeInteger(Math.round(units))
        && Math.abs(units - Math.round(units)) <= 1e-8;
}
export function parseSpotMarketRules(document) {
    const pair = pairResult(document);
    if (pair.altname !== "XBTUSD" || pair.base !== "XXBT" || pair.quote !== "ZUSD"
        || pair.aclass_base !== "currency" || pair.aclass_quote !== "currency"
        || pair.lot !== "unit" || pair.lot_multiplier !== 1)
        throw new Error("SPOT_MARKET_INSTRUMENT_MISMATCH");
    if (pair.status !== "online")
        throw new Error("SPOT_MARKET_NOT_ONLINE");
    const lotSize = 10 ** -decimals(pair.lot_decimals), pairStep = 10 ** -decimals(pair.pair_decimals);
    const minimumQuantity = positiveDecimal(pair.ordermin), minimumNotionalUsd = positiveDecimal(pair.costmin);
    const tickSize = pair.tick_size === undefined ? pairStep : positiveDecimal(pair.tick_size);
    if (!isStepMultiple(minimumQuantity, lotSize) || !isStepMultiple(tickSize, pairStep))
        throw new Error("SPOT_MARKET_RULE_STEP_MISMATCH");
    return { lotSize, minimumQuantity, minimumNotionalUsd, tickSize };
}
export function parseSpotMarketBook(document, receivedAtMs) {
    if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0)
        throw new Error("INVALID_SPOT_MARKET_CLOCK");
    const book = pairResult(document);
    if (Object.keys(book).some(key => key !== "bids" && key !== "asks"))
        throw new Error("INVALID_SPOT_MARKET_BOOK");
    function levels(value, side) {
        if (!Array.isArray(value) || !value.length || value.length > 100)
            throw new Error("INVALID_SPOT_MARKET_DEPTH");
        let prior = side === "bids" ? Infinity : -Infinity;
        return value.map(raw => {
            if (!Array.isArray(raw) || raw.length !== 3 || typeof raw[2] !== "number"
                || !Number.isFinite(raw[2]) || raw[2] < 0 || raw[2] > Number.MAX_SAFE_INTEGER / 1000)
                throw new Error("INVALID_SPOT_MARKET_LEVEL");
            const price = positiveDecimal(raw[0]), quantity = positiveDecimal(raw[1]);
            if (!Number.isFinite(price * quantity) || (side === "bids" ? price >= prior : price <= prior))
                throw new Error("UNORDERED_OR_DUPLICATE_SPOT_MARKET_LEVEL");
            prior = price;
            // raw[2] is a level's last-change time, not a stream heartbeat or quote age.
            return [price, quantity];
        });
    }
    const bids = levels(book.bids, "bids"), asks = levels(book.asks, "asks");
    if (bids[0][0] >= asks[0][0])
        throw new Error("CROSSED_OR_LOCKED_SPOT_MARKET_BOOK");
    return { bids, asks, receivedAtMs };
}
async function boundedResponse(response) {
    if (!response.body)
        throw new Error(`SPOT_MARKET_HTTP_${response.status}_NO_BODY`);
    const advertised = response.headers.get("content-length");
    if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > MAXIMUM_RESPONSE_BYTES)) {
        await response.body.cancel();
        throw new Error("SPOT_MARKET_RESPONSE_LIMIT");
    }
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done)
                break;
            bytes += part.value.byteLength;
            if (bytes > MAXIMUM_RESPONSE_BYTES)
                throw new Error("SPOT_MARKET_RESPONSE_LIMIT");
            chunks.push(Buffer.from(part.value));
        }
    }
    finally {
        await reader.cancel();
    }
    return Buffer.concat(chunks);
}
/** Public REST data only: this module has no private API, credentials, or order path. */
export async function fetchSpotMarketSnapshot(dependencies = {}) {
    const fetcher = dependencies.fetcher ?? fetch, now = dependencies.now ?? Date.now;
    let priorClock = -1;
    const clock = () => {
        const value = now();
        if (!Number.isSafeInteger(value) || value < 0 || value < priorClock)
            throw new Error("INVALID_OR_REVERSED_SPOT_MARKET_CLOCK");
        priorClock = value;
        return value;
    };
    const source = async (url) => {
        const requestedAtMs = clock();
        const response = await fetcher(url, { method: "GET", redirect: "error", cache: "no-store",
            headers: { Accept: "application/json", "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        const bytes = await boundedResponse(response), receivedAtMs = clock();
        const rawBody = bytes.toString("utf8"), validUtf8 = Buffer.from(rawBody, "utf8").equals(bytes);
        let rawDocument = null, parseError;
        if (!validUtf8)
            parseError = "INVALID_SPOT_MARKET_UTF8";
        else
            try {
                rawDocument = JSON.parse(rawBody);
            }
            catch {
                parseError = "SPOT_MARKET_INVALID_JSON";
            }
        return { url, requestedAtMs, receivedAtMs,
            sha256: createHash("sha256").update(bytes).digest("hex"), responseBytes: bytes.length, httpStatus: response.status,
            rawBody, rawDocument, ...(validUtf8 ? {} : { rawBodyBase64: bytes.toString("base64") }),
            ...(parseError === undefined ? {} : { parseError }), serverDateHeader: response.headers.get("date") };
    };
    const validSource = (value) => {
        if (value.httpStatus < 200 || value.httpStatus >= 300)
            throw new Error(`SPOT_MARKET_HTTP_${value.httpStatus}`);
        if (value.parseError)
            throw new Error(value.parseError);
    };
    const initial = await Promise.allSettled([source(SPOT_MARKET_SOURCES.ohlc), source(SPOT_MARKET_SOURCES.rules)]);
    const [ohlcResult, rulesResult] = initial;
    if (rulesResult.status === "rejected")
        throw rulesResult.reason;
    const assetPairs = rulesResult.value;
    validSource(assetPairs);
    const rules = parseSpotMarketRules(assetPairs.rawDocument);
    let bars = [], historyError;
    try {
        if (ohlcResult.status === "rejected")
            throw ohlcResult.reason;
        const ohlc = ohlcResult.value;
        validSource(ohlc);
        bars = parseSpotWeeks(ohlc.rawDocument, ohlc.receivedAtMs);
        if (!bars.length)
            throw new Error("NO_COMPLETED_SPOT_MARKET_WEEKS");
        const expectedLastEndMs = Math.floor((ohlc.receivedAtMs - SPOT_WEEK_DATA_SPEC.finalizationLagMs) / WEEK_MS) * WEEK_MS;
        if (bars.at(-1).endMs !== expectedLastEndMs)
            throw new Error("STALE_COMPLETED_SPOT_MARKET_WEEKS");
    }
    catch (error) {
        bars = [];
        historyError = error instanceof Error ? error.message.slice(0, 512) : "SPOT_MARKET_HISTORY_UNAVAILABLE";
    }
    // Fetch depth last so historical/rule requests do not consume its usable receipt age.
    const depth = await source(SPOT_MARKET_SOURCES.book);
    validSource(depth);
    const book = parseSpotMarketBook(depth.rawDocument, depth.receivedAtMs);
    return { retrievedAtMs: clock(), bars, book, rules,
        sources: [...(ohlcResult.status === "fulfilled" ? [ohlcResult.value] : []), assetPairs, depth],
        ...(historyError === undefined ? {} : { historyError }) };
}
//# sourceMappingURL=market.js.map