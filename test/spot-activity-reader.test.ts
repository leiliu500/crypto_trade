import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { SpotPaperActivityReader } from "../src/dashboard/spot-activity-reader.js";
import { createSpotPaperState, type SpotPaperDecision, type SpotPaperState } from "../src/spot-trend/paper.js";
import { executeSpotPaperOrder, submitSpotPaperOrder, type SpotOrderRequest } from "../src/spot-trend/orders.js";
import { markSpotAccount } from "../src/spot-trend/account.js";

const start = 10_000, feeBps = 80;
const signal: SpotPaperDecision["signal"] = { version: "fixture", state: "long", reason: "TREND_ENTER",
  availableAtMs: 0, lastWeekEndMs: null, close: 100, movingAverage: 90 };
interface Proof { file: string; sha256: string }
type Document = Record<string, unknown>;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const clone = <T>(value: T): T => structuredClone(value);

async function fixture(t: TestContext, legacy = false) {
  const root = await mkdtemp(join(tmpdir(), "spot-activity-reader-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "cycles"));
  let state = createSpotPaperState("a".repeat(64), start);
  if (legacy) state.version = "btc-spot-weekly-research-paper-runner-v2" as SpotPaperState["version"];
  const envelope = { version: "spot-paper-journal-v1", state, runtimeSourceSha256: "b".repeat(64),
    lastEvidence: null as Proof | null, receiptEvidence: {} as Record<string, Proof>, runtimeUpgradeEvidence: undefined as Proof | undefined };
  const records: Array<{ proof: Proof; document: Document }> = [];
  async function write(file: string, document: unknown): Promise<Proof> {
    const bytes = JSON.stringify(document) + "\n";
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), bytes);
    return { file, sha256: sha(bytes) };
  }
  async function save() { envelope.state = state; await write("state.json", envelope); }
  async function commit(next: SpotPaperState, document: Document, suffix = "") {
    const proof = await write(`cycles/${next.cycles}-${next.lastCycleMs}${suffix}.json`, document);
    state = next; envelope.lastEvidence = proof; records.push({ proof, document }); await save();
    return proof;
  }
  async function submit(side: "buy" | "sell", quantity: number, price: number, nowMs: number) {
    const request: SpotOrderRequest = { clientOrderId: `activity-${nowMs}-${side}`, symbol: "BTC/USD", side, quantity,
      limitPrice: side === "buy" ? price + .1 : price - .1, createdAtMs: nowMs, feeBps, timeInForce: "ioc", reduceOnly: side === "sell" };
    const orders = submitSpotPaperOrder(state.orders, request, state.account), order = orders.at(-1)!;
    const bid = side === "buy" ? price - .1 : price;
    const decision: SpotPaperDecision = { timestampMs: nowMs, action: side, reason: side === "buy" ? "WEEKLY_TREND_ENTER" : "WEEKLY_TREND_EXIT",
      fill: null, orderId: order.orderId, signal, mark: markSpotAccount(state.account, bid, feeBps) };
    const next = { ...state, orders, cycles: state.cycles + 1, lastCycleMs: nowMs, lastDecision: decision, lastSignal: signal };
    const proof = await commit(next, { before: state, after: next, decision, recordedAtMs: nowMs,
      market: { book: { bids: [[bid, 100]], receivedAtMs: nowMs } } }, "-submitted");
    return { proof, orderId: order.orderId };
  }
  async function settle(price: number, nowMs: number, submittedEvidence: Proof) {
    const order = state.orders.at(-1)!, side = order.request.side;
    const bid = side === "buy" ? price - .1 : price, ask = side === "buy" ? price : price + .1;
    const book = { bids: [[bid, 100] as [number, number]], asks: [[ask, 100] as [number, number]], receivedAtMs: nowMs };
    const executed = executeSpotPaperOrder(order, state.account, { book, feeBps,
      rules: { lotSize: .001, minimumQuantity: .001, minimumNotionalUsd: 1, tickSize: .1 } }, nowMs);
    const decision = { ...state.lastDecision!, timestampMs: nowMs, fill: executed.order.fill, mark: markSpotAccount(executed.account, bid, feeBps) };
    const next = { ...state, account: executed.account, orders: state.orders.map(value => value.orderId === order.orderId ? executed.order : value),
      lastCycleMs: nowMs, lastDecision: decision };
    const reference = await commit(next, { before: state, after: next, decision, recordedAtMs: nowMs,
      phase: "BROKER_SETTLEMENT", submittedEvidence, market: { book } }, "-settled");
    if (executed.order.fill) envelope.receiptEvidence[executed.order.fill.id] = reference;
    await save();
  }
  async function hold(bid = 110, padding = "") {
    const nowMs = state.lastCycleMs + 300_000;
    const decision: SpotPaperDecision = { timestampMs: nowMs, action: "hold", reason: "HOLD_SPOT_NO_ADDITIONS", fill: null,
      signal, mark: markSpotAccount(state.account, bid, feeBps) };
    const next = { ...state, cycles: state.cycles + 1, lastCycleMs: nowMs, lastDecision: decision };
    return commit(next, { before: state, after: next, decision, recordedAtMs: nowMs, padding,
      market: { book: { bids: [[bid, 100]], receivedAtMs: nowMs } } });
  }
  async function upgrade() {
    const next = { ...state, version: "btc-spot-weekly-research-paper-runner-v3" as const };
    const reference = await write(`runtime-upgrades/${"c".repeat(64)}.json`, { version: "spot-paper-runtime-upgrade-v1",
      before: state, after: next, previousEvidence: envelope.lastEvidence, accountChanged: false, ordersChanged: false });
    envelope.runtimeUpgradeEvidence = reference; envelope.lastEvidence = reference; state = next; await save();
  }
  const entry = await submit("buy", 1, 100, start);
  await settle(100, start + 1, entry.proof);
  return { root, envelope, records, write, save, hold, submit, settle, upgrade, orderId: entry.orderId,
    get state() { return state; }, reader: new SpotPaperActivityReader({ root }) };
}

