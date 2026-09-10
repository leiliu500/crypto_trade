import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertPortfolioStageAllowed, runPortfolioStudy } from "../src/portfolio/study-main.js";
import { PORTFOLIO_PERIODS, PORTFOLIO_POLICIES, PORTFOLIO_SCENARIOS, PORTFOLIO_STUDY_PROTOCOL } from "../src/portfolio/protocol.js";

const hash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const write = (directory: string, file: string, value: unknown) => writeFile(join(directory, file), JSON.stringify(value));
async function passedFixture() {
  const directory = await mkdtemp(join(tmpdir(), "portfolio-stage-"));
  const registration = { protocol: PORTFOLIO_STUDY_PROTOCOL, sourceHashes: { fixture: "same-source" }, dataSeals: [{ fixture: "same-data" }] };
  await write(directory, "protocol.json", registration);
  const protocolSha256 = hash(await readFile(join(directory, "protocol.json")));
  const artifacts: Record<string, string> = {};
  for (const policy of PORTFOLIO_POLICIES) {
    for (const name of [`develop-${policy}-targets.json`, ...PORTFOLIO_SCENARIOS.map(s => `develop-${policy}-${s.id}.json`)]) {
      await write(directory, name, { fixture: name }); artifacts[name] = hash(await readFile(join(directory, name)));
    }
  }
  const summary = { passed: true, stage: "develop", period: PORTFOLIO_PERIODS.develop,
    protocolSha256, sourceHashes: registration.sourceHashes, dataSeals: registration.dataSeals, artifacts };
  await write(directory, "develop-summary.json", summary);
  await write(directory, "develop-integrity.json", { ...summary,
    summarySha256: hash(await readFile(join(directory, "develop-summary.json"))) });
  return { directory, registration, summary };
}
test("failed development denies later market-data access even when dataset paths are absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "portfolio-denial-"));
  await write(directory, "develop-summary.json", { passed: false });
  await assert.rejects(runPortfolioStudy("confirm", "/absent/older", "/absent/recent", directory), /PORTFOLIO_STAGE_DENIED_DEVELOP_FAILED/);
  await assert.rejects(readFile(join(directory, "confirm-start.json")), { code: "ENOENT" });
});
test("complete prior-stage receipts authorize next-stage eligibility only", async () => {
  const f = await passedFixture(); await assertPortfolioStageAllowed("confirm", f.directory);
});
test("copying prior success from another registration cannot authorize later data", async () => {
  const f = await passedFixture();
  await write(f.directory, "protocol.json", { ...f.registration, sourceHashes: { fixture: "different-source" } });
  await assert.rejects(assertPortfolioStageAllowed("confirm", f.directory), /REGISTRATION_MISMATCH/);
});
test("changed trade artifact fails the prior evidence seal", async () => {
  const f = await passedFixture();
  await write(f.directory, Object.keys(f.summary.artifacts)[0]!, { replaced: true });
  await assert.rejects(assertPortfolioStageAllowed("confirm", f.directory), /ARTIFACT_CHANGED/);
});
test("missing policy/scenario receipts cannot pass with a partial artifact dictionary", async () => {
  const f = await passedFixture(); const partial = { ...f.summary, artifacts: {} };
  await write(f.directory, "develop-summary.json", partial);
  await assert.rejects(assertPortfolioStageAllowed("confirm", f.directory), /INVALID_ARTIFACT_SEAL/);
});
test("test stage requires a confirmation result, not only successful development", async () => {
  const f = await passedFixture();
  await assert.rejects(assertPortfolioStageAllowed("test", f.directory), /CONFIRM_MISSING/);
});
