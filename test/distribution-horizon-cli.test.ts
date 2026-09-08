import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, link, symlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { RecordedEvent } from "../src/backtest/replay.js";
import { horizonReplayCosts, parseHorizonResearchArgs, prepareHorizonResearch,
  type HorizonResearchCliOptions, type HorizonResearchRunner } from "../src/distribution/horizon-main.js";

const costs = { "BTC/USD": { feeBps: 5, reserveBps: 3 }, "ETH/USD": { feeBps: 5, reserveBps: 3 } };
const assets = Object.fromEntries(Object.keys(costs).map(symbol => [symbol, { symbol,
  minOrderSize: .001, minTradeIncrement: .001, priceIncrement: .1, maximumOrderQty: 100, shortable: true }]));
const sampleEvent: RecordedEvent = { kind: "BOOK", delta: { symbol: "BTC/USD", sourceId: "one", reset: true,
  bids: [{ px: 100, qty: 1 }], asks: [{ px: 101, qty: 1 }], exchangeTsMs: 1000, receiveTsMs: 1000 } };
const consume: HorizonResearchRunner = async events => {
  const kinds: string[] = [];
  for await (const event of events) kinds.push(event.kind);
  return { version: "fixture-horizon-report", kinds };
};
async function fixture(t: { after: (fn: () => Promise<void>) => void }, raw = gzipSync(`${JSON.stringify(sampleEvent)}\n`)) {
  const directory = await mkdtemp(join(tmpdir(), "horizon-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "raw.jsonl.gz"), manifest = join(directory, "manifest.json"), assetFile = join(directory, "assets.json");
  await writeFile(source, raw); await writeFile(assetFile, JSON.stringify(assets));
  const input = { path: source, bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") };
  await writeFile(manifest, JSON.stringify({ trainingBackfill: { costs, inputFiles: [input] } }));
  const options: HorizonResearchCliOptions = { manifest, assets: assetFile, out: join(directory, "output.json"),
    trainingStartMs: 0, laterStartMs: 2000, cutoffMs: 3000, includePanels: false };
  return { directory, source, input, options };
}

test("horizon CLI requires explicit inputs, timezone-aware ordered boundaries and rejects duplicate/unknown options", () => {
  const args = ["--manifest=data.json", "--assets=rules.json", "--training-start=2026-08-27T00:00:00Z",
    "--later-start=2026-09-07T00:00:00Z", "--cutoff=2026-09-07T18:07:03Z", "--out=report.json"];
  const parsed = parseHorizonResearchArgs([...args, "--include-panels"]);
  assert.equal(parsed.trainingStartMs, Date.parse("2026-08-27T00:00:00Z")); assert.equal(parsed.includePanels, true);
  assert.throws(() => parseHorizonResearchArgs(args.filter(arg => !arg.startsWith("--assets="))), /Usage/);
  assert.throws(() => parseHorizonResearchArgs([...args, "--assets=other.json"]), /INVALID_HORIZON_OPTION/);
  assert.throws(() => parseHorizonResearchArgs([...args, "--include-panels", "--include-panels"]), /INVALID_HORIZON_OPTION/);
  assert.throws(() => parseHorizonResearchArgs([...args, "--submit-orders"]), /INVALID_HORIZON_OPTION/);
  assert.throws(() => parseHorizonResearchArgs(args.map(arg => arg.startsWith("--later-start=")
    ? "--later-start=2026-09-07T00:00:00" : arg)), /INVALID_HORIZON_TIMESTAMP/);
  assert.throws(() => parseHorizonResearchArgs(args.map(arg => arg.startsWith("--cutoff=")
    ? "--cutoff=2026-09-06T00:00:00Z" : arg)), /INVALID_HORIZON_BOUNDARIES/);
  assert.throws(() => parseHorizonResearchArgs(args.map(arg => arg.startsWith("--training-start=")
    ? "--training-start=2026-02-30T00:00:00Z" : arg)), /INVALID_HORIZON_TIMESTAMP/);
});

test("safe replay cost loading leaves an enabled paper trial environment unchanged", () => {
  const env = { DISTRIBUTIONAL_ENGINE_ENABLED: "true", DISTRIBUTIONAL_PAPER_TRIAL_ENABLED: "true", TRADING_MODE: "paper" };
  const original = { ...env }, configured = horizonReplayCosts(env);
  assert.deepEqual(env, original);
  assert.deepEqual(Object.keys(configured.costs).sort(), ["BTC/USD", "ETH/USD"]);
  assert.ok(Object.values(configured.costs).every(c => Number.isFinite(c.feeBps) && Number.isFinite(c.reserveBps)));
});

test("preparation hashes actual compressed bytes and creates a complete immutable report after full stream consumption", async t => {
  const raw = gzipSync([sampleEvent, { kind: "PRIVATE", event: { retained: true } }].map(e => JSON.stringify(e)).join("\n") + "\n");
  const f = await fixture(t, raw), progress: number[] = [];
  const prepared = await prepareHorizonResearch(f.options, costs, { replay: consume,
    onProgress: p => progress.push(p.events), costSource: "test fixed costs" });
  const written = JSON.parse(await readFile(f.options.out, "utf8"));
  assert.deepEqual(written.kinds, ["BOOK", "PRIVATE"]);
  assert.equal(written.inputProvenance.eventsRead, 2);
  assert.equal(written.inputProvenance.inputFiles[0].actualSha256, f.input.sha256);
  assert.equal(written.inputProvenance.inputFiles[0].actualBytes, raw.length);
  assert.equal(written.inputProvenance.inputFiles[0].sha256Matches, true);
  assert.equal(written.inputProvenance.costSource, "test fixed costs");
  assert.deepEqual(written.inputProvenance.instrumentRules.assets, assets);
  assert.equal(written.brokerOrdersSubmitted, 0); assert.equal(written.profitabilityEstablished, false);
  assert.equal(prepared.sha256, createHash("sha256").update(await readFile(f.options.out)).digest("hex"));
  assert.equal((await stat(f.options.out)).mode & 0o777, 0o600); assert.deepEqual(progress, [2]);
  assert.ok((await readdir(f.directory)).every(name => !name.endsWith(".tmp")));
  await assert.rejects(prepareHorizonResearch(f.options, costs, { replay: consume }), /OUTPUT_EXISTS/);
});

test("incorrect expected size or SHA cannot publish an output", async t => {
  for (const field of ["bytes", "sha256"] as const) {
    const f = await fixture(t), bad = { ...f.input, [field]: field === "bytes" ? f.input.bytes + 1 : "0".repeat(64) };
    await writeFile(f.options.manifest, JSON.stringify({ trainingBackfill: { inputFiles: [bad] } }));
    await assert.rejects(prepareHorizonResearch(f.options, costs, { replay: consume }), field === "bytes" ? /SIZE_MISMATCH/ : /HASH_MISMATCH/);
    await assert.rejects(stat(f.options.out), { code: "ENOENT" });
  }
});

test("raw duplicate paths and filesystem aliases are rejected before replay", async t => {
  const f = await fixture(t);
  await writeFile(f.options.manifest, JSON.stringify({ trainingBackfill: { inputFiles: [f.input, f.input] } }));
  await assert.rejects(prepareHorizonResearch(f.options, costs, { replay: consume }), /DUPLICATE_HORIZON_INPUT_PATH/);
  for (const [name, make] of [["hardlink.gz", link], ["symlink.gz", symlink]] as const) {
    const alias = join(f.directory, name); await make(f.source, alias);
    await writeFile(f.options.manifest, JSON.stringify({ trainingBackfill: { inputFiles: [f.input, { ...f.input, path: alias }] } }));
    await assert.rejects(prepareHorizonResearch(f.options, costs, { replay: consume }), /DUPLICATE_HORIZON_INPUT_INODE/);
    await assert.rejects(prepareHorizonResearch({ ...f.options, out: alias }, costs, { replay: consume }), /OUTPUT_EXISTS/);
  }
  await assert.rejects(prepareHorizonResearch({ ...f.options, out: f.source }, costs, { replay: consume }), /OUTPUT_EXISTS/);
  assert.equal(createHash("sha256").update(await readFile(f.source)).digest("hex"), f.input.sha256);
});

test("truncated gzip and malformed JSON fail without creating partial reports or temporary files", async t => {
  const gz = gzipSync(`${JSON.stringify(sampleEvent)}\n`);
  for (const raw of [gz.subarray(0, gz.length - 8), gzipSync(`${JSON.stringify(sampleEvent)}\n{invalid}\n`)]) {
    const f = await fixture(t, raw);
    await assert.rejects(prepareHorizonResearch(f.options, costs, { replay: consume }));
    await assert.rejects(stat(f.options.out), { code: "ENOENT" });
    assert.ok((await readdir(f.directory)).every(name => !name.endsWith(".tmp")));
  }
});

test("an input or metadata file changed during replay prevents publication", async t => {
  for (const mutate of ["source", "assets", "manifest"] as const) {
    const f = await fixture(t), target = mutate === "source" ? f.source : f.options[mutate];
    await assert.rejects(prepareHorizonResearch(f.options, costs, { replay: consume,
      onProgress: () => writeFileSync(target, "changed") }), /HORIZON_INPUT_CHANGED/);
    await assert.rejects(stat(f.options.out), { code: "ENOENT" });
  }
});

test("an incomplete consumer or an output created during replay cannot publish or overwrite anything", async t => {
  const f = await fixture(t);
  await assert.rejects(prepareHorizonResearch(f.options, costs, { replay: async events => {
    for await (const _ of events) break;
    return {};
  } }), /DID_NOT_CONSUME_MANIFEST/);
  await assert.rejects(stat(f.options.out), { code: "ENOENT" });
  await assert.rejects(prepareHorizonResearch(f.options, costs, { replay: consume,
    onProgress: () => writeFileSync(f.options.out, "existing user output") }), { code: "EEXIST" });
  assert.equal(await readFile(f.options.out, "utf8"), "existing user output");
  assert.ok((await readdir(f.directory)).every(name => !name.endsWith(".tmp")));
});
