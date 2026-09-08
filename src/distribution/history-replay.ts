import { createReadStream, type Stats } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import type { RecordedEvent } from "../backtest/replay.js";
import { LocalOrderBook } from "../core/order-book.js";
import { DistributionMarket, distributionBookReason } from "./market.js";
import { DISTRIBUTION_SPEC } from "./spec.js";

/** Replay observed prices only. This module has no controller, model, account or
 * broker: preparation cannot create training labels, validation or orders. */
export async function warmDistributionMarketHistory(
  events: AsyncIterable<RecordedEvent> | Iterable<RecordedEvent>, cutoffMs: number,
) {
  if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) throw new Error("INVALID_HISTORY_CUTOFF");
  const market = new DistributionMarket(), books = new Map<string, LocalOrderBook>();
  const streamTimes = new Map<string, number>();
  const report = { version: "btc-eth-market-history-preparation-v1", cutoffMs,
    events: 0, books: 0, acceptedBooks: 0, trades: 0, ignoredPrivate: 0,
    futureEventsExcluded: 0, duplicates: 0, invalidBooks: 0, timestampReversals: 0,
    crossStreamReceiveRegressions: 0, publicDisconnects: 0, recorderGaps: 0,
    invalidReasons: {} as Record<string, number>, firstMs: null as number | null,
    lastMs: null as number | null, brokerOrdersSubmitted: 0,
    trainingOutcomesCreated: 0, prospectiveSelectionsCreated: 0 };
  const invalidate = (reason: string): void => {
    market.invalidate(); for (const book of books.values()) book.invalidate();
    report.invalidReasons[reason] = (report.invalidReasons[reason] ?? 0) + 1;
  };
  for await (const event of events) {
    report.events++;
    if (!event || typeof event !== "object") throw new Error("INVALID_RECORDED_EVENT");
    if (event.kind === "PRIVATE") { report.ignoredPrivate++; continue; }
    if (!["BOOK", "TRADE", "DISCONNECT", "RECORDER_GAP"].includes(event.kind))
      throw new Error("INVALID_RECORDED_EVENT_KIND");
    const now = event.kind === "BOOK" ? event.delta?.receiveTsMs
      : event.kind === "TRADE" ? event.trade?.receiveTsMs : event.receiveTsMs;
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_RECORDED_TIMESTAMP");
    // Do not stop at the first future event: independent buffered streams may
    // still contain an earlier admissible receipt timestamp later in the file.
    if (now > cutoffMs) { report.futureEventsExcluded++; continue; }
    if (event.kind === "DISCONNECT" && event.stream === "private") { report.ignoredPrivate++; continue; }
    const symbol = event.kind === "BOOK" ? event.delta.symbol : event.kind === "TRADE" ? event.trade.symbol : null;
    if (symbol !== null && !DISTRIBUTION_SPEC.symbols.some(s => s === symbol)) continue;
    const stream = symbol === null ? null : `${event.kind}:${symbol}`;
    if (stream && now < (streamTimes.get(stream) ?? -Infinity)) {
      report.timestampReversals++; invalidate("RECEIVE_TIMESTAMP_REVERSAL"); continue;
    }
    if (stream) streamTimes.set(stream, now);
    report.firstMs = Math.min(report.firstMs ?? now, now);
    report.crossStreamReceiveRegressions += Number(report.lastMs !== null && now < report.lastMs);
    report.lastMs = Math.max(report.lastMs ?? now, now);
    if (event.kind === "DISCONNECT") {
      if (event.stream !== "public") throw new Error("INVALID_RECORDED_DISCONNECT_STREAM");
      report.publicDisconnects++;
      const history = market.exportHistory();
      market.invalidate(); for (const book of books.values()) book.invalidate();
      // A brief disconnect retains real endpoints, never an executable quote or
      // flow state. restoreHistory rejects endpoints older than ninety seconds.
      market.restoreHistory(history, report.lastMs);
      continue;
    }
    if (event.kind === "RECORDER_GAP") {
      report.recorderGaps++; invalidate("RECORDER_GAP"); continue;
    }
    if (event.kind === "TRADE") { report.trades++; continue; } // No flow is persisted.
    report.books++;
    const delta = event.delta;
    if (!Number.isSafeInteger(delta.exchangeTsMs) || delta.exchangeTsMs < 0
      || typeof delta.reset !== "boolean" || typeof delta.sourceId !== "string" || !delta.sourceId
      || !Array.isArray(delta.bids) || !Array.isArray(delta.asks))
      throw new Error("INVALID_RECORDED_BOOK");
    const book = books.get(delta.symbol) ?? new LocalOrderBook(delta.symbol);
    books.set(delta.symbol, book);
    const result = book.apply(delta);
    if (result.duplicate) { report.duplicates++; continue; }
    const reason = !result.accepted || !result.state ? result.reason ?? "INVALID_BOOK" : distributionBookReason(result.state);
    if (reason) { report.invalidBooks++; invalidate(reason); continue; }
    const snapshot = market.onBook(result.state!);
    if (snapshot?.reason === "REVERSED_BOOK") {
      report.timestampReversals++; invalidate("REVERSED_BOOK"); continue;
    }
    report.acceptedBooks++;
  }
  // Remove stale tails at the intended deployment cutoff and strip all live
  // books/flow. Output is bounded real price history, not an evaluation snapshot.
  const finalMarket = new DistributionMarket();
  const restored = finalMarket.restoreHistory(market.exportHistory(), cutoffMs);
  const history = finalMarket.exportHistory();
  return { history, report: { ...report, ...restored,
    symbols: DISTRIBUTION_SPEC.symbols.map(symbol => ({ symbol, ...finalMarket.historyStats(symbol, cutoffMs) })),
    assumptions: ["All raw book updates were reconstructed and validated; no synthetic prices or sampling-phase changes",
      "Only observed price endpoints are exported; fresh live quotes and thirty seconds of clean flow remain required",
      "This does not satisfy training support or prospective profitability validation"] } };
}

