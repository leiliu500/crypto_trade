import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { projectSpotOrderActivity, type SpotCommittedActivityCycle, type SpotPositionActivity } from "./spot-position-activity.js";

type State = Parameters<typeof projectSpotOrderActivity>[0];
type Row = Record<string, unknown>;
interface Proof { file: string; sha256: string }
interface Envelope { version: string; state: State; lastEvidence: Proof | null; receiptEvidence: Record<string, Proof>;
  migrationEvidence?: Proof; runtimeUpgradeEvidence?: Proof }
export interface SpotPagedActivity extends SpotPositionActivity { totalEvents: number; nextCursor: string | null }
export interface SpotActivitySnapshot { available: boolean; error?: string; sourceCycle: number | null;
  sourceTimestampMs: number | null; orders: Record<string, SpotPagedActivity> }
export interface SpotActivityPage { available: boolean; error?: string; activity?: SpotPagedActivity;
  sourceCycle?: number; sourceTimestampMs?: number }
interface CachedNode {
  file: string; signature: string; sha256: string; beforeHash: string; afterHash: string;
  beforeCycle: number; beforeTimestampMs: number; beforeStartedAtMs: number;
  afterCycle: number; afterTimestampMs: number; afterStartedAtMs: number;
  afterPending: boolean; compact: SpotCommittedActivityCycle | null; previous: Proof | null;
}
interface CachedProjection { journalSha256: string; state: State; orders: Record<string, SpotPositionActivity>;
  dependencies: Set<string>; dependencyFiles: string[] }
interface Budget { bytes: number; deadlineMs: number; dependencies: Set<string> }

const JOURNAL_BYTES = 2 * 1024 * 1024, CYCLE_BYTES = 8 * 1024 * 1024, CHUNK_BYTES = 64 * 1024 * 1024;
const MAXIMUM_DIRECTORY_FILES = 200_000, MAXIMUM_CHAIN_NODES = 100_000;
const CYCLE_NAME = /^(\d+)-(\d+)(?:-(submitted|settled))?\.json$/;
const PROOF_PATH = /^(?:cycles\/\d+-\d+(?:-(?:submitted|settled))?|(?:migrations|runtime-upgrades)\/[a-f0-9]{64})\.json$/;
const HASH = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const stateHash = (value: unknown): string => hash(canonical(value));
function fail(code: string): never { throw new Error(code); }
function proof(value: unknown): Proof {
  if (!object(value) || typeof value.file !== "string" || !PROOF_PATH.test(value.file)
    || typeof value.sha256 !== "string" || !HASH.test(value.sha256)) fail("SPOT_ACTIVITY_INVALID_PROOF");
  return { file: value.file, sha256: value.sha256 };
}
function compactState(value: unknown): SpotCommittedActivityCycle["before"] {
  if (!object(value) || !object(value.account) || !integer(value.startedAtMs) || !integer(value.lastCycleMs)
    || !integer(value.cycles)) fail("SPOT_ACTIVITY_INVALID_CYCLE_STATE");
  const account = value.account;
  const fields = ["initialCashUsd", "cashUsd", "quantity", "entryCostUsd", "realizedNetUsd", "feesUsd"] as const;
  if (fields.some(key => typeof account[key] !== "number" || !Number.isFinite(account[key])))
    fail("SPOT_ACTIVITY_INVALID_CYCLE_ACCOUNT");
  return { startedAtMs: value.startedAtMs, lastCycleMs: value.lastCycleMs, cycles: value.cycles,
    account: Object.fromEntries(fields.map(key => [key, account[key]])) as SpotCommittedActivityCycle["before"]["account"] };
}
function errorCode(error: unknown): string {
  return error instanceof Error && /^SPOT_ACTIVITY_[A-Z_]+$/.test(error.message) ? error.message : "SPOT_ACTIVITY_UNAVAILABLE";
}
async function parallelFour<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) { const item = items[next++]!; await task(item); }
  }));
}

