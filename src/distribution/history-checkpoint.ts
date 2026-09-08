import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TradingEngine } from "../engine/trading-engine.js";

type HistoryEngine = Pick<TradingEngine, "exportDistributionalMarketHistory" | "restoreDistributionalMarketHistory">;

/** Price history only. This file cannot restore a quote, decision, training
 * outcome or order permission. Capture before shutdown invalidates the feed. */
export class DistributionHistoryCheckpoint {
  private queue: Promise<void> = Promise.resolve();
  public constructor(private readonly path: string, private readonly engine: HistoryEngine,
    private readonly reportError: (error: unknown) => void) {}

  public async restore() {
    let contents: string;
    try { contents = await readFile(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    return this.engine.restoreDistributionalMarketHistory(JSON.parse(contents));
  }

  public save(): void {
    const history = this.engine.exportDistributionalMarketHistory();
    if (!history) return;
    // Serialize at capture time: engine.stop() may clear the live context
    // before this asynchronous write reaches the head of the queue.
    const contents = `${JSON.stringify(history)}\n`;
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, this.path);
    }).catch(error => { this.reportError(error); });
  }
  public async flush(): Promise<void> { await this.queue; }
}