/** Inputs must be frozen complete files, in original chronological file order.
 * A changing file, truncated gzip or invalid JSON fails before output promotion. */
export async function prepareDistributionHistory(files: readonly string[], out: string, cutoffMs = Date.now()) {
  if (!files.length) throw new Error("HISTORY_INPUT_REQUIRED");
  const paths = files.map(path => resolve(path)), output = resolve(out);
  if (new Set(paths).size !== paths.length || paths.includes(output))
    throw new Error("HISTORY_INPUT_OUTPUT_COLLISION");
  const inputFiles: Array<{ path: string; bytes: number; modifiedMs: number; inode: number; sha256: string }> = [];
  const inputStats = new Map<string, Stats>();
  for (const path of paths) {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`HISTORY_INPUT_NOT_FILE:${path}`);
    inputStats.set(path, info);
  }
  async function* events() {
    for (const path of paths) {
      const hash = createHash("sha256");
      yield* safelyReadRecordedEvents(path, chunk => { hash.update(chunk); });
      const info = inputStats.get(path)!;
      inputFiles.push({ path, bytes: info.size, modifiedMs: info.mtimeMs, inode: info.ino, sha256: hash.digest("hex") });
    }
  }
  const result = await warmDistributionMarketHistory(events(), cutoffMs);
  for (const file of inputFiles) {
    const after = await stat(file.path);
    if (after.size !== file.bytes || after.mtimeMs !== file.modifiedMs || after.ino !== file.inode)
      throw new Error(`HISTORY_INPUT_CHANGED:${file.path}`);
  }
  const content = `${JSON.stringify(result.history)}\n`;
  const report = { ...result.report, inputFiles, historyFile: output,
    historySha256: createHash("sha256").update(content).digest("hex") };
  await atomicWrite(output, content);
  return { ...result, report, output };
}

/** Same JSONL event format as readRecordedEvents, with owned streams so malformed
 * JSON, fs errors and incomplete gzip members always close descriptors and fail. */
async function* safelyReadRecordedEvents(path: string, onCompressedBytes: (chunk: Buffer) => void): AsyncGenerator<RecordedEvent> {
  const source = createReadStream(path), output = new PassThrough();
  const hashing = new Transform({ transform(chunk: Buffer, _encoding, done) { onCompressedBytes(chunk); done(null, chunk); } });
  const decoder = path.toLowerCase().endsWith(".gz") ? createGunzip() : new PassThrough();
  const lines = createInterface({ input: output, crlfDelay: Infinity });
  let streamError: unknown;
  const running = pipeline(source, hashing, decoder, output).catch(error => { streamError = error; });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      yield JSON.parse(line) as RecordedEvent;
    }
    await running;
    if (streamError) throw streamError;
  } finally {
    lines.close(); source.destroy(); hashing.destroy(); decoder.destroy(); output.destroy();
    await running;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(temporary).catch(() => {}); throw error; }
  await handle.close();
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
