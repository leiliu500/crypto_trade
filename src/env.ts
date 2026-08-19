import { existsSync } from "node:fs";

/** Load local development configuration without ever printing secret values. */
export function loadLocalEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  process.loadEnvFile(path);
}
