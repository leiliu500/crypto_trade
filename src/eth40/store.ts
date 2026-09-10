import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquireSpotPaperLock, durableSpotFile } from "../spot-trend/journal.js";
import { validatePaperState } from "./engine.js";
import type { AccountId, Asset, CycleResult, DailyBar, MarketSnapshot, PaperState } from "./types.js";

const ASSETS: Asset[] = ["ETH/USD", "BTC/USD"];
const ACCOUNTS: AccountId[] = ["eth40", "passiveEth", "passiveBtc"];
const HASH = /^[a-f0-9]{64}$/;
const EVENT_FILE = /^\d{12}\.json$/;
const PENDING_FILE = /^\d{12}\.json\.pending-[a-f0-9-]+$/;
const MAX_BYTES = 64 * 1024 * 1024;
type Histories = Record<Asset, DailyBar[]>;
type MarketEvidence = Omit<MarketSnapshot, "histories"> & { historyEvidence: Record<Asset, string> };
interface Evidence { version: "eth40-evidence-v1"; kind: string; payload: unknown }
interface BaseEvent {
  version: "eth40-event-v1"; sequence: number; previousHash: string | null;
  beforeStateHash: string | null; manifestHash: string; state: PaperState;
}
interface Genesis extends BaseEvent { kind: "genesis"; manifest: unknown }
interface Cycle extends BaseEvent { kind: "cycle"; market: MarketEvidence; decisions: CycleResult["decisions"]; valuations: CycleResult["valuations"] }
type Event = Genesis | Cycle;
interface Envelope { hash: string; event: Event }
interface Head { version: "eth40-head-v1"; sequence: number; hash: string }

export interface Eth40Store {
  readonly state: PaperState;
  readonly sequence: number;
  readonly lastHash: string;
  readonly manifestHash: string;
  readonly latestMarketHistories: Histories | null;
  appendCycle(input: { market: MarketSnapshot; result: CycleResult }): Promise<void>;
  evidence(kind: string, payload: unknown): Promise<string>;
  close(): Promise<void>;
}

/** Only lossless plain JSON is accepted; hashes never silently drop undefined or nonfinite values. */
function canonical(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): string => {
    if (depth > 128) throw new Error("ETH40_STORE_JSON_TOO_DEEP");
    if (item === null || typeof item === "boolean" || typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || ancestors.has(item)) throw new Error("ETH40_STORE_INVALID_JSON");
    if (Object.getOwnPropertySymbols(item).length) throw new Error("ETH40_STORE_INVALID_JSON");
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw new Error("ETH40_STORE_INVALID_JSON");
      const parts: string[] = [];
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, i);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("ETH40_STORE_INVALID_JSON");
        parts.push(visit(descriptor.value, depth + 1));
      }
      result = `[${parts.join(",")}]`;
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("ETH40_STORE_INVALID_JSON");
      result = `{${Object.keys(item).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!Object.hasOwn(descriptor, "value")) throw new Error("ETH40_STORE_INVALID_JSON");
        return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
      }).join(",")}}`;
    }
    ancestors.delete(item);
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > MAX_BYTES) throw new Error("ETH40_STORE_RECORD_TOO_LARGE");
  return result;
}
const sha = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const stateHash = (state: PaperState): string => sha(canonical(state));
const copy = <T>(value: T): T => JSON.parse(canonical(value)) as T;
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const filename = (sequence: number): string => {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999_999_999_999) throw new Error("ETH40_STORE_INVALID_SEQUENCE");
  return `${String(sequence).padStart(12, "0")}.json`;
};

async function bytes(file: string): Promise<string> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("ETH40_STORE_INVALID_FILE");
  return readFile(file, "utf8");
}
async function absent(file: string): Promise<boolean> {
  try { await lstat(file); return false; } catch (error) { if (missing(error)) return true; throw error; }
}
async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("ETH40_STORE_INVALID_DIRECTORY");
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
function parseCanonical<T>(raw: string): T {
  const parsed = JSON.parse(raw) as T;
  if (`${canonical(parsed)}\n` !== raw) throw new Error("ETH40_STORE_NONCANONICAL_RECORD");
  return parsed;
}

function validateGenesis(state: PaperState): void {
  validatePaperState(state);
  for (const id of ACCOUNTS) {
    const p = state.portfolios[id], a = p.account;
    if (a.receipts.length || a.cashUsd !== a.initialCashUsd || a.quantity !== 0 || a.entryCostUsd !== 0
      || a.realizedNetUsd !== 0 || a.feesUsd !== 0 || p.entered || p.lastFillDayMs !== null || p.completedEpisodes !== 0
      || p.maxDrawdownUsd !== 0 || p.peakLiquidationEquityUsd !== a.initialCashUsd)
      throw new Error("ETH40_STORE_NONPRISTINE_GENESIS");
  }
}

