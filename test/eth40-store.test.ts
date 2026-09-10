import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createPaperState, ETH40_HISTORY_ANCHOR_MS, runPaperCycle } from "../src/eth40/engine.js";
import { DAY_MS } from "../src/eth40/spec.js";
import { openEth40Store, type Eth40Store } from "../src/eth40/store.js";
import type { Asset, DailyBar, MarketSnapshot, PaperState, VerifiedBook } from "../src/eth40/types.js";

const START = ETH40_HISTORY_ANCHOR_MS + 100 * DAY_MS + DAY_MS / 2;
const EXECUTION = Math.floor(START / DAY_MS) * DAY_MS + 2 * DAY_MS + 1_000;
const MANIFEST = { version: "eth40-store-test", policy: "frozen", liveTradingEnabled: false };
const eventFile = (root: string, sequence: number) => join(root, "events", `${String(sequence).padStart(12, "0")}.json`);

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eth40-store-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function opened(root: string, t: TestContext): Promise<Eth40Store> {
  const store = await openEth40Store(root, MANIFEST, () => createPaperState(START));
  t.after(() => store.close());
  return store;
}
function market(observedAtMs = EXECUTION): MarketSnapshot {
  const bars: DailyBar[] = Array.from({ length: 101 }, (_, i) => {
    const close = i < 95 ? 100 : 150;
    return { openTimeMs: ETH40_HISTORY_ANCHOR_MS + i * DAY_MS, open: close, high: close + 1,
      low: close - 1, close, volume: 10_000 };
  });
  const book = (symbol: Asset): VerifiedBook => ({ symbol, bids: [[149, 1_000]], asks: [[150, 1_000]],
    receivedAtMs: observedAtMs, exchangeUpdateAtMs: observedAtMs, connectionId: "test-session",
    checksum: "123", checksumValid: true });
  const rule = { lotSize: 1e-8, minimumQuantity: .00001, minimumNotionalUsd: .5, tickSize: .01 };
  return { observedAtMs, histories: { "ETH/USD": bars, "BTC/USD": structuredClone(bars) },
    books: { "ETH/USD": book("ETH/USD"), "BTC/USD": book("BTC/USD") },
    rules: { "ETH/USD": rule, "BTC/USD": { ...rule } }, rulesFetchedAtMs: observedAtMs,
    rulesFetchedAtMsByAsset: { "ETH/USD": observedAtMs, "BTC/USD": observedAtMs }, errors: [], evidenceIds: [] };
}
async function cycle(store: Eth40Store, snapshot = market()): Promise<void> {
  await store.appendCycle({ market: snapshot, result: runPaperCycle(store.state, snapshot, "test-cycle") });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
async function resignLastEvent(root: string, sequence: number, change: (event: Record<string, any>) => void): Promise<void> {
  const file = eventFile(root, sequence), envelope = JSON.parse(await readFile(file, "utf8"));
  change(envelope.event);
  envelope.hash = createHash("sha256").update(canonical(envelope.event)).digest("hex");
  await writeFile(file, canonical(envelope) + "\n");
  await writeFile(join(root, "head.json"), canonical({ version: "eth40-head-v1", sequence, hash: envelope.hash }) + "\n");
}

test("ETH40 genesis binds a canonical manifest and restores without creating a new account", async t => {
  const root = await temporary(t), store = await opened(root, t);
  assert.equal(store.sequence, 1);
  assert.match(store.lastHash, /^[a-f0-9]{64}$/);
  assert.equal(store.latestMarketHistories, null);
  const originalHash = store.lastHash;
  await store.close();
  const restored = await openEth40Store(root, { liveTradingEnabled: false, policy: "frozen", version: "eth40-store-test" },
    () => { throw new Error("must not reset existing experiment"); });
  assert.equal(restored.sequence, 1);
  assert.equal(restored.lastHash, originalHash);
  assert.deepEqual(restored.state, createPaperState(START));
  await restored.close();
  await assert.rejects(openEth40Store(root, { ...MANIFEST, policy: "retuned" }, () => createPaperState(START)),
    /ETH40_STORE_EVENT_CHAIN_MISMATCH|ETH40_STORE_MANIFEST/);
  assert.equal((await readdir(join(root, "events"))).length, 1);
});

test("ETH40 kernel lock excludes a second writer and close is idempotent", async t => {
  const root = await temporary(t), store = await opened(root, t);
  await assert.rejects(openEth40Store(root, MANIFEST, () => createPaperState(START)), /LOCK_UNAVAILABLE/);
  await Promise.all([store.close(), store.close()]);
  await assert.rejects(store.evidence("after-close", {}), /ETH40_STORE_CLOSED/);
  const next = await opened(root, t);
  assert.equal(next.sequence, 1);
});

test("ETH40 cycles persist receipt-backed fills with compact deduplicated histories and complete market metadata", async t => {
  const root = await temporary(t), store = await opened(root, t), snapshot = market();
  const source = await store.evidence("raw-market-source", { raw: "unchanged bytes", receivedAtMs: EXECUTION });
  assert.equal(await store.evidence("raw-market-source", { receivedAtMs: EXECUTION, raw: "unchanged bytes" }), source);
  snapshot.evidenceIds = [source];
  await cycle(store, snapshot);
  assert.equal(store.sequence, 2);
  for (const p of Object.values(store.state.portfolios)) assert.equal(p.account.receipts.length, 1);
  const first = JSON.parse(await readFile(eventFile(root, 2), "utf8"));
  assert.equal(first.event.market.histories, undefined);
  assert.deepEqual(first.event.market.rulesFetchedAtMsByAsset, snapshot.rulesFetchedAtMsByAsset);
  assert.deepEqual(first.event.market.books, snapshot.books);
  assert.deepEqual(first.event.market.evidenceIds, [source]);
  const next = market(EXECUTION + 1_000); next.evidenceIds = [source];
  await cycle(store, next);
  assert.equal((await readdir(join(root, "evidence"))).length, 3, "one raw source and one history per asset");
  const expected = structuredClone(store.state), lastHash = store.lastHash;
  await store.close();
  const recovered = await opened(root, t);
  assert.deepEqual(recovered.state, expected);
  assert.equal(recovered.lastHash, lastHash);
  assert.equal(recovered.sequence, 3);
  assert.deepEqual(recovered.latestMarketHistories, snapshot.histories);
  assert.throws(() => { recovered.state.portfolios.eth40.account.cashUsd = 1_000_000; }, TypeError);
});

test("ETH40 failed history cycles retain each last nonempty archive across restart", async t => {
  const root = await temporary(t), store = await opened(root, t), first = market();
  await cycle(store, first);
  const failed = market(EXECUTION + 1_000);
  failed.histories = { "ETH/USD": [], "BTC/USD": [] }; failed.errors = ["history refresh failed"];
  await cycle(store, failed);
  assert.deepEqual(store.latestMarketHistories, first.histories);
  const event = JSON.parse(await readFile(eventFile(root, 3), "utf8"));
  const evidence = JSON.parse(await readFile(join(root, "evidence", `${event.event.market.historyEvidence["ETH/USD"]}.json`), "utf8"));
  assert.deepEqual(evidence.payload.bars, [], "failed snapshot remains empty in its own evidence");
  await store.close();
  const restored = await opened(root, t);
  assert.deepEqual(restored.latestMarketHistories, first.histories);
});

test("ETH40 committed event survives a head-write failure before the in-memory state advances", async t => {
  const root = await temporary(t), store = await opened(root, t);
  const oldHead = await readFile(join(root, "head.json"), "utf8");
  await rm(join(root, "head.json")); await mkdir(join(root, "head.json"));
  await assert.rejects(cycle(store), /EISDIR|ENOTEMPTY/);
  assert.equal(store.sequence, 1, "failed append has not exposed its next in-memory account");
  assert.ok((await readdir(join(root, "events"))).includes("000000000002.json"), "durable event is already committed");
  await assert.rejects(store.evidence("after-failure", {}), /REOPEN_REQUIRED/);
  await store.close();
  await rm(join(root, "head.json"), { recursive: true }); await writeFile(join(root, "head.json"), oldHead);
  const pendingFile = join(root, "events", "000000000003.json.pending-00000000-0000-4000-8000-000000000000");
  await writeFile(pendingFile, '{"torn":');
  const recovered = await opened(root, t);
  assert.equal(recovered.sequence, 2);
  assert.equal(recovered.state.portfolios.eth40.account.receipts.length, 1);
  assert.equal(JSON.parse(await readFile(join(root, "head.json"), "utf8")).sequence, 2);
  await cycle(recovered, market(EXECUTION + 1_000));
  assert.equal(recovered.state.portfolios.eth40.account.receipts.length, 1, "recovery cannot apply a second debit");
  assert.equal(await readFile(pendingFile, "utf8"), '{"torn":');
});

test("ETH40 lost suffix and sequence holes cannot silently restore stale account balances", async t => {
  for (const missingSequence of [2, 3]) {
    const root = await temporary(t), store = await opened(root, t);
    await cycle(store); await cycle(store, market(EXECUTION + 1_000)); await store.close();
    await rm(eventFile(root, missingSequence));
    await assert.rejects(openEth40Store(root, MANIFEST, () => { throw new Error("never reset missing events"); }),
      /ETH40_STORE_EVENT_SEQUENCE_GAP|ETH40_STORE_COMMITTED_EVENTS_MISSING/);
  }
  const root = await temporary(t), store = await opened(root, t); await store.close();
  await rm(eventFile(root, 1));
  await assert.rejects(openEth40Store(root, MANIFEST, () => createPaperState(START)), /COMMITTED_EVENTS_MISSING/);
});

test("ETH40 malformed committed events and altered source evidence fail startup", async t => {
  const root = await temporary(t), store = await opened(root, t);
  const source = await store.evidence("source", { raw: "original" });
  const snapshot = market(); snapshot.evidenceIds = [source]; await cycle(store, snapshot); await store.close();
  const sourcePath = join(root, "evidence", `${source}.json`), original = await readFile(sourcePath, "utf8");
  await writeFile(sourcePath, original.replace("original", "altered"));
  await assert.rejects(openEth40Store(root, MANIFEST, () => createPaperState(START)), /EVIDENCE_HASH_MISMATCH/);
  await writeFile(sourcePath, original);
  const event = await readFile(eventFile(root, 2), "utf8");
  await writeFile(eventFile(root, 2), event.slice(0, -20));
  await assert.rejects(openEth40Store(root, MANIFEST, () => createPaperState(START)), /JSON|Unterminated|Expected/);
});

test("ETH40 checks receipt correspondence even when altered events and their head are consistently rehashed", async t => {
  const root = await temporary(t), store = await opened(root, t); await cycle(store); await store.close();
  await resignLastEvent(root, 2, event => {
    event.decisions[0].fill = null; event.decisions[0].orderId = null; event.decisions[0].action = "hold";
  });
  await assert.rejects(openEth40Store(root, MANIFEST, () => createPaperState(START)), /FILL_WITHOUT_DECISION/);
});

test("ETH40 prior drawdown cannot be reset in a later event with unchanged valid receipts", async t => {
  const root = await temporary(t), store = await opened(root, t);
  await cycle(store); await cycle(store, market(EXECUTION + 1_000));
  assert.ok(store.state.portfolios.eth40.maxDrawdownUsd > 0);
  await store.close();
  await resignLastEvent(root, 3, event => { event.state.portfolios.eth40.maxDrawdownUsd = 0; });
  await assert.rejects(openEth40Store(root, MANIFEST, () => createPaperState(START)), /RECORDED_RISK_DECREASED/);
});

test("ETH40 invalid cycle evidence cannot append an unaccounted fill or refer to missing source bytes", async t => {
  const root = await temporary(t), store = await opened(root, t), snapshot = market();
  const result = runPaperCycle(store.state, snapshot, "invalid-decision");
  result.decisions[0]!.orderId = "different-order";
  await assert.rejects(store.appendCycle({ market: snapshot, result }), /DECISION_RECEIPT_MISMATCH/);
  assert.equal((await readdir(join(root, "events"))).length, 1);
  await store.close();
  const restored = await opened(root, t);
  snapshot.evidenceIds = ["a".repeat(64)];
  await assert.rejects(cycle(restored, snapshot), /ENOENT/);
  assert.equal(restored.sequence, 1);
  assert.equal(restored.state.portfolios.eth40.account.receipts.length, 0);
});

test("ETH40 captures append inputs before asynchronous writes and rejects lossy JSON", async t => {
  const root = await temporary(t), store = await opened(root, t), snapshot = market();
  const result = structuredClone(runPaperCycle(store.state, snapshot, "capture-input"));
  const expected = structuredClone(result.state);
  const pending = store.appendCycle({ market: snapshot, result });
  result.state.portfolios.eth40.account.cashUsd = 1_000_000;
  snapshot.histories["ETH/USD"] = [];
  await pending;
  assert.deepEqual(store.state, expected);
  assert.equal(store.latestMarketHistories?.["ETH/USD"].length, 101);
  assert.throws(() => store.evidence("lossy", { n: Number.NaN }), /INVALID_JSON/);
  assert.throws(() => store.evidence("lossy", { omitted: undefined }), /INVALID_JSON/);
  await assert.rejects(openEth40Store(join(root, "another"), { bad: Infinity }, () => createPaperState(START)), /INVALID_JSON/);
});
