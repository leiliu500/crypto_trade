export type HaltReason = "SEQUENCE_GAP" | "BOOK_INVALID" | "PUBLIC_STREAM_DOWN" | "PRIVATE_STREAM_DOWN" | "ACCOUNT_UNKNOWN" | "ORDER_SEND_UNKNOWN" | "ACK_LATENCY" | "ROLLING_LOSS" | "DRAWDOWN" | "CLOCK_INVALID" | "PROCESS_STALL" | "MANUAL";
export interface HealthState { publicStream: boolean; privateStream: boolean; accountReconciled: boolean; bookValid: boolean; clockValid: boolean; riskRecomputed: boolean; }

export class RiskState {
  private readonly haltReasons = new Set<HaltReason>();
  private health: HealthState = { publicStream: false, privateStream: false, accountReconciled: false, bookValid: false, clockValid: true, riskRecomputed: false };
  private equity = 0;
  private equityHighWater = 0;
  private realizedLoss24h = 0;
  private realizedSessionLoss = 0;
  public constructor(private readonly rollingLossFraction: number, private readonly sessionLossFraction: number, private readonly maximumDrawdown: number) {}

  public updateEquity(equity: number): void {
    if (!(equity > 0)) { this.halt("ACCOUNT_UNKNOWN"); return; }
    this.equity = equity;
    this.equityHighWater = Math.max(this.equityHighWater, equity);
    if (1 - equity / this.equityHighWater >= this.maximumDrawdown) this.halt("DRAWDOWN");
  }
  public updateLosses(realizedLoss24h: number, realizedSessionLoss: number, stressedOpenLoss: number): void {
    this.realizedLoss24h = Math.max(0, realizedLoss24h);
    this.realizedSessionLoss = Math.max(0, realizedSessionLoss);
    if (this.equity > 0 && (this.realizedLoss24h + stressedOpenLoss >= this.equity * this.rollingLossFraction
      || this.realizedSessionLoss + stressedOpenLoss >= this.equity * this.sessionLossFraction)) this.halt("ROLLING_LOSS");
  }
  public setHealth(patch: Partial<HealthState>): void { this.health = { ...this.health, ...patch }; }
  public halt(reason: HaltReason): void { this.haltReasons.add(reason); this.health.riskRecomputed = false; }
  public entriesAllowed(): boolean { return this.haltReasons.size === 0 && Object.values(this.health).every(Boolean); }
  public reasons(): readonly HaltReason[] { return [...this.haltReasons]; }
  public snapshot(): { health: HealthState; reasons: readonly HaltReason[]; equity: number; equityHighWater: number } {
    return { health: { ...this.health }, reasons: this.reasons(), equity: this.equity, equityHighWater: this.equityHighWater };
  }
  /** Resume is only possible after every design reconciliation invariant passes. */
  public resumeAfterReconciliation(): boolean {
    if (!Object.values(this.health).every(Boolean)) return false;
    const operational: HaltReason[] = ["SEQUENCE_GAP", "BOOK_INVALID", "PUBLIC_STREAM_DOWN", "PRIVATE_STREAM_DOWN", "ACCOUNT_UNKNOWN", "ORDER_SEND_UNKNOWN", "ACK_LATENCY", "CLOCK_INVALID", "PROCESS_STALL"];
    for (const reason of operational) this.haltReasons.delete(reason);
    return this.haltReasons.size === 0;
  }
}
