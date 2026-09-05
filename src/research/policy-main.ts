import { loadConfig } from "../config.js";
import { loadLocalEnv } from "../env.js";
import { PolicyStore } from "./policy-store.js";

loadLocalEnv();
const cfg = loadConfig(process.env);
const store = new PolicyStore(cfg.databaseUrl);
try {
  const report = await store.evaluate(cfg.configurationVersion, !process.argv.includes("--no-save"));
  const output = process.argv.includes("--summary") ? {
    configurationVersion: report.configurationVersion, policyVersion: report.policyVersion,
    generatedAtMs: report.generatedAtMs, evidenceEndMs: report.evidenceEndMs,
    observations: report.observations, cohorts: report.evaluations.length, promoted: report.models.length,
    evaluations: report.evaluations.map(({ folds, model, ...evaluation }) => evaluation),
  } : report;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally { await store.close(); }
