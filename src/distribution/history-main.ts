import { prepareDistributionHistory } from "./history-replay.js";

const args = process.argv.slice(2), files: string[] = [], flags = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (!arg.startsWith("--")) { files.push(arg); continue; }
  const equals = arg.indexOf("="), key = equals < 0 ? arg.slice(2) : arg.slice(2, equals);
  const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
  if (!["out", "as-of"].includes(key) || flags.has(key) || !value || value.startsWith("--"))
    throw new Error(`Invalid or duplicate option ${arg}`);
  flags.set(key, value);
}
const cutoffMs = flags.has("as-of") ? Date.parse(flags.get("as-of")!) : Date.now();
if (!files.length || !flags.has("out") || !Number.isSafeInteger(cutoffMs) || cutoffMs < 0)
  throw new Error("Usage: history-main --out PATH [--as-of ISO] frozen-chronological-recording.jsonl[.gz] ...");
const result = await prepareDistributionHistory(files, flags.get("out")!, cutoffMs);
process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
