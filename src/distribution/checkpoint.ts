import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TradingEngine } from "../engine/trading-engine.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SPEC, type DistributionDecision } from "./spec.js";

/** Atomic, serialized local state. A failed write is reported and does not
 * disable exits; the last complete checkpoint remains available. */
export class DistributionCheckpoint {
  private queue: Promise<void> = Promise.resolve();
  private latestState: unknown = null;
  private saving = false;
  public constructor(private readonly path: string, private readonly engine: TradingEngine,
    private readonly reportError: (error: unknown) => void) {}
  public async restore(): Promise<number> {
    try {
      const state = JSON.parse(await readFile(this.path, "utf8"));
      let pending: { symbol: string; actionId: string; atMs: number; selectionPolicyVersion?: string } | null = null;
      let journalExists = false;
      try { const journal = await readFile(`${this.path}.pending`, "utf8"); journalExists = true; pending = JSON.parse(journal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (journalExists && (!pending || typeof pending !== "object" || !DISTRIBUTION_SPEC.symbols.some(s => s === pending!.symbol)
        || !DISTRIBUTION_ACTIONS.some(a => a.id === pending!.actionId) || !Number.isSafeInteger(pending.atMs) || pending.atMs < 0)) {
        throw new Error("INVALID_DISTRIBUTION_PENDING_JOURNAL");
      }
      const restored = this.engine.restoreDistributionalState(state);
      const activePolicyVersion = this.engine.exportDistributionalState()?.selectionPolicyVersion;
      if (pending && (!activePolicyVersion || pending.selectionPolicyVersion !== activePolicyVersion
        || state.selectionPolicyVersion !== activePolicyVersion
        || !state.validationSelections.some((row: { sampleId: string; decision: DistributionDecision }) =>
          row.sampleId === `${pending!.symbol}:${pending!.actionId}:${pending!.atMs}`
          && row.decision.selectionPolicyVersion === pending!.selectionPolicyVersion))) {
        this.engine.invalidateDistributionalValidation();
      }
      return restored;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.engine.invalidateDistributionalValidation(); return 0; }
      throw error;
    }
  }
  /** This tiny write-ahead marker completes synchronously before the engine
   * can dispatch a selected paper entry. A crash cannot erase a selected path
   * while preserving a previous checkpoint's positive validation. */
  public markPending(decision: DistributionDecision): void {
    if (!decision.actionId) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const target = `${this.path}.pending`, temporary = `${target}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({ symbol: decision.symbol, actionId: decision.actionId, atMs: decision.atMs,
        selectionPolicyVersion: decision.selectionPolicyVersion })}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, target);
    const directory = openSync(dirname(this.path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  public save(): void {
    const state = this.engine.exportDistributionalState();
    if (!state) return;
    // At most one write and one newer snapshot are retained. Fast selected
    // nonfills must not build an unbounded queue of full model checkpoints.
    this.latestState = state;
    if (this.saving) return;
    this.saving = true;
    this.queue = this.writeLatest();
  }
  private async writeLatest(): Promise<void> {
    try {
      while (this.latestState !== null) {
        const state = this.latestState; this.latestState = null;
        try { await this.writeState(state); }
        catch (error) { this.reportError(error); }
      }
    } finally { this.saving = false; }
  }
  private async writeState(state: unknown): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
  public async flush(): Promise<void> { while (this.saving) await this.queue; }
}
