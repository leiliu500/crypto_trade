import test from "node:test";
import assert from "node:assert/strict";
import { horizonCarrySignal, type HorizonSignalInput } from "../src/carry/horizon-signal.js";
const H = 3_600_000, end = Date.UTC(2024, 0, 4);
const rates = Array.from({ length: 2160 }, (_, i) => ({ symbol: "BTC/USD" as const,
  timestampMs: end - i * H, rate: 0.00005, absoluteRate: 5 }));
const input: HorizonSignalInput = { atMs: end + 60_000, spotPrice: 100_000, futurePrice: 100_000,
  funding: rates, spotFeeBps: 80, futureFeeBps: 5, slippageBps: 2, fundingEndShiftMs: 0 };
test("carry entry pays all four executions and capital hurdle on both wallets", () => {
  const signal = horizonCarrySignal(input);
  assert.equal(signal.missingHours, 0); assert.equal(signal.feesPerBase, 1700);
  assert.equal(signal.slippagePerBase, 80); assert.ok(Math.abs(signal.capitalPerBase - 300820.16) < 1e-9);
  assert.equal(signal.expectedHaircutFundingPerBase, 10800);
  assert.equal(signal.entryAllowed, true);
  assert.ok(signal.requiredPerBase > 9900 && signal.requiredPerBase < 10000);
  assert.equal(horizonCarrySignal({ ...input, funding: rates.map(r => ({ ...r, absoluteRate: 2 })) }).entryAllowed, false);
});
test("carry funding forecast excludes future values and requires a complete lookback", () => {
  assert.deepEqual(horizonCarrySignal({ ...input, funding: [...rates,
    { symbol: "BTC/USD", timestampMs: end + H, rate: NaN, absoluteRate: NaN }] }), horizonCarrySignal(input));
  const missing = horizonCarrySignal({ ...input, funding: rates.slice(1) });
  assert.equal(missing.entryAllowed, false); assert.equal(missing.expectedExcessPerBase, null);
  assert.equal(missing.missingHours, 1);
  assert.throws(() => horizonCarrySignal({ ...input, funding: [...rates, rates[0]!] }), /DUPLICATE/);
});
test("carry sensitivity shifts economic intervals and removes the newest rate", () => {
  const shifted = horizonCarrySignal({ ...input, fundingEndShiftMs: H });
  assert.equal(shifted.missingHours, 1); assert.equal(shifted.entryAllowed, false);
  const complete = horizonCarrySignal({ ...input, fundingEndShiftMs: H,
    funding: [...rates, { ...rates[0]!, timestampMs: end - 2160 * H }] });
  assert.equal(complete.missingHours, 0); assert.equal(complete.entryAllowed, true);
});
