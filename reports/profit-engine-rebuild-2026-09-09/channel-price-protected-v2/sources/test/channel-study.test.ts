import assert from "node:assert/strict";
import test from "node:test";
import { channelBootstrap } from "../src/channel/study-main.js";
import type { replayChannel } from "../src/channel/replay.js";
const D = 86400000, MONDAY = Date.UTC(2024, 0, 1);
function fake(start: number, weeks: number, daily: number) {
  return { scenario: "base", policy: "channel", startMs: start,
    dailyNetPnlUsd: Array.from({ length: weeks * 7 }, (_, i) => ({ dayStartMs: start + i * D, netPnlUsd: daily })) } as ReturnType<typeof replayChannel>;
}
test("channel block bootstrap preserves complete weeks and cannot bridge separate windows", () => {
  const result = channelBootstrap([fake(MONDAY, 5, 2), fake(MONDAY + 10 * 7 * D, 5, 2)]);
  assert.equal(result.completeWeeks, 10); assert.equal(result.validBlocks, 4);
  assert.equal(result.lowerMeanWeeklyNetUsd, 14);
  const negative = channelBootstrap([fake(MONDAY, 5, -2)]);
  assert.equal(negative.lowerMeanWeeklyNetUsd, -14);
});
test("partial calendar weeks and absent block support never claim a positive bound", () => {
  assert.equal(channelBootstrap([fake(MONDAY + D, 2, 20)]).lowerMeanWeeklyNetUsd, null);
  assert.equal(channelBootstrap([]).lowerMeanWeeklyNetUsd, null);
});
