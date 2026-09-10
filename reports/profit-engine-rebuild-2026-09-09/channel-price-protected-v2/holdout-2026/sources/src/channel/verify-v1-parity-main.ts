import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadHourlyDataset, type FundingRow, type HourlyBar } from "../research/hourly-data.js";
import { CHANNEL_STUDY_SPEC as D } from "./spec.js";
import { replayChannel } from "./replay.js";
const SHA = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const original = "reports/profit-engine-rebuild-2026-09-09/channel", out = process.argv[2];
if (!out || process.argv.length !== 3) throw new Error("Usage: npx tsx src/channel/verify-v1-parity-main.ts NEW_V2_OUTPUT_DIRECTORY");
const protocol = JSON.parse(await readFile(join(original, "protocol.json"), "utf8")) as { sourceHashes: Record<string, string>; permittedDataSha256: string };
for (const [path, hash] of Object.entries(protocol.sourceHashes))
  if (SHA(await readFile(join(original, "sources", path))) !== hash) throw new Error(`ORIGINAL_CHANNEL_SOURCE_COPY_CHANGED:${path}`);
const inputs = ["reports/hourly-adaptive-study-2026-09-08/data-older-restored", "reports/hourly-adaptive-study-2026-09-08/data-recent"];
const datasets = await Promise.all(inputs.map(loadHourlyDataset));
const bmap = new Map<string, HourlyBar>(), fmap = new Map<string, FundingRow>();
for (const dataset of datasets) {
  for (const row of dataset.bars) {
    if (row.openMs < D.warmupStartMs || row.openMs >= D.windows.at(-1)!.endMs) continue;
    const key = `${row.symbol}:${row.openMs}`, prior = bmap.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error("PARITY_CONFLICTING_BARS"); bmap.set(key, row);
  }
  for (const row of dataset.funding) {
    if (row.timestampMs <= D.warmupStartMs || row.timestampMs > D.windows.at(-1)!.endMs) continue;
    const key = `${row.symbol}:${row.timestampMs}`, prior = fmap.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error("PARITY_CONFLICTING_FUNDING"); fmap.set(key, row);
  }
}
const bars = [...bmap.values()].sort((a, b) => a.openMs - b.openMs || a.symbol.localeCompare(b.symbol));
const funding = [...fmap.values()].sort((a, b) => a.timestampMs - b.timestampMs || a.symbol.localeCompare(b.symbol));
if (SHA(JSON.stringify({ bars, funding })) !== protocol.permittedDataSha256) throw new Error("ORIGINAL_CHANNEL_INPUT_CHANGED");
const matches: Array<{ file: string; originalSha256: string; reproducedSha256: string; identical: boolean }> = [];
for (const window of D.windows) for (const scenario of D.scenarios) for (const policy of ["channel", "buy-hold-btc", "buy-hold-eth"] as const) {
  const file = `${window.id}-${scenario}-${policy}.json`, old = await readFile(join(original, file));
  const reproduced = JSON.stringify(replayChannel({ bars, funding, startMs: window.startMs, endMs: window.endMs, scenario, policy }), null, 2) + "\n";
  matches.push({ file, originalSha256: SHA(old), reproducedSha256: SHA(reproduced), identical: SHA(old) === SHA(reproduced) });
}
const sourcePaths = ["src/channel/spec.ts", "src/channel/replay.ts", "src/channel/verify-v1-parity-main.ts"];
const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, SHA(await readFile(path))])));
const report = { checkedAtUtc: new Date().toISOString(), originalProtocolSha256: SHA(await readFile(join(original, "protocol.json"))),
  allOriginalRunsIdentical: matches.length === 12 && matches.every(m => m.identical), matches, sourceHashes,
  v2StrategyOutcomesComputed: false, reserved2026Evaluated: false };
await mkdir(out, { recursive: true });
await writeFile(join(out, "v1-parity.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (!report.allOriginalRunsIdentical) throw new Error("CHANNEL_V1_REFACTOR_PARITY_FAILED");
