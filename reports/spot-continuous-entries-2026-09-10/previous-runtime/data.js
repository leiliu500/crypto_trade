import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const SPOT_WEEK_DATA_SPEC = Object.freeze({
    version: "kraken-btc-spot-weeks-v1",
    symbol: "BTC/USD",
    intervalMinutes: 10080,
    sourceUrl: "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=10080",
    documentationUrl: "https://docs.kraken.com/api-reference/market-data/get-ohlc-data",
    maximumResponseBytes: 1024 * 1024,
    maximumSourceRows: 721,
    finalizationLagMs: 60_000,
    startMs: 0,
    gapPolicy: "REJECT_MISSING_COMPLETED_WEEKS",
    timestamps: "NATIVE_THURSDAY_UTC_EPOCH_ALIGNED_WEEKS",
});
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const limitations = [
    "OFFICIAL_SPOT_TRADE_AGGREGATES_ARE_NOT_EXECUTABLE_BID_ASK_QUOTES",
    "MOST_RECENT_720_PERIODS_ONLY_OLDER_HISTORY_CANNOT_BE_PAGINATED_VIA_OHLC",
    "NATIVE_THURSDAY_WEEK_BOUNDARIES_ARE_PRESERVED",
    "ONE_MINUTE_FINALIZATION_LAG_IS_AN_ASSUMPTION_NOT_HISTORICAL_RECEIPT_EVIDENCE",
    "NO_MISSING_WEEK_OR_INTRAWEEK_PRICE_PATH_IS_SYNTHESIZED",
    "FULL_PUBLIC_SOURCE_INCLUDES_EXCLUDED_INCOMPLETE_ROWS",
    "SOURCE_HASH_BINDS_RETRIEVED_BYTES_NOT_A_VENUE_DIGITAL_SIGNATURE",
];
function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("INVALID_SPOT_WEEK_DOCUMENT");
    return value;
}
function sourceRows(document) {
    const value = object(document);
    if (Object.keys(value).some(key => key !== "error" && key !== "result")
        || !Array.isArray(value.error) || value.error.length !== 0)
        throw new Error("SPOT_WEEK_API_ERROR");
    const result = object(value.result);
    if (Object.keys(result).some(key => key !== "XXBTZUSD" && key !== "last")
        || !Number.isSafeInteger(result.last) || result.last < 0
        || !Array.isArray(result.XXBTZUSD) || result.XXBTZUSD.length > SPOT_WEEK_DATA_SPEC.maximumSourceRows)
        throw new Error("INVALID_SPOT_WEEK_SOURCE");
    return result.XXBTZUSD;
}
/** No incomplete/future price is accessed when selecting the completed dataset. */
export function parseSpotWeeks(document, asOfMs) {
    if (!Number.isSafeInteger(asOfMs) || asOfMs < 0)
        throw new Error("INVALID_SPOT_WEEK_AS_OF");
    const bars = [];
    let priorSourceMs = -1;
    for (const raw of sourceRows(document)) {
        if (!Array.isArray(raw) || raw.length !== 8 || !Number.isSafeInteger(raw[0]) || raw[0] < 0)
            throw new Error("INVALID_SPOT_WEEK_TIMESTAMP");
        const openMs = raw[0] * 1000;
        const endMs = openMs + WEEK_MS, availableAtMs = endMs + SPOT_WEEK_DATA_SPEC.finalizationLagMs;
        if (!Number.isSafeInteger(availableAtMs) || openMs % WEEK_MS !== 0 || openMs <= priorSourceMs)
            throw new Error("DUPLICATE_REVERSED_OR_UNALIGNED_SPOT_WEEK");
        priorSourceMs = openMs;
        if (availableAtMs > asOfMs)
            continue;
        const numeric = raw.slice(1, 7).map(value => typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
        const [open, high, low, close, vwap, volume] = numeric;
        const trades = raw[7];
        if (!numeric.every(Number.isFinite) || Math.min(open, high, low, close, vwap) <= 0 || volume < 0
            || low > Math.min(open, close, vwap) || high < Math.max(open, close, vwap)
            || !Number.isSafeInteger(trades) || trades < 0 || (trades === 0) !== (volume === 0))
            throw new Error("INVALID_SPOT_WEEK_OHLCVT");
        if (bars.length && bars.at(-1).endMs !== openMs)
            throw new Error("MISSING_COMPLETED_SPOT_WEEK");
        bars.push({ openMs, endMs, availableAtMs, open, high, low, close, volume, trades: trades });
    }
    return bars;
}
function reconstruct(source, retrievedAtMs) {
    if (!source.length || source.length > SPOT_WEEK_DATA_SPEC.maximumResponseBytes)
        throw new Error("SPOT_WEEK_SOURCE_LIMIT");
    const document = JSON.parse(source.toString("utf8"));
    const bars = parseSpotWeeks(document, retrievedAtMs);
    if (!bars.length)
        throw new Error("NO_COMPLETED_SPOT_WEEKS");
    const originalRows = sourceRows(document).length;
    return {
        version: SPOT_WEEK_DATA_SPEC.version, symbol: SPOT_WEEK_DATA_SPEC.symbol,
        intervalMinutes: SPOT_WEEK_DATA_SPEC.intervalMinutes, bars,
        sourceUrl: SPOT_WEEK_DATA_SPEC.sourceUrl, sourceSha256: sha256(source), sourceBytes: source.length,
        retrievedAtMs, coverage: { originalRows, retainedBars: bars.length,
            firstOpenMs: bars[0].openMs, lastEndMs: bars.at(-1).endMs,
            excludedIncomplete: originalRows - bars.length, gaps: [] }, limitations: [...limitations],
    };
}
async function boundedResponse(response) {
    if (!response.ok || !response.body)
        throw new Error(`SPOT_WEEK_HTTP_${response.status}`);
    const advertised = response.headers.get("content-length");
    if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > SPOT_WEEK_DATA_SPEC.maximumResponseBytes)) {
        await response.body.cancel();
        throw new Error("SPOT_WEEK_RESPONSE_LIMIT");
    }
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done)
                break;
            bytes += part.value.byteLength;
            if (bytes > SPOT_WEEK_DATA_SPEC.maximumResponseBytes)
                throw new Error("SPOT_WEEK_RESPONSE_LIMIT");
            chunks.push(Buffer.from(part.value));
        }
    }
    finally {
        await reader.cancel();
    }
    return Buffer.concat(chunks);
}
/** Data acquisition only; a directory is immutable and is never resumed/overwritten. */
export async function downloadSpotWeeks(root, dependencies = {}) {
    const registeredAtMs = dependencies.nowMs ?? Date.now();
    if (!root || !Number.isSafeInteger(registeredAtMs) || registeredAtMs < 0)
        throw new Error("INVALID_SPOT_WEEK_DOWNLOAD");
    await mkdir(root, { recursive: false });
    await writeFile(join(root, "registration.json"), JSON.stringify({ registeredAtMs, spec: SPOT_WEEK_DATA_SPEC,
        purpose: "DATA_ACQUISITION_ONLY", strategyPerformanceComputed: false, activationAllowed: false }, null, 2) + "\n", { flag: "wx" });
    const source = await boundedResponse(await (dependencies.fetcher ?? fetch)(SPOT_WEEK_DATA_SPEC.sourceUrl, { signal: AbortSignal.timeout(25_000), redirect: "error" }));
    const retrievedAtMs = dependencies.nowMs ?? Date.now();
    await writeFile(join(root, "source.json"), source, { flag: "wx" });
    const dataset = reconstruct(source, retrievedAtMs);
    const bytes = JSON.stringify(dataset) + "\n";
    await writeFile(join(root, "dataset.json"), bytes, { flag: "wx" });
    await writeFile(join(root, "manifest.json"), JSON.stringify({ version: SPOT_WEEK_DATA_SPEC.version,
        sourceFile: "source.json", sourceSha256: dataset.sourceSha256, sourceBytes: source.length,
        datasetFile: "dataset.json", datasetSha256: sha256(bytes), datasetBytes: Buffer.byteLength(bytes),
        retrievedAtMs, spec: SPOT_WEEK_DATA_SPEC }, null, 2) + "\n", { flag: "wx" });
    return dataset;
}
async function boundedFile(path) {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > SPOT_WEEK_DATA_SPEC.maximumResponseBytes)
        throw new Error("SPOT_WEEK_FILE_LIMIT");
    const bytes = await readFile(path);
    if (bytes.length !== info.size || bytes.length > SPOT_WEEK_DATA_SPEC.maximumResponseBytes)
        throw new Error("SPOT_WEEK_FILE_CHANGED");
    return bytes;
}
/** Reconstruct every retained bar from the hash-bound public source, not cached features. */
export async function loadSpotWeeks(root) {
    const manifest = object(JSON.parse((await boundedFile(join(root, "manifest.json"))).toString("utf8")));
    const expectedKeys = ["version", "sourceFile", "sourceSha256", "sourceBytes", "datasetFile", "datasetSha256", "datasetBytes", "retrievedAtMs", "spec"];
    if (Object.keys(manifest).length !== expectedKeys.length || expectedKeys.some(key => !(key in manifest))
        || manifest.version !== SPOT_WEEK_DATA_SPEC.version || manifest.sourceFile !== "source.json" || manifest.datasetFile !== "dataset.json"
        || JSON.stringify(manifest.spec) !== JSON.stringify(SPOT_WEEK_DATA_SPEC))
        throw new Error("INVALID_SPOT_WEEK_MANIFEST");
    const source = await boundedFile(join(root, "source.json"));
    if (source.length !== manifest.sourceBytes || sha256(source) !== manifest.sourceSha256)
        throw new Error("SPOT_WEEK_SOURCE_HASH_MISMATCH");
    const cached = await boundedFile(join(root, "dataset.json"));
    if (cached.length !== manifest.datasetBytes || sha256(cached) !== manifest.datasetSha256)
        throw new Error("SPOT_WEEK_DATASET_HASH_MISMATCH");
    const reconstructed = reconstruct(source, manifest.retrievedAtMs);
    if (JSON.stringify(JSON.parse(cached.toString("utf8"))) !== JSON.stringify(reconstructed))
        throw new Error("SPOT_WEEK_SOURCE_DATASET_MISMATCH");
    const registration = object(JSON.parse((await boundedFile(join(root, "registration.json"))).toString("utf8")));
    if (!Number.isSafeInteger(registration.registeredAtMs) || registration.registeredAtMs < 0
        || registration.registeredAtMs > reconstructed.retrievedAtMs
        || JSON.stringify(registration.spec) !== JSON.stringify(SPOT_WEEK_DATA_SPEC)
        || registration.purpose !== "DATA_ACQUISITION_ONLY" || registration.strategyPerformanceComputed !== false
        || registration.activationAllowed !== false)
        throw new Error("INVALID_SPOT_WEEK_REGISTRATION");
    return reconstructed;
}
export async function main(args = process.argv.slice(2)) {
    if (args.length !== 1 || !args[0])
        throw new Error("Usage: npx tsx src/spot-trend/data.ts NEW_OUTPUT_DIRECTORY");
    const dataset = await downloadSpotWeeks(args[0]);
    process.stdout.write(JSON.stringify({ output: resolve(args[0]), sourceSha256: dataset.sourceSha256,
        retrievedAtMs: dataset.retrievedAtMs, coverage: dataset.coverage, strategyPerformanceComputed: false }) + "\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    await main();
//# sourceMappingURL=data.js.map