/** Read-only projection of committed paper evidence. Directory orphans never become fills or activity. */
export class SpotPaperActivityReader {
  private readonly root: string;
  private resolvedRoot: string | undefined;
  private readonly nodes = new Map<string, CachedNode>();
  private projection: CachedProjection | undefined;
  private loading: Promise<CachedProjection> | undefined;
  private revalidationCursor = 0;
  private directoryIndex: { signature: string; entries: Map<string, string[]> } | undefined;

  public constructor(options: { root?: string } = {}) {
    this.root = resolve(options.root ?? process.env.SPOT_PAPER_JOURNAL_DIRECTORY ?? "/app/spot-paper-data");
  }

  public async snapshot(expectedState: unknown): Promise<SpotActivitySnapshot> {
    try {
      const current = await this.load(expectedState);
      if (!isDeepStrictEqual(current.state, expectedState)) fail("SPOT_ACTIVITY_STATUS_MISMATCH");
      const orders: Record<string, SpotPagedActivity> = Object.create(null);
      for (const [id, activity] of Object.entries(current.orders)) orders[id] = this.paginate(activity, null, 30);
      return { available: true, sourceCycle: current.state.cycles, sourceTimestampMs: current.state.lastCycleMs, orders };
    } catch (error) { return { available: false, error: errorCode(error), sourceCycle: null, sourceTimestampMs: null, orders: {} }; }
  }

