import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export class EventRecorder {
  private readonly stream: WriteStream;
  public constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: "a", encoding: "utf8" });
  }
  public write(event: unknown): boolean {
    return this.stream.write(`${JSON.stringify(event, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)}\n`);
  }
  public close(): Promise<void> { return new Promise((resolve, reject) => { this.stream.once("error", reject); this.stream.end(resolve); }); }
}
