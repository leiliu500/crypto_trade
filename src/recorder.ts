import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, renameSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { gzip } from "node:zlib";

const COMPRESSED_BATCH_BYTES = 256 * 1024;
const COMPRESSED_FLUSH_INTERVAL_MS = 1_000;
const MAXIMUM_QUEUED_BYTES = 8 * 1024 * 1024;

export interface EventRecorderOptions {
  rotateExisting?: boolean;
  maximumQueuedBytes?: number;
  compressedBatchBytes?: number;
  compressedFlushIntervalMs?: number;
}

export interface EventRecorderStats {
  queuedBytes: number;
  droppedEvents: number;
  droppedBytes: number;
  pendingGapEvents: number;
  archivedPath: string | null;
}

export class EventRecorder {
  private readonly stream: WriteStream;
  private readonly compressed: boolean;
  private readonly flushTimer?: NodeJS.Timeout;
  private compressedBuffer: string[] = [];
  private compressedBufferBytes = 0;
  private queuedBytes = 0;
  private compressionQueue: Promise<void> = Promise.resolve();
  private failure?: Error;
  private closed = false;
  private droppedEvents = 0;
  private droppedBytes = 0;
  private pendingGapEvents = 0;
  private pendingGapBytes = 0;
  private readonly maximumQueuedBytes: number;
  private readonly compressedBatchBytes: number;
  private readonly archivedPath: string | null;

  public constructor(path: string, options: EventRecorderOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.maximumQueuedBytes = Math.max(1, options.maximumQueuedBytes ?? MAXIMUM_QUEUED_BYTES);
    this.compressedBatchBytes = Math.max(1, options.compressedBatchBytes ?? COMPRESSED_BATCH_BYTES);
    this.archivedPath = options.rotateExisting ? archiveExisting(path) : null;
    this.compressed = path.toLowerCase().endsWith(".gz");
    this.stream = createWriteStream(path, { flags: options.rotateExisting ? "w" : "a" });
    this.stream.on("error", (error) => { this.failure ??= error; });
    if (this.compressed) {
      this.flushTimer = setInterval(() => this.queueCompressedBuffer(),
        Math.max(1, options.compressedFlushIntervalMs ?? COMPRESSED_FLUSH_INTERVAL_MS));
      this.flushTimer.unref();
    }
  }

  public write(event: unknown): boolean {
    if (this.closed || this.failure) return false;
    const line = `${JSON.stringify(event, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)}\n`;
    const bytes = Buffer.byteLength(line);
    const gap = this.pendingGapEvents > 0 ? this.gapLine() : null;
    const gapBytes = gap === null ? 0 : Buffer.byteLength(gap);
    if (this.currentQueuedBytes() + gapBytes + bytes > this.maximumQueuedBytes) {
      this.droppedEvents += 1;
      this.droppedBytes += bytes;
      this.pendingGapEvents += 1;
      this.pendingGapBytes += bytes;
      return false;
    }
    if (gap !== null) {
      this.enqueueLine(gap, gapBytes);
      this.pendingGapEvents = 0;
      this.pendingGapBytes = 0;
    }
    this.enqueueLine(line, bytes);
    return true;
  }

  public stats(): EventRecorderStats {
    return {
      queuedBytes: this.currentQueuedBytes(), droppedEvents: this.droppedEvents, droppedBytes: this.droppedBytes,
      pendingGapEvents: this.pendingGapEvents, archivedPath: this.archivedPath,
    };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.compressed) {
      this.queueCompressedBuffer();
      await this.compressionQueue;
      this.queueFinalGap();
      this.queueCompressedBuffer();
      await this.compressionQueue;
    } else if (this.pendingGapEvents > 0 && !this.failure) {
      if (this.stream.writableNeedDrain) await once(this.stream, "drain");
      this.stream.write(this.gapLine(), "utf8");
      this.pendingGapEvents = 0;
      this.pendingGapBytes = 0;
    }
    if (this.failure) throw this.failure;
    await new Promise<void>((resolve, reject) => {
      this.stream.once("error", reject);
      this.stream.end(resolve);
    });
    if (this.failure) throw this.failure;
  }

  private queueCompressedBuffer(): void {
    if (this.compressedBufferBytes === 0 || this.failure) return;
    const payload = this.compressedBuffer.join("");
    const payloadBytes = this.compressedBufferBytes;
    this.compressedBuffer = [];
    this.compressedBufferBytes = 0;
    this.queuedBytes += payloadBytes;
    this.compressionQueue = this.compressionQueue.then(async () => {
      if (this.failure) return;
      const output = await gzipBuffer(payload);
      if (!this.stream.write(output)) await once(this.stream, "drain");
    }).catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.stream.destroy(this.failure);
    }).finally(() => { this.queuedBytes -= payloadBytes; });
  }

  private currentQueuedBytes(): number {
    return this.compressed ? this.queuedBytes + this.compressedBufferBytes : this.stream.writableLength;
  }

  private enqueueLine(line: string, bytes: number): void {
    if (!this.compressed) {
      this.stream.write(line, "utf8");
      return;
    }
    this.compressedBuffer.push(line);
    this.compressedBufferBytes += bytes;
    if (this.compressedBufferBytes >= this.compressedBatchBytes) this.queueCompressedBuffer();
  }

  private gapLine(): string {
    return `${JSON.stringify({ kind: "RECORDER_GAP", receiveTsMs: Date.now(),
      droppedEvents: this.pendingGapEvents, droppedBytes: this.pendingGapBytes })}\n`;
  }

  private queueFinalGap(): void {
    if (this.pendingGapEvents === 0 || this.failure) return;
    const gap = this.gapLine();
    this.compressedBuffer.push(gap);
    this.compressedBufferBytes += Buffer.byteLength(gap);
    this.pendingGapEvents = 0;
    this.pendingGapBytes = 0;
  }
}

function archiveExisting(path: string): string | null {
  if (!existsSync(path)) return null;
  const suffix = path.toLowerCase().endsWith(".jsonl.gz") ? ".jsonl.gz" : path.toLowerCase().endsWith(".gz") ? ".gz" : "";
  const stem = suffix ? path.slice(0, -suffix.length) : path;
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  let candidate = `${stem}.${timestamp}${suffix}`;
  for (let index = 1; existsSync(candidate); index += 1) candidate = `${stem}.${timestamp}.${index}${suffix}`;
  renameSync(path, candidate);
  return candidate;
}

function gzipBuffer(payload: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(payload, { level: 6 }, (error, output) => error ? reject(error) : resolve(output));
  });
}
