import assert from "node:assert/strict";
import test from "node:test";
import {simulateHourlyRetryAccount,HOURLY_SCENARIOS,HOURLY_MS as H,
  type HourlyBar,type FundingRow,type HourlyForecast,type AssetRules} from "../src/research/hourly-retry-simulator.js";
const T=Date.UTC(2025,0,1);
const rules:Record<"BTC/USD"|"ETH/USD",AssetRules>={
 "BTC/USD":{symbol:"BTC/USD",minOrderSize:.0001,minTradeIncrement:.0001,priceIncrement:1,maximumOrderQty:1200,shortable:true},
 "ETH/USD":{symbol:"ETH/USD",minOrderSize:.001,minTradeIncrement:.001,priceIncrement:.1,maximumOrderQty:21000,shortable:true},
};
const close=(a:number|null,b:number)=>{assert.notEqual(a,null);assert.ok(Math.abs(a!-b)<1e-8,`${a} != ${b}`);};
function fixture(hours=48){const bars:HourlyBar[]=[],funding:FundingRow[]=[];
 for(let h=0;h<=hours;h++)for(const symbol of ["BTC/USD","ETH/USD"] as const){bars.push({symbol,openMs:T+h*H,open:100,high:100,low:100,close:100,volume:1});funding.push({symbol,timestampMs:T+h*H,rate:0});}
 return {bars,funding,assetRules:structuredClone(rules),startMs:T,endMs:T+hours*H};
}
const signal=(symbol:"BTC/USD"|"ETH/USD"="BTC/USD",hour=0,predictedGrossBps=100,horizonHours=4):HourlyForecast=>({symbol,decisionMs:T+hour*H,predictedGrossBps,horizonHours});
function bar(f:ReturnType<typeof fixture>,hour:number,symbol="BTC/USD"){return f.bars.find(b=>b.symbol===symbol&&b.openMs===T+hour*H)!;}
function price(f:ReturnType<typeof fixture>,hour:number,value:number,symbol="BTC/USD"){Object.assign(bar(f,hour,symbol),{open:value,high:value,low:value,close:value});}

test("five-hour maintenance carries inventory and retries at first executable open without releasing its global slot",()=>{
 const f=fixture();for(let h=5;h<10;h++)bar(f,h).volume=0;price(f,10,110);
 const r=simulateHourlyRetryAccount({...f,forecasts:[signal(),signal("ETH/USD",6,1000),signal("ETH/USD",10)]});
 const t=r.trades[0]!;assert.equal(t.scheduledExitMs,T+5*H);assert.equal(t.exitMs,T+10*H);
 assert.equal(t.status,"COMPLETE");assert.equal(t.exitDelayHours,5);assert.equal(t.exitRetryCount,5);
 assert.equal(t.exitAttempts.length,6);assert.equal(t.exitAttempts.filter(a=>a.status==="ZERO_VOLUME_UNFILLED").length,5);
 assert.equal(t.exitAttempts[0]!.knownAtMs,T+6*H);assert.equal(r.skips.busyForecasts,1);
 assert.equal(r.trades[1]!.decisionMs,T+10*H);assert.equal(r.allSelectedPathsKnown,true);
 assert.equal(r.metrics.staleMarkHours,5);assert.equal(r.metrics.exitZeroVolumeNoFills,5);
});

test("retry at nominal plus24h is allowed and final failed candle is known only at plus25h",()=>{
 const f=fixture();for(let h=5;h<29;h++)bar(f,h).volume=0;
 const filled=simulateHourlyRetryAccount({...f,forecasts:[signal()]});assert.equal(filled.trades[0]!.exitMs,T+29*H);
 assert.equal(filled.trades[0]!.exitDelayHours,24);assert.equal(filled.allSelectedPathsKnown,true);
 bar(f,29).volume=0;
 const expired=simulateHourlyRetryAccount({...f,forecasts:[signal(),signal("ETH/USD",31,1000)]});
 assert.equal(expired.trades.length,1);assert.equal(expired.trades[0]!.exitMs,null);assert.equal(expired.trades[0]!.exitRetryExhausted,true);
 assert.equal(expired.trades[0]!.exitAttempts.length,25);assert.equal(expired.trades[0]!.exitRetryCount,24);
 assert.notEqual(expired.equity.find(e=>e.atMs===T+29*H)!.equityUsd,null);
 assert.equal(expired.equity.find(e=>e.atMs===T+30*H)!.equityUsd,null);assert.equal(expired.netPnlUsd,null);
 assert.ok(expired.unknowns.some(u=>u.reason==="EXIT_RETRY_LIMIT_EXCEEDED"&&u.atMs===T+30*H));
});