async function files(root: string): Promise<Record<string, string>> {
  const paths = (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
  return Object.fromEntries(await Promise.all(paths.map(async entry => {
    const file = join(entry.parentPath, entry.name); return [file, sha(await readFile(file))];
  })));
}

test("committed holding history updates fee-inclusive position values without any journal writes", async t => {
  const f = await fixture(t); await f.hold(110); await f.hold(120);
  const before = await files(f.root), snapshot = await f.reader.snapshot(f.state);
  assert.equal(snapshot.available, true, snapshot.error); assert.equal(snapshot.sourceCycle, 3);
  const activity = snapshot.orders[f.orderId]!;
  assert.equal(activity.positionStatus, "OPEN"); assert.equal(activity.remainingQuantity, 1);
  assert.equal(activity.markPrice, 120); assert.ok(Math.abs(activity.totalNetUsd! - 18.24) < 1e-8);
  assert.equal(activity.events.filter(event => event.type === "STRATEGY_EVALUATION").length, 2);
  assert.ok(activity.events.some(event => event.type === "BROKER_SETTLEMENT"));
  assert.deepEqual(await f.reader.snapshot(f.state), snapshot);
  assert.deepEqual(await files(f.root), before);
});

test("unreferenced cycle orphans are excluded and ambiguous committed predecessors fail closed", async t => {
  const f = await fixture(t); await f.hold(110); await f.hold(120);
  const intermediate = f.records[2]!, orphan = clone(intermediate.document);
  (orphan.after as SpotPaperState).peakEquityUsd += 1;
  const alternate = intermediate.proof.file.replace(".json", "-submitted.json");
  await f.write(alternate, orphan);
  const valid = await f.reader.snapshot(f.state);
  assert.equal(valid.available, true, valid.error);
  assert.equal(valid.orders[f.orderId]!.events.filter(event => event.type === "STRATEGY_EVALUATION").length, 2);
  await f.write(alternate, intermediate.document);
  const ambiguous = await new SpotPaperActivityReader({ root: f.root }).snapshot(f.state);
  assert.equal(ambiguous.available, false); assert.equal(ambiguous.error, "SPOT_ACTIVITY_HISTORY_AMBIGUOUS");
});

test("the current anchor and receipt/submission proof hashes are checked after cache hits", async t => {
  for (const target of ["anchor", "receipt", "submission"] as const) {
    const f = await fixture(t); await f.hold();
    assert.equal((await f.reader.snapshot(f.state)).available, true);
    const reference = target === "anchor" ? f.envelope.lastEvidence! : f.records[target === "receipt" ? 1 : 0]!.proof;
    const path = join(f.root, reference.file); await writeFile(path, (await readFile(path, "utf8")) + " ");
    const result = await f.reader.snapshot(f.state);
    assert.equal(result.available, false, target); assert.match(result.error!, /(?:PROOF|HISTORY)_CHANGED/);
  }
});

test("missing holding documents, receipt evidence and altered anchor state are unavailable", async t => {
  const missing = await fixture(t); await missing.hold(); await missing.hold();
  await rm(join(missing.root, missing.records[2]!.proof.file));
  assert.equal((await missing.reader.snapshot(missing.state)).error, "SPOT_ACTIVITY_HISTORY_MISSING");
  const receipt = await fixture(t); receipt.envelope.receiptEvidence = {}; await receipt.save();
  assert.equal((await receipt.reader.snapshot(receipt.state)).error, "SPOT_ACTIVITY_RECEIPT_PROOF_MISMATCH");
  const altered = await fixture(t); altered.state.peakEquityUsd += 1; await altered.save();
  assert.equal((await altered.reader.snapshot(altered.state)).error, "SPOT_ACTIVITY_ANCHOR_MISMATCH");
});

test("new cycles extend the durable timeline and mismatched status cannot reuse cached green activity", async t => {
  const f = await fixture(t); await f.hold();
  const previous = clone(f.state), first = await f.reader.snapshot(previous);
  await f.hold(120);
  assert.equal((await f.reader.snapshot(previous)).error, "SPOT_ACTIVITY_STATUS_MISMATCH");
  const current = await f.reader.snapshot(f.state);
  assert.equal(current.available, true, current.error);
  assert.equal(current.orders[f.orderId]!.totalEvents, first.orders[f.orderId]!.totalEvents + 1);
  assert.deepEqual(await new SpotPaperActivityReader({ root: f.root }).snapshot(f.state), current);
});

test("history pages use stable opaque event IDs across fresh readers and new cycle heads", async t => {
  const f = await fixture(t); for (let index = 0; index < 65; index++) await f.hold(110 + index);
  const snapshot = await f.reader.snapshot(f.state), first = snapshot.orders[f.orderId]!;
  assert.equal(snapshot.available, true, snapshot.error); assert.equal(first.events.length, 30); assert.ok(first.nextCursor);
  const page = await f.reader.page(f.orderId, first.nextCursor);
  assert.equal(page.available, true, page.error); assert.equal(page.activity!.nextCursor, null);
  const all = [...first.events, ...page.activity!.events];
  assert.equal(all.length, first.totalEvents); assert.equal(new Set(all.map(event => event.id)).size, all.length);
  assert.ok(all.every((event, index) => index === 0 || event.timestampMs <= all[index - 1]!.timestampMs));
  await f.hold(200);
  const later = await new SpotPaperActivityReader({ root: f.root }).page(f.orderId, first.nextCursor);
  assert.equal(later.available, true, later.error);
  assert.deepEqual(later.activity!.events.map(event => event.id), page.activity!.events.map(event => event.id));
  assert.equal((await f.reader.page(f.orderId, "unknown-event")).error, "SPOT_ACTIVITY_CURSOR_UNKNOWN");
});

test("query values cannot select filesystem paths and symlinked evidence is rejected", async t => {
  const f = await fixture(t);
  for (const [id, cursor] of [["../state.json", null], [f.orderId, "../state.json"], [f.orderId, "bad cursor"]] as const)
    assert.equal((await f.reader.page(id, cursor)).error, "SPOT_ACTIVITY_INVALID_QUERY");
  assert.equal((await f.reader.page("absent-order", null)).error, "SPOT_ACTIVITY_ORDER_UNAVAILABLE");
  const anchor = join(f.root, f.envelope.lastEvidence!.file), original = await readFile(anchor);
  await writeFile(join(f.root, "outside.json"), original); await rm(anchor); await symlink(join(f.root, "outside.json"), anchor);
  assert.equal((await f.reader.snapshot(f.state)).error, "SPOT_ACTIVITY_UNSAFE_PATH");
});

test("a version migration bridges complete entry history without adding synthetic evaluations", async t => {
  const f = await fixture(t, true); await f.hold(110); await f.upgrade(); await f.hold(120);
  const snapshot = await f.reader.snapshot(f.state);
  assert.equal(snapshot.available, true, snapshot.error);
  const activity = snapshot.orders[f.orderId]!;
  assert.equal(activity.events.filter(event => event.type === "STRATEGY_EVALUATION").length, 2);
  assert.equal(activity.events.filter(event => event.type === "BROKER_SETTLEMENT").length, 1);
  assert.equal(activity.openedAtMs, start + 1); assert.equal(activity.markPrice, 120);
});

test("the latest twenty reduction cards retain history back to their older entry", async t => {
  const f = await fixture(t); await f.hold(110);
  for (let index = 0; index < 21; index++) await f.submit("sell", 2, 110, f.state.lastCycleMs + 1_000);
  const snapshot = await f.reader.snapshot(f.state);
  assert.equal(snapshot.available, true, snapshot.error); assert.equal(Object.keys(snapshot.orders).length, 20);
  assert.equal(snapshot.orders[f.orderId], undefined);
  for (const activity of Object.values(snapshot.orders)) {
    assert.equal(activity.entryOrderId, f.orderId); assert.equal(activity.openedAtMs, start + 1);
    const pages = await f.reader.page(activity.orderId, activity.nextCursor);
    const all = [...activity.events, ...pages.activity!.events];
    assert.ok(all.some(event => event.type === "BROKER_SETTLEMENT" && event.timestampMs === start + 1));
  }
});
