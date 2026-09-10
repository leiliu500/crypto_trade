import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSpotPaperEvidence } from "./evidence.js";
import { fetchSpotMarketSnapshot } from "./market.js";
import { createSpotPaperState, prepareSpotPaperCycle, settleSpotPaperCycle, validateSpotPaperState, SPOT_PAPER_SPEC, type SpotPaperState } from "./paper.js";
import { durableSpotFile as durableFile, acquireSpotPaperLock as acquireLock } from "./journal.js";
import { migrateLegacySpotState, LEGACY_SPOT_VERSION } from "./migration.js";
import { isDeepStrictEqual } from "node:util";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
interface Envelope {
  version: "spot-paper-journal-v1"; state: SpotPaperState; runtimeSourceSha256: string;
  lastEvidence: { file: string; sha256: string } | null;
  receiptEvidence: Record<string, { file: string; sha256: string }>;
  migrationEvidence?: { file: string; sha256: string };
}
async function runtimeHash(): Promise<string> {
  const files = ["src/spot-trend/paper.ts", "src/spot-trend/paper-main.ts", "src/spot-trend/market.ts", "src/spot-trend/evidence.ts", "src/spot-trend/journal.ts", "src/spot-trend/orders.ts", "src/spot-trend/migration.ts"];
  return sha(JSON.stringify(await Promise.all(files.map(async file => ({ file, sha256: sha(await readFile(file)) })))));
}
export async function loadSpotPaperEnvelope(file: string, root: string): Promise<Envelope | null> {
  let bytes: string;
  try { bytes = await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const envelope = JSON.parse(bytes) as Envelope;
  if (envelope.version !== "spot-paper-journal-v1" || !/^[a-f0-9]{64}$/.test(envelope.runtimeSourceSha256)
    || !envelope.receiptEvidence || typeof envelope.receiptEvidence !== "object") throw new Error("INVALID_SPOT_JOURNAL");
  if (String(envelope.state.version) === LEGACY_SPOT_VERSION) migrateLegacySpotState(envelope.state, envelope.runtimeSourceSha256);
  else validateSpotPaperState(envelope.state);
  const verify = async (proof: { file: string; sha256: string }) => {
    if (!/^(?:cycles\/\d+-\d+(?:-(?:submitted|settled))?|migrations\/[a-f0-9]{64})\.json$/.test(proof.file)
      || !/^[a-f0-9]{64}$/.test(proof.sha256)) throw new Error("INVALID_SPOT_CYCLE_PATH");
    const raw = await readFile(join(root, proof.file));
    if (sha(raw) !== proof.sha256) throw new Error("SPOT_CYCLE_EVIDENCE_CHANGED");
    return JSON.parse(raw.toString("utf8")) as { after: SpotPaperState; before?: SpotPaperState;
      phase?: string; submittedEvidence?: { file: string; sha256: string }; decision: { fill: unknown } };
  };
  const verifySubmission = async (cycle: Awaited<ReturnType<typeof verify>>) => {
    if (cycle.phase !== "BROKER_SETTLEMENT") return;
    if (!cycle.submittedEvidence) throw new Error("SPOT_MISSING_SUBMISSION_EVIDENCE");
    const submitted = await verify(cycle.submittedEvidence);
    if (!isDeepStrictEqual(submitted.after, cycle.before)) throw new Error("SPOT_SUBMISSION_STATE_MISMATCH");
    if (!submitted.after.orders.some(order => ["SUBMITTED", "ACCEPTED"].includes(order.status)))
      throw new Error("SPOT_SETTLEMENT_WITHOUT_SUBMITTED_ORDER");
  };
  if (envelope.lastEvidence) {
    const cycle = await verify(envelope.lastEvidence);
    await verifySubmission(cycle);
    if (JSON.stringify(cycle.after) !== JSON.stringify(envelope.state)) throw new Error("SPOT_LAST_CYCLE_STATE_MISMATCH");
  } else if (envelope.state.cycles !== 0) throw new Error("SPOT_MISSING_CYCLE_EVIDENCE");
  if (Object.keys(envelope.receiptEvidence).length !== envelope.state.account.receipts.length) throw new Error("SPOT_RECEIPT_PROOF_COUNT");
  for (const fill of envelope.state.account.receipts) {
    const proof = envelope.receiptEvidence[fill.id]; if (!proof) throw new Error("SPOT_MISSING_RECEIPT_EVIDENCE");
    const cycle = await verify(proof);
    if (cycle.phase !== "BROKER_SETTLEMENT") throw new Error("SPOT_FILL_WITHOUT_BROKER_SETTLEMENT");
    await verifySubmission(cycle);
    if (JSON.stringify(cycle.decision.fill) !== JSON.stringify(fill)) throw new Error("SPOT_RECEIPT_EVIDENCE_MISMATCH");
  }
  if (envelope.migrationEvidence) await verify(envelope.migrationEvidence);
  return envelope;
}

export async function migrateSpotPaperEnvelope(envelope: Envelope, root: string, sourceSha256: string): Promise<Envelope> {
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error("INVALID_SPOT_MIGRATION_SOURCE_HASH");
  const state = migrateLegacySpotState(envelope.state, envelope.runtimeSourceSha256);
  const oldBytes = await readFile(join(root, "state.json"));
  if (!isDeepStrictEqual(JSON.parse(oldBytes.toString("utf8")), envelope)) throw new Error("SPOT_STATE_CHANGED_DURING_MIGRATION");
  const oldSha = sha(oldBytes), proofFile = `migrations/${oldSha}.json`;
  await mkdir(join(root, "migrations"), { recursive: true });
  const backup = join(root, `state-v1-${oldSha}.json`);
  try { await durableFile(backup, oldBytes.toString("utf8"), true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || sha(await readFile(backup)) !== oldSha) throw error; }
  let proofBytes: string;
  try { proofBytes = await readFile(join(root, proofFile), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    proofBytes = JSON.stringify({ version: "spot-paper-order-migration-v1", migratedAtMs: Date.now(), beforeEnvelopeSha256: oldSha,
      beforeRuntimeSha256: envelope.runtimeSourceSha256, afterRuntimeSha256: sourceSha256,
      before: envelope.state, after: state, previousEvidence: envelope.lastEvidence, accountChanged: false }) + "\n";
    await durableFile(join(root, proofFile), proofBytes, true);
  }
  const proof = JSON.parse(proofBytes) as Record<string, unknown>;
  if (proof.version !== "spot-paper-order-migration-v1" || !Number.isSafeInteger(proof.migratedAtMs)
    || (proof.migratedAtMs as number) < 0 || proof.beforeEnvelopeSha256 !== oldSha || proof.beforeRuntimeSha256 !== envelope.runtimeSourceSha256
    || proof.afterRuntimeSha256 !== sourceSha256 || !isDeepStrictEqual(proof.before, envelope.state)
    || !isDeepStrictEqual(proof.after, state) || !isDeepStrictEqual(proof.previousEvidence, envelope.lastEvidence)
    || proof.accountChanged !== false) throw new Error("SPOT_MIGRATION_EVIDENCE_MISMATCH");
  const migrationEvidence = { file: proofFile, sha256: sha(proofBytes) };
  const migrated: Envelope = { ...envelope, state, runtimeSourceSha256: sourceSha256,
    lastEvidence: migrationEvidence, migrationEvidence };
  await durableFile(join(root, "state.json"), JSON.stringify(migrated) + "\n", false);
  return migrated;
}

export async function runSpotPaper(args = process.argv.slice(2)) {
  if (args.length !== 4 || !["--once", "--serve"].includes(args[3]!))
    throw new Error("Usage: node dist/src/spot-trend/paper-main.js STUDY_DIRECTORY AUDIT_FILE STATE_DIRECTORY --once|--serve");
  const [studyDirectory, auditFile, stateDirectory, mode] = args as [string, string, string, string];
  const evidence = await loadSpotPaperEvidence(studyDirectory, auditFile);
  const root = resolve(stateDirectory), file = join(root, "state.json"), sourceSha256 = await runtimeHash();
  await mkdir(root, { recursive: true }); await mkdir(join(root, "cycles"), { recursive: true });
  const releaseLock = await acquireLock(root);
  let stopping = false, wake: (() => void) | undefined;
  const stop = () => { stopping = true; wake?.(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  let server: ReturnType<typeof createServer> | undefined;
  try {
    let envelope = await loadSpotPaperEnvelope(file, root);
    if (!envelope) {
      envelope = { version: "spot-paper-journal-v1", state: createSpotPaperState(evidence.evidenceSha256, Date.now()),
        runtimeSourceSha256: sourceSha256, lastEvidence: null, receiptEvidence: {} };
      await durableFile(file, JSON.stringify(envelope) + "\n", false);
    }
    if (String(envelope.state.version) === LEGACY_SPOT_VERSION)
      envelope = await migrateSpotPaperEnvelope(envelope, root, sourceSha256);
    if (envelope.state.evidenceSha256 !== evidence.evidenceSha256 || envelope.runtimeSourceSha256 !== sourceSha256)
      throw new Error("SPOT_PAPER_VERSION_OR_EVIDENCE_CHANGED_REVIEW_REQUIRED");
    let lastError: string | null = envelope.state.lastDecision?.mark === null
      || envelope.state.lastDecision?.reason.startsWith("HISTORY_UNAVAILABLE") ? envelope.state.lastDecision.reason : null;
    let lastSuccessMs = envelope.state.lastDecision?.mark && !lastError ? envelope.state.lastCycleMs : 0;
    const status = () => ({ system: "BTC spot weekly trend", mode: "RESEARCH_PAPER", liveTradingEnabled: false,
      orderSubmissionEnabled: true, orderExecutionMode: "LOCAL_SPOT_PAPER_BROKER",
      provenProfitable: false, strategy: SPOT_PAPER_SPEC,
      healthy: lastError === null && lastSuccessMs > 0 && Date.now() - lastSuccessMs < 2 * SPOT_PAPER_SPEC.cycleIntervalMs,
      lastError, lastSuccessMs, evidence: evidence.summary, state: envelope!.state });
    if (mode === "--serve") {
      server = createServer((request, response) => {
        if (!["/", "/status", "/healthz"].includes(request.url ?? "")) { response.writeHead(404); response.end(); return; }
        const result = status(); response.writeHead(request.url === "/healthz" && !result.healthy ? 503 : 200,
          { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(result));
      });
      await new Promise<void>((resolveReady, reject) => { server!.once("error", reject); server!.listen(3002, "0.0.0.0", resolveReady); });
    }
    do {
      let persistenceStarted = false;
      try {
        const market = await fetchSpotMarketSnapshot(), nowMs = Date.now();
        if (stopping) break;
        const before = envelope.state, advanced = prepareSpotPaperCycle(before, market, nowMs);
        if (advanced.state === before) throw new Error("SPOT_DUPLICATE_CYCLE_CLOCK");
        const cycleFile = `cycles/${advanced.state.cycles}-${nowMs}-submitted.json`;
        const cycleBytes = JSON.stringify({ recordedAtMs: nowMs, mode: "RESEARCH_PAPER", evidenceSha256: evidence.evidenceSha256,
          runtimeSourceSha256: sourceSha256, before, market, decision: advanced.decision, after: advanced.state }) + "\n";
        persistenceStarted = true;
        await durableFile(join(root, cycleFile), cycleBytes, true);
        const proof = { file: cycleFile, sha256: sha(cycleBytes) };
        const next: Envelope = { ...envelope, state: advanced.state, lastEvidence: proof,
          receiptEvidence: { ...envelope.receiptEvidence, ...(advanced.decision.fill ? { [advanced.decision.fill.id]: proof } : {}) } };
        await durableFile(file, JSON.stringify(next) + "\n", false);
        envelope = next;
        if (!stopping && envelope.state.orders.some(order => ["SUBMITTED", "ACCEPTED"].includes(order.status))) {
          const settleMs = Date.now(), submitted = envelope.state;
          const settled = settleSpotPaperCycle(submitted, market, settleMs);
          const settlementFile = `cycles/${settled.state.cycles}-${settleMs}-settled.json`;
          const settlementBytes = JSON.stringify({ recordedAtMs: settleMs, mode: "RESEARCH_PAPER",
            phase: "BROKER_SETTLEMENT", submittedEvidence: envelope.lastEvidence,
            evidenceSha256: evidence.evidenceSha256, runtimeSourceSha256: sourceSha256,
            before: submitted, market, decision: settled.decision, after: settled.state }) + "\n";
          await durableFile(join(root, settlementFile), settlementBytes, true);
          const settlementProof = { file: settlementFile, sha256: sha(settlementBytes) };
          const settledEnvelope: Envelope = { ...envelope, state: settled.state, lastEvidence: settlementProof,
            receiptEvidence: { ...envelope.receiptEvidence, ...(settled.decision.fill ? { [settled.decision.fill.id]: settlementProof } : {}) } };
          await durableFile(file, JSON.stringify(settledEnvelope) + "\n", false);
          envelope = settledEnvelope;
        }
        const decision = envelope.state.lastDecision!;
        lastError = market.historyError ?? (decision.mark === null || decision.reason.startsWith("HISTORY_UNAVAILABLE") ? decision.reason : null);
        if (!lastError) lastSuccessMs = envelope.state.lastCycleMs;
        process.stdout.write(JSON.stringify({ timestampMs: envelope.state.lastCycleMs, mode: "RESEARCH_PAPER", cycle: envelope.state.cycles,
          action: decision.action, reason: decision.reason, orderId: decision.orderId ?? null,
          submittedOrders: envelope.state.orders.length,
          cashUsd: envelope.state.account.cashUsd, quantity: envelope.state.account.quantity,
          realizedNetUsd: envelope.state.account.realizedNetUsd,
          liquidationNetUsd: decision.mark?.netPnlUsd ?? null, liveTradingEnabled: false }) + "\n");
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        process.stderr.write(JSON.stringify({ timestampMs: Date.now(), mode: "RESEARCH_PAPER", error: lastError }) + "\n");
        // A rename may have committed even if a later directory fsync failed. Never continue from possibly stale memory.
        if (persistenceStarted || mode === "--once") throw error;
      }
      if (mode === "--once" || stopping) break;
      await new Promise<void>(resolveWait => { const timer = setTimeout(resolveWait, SPOT_PAPER_SPEC.cycleIntervalMs);
        wake = () => { clearTimeout(timer); resolveWait(); }; if (stopping) wake(); });
    } while (!stopping);
    await durableFile(join(root, `status-${Date.now()}.json`), JSON.stringify(status(), null, 2) + "\n", true);
    return status();
  } finally {
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
    if (server) await new Promise<void>(resolveClosed => server!.close(() => resolveClosed()));
    await releaseLock();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runSpotPaper();
