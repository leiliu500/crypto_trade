import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPredictiveAuditData } from "./predictive-audit-data.js";
import { REGIME_STUDY_SPEC, runRegimeAuditStudy } from "./regime-study.js";

const sourceFiles = ["src/distribution/regime-study.ts", "src/distribution/regime-study-main.ts", "src/distribution/regime-model.ts",
  "src/distribution/predictive-audit-data.ts", "src/distribution/model.ts", "src/distribution/spec.ts", "package.json", "package-lock.json"];
async function sourceHashes() { return Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path,
  createHash("sha256").update(await readFile(path)).digest("hex")]))); }

export async function runArchivedRegimeComparisons(inputDirectory: string, outputDirectory: string) {
  const initial = await sourceHashes(), inputs = [
    { name: "first", stem: "conditional-development-20260908", protocol: "first-protocol" },
    { name: "later", stem: "conditional-later-v2-20260908", protocol: "later-protocol" },
  ];
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "candidate-manifest.json"), JSON.stringify({ version: REGIME_STUDY_SPEC.version,
    createdAtMs: Date.now(), spec: REGIME_STUDY_SPEC, sourceHashes: initial, inputs,
    untouched: false, evidenceClass: "INSPECTED_HISTORICAL_DEVELOPMENT" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const reports = [];
  for (const input of inputs) {
    const dataset = await loadPredictiveAuditData({ reportPath: join(inputDirectory, input.stem + ".json"),
      auditPath: join(inputDirectory, input.stem + ".json.audit.jsonl.gz"), seedPath: join(inputDirectory, input.protocol, "seed.json"),
      protocolPath: join(inputDirectory, input.protocol, "protocol.json") });
    const report = runRegimeAuditStudy(dataset), path = join(outputDirectory, input.name + ".json");
    await writeFile(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    reports.push({ name: input.name, report: path, source: report.source, predictions: report.predictions,
      opportunities: report.opportunities, policy: report.policy.aggregates, forecastsSha256: report.forecastsSha256 });
    process.stdout.write(JSON.stringify({ completed: input.name, report: path, probes: dataset.probes.length }) + "\n");
  }
  const final = await sourceHashes();
  if (JSON.stringify(initial) !== JSON.stringify(final)) {
    await writeFile(join(outputDirectory, "incomplete.json"), JSON.stringify({ status: "SOURCE_CHANGED_DURING_RUN",
      sourceHashes: initial, finalSourceHashes: final }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    throw new Error("REGIME_STUDY_SOURCE_CHANGED_DURING_RUN");
  }
  const summary = { version: REGIME_STUDY_SPEC.version, status: "DEVELOPMENT_COMPARISONS_COMPLETE", sourceHashes: initial,
    finalSourceHashes: final, sourceHashesUnchanged: true, reports, automaticPromotion: false, deploymentReady: false, profitabilityEstablished: false };
  await writeFile(join(outputDirectory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("Usage: regime-study-main INPUT_STUDY_DIRECTORY NEW_OUTPUT_DIRECTORY");
  await runArchivedRegimeComparisons(resolve(process.argv[2]!), resolve(process.argv[3]!));
}
