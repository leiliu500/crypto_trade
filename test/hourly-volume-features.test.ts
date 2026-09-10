import assert from "node:assert/strict";
import test from "node:test";
import { HOUR_MS as H, type HourlyBar, type HourlySymbol } from "../src/research/hourly-data.js";
import { buildHourlyVolumeFeatures, HOURLY_VOLUME_FEATURE_SPEC, type HourlyVolumePoint } from "../src/research/hourly-volume-features.js";

const START = Date.UTC(2023, 0, 1);
const near = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance,
  `Expected ${actual} near ${expected}`);
function ownBars(closes: readonly number[], symbol: HourlySymbol): HourlyBar[] {
  return closes.map((close, i) => ({ symbol, openMs: START + i * H, open: close,
    high: close * 1.01, low: close * .99, close, volume: 1 }));
}
function pair(count = 220, rate = .001): HourlyBar[] {
  const closes = Array.from({ length: count }, (_, i) => 100 * Math.exp(rate * i));
  return [...ownBars(closes, "BTC/USD"), ...ownBars(closes, "ETH/USD")];
}
function point(bars: readonly HourlyBar[], at = START + 169 * H, symbol = "BTC/USD"): HourlyVolumePoint {
  const found = buildHourlyVolumeFeatures(bars).find(row => row.decisionMs === at && row.symbol === symbol);
  assert.ok(found); return found;
}

test("new twelve-feature schema requires 169 synchronized completed bars and has the prescribed return scales", () => {
  const input = pair(169), values = point(input).features;
  assert.equal(HOURLY_VOLUME_FEATURE_SPEC.featureDimension, 12);
  assert.equal(HOURLY_VOLUME_FEATURE_SPEC.distinctFromDistributionFeatureSchema, true);
  assert.equal(HOURLY_VOLUME_FEATURE_SPEC.featureNames.length, 12);
  assert.equal(buildHourlyVolumeFeatures(pair(168)).length, 0);
  assert.equal(buildHourlyVolumeFeatures(input.filter(bar => bar.symbol === "BTC/USD")).length, 0);
  assert.equal(buildHourlyVolumeFeatures(input)[0]!.decisionMs, START + 169 * H);
  for (const [i, horizon] of [1, 4, 24, 168].entries()) near(values[i]!, Math.sqrt(horizon));
  near(values[4]!, Math.log(10)); near(values[5]!, 0);
  near(values[6]!, 0); near(values[7]!, 0); near(values[9]!, 0); near(values[10]!, 0);
  assert.equal(values[11], 0); // Identical own and peer series have beta one and zero residual variance.
});

test("short volatility includes exactly the latest 24 one-hour returns", () => {
  const closes = [...Array<number>(168).fill(100), 100 * Math.exp(.1)];
  const values = point([...ownBars(closes, "BTC/USD"), ...ownBars(closes, "ETH/USD")]).features;
  near(values[0], Math.sqrt(168));
  near(values[4], Math.log(.1 / Math.sqrt(24) * 10_000));
  near(values[5], Math.log(Math.sqrt(7)));
});

test("candle location and body use current completed OHLC and true range includes gaps", () => {
  const input = pair(169, 0), current = input.find(bar => bar.symbol === "BTC/USD" && bar.openMs === START + 168 * H)!;
  Object.assign(current, { open: 109, high: 112, low: 108, close: 111 });
  const values = point(input).features;
  near(values[6], .5); near(values[7], .5);
  near(values[8], Math.log(12 / 2)); // Previous close 100, so TR=12 despite candle range=4.
  near(values[11], values[2]); // Constant peer means beta zero.
});

test("true-range reference uses exactly the previous 24 bars, excluding current and older ranges", () => {
  const input = pair(169, 0), btc = input.filter(bar => bar.symbol === "BTC/USD");
  Object.assign(btc[143]!, { high: 140, low: 60 }); // Outside the prior 24 range reference.
  Object.assign(btc[144]!, { high: 103, low: 97 }); // Included oldest prior true range.
  Object.assign(btc[168]!, { high: 105, low: 95 });
  near(point(input).features[8], Math.log(10 / ((23 * 2 + 6) / 24)));
});

