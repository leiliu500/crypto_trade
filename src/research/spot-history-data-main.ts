import { pathToFileURL } from "node:url";
import { downloadSpotHistoryDataset } from "./spot-history-data.js";

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || !args[0]) throw new Error("Usage: npx tsx src/research/spot-history-data-main.ts NEW_OUTPUT_DIRECTORY");
  const dataset = await downloadSpotHistoryDataset(args[0]);
  process.stdout.write(JSON.stringify({ output: args[0], coverage: dataset.coverage, strategyPerformanceComputed: false }) + "\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
