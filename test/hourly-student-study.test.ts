import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runStudentStudy, studentEvaluationSymbols, studentTrainingPartition, STUDENT_STUDY_PROTOCOL } from "../src/research/hourly-student-study-main.js";

const H = 3_600_000, DAY = 24 * H, CUTOFF = Date.UTC(2024, 5, 1), CALIBRATION = CUTOFF - 30 * DAY;
type Row = Parameters<typeof studentTrainingPartition>[0][number];
const row = (decisionMs: number, completedAtMs = decisionMs + 27 * H, target = 1, status = "COMPLETE"): Row =>
  ({ decisionMs, completedAtMs, target, status, features: Array<number>(12).fill(0) });

test("development compares both assets while later stages score only each asset's sealed candidate", () => {
  const student = "student-t-boost-net-24h", linear = "matched-linear-net-24h";
  for (const candidate of [student, linear] as const)
    assert.deepEqual(studentEvaluationSymbols(candidate), ["BTC/USD", "ETH/USD"]);
  const split = { "BTC/USD": student, "ETH/USD": linear } as const;
  assert.deepEqual(studentEvaluationSymbols(student, split), ["BTC/USD"]);
  assert.deepEqual(studentEvaluationSymbols(linear, split), ["ETH/USD"]);
  for (const candidate of [student, linear] as const) {
    assert.deepEqual(studentEvaluationSymbols(candidate, {}), []);
    assert.deepEqual(studentEvaluationSymbols(candidate, { "BTC/USD": null, "ETH/USD": null }), []);
  }
  assert.deepEqual(studentEvaluationSymbols(student, { "BTC/USD": student, "ETH/USD": student }), ["BTC/USD", "ETH/USD"]);
  assert.deepEqual(studentEvaluationSymbols(linear, { "BTC/USD": student, "ETH/USD": student }), []);
  assert.deepEqual(studentEvaluationSymbols(student, { "BTC/USD": student }), ["BTC/USD"]);
});

test("training uses exactly the preceding 365 days and excludes the 51-hour pre-calibration decision boundary", () => {
  const start = CUTOFF - 365 * DAY;
  const rows = [row(start - H), row(start), row(CALIBRATION - 52 * H), row(CALIBRATION - 51 * H), row(CALIBRATION - H)];
  const split = studentTrainingPartition(rows, CUTOFF);
  assert.deepEqual(split.fit, [rows[1], rows[2]]);
  assert.deepEqual(split.calibration, []);
});

test("calibration starts exactly 30 days before cutoff and strictly purges the last 51 decision hours", () => {
  const rows = [row(CALIBRATION - H), row(CALIBRATION), row(CUTOFF - 52 * H), row(CUTOFF - 51 * H),
    row(CUTOFF - H), row(CUTOFF), row(CUTOFF + H)];
  const split = studentTrainingPartition(rows, CUTOFF);
  assert.deepEqual(split.fit, []);
  assert.deepEqual(split.calibration, [rows[1], rows[2]]);
});

test("completion receipts must be strictly before their fit or calibration cutoff independently of decision purges", () => {
  const fitDecision = CALIBRATION - 72 * H, calibrationDecision = CUTOFF - 72 * H;
  const rows = [row(fitDecision, CALIBRATION - H), row(fitDecision, CALIBRATION), row(fitDecision, CALIBRATION + H),
    row(calibrationDecision, CUTOFF - H), row(calibrationDecision, CUTOFF), row(calibrationDecision, CUTOFF + H)];
  const split = studentTrainingPartition(rows, CUTOFF);
  assert.deepEqual(split.fit, [rows[0]]);
  assert.deepEqual(split.calibration, [rows[3]]);
  assert.ok(split.fit.every(r => r.completedAtMs < CALIBRATION));
  assert.ok(split.calibration.every(r => r.completedAtMs < CUTOFF));
});

test("known nonfills receive the same fixed purge as filled labels despite their early zero-return receipts", () => {
  const rows = [row(CALIBRATION - 52 * H, CALIBRATION - 50 * H, 0, "UNFILLED"),
    row(CALIBRATION - 51 * H, CALIBRATION - 49 * H, 0, "UNFILLED"),
    row(CUTOFF - 52 * H, CUTOFF - 50 * H, 0, "UNFILLED"),
    row(CUTOFF - 51 * H, CUTOFF - 49 * H, 0, "UNFILLED")];
  const split = studentTrainingPartition(rows, CUTOFF);
  assert.deepEqual(split.fit, [rows[0]]);
  assert.deepEqual(split.calibration, [rows[2]]);
  assert.equal(split.fit[0]!.target, 0); assert.equal(split.calibration[0]!.status, "UNFILLED");
});

