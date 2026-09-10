import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface RiskTrainingSourceHash { path: string; sha256: string }

/** Hash the canonical TypeScript dependency closure for both TS and compiled
 * runners. Runtime images must ship src alongside dist; compiled JS hashes are
 * deliberately never substituted for source identity. Literal local imports
 * include type dependencies, conservatively invalidating stale artifacts. */
export function readRiskTrainingSourceHashes(repositoryRoot?: string): RiskTrainingSourceHash[] {
  const here = fileURLToPath(import.meta.url);
  const root = repositoryRoot ?? resolve(dirname(here), here.endsWith(".ts") ? "../.." : "../../..");
  const sourceRoot = resolve(root, "src"), seen = new Set<string>(), hashes: RiskTrainingSourceHash[] = [];
  const pending = ["distribution/training-main.ts", "distribution/training-backfill.ts",
    "distribution/training-import.ts", "distribution/risk-training-source.ts", "engine/trading-engine.ts"]
    .map(path => resolve(sourceRoot, path));
  while (pending.length) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    if (!path.startsWith(`${sourceRoot}${sep}`)) throw new Error("RISK_TRAINING_SOURCE_OUTSIDE_SRC");
    seen.add(path);
    const bytes = readFileSync(path);
    hashes.push({ path: relative(root, path).split(sep).join("/"),
      sha256: createHash("sha256").update(bytes).digest("hex") });
    const imports = bytes.toString("utf8").matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g);
    for (const match of imports) {
      const specifier = match[1]!;
      if (!specifier.endsWith(".js") && !specifier.endsWith(".ts"))
        throw new Error(`RISK_TRAINING_UNSUPPORTED_SOURCE_IMPORT:${specifier}`);
      pending.push(resolve(dirname(path), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return hashes.sort((a, b) => a.path.localeCompare(b.path));
}
