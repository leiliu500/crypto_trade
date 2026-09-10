import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

export const HOUR_MS = 3_600_000;
export const HOURLY_SYMBOLS = ["BTC/USD", "ETH/USD"] as const;
export type HourlySymbol = typeof HOURLY_SYMBOLS[number];
export interface HourlyBar { symbol: HourlySymbol; openMs: number; open: number; high: number; low: number; close: number; volume: number }
/** timestampMs is the END of the hour to which this funding rate applies.
 * rate is a fraction, not a percentage; absoluteRate is USD per contract unit. */
export interface FundingRow { symbol: HourlySymbol; timestampMs: number; rate: number; absoluteRate?: number }
export interface MissingHours { fromMs: number; toMsExclusive: number; hours: number }
export interface HourlySourceFile { file: string; url: string; bytes: number; sha256: string; fetchedAtMs: number;
  status: number; range?: string; lastModified?: string; etag?: string }
export interface HourlyDatasetMetadata {
  version: string; researchOnly: true; venue: "KRAKEN_FUTURES"; startMs: number; endMs: number; fetchedAtMs: number;
  products: Record<HourlySymbol, string>; sourceFiles: HourlySourceFile[];
  coverage: Array<{ symbol: HourlySymbol; expectedBars: number; bars: number; zeroVolumeHours: number;
    missingBars: MissingHours[]; funding: number; missingFunding: MissingHours[] }>;
  funding: { source: string; archiveBytes: number; downloadedBytes: number;
    timestampConvention: string; timestampConventionVerified: boolean;
    analyticsCoverage: Array<{ symbol: HourlySymbol; fromMs: number; toMsExclusive: number; candles: number;
      missingHours: MissingHours[]; settlementMappingVerified: false }>;
    members: Array<{ symbol: HourlySymbol;
      file: string; sha256: string; crc32: number; compressedBytes: number; uncompressedBytes: number;
      firstSourceMs: number; lastSourceMs: number }> };
  limitations: string[];
}
export interface HourlyDataset { bars: HourlyBar[]; funding: FundingRow[]; metadata: HourlyDatasetMetadata }
export const HOURLY_DATA_SPEC = Object.freeze({ version: "kraken-hourly-dataset-v1", researchOnly: true,
  startMs: Date.UTC(2023, 11, 1), endMs: Date.UTC(2026, 8, 1), maximumCandlesPerRequest: 7000,
  maximumResponseBytes: 8 * 1024 * 1024, maximumFundingDownloadBytes: 25 * 1024 * 1024,
  fundingExportPage: "https://support.kraken.com/articles/export-historical-funding-rates",
  fundingArchiveUrl: "https://assets-cms.kraken.com/files/51n36hrp/facade/4b70936c1227e4ae5514cba8bf41a5561cf13bd7.zip?dl=",
  candleDocumentation: "https://docs.kraken.com/api/docs/futures-api/charts/candles",
  contractDocumentation: "https://support.kraken.com/articles/4844359082772-linear-multi-collateral-derivatives-contract-specifications",
});
const PRODUCTS: Record<HourlySymbol, string> = { "BTC/USD": "PF_XBTUSD", "ETH/USD": "PF_ETHUSD" };
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const aligned = (value: unknown): value is number => time(value) && value % HOUR_MS === 0;
const numeric = (value: unknown): number => {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) throw new Error("INVALID_HOURLY_NUMBER");
  const result = Number(value); if (!Number.isFinite(result)) throw new Error("INVALID_HOURLY_NUMBER"); return result;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_HOURLY_OBJECT");
  return value as Record<string, unknown>;
}
function window(startMs: number, endMs: number, nowMs: number): void {
  if (!aligned(startMs) || !aligned(endMs) || endMs <= startMs || !time(nowMs) || endMs > nowMs
    || endMs - startMs > 5 * 366 * 24 * HOUR_MS) throw new Error("INVALID_HOURLY_WINDOW");
}
export function parseHourlyCandles(value: unknown, symbol: HourlySymbol): { bars: HourlyBar[]; more: boolean } {
  const document = object(value);
  if (!HOURLY_SYMBOLS.includes(symbol) || !Array.isArray(document.candles) || typeof document.more_candles !== "boolean"
    || document.candles.length > HOURLY_DATA_SPEC.maximumCandlesPerRequest) throw new Error("INVALID_HOURLY_CANDLES");
  const bars = document.candles.map(value => {
    const row = object(value);
    if (!aligned(row.time)) throw new Error("UNALIGNED_HOURLY_CANDLE");
    const bar: HourlyBar = { symbol, openMs: row.time, open: numeric(row.open), high: numeric(row.high),
      low: numeric(row.low), close: numeric(row.close), volume: numeric(row.volume) };
    if (Math.min(bar.open, bar.high, bar.low, bar.close) <= 0 || bar.volume < 0
      || bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close)
      || bar.high < bar.low) throw new Error("INVALID_HOURLY_OHLCV");
    return bar;
  });
  for (let i = 1; i < bars.length; i++) if (bars[i]!.openMs < bars[i - 1]!.openMs) throw new Error("REVERSED_HOURLY_PAGE");
  return { bars, more: document.more_candles };
}
export function missingHourlyTimes(times: readonly number[], startMs: number, endMs: number): MissingHours[] {
  if (!aligned(startMs) || !aligned(endMs) || endMs < startMs) throw new Error("INVALID_HOURLY_COVERAGE_WINDOW");
  const have = new Set(times), missing: MissingHours[] = [];
  for (let at = startMs; at < endMs; at += HOUR_MS) if (!have.has(at)) {
    const prior = missing.at(-1);
    if (prior?.toMsExclusive === at) { prior.toMsExclusive += HOUR_MS; prior.hours++; }
    else missing.push({ fromMs: at, toMsExclusive: at + HOUR_MS, hours: 1 });
  }
  return missing;
}
export function mergeHourlyBars(rows: readonly HourlyBar[], startMs: number, endMs: number, nowMs: number): HourlyBar[] {
  window(startMs, endMs, nowMs);
  const seen = new Map<string, HourlyBar>();
  for (const row of rows) {
    const normalized = parseHourlyCandles({ candles: [{ time: row.openMs, ...row }], more_candles: false }, row.symbol).bars[0]!;
    if (row.openMs < startMs || row.openMs + HOUR_MS > endMs || row.openMs + HOUR_MS > nowMs) continue;
    const key = `${row.symbol}:${row.openMs}`, prior = seen.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(normalized)) throw new Error("CONFLICTING_HOURLY_DUPLICATE");
    seen.set(key, normalized);
  }
  return [...seen.values()].sort((a, b) => a.openMs - b.openMs || a.symbol.localeCompare(b.symbol));
}