test("partitioning preserves known targets and metadata, is disjoint, and cannot use future calibration changes in fit rows", () => {
  const inputs = [row(CUTOFF - 200 * DAY, undefined, -20), row(CUTOFF - 100 * DAY, undefined, 15),
    row(CALIBRATION + H, undefined, -50), row(CUTOFF - 80 * H, undefined, 0, "UNFILLED"),
    row(CUTOFF + H, undefined, 10000)];
  const before = structuredClone(inputs), split = studentTrainingPartition(inputs, CUTOFF);
  assert.deepEqual(inputs, before);
  assert.deepEqual(split.fit.map(r => r.target), [-20, 15]);
  assert.deepEqual(split.calibration.map(r => r.target), [-50, 0]);
  assert.equal(split.fit.some(r => split.calibration.includes(r)), false);
  const altered = inputs.map(r => r.decisionMs >= CALIBRATION
    ? { ...r, target: 1e9, features: Array<number>(12).fill(1000) } : r);
  assert.deepEqual(studentTrainingPartition(altered, CUTOFF).fit, split.fit);
  assert.deepEqual(studentTrainingPartition([], CUTOFF), { fit: [], calibration: [] });
});

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
// Source fingerprints only. These stage tests intentionally have no historical
// datasets and cannot open a model, calculate historical returns, or place orders.
const SOURCES = ["src/research/hourly-data.ts", "src/research/hourly-volume-features.ts", "src/research/hourly-net-labels.ts",
  "src/research/hourly-student-model.ts", "src/research/hourly-net-calibration.ts", "src/research/hourly-student-study-main.ts",
  "src/research/hourly-retry-simulator.ts", "src/research/hourly-adaptive-study-gates.ts", "src/research/hourly-study-statistics.ts",
  "reports/distribution-instrument-rules-2026-09-07.json", "package.json", "package-lock.json"];
async function directory(t: TestContext) {
  const output = await mkdtemp(join(tmpdir(), "student-study-gates-"));
  t.after(() => rm(output, { recursive: true, force: true })); return output;
}
async function receipt(output: string, stage: "develop" | "confirm", summary: "selection.json" | "confirmation.json") {
  await writeJson(join(output, `${stage}-start.json`), {});
  await writeJson(join(output, `${stage}-portfolio.json`), {});
  const names = [summary, `${stage}-start.json`, `${stage}-portfolio.json`];
  const artifacts = Object.fromEntries(await Promise.all(names.map(async name => [name, digest(await readFile(join(output, name)))])));
  await writeJson(join(output, `${stage}-integrity.json`), { stage, artifacts });
}
async function selectionFixture(output: string) {
  await writeJson(join(output, "protocol.json"), { definition: STUDENT_STUDY_PROTOCOL });
  const sourceHashes = Object.fromEntries(await Promise.all(SOURCES.map(async path => [path, digest(await readFile(path))])));
  const seal = { sourceHashes, protocolSha256: digest(await readFile(join(output, "protocol.json"))), dataSeal: {} };
  await writeJson(join(output, "selection.json"), { ...seal, developmentGatePassed: true,
    selectedByAsset: { "BTC/USD": "student-t-boost-net-24h", "ETH/USD": "matched-linear-net-24h" } });
  await receipt(output, "develop", "selection.json"); return seal;
}
const runMissing = (stage: "develop" | "confirm" | "test", output: string) => runStudentStudy(stage,
  join(output, "UNOPENED_MISSING_OLDER_DATA"), join(output, "UNOPENED_MISSING_RECENT_DATA"), output);
const noMarker = (output: string, stage: "develop" | "confirm" | "test") =>
  assert.rejects(readFile(join(output, `${stage}-start.json`)), { code: "ENOENT" });

test("registration writes the two-candidate protocol without accessing data or enabling orders", async t => {
  const output = await directory(t);
  const result = await runStudentStudy("register", "MISSING_OLDER", "MISSING_RECENT", output);
  assert.equal(result.status, "STUDENT_PROTOCOL_REGISTERED_NO_RETURNS_EVALUATED");
  assert.deepEqual(await readdir(output), ["protocol.json"]);
  const saved = JSON.parse(await readFile(join(output, "protocol.json"), "utf8"));
  assert.deepEqual(saved.definition.candidates, ["student-t-boost-net-24h", "matched-linear-net-24h"]);
  assert.equal(saved.definition.commonAvailabilityPurgeHours, 51);
  assert.equal(saved.definition.calibrationDays, 30); assert.equal(saved.definition.trailingDays, 365);
  assert.equal(saved.definition.features.featureDimension, 12);
  assert.equal(saved.definition.labels.capacityUsd, 12);
  assert.equal(saved.definition.periods.test.end, Date.UTC(2026, 7, 1));
  assert.equal(saved.definition.realOrdersAllowed, false); assert.equal(saved.definition.noAutomaticActivation, true);
  await assert.rejects(runStudentStudy("register", "MISSING_OLDER", "MISSING_RECENT", output), { code: "EEXIST" });
});

