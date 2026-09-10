import assert from "node:assert/strict";
import test from "node:test";
import { HourlyNetLabelIndex, HOURLY_NET_LABEL_SPEC, type HourlyBar, type HourlySymbol, type AssetRules } from "../src/research/hourly-net-labels.js";
import { simulateHourlyRetryAccount, HOURLY_SCENARIOS, HOURLY_MS as H } from "../src/research/hourly-retry-simulator.js";
const T = Date.UTC(2024,0,1);
const rules: Record<HourlySymbol,AssetRules> = {
  "BTC/USD": {symbol:"BTC/USD",minOrderSize:.0001,minTradeIncrement:.0001,priceIncrement:1,maximumOrderQty:1200,shortable:true},
  "ETH/USD": {symbol:"ETH/USD",minOrderSize:.001,minTradeIncrement:.001,priceIncrement:.1,maximumOrderQty:21000,shortable:true},
};
const base = {"BTC/USD":.4,"ETH/USD":.5}, stress = {"BTC/USD":.7,"ETH/USD":.9};
function fixture() {
  const bars: HourlyBar[] = [];
  for(let h=0;h<=60;h++)for(const symbol of ["BTC/USD","ETH/USD"] as const){
    const px=symbol==="BTC/USD"?50000+101*h:2000+4.3*h;
    bars.push({symbol,openMs:T+h*H,open:px,high:px+10,low:px-10,close:px+1,volume:1});
  }
  return bars;
}
const near = (a:number|null,b:number|null) => {assert.notEqual(a,null); assert.notEqual(b,null); assert.ok(Math.abs(a!-b!)<1e-9,`${a} != ${b}`);};
function parity(bars:HourlyBar[],symbol:HourlySymbol,side:1|-1,scenario:"base"|"stress",assetRules=rules) {
  const label=new HourlyNetLabelIndex(bars,assetRules,base,stress).label(symbol,T,side,scenario);
  const account=simulateHourlyRetryAccount({bars,assetRules,funding:[],startMs:T,endMs:T+60*H,
    adverseFundingBpsPerHour:scenario==="base"?base:stress,forecastsPrequalified:true,scenario:HOURLY_SCENARIOS[scenario],
    forecasts:[{symbol,decisionMs:T,predictedGrossBps:side*100,horizonHours:24}]});
  const trade=account.trades[0]!;
  assert.equal(label.status,trade.status==="INVALID"?"UNKNOWN":trade.status);
  for(const field of ["entryMs","exitMs","qty","entryPx","exitPx","entryReferencePx","exitReferencePx","entryNotionalUsd","netPnlUsd","grossPnlUsd"] as const){
    if(trade[field]===null)assert.equal(label[field],null);else near(label[field],trade[field]);
  }
  if(label.status!=="UNKNOWN")for(const field of ["feesUsd","slippageUsd","fundingUsd","fundingReserveUsd"] as const)near(label[field],trade[field]);
  if(label.status==="COMPLETE"){
    near(label.netBps,label.netPnlUsd!/12*10000);assert.equal(label.completedAtMs,label.exitMs!+H);
    assert.equal(label.fundingHours,account.settlements.length);assert.equal(label.staleMarkHours,account.metrics.staleMarkHours);
  }
  return {label,account};
}
test("net labels exactly match sealed simulator for both assets, directions and cost scenarios",()=>{
  for(const s of ["BTC/USD","ETH/USD"] as const)for(const side of [1,-1] as const)for(const scenario of ["base","stress"] as const){
    const {label}=parity(fixture(),s,side,scenario);assert.equal(label.status,"COMPLETE");assert.ok(label.entryNotionalUsd!<=12);
    assert.equal(label.entryMs,T+(scenario==="base"?1:2)*H);assert.equal(label.exitMs,label.entryMs!+24*H);
    assert.notEqual(label.netBps,label.netPnlUsd!/label.entryNotionalUsd!*10000);
  }
});
test("maintenance exit retry carries funding and exposes causal receipts without future-gap filtering",()=>{
  const bars=fixture();for(const b of bars)if(b.openMs>=T+25*H&&b.openMs<T+31*H)b.volume=0;
  for(const s of ["BTC/USD","ETH/USD"] as const)for(const side of [1,-1] as const)for(const scenario of ["base","stress"] as const){
    const {label}=parity(bars,s,side,scenario);assert.equal(label.status,"COMPLETE");assert.equal(label.exitMs,T+31*H);assert.equal(label.completedAtMs,T+32*H);
    assert.equal(label.exitRetryCount,scenario==="base"?6:5);assert.equal(label.staleMarkHours,6);
    for(const receipt of label.exitAttempts)assert.equal(receipt.knownAtMs,receipt.attemptMs+H);
  }
});
test("zero-volume entry is a known zero label only at candle close",()=>{
  const bars=fixture();for(const b of bars)if(b.openMs===T+H||b.openMs===T+2*H)b.volume=0;
  for(const scenario of ["base","stress"] as const){const {label}=parity(bars,"BTC/USD",1,scenario);
    assert.equal(label.status,"UNFILLED");assert.equal(label.netBps,0);assert.equal(label.qty,null);
    assert.equal(label.completedAtMs,T+(scenario==="base"?2:3)*H);assert.equal(label.fundingHours,0);
  }
});
test("below-minimum lot produces a known zero at entry without any fill costs",()=>{
  const bars=fixture();for(const b of bars)if(b.symbol==="BTC/USD")Object.assign(b,{open:200000,high:200000,low:200000,close:200000});
  for(const side of [1,-1] as const)for(const scenario of ["base","stress"] as const){const {label}=parity(bars,"BTC/USD",side,scenario);
    assert.equal(label.status,"UNFILLED");assert.equal(label.noFillReason,"BELOW_MINIMUM_QUANTITY");assert.equal(label.netBps,0);
    assert.equal(label.completedAtMs,label.scheduledEntryMs);assert.equal(label.feesUsd,0);assert.equal(label.fundingUsd,0);
  }
});
test("missing entry is unknown rather than a zero no-fill",()=>{
  const bars=fixture().filter(b=>!(b.symbol==="BTC/USD"&&b.openMs===T+H));
  const {label}=parity(bars,"BTC/USD",1,"base");assert.equal(label.netBps,null);assert.equal(label.completedAtMs,T+2*H);
  assert.deepEqual(label.invalidReasons,[{atMs:T+H,reason:"MISSING_ENTRY_BAR"}]);
});
test("missing held mark or exit remains unknown even if a later observed retry closes",()=>{
  for(const missingHour of [10,25]){const bars=fixture().filter(b=>!(b.symbol==="BTC/USD"&&b.openMs===T+missingHour*H));
    const {label}=parity(bars,"BTC/USD",1,"base");assert.equal(label.status,"UNKNOWN");assert.equal(label.netBps,null);assert.equal(label.netPnlUsd,null);
    assert.ok(label.invalidReasons.some(r=>r.reason==="MISSING_MARK_BAR"));assert.equal(label.exitMs,T+(missingHour===25?26:25)*H);
    assert.equal(label.completedAtMs,label.exitMs!+H);
  }
});
test("last retry is inclusive and its final no-fill is received at the scenario deadline",()=>{
  for(const scenario of ["base","stress"] as const){const bars=fixture();const last=scenario==="base"?49:50;
    for(const b of bars)if(b.openMs>=T+(last-24)*H&&b.openMs<T+last*H)b.volume=0;
    const lastFill=parity(bars,"BTC/USD",1,scenario).label;assert.equal(lastFill.exitRetryCount,24);assert.equal(lastFill.completedAtMs,T+(last+1)*H);
    for(const b of bars)if(b.openMs===T+last*H)b.volume=0;
    const failed=new HourlyNetLabelIndex(bars,rules,base,stress).label("BTC/USD",T,1,scenario);
    assert.equal(failed.status,"UNKNOWN");assert.equal(failed.netBps,null);assert.equal(failed.exitMs,null);assert.equal(failed.exitRetryExhausted,true);
    assert.equal(failed.completedAtMs,T+(last+1)*H);assert.equal(failed.exitAttempts.length,25);assert.equal(failed.exitAttempts.at(-1)!.knownAtMs,failed.completedAtMs);
    assert.ok(failed.completedAtMs<=T+HOURLY_NET_LABEL_SPEC.maximumCompletionHours*H);
    const deadlineAccount=simulateHourlyRetryAccount({bars,assetRules:rules,funding:[],startMs:T,endMs:failed.completedAtMs,
      adverseFundingBpsPerHour:scenario==="base"?base:stress,forecastsPrequalified:true,scenario:HOURLY_SCENARIOS[scenario],
      forecasts:[{symbol:"BTC/USD",decisionMs:T,predictedGrossBps:100,horizonHours:24}]});
    near(failed.fundingUsd,deadlineAccount.trades[0]!.fundingUsd);near(failed.fundingReserveUsd,deadlineAccount.trades[0]!.fundingReserveUsd);
    assert.equal(failed.fundingHours,49);
  }
});
test("input truncation cannot create a complete or zero return",()=>{
  const label=new HourlyNetLabelIndex(fixture().filter(b=>b.openMs<T+20*H),rules,base,stress).label("ETH/USD",T,-1,"stress");
  assert.equal(label.status,"UNKNOWN");assert.equal(label.netPnlUsd,null);assert.equal(label.completedAtMs,T+51*H);
  assert.ok(label.invalidReasons.some(r=>r.reason==="MISSING_EXIT_BAR"));
});
test("snapshots isolate inputs and repeated labels do not share mutable audit arrays",()=>{
  const bars=fixture(),ownRules=structuredClone(rules),ownBase={...base};const index=new HourlyNetLabelIndex(bars,ownRules,ownBase,stress);
  const before=index.label("BTC/USD",T,1,"base");bars[2]!.open=1;ownRules["BTC/USD"].priceIncrement=10;ownBase["BTC/USD"]=999;
  assert.deepEqual(index.label("BTC/USD",T,1,"base"),before);before.exitAttempts.length=0;
  assert.equal(index.label("BTC/USD",T,1,"base").exitAttempts.length,1);
});
test("malformed bars, reserves, queries and unsupported shorts fail explicitly",()=>{
  const bars=fixture();assert.throws(()=>new HourlyNetLabelIndex([...bars,bars[0]!],rules,base,stress),/BAR/);
  assert.throws(()=>new HourlyNetLabelIndex(bars,rules,{...base,"BTC/USD":NaN},stress),/RESERVE/);
  const index=new HourlyNetLabelIndex(bars,rules,base,stress);assert.throws(()=>index.label("BTC/USD",T+1,1,"base"),/QUERY/);
  const unavailable=structuredClone(rules);unavailable["BTC/USD"].shortable=false;
  assert.throws(()=>new HourlyNetLabelIndex(bars,unavailable,base,stress).label("BTC/USD",T,-1,"base"),/SHORT_DISABLED/);
});
