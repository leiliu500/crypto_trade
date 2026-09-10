import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { collectCarryPublicSnapshot, carryMonitorReport } from "./monitor.js";
import { loadCarryResearchConfig } from "./config.js";

const output = process.argv[2];
if (!output) throw new Error("Usage: carry:monitor NEW_OUTPUT_DIRECTORY [CONFIG_PATH] [SAVED_PUBLIC_INPUT_JSON_GZ]");
const { config, configurationSha256 } = loadCarryResearchConfig(process.argv[3]);
await mkdir(output, { recursive: false });
const snapshot = process.argv[4] ? JSON.parse(gunzipSync(await readFile(process.argv[4])).toString("utf8"))
  : await collectCarryPublicSnapshot();
await writeFile(join(output, "public-input.json.gz"), gzipSync(JSON.stringify(snapshot)), { flag: "wx" });
const report = { ...carryMonitorReport(snapshot, config), configurationSha256 };
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
process.stdout.write(`${JSON.stringify({ output, capturedAtUtc: report.capturedAtUtc, scenarios: report.rows.length,
  activationAllowed: report.activationAllowed, validatedProfitability: report.validatedProfitability })}\n`);
