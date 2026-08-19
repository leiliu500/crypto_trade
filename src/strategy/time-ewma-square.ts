/** Causal, event-time EWMA of a squared signal. Decisions use rms() before update(). */
export class TimeEwmaSquare {
  private initialized = false;
  private lastMs = 0;
  private squareMean = 0;

  public constructor(private readonly tauMs: number, private readonly floor = 1e-8) {
    if (!(tauMs > 0) || !(floor > 0)) throw new Error("TimeEwmaSquare requires positive tau and floor");
  }

  public rms(): number { return Math.sqrt(Math.max(this.squareMean, this.floor)); }

  public update(value: number, nowMs: number): void {
    if (!Number.isFinite(value) || !Number.isFinite(nowMs)) return;
    if (!this.initialized) {
      this.initialized = true;
      this.lastMs = nowMs;
      this.squareMean = Math.max(value * value, this.floor);
      return;
    }
    const elapsedMs = Math.max(.01, nowMs - this.lastMs);
    const alpha = 1 - Math.exp(-elapsedMs / this.tauMs);
    this.squareMean = (1 - alpha) * this.squareMean + alpha * value * value;
    this.lastMs = nowMs;
  }
}
