import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { applySpotFill, markSpotAccount } from "../src/spot-trend/account.js";
import { LEGACY_SPOT_EVIDENCE_SHA256, LEGACY_SPOT_RUNTIME_SHA256, LEGACY_SPOT_VERSION,
  migrateLegacySpotState, migratePreviousSpotState, PREVIOUS_SPOT_RUNTIME_SHA256, PREVIOUS_SPOT_VERSION,
  validatePreviousSpotState } from "../src/spot-trend/migration.js";
import { loadSpotPaperEnvelope, migrateSpotPaperEnvelope, upgradeSpotPaperEnvelope } from "../src/spot-trend/paper-main.js";
import { createSpotPaperState, prepareSpotPaperCycle, SPOT_PAPER_SPEC, validateSpotPaperState } from "../src/spot-trend/paper.js";
import { executeSpotPaperOrder, submitSpotPaperOrder } from "../src/spot-trend/orders.js";

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const targetSource = "b".repeat(64), nowMs = 1_780_000_000_000;
type Envelope = NonNullable<Awaited<ReturnType<typeof loadSpotPaperEnvelope>>>;

function legacyState(): Record<string, unknown> {
  const initial = createSpotPaperState(LEGACY_SPOT_EVIDENCE_SHA256, nowMs);
  const prepared = prepareSpotPaperCycle(initial, { retrievedAtMs: nowMs, bars: [], sources: [],
    book: { bids: [[100, 100]], asks: [[100.1, 100]], receivedAtMs: nowMs },
    rules: { lotSize: 0.001, minimumQuantity: 0.001, minimumNotionalUsd: 1, tickSize: 0.1 } }, nowMs);
  const { orders: ignored, ...state } = prepared.state;
  assert.equal(ignored.length, 0);
  return { ...state, version: LEGACY_SPOT_VERSION };
}

