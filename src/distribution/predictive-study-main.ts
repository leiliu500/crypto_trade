import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPredictiveAuditData } from "./predictive-audit-data.js";
import { PREDICTIVE_STUDY_SPEC, runPredictiveAuditStudy } from "./predictive-study.js";

const sourceFiles = ["src/distribution/predictive-study.ts", "src/distribution/predictive-study-main.ts",
  "src/distribution/predictive-audit-data.ts", "src/distribution/cost-aware-model.ts", "src/distribution/model.ts",
  "src/distribution/spec.ts", "package.json", "package-lock.json"];
async function currentSourceHashes() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file,
    createHash("sha256").update(await readFile(file)).digest("hex")])));
}

export async function runArchivedPredictiveComparisons(inputDirectory: string, outputDirectory: string) {
  const sourceHashes = await currentSourceHashes();
  const inputs = [
    { name: "first", stem: "conditional-development-20260908", protocol: "first-protocol" },
    { name: "later", stem: "conditional-later-v2-20260908", protocol: "later-protocol" },
  ];
  await mkdir(outputDirectory, { recursive: true });
  // Seal the single candidate, sources and prescribed windows before reading
  // any candidate forecast outcomes. Existing output cannot be overwritten.
  await writeFile(join(outputDirectory, "candidate-manifest.json"), `${JSON.stringify({
    version: PREDICTIVE_STUDY_SPEC.version, createdAtMs: Date.now(), spec: PREDICTIVE_STUDY_SPEC,
    sourceHashes, inputs, untouched: false, evidenceClass: "INSPECTED_HISTORICAL_DEVELOPMENT",
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const reports = [];
  for (const input of inputs) {
    const dataset = await loadPredictiveAuditData({
      reportPath: join(inputDirectory, `${input.stem}.json`), auditPath: join(inputDirectory, `${input.stem}.json.audit.jsonl.gz`),
      seedPath: join(inputDirectory, input.protocol, "seed.json"), protocolPath: join(inputDirectory, input.protocol, "protocol.json"),
    });
    const report = runPredictiveAuditStudy(dataset);
    const path = join(outputDirectory, `${input.name}.json`);
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    reports.push({ name: input.name, report: path, predictions: report.predictions, policy: report.policy.aggregates,
      source: report.source, forecastsSha256: report.forecastsSha256 });
    process.stdout.write(`${JSON.stringify({ completed: input.name, report: path, probes: dataset.probes.length })}\n`);
  }
  const finalSourceHashes = await currentSourceHashes();
  if (JSON.stringify(sourceHashes) !== JSON.stringify(finalSourceHashes)) {
    await writeFile(join(outputDirectory, "incomplete.json"), `${JSON.stringify({
      status: "SOURCE_CHANGED_DURING_RUN", sourceHashes, finalSourceHashes,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    throw new Error("PREDICTIVE_STUDY_SOURCE_CHANGED_DURING_RUN");
  }
  const summary = { version: PREDICTIVE_STUDY_SPEC.version, status: "DEVELOPMENT_COMPARISONS_COMPLETE",
    sourceHashes, finalSourceHashes, sourceHashesUnchanged: true,
    reports, automaticPromotion: false, deploymentReady: false, profitabilityEstablished: false };
  await writeFile(join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error("Usage: predictive-study-main INPUT_STUDY_DIRECTORY NEW_OUTPUT_DIRECTORY");
  await runArchivedPredictiveComparisons(resolve(process.argv[2]!), resolve(process.argv[3]!));
}
