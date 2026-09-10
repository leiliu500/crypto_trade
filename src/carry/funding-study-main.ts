import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FUNDING_HOUR_MS as H, FUNDING_MODEL_SPEC, fundingMonthlyCohorts, summarizeFundingCohorts, type FundingObservation } from "./funding-model.js";

const output = process.argv[2];
if (!output) throw new Error("Usage: carry:funding-study NEW_OUTPUT_DIRECTORY");
const sourcePaths = ["docs/FUNDING_ECONOMIC_PROTOCOL.md", "src/carry/funding-model.ts", "src/carry/funding-study-main.ts",
  "test/carry-funding-model.test.ts"];
const inputPaths = ["reports/hourly-adaptive-study-2026-09-08/data-older-restored/dataset.json",
  "reports/hourly-adaptive-study-2026-09-08/data-recent/dataset.json"];
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const sources = await Promise.all(sourcePaths.map(async path => ({ path, sha256: sha(await readFile(path)) })));
const inputs = await Promise.all(inputPaths.map(async path => ({ path, bytes: await readFile(path) })));
await mkdir(output, { recursive: false });
// The preregistration is durable before JSON parsing, forecasts, or outcomes. Existing directories are refused.
await writeFile(join(output, "registration.json"), JSON.stringify({ registeredAtUtc: new Date().toISOString(),
  protocol: FUNDING_MODEL_SPEC, sources, inputs: inputs.map(i => ({ path: i.path, sha256: sha(i.bytes) })),
  publicationAvailabilityEvidence: "ASSUMED_EXTRA_ONE_HOUR_LAG_NOT_ARCHIVED_KNOWN_AT",
  permittedAccrualStartInclusive: "2023-01-01T00:00:00.000Z", permittedAccrualEndExclusive: "2026-01-01T00:00:00.000Z",
  priceReturnsInspected: false, untouchedTest: false, activationAllowed: false,
}, null, 2) + "\n", { flag: "wx" });

const byKey = new Map<string, FundingObservation>();
let identicalCrossFileRows = 0;
for (const input of inputs) {
  // Prices are never accessed. JSON funding end timestamps may include Jan 1 settlement of Dec 31 accrual.
  const parsed = JSON.parse(input.bytes.toString("utf8")) as { funding: FundingObservation[] };
  if (!Array.isArray(parsed.funding)) throw new Error("MISSING_FUNDING_ARRAY");
  const seenInFile = new Set<string>();
  for (const row of parsed.funding) {
    if (!Number.isSafeInteger(row.timestampMs)) throw new Error("INVALID_FUNDING_TIMESTAMP");
    const sourceTime = row.timestampMs - H;
    if (sourceTime < Date.UTC(2023, 0, 1) || sourceTime >= Date.UTC(2026, 0, 1)) continue;
    const key = `${row.symbol}:${row.timestampMs}`;
    if (seenInFile.has(key)) throw new Error(`DUPLICATE_WITHIN_INPUT:${key}`);
    seenInFile.add(key);
    const prior = byKey.get(key);
    if (prior) {
      if (prior.absoluteRate !== row.absoluteRate) throw new Error(`CONFLICTING_INPUTS:${key}`);
      identicalCrossFileRows++;
    } else byKey.set(key, { symbol: row.symbol, timestampMs: row.timestampMs, absoluteRate: row.absoluteRate });
  }
}
const rows = [...byKey.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.timestampMs - b.timestampMs);
const cohorts = FUNDING_MODEL_SPEC.symbols.flatMap(symbol => FUNDING_MODEL_SPEC.years.flatMap(year => fundingMonthlyCohorts(rows, symbol, year)));
const summaries = FUNDING_MODEL_SPEC.symbols.flatMap(symbol => FUNDING_MODEL_SPEC.years.map(year =>
  summarizeFundingCohorts(cohorts.filter(c => c.symbol === symbol && c.year === year)))) ;
const report = { schemaVersion: 1, completedAtUtc: new Date().toISOString(), scope: FUNDING_MODEL_SPEC.scope,
  originalInputSha256: inputs.map(i => ({ path: i.path, sha256: sha(i.bytes) })),
  normalizedPermittedFundingSha256: sha(JSON.stringify(rows)), normalizedRows: rows.length, identicalCrossFileRows,
  historyAvailability: "ASSUMED_EXTRA_ONE_HOUR_PUBLICATION_LAG", untouchedTest: false,
  validatedProfitability: false, activationAllowed: false, completeStrategyPnlUsd: null,
  limitations: ["FUNDING_FORECAST_ONLY", "PREVIOUSLY_OBSERVED_DEVELOPMENT_DATA", "NO_PAIRED_PRICE_EXECUTION_BACKTEST",
    "NO_ACTUAL_ACCOUNT_FEE_VERIFICATION", "SMALL_MONTHLY_SAMPLE", "MISSING_HOURS_MAKE_FULL_COHORT_UNKNOWN"],
  summaries, cohorts,
};
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
await writeFile(join(output, "integrity.json"), JSON.stringify({ checkedAtUtc: new Date().toISOString(),
  sourceUnchanged: (await Promise.all(sources.map(async s => sha(await readFile(s.path)) === s.sha256))).every(Boolean),
  reportSha256: sha(JSON.stringify(report, null, 2) + "\n"),
}, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify({ output, summaries, activationAllowed: false, completeStrategyPnlUsd: null }, null, 2) + "\n");
