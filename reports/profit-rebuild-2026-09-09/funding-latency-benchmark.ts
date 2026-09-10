import { performance } from "node:perf_hooks";
import { newPaperFundingState, observePaperFundingFill, observePaperFundingRates, paperFundingSnapshot } from "/home/ec2-user/crypto_trade/src/kraken/paper-funding.ts";
const H = 3_600_000, T = Date.UTC(2026, 0, 1), symbol = "BTC/USD";
const count = Number(process.argv[2] ?? 100);
let state = newPaperFundingState({ startedAtMs: T, productsBySymbol: { [symbol]: "PF_XBTUSD" }, initialSignedQtyBySymbol: { [symbol]: 1 } });
let began = performance.now();
for (let i = 0; i < 100; i++) {
  const occurredAtMs = T + Math.floor(i * count * H / 100);
  state = observePaperFundingFill(state, { id: `fill-${i}`, symbol, occurredAtMs, side: i % 2 ? -1 : 1, qty: .001 }, occurredAtMs);
}
console.log(JSON.stringify({ hours: count, fills: 100, phase: "build-fill-evidence", elapsedMs: performance.now() - began }));
const rates = Array.from({ length: count }, (_, i) => ({ id: `rate-${i}`, symbol, productId: "PF_XBTUSD",
  effectiveFromMs: T + i * H, effectiveToMs: T + (i + 1) * H, knownAtMs: T + count * H,
  absoluteUsdPerBasePerHour: .01, sourceResponseSha256: "a".repeat(64) }));
began = performance.now();
state = observePaperFundingRates(state, rates, T + count * H);
console.log(JSON.stringify({ hours: count, fills: 100, phase: "observe-rates", elapsedMs: performance.now() - began }));
began = performance.now(); paperFundingSnapshot(state, T + count * H + 1000);
console.log(JSON.stringify({ hours: count, fills: 100, phase: "snapshot-cache-miss", elapsedMs: performance.now() - began }));
began = performance.now(); paperFundingSnapshot(state, T + count * H + 2000);
console.log(JSON.stringify({ hours: count, fills: 100, phase: "snapshot-next-second", elapsedMs: performance.now() - began }));
began = performance.now(); paperFundingSnapshot(state, T + (count + 1) * H);
console.log(JSON.stringify({ hours: count, fills: 100, phase: "snapshot-next-hour", elapsedMs: performance.now() - began }));
