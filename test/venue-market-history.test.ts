import assert from "node:assert/strict";
import test from "node:test";
import { loadVenueSlowTrendHistory } from "../src/venue/market-history.js";
import type { VenueClient } from "../src/venue/client.js";
import type { VenueBar, VenueOrderbook, VenueSnapshot } from "../src/venue/types.js";
import { DEFAULT_EXTENSION_CONFIG } from "../src/config/deterministic-defaults.js";
import { DeterministicFeatureExtensions } from "../src/strategy/deterministic-features.js";

function historyClient(bars: Record<string, VenueBar[]>, orderbooks: Record<string, VenueOrderbook>,
  snapshots: Record<string, VenueSnapshot> = {}): VenueClient {
  const unavailable = (): never => { throw new Error("unused test client method"); };
  return {
    getAccount: unavailable, getAccountConfiguration: unavailable, getClock: unavailable,
    listAssets: unavailable, getAsset: unavailable, listOrders: unavailable, getOrder: unavailable,
    getOrderByClientId: unavailable, listPositions: unavailable, getPortfolioHistory: unavailable,
    getActivities: unavailable, latestQuotes: unavailable, latestTrades: unavailable, latestBars: unavailable,
    bars: async () => ({ data: { bars }, status: 200 }),
    latestOrderbooks: async () => ({ data: { orderbooks }, status: 200 }),
    snapshots: async () => ({ data: { snapshots }, status: 200 }),
  };
}

test("completed bars plus a current order book restore slow-trend coverage after a clean restart", async () => {
  const asOfMs = Date.parse("2026-08-25T05:30:45Z");
  const firstOpenMs = Date.parse("2026-08-25T04:28:00Z");
  const bars = Array.from({ length: 63 }, (_value, index) => ({
    t: new Date(firstOpenMs + index * 60_000).toISOString(),
    o: 2_490 + index, h: 2_492 + index, l: 2_489 + index, c: 2_491 + index, v: 10,
  }));
  const client = historyClient({ "ETH/USD": bars }, { "ETH/USD": {
    t: "2026-08-25T05:30:40Z", b: [{ p: 2_550, s: 1 }], a: [{ p: 2_552, s: 1 }],
  } });

  const history = await loadVenueSlowTrendHistory(client, ["ETH/USD"], firstOpenMs, asOfMs);
  const observations = history.get("ETH/USD")!;
  assert.equal(observations.at(-1)?.atMs, Date.parse("2026-08-25T05:30:40Z"));
  assert.equal(observations.at(-1)?.mid, 2_551);
  assert.ok(!observations.some((point) => point.mid === bars.at(-1)!.c));
  const restored = new DeterministicFeatureExtensions(DEFAULT_EXTENSION_CONFIG).restoreSlowTrend(observations, asOfMs);
  assert.equal(restored.ready, true);
});

test("venue history remains fail-closed when its newest market observation is stale", async () => {
  const asOfMs = Date.parse("2026-08-25T05:30:45Z");
  const client = historyClient({ "ETH/USD": [{
    t: "2026-08-25T05:28:00Z", o: 2_500, h: 2_501, l: 2_499, c: 2_500, v: 10,
  }] }, { "ETH/USD": {
    t: "2026-08-25T05:29:00Z", b: [{ p: 2_499, s: 1 }], a: [{ p: 2_501, s: 1 }],
  } });
  const history = await loadVenueSlowTrendHistory(client, ["ETH/USD"], asOfMs - 3_600_000, asOfMs);
  const restored = new DeterministicFeatureExtensions(DEFAULT_EXTENSION_CONFIG)
    .restoreSlowTrend(history.get("ETH/USD")!, asOfMs);
  assert.equal(restored.ready, false);
  assert.equal(restored.reason, "HISTORY_STALE");
});

test("a valid snapshot midpoint safely substitutes for an invalid current order book", async () => {
  const asOfMs = Date.parse("2026-08-25T05:30:45Z");
  const client = historyClient({ "ETH/USD": [] }, { "ETH/USD": {
    t: "2026-08-25T05:30:39Z", b: [{ p: 2_502, s: 1 }], a: [{ p: 2_501, s: 1 }],
  } }, { "ETH/USD": { latestQuote: {
    t: "2026-08-25T05:30:40Z", bp: 2_500, bs: 1, ap: 2_502, as: 1,
  } } });
  const history = await loadVenueSlowTrendHistory(client, ["ETH/USD"], asOfMs - 3_600_000, asOfMs);
  assert.deepEqual(history.get("ETH/USD"), [{ atMs: Date.parse("2026-08-25T05:30:40Z"), mid: 2_501 }]);
});