  public async page(orderId: string, before: string | null): Promise<SpotActivityPage> {
    try {
      if (typeof orderId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,239}$/.test(orderId)
        || before !== null && (typeof before !== "string" || before.length === 0 || before.length > 512 || /[\x00-\x20/\\]/.test(before)))
        fail("SPOT_ACTIVITY_INVALID_QUERY");
      const current = await this.load(), activity = Object.hasOwn(current.orders, orderId) ? current.orders[orderId] : undefined;
      if (!activity) fail("SPOT_ACTIVITY_ORDER_UNAVAILABLE");
      return { available: true, sourceCycle: current.state.cycles, sourceTimestampMs: current.state.lastCycleMs,
        activity: this.paginate(activity, before, 50) };
    } catch (error) { return { available: false, error: errorCode(error) }; }
  }

  private paginate(activity: SpotPositionActivity, before: string | null, count: number): SpotPagedActivity {
    const descending = [...activity.events].reverse();
    const offset = before === null ? 0 : descending.findIndex(event => event.id === before) + 1;
    if (before !== null && offset === 0) fail("SPOT_ACTIVITY_CURSOR_UNKNOWN");
    const events = descending.slice(offset, offset + count);
    return { ...activity, events, totalEvents: descending.length,
      nextCursor: offset + events.length < descending.length ? events.at(-1)!.id : null };
  }

  private async path(file: string): Promise<string> {
    this.resolvedRoot ??= await realpath(this.root);
    const path = join(this.resolvedRoot, file), actual = await realpath(path);
    if (!actual.startsWith(`${this.resolvedRoot}${sep}`) || actual !== path) fail("SPOT_ACTIVITY_UNSAFE_PATH");
    return path;
  }

  private async signature(file: string): Promise<{ path: string; signature: string; size: number }> {
    const path = await this.path(file), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) fail("SPOT_ACTIVITY_UNSAFE_PATH");
    return { path, signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`, size: info.size };
  }

  private async bytes(file: string, maximum: number): Promise<{ bytes: Buffer; signature: string }> {
    const initial = await this.signature(file);
    if (initial.size > maximum) fail("SPOT_ACTIVITY_FILE_LIMIT");
    const handle = await open(initial.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > maximum) fail("SPOT_ACTIVITY_FILE_LIMIT");
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) fail("SPOT_ACTIVITY_FILE_CHANGED");
        offset += read.bytesRead;
      }
      const after = await handle.stat();
      const signature = `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`;
      if (signature !== initial.signature) fail("SPOT_ACTIVITY_FILE_CHANGED");
      return { bytes, signature };
    } finally { await handle.close(); }
  }

  private async node(file: string, budget: Budget, expectedSha?: string, revalidate = false): Promise<CachedNode> {
    if (!PROOF_PATH.test(file)) fail("SPOT_ACTIVITY_INVALID_PROOF");
    budget.dependencies.add(file);
    const old = this.nodes.get(file);
    // Old holding documents are revalidated in bounded rotating batches. Head/fill
    // anchors always pass an expected hash and are checked on every request.
    if (old && expectedSha === undefined && !revalidate) return old;
    const current = await this.signature(file);
    if (old && old.signature === current.signature) {
      if (expectedSha && old.sha256 !== expectedSha) fail("SPOT_ACTIVITY_PROOF_CHANGED");
      return old;
    }
    if (current.size > CYCLE_BYTES) fail("SPOT_ACTIVITY_FILE_LIMIT");
    if (budget.bytes + current.size > CHUNK_BYTES || Date.now() > budget.deadlineMs) fail("SPOT_ACTIVITY_HISTORY_LOADING");
    budget.bytes += current.size;
    const loaded = await this.bytes(file, CYCLE_BYTES), digest = hash(loaded.bytes);
    if (expectedSha && digest !== expectedSha) fail("SPOT_ACTIVITY_PROOF_CHANGED");
    if (old && digest !== old.sha256) fail("SPOT_ACTIVITY_HISTORY_CHANGED");
    if (old) { old.signature = loaded.signature; return old; }
    if (this.nodes.size >= MAXIMUM_CHAIN_NODES + 1_000) fail("SPOT_ACTIVITY_HISTORY_LIMIT");
    const row: unknown = JSON.parse(loaded.bytes.toString("utf8"));
    if (!object(row) || !object(row.before) || !object(row.after)) fail("SPOT_ACTIVITY_INVALID_CYCLE");
    const before = compactState(row.before), after = compactState(row.after);
    if (before.startedAtMs !== after.startedAtMs || after.lastCycleMs < before.lastCycleMs) fail("SPOT_ACTIVITY_INVALID_CYCLE");
    let compact: SpotCommittedActivityCycle | null = null, previous: Proof | null = null;
    if (file.startsWith("cycles/")) {
      const match = CYCLE_NAME.exec(file.slice(7));
      if (!match || Number(match[1]) !== after.cycles || Number(match[2]) !== after.lastCycleMs
        || row.recordedAtMs !== after.lastCycleMs || !object(row.decision)
        || !isDeepStrictEqual(row.decision, row.after.lastDecision)) fail("SPOT_ACTIVITY_INVALID_CYCLE");
      if (row.phase === "BROKER_SETTLEMENT") {
        if (match[3] !== "settled" || after.cycles !== before.cycles) fail("SPOT_ACTIVITY_INVALID_SETTLEMENT");
        previous = proof(row.submittedEvidence);
      } else if (match[3] === "settled" || after.cycles !== before.cycles + 1) fail("SPOT_ACTIVITY_INVALID_CYCLE");
      const market = object(row.market) ? row.market : null, book = market && object(market.book) ? market.book : null;
      compact = { before, after, decision: row.decision as unknown as SpotCommittedActivityCycle["decision"], recordedAtMs: after.lastCycleMs,
        ...(typeof row.phase === "string" ? { phase: row.phase } : {}),
        ...(book && Array.isArray(book.bids) && integer(book.receivedAtMs) ? { market: { book: {
          bids: book.bids.slice(0, 1) as [number, number][], receivedAtMs: book.receivedAtMs } } } : {}) };
    } else {
      if (row.accountChanged !== false || !["spot-paper-order-migration-v1", "spot-paper-runtime-upgrade-v1"].includes(String(row.version))
        || !isDeepStrictEqual({ ...row.before, version: row.after.version,
          ...(row.version === "spot-paper-order-migration-v1" ? { orders: [] } : {}) }, row.after))
        fail("SPOT_ACTIVITY_INVALID_MIGRATION");
      if (row.previousEvidence !== null) previous = proof(row.previousEvidence);
    }
    const node: CachedNode = { file, signature: loaded.signature, sha256: digest,
      beforeHash: stateHash(row.before), afterHash: stateHash(row.after), beforeCycle: before.cycles,
      beforeTimestampMs: before.lastCycleMs, beforeStartedAtMs: before.startedAtMs,
      afterCycle: after.cycles, afterTimestampMs: after.lastCycleMs, afterStartedAtMs: after.startedAtMs,
      afterPending: Array.isArray(row.after.orders) && row.after.orders.some(order => object(order)
        && ["SUBMITTED", "ACCEPTED"].includes(String(order.status))), compact, previous };
    this.nodes.set(file, node);
    return node;
  }

  private async referenced(reference: Proof, budget: Budget): Promise<CachedNode> {
    const checked = proof(reference), node = await this.node(checked.file, budget, checked.sha256);
    if (node.compact?.phase === "BROKER_SETTLEMENT") {
      const submitted = await this.node(node.previous!.file, budget, node.previous!.sha256);
      if (!submitted.afterPending || submitted.afterHash !== node.beforeHash) fail("SPOT_ACTIVITY_SUBMISSION_MISMATCH");
    }
    return node;
  }

  private async index(): Promise<Map<string, string[]>> {
    this.resolvedRoot ??= await realpath(this.root);
    const directory = join(this.resolvedRoot, "cycles");
    if (await realpath(directory) !== directory) fail("SPOT_ACTIVITY_UNSAFE_PATH");
    const info = await lstat(directory), signature = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}`;
    if (this.directoryIndex?.signature === signature) return this.directoryIndex.entries;
    const handle = await opendir(directory), result = new Map<string, string[]>();
    let count = 0;
    for await (const entry of handle) {
      if (++count > MAXIMUM_DIRECTORY_FILES) fail("SPOT_ACTIVITY_HISTORY_LIMIT");
      const match = CYCLE_NAME.exec(entry.name); if (!match) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) fail("SPOT_ACTIVITY_UNSAFE_PATH");
      const key = `${Number(match[1])}:${Number(match[2])}`, files = result.get(key) ?? [];
      files.push(`cycles/${entry.name}`); result.set(key, files);
    }
    this.directoryIndex = { signature, entries: result };
    return result;
  }

  private async revalidateHistory(budget: Budget): Promise<void> {
    const files = this.projection?.dependencyFiles ?? [...this.nodes.keys()];
    const count = Math.min(128, files.length);
    const batch = Array.from({ length: count }, () => files[this.revalidationCursor++ % files.length]!);
    await parallelFour(batch, async file => { await this.node(file, budget, undefined, true); });
  }

  private async load(expected?: unknown): Promise<CachedProjection> {
    if (this.loading) return this.loading;
    this.loading = this.build(expected).finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async build(expected?: unknown): Promise<CachedProjection> {
    const journal = await this.bytes("state.json", JOURNAL_BYTES), digest = hash(journal.bytes);
    const envelope = JSON.parse(journal.bytes.toString("utf8")) as Envelope;
    if (envelope.version !== "spot-paper-journal-v1" || !object(envelope.state) || !object(envelope.receiptEvidence)
      || !Array.isArray(envelope.state.orders) || !Array.isArray(envelope.state.account?.receipts)) fail("SPOT_ACTIVITY_INVALID_JOURNAL");
    if (expected !== undefined && !isDeepStrictEqual(envelope.state, expected)) fail("SPOT_ACTIVITY_STATUS_MISMATCH");
    const budget: Budget = { bytes: 0, deadlineMs: Date.now() + 1_500, dependencies: new Set() };
    await this.revalidateHistory(budget);
    let anchor: CachedNode | null = null;
    if (envelope.lastEvidence) {
      anchor = await this.referenced(envelope.lastEvidence, budget);
      if (anchor.afterHash !== stateHash(envelope.state)) fail("SPOT_ACTIVITY_ANCHOR_MISMATCH");
    } else if (envelope.state.cycles !== 0) fail("SPOT_ACTIVITY_MISSING_ANCHOR");
    if (Object.keys(envelope.receiptEvidence).length !== envelope.state.account.receipts.length) fail("SPOT_ACTIVITY_RECEIPT_PROOF_MISMATCH");
    await parallelFour(envelope.state.account.receipts, async fill => {
      const reference = envelope.receiptEvidence[fill.id]; if (!reference) fail("SPOT_ACTIVITY_RECEIPT_PROOF_MISSING");
      const node = await this.referenced(reference, budget);
      if (node.compact?.phase !== "BROKER_SETTLEMENT" || !isDeepStrictEqual(node.compact.decision.fill, fill))
        fail("SPOT_ACTIVITY_RECEIPT_PROOF_MISMATCH");
    });
    const migrations = await Promise.all([envelope.migrationEvidence, envelope.runtimeUpgradeEvidence]
      .filter((reference): reference is Proof => reference !== undefined).map(reference => this.referenced(reference, budget)));
    if (this.projection?.journalSha256 === digest) return this.projection;
    const preliminary = projectSpotOrderActivity(envelope.state, []);
    const selected = [...envelope.state.orders].sort((a, b) => b.request.createdAtMs - a.request.createdAtMs).slice(0, 20);
    let fromMs = Infinity;
    for (const order of selected) {
      fromMs = Math.min(fromMs, order.request.createdAtMs);
      const entryId = preliminary[order.orderId]?.entryOrderId;
      const entry = entryId ? envelope.state.orders.find(candidate => candidate.orderId === entryId) : undefined;
      if (entry) fromMs = Math.min(fromMs, entry.request.createdAtMs);
    }
    const cycles: SpotCommittedActivityCycle[] = [], visited = new Set<string>();
    const index = anchor && Number.isFinite(fromMs) ? await this.index() : new Map<string, string[]>();
    budget.deadlineMs = Date.now() + 1_500;
    while (anchor && Number.isFinite(fromMs)) {
      if (visited.has(anchor.file) || visited.size >= MAXIMUM_CHAIN_NODES) fail("SPOT_ACTIVITY_HISTORY_LIMIT");
      visited.add(anchor.file);
      if (anchor.compact && anchor.afterTimestampMs >= fromMs) cycles.push(anchor.compact);
      if (anchor.beforeTimestampMs < fromMs) break;
      if (anchor.previous) {
        const previous = await this.referenced(anchor.previous, budget);
        if (previous.afterHash !== anchor.beforeHash) fail("SPOT_ACTIVITY_HISTORY_MISMATCH");
        anchor = previous; continue;
      }
      const candidates: CachedNode[] = [];
      for (const migration of migrations) if (migration.afterHash === anchor.beforeHash) candidates.push(migration);
      const files = index.get(`${anchor.beforeCycle}:${anchor.beforeTimestampMs}`) ?? [];
      await parallelFour(files, async file => {
        const candidate = await this.node(file, budget);
        if (candidate.afterHash === anchor!.beforeHash) candidates.push(candidate);
      });
      if (!candidates.length) fail("SPOT_ACTIVITY_HISTORY_MISSING");
      if (candidates.length !== 1) fail("SPOT_ACTIVITY_HISTORY_AMBIGUOUS");
      anchor = candidates[0]!;
    }
    const all = projectSpotOrderActivity(envelope.state, cycles.reverse()), orders: Record<string, SpotPositionActivity> = Object.create(null);
    for (const selectedOrder of selected) {
      const activity = all[selectedOrder.orderId]; if (!activity) continue;
      if (new Set(activity.events.map(event => event.id)).size !== activity.events.length) fail("SPOT_ACTIVITY_DUPLICATE_EVENT");
      orders[selectedOrder.orderId] = activity;
    }
    const result: CachedProjection = { journalSha256: digest, state: envelope.state, orders, dependencies: budget.dependencies,
      dependencyFiles: [...budget.dependencies] };
    this.projection = result;
    return result;
  }
}
