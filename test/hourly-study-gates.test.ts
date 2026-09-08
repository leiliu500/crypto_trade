import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runHourlyFinalTest } from "../src/research/hourly-study-main.js";

test("hourly final-test runner refuses failed development before reading reserved outcomes", async () => {
  const out = await mkdtemp(join(tmpdir(), "hourly-denied-"));
  await writeFile(join(out, "selection.json"), JSON.stringify({ developmentGatePassed: false }));
  await assert.rejects(runHourlyFinalTest(join(out, "missing-reserved-data.json"), out), /FINAL_TEST_DENIED_DEVELOPMENT_FAILED/);
  await assert.rejects(readFile(join(out, "final-test-start.json")), { code: "ENOENT" });
});
test("hourly final-test runner rejects changed data before opening its final-test marker", async () => {
  const out = await mkdtemp(join(tmpdir(), "hourly-seal-"));
  await writeFile(join(out, "selection.json"), JSON.stringify({ developmentGatePassed: true, dataSha256: "original-data-hash" }));
  await writeFile(join(out, "changed-data.json"), JSON.stringify({ bars: [], funding: [] }));
  await assert.rejects(runHourlyFinalTest(join(out, "changed-data.json"), out), /FINAL_TEST_SEAL_MISMATCH/);
  await assert.rejects(readFile(join(out, "final-test-start.json")), { code: "ENOENT" });
});
