import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { acquireSpotPaperLock, durableSpotFile } from "../src/spot-trend/journal.js";

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "spot-journal-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function externalContender(root: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("flock", ["-n", join(root, "runner.lock"), "true"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (part: Buffer) => { stderr += part.toString("utf8"); });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stderr }));
  });
}

interface Holder {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
}

function independentHolder(root: string, t: TestContext): Holder {
  const sourceTest = import.meta.url.endsWith(".ts");
  const moduleUrl = new URL(`../src/spot-trend/journal.${sourceTest ? "ts" : "js"}`, import.meta.url).href;
  const script = [
    `const { acquireSpotPaperLock } = await import(${JSON.stringify(moduleUrl)});`,
    `const release = await acquireSpotPaperLock(${JSON.stringify(root)});`,
    'process.stdout.write("LOCK_READY\\n");',
    'process.stdin.resume();',
    'await new Promise(resolve => process.stdin.once("end", resolve));',
    'await release();',
    'process.stdout.write("LOCK_RELEASED\\n");',
  ].join("\n");
  const child = spawn(process.execPath, [...(sourceTest ? ["--import", "tsx"] : []), "--input-type=module", "-e", script],
    { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", stdout = "";
  child.stderr.on("data", (part: Buffer) => { stderr += part.toString("utf8"); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`LOCK_HOLDER_READY_TIMEOUT:${stderr}`)), 10_000);
    child.stdout.on("data", (part: Buffer) => {
      stdout += part.toString("utf8");
      if (stdout.includes("LOCK_READY\n")) { clearTimeout(timer); resolve(); }
    });
    void closed.then(result => {
      clearTimeout(timer);
      if (!stdout.includes("LOCK_READY\n")) reject(new Error(`LOCK_HOLDER_EXITED_BEFORE_READY:${JSON.stringify({ ...result, stdout })}`));
    }, error => { clearTimeout(timer); reject(error); });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  return { child, ready, closed };
}

test("spot kernel lock remains held after its flock helper exits and blocks independent open descriptions", { timeout: 15_000 }, async t => {
  const root = await temporary(t);
  const release = await acquireSpotPaperLock(root);
  let released = false;
  t.after(async () => { if (!released) await release(); });
  const inode = (await stat(join(root, "runner.lock"))).ino;
  // acquireSpotPaperLock resolves only after the short-lived flock helper has closed.
  const blocked = await externalContender(root);
  assert.equal(blocked.code, 1, blocked.stderr);
  await assert.rejects(acquireSpotPaperLock(root), /SPOT_PAPER_LOCK_UNAVAILABLE:1/);
  assert.equal((await stat(join(root, "runner.lock"))).ino, inode, "contention must not unlink or replace the lock inode");
  await release(); released = true;
  const available = await externalContender(root);
  assert.equal(available.code, 0, available.stderr);
  assert.equal((await stat(join(root, "runner.lock"))).ino, inode, "release closes the description and leaves the stable inode");
});

test("an independent Node process owns the lock until it releases its inherited open description", { timeout: 15_000 }, async t => {
  const root = await temporary(t), holder = independentHolder(root, t);
  await holder.ready;
  await assert.rejects(acquireSpotPaperLock(root), /SPOT_PAPER_LOCK_UNAVAILABLE:1/);
  assert.equal((await externalContender(root)).code, 1);
  holder.child.stdin.end();
  const result = await holder.closed;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  const release = await acquireSpotPaperLock(root);
  await release();
});

test("SIGKILL releases the parent's kernel lock without deleting a stale file or consulting process IDs", { timeout: 15_000 }, async t => {
  const root = await temporary(t), holder = independentHolder(root, t);
  await holder.ready;
  const inode = (await stat(join(root, "runner.lock"))).ino;
  assert.equal((await externalContender(root)).code, 1);
  assert.equal(holder.child.kill("SIGKILL"), true);
  const result = await holder.closed;
  assert.equal(result.signal, "SIGKILL");
  const release = await acquireSpotPaperLock(root);
  assert.equal((await stat(join(root, "runner.lock"))).ino, inode);
  await release();
  assert.equal((await externalContender(root)).code, 0);
});

test("atomic spot journal replacement ignores abandoned pending files and preserves their evidence", async t => {
  const root = await temporary(t), file = join(root, "state.json"), orphan = `${file}.pending-abandoned`;
  await durableSpotFile(file, '{"cycle":1,"cashUsd":99900}\n', false);
  await writeFile(orphan, '{"uncommitted":true}\n', { flag: "wx" });
  const replacement = JSON.stringify({ cycle: 2, cashUsd: 99900, receipts: ["one-buy"], utf8: "₿" }) + "\n";
  await durableSpotFile(file, replacement, false);
  assert.equal(await readFile(file, "utf8"), replacement);
  assert.equal(await readFile(orphan, "utf8"), '{"uncommitted":true}\n');
  assert.deepEqual((await readdir(root)).sort(), ["state.json", "state.json.pending-abandoned"]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("exclusive cycle evidence cannot be overwritten, including by a competing writer", async t => {
  const root = await temporary(t), file = join(root, "cycle.json");
  const results = await Promise.allSettled([
    durableSpotFile(file, '{"source":"first"}\n', true),
    durableSpotFile(file, '{"source":"second"}\n', true),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const failure = results.find(result => result.status === "rejected");
  assert.ok(failure?.status === "rejected");
  assert.equal((failure.reason as NodeJS.ErrnoException).code, "EEXIST");
  const original = await readFile(file, "utf8");
  assert.ok(['{"source":"first"}\n', '{"source":"second"}\n'].includes(original));
  await assert.rejects(durableSpotFile(file, '{"rewritten":true}\n', true), { code: "EEXIST" });
  assert.equal(await readFile(file, "utf8"), original);
});

test("concurrent readers observe complete journal generations during repeated atomic replacement", { timeout: 15_000 }, async t => {
  const root = await temporary(t), file = join(root, "state.json");
  const generation = (id: number) => JSON.stringify({ id, payload: String(id).padStart(3, "0").repeat(24_000) }) + "\n";
  await durableSpotFile(file, generation(0), false);
  let complete = false, reads = 0;
  const writer = (async () => {
    try { for (let id = 1; id <= 25; id++) await durableSpotFile(file, generation(id), false); }
    finally { complete = true; }
  })();
  const reader = (async () => {
    do {
      const snapshot = JSON.parse(await readFile(file, "utf8")) as { id: number; payload: string };
      assert.ok(Number.isInteger(snapshot.id) && snapshot.id >= 0 && snapshot.id <= 25);
      assert.equal(snapshot.payload, String(snapshot.id).padStart(3, "0").repeat(24_000));
      reads++;
    } while (!complete);
  })();
  const results = await Promise.allSettled([writer, reader]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  assert.ok(reads > 1);
  assert.equal(await readFile(file, "utf8"), generation(25));
  assert.deepEqual(await readdir(root), ["state.json"]);
});
