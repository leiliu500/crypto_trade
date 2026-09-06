import test from "node:test";
import assert from "node:assert/strict";
import { PolicyCollector } from "../src/research/policy-collector.js";
import { policyCandidates } from "../src/research/trading-policy.js";
import { validPolicyOutcome } from "../src/research/policy-validation.js";
import type { BookState } from "../src/core/market.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";
const asset = { symbol: "BTC/USD", minOrderSize: .001, minTradeIncrement: .001, maximumOrderQty: 100,
  priceIncrement: .001, shortable: true };
const book = (at: number, mid = 100): BookState => ({symbol: "BTC/USD", valid: true, sequence: BigInt(at),
  sourceReset: false, exchangeTsMs: at, receiveTsMs: at, bids: [{px:mid-.005,qty:100}], asks:[{px:mid+.005,qty:100}]});
const features = (at: number): DeterministicFeatures => ({ receiveTsMs: at, stale: false, warmedUp:true, spreadBps:1,
  retestCandidate: { side:1,boundary:100,invalidationPx:99,signalAtMs:at,setupAtMs:0,volatilityBps:1,tradeImbalance:.8 }
} as DeterministicFeatures);
function setup() {
  const c = new PolicyCollector("observed-test", "BTC/USD", 5, 3), f=features(1000);
  const starts = c.captureEntry(book(1000), f, asset, policyCandidates(f)[0]!, .1,
    {clientOrderId:"actual",decisionAtMs:1550});
  assert.equal(starts.length,4);
  return {c,starts};
}
test("an observed paper fill cannot become a simulated IOC non-fill on an earlier quote",()=>{
  const {c,starts}=setup();
  assert.deepEqual(c.observe(book(1250,100.1),features(1250)),[]);
  const filled=c.observeEntryExecution("actual",1800,{qty:.1,price:100.005,feeUsd:.00500025},true);
  assert.equal(filled.length,4);
  assert.ok(filled.every(o=>o.entryAtMs===1800&&o.entryPrice===100.005&&o.filledQty===.1));
  assert.ok(starts.every(o=>o.entryAtMs===null));
  assert.deepEqual(c.observeEntryExecution("actual",1800,undefined,true),[],"duplicate terminal event is idempotent");
  assert.deepEqual(c.observeEntryExecution("actual",3000,undefined,true),[],"late duplicate acknowledgment cannot invalidate an observed fill");
  let outcomes=[];
  for(let at=2000;at<=62500;at+=250) outcomes.push(...c.observe(book(at),features(at)));
  const end=outcomes.find(o=>o.policyId==="retest-1m")!;
  assert.equal(end.reason,"POLICY_DEADLINE"); assert.ok(end.netBps!<0); assert.ok(validPolicyOutcome(end));
});
test("confirmed IOC non-fill is zero, but missing execution and rejection are invalid",()=>{
  const {c}=setup();
  const noFill=c.observeEntryExecution("actual",1600,undefined,true,true);
  assert.ok(noFill.every(o=>o.reason==="ENTRY_NOT_FILLED"&&validPolicyOutcome(o)));
  const rejected=setup().c.observeEntryExecution("actual",1600,undefined,true);
  assert.ok(rejected.every(o=>o.status==="INVALID"));
  const timedOut=setup().c.observe(book(3000),features(3000));
  assert.ok(timedOut.every(o=>o.reason==="ENTRY_EXECUTION_UNOBSERVED"&&o.netBps===null));
});
test("terminal partial fills preserve their fraction; wrong fees and later fills cannot masquerade as clean labels",()=>{
  const {c}=setup();
  const partial=c.observeEntryExecution("actual",1800,{qty:.04,price:100.005,feeUsd:.0020001},true);
  assert.ok(partial.every(o=>o.qty===.1&&o.filledQty===.04));
  let outcomes=[];
  for(let at=2000;at<=62500;at+=250) outcomes.push(...c.observe(book(at),features(at)));
  assert.ok(outcomes.every(o=>validPolicyOutcome(o)&&o.netBps!<0));
  const wrong=setup().c.observeEntryExecution("actual",1800,{qty:.1,price:100.005,feeUsd:0},true);
  assert.ok(wrong.every(o=>o.reason==="ENTRY_FEE_MISMATCH"));
  const multi=setup().c;
  multi.observeEntryExecution("actual",1700,{qty:.04,price:100.005,feeUsd:.0020001},false);
  assert.ok(multi.observeEntryExecution("actual",1800,{qty:.04,price:100.005,feeUsd:.0020001},true)
    .every(o=>o.reason==="MULTIPLE_ENTRY_FILLS_UNSUPPORTED"));
});