async function fixture(t: TestContext): Promise<{ root: string; file: string; envelope: Envelope; bytes: string; cycleFile: string }> {
  const root = await mkdtemp(join(tmpdir(), "spot-order-migration-test-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "cycles"));
  const state = legacyState(), cycleFile = `cycles/1-${nowMs}.json`;
  const cycleBytes = JSON.stringify({ after: state, decision: state.lastDecision }) + "\n";
  await writeFile(join(root, cycleFile), cycleBytes);
  const envelope = { version: "spot-paper-journal-v1", state, runtimeSourceSha256: LEGACY_SPOT_RUNTIME_SHA256,
    lastEvidence: { file: cycleFile, sha256: sha(cycleBytes) }, receiptEvidence: {} } as unknown as Envelope;
  const file = join(root, "state.json"), bytes = JSON.stringify(envelope) + "\n";
  await writeFile(file, bytes);
  return { root, file, envelope, bytes, cycleFile };
}

test("known untraded v1 migration preserves cash, history, clocks and decision without inventing orders", () => {
  const before = legacyState(), migrated = migrateLegacySpotState(before, LEGACY_SPOT_RUNTIME_SHA256);
  assert.equal(migrated.version, SPOT_PAPER_SPEC.version);
  assert.deepEqual(migrated.orders, []);
  assert.deepEqual(migrated.account, before.account);
  assert.equal(migrated.startedAtMs, before.startedAtMs);
  assert.equal(migrated.cycles, before.cycles);
  assert.equal(migrated.lastCycleMs, before.lastCycleMs);
  assert.deepEqual(migrated.lastDecision, before.lastDecision);
  assert.equal(migrated.evidenceSha256, LEGACY_SPOT_EVIDENCE_SHA256);
  assert.equal(before.version, LEGACY_SPOT_VERSION);
  assert.equal("orders" in before, false);
  validateSpotPaperState(migrated);
});

test("migration rejects unknown runtime, strategy evidence, versions and preexisting order fields", () => {
  assert.throws(() => migrateLegacySpotState(legacyState(), "c".repeat(64)), /KNOWN_UNTRADED_V1_LEDGER/);
  for (const changes of [{ version: "other-v1" }, { evidenceSha256: "c".repeat(64) }, { mode: "LIVE" }, { orders: [] }])
    assert.throws(() => migrateLegacySpotState({ ...legacyState(), ...changes }, LEGACY_SPOT_RUNTIME_SHA256), /KNOWN_UNTRADED_V1_LEDGER/);
});

test("migration refuses any legacy fill or changed capital even when the old account reconciles", () => {
  const state = legacyState();
  const account = clone(createSpotPaperState(LEGACY_SPOT_EVIDENCE_SHA256, nowMs).account);
  const bought = applySpotFill(account, { id: "legacy-fill", side: "buy", quantity: 1, price: 100, feeBps: 80, timestampMs: nowMs });
  assert.throws(() => migrateLegacySpotState({ ...state, account: bought }, LEGACY_SPOT_RUNTIME_SHA256), /KNOWN_UNTRADED_V1_LEDGER/);
  for (const changes of [{ cashUsd: 100_001 }, { cashUsd: 99_999 }, { feesUsd: 1 }, { realizedNetUsd: 1 }, { initialCashUsd: 200_000 }])
    assert.throws(() => migrateLegacySpotState({ ...state, account: { ...account, ...changes } }, LEGACY_SPOT_RUNTIME_SHA256), /KNOWN_UNTRADED_V1_LEDGER/);
});

test("durable envelope migration backs up exact v1 bytes and reloads the current ledger", async t => {
  const value = await fixture(t), loaded = await loadSpotPaperEnvelope(value.file, value.root);
  assert.ok(loaded);
  assert.equal(String(loaded.state.version), LEGACY_SPOT_VERSION);
  const migrated = await migrateSpotPaperEnvelope(loaded, value.root, targetSource);
  assert.equal(migrated.runtimeSourceSha256, targetSource);
  assert.equal(migrated.state.version, SPOT_PAPER_SPEC.version);
  assert.deepEqual(migrated.state.account, loaded.state.account);
  assert.equal(migrated.state.startedAtMs, loaded.state.startedAtMs);
  assert.equal(migrated.state.lastCycleMs, loaded.state.lastCycleMs);
  assert.equal(migrated.state.cycles, loaded.state.cycles);
  assert.deepEqual(migrated.state.orders, []);
  assert.ok(migrated.migrationEvidence);
  assert.deepEqual(migrated.lastEvidence, migrated.migrationEvidence);
  const backup = join(value.root, `state-v1-${sha(value.bytes)}.json`);
  assert.equal(await readFile(backup, "utf8"), value.bytes);
  const proofBytes = await readFile(join(value.root, migrated.migrationEvidence.file));
  assert.equal(sha(proofBytes), migrated.migrationEvidence.sha256);
  const proof = JSON.parse(proofBytes.toString("utf8")) as Record<string, unknown>;
  assert.equal(proof.accountChanged, false);
  assert.equal(proof.beforeEnvelopeSha256, sha(value.bytes));
  assert.equal(proof.beforeRuntimeSha256, LEGACY_SPOT_RUNTIME_SHA256);
  assert.equal(proof.afterRuntimeSha256, targetSource);
  assert.deepEqual(proof.previousEvidence, loaded.lastEvidence);
  const reloaded = await loadSpotPaperEnvelope(value.file, value.root);
  assert.deepEqual(reloaded, migrated);
  assert.deepEqual(JSON.parse(await readFile(value.file, "utf8")), migrated);
  assert.deepEqual(await readdir(join(value.root, "migrations")), [`${sha(value.bytes)}.json`]);
});

test("legacy envelope rejects changed or mismatched last-cycle evidence before migration", async t => {
  const value = await fixture(t);
  await writeFile(join(value.root, value.cycleFile), "{}\n");
  await assert.rejects(loadSpotPaperEnvelope(value.file, value.root), /SPOT_CYCLE_EVIDENCE_CHANGED/);
  assert.equal(await readFile(value.file, "utf8"), value.bytes);
  const wrongState = clone(value.envelope.state); wrongState.lastCycleMs += 1;
  const changedCycle = JSON.stringify({ after: wrongState, decision: wrongState.lastDecision }) + "\n";
  await writeFile(join(value.root, value.cycleFile), changedCycle);
  const changedEnvelope = { ...value.envelope, lastEvidence: { file: value.cycleFile, sha256: sha(changedCycle) } };
  await writeFile(value.file, JSON.stringify(changedEnvelope) + "\n");
  await assert.rejects(loadSpotPaperEnvelope(value.file, value.root), /SPOT_LAST_CYCLE_STATE_MISMATCH/);
});

test("migration detects a journal changed after loading and preserves the newer bytes", async t => {
  const value = await fixture(t), loaded = await loadSpotPaperEnvelope(value.file, value.root);
  assert.ok(loaded);
  const replaced = { ...value.envelope, unexpectedChange: true }, bytes = JSON.stringify(replaced) + "\n";
  await writeFile(value.file, bytes);
  await assert.rejects(migrateSpotPaperEnvelope(loaded, value.root, targetSource), /SPOT_STATE_CHANGED_DURING_MIGRATION/);
  assert.equal(await readFile(value.file, "utf8"), bytes);
  assert.deepEqual((await readdir(value.root)).sort(), ["cycles", "state.json"]);
});

test("recovery after writing migration proof but before journal replacement is idempotent", async t => {
  const value = await fixture(t), loaded = await loadSpotPaperEnvelope(value.file, value.root);
  assert.ok(loaded);
  const first = await migrateSpotPaperEnvelope(loaded, value.root, targetSource);
  const proofBytes = await readFile(join(value.root, first.migrationEvidence!.file), "utf8");
  // Simulate a crash before the final atomic replacement became durable.
  await writeFile(value.file, value.bytes);
  const legacy = await loadSpotPaperEnvelope(value.file, value.root); assert.ok(legacy);
  const recovered = await migrateSpotPaperEnvelope(legacy, value.root, targetSource);
  assert.deepEqual(recovered, first);
  assert.equal(await readFile(join(value.root, first.migrationEvidence!.file), "utf8"), proofBytes);
  assert.equal((await readdir(value.root)).filter(name => name.startsWith("state-v1-")).length, 1);
  assert.deepEqual(await loadSpotPaperEnvelope(value.file, value.root), first);
});

test("a previously written migration proof cannot be reused for a different runtime", async t => {
  const value = await fixture(t), loaded = await loadSpotPaperEnvelope(value.file, value.root); assert.ok(loaded);
  await migrateSpotPaperEnvelope(loaded, value.root, targetSource);
  await writeFile(value.file, value.bytes);
  const legacy = await loadSpotPaperEnvelope(value.file, value.root); assert.ok(legacy);
  await assert.rejects(migrateSpotPaperEnvelope(legacy, value.root, "d".repeat(64)), /SPOT_MIGRATION_EVIDENCE_MISMATCH/);
  assert.equal(await readFile(value.file, "utf8"), value.bytes);
});

test("changed migration proof is rejected on the next startup", async t => {
  const value = await fixture(t), loaded = await loadSpotPaperEnvelope(value.file, value.root); assert.ok(loaded);
  const migrated = await migrateSpotPaperEnvelope(loaded, value.root, targetSource);
  await writeFile(join(value.root, migrated.migrationEvidence!.file), "{}\n");
  await assert.rejects(loadSpotPaperEnvelope(value.file, value.root), /SPOT_CYCLE_EVIDENCE_CHANGED/);
});

async function v2Fixture(t: TestContext, kind: "empty" | "filled" | "submitted" | "accepted" = "empty") {
  const root = await mkdtemp(join(tmpdir(), "spot-runtime-upgrade-test-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "cycles")); await mkdir(join(root, "migrations"));
  const oldV1 = legacyState();
  let state = { ...oldV1, version: PREVIOUS_SPOT_VERSION, orders: [] } as unknown as Envelope["state"];
  const migrationPath = `migrations/${"a".repeat(64)}.json`;
  const migrationBytes = JSON.stringify({ version: "spot-paper-order-migration-v1", before: oldV1, after: state }) + "\n";
  await writeFile(join(root, migrationPath), migrationBytes);
  const migrationEvidence = { file: migrationPath, sha256: sha(migrationBytes) };
  let cycleFile = `cycles/1-${nowMs}.json`, cycleBytes: string;
  const receiptEvidence: Envelope["receiptEvidence"] = {};
  if (kind !== "empty") {
    const request = { clientOrderId: "persisted-v2-entry", symbol: "BTC/USD" as const, side: "buy" as const,
      quantity: 1, limitPrice: 100.1, timeInForce: "ioc" as const, reduceOnly: false, createdAtMs: nowMs, feeBps: 80 };
    const orders = submitSpotPaperOrder([], request, state.account);
    state = { ...state, orders, lastDecision: { ...state.lastDecision!, timestampMs: nowMs,
      action: "buy", reason: "WEEKLY_TREND_ENTER", fill: null, orderId: orders[0]!.orderId } };
    if (kind === "accepted") {
      state = { ...state, orders: [{ ...orders[0]!, status: "ACCEPTED",
        events: [...orders[0]!.events, { type: "ACCEPTED", timestampMs: nowMs }] }] };
    }
    cycleFile = `cycles/1-${nowMs}-submitted.json`;
    cycleBytes = JSON.stringify({ after: state, decision: state.lastDecision }) + "\n";
    await writeFile(join(root, cycleFile), cycleBytes);
    if (kind === "filled") {
      const before = state, submittedEvidence = { file: cycleFile, sha256: sha(cycleBytes) };
      const matched = executeSpotPaperOrder(orders[0]!, state.account,
        { book: { bids: [[99.9, 100]], asks: [[100, 100]], receivedAtMs: nowMs + 1 },
          rules: { lotSize: .001, minimumQuantity: .001, minimumNotionalUsd: 1, tickSize: .01 }, feeBps: 80 }, nowMs + 1);
      assert.equal(matched.order.status, "FILLED");
      state = { ...state, orders: [matched.order], account: matched.account, lastCycleMs: nowMs + 1,
        lastDecision: { ...state.lastDecision!, timestampMs: nowMs + 1, fill: matched.order.fill,
          mark: markSpotAccount(matched.account, 99.9, 80) } };
      cycleFile = `cycles/1-${nowMs + 1}-settled.json`;
      cycleBytes = JSON.stringify({ phase: "BROKER_SETTLEMENT", before, after: state,
        submittedEvidence, decision: state.lastDecision }) + "\n";
      receiptEvidence[matched.order.fill!.id] = { file: cycleFile, sha256: sha(cycleBytes) };
    }
  } else cycleBytes = JSON.stringify({ after: state, decision: state.lastDecision }) + "\n";
  await writeFile(join(root, cycleFile), cycleBytes);
  const envelope: Envelope = { version: "spot-paper-journal-v1", state, runtimeSourceSha256: PREVIOUS_SPOT_RUNTIME_SHA256,
    lastEvidence: { file: cycleFile, sha256: sha(cycleBytes) }, receiptEvidence, migrationEvidence };
  const file = join(root, "state.json"), bytes = JSON.stringify(envelope) + "\n";
  await writeFile(file, bytes);
  return { root, file, bytes, envelope, cycleFile, cycleBytes };
}

test("v2 validation leaves historical version and settled ledger untouched", async t => {
  const value = await v2Fixture(t, "filled"), original = clone(value.envelope);
  validatePreviousSpotState(value.envelope.state, PREVIOUS_SPOT_RUNTIME_SHA256);
  const loaded = await loadSpotPaperEnvelope(value.file, value.root);
  assert.deepEqual(loaded, original);
  assert.equal(String(loaded!.state.version), PREVIOUS_SPOT_VERSION);
  assert.equal(await readFile(value.file, "utf8"), value.bytes);
  const migrated = migratePreviousSpotState(value.envelope.state, PREVIOUS_SPOT_RUNTIME_SHA256);
  assert.equal(migrated.version, SPOT_PAPER_SPEC.version);
  assert.equal(migrated.account, value.envelope.state.account);
  assert.equal(migrated.orders, value.envelope.state.orders);
  assert.deepEqual({ ...migrated, version: PREVIOUS_SPOT_VERSION }, value.envelope.state);
  assert.deepEqual(value.envelope, original);
});

test("v2 policy upgrade preserves filled orders, historical proofs and exact backup bytes", async t => {
  const value = await v2Fixture(t, "filled"), loaded = await loadSpotPaperEnvelope(value.file, value.root); assert.ok(loaded);
  const upgraded = await upgradeSpotPaperEnvelope(loaded, value.root, targetSource);
  assert.equal(upgraded.state.version, SPOT_PAPER_SPEC.version);
  assert.equal(upgraded.runtimeSourceSha256, targetSource);
  assert.deepEqual(upgraded.state.account, loaded.state.account);
  assert.deepEqual(upgraded.state.orders, loaded.state.orders);
  assert.deepEqual(upgraded.state.lastDecision, loaded.state.lastDecision);
  assert.deepEqual(upgraded.receiptEvidence, loaded.receiptEvidence);
  assert.deepEqual(upgraded.migrationEvidence, loaded.migrationEvidence);
  assert.ok(upgraded.runtimeUpgradeEvidence);
  assert.deepEqual(upgraded.lastEvidence, upgraded.runtimeUpgradeEvidence);
  assert.equal(await readFile(join(value.root, `state-v2-${sha(value.bytes)}.json`), "utf8"), value.bytes);
  assert.equal(await readFile(join(value.root, value.cycleFile), "utf8"), value.cycleBytes);
  assert.deepEqual(await loadSpotPaperEnvelope(value.file, value.root), upgraded);
  const proof = JSON.parse(await readFile(join(value.root, upgraded.runtimeUpgradeEvidence.file), "utf8"));
  assert.equal(proof.beforeEnvelopeSha256, sha(value.bytes));
  assert.equal(proof.beforeRuntimeSha256, PREVIOUS_SPOT_RUNTIME_SHA256);
  assert.equal(proof.afterRuntimeSha256, targetSource);
  assert.equal(proof.policyChange, "ENTRY_TIMING_ONLY");
  assert.equal(proof.accountChanged, false); assert.equal(proof.ordersChanged, false);
  assert.deepEqual(proof.previousMigrationEvidence, loaded.migrationEvidence);
});

test("later v3 cycles retain and verify the original runtime upgrade and v2 fill proofs", async t => {
  const value = await v2Fixture(t, "filled"), loaded = await loadSpotPaperEnvelope(value.file, value.root); assert.ok(loaded);
  const upgraded = await upgradeSpotPaperEnvelope(loaded, value.root, targetSource);
  const after = { ...upgraded.state, cycles: upgraded.state.cycles + 1, lastCycleMs: nowMs + 10,
    lastDecision: { ...upgraded.state.lastDecision!, timestampMs: nowMs + 10, action: "hold" as const,
      reason: "HOLD_SPOT_NO_ADDITIONS", fill: null } };
  const cycleFile = `cycles/2-${nowMs + 10}-submitted.json`, cycleBytes = JSON.stringify({ after, decision: after.lastDecision }) + "\n";
  await writeFile(join(value.root, cycleFile), cycleBytes);
  const next = { ...upgraded, state: after, lastEvidence: { file: cycleFile, sha256: sha(cycleBytes) } };
  await writeFile(value.file, JSON.stringify(next) + "\n");
  assert.deepEqual(await loadSpotPaperEnvelope(value.file, value.root), next);
  assert.deepEqual(next.runtimeUpgradeEvidence, upgraded.runtimeUpgradeEvidence);
  await writeFile(join(value.root, value.cycleFile), "{}\n");
  await assert.rejects(loadSpotPaperEnvelope(value.file, value.root), /SPOT_CYCLE_EVIDENCE_CHANGED/);
});

test("pending v2 submitted and accepted requests block policy migration without changing the journal", async t => {
  for (const kind of ["submitted", "accepted"] as const) {
    const value = await v2Fixture(t, kind), loaded = await loadSpotPaperEnvelope(value.file, value.root); assert.ok(loaded);
    await assert.rejects(upgradeSpotPaperEnvelope(loaded, value.root, targetSource), /SPOT_UPGRADE_REQUIRES_NO_PENDING_ORDERS/);
    assert.equal(await readFile(value.file, "utf8"), value.bytes);
    assert.deepEqual((await readdir(value.root)).sort(), ["cycles", "migrations", "state.json"]);
  }
});

test("unknown v2 source, evidence, account changes and existing upgrade metadata fail closed", async t => {
  const value = await v2Fixture(t, "filled");
  assert.throws(() => migratePreviousSpotState(value.envelope.state, "c".repeat(64)), /KNOWN_V2_LEDGER/);
  for (const change of [{ mode: "LIVE" }, { evidenceSha256: "c".repeat(64) }, { version: "unknown-v2" }])
    assert.throws(() => validatePreviousSpotState({ ...value.envelope.state, ...change }, PREVIOUS_SPOT_RUNTIME_SHA256), /KNOWN_V2_LEDGER/);
  const forged = clone(value.envelope.state); forged.account.cashUsd += 1;
  assert.throws(() => validatePreviousSpotState(forged, PREVIOUS_SPOT_RUNTIME_SHA256), /RECONCILIATION_FAILED/);
  const changed = { ...value.envelope, runtimeUpgradeEvidence: { file: `runtime-upgrades/${"a".repeat(64)}.json`, sha256: "b".repeat(64) } };
  await writeFile(value.file, JSON.stringify(changed) + "\n");
  await assert.rejects(loadSpotPaperEnvelope(value.file, value.root), /SPOT_V2_ALREADY_HAS_UPGRADE_EVIDENCE/);
});

test("v2 upgrade refuses a changed last-cycle proof before writing any backup", async t => {
  const value = await v2Fixture(t), loaded = await loadSpotPaperEnvelope(value.file, value.root); assert.ok(loaded);
  await writeFile(join(value.root, value.cycleFile), "{}\n");
  await assert.rejects(upgradeSpotPaperEnvelope(loaded, value.root, targetSource), /SPOT_CYCLE_EVIDENCE_CHANGED/);
  assert.equal(await readFile(value.file, "utf8"), value.bytes);
  assert.deepEqual((await readdir(value.root)).sort(), ["cycles", "migrations", "state.json"]);
});

test("v2 upgrade detects a concurrent journal change and invalid target hash", async t => {
  const value = await v2Fixture(t), loaded = await loadSpotPaperEnvelope(value.file, value.root); assert.ok(loaded);
  for (const target of ["invalid", PREVIOUS_SPOT_RUNTIME_SHA256])
    await assert.rejects(upgradeSpotPaperEnvelope(loaded, value.root, target), /INVALID_SPOT_UPGRADE_SOURCE_HASH/);
  const changedBytes = JSON.stringify({ ...value.envelope, changed: true }) + "\n";
  await writeFile(value.file, changedBytes);
  await assert.rejects(upgradeSpotPaperEnvelope(loaded, value.root, targetSource), /SPOT_STATE_CHANGED_DURING_UPGRADE/);
  assert.equal(await readFile(value.file, "utf8"), changedBytes);
});

test("v2 upgrade recovers idempotently after proof creation but before journal replacement", async t => {
  const value = await v2Fixture(t, "filled"), loaded = await loadSpotPaperEnvelope(value.file, value.root); assert.ok(loaded);
  const first = await upgradeSpotPaperEnvelope(loaded, value.root, targetSource);
  const proofBytes = await readFile(join(value.root, first.runtimeUpgradeEvidence!.file), "utf8");
  await writeFile(value.file, value.bytes);
  const restored = await loadSpotPaperEnvelope(value.file, value.root); assert.ok(restored);
  const second = await upgradeSpotPaperEnvelope(restored, value.root, targetSource);
  assert.deepEqual(second, first);
  assert.equal(await readFile(join(value.root, first.runtimeUpgradeEvidence!.file), "utf8"), proofBytes);
  assert.equal((await readdir(value.root)).filter(name => name.startsWith("state-v2-")).length, 1);
  assert.deepEqual(await loadSpotPaperEnvelope(value.file, value.root), first);
});

test("a written v2 upgrade proof cannot be retargeted to a different runtime", async t => {
  const value = await v2Fixture(t), loaded = await loadSpotPaperEnvelope(value.file, value.root); assert.ok(loaded);
  await upgradeSpotPaperEnvelope(loaded, value.root, targetSource);
  await writeFile(value.file, value.bytes);
  await assert.rejects(upgradeSpotPaperEnvelope(loaded, value.root, "d".repeat(64)), /SPOT_RUNTIME_UPGRADE_EVIDENCE_MISMATCH/);
  assert.equal(await readFile(value.file, "utf8"), value.bytes);
});

test("changed upgrade backup and proof are rejected after v3 migration", async t => {
  const value = await v2Fixture(t), loaded = await loadSpotPaperEnvelope(value.file, value.root); assert.ok(loaded);
  const upgraded = await upgradeSpotPaperEnvelope(loaded, value.root, targetSource);
  const backup = join(value.root, `state-v2-${sha(value.bytes)}.json`);
  await writeFile(backup, value.bytes + " ");
  await assert.rejects(loadSpotPaperEnvelope(value.file, value.root), /SPOT_UPGRADE_BACKUP_CHANGED/);
  await writeFile(backup, value.bytes);
  const proofPath = join(value.root, upgraded.runtimeUpgradeEvidence!.file);
  const proof = JSON.parse(await readFile(proofPath, "utf8")); proof.ordersChanged = true;
  const changedBytes = JSON.stringify(proof) + "\n";
  await writeFile(proofPath, changedBytes);
  await assert.rejects(loadSpotPaperEnvelope(value.file, value.root), /SPOT_CYCLE_EVIDENCE_CHANGED/);
  const reference = { file: upgraded.runtimeUpgradeEvidence!.file, sha256: sha(changedBytes) };
  await writeFile(value.file, JSON.stringify({ ...upgraded, lastEvidence: reference, runtimeUpgradeEvidence: reference }) + "\n");
  await assert.rejects(loadSpotPaperEnvelope(value.file, value.root), /SPOT_RUNTIME_UPGRADE_EVIDENCE_MISMATCH/);
});