test("missing exit bars remain unknown even when a later observed retry closes the inventory",()=>{
 const f=fixture();f.bars=f.bars.filter(b=>!(b.symbol==="BTC/USD"&&b.openMs===T+5*H));
 const r=simulateHourlyRetryAccount({...f,forecasts:[signal(),signal("ETH/USD",6)]});
 assert.equal(r.trades[0]!.exitMs,T+6*H);assert.equal(r.trades[0]!.status,"INVALID");assert.equal(r.netPnlUsd,null);
 assert.ok(r.unknowns.some(u=>u.reason==="MISSING_EXIT_BAR"));assert.equal(r.trades[1]!.decisionMs,T+6*H);
});

test("signed tick rounding and floored lots preserve12USD cap and exact cost decomposition",()=>{
 for(const side of [1,-1] as const){const f=fixture(10);price(f,5,side===1?110:90);
  const r=simulateHourlyRetryAccount({...f,forecasts:[signal("BTC/USD",0,side*100)]}),t=r.trades[0]!;
  const expectedEntry=side===1?101:99,expectedExit=side===1?109:91;
  assert.equal(t.entryPx,expectedEntry);assert.equal(t.exitPx,expectedExit);
  close(t.qty!/rules["BTC/USD"].minTradeIncrement,Math.round(t.qty!/rules["BTC/USD"].minTradeIncrement));
  assert.ok(t.entryNotionalUsd!<=12);assert.ok(t.qty!>=rules["BTC/USD"].minOrderSize);
  close(t.slippageUsd,t.qty!*(side*(expectedEntry-100)+side*((side===1?110:90)-expectedExit)));
  close(t.feesUsd,t.qty!*(expectedEntry+expectedExit)*.0005);
  close(t.netPnlUsd,t.grossPnlUsd!-t.feesUsd-t.slippageUsd-t.fundingUsd-t.fundingReserveUsd);
  close(r.netPnlUsd,t.netPnlUsd!);close(r.metrics.turnoverUsd,t.qty!*(expectedEntry+expectedExit));
 }
});

test("ETH tenth-dollar ticks, quantity cap and rounding apply in both scenarios",()=>{
 for(const scenario of [HOURLY_SCENARIOS.base,HOURLY_SCENARIOS.stress]){const f=fixture(10);
  const r=simulateHourlyRetryAccount({...f,scenario,forecasts:[signal("ETH/USD")]}),t=r.trades[0]!;
  assert.equal(t.entryPx,100.1);assert.equal(t.exitPx,99.9);assert.equal(t.qty,.119);assert.ok(t.entryNotionalUsd!<=12);
  assert.equal(t.entryMs,T+scenario.delayHours*H);assert.equal(t.exitMs,t.entryMs!+4*H);
 }
});

test("quantity below instrument minimum is known no-fill without fees or funding",()=>{
 const f=fixture(10);price(f,1,200000);
 const r=simulateHourlyRetryAccount({...f,forecasts:[signal(),signal("ETH/USD",1)]});
 assert.equal(r.trades[0]!.status,"UNFILLED");assert.equal(r.trades[0]!.noFillReason,"BELOW_MINIMUM_QUANTITY");
 assert.equal(r.trades[0]!.entryMs,null);assert.equal(r.trades[0]!.netPnlUsd,0);assert.equal(r.trades[0]!.feesUsd,0);
 assert.equal(r.metrics.zeroQuantityNoFills,1);assert.equal(r.trades[1]!.decisionMs,T+H);assert.equal(r.allSelectedPathsKnown,true);
});

