import assert from "node:assert/strict";
import test from "node:test";
import { CHANNEL_HOLDOUT_SPEC as H } from "../src/channel/holdout-spec.js";
import { CHANNEL_SPEC as S, CHANNEL_PRICE_PROTECTED_SPEC as P } from "../src/channel/spec.js";
import type { HourlyBar } from "../src/research/hourly-data.js";
import { replayChannel, replayPriceProtectedChannel, replayPriceProtectedChannelHoldout } from "../src/channel/replay.js";
import { validateChannelHoldout } from "../src/channel/holdout-main.js";
const input = { bars: [], funding: [], startMs: H.startMs, endMs: H.endMs, scenario: "base" as const };
test("default replay APIs cannot open reserved dates; explicit holdout API has one exact window and required warmup", () => {
  assert.throws(() => replayChannel(input), /INVALID_CHANNEL_REPLAY_WINDOW/);
  assert.throws(() => replayPriceProtectedChannel(input), /INVALID_CHANNEL_REPLAY_WINDOW/);
  assert.throws(() => replayPriceProtectedChannelHoldout({ ...input, endMs: H.endMs + S.dayMs }), /EXACT_WINDOW/);
  assert.throws(() => replayPriceProtectedChannelHoldout(input), /INCOMPLETE_WARMUP/);
});
function synthetic(scenario: "base" | "stress"): ReturnType<typeof replayChannel> {
  const empty = replayPriceProtectedChannel({ bars: [], funding: [], startMs: Date.UTC(2024, 0, 1), endMs: Date.UTC(2024, 0, 2), scenario });
  return { ...empty, version: P.version, startMs: H.startMs, endMs: H.endMs, scenario, policy: "channel", accountingKnown: true,
    netPnlUsd: 100, closedEpisodes: 6, unresolved: [], missingFunding: [], missingBars: [], haltReasons: {},
    dailyNetPnlUsd: Array.from({ length: (H.endMs - H.startMs) / S.dayMs }, (_, i) => ({ dayStartMs: H.startMs + i * S.dayMs, netPnlUsd: 1 })) } satisfies ReturnType<typeof replayChannel>;
}
test("holdout checks use only the held-out weekly path and never override the original planner gate", () => {
  const result = validateChannelHoldout([synthetic("base"), synthetic("stress")]);
  assert.equal(result.historicalHoldoutPassed, true);
  assert.equal(result.bootstrap.lowerMeanWeeklyNetUsd, 7);
  assert.equal(result.paperPilotEligible, false); assert.equal(result.originalPlannerHistoricalGateChanged, false);
});
test("missing funding, fewer than six episodes, loss, risk breach or nonpositive bootstrap rejects holdout qualification", () => {
  const mutations: Array<(r: ReturnType<typeof replayChannel>) => void> = [
    r => { r.missingFunding.push("BTC/USD:missing"); }, r => { r.closedEpisodes = 5; }, r => { r.netPnlUsd = -1; },
    r => { r.accountingKnown = false; }, r => { r.haltReasons.SESSION_OR_ROLLING_LOSS_ENVELOPE = 1; },
    r => { for (const d of r.dailyNetPnlUsd) d.netPnlUsd = -1; },
  ];
  for (const mutate of mutations) { const base = synthetic("base"); mutate(base);
    assert.equal(validateChannelHoldout([base, synthetic("stress")]).historicalHoldoutPassed, false); }
});
test("unknown funded cash never emits a positive funded bootstrap from a partial marked path", () => {
  for (const scenario of ["base", "stress"] as const) {
    const runs = [synthetic("base"), synthetic("stress")], affected = runs.find(r => r.scenario === scenario)!;
    affected.missingFunding.push("BTC/USD:omitted");
    const result = validateChannelHoldout(runs);
    assert.equal(result.bootstrap.lowerMeanWeeklyNetUsd, null);
    assert.equal(result.bootstrap.completeWeeks, 0);
    assert.equal(result.fundedBootstrapStatus, "UNAVAILABLE_MISSING_FUNDED_EVIDENCE");
  }
});
test("the explicit scope executes only its fixed test interval using synthetic constant prices", () => {
  const bars: HourlyBar[] = [];
  for (let openMs = H.warmupStartMs; openMs < H.endMs; openMs += S.hourMs) for (const symbol of S.symbols)
    bars.push({ symbol, openMs, open: 100, high: 101, low: 99, close: 100, volume: 100 });
  const result = replayPriceProtectedChannelHoldout({ ...input, bars });
  assert.equal(result.orders.length, 0); assert.equal(result.netPnlUsd, 0);
  assert.equal(result.hourly[0]?.atMs, H.startMs + S.hourMs);
  assert.equal(result.hourly.at(-1)?.atMs, H.endMs);
  assert.equal(result.holdoutScopeVersion, H.version);
});