test("volume surprise excludes current from references and includes current in the short activity mean", () => {
  const input = pair(169, 0), btc = input.filter(bar => bar.symbol === "BTC/USD");
  btc[168]!.volume = 25;
  const values = point(input).features;
  near(values[9], Math.log(26 / 2));
  near(values[10], Math.log(3 / 2)); // Last24 mean=2, prior168 mean=1.
  btc[0]!.volume = 169;
  near(point(input).features[9], values[9]);
  near(point(input).features[10], 0); // Oldest prior168 volume matters; prior168 mean becomes two.
  btc[144]!.volume = 25;
  near(point(input).features[9], Math.log(26 / 3)); // Oldest prior24 is included.
});

test("beta is a trailing through-origin hedge without clipping, with a residual-specific scale", () => {
  const own = [100], peer = [100];
  for (let i = 1; i <= 168; i++) {
    const peerReturn = i % 2 ? .01 : -.01, residual = i > 144 ? .005 : 0;
    peer.push(peer.at(-1)! * Math.exp(peerReturn));
    own.push(own.at(-1)! * Math.exp(3 * peerReturn + residual));
  }
  const values = point([...ownBars(own, "BTC/USD"), ...ownBars(peer, "ETH/USD")]).features;
  // Orthogonal residual and peer return imply beta=3. Residual has 24 equal
  // positive returns among 168, giving normalized residual24=sqrt(168).
  near(values[11], Math.sqrt(168), 1e-8);
  assert.ok(Math.abs(values[11] - values[2]) > 5);
});

test("future prices and volumes, and data before the declared lookback, cannot change an earlier point", () => {
  const input = pair(), at = START + 200 * H, expected = point(input, at);
  const changed = input.map(bar => bar.openMs >= at || bar.openMs < START + 31 * H
    ? { ...bar, open: bar.open * 3, high: bar.high * 3, low: bar.low * 3, close: bar.close * 3, volume: 50000 } : bar);
  assert.deepEqual(point(changed, at), expected);
  const prefix = input.filter(bar => bar.openMs + H <= at);
  assert.deepEqual(point(prefix, at), expected);
  assert.equal(buildHourlyVolumeFeatures(input.filter(bar => bar.openMs + H < at)).some(row => row.decisionMs === at), false);
});

test("a missing hour in either asset invalidates both aligned lookbacks and recovers after 169 fresh bars", () => {
  for (const missingSymbol of ["BTC/USD", "ETH/USD"] as const) {
    const input = pair(270).filter(bar => !(bar.symbol === missingSymbol && bar.openMs === START + 80 * H));
    const points = buildHourlyVolumeFeatures(input);
    assert.equal(points.some(row => row.decisionMs < START + 250 * H), false);
    assert.deepEqual(points.filter(row => row.decisionMs === START + 250 * H).map(row => row.symbol), ["BTC/USD", "ETH/USD"]);
    const fresh = input.filter(bar => bar.openMs > START + 80 * H);
    assert.deepEqual(buildHourlyVolumeFeatures(fresh), points);
  }
});

test("flat candles, zero volume and zero return scales produce finite specified values", () => {
  const input = pair(169, 0).map(bar => ({ ...bar, open: 100, high: 100, low: 100, close: 100, volume: 0 }));
  assert.deepEqual(point(input).features, [0, 0, 0, 0, Math.log(.01), 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(buildHourlyVolumeFeatures([]), []);
});

test("output is deterministic, owns immutable inputs, and malformed or duplicate bars fail", () => {
  const input = pair(169), original = structuredClone(input), result = buildHourlyVolumeFeatures(input);
  assert.deepEqual(buildHourlyVolumeFeatures([...input].reverse()), result);
  assert.deepEqual(input, original);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result[0]) && Object.isFrozen(result[0]!.features));
  assert.ok(Object.isFrozen(HOURLY_VOLUME_FEATURE_SPEC) && Object.isFrozen(HOURLY_VOLUME_FEATURE_SPEC.featureNames));
  input[0]!.volume = 10000; assert.deepEqual(result, buildHourlyVolumeFeatures(original));
  assert.throws(() => buildHourlyVolumeFeatures([...original, original[0]!]), /DUPLICATE_BAR/);
  for (const change of [{ openMs: START + 1 }, { close: NaN }, { volume: -1 }, { high: 1 }, { symbol: "SOL/USD" }])
    assert.throws(() => buildHourlyVolumeFeatures([{ ...original[0]!, ...change } as HourlyBar]), /INVALID_BAR/);
  assert.throws(() => buildHourlyVolumeFeatures(null as unknown as HourlyBar[]), /INVALID_INPUT/);
});
