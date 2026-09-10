import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, rename } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Atomic replacement, with file and directory durability. Callers must stop on any error. */
export async function durableSpotFile(file: string, bytes: string, exclusive: boolean): Promise<void> {
  const temporary = exclusive ? file : `${file}.pending-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  if (!exclusive) await rename(temporary, file);
  const directory = await open(resolve(file, ".."), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/**
 * Linux flock belongs to the open file description. The child locks an inherited
 * duplicate of our descriptor; our still-open descriptor holds it until close/crash.
 * No PID namespace assumptions, stale-file deletion, or abandoned-lock recovery.
 */
export async function acquireSpotPaperLock(root: string): Promise<() => Promise<void>> {
  const handle = await open(join(root, "runner.lock"), "a+", 0o600);
  try {
    await new Promise<void>((resolveLocked, reject) => {
      const child = spawn("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "pipe", handle.fd] });
      let errorText = "";
      child.stderr?.on("data", (chunk: Buffer) => { errorText += chunk.toString("utf8").slice(0, 1024); });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolveLocked()
        : reject(new Error(`SPOT_PAPER_LOCK_UNAVAILABLE:${code}:${errorText.trim()}`)));
    });
    return () => handle.close();
  } catch (error) { await handle.close(); throw error; }
}
