import assert from "node:assert/strict";
import test from "node:test";
import { loadVenueSlowTrendHistory } from "../src/alpaca/market-history.js";
import { AlpacaRestClient } from "../src/alpaca/rest.js";
import { DEFAULT_EXTENSION_CONFIG } from "../src/config/deterministic-defaults.js";
import { DeterministicFeatureExtensions } from "../src/strategy/deterministic-features.js";

test("completed Alpaca bars plus a current order book restore slow-trend coverage after a clean restart", async () => {
  const asOfMs = Date.parse("2026-08-25T05:30:45Z");
  const firstOpenMs = Date.parse("2026-08-25T04:28:00Z");
  const bars = Array.from({ length: 63 }, (_value, index) => ({
    t: new Date(firstOpenMs + index * 60_000).toISOString(),
    o: 2_490 + index, h: 2_492 + index, l: 2_489 + index, c: 2_491 + index, v: 10,
  }));
  const requestedUrls: string[] = [];
  const client = new AlpacaRestClient({ credentials: { keyId: "key", secretKey: "secret" }, paper: true },
    async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/bars?")) return new Response(JSON.stringify({ bars: { "ETH/USD": bars } }), { status: 200 });
      if (url.includes("/latest/orderbooks")) return new Response(JSON.stringify({ orderbooks: { "ETH/USD": {
        t: "2026-08-25T05:30:40Z", b: [{ p: 2_550, s: 1 }], a: [{ p: 2_552, s: 1 }],
      } } }), { status: 200 });
      return new Response(JSON.stringify({ snapshots: { "ETH/USD": {} } }), { status: 200 });
    });

  const history = await loadVenueSlowTrendHistory(client, ["ETH/USD"], firstOpenMs, asOfMs);
  const observations = history.get("ETH/USD")!;
  assert.equal(observations.at(-1)?.atMs, Date.parse("2026-08-25T05:30:40Z"));
  assert.equal(observations.at(-1)?.mid, 2_551);
  assert.ok(!observations.some((point) => point.mid === bars.at(-1)!.c), "the still-open minute must be excluded");
  assert.match(requestedUrls.find((url) => url.includes("/bars?"))!, /timeframe=1Min/);

  const restored = new DeterministicFeatureExtensions(DEFAULT_EXTENSION_CONFIG).restoreSlowTrend(observations, asOfMs);
  assert.equal(restored.ready, true);
  assert.equal(restored.lastAtMs, Date.parse("2026-08-25T05:30:40Z"));
  assert.ok(restored.coverageMs >= DEFAULT_EXTENSION_CONFIG.trendSlowWindowMs * DEFAULT_EXTENSION_CONFIG.trendMinimumCoverage);
});

test("venue history remains fail-closed when its newest market observation is stale", async () => {
  const asOfMs = Date.parse("2026-08-25T05:30:45Z");
  const client = new AlpacaRestClient({ credentials: { keyId: "key", secretKey: "secret" }, paper: true },
    async (input) => {
      const url = String(input);
      if (url.includes("/bars?")) return new Response(JSON.stringify({ bars: { "ETH/USD": [{
        t: "2026-08-25T05:28:00Z", o: 2_500, h: 2_501, l: 2_499, c: 2_500, v: 10,
      }] } }), { status: 200 });
      if (url.includes("/latest/orderbooks")) return new Response(JSON.stringify({ orderbooks: { "ETH/USD": {
        t: "2026-08-25T05:29:00Z", b: [{ p: 2_499, s: 1 }], a: [{ p: 2_501, s: 1 }],
      } } }), { status: 200 });
      return new Response(JSON.stringify({ snapshots: { "ETH/USD": {} } }), { status: 200 });
    });
  const history = await loadVenueSlowTrendHistory(client, ["ETH/USD"], asOfMs - 3_600_000, asOfMs);
  const restored = new DeterministicFeatureExtensions(DEFAULT_EXTENSION_CONFIG)
    .restoreSlowTrend(history.get("ETH/USD")!, asOfMs);
  assert.equal(restored.ready, false);
  assert.equal(restored.reason, "HISTORY_STALE");
});

test("a valid snapshot midpoint safely substitutes for an invalid current order book", async () => {
  const asOfMs = Date.parse("2026-08-25T05:30:45Z");
  const client = new AlpacaRestClient({ credentials: { keyId: "key", secretKey: "secret" }, paper: true },
    async (input) => {
      const url = String(input);
      if (url.includes("/bars?")) return new Response(JSON.stringify({ bars: { "ETH/USD": [] } }), { status: 200 });
      if (url.includes("/latest/orderbooks")) return new Response(JSON.stringify({ orderbooks: { "ETH/USD": {
        t: "2026-08-25T05:30:39Z", b: [{ p: 2_502, s: 1 }], a: [{ p: 2_501, s: 1 }],
      } } }), { status: 200 });
      return new Response(JSON.stringify({ snapshots: { "ETH/USD": { latestQuote: {
        t: "2026-08-25T05:30:40Z", bp: 2_500, bs: 1, ap: 2_502, as: 1,
      } } } }), { status: 200 });
    });
  const history = await loadVenueSlowTrendHistory(client, ["ETH/USD"], asOfMs - 3_600_000, asOfMs);
  assert.deepEqual(history.get("ETH/USD"), [{ atMs: Date.parse("2026-08-25T05:30:40Z"), mid: 2_501 }]);
});
