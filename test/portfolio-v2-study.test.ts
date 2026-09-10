import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertRiskStageAllowed, expectedRiskArtifacts, runRiskStudy } from "../src/portfolio-v2/study-main.js";
import { PORTFOLIO_PERIODS, RISK_STUDY_PROTOCOL } from "../src/portfolio-v2/protocol.js";

const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const write = (d: string, f: string, v: unknown) => writeFile(join(d, f), JSON.stringify(v));
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "portfolio-risk-stage-"));
  const registration = { protocol: RISK_STUDY_PROTOCOL, sourceHashes: { fixture: "source-a" }, dataSeals: [{ fixture: "data-a" }] };
  await write(directory, "protocol.json", registration);
  const protocolSha256 = hash(await readFile(join(directory, "protocol.json")));
  const artifacts: Record<string, string> = {};
  for (const name of expectedRiskArtifacts("develop")) {
    await write(directory, name, { fixture: name }); artifacts[name] = hash(await readFile(join(directory, name)));
  }
  const selection = { selected: "sign-trend-90d", stage: "develop", protocolSha256,
    sourceHashes: registration.sourceHashes, dataSeals: registration.dataSeals };
  await write(directory, "selection.json", selection);
  const selectionSha256 = hash(await readFile(join(directory, "selection.json")));
  const summary = { passed: true, stage: "develop", period: PORTFOLIO_PERIODS.develop,
    protocolSha256, sourceHashes: registration.sourceHashes, dataSeals: registration.dataSeals, artifacts,
    selectedPolicy: "sign-trend-90d", selectionSha256 };
  await write(directory, "develop-summary.json", summary);
  await write(directory, "develop-integrity.json", { ...summary,
    summarySha256: hash(await readFile(join(directory, "develop-summary.json"))) });
  return { directory, summary, selection, registration };
}
test("risk study denies failed development before opening later datasets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "risk-denial-"));
  await write(directory, "develop-summary.json", { passed: false });
  await assert.rejects(runRiskStudy("confirm", "/missing-older", "/missing-recent", directory), /RISK_STAGE_DENIED_DEVELOP_FAILED/);
  await assert.rejects(readFile(join(directory, "confirm-start.json")), { code: "ENOENT" });
});
test("the complete development seal returns the frozen policy for confirmation", async () => {
  const f = await fixture(); assert.equal(await assertRiskStageAllowed("confirm", f.directory), "sign-trend-90d");
  assert.equal(expectedRiskArtifacts("develop").length, 33);
});
test("a changed selection cannot authorize confirmation", async () => {
  const f = await fixture(); await write(f.directory, "selection.json", { ...f.selection, selected: "multiscale-trend" });
  await assert.rejects(assertRiskStageAllowed("confirm", f.directory), /SELECTION_CHANGED/);
});
test("a different source registration and a changed execution artifact are rejected", async () => {
  const f = await fixture(); await write(f.directory, "protocol.json", { ...f.registration, sourceHashes: { fixture: "source-b" } });
  await assert.rejects(assertRiskStageAllowed("confirm", f.directory), /REGISTRATION_MISMATCH/);
  const g = await fixture(); await write(g.directory, Object.keys(g.summary.artifacts)[0]!, { changed: true });
  await assert.rejects(assertRiskStageAllowed("confirm", g.directory), /ARTIFACT_CHANGED/);
});
test("a complete development stage does not authorize reserved testing", async () => {
  const f = await fixture(); await assert.rejects(assertRiskStageAllowed("test", f.directory), /CONFIRM_MISSING/);
  await assert.rejects(readFile(join(f.directory, "test-start.json")), { code: "ENOENT" });
});
test("prototype names are not accepted as study stages", async () => {
  for (const stage of ["constructor", "toString", "__proto__"]) {
    await assert.rejects(runRiskStudy(stage as "test", "/missing", "/missing", "/missing"), /RISK_UNKNOWN_STAGE/);
    await assert.rejects(assertRiskStageAllowed(stage as "test", "/missing"), /RISK_UNKNOWN_STAGE/);
  }
});
