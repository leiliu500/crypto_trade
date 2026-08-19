export type WatchdogFault = "PUBLIC_SILENCE" | "PRIVATE_SILENCE" | "PROCESS_STALL";
export interface WatchdogConfig { checkIntervalMs: number; publicSilenceMs: number; privateSilenceMs: number; maximumEventLoopDriftMs: number; }

/** Separate timer-based liveness monitor; it never performs strategy work. */
export class HealthWatchdog {
  private lastPublicMs = Date.now();
  private lastPrivateMs = Date.now();
  private expectedTickMs = Date.now();
  private timer?: NodeJS.Timeout;
  public constructor(private readonly cfg: WatchdogConfig, private readonly onFault: (fault: WatchdogFault) => void, private readonly now: () => number = Date.now) {}
  public start(): void {
    if (this.timer) return;
    const current = this.now();
    this.lastPublicMs = current; this.lastPrivateMs = current; this.expectedTickMs = current + this.cfg.checkIntervalMs;
    this.timer = setInterval(() => this.check(), this.cfg.checkIntervalMs);
    this.timer.unref();
  }
  public stop(): void { if (this.timer) clearInterval(this.timer); delete this.timer; }
  public markPublic(nowMs = this.now()): void { this.lastPublicMs = nowMs; }
  public markPrivate(nowMs = this.now()): void { this.lastPrivateMs = nowMs; }
  private check(): void {
    const current = this.now();
    if (current - this.expectedTickMs > this.cfg.maximumEventLoopDriftMs) this.onFault("PROCESS_STALL");
    if (current - this.lastPublicMs > this.cfg.publicSilenceMs) this.onFault("PUBLIC_SILENCE");
    if (current - this.lastPrivateMs > this.cfg.privateSilenceMs) this.onFault("PRIVATE_SILENCE");
    this.expectedTickMs = current + this.cfg.checkIntervalMs;
  }
}