function validateTransition(before: PaperState, market: MarketEvidence | MarketSnapshot, result: CycleResult): void {
  const after = result.state;
  validatePaperState(after);
  for (const field of ["version", "startedAtMs", "reviewAtMs", "firstExecutionDayMs"] as const) {
    if (before[field] !== after[field]) throw new Error("ETH40_STORE_EXPERIMENT_IDENTITY_CHANGED");
  }
  if (after.lastCycleAtMs !== market.observedAtMs || after.lastCycleAtMs < before.lastCycleAtMs)
    throw new Error("ETH40_STORE_CYCLE_TIME_MISMATCH");
  if (!Array.isArray(result.decisions) || !Array.isArray(result.valuations)
    || result.decisions.length !== ACCOUNTS.length || result.valuations.length !== ACCOUNTS.length
    || new Set(result.decisions.map(d => d.accountId)).size !== ACCOUNTS.length
    || new Set(result.valuations.map(v => v.accountId)).size !== ACCOUNTS.length)
    throw new Error("ETH40_STORE_INCOMPLETE_CYCLE");
  for (const id of ACCOUNTS) {
    const prior = before.portfolios[id], next = after.portfolios[id];
    const decision = result.decisions.find(d => d.accountId === id), valuation = result.valuations.find(v => v.accountId === id);
    if (!decision || !valuation || decision.symbol !== next.symbol || prior.symbol !== next.symbol
      || !["buy", "sell", "hold", "blocked"].includes(decision.action)
      || !["long", "cash", null].includes(decision.target)) throw new Error("ETH40_STORE_INVALID_DECISION");
    if (next.peakLiquidationEquityUsd < prior.peakLiquidationEquityUsd || next.maxDrawdownUsd < prior.maxDrawdownUsd)
      throw new Error("ETH40_STORE_RECORDED_RISK_DECREASED");
    if (next.account.initialCashUsd !== prior.account.initialCashUsd
      || next.account.receipts.length < prior.account.receipts.length
      || next.account.receipts.length > prior.account.receipts.length + 1
      || !same(next.account.receipts.slice(0, prior.account.receipts.length), prior.account.receipts))
      throw new Error("ETH40_STORE_RECEIPT_PREFIX_CHANGED");
    const added = next.account.receipts.slice(prior.account.receipts.length);
    if (decision.fill === null) {
      if (added.length || decision.action === "buy" || decision.action === "sell") throw new Error("ETH40_STORE_FILL_WITHOUT_DECISION");
    } else if (added.length !== 1 || !same(added[0], decision.fill) || decision.orderId !== decision.fill.id
      || decision.action !== decision.fill.side || decision.fill.timestampMs !== market.observedAtMs) {
      throw new Error("ETH40_STORE_DECISION_RECEIPT_MISMATCH");
    }
    for (const field of ["cashUsd", "quantity", "realizedNetUsd", "feesUsd"] as const) {
      if (valuation[field] !== next.account[field]) throw new Error("ETH40_STORE_VALUATION_ACCOUNT_MISMATCH");
    }
    if ((valuation.liquidationEquityUsd === null) !== (valuation.netPnlUsd === null)) throw new Error("ETH40_STORE_VALUATION_PNL_MISMATCH");
    if (valuation.liquidationEquityUsd !== null && (valuation.netPnlUsd === null
      || Math.abs(valuation.liquidationEquityUsd - next.account.initialCashUsd - valuation.netPnlUsd) > 1e-7))
      throw new Error("ETH40_STORE_VALUATION_PNL_MISMATCH");
  }
}

