import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { ETH40_SPEC, DAY_MS } from "./spec.js";
import type { Asset, DailyBar } from "./types.js";

export const SEED_PATH = "reports/parallel-strategy-study-2026-09-10/data/dataset.json";
export const SEED_SHA256 = "951499efbfe353842f55b78b94e7d0fe1ba642afa2867f077810835f2303a45e";
export const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const codeFiles = ["types", "spec", "bootstrap", "engine", "market", "store", "status", "paper-main"];

export async function loadEth40Bootstrap(): Promise<{
  manifest: unknown; histories: Record<Asset, DailyBar[]>;
}> {
  const bytes = await readFile(SEED_PATH);
  if (hash(bytes) !== SEED_SHA256) throw new Error("ETH40_FROZEN_SEED_CHANGED");
  const input = JSON.parse(bytes.toString("utf8")) as Record<Asset, Array<Omit<DailyBar, "openTimeMs"> & { openMs: number }>>;
  const histories = {} as Record<Asset, DailyBar[]>;
  for (const symbol of ["ETH/USD", "BTC/USD"] as const) {
    histories[symbol] = input[symbol].map(({ openMs, ...bar }) => ({ openTimeMs: openMs, ...bar }));
    if (histories[symbol].length !== 720 || histories[symbol][0]?.openTimeMs !== Date.UTC(2024, 8, 20)
      || histories[symbol].some((bar, i, all) => ![bar.open, bar.high, bar.low, bar.close, bar.volume].every(x => Number.isFinite(x) && x > 0)
        || bar.openTimeMs % DAY_MS !== 0 || i > 0 && bar.openTimeMs !== all[i - 1]!.openTimeMs + DAY_MS))
      throw new Error(`ETH40_INVALID_SEED:${symbol}`);
  }
  const files = [
    "package.json", "package-lock.json", "node_modules/ws/package.json",
    "node_modules/ws/index.js", "node_modules/ws/wrapper.mjs",
    ...(await readdir("node_modules/ws/lib")).filter(name => name.endsWith(".js")).sort().map(name => `node_modules/ws/lib/${name}`),
    ...codeFiles.flatMap(file => [`src/eth40/${file}.ts`, `dist/src/eth40/${file}.js`]),
    ...["account", "journal"].flatMap(file => [`src/spot-trend/${file}.ts`, `dist/src/spot-trend/${file}.js`]),
    "reports/profit-search-100-2026-09-10/forward-experiment.json",
    "reports/profit-search-100-2026-09-10/screen/development-lock.json", SEED_PATH,
  ];
  const fingerprints = await Promise.all(files.map(async file => ({ file, sha256: hash(await readFile(file)) })));
  const selection = JSON.parse(await readFile("reports/profit-search-100-2026-09-10/screen/development-lock.json", "utf8")) as { selectedId: string };
  if (selection.selectedId !== ETH40_SPEC.candidateId) throw new Error("ETH40_SELECTION_CHANGED");
  return { histories, manifest: { version: "eth40-frozen-runtime-v1", spec: ETH40_SPEC,
    runtimePlatform: { node: process.version, versions: process.versions, platform: process.platform, arch: process.arch },
    fingerprints, runtimeSha256: hash(JSON.stringify(fingerprints)),
    researchStatus: "Prospective paper observation; historical qualification failed. No automatic strategy updates or live orders.",
  } };
}