export function parseFundingCsv(csv: string, symbol: HourlySymbol, startMs: number, endMs: number):
  { rows: FundingRow[]; firstSourceMs: number; lastSourceMs: number } {
  if (!HOURLY_SYMBOLS.includes(symbol) || !aligned(startMs) || !aligned(endMs) || endMs <= startMs)
    throw new Error("INVALID_FUNDING_WINDOW");
  const lines = csv.replace(/^\uFEFF/, "").trimEnd().split(/\r?\n/);
  if (lines.shift() !== "timestamp,tradeable,absolute_rate,relative_rate") throw new Error("INVALID_FUNDING_CSV_HEADER");
  const rows = new Map<number, FundingRow>(); let firstSourceMs = Infinity, lastSourceMs = -Infinity;
  for (const line of lines) {
    const columns = line.split(",");
    if (columns.length !== 4 || columns[1] !== PRODUCTS[symbol] || !/^\d{4}-\d{2}-\d{2} \d{2}:00:00$/.test(columns[0]!))
      throw new Error("INVALID_FUNDING_CSV_ROW");
    const sourceMs = Date.parse(`${columns[0]!.replace(" ", "T")}Z`);
    if (!aligned(sourceMs) || new Date(sourceMs).toISOString().slice(0, 19).replace("T", " ") !== columns[0])
      throw new Error("INVALID_FUNDING_CSV_TIMESTAMP");
    const rate = numeric(columns[3]), absoluteRate = numeric(columns[2]);
    if (Math.abs(rate) > 1 || rate * absoluteRate < 0 || (rate === 0) !== (absoluteRate === 0)) throw new Error("INVALID_FUNDING_RATE");
    firstSourceMs = Math.min(firstSourceMs, sourceMs); lastSourceMs = Math.max(lastSourceMs, sourceMs);
    // The convention is stated in metadata: source timestamps are interpreted
    // as effective starts, then normalized to the simulator's settlement time.
    const timestampMs = sourceMs + HOUR_MS;
    if (timestampMs <= startMs || timestampMs > endMs) continue;
    const row: FundingRow = { symbol, timestampMs, rate, absoluteRate }, prior = rows.get(timestampMs);
    if (prior && (prior.rate !== rate || prior.absoluteRate !== absoluteRate)) throw new Error("CONFLICTING_FUNDING_DUPLICATE");
    rows.set(timestampMs, row);
  }
  if (!Number.isFinite(firstSourceMs)) throw new Error("EMPTY_FUNDING_EXPORT");
  return { rows: [...rows.values()].sort((a, b) => a.timestampMs - b.timestampMs), firstSourceMs, lastSourceMs };
}