test("failed development denies confirmation and final stages before seals, data, or open markers", async t => {
  for (const stage of ["confirm", "test"] as const) {
    const output = await directory(t); await writeJson(join(output, "selection.json"), { developmentGatePassed: false });
    await assert.rejects(runMissing(stage, output), /STUDENT_STAGE_DENIED_DEVELOPMENT_FAILED/);
    await noMarker(output, stage);
  }
});

test("changed protocol prevents development before loading datasets", async t => {
  const output = await directory(t);
  await writeJson(join(output, "protocol.json"), { definition: { ...STUDENT_STUDY_PROTOCOL, commonAvailabilityPurgeHours: 0 } });
  await assert.rejects(runMissing("develop", output), /STUDENT_PROTOCOL_CHANGED/); await noMarker(output, "develop");
});

test("source and protocol fingerprint mismatches prevent confirmation before loading datasets", async t => {
  for (const changed of ["source", "protocol"] as const) {
    const output = await directory(t); await selectionFixture(output);
    const path = join(output, "selection.json"), selected = JSON.parse(await readFile(path, "utf8"));
    if (changed === "source") selected.sourceHashes[SOURCES[0]!] = "changed";
    else selected.protocolSha256 = "changed";
    await writeJson(path, selected);
    await assert.rejects(runMissing("confirm", output), /STUDENT_STUDY_SEAL_MISMATCH/); await noMarker(output, "confirm");
  }
});

test("edited asset choices fail the saved development artifact receipt", async t => {
  const output = await directory(t); await selectionFixture(output);
  const path = join(output, "selection.json"), selected = JSON.parse(await readFile(path, "utf8"));
  selected.selectedByAsset["BTC/USD"] = "matched-linear-net-24h"; await writeJson(path, selected);
  await assert.rejects(runMissing("confirm", output), /STUDENT_ARTIFACT_CHANGED/); await noMarker(output, "confirm");
});

test("missing required artifacts or wrong receipt stage deny confirmation", async t => {
  for (const missing of ["selection.json", "develop-start.json", "develop-portfolio.json", "stage"] as const) {
    const output = await directory(t); await selectionFixture(output);
    const path = join(output, "develop-integrity.json"), value = JSON.parse(await readFile(path, "utf8"));
    if (missing === "stage") value.stage = "confirm"; else delete value.artifacts[missing];
    await writeJson(path, value);
    await assert.rejects(runMissing("confirm", output), /STUDENT_INCOMPLETE_ARTIFACT_RECEIPT/); await noMarker(output, "confirm");
  }
});

test("changed portfolio bytes and path traversal in receipts fail before data access", async t => {
  for (const change of ["bytes", "path"] as const) {
    const output = await directory(t); await selectionFixture(output);
    if (change === "bytes") await writeJson(join(output, "develop-portfolio.json"), { changed: true });
    else {
      const path = join(output, "develop-integrity.json"), value = JSON.parse(await readFile(path, "utf8"));
      value.artifacts["../escape.json"] = "changed"; await writeJson(path, value);
    }
    await assert.rejects(runMissing("confirm", output), /STUDENT_ARTIFACT_CHANGED/); await noMarker(output, "confirm");
  }
});

test("failed confirmation keeps the final period closed", async t => {
  const output = await directory(t); await selectionFixture(output);
  await writeJson(join(output, "confirmation.json"), { confirmationGatePassed: false });
  await assert.rejects(runMissing("test", output), /STUDENT_FINAL_DENIED_CONFIRMATION_FAILED/); await noMarker(output, "test");
});

test("final stage requires the original selection reference and unchanged confirmation artifacts", async t => {
  for (const change of ["selection-reference", "confirmation-bytes"] as const) {
    const output = await directory(t), seal = await selectionFixture(output);
    await writeJson(join(output, "confirmation.json"), { ...seal, confirmationGatePassed: true,
      selectionSha256: change === "selection-reference" ? "changed" : digest(await readFile(join(output, "selection.json"))) });
    await receipt(output, "confirm", "confirmation.json");
    if (change === "confirmation-bytes") await writeJson(join(output, "confirm-portfolio.json"), { changed: true });
    await assert.rejects(runMissing("test", output), change === "selection-reference" ? /STUDENT_SELECTION_CHANGED/ : /STUDENT_ARTIFACT_CHANGED/);
    await noMarker(output, "test");
  }
});

test("valid stage seals reach the intentionally missing datasets without creating an evaluation marker", async t => {
  const output = await directory(t); await selectionFixture(output);
  await assert.rejects(runMissing("confirm", output), error => {
    const value = error as NodeJS.ErrnoException;
    return value.code === "ENOENT" && (value.path?.includes("UNOPENED_MISSING_") ?? false);
  });
  await noMarker(output, "confirm");
});
