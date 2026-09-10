#!/usr/bin/env node
/**
 * No-network execution smoke against compiled application modules.
 * Usage: node order-lifecycle-smoke.mjs --app-root /app --state-root /tmp
 * Always creates a new private synthetic journal; never opens an existing account.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sha = value => createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value) + "\n";
const clone = value => JSON.parse(JSON.stringify(value));
const report = { version: "spot-order-lifecycle-compiled-smoke-v1", syntheticData: true,
  mode: "RESEARCH_PAPER", liveTradingEnabled: false, networkUsed: false,
  productionAccountAccessed: false, financialPerformanceEvidence: false,
  startedAt: new Date().toISOString(), passed: false, checks: [], scenarios: [] };

async function main() {
  let appRoot = process.cwd(), stateRoot = "/tmp";
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    if (!["--app-root", "--state-root"].includes(args[index]) || !args[index + 1]) throw new Error("INVALID_SMOKE_ARGUMENTS");
    if (args[index] === "--app-root") appRoot = args[index + 1]; else stateRoot = args[index + 1];
  }
  if (!isAbsolute(appRoot) || !isAbsolute(stateRoot)) throw new Error("SMOKE_PATHS_MUST_BE_ABSOLUTE");
  appRoot = resolve(appRoot); stateRoot = resolve(stateRoot);
  if (stateRoot === appRoot || stateRoot === join(appRoot, "data") || stateRoot.startsWith(join(appRoot, "data") + "/"))
    throw new Error("SMOKE_REQUIRES_SEPARATE_SYNTHETIC_STATE_ROOT");
  globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN_IN_SYNTHETIC_SMOKE"); };
  const imported = name => import(pathToFileURL(join(appRoot, "dist/src/spot-trend", `${name}.js`)).href);
  const [{ createSpotPaperState, prepareSpotPaperCycle, settleSpotPaperCycle, validateSpotPaperState },
    { durableSpotFile, acquireSpotPaperLock }, { loadSpotPaperEnvelope }, { WEEK_MS }] = await Promise.all([
    imported("paper"), imported("journal"), imported("paper-main"), imported("data")]);
  const sourceNames = ["paper", "paper-main", "market", "evidence", "journal", "orders", "migration"];
  const sourceManifest = await Promise.all(sourceNames.map(async name => {
    const file = `src/spot-trend/${name}.ts`;
    return { file, sha256: sha(await readFile(join(appRoot, file))) };
  }));
  const runtimeSourceSha256 = sha(JSON.stringify(sourceManifest));
  const compiledNames = (await readdir(join(appRoot, "dist/src/spot-trend"))).filter(file => file.endsWith(".js")).sort();
  const compiledManifest = await Promise.all(compiledNames.map(async name => {
    const file = `dist/src/spot-trend/${name}`;
    return { file, sha256: sha(await readFile(join(appRoot, file))) };
  }));
  report.runtimeSourceSha256 = runtimeSourceSha256;
  report.compiledManifestSha256 = sha(JSON.stringify(compiledManifest));
  report.compiledManifest = compiledManifest;
  await mkdir(stateRoot, { recursive: true });
  const root = await mkdtemp(join(stateRoot, "spot-order-lifecycle-synthetic-"));
  report.syntheticJournalRoot = root;
  const evidenceSha256 = sha("SYNTHETIC_ORDER_EXECUTION_TEST_ONLY;NOT_PROFITABILITY_EVIDENCE");
  const origin = Date.UTC(2020, 0, 2), weekOpen = origin + 45 * WEEK_MS, start = weekOpen + 120_000;
  const bars = (closes = Array.from({ length: 45 }, (_, index) => 100 + index)) => closes.map((close, index) => ({
    openMs: origin + index * WEEK_MS, endMs: origin + (index + 1) * WEEK_MS,
    availableAtMs: origin + (index + 1) * WEEK_MS + 60_000,
    open: close, high: close + 1, low: close - 1, close, volume: 100, trades: 10 }));
  const market = (nowMs, displayed = 100) => ({ retrievedAtMs: nowMs, bars: bars(), sources: [],
    book: { bids: [[144, 100]], asks: [[144.1, displayed]], receivedAtMs: nowMs },
    rules: { lotSize: 0.00000001, minimumQuantity: 0.00005, minimumNotionalUsd: 0.5, tickSize: 0.1 } });
  const checked = (name, action) => { action(); report.checks.push({ name, passed: true }); };
  const denied = async (name, pattern, action) => {
    let failure;
    try { await action(); } catch (error) { failure = error; }
    assert.ok(failure, `${name} did not reject`);
    assert.match(failure instanceof Error ? failure.message : String(failure), pattern);
    report.checks.push({ name, passed: true, rejection: failure.message });
  };

  for (const scenario of [{ name: "full", displayed: 100, status: "FILLED" },
    { name: "partial-ioc", displayed: 0.2, status: "CANCELED" }]) {
    const directory = join(root, scenario.name), file = join(directory, "state.json");
    await mkdir(join(directory, "cycles"), { recursive: true });
    let release = await acquireSpotPaperLock(directory);
    try {
      await denied(`${scenario.name}: exclusive journal lock`, /SPOT_PAPER_LOCK_UNAVAILABLE/,
        () => acquireSpotPaperLock(directory));
      let envelope = { version: "spot-paper-journal-v1", state: createSpotPaperState(evidenceSha256, start),
        runtimeSourceSha256, lastEvidence: null, receiptEvidence: {} };
      await durableSpotFile(file, json(envelope), false);
      assert.deepEqual(await loadSpotPaperEnvelope(file, directory), envelope);
      const quote = market(start, scenario.displayed), before = envelope.state;
      const prepared = prepareSpotPaperCycle(before, quote, start);
      checked(`${scenario.name}: submission has no cash or fill effects`, () => {
        assert.equal(prepared.state.orders.length, 1);
        assert.equal(prepared.state.orders[0].status, "SUBMITTED");
        assert.equal(prepared.decision.fill, null);
        assert.deepEqual(prepared.state.account, before.account);
        assert.equal(prepared.state.account.receipts.length, 0);
      });
      const submittedFile = `cycles/${prepared.state.cycles}-${start}-submitted.json`;
      const submittedBytes = json({ recordedAtMs: start, mode: "RESEARCH_PAPER", evidenceSha256, runtimeSourceSha256,
        before, market: quote, decision: prepared.decision, after: prepared.state });
      await durableSpotFile(join(directory, submittedFile), submittedBytes, true);
      const submittedProof = { file: submittedFile, sha256: sha(submittedBytes) };
      envelope = { ...envelope, state: prepared.state, lastEvidence: submittedProof };
      await durableSpotFile(file, json(envelope), false);
      // Drop in-memory ownership and reload the durable SUBMITTED phase as after a restart.
      await release(); release = await acquireSpotPaperLock(directory);
      envelope = await loadSpotPaperEnvelope(file, directory);
      checked(`${scenario.name}: submitted journal reload preserves request and cash`, () => {
        assert.ok(envelope);
        assert.equal(envelope.state.orders[0].status, "SUBMITTED");
        assert.equal(envelope.state.account.cashUsd, 100_000);
        assert.equal(envelope.state.account.quantity, 0);
      });
      const settledAt = start + 1, submittedState = envelope.state;
      const settled = settleSpotPaperCycle(submittedState, quote, settledAt);
      checked(`${scenario.name}: broker produces the expected terminal order`, () => {
        assert.equal(settled.state.orders[0].status, scenario.status);
        assert.ok(settled.decision.fill);
        assert.equal(settled.state.account.receipts.length, 1);
        assert.deepEqual(settled.state.orders[0].events.map(event => event.type), scenario.status === "FILLED"
          ? ["SUBMITTED", "ACCEPTED", "FILLED"] : ["SUBMITTED", "ACCEPTED", "PARTIAL_FILL", "CANCELED"]);
        if (scenario.status === "CANCELED") {
          assert.equal(settled.state.orders[0].cancellationReason, "IOC_UNFILLED_REMAINDER");
          assert.ok(settled.state.orders[0].filledQuantity < settled.state.orders[0].request.quantity);
        }
        const fill = settled.decision.fill, notional = fill.quantity * fill.price;
        assert.equal(settled.state.account.cashUsd, 100_000 - (notional + notional * (fill.feeBps / 10_000)));
        assert.equal(settled.state.account.quantity, fill.quantity);
      });
      const settledFile = `cycles/${settled.state.cycles}-${settledAt}-settled.json`;
      const settledDocument = { recordedAtMs: settledAt, mode: "RESEARCH_PAPER", phase: "BROKER_SETTLEMENT",
        submittedEvidence: submittedProof, evidenceSha256, runtimeSourceSha256,
        before: submittedState, market: quote, decision: settled.decision, after: settled.state };
      const settledBytes = json(settledDocument), settledProof = { file: settledFile, sha256: sha(settledBytes) };
      await durableSpotFile(join(directory, settledFile), settledBytes, true);
      envelope = { ...envelope, state: settled.state, lastEvidence: settledProof,
        receiptEvidence: { [settled.decision.fill.id]: settledProof } };
      const goodEnvelopeBytes = json(envelope);
      await durableSpotFile(file, goodEnvelopeBytes, false);
      await release(); release = await acquireSpotPaperLock(directory);
      const reloaded = await loadSpotPaperEnvelope(file, directory);
      checked(`${scenario.name}: settled journal reload and repeat settlement do not duplicate fills`, () => {
        assert.deepEqual(reloaded, envelope);
        validateSpotPaperState(reloaded.state);
        const retried = settleSpotPaperCycle(reloaded.state, market(start + 2), start + 2);
        assert.equal(retried.state, reloaded.state);
        assert.equal(retried.state.account.receipts.length, 1);
        assert.equal(retried.state.account.cashUsd, settled.state.account.cashUsd);
      });
      // Each corruption is confined to this new synthetic journal and is restored afterward.
      const restore = async () => {
        await durableSpotFile(join(directory, submittedFile), submittedBytes, false);
        await durableSpotFile(join(directory, settledFile), settledBytes, false);
        await durableSpotFile(file, goodEnvelopeBytes, false);
      };
      const writeAlteredSettlement = async document => {
        const bytes = json(document), proof = { file: settledFile, sha256: sha(bytes) };
        await durableSpotFile(join(directory, settledFile), bytes, false);
        await durableSpotFile(file, json({ ...envelope, lastEvidence: proof,
          receiptEvidence: { [settled.decision.fill.id]: proof } }), false);
      };
      try {
        const missing = clone(settledDocument); delete missing.submittedEvidence;
        await writeAlteredSettlement(missing);
        await denied(`${scenario.name}: missing submission proof rejected`, /SPOT_MISSING_SUBMISSION_EVIDENCE/,
          () => loadSpotPaperEnvelope(file, directory));
      } finally { await restore(); }
      try {
        await durableSpotFile(join(directory, submittedFile), submittedBytes + "\n", false);
        await denied(`${scenario.name}: tampered submission bytes rejected`, /SPOT_CYCLE_EVIDENCE_CHANGED/,
          () => loadSpotPaperEnvelope(file, directory));
      } finally { await restore(); }
      try {
        await rename(join(directory, submittedFile), join(directory, submittedFile + ".missing"));
        await denied(`${scenario.name}: missing submission file rejected`, /ENOENT/,
          () => loadSpotPaperEnvelope(file, directory));
      } finally { await rename(join(directory, submittedFile + ".missing"), join(directory, submittedFile)); await restore(); }
      try {
        const mismatched = clone(settledDocument); mismatched.before.cycles += 1;
        await writeAlteredSettlement(mismatched);
        await denied(`${scenario.name}: mismatched submission state rejected`, /SPOT_SUBMISSION_STATE_MISMATCH/,
          () => loadSpotPaperEnvelope(file, directory));
      } finally { await restore(); }
      try {
        const noPending = clone(prepared.state); noPending.orders = [];
        const alteredSubmission = json({ ...JSON.parse(submittedBytes), after: noPending });
        await durableSpotFile(join(directory, submittedFile), alteredSubmission, false);
        const alteredSettlement = { ...settledDocument, before: noPending,
          submittedEvidence: { file: submittedFile, sha256: sha(alteredSubmission) } };
        await writeAlteredSettlement(alteredSettlement);
        await denied(`${scenario.name}: settlement without a submitted order rejected`, /SPOT_SETTLEMENT_WITHOUT_SUBMITTED_ORDER/,
          () => loadSpotPaperEnvelope(file, directory));
      } finally { await restore(); }
      const final = await loadSpotPaperEnvelope(file, directory);
      checked(`${scenario.name}: complete journal remains valid after corruption checks`, () => assert.deepEqual(final, envelope));
      report.scenarios.push({ name: scenario.name, stateFile: file, orderId: final.state.orders[0].orderId,
        orderStatus: final.state.orders[0].status, eventTypes: final.state.orders[0].events.map(event => event.type),
        requestedQuantity: final.state.orders[0].request.quantity, filledQuantity: final.state.orders[0].filledQuantity,
        receiptCount: final.state.account.receipts.length, cashBeforeUsd: 100_000, cashAfterUsd: final.state.account.cashUsd,
        quantityAfter: final.state.account.quantity, feesUsd: final.state.account.feesUsd,
        submissionProof: submittedProof, settlementProof: settledProof, stateSha256: sha(await readFile(file)) });
    } finally { await release(); }
  }
  report.passed = report.checks.every(check => check.passed);
  report.completedAt = new Date().toISOString();
}

try { await main(); }
catch (error) { report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