class Store implements Eth40Store {
  private currentState!: PaperState;
  private currentSequence = 0;
  private currentHash = "";
  private histories: Histories | null = null;
  private eventHistories: Histories | null = null;
  private historyReferences: Partial<Record<Asset, string>> = {};
  private readonly verifiedEvidence = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private closing: Promise<void> | null = null;
  readonly manifestHash: string;
  constructor(private readonly root: string, private readonly manifest: unknown, private readonly release: () => Promise<void>) {
    this.manifestHash = sha(canonical(manifest));
  }
  get state(): PaperState { return this.currentState; }
  get sequence(): number { return this.currentSequence; }
  get lastHash(): string { return this.currentHash; }
  get latestMarketHistories(): Histories | null { return this.histories; }
  private queued<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("ETH40_STORE_CLOSED"));
    const result = this.tail.then(async () => {
      if (this.failure !== null) throw new Error("ETH40_STORE_REOPEN_REQUIRED", { cause: this.failure });
      try { return await operation(); } catch (error) { this.failure = error; throw error; }
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async verifyEvidence(id: string, read = false): Promise<Evidence | null> {
    if (!HASH.test(id)) throw new Error("ETH40_STORE_INVALID_EVIDENCE_ID");
    if (!read && this.verifiedEvidence.has(id)) return null;
    const raw = await bytes(join(this.root, "evidence", `${id}.json`));
    if (sha(raw) !== id) throw new Error("ETH40_STORE_EVIDENCE_HASH_MISMATCH");
    const parsed = parseCanonical<Evidence>(raw);
    if (parsed.version !== "eth40-evidence-v1" || typeof parsed.kind !== "string" || !parsed.kind.length)
      throw new Error("ETH40_STORE_INVALID_EVIDENCE");
    this.verifiedEvidence.add(id);
    return parsed;
  }
  private async saveEvidence(kind: string, payload: unknown): Promise<string> {
    if (typeof kind !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(kind)) throw new Error("ETH40_STORE_INVALID_EVIDENCE_KIND");
    const raw = `${canonical({ version: "eth40-evidence-v1", kind, payload })}\n`, id = sha(raw);
    const file = join(this.root, "evidence", `${id}.json`);
    if (await absent(file)) await durableSpotFile(file, raw, false);
    else if (await bytes(file) !== raw) throw new Error("ETH40_STORE_EVIDENCE_HASH_MISMATCH");
    this.verifiedEvidence.add(id);
    return id;
  }
  evidence(kind: string, payload: unknown): Promise<string> {
    const saved = copy(payload);
    return this.queued(() => this.saveEvidence(kind, saved));
  }
  private async restoreHistories(market: MarketEvidence): Promise<Histories> {
    if (!Array.isArray(market.evidenceIds) || !market.evidenceIds.every(id => typeof id === "string")
      || !object(market.historyEvidence)) throw new Error("ETH40_STORE_INVALID_MARKET_EVIDENCE");
    for (const id of market.evidenceIds) await this.verifyEvidence(id);
    const histories = {} as Histories;
    for (const symbol of ASSETS) {
      const id = market.historyEvidence[symbol];
      if (this.historyReferences[symbol] === id && this.eventHistories) histories[symbol] = this.eventHistories[symbol];
      else {
        const evidence = await this.verifyEvidence(id, true);
        if (!evidence || evidence.kind !== "market-history" || !object(evidence.payload)
          || evidence.payload.symbol !== symbol || !Array.isArray(evidence.payload.bars)) throw new Error("ETH40_STORE_INVALID_HISTORY_EVIDENCE");
        histories[symbol] = evidence.payload.bars as DailyBar[];
      }
    }
    return freeze(histories);
  }
  private acceptHistories(histories: Histories, references: Record<Asset, string>): void {
    this.eventHistories = histories;
    this.historyReferences = references;
    // Empty histories faithfully describe a failed market snapshot, not deletion of the last verified archive.
    if (this.histories || ASSETS.some(symbol => histories[symbol].length > 0)) {
      this.histories = freeze(Object.fromEntries(ASSETS.map(symbol =>
        [symbol, histories[symbol].length ? histories[symbol] : this.histories?.[symbol] ?? []])) as Histories);
    }
  }
  private async writeHead(sequence: number, hash: string): Promise<void> {
    await durableSpotFile(join(this.root, "head.json"), `${canonical({ version: "eth40-head-v1", sequence, hash })}\n`, false);
  }
  private async commit(event: Event): Promise<string> {
    const hash = sha(canonical(event)), file = join(this.root, "events", filename(event.sequence));
    if (!await absent(file)) throw new Error("ETH40_STORE_EVENT_ALREADY_EXISTS");
    await durableSpotFile(file, `${canonical({ hash, event })}\n`, false);
    // Events are authoritative. A stale head is recoverable; a missing committed tail is not.
    await this.writeHead(event.sequence, hash);
    this.currentState = freeze(event.state);
    this.currentSequence = event.sequence;
    this.currentHash = hash;
    return hash;
  }
  appendCycle(input: { market: MarketSnapshot; result: CycleResult }): Promise<void> {
    const saved = copy(input);
    return this.queued(async () => {
      validateTransition(this.currentState, saved.market, saved.result);
      const { histories, ...snapshot } = saved.market;
      const historyEvidence = {} as Record<Asset, string>;
      for (const symbol of ASSETS) historyEvidence[symbol] = await this.saveEvidence("market-history", { symbol, bars: histories[symbol] });
      const market: MarketEvidence = { ...snapshot, historyEvidence };
      const restored = await this.restoreHistories(market);
      await this.commit({ version: "eth40-event-v1", sequence: this.currentSequence + 1, kind: "cycle",
        previousHash: this.currentHash, beforeStateHash: stateHash(this.currentState), manifestHash: this.manifestHash,
        state: saved.result.state, market, decisions: saved.result.decisions, valuations: saved.result.valuations });
      this.acceptHistories(restored, market.historyEvidence);
    });
  }
  async restore(createInitialState: () => PaperState): Promise<void> {
    const names = await readdir(join(this.root, "events"));
    if (names.some(name => !EVENT_FILE.test(name) && !PENDING_FILE.test(name))) throw new Error("ETH40_STORE_UNEXPECTED_EVENT_FILE");
    const events = names.filter(name => EVENT_FILE.test(name)).sort();
    let head: Head | null = null;
    try { head = parseCanonical<Head>(await bytes(join(this.root, "head.json"))); } catch (error) { if (!missing(error)) throw error; }
    if (head && (head.version !== "eth40-head-v1" || !Number.isSafeInteger(head.sequence) || head.sequence < 1 || !HASH.test(head.hash)))
      throw new Error("ETH40_STORE_INVALID_HEAD");
    if (!events.length) {
      if (head) throw new Error("ETH40_STORE_COMMITTED_EVENTS_MISSING");
      const state = copy(createInitialState());
      validateGenesis(state);
      await this.commit({ version: "eth40-event-v1", sequence: 1, kind: "genesis", previousHash: null,
        beforeStateHash: null, manifestHash: this.manifestHash, manifest: this.manifest, state });
      return;
    }
    let headMatched = head === null;
    for (let index = 0; index < events.length; index++) {
      if (events[index] !== filename(index + 1)) throw new Error("ETH40_STORE_EVENT_SEQUENCE_GAP");
      const envelope = parseCanonical<Envelope>(await bytes(join(this.root, "events", events[index]!)));
      if (!object(envelope) || !object(envelope.event)) throw new Error("ETH40_STORE_INVALID_EVENT");
      const event = envelope.event;
      if (!HASH.test(envelope.hash) || envelope.hash !== sha(canonical(event)) || event.version !== "eth40-event-v1"
        || event.sequence !== index + 1 || event.manifestHash !== this.manifestHash
        || event.previousHash !== (index === 0 ? null : this.currentHash)) throw new Error("ETH40_STORE_EVENT_CHAIN_MISMATCH");
      if (index === 0) {
        if (event.kind !== "genesis" || event.beforeStateHash !== null || !same(event.manifest, this.manifest))
          throw new Error("ETH40_STORE_MANIFEST_OR_GENESIS_MISMATCH");
        validateGenesis(event.state);
      } else {
        if (event.kind !== "cycle" || event.beforeStateHash !== stateHash(this.currentState)) throw new Error("ETH40_STORE_PREVIOUS_STATE_MISMATCH");
        validateTransition(this.currentState, event.market, { state: event.state, decisions: event.decisions, valuations: event.valuations });
        this.acceptHistories(await this.restoreHistories(event.market), event.market.historyEvidence);
      }
      this.currentState = freeze(event.state); this.currentSequence = event.sequence; this.currentHash = envelope.hash;
      if (head?.sequence === event.sequence) {
        if (head.hash !== envelope.hash) throw new Error("ETH40_STORE_HEAD_CHAIN_MISMATCH");
        headMatched = true;
      }
    }
    if (!headMatched) throw new Error("ETH40_STORE_COMMITTED_EVENTS_MISSING");
    if (!head || head.sequence !== this.currentSequence) await this.writeHead(this.currentSequence, this.currentHash);
  }
  close(): Promise<void> {
    if (!this.closing) this.closing = this.tail.then(() => this.release());
    return this.closing;
  }
}

/** A single locked hash-chain journal. The head detects lost suffixes but cannot defeat rollback of the whole directory. */
export async function openEth40Store(root: string, manifest: unknown, createInitialState: () => PaperState): Promise<Eth40Store> {
  const location = resolve(root), frozenManifest = freeze(copy(manifest));
  await directory(location);
  const release = await acquireSpotPaperLock(location);
  try {
    await directory(join(location, "events")); await directory(join(location, "evidence"));
    await syncDirectory(location); await syncDirectory(resolve(location, ".."));
    const store = new Store(location, frozenManifest, release);
    await store.restore(createInitialState);
    return store;
  } catch (error) { await release(); throw error; }
}