export function fundingCoverage(rows: readonly FundingRow[], symbol: HourlySymbol, startMs: number, endMs: number): MissingHours[] {
  return missingHourlyTimes(rows.filter(row => row.symbol === symbol).map(row => row.timestampMs), startMs + HOUR_MS, endMs + HOUR_MS);
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export interface FundingZipMember { name: string; method: number; flags: number; crc32: number;
  compressedBytes: number; uncompressedBytes: number; offset: number }
export function fundingZipDirectory(tail: Buffer, archiveBytes: number): { offset: number; bytes: number; entries: number } {
  const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (at < 0 || at + 22 > tail.length || at + 22 + tail.readUInt16LE(at + 20) !== tail.length
    || tail.readUInt16LE(at + 4) !== 0 || tail.readUInt16LE(at + 6) !== 0
    || tail.readUInt16LE(at + 8) !== tail.readUInt16LE(at + 10)) throw new Error("INVALID_FUNDING_ZIP_DIRECTORY");
  const entries = tail.readUInt16LE(at + 10), bytes = tail.readUInt32LE(at + 12), offset = tail.readUInt32LE(at + 16);
  if (!entries || entries === 0xffff || !bytes || bytes > 2 * 1024 * 1024 || offset + bytes > archiveBytes - 22)
    throw new Error("UNSUPPORTED_FUNDING_ZIP_DIRECTORY");
  return { offset, bytes, entries };
}
export function fundingZipMembers(directory: Buffer, expectedEntries: number): FundingZipMember[] {
  let at = 0, entries = 0; const found: FundingZipMember[] = [];
  while (at < directory.length) {
    if (at + 46 > directory.length || directory.readUInt32LE(at) !== 0x02014b50) throw new Error("INVALID_FUNDING_ZIP_ENTRY");
    const nameBytes = directory.readUInt16LE(at + 28), extraBytes = directory.readUInt16LE(at + 30), commentBytes = directory.readUInt16LE(at + 32);
    if (at + 46 + nameBytes + extraBytes + commentBytes > directory.length) throw new Error("TRUNCATED_FUNDING_ZIP_ENTRY");
    const name = directory.subarray(at + 46, at + 46 + nameBytes).toString("utf8");
    if (Object.values(PRODUCTS).some(product => name === `exports/${product}.csv`)) {
      const row: FundingZipMember = { name, method: directory.readUInt16LE(at + 10), flags: directory.readUInt16LE(at + 8),
        crc32: directory.readUInt32LE(at + 16), compressedBytes: directory.readUInt32LE(at + 20),
        uncompressedBytes: directory.readUInt32LE(at + 24), offset: directory.readUInt32LE(at + 42) };
      if ((row.flags & 1) || ![0, 8].includes(row.method) || row.compressedBytes <= 0 || row.compressedBytes > 8 * 1024 * 1024
        || row.uncompressedBytes <= 0 || row.uncompressedBytes > 16 * 1024 * 1024 || found.some(prior => prior.name === name))
        throw new Error("UNSUPPORTED_FUNDING_ZIP_MEMBER");
      found.push(row);
    }
    entries++; at += 46 + nameBytes + extraBytes + commentBytes;
  }
  if (entries !== expectedEntries || found.length !== HOURLY_SYMBOLS.length) throw new Error("MISSING_FUNDING_ZIP_MEMBERS");
  return found;
}
export function decodeFundingZipMember(bytes: Buffer, member: FundingZipMember): Buffer {
  if (bytes.length < 30 || bytes.readUInt32LE(0) !== 0x04034b50 || bytes.readUInt16LE(8) !== member.method
    || (bytes.readUInt16LE(6) & 1)) throw new Error("INVALID_FUNDING_ZIP_LOCAL_HEADER");
  const nameBytes = bytes.readUInt16LE(26), extraBytes = bytes.readUInt16LE(28), start = 30 + nameBytes + extraBytes;
  if (start + member.compressedBytes !== bytes.length || bytes.subarray(30, 30 + nameBytes).toString("utf8") !== member.name)
    throw new Error("INVALID_FUNDING_ZIP_LOCAL_SIZE_OR_NAME");
  const compressed = bytes.subarray(start), csv = member.method === 0 ? compressed
    : inflateRawSync(compressed, { maxOutputLength: member.uncompressedBytes });
  if (csv.length !== member.uncompressedBytes || crc32(csv) !== member.crc32) throw new Error("FUNDING_ZIP_CRC_OR_SIZE_MISMATCH");
  return csv;
}

export interface HourlyDownloadOptions { out: string; startMs?: number; endMs?: number; fundingUrl?: string }
export interface HourlyDownloadDependencies { fetcher?: typeof fetch; nowMs?: number;
  onProgress?: (progress: { stage: string; symbol?: HourlySymbol; pages?: number; bars?: number; bytes?: number }) => void }
export async function downloadHourlyDataset(options: HourlyDownloadOptions, dependencies: HourlyDownloadDependencies = {}) {
  const startMs = options.startMs ?? HOURLY_DATA_SPEC.startMs, endMs = options.endMs ?? HOURLY_DATA_SPEC.endMs;
  const nowMs = dependencies.nowMs ?? Date.now(); window(startMs, endMs, nowMs);
  const fetcher = dependencies.fetcher ?? fetch, out = resolve(options.out), raw = join(out, "raw");
  await mkdir(out, { recursive: false }); await mkdir(raw);
  const sourceFiles: HourlySourceFile[] = [];
  let fundingBytes = 0;
  async function request(url: string, name: string, range?: { start: number; end: number }): Promise<Buffer> {
    const headers: Record<string, string> = {};
    if (range) headers.Range = `bytes=${range.start}-${range.end}`;
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok || (range && response.status !== 206)) {
      await response.body?.cancel(); throw new Error(`HOURLY_DATA_HTTP:${response.status}:${url}`);
    }
    if (range && !new RegExp(`^bytes ${range.start}-${range.end}/\\d+$`).test(response.headers.get("content-range") ?? "")) {
      await response.body?.cancel(); throw new Error("FUNDING_RANGE_NOT_HONORED");
    }
    const expected = range ? range.end - range.start + 1 : null;
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (!Number.isFinite(declared) || declared < 0 || declared > HOURLY_DATA_SPEC.maximumResponseBytes) {
      await response.body?.cancel(); throw new Error("HOURLY_RESPONSE_TOO_LARGE");
    }
    const reader = response.body?.getReader(); if (!reader) throw new Error("EMPTY_HOURLY_RESPONSE_BODY");
    const chunks: Buffer[] = []; let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > HOURLY_DATA_SPEC.maximumResponseBytes || (expected !== null && bytes > expected)) throw new Error("HOURLY_RESPONSE_TOO_LARGE");
        chunks.push(Buffer.from(next.value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (!bytes || (expected !== null && bytes !== expected)) throw new Error("TRUNCATED_HOURLY_RESPONSE");
    const body = Buffer.concat(chunks); await writeFile(join(raw, name), body, { flag: "wx", mode: 0o600 });
    const source: HourlySourceFile = { file: `raw/${name}`, url, bytes, sha256: sha(body), fetchedAtMs: Date.now(), status: response.status };
    if (range) source.range = headers.Range!;
    const modified = response.headers.get("last-modified"), etag = response.headers.get("etag");
    if (modified) source.lastModified = modified; if (etag) source.etag = etag;
    sourceFiles.push(source);
    if (range) { fundingBytes += bytes; if (fundingBytes > HOURLY_DATA_SPEC.maximumFundingDownloadBytes) throw new Error("FUNDING_DOWNLOAD_LIMIT"); }
    return body;
  }

  const allBars: HourlyBar[] = [];
  for (const symbol of HOURLY_SYMBOLS) {
    let cursor = startMs, page = 0;
    while (cursor < endMs) {
      if (++page > 16) throw new Error("HOURLY_PAGINATION_LIMIT");
      const url = `https://futures.kraken.com/api/charts/v1/trade/${PRODUCTS[symbol]}/1h?from=${cursor / 1000}&to=${(endMs - HOUR_MS) / 1000}&count=7000`;
      const response = await request(url, `${PRODUCTS[symbol]}-candles-${page}.json`);
      const result = parseHourlyCandles(JSON.parse(response.toString("utf8")), symbol);
      allBars.push(...result.bars);
      const latest = result.bars.at(-1)?.openMs;
      if (latest === undefined) { if (result.more) throw new Error("EMPTY_HOURLY_PAGE_WITH_MORE"); break; }
      if (latest < cursor || result.bars.some(bar => bar.openMs < cursor || bar.openMs >= endMs)) throw new Error("HOURLY_PAGE_OUT_OF_RANGE");
      dependencies.onProgress?.({ stage: "CANDLES", symbol, pages: page, bars: allBars.filter(bar => bar.symbol === symbol).length });
      cursor = latest + HOUR_MS;
      if (!result.more) break;
    }
  }
  const bars = mergeHourlyBars(allBars, startMs, endMs, nowMs);
  const barGaps = HOURLY_SYMBOLS.map(symbol => ({ symbol,
    gaps: missingHourlyTimes(bars.filter(bar => bar.symbol === symbol).map(bar => bar.openMs), startMs, endMs) }));
  if (barGaps.some(row => row.gaps.length)) {
    await writeFile(join(out, "incomplete.json"), `${JSON.stringify({ reason: "HOURLY_CANDLE_GAPS", barGaps }, null, 2)}\n`, { flag: "wx" });
    throw new Error("HOURLY_CANDLE_GAPS");
  }
  const fundingUrl = options.fundingUrl ?? HOURLY_DATA_SPEC.fundingArchiveUrl;
  if (new URL(fundingUrl).protocol !== "https:") throw new Error("INSECURE_FUNDING_URL");
  const head = await fetcher(fundingUrl, { method: "HEAD", signal: AbortSignal.timeout(30_000) });
  const archiveBytes = Number(head.headers.get("content-length"));
  if (!head.ok || !Number.isSafeInteger(archiveBytes) || archiveBytes < 22 || archiveBytes > 1024 * 1024 * 1024
    || head.headers.get("accept-ranges") !== "bytes") throw new Error("FUNDING_ARCHIVE_RANGE_UNAVAILABLE");
  const tail = await request(fundingUrl, "funding-zip-tail.bin", { start: Math.max(0, archiveBytes - 65_557), end: archiveBytes - 1 });
  const directory = fundingZipDirectory(tail, archiveBytes);
  const directoryBytes = await request(fundingUrl, "funding-zip-directory.bin", { start: directory.offset, end: directory.offset + directory.bytes - 1 });
  const members = fundingZipMembers(directoryBytes, directory.entries), funding: FundingRow[] = [];
  const memberMetadata: HourlyDatasetMetadata["funding"]["members"] = [];
  for (const symbol of HOURLY_SYMBOLS) {
    const member = members.find(row => row.name === `exports/${PRODUCTS[symbol]}.csv`)!;
    const header = await request(fundingUrl, `${PRODUCTS[symbol]}-funding-header.bin`, { start: member.offset, end: member.offset + 29 });
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error("INVALID_FUNDING_LOCAL_HEADER");
    const length = 30 + header.readUInt16LE(26) + header.readUInt16LE(28) + member.compressedBytes;
    if (member.offset + length > directory.offset) throw new Error("FUNDING_MEMBER_OUT_OF_RANGE");
    const encoded = await request(fundingUrl, `${PRODUCTS[symbol]}-funding-member.bin`, { start: member.offset, end: member.offset + length - 1 });
    const csv = decodeFundingZipMember(encoded, member), parsed = parseFundingCsv(csv.toString("utf8"), symbol, startMs, endMs);
    const file = `raw/${PRODUCTS[symbol]}-funding.csv`; await writeFile(join(out, file), csv, { flag: "wx", mode: 0o600 });
    funding.push(...parsed.rows);
    memberMetadata.push({ symbol, file, sha256: sha(csv), crc32: member.crc32, compressedBytes: member.compressedBytes,
      uncompressedBytes: member.uncompressedBytes, firstSourceMs: parsed.firstSourceMs, lastSourceMs: parsed.lastSourceMs });
    dependencies.onProgress?.({ stage: "FUNDING", symbol, bytes: fundingBytes });
  }
  funding.sort((a, b) => a.timestampMs - b.timestampMs || a.symbol.localeCompare(b.symbol));
  // Preserve newer OHLC funding analytics for coverage review only. Neither
  // open nor close is silently converted into an actual settlement payment.
  const analyticsCoverage: HourlyDatasetMetadata["funding"]["analyticsCoverage"] = [];
  for (const member of memberMetadata) {
    let fromMs = Math.max(startMs, member.lastSourceMs), page = 0;
    while (fromMs < endMs) {
      const toMsExclusive = Math.min(endMs, fromMs + 31 * 24 * HOUR_MS);
      const url = `https://futures.kraken.com/api/charts/v1/analytics/${PRODUCTS[member.symbol]}/funding?since=${fromMs / 1000}&to=${(toMsExclusive - HOUR_MS) / 1000}&interval=3600`;
      const bytes = await request(url, `${PRODUCTS[member.symbol]}-funding-analytics-${++page}.json`);
      const payload = object(JSON.parse(bytes.toString("utf8"))), result = object(payload.result), data = object(result.data);
      if (!Array.isArray(payload.errors) || payload.errors.length || !Array.isArray(result.timestamp)
        || result.timestamp.length > 744 || result.more !== false || !Array.isArray(data.rate) || !Array.isArray(data.relativeRate)
        || data.rate.length !== result.timestamp.length || data.relativeRate.length !== result.timestamp.length)
        throw new Error("INVALID_FUNDING_ANALYTICS_RESPONSE");
      const timestamps: number[] = [];
      for (const [index, timestamp] of result.timestamp.entries()) {
        if (!aligned(timestamp) || timestamp < fromMs || timestamp >= toMsExclusive
          || (timestamps.length > 0 && timestamp <= timestamps.at(-1)!)) throw new Error("INVALID_FUNDING_ANALYTICS_TIME");
        for (const series of [data.rate, data.relativeRate]) {
          const values = series[index];
          if (!Array.isArray(values) || values.length !== 4) throw new Error("INVALID_FUNDING_ANALYTICS_OHLC");
          values.forEach(numeric);
        }
        timestamps.push(timestamp);
      }
      analyticsCoverage.push({ symbol: member.symbol, fromMs, toMsExclusive, candles: timestamps.length,
        missingHours: missingHourlyTimes(timestamps, fromMs, toMsExclusive), settlementMappingVerified: false });
      dependencies.onProgress?.({ stage: "FUNDING_ANALYTICS_COVERAGE_ONLY", symbol: member.symbol, pages: page });
      fromMs = toMsExclusive;
    }
  }
  const dataset: HourlyDataset = { bars, funding, metadata: { version: HOURLY_DATA_SPEC.version, researchOnly: true,
    venue: "KRAKEN_FUTURES", startMs, endMs, fetchedAtMs: nowMs, products: { ...PRODUCTS }, sourceFiles,
    coverage: HOURLY_SYMBOLS.map(symbol => ({ symbol, expectedBars: (endMs - startMs) / HOUR_MS,
      bars: bars.filter(bar => bar.symbol === symbol).length, zeroVolumeHours: bars.filter(bar => bar.symbol === symbol && bar.volume === 0).length,
      missingBars: [], funding: funding.filter(row => row.symbol === symbol).length, missingFunding: fundingCoverage(funding, symbol, startMs, endMs) })),
    funding: { source: fundingUrl, archiveBytes, downloadedBytes: fundingBytes,
      timestampConvention: "CSV timestamp interpreted as effective-hour start; normalized settlement timestamp is source + 1 hour",
      timestampConventionVerified: false, analyticsCoverage, members: memberMetadata },
    limitations: ["Completed vendor trade candles are retrospective aggregates, not executable order-book paths; zero-volume hours remain flagged by volume=0",
      "Missing funding is absent, never filled with zero; incomplete funding invalidates affected execution paths",
      "CSV timestamp convention is an explicit interpretation pending source confirmation",
      "relative_rate is a fraction relative to the rate-setting index; exact fixed-unit dollar funding requires absoluteRate",
      "Current contract rules and configured fees do not prove historical availability, fill prices, impact or funding conventions",
      "Public archives may be revised; raw response and extracted-member hashes attest only to these downloaded bytes"] } };
  const content = `${JSON.stringify(dataset)}\n`, datasetPath = join(out, "dataset.json");
  await writeFile(datasetPath, content, { flag: "wx", mode: 0o600 });
  const manifest = { version: HOURLY_DATA_SPEC.version, datasetFile: "dataset.json", datasetSha256: sha(content),
    datasetBytes: Buffer.byteLength(content), metadata: dataset.metadata };
  await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { datasetPath, manifest, dataset };
}

export async function loadHourlyDataset(directory: string): Promise<HourlyDataset> {
  const root = resolve(directory), manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as
    { version: string; datasetFile: string; datasetSha256: string; metadata: HourlyDatasetMetadata };
  if (manifest.version !== HOURLY_DATA_SPEC.version || manifest.datasetFile !== "dataset.json") throw new Error("INVALID_HOURLY_MANIFEST");
  const bytes = await readFile(join(root, "dataset.json"));
  if (sha(bytes) !== manifest.datasetSha256) throw new Error("HOURLY_DATASET_HASH_MISMATCH");
  const dataset = JSON.parse(bytes.toString("utf8")) as HourlyDataset;
  if (JSON.stringify(dataset.metadata) !== JSON.stringify(manifest.metadata)) throw new Error("HOURLY_METADATA_MISMATCH");
  const metadata = dataset.metadata;
  if (metadata.version !== HOURLY_DATA_SPEC.version || metadata.venue !== "KRAKEN_FUTURES" || metadata.researchOnly !== true
    || !Array.isArray(dataset.bars) || !Array.isArray(dataset.funding)) throw new Error("INVALID_HOURLY_DATASET");
  const normalized = mergeHourlyBars(dataset.bars, metadata.startMs, metadata.endMs, metadata.fetchedAtMs);
  if (JSON.stringify(normalized) !== JSON.stringify(dataset.bars)) throw new Error("NONCANONICAL_HOURLY_BARS");
  const fundingIds = new Set<string>();
  for (const row of dataset.funding) {
    if (!row || !HOURLY_SYMBOLS.includes(row.symbol) || !aligned(row.timestampMs) || row.timestampMs <= metadata.startMs
      || row.timestampMs > metadata.endMs || typeof row.rate !== "number" || !Number.isFinite(row.rate) || Math.abs(row.rate) > 1
      || (row.absoluteRate !== undefined && (!Number.isFinite(row.absoluteRate) || row.rate * row.absoluteRate < 0)))
      throw new Error("INVALID_SAVED_FUNDING_ROW");
    const key = `${row.symbol}:${row.timestampMs}`;
    if (fundingIds.has(key)) throw new Error("DUPLICATE_SAVED_FUNDING_ROW"); fundingIds.add(key);
  }
  for (const symbol of HOURLY_SYMBOLS) if (missingHourlyTimes(normalized.filter(bar => bar.symbol === symbol).map(bar => bar.openMs),
    metadata.startMs, metadata.endMs).length) throw new Error("SAVED_HOURLY_CANDLE_GAPS");
  for (const source of [...metadata.sourceFiles, ...metadata.funding.members]) {
    if (!/^raw\/[A-Za-z0-9_.-]+$/.test(source.file) || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error("INVALID_HOURLY_SOURCE_MANIFEST");
    if (sha(await readFile(join(root, source.file))) !== source.sha256) throw new Error("HOURLY_RAW_SOURCE_HASH_MISMATCH");
  }
  return dataset;
}
