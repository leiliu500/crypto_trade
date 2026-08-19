import { once } from "node:events";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { gzip } from "node:zlib";

const COMPRESSED_BATCH_BYTES = 256 * 1024;
const COMPRESSED_FLUSH_INTERVAL_MS = 1_000;
const MAXIMUM_QUEUED_BYTES = 8 * 1024 * 1024;

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

  public constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.compressed = path.toLowerCase().endsWith(".gz");
    this.stream = createWriteStream(path, { flags: "a" });
    this.stream.on("error", (error) => { this.failure ??= error; });
    if (this.compressed) {
      this.flushTimer = setInterval(() => this.queueCompressedBuffer(), COMPRESSED_FLUSH_INTERVAL_MS);
      this.flushTimer.unref();
    }
  }

  public write(event: unknown): boolean {
    if (this.closed || this.failure) return false;
    const line = `${JSON.stringify(event, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)}\n`;
    if (!this.compressed) return this.stream.write(line, "utf8");
    const bytes = Buffer.byteLength(line);
    this.compressedBuffer.push(line);
    this.compressedBufferBytes += bytes;
    if (this.compressedBufferBytes >= COMPRESSED_BATCH_BYTES) this.queueCompressedBuffer();
    return this.queuedBytes + this.compressedBufferBytes < MAXIMUM_QUEUED_BYTES;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.compressed) {
      this.queueCompressedBuffer();
      await this.compressionQueue;
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
}

function gzipBuffer(payload: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(payload, { level: 6 }, (error, output) => error ? reject(error) : resolve(output));
  });
}
