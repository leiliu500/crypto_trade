import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadHourlyDataset, type HourlyDownloadOptions } from "./hourly-data.js";

export function parseHourlyDataArgs(args: readonly string[]): HourlyDownloadOptions {
  const result: HourlyDownloadOptions = { out: "reports/hourly-model-study-2026-09-08/data" }, seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i], value = args[++i];
    if (!key || !["--out", "--start", "--end", "--funding-url"].includes(key) || !value || value.startsWith("--") || seen.has(key))
      throw new Error("INVALID_HOURLY_DATA_OPTION");
    seen.add(key);
    if (key === "--out") result.out = value;
    else if (key === "--funding-url") result.fundingUrl = value;
    else if (key === "--start") result.startMs = Date.parse(value);
    else result.endMs = Date.parse(value);
  }
  return result;
}
export async function runHourlyDataCli(args: readonly string[]) {
  const result = await downloadHourlyDataset(parseHourlyDataArgs(args), {
    onProgress: progress => process.stdout.write(`${JSON.stringify(progress)}\n`),
  });
  process.stdout.write(`${JSON.stringify({ dataset: result.datasetPath, sha256: result.manifest.datasetSha256,
    coverage: result.dataset.metadata.coverage, fundingTimestampVerified: result.dataset.metadata.funding.timestampConventionVerified })}\n`);
  return result;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runHourlyDataCli(process.argv.slice(2)).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