test("zero-volume ENTRY no-fill continues to reserve its slot until candle close",()=>{
 const f=fixture(12);bar(f,1).volume=0;
 const r=simulateHourlyRetryAccount({...f,forecasts:[signal(),signal("ETH/USD",1,1000),signal("ETH/USD",2)]});
 assert.equal(r.trades[0]!.noFillReason,"ZERO_VOLUME");assert.equal(r.trades[0]!.exitMs,T+2*H);
 assert.equal(r.trades[1]!.decisionMs,T+2*H);assert.equal(r.skips.busyForecasts,1);assert.equal(r.metrics.zeroQuantityNoFills,0);
});

test("funding and fees carry through maintenance; reserve debits both sides while actual absolute funding remains signed",()=>{
 for(const side of [1,-1] as const){const f=fixture(12);for(let h=5;h<10;h++)bar(f,h).volume=0;
  const r=simulateHourlyRetryAccount({...f,forecasts:[signal("BTC/USD",0,side*100)],adverseFundingBpsPerHour:{"BTC/USD":2,"ETH/USD":2}}),t=r.trades[0]!;
  close(t.fundingUsd,t.qty!*100*.0002*9);assert.equal(r.settlements.length,9);
  close(r.netPnlUsd,t.grossPnlUsd!-t.feesUsd-t.slippageUsd-t.fundingUsd);
  for(const fund of f.funding)fund.absoluteRate=1;
  const actual=simulateHourlyRetryAccount({...f,forecasts:[signal("BTC/USD",0,side*100)]});
  close(actual.trades[0]!.fundingUsd,side*actual.trades[0]!.qty!*9);
 }
});

test("hourly drawdown includes carried position losses and daily equity telescopes after retry",()=>{
 const f=fixture(72);for(let h=5;h<10;h++){bar(f,h).volume=0;price(f,h,50);}price(f,10,110);
 const r=simulateHourlyRetryAccount({...f,forecasts:[signal()]});
 assert.ok(r.maximumDrawdownUsd!>5);assert.equal(r.metrics.positionHours,9);assert.equal(r.daily.length,3);
 close(r.daily.reduce((s,d)=>s+d.netPnlUsd!,0),r.netPnlUsd!);assert.equal(r.allSelectedPathsKnown,true);
});

test("UTC-day alternating priority ignores incomparable score magnitudes and is identical across stresses",()=>{
 const f=fixture(72),forecasts=[signal("BTC/USD",0,100),signal("ETH/USD",0,10000),signal("BTC/USD",24,100),signal("ETH/USD",24,10000)];
 const expected=[0,24].map(h=>Math.floor((T+h*H)/(24*H))%2===0?"BTC/USD":"ETH/USD");
 for(const scenario of [HOURLY_SCENARIOS.base,HOURLY_SCENARIOS.stress]){
  const r=simulateHourlyRetryAccount({...f,forecasts,scenario,rankingPolicy:"UTC_DAY_ALTERNATING",forecastsPrequalified:true});
  assert.deepEqual(r.trades.map(t=>t.symbol),expected);
 }
});

test("required rules validate, unavailable shorts skip, and missing funding never becomes zero",()=>{
 const f=fixture(10);assert.throws(()=>simulateHourlyRetryAccount({...f,assetRules:undefined as never,forecasts:[]}),/ASSET_RULES/);
 f.assetRules["BTC/USD"].shortable=false;assert.equal(simulateHourlyRetryAccount({...f,forecasts:[signal("BTC/USD",0,-100)]}).trades.length,0);
 const unknown=simulateHourlyRetryAccount({...f,funding:[],forecasts:[signal()]});assert.equal(unknown.netPnlUsd,null);
 assert.ok(unknown.unknowns.some(u=>u.reason==="MISSING_FUNDING"));
});
