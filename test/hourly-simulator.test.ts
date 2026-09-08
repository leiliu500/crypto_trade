import assert from "node:assert/strict";
import test from "node:test";
import {simulateHourlyAccount,HOURLY_MS as H,HOURLY_SCENARIOS,
  type HourlyBar,type FundingRow,type HourlyForecast} from "../src/research/hourly-simulator.js";

const T=Date.UTC(2024,0,1);
const close=(actual:number|null,expected:number,tolerance=1e-8)=>{assert.notEqual(actual,null);assert.ok(Math.abs(actual!-expected)<tolerance,`${actual} != ${expected}`);};
function fixture(hours=72){
 const bars:HourlyBar[]=[],funding:FundingRow[]=[];
 for(let i=0;i<=hours;i++)for(const symbol of ["BTC/USD","ETH/USD"] as const){
  bars.push({symbol,openMs:T+i*H,open:100,high:100,low:100,close:100,volume:1});
  funding.push({symbol,timestampMs:T+i*H,rate:0});
 }
 return {bars,funding,startMs:T,endMs:T+hours*H};
}
const forecast=(symbol:"BTC/USD"|"ETH/USD"="BTC/USD",hour=0,gross=100,horizonHours=4):HourlyForecast=>({symbol,decisionMs:T+hour*H,predictedGrossBps:gross,horizonHours});
function price(bars:HourlyBar[],hour:number,value:number,symbol="BTC/USD"){
 const b=bars.find(b=>b.symbol===symbol&&b.openMs===T+hour*H)!;Object.assign(b,{open:value,high:value,low:value,close:value});
}

test("strictly later open timing, shared BTC tie-break, and pending/open slots are causal",()=>{
 const f=fixture(12);price(f.bars,0,700);price(f.bars,1,100);price(f.bars,5,110);
 const r=simulateHourlyAccount({...f,forecasts:[forecast("ETH/USD"),forecast(),forecast("ETH/USD",1,999),forecast("ETH/USD",4,999),forecast("ETH/USD",5,90)]});
 assert.deepEqual(r.trades.map(t=>[t.symbol,t.decisionMs,t.entryMs,t.exitMs]),[
  ["BTC/USD",T,T+H,T+5*H],["ETH/USD",T+5*H,T+6*H,T+10*H]]);
 assert.equal(r.metrics.completed,2);assert.equal(r.skips.busyForecasts,2);
 close(r.trades[0]!.qty!*r.trades[0]!.entryPx!,12);
});

test("fees use both actual notionals and adverse slippage is charged exactly once",()=>{
 const f=fixture(8);price(f.bars,5,110);
 const r=simulateHourlyAccount({...f,forecasts:[forecast()]}),t=r.trades[0]!;
 const entry=100*1.00015,exit=110*.99985,q=12/entry;
 const fees=q*(entry+exit)*.0005,slip=q*((entry-100)+(110-exit));
 close(t.feesUsd,fees);close(t.slippageUsd,slip);close(t.grossPnlUsd,q*10);
 close(t.netPnlUsd,q*(exit-entry)-fees);close(r.netPnlUsd,t.netPnlUsd!);
 close(r.metrics.turnoverUsd,q*(entry+exit));close(r.metrics.turnoverInitialEquity,q*(entry+exit)/100000);
 close(r.daily.reduce((s,d)=>s+d.netPnlUsd!,0),r.netPnlUsd!);
});

test("absolute funding is fixed-unit signed cash flow and entry settlement is excluded",()=>{
 const f=fixture(7);for(const row of f.funding){row.rate=.8;row.absoluteRate=1;}
 price(f.bars,2,105);price(f.bars,3,108);
 const long=simulateHourlyAccount({...f,forecasts:[forecast("BTC/USD",0,100,2)]});
 const short=simulateHourlyAccount({...f,forecasts:[forecast("BTC/USD",0,-100,2)]});
 assert.deepEqual(long.settlements.map(s=>s.atMs),[T+2*H,T+3*H]);
 close(long.metrics.totalFundingUsd,2*long.trades[0]!.qty!);
 close(short.metrics.totalFundingUsd,-2*short.trades[0]!.qty!);
 assert.ok(long.settlements.every(s=>s.source==="ABSOLUTE_RATE"));
});

test("relative funding uses current mark and stress adds its adverse daily reserve",()=>{
 const f=fixture(8);for(const row of f.funding)row.rate=.0001;
 price(f.bars,3,110);price(f.bars,4,120);
 const r=simulateHourlyAccount({...f,scenario:HOURLY_SCENARIOS.stress,forecasts:[forecast("BTC/USD",0,100,2)]});
 const q=r.trades[0]!.qty!;
 assert.equal(r.trades[0]!.entryMs,T+2*H);assert.equal(r.trades[0]!.exitMs,T+4*H);
 close(r.metrics.totalFundingUsd,q*(110+120)*.0001);
 close(r.metrics.totalFundingReserveUsd,q*(110+120)*.0001/24);
});

test("explicit training reserve pays for both directions and replaces actual funding credits",()=>{
 const f=fixture(8);for(const row of f.funding){row.rate=-.1;row.absoluteRate=-100;}
 const adverseFundingBpsPerHour={"BTC/USD":2,"ETH/USD":3};
 const long=simulateHourlyAccount({...f,adverseFundingBpsPerHour,forecasts:[forecast("BTC/USD",0,100,2)]});
 const short=simulateHourlyAccount({...f,funding:[],adverseFundingBpsPerHour,forecasts:[forecast("BTC/USD",0,-100,2)]});
 close(long.metrics.totalFundingUsd,long.trades[0]!.qty!*100*.0002*2);
 close(short.metrics.totalFundingUsd,short.trades[0]!.qty!*100*.0002*2);
 assert.equal(short.accountingMode,"ADVERSE_TRAINING_RESERVE_SCENARIO");assert.equal(short.allSelectedPathsKnown,true);
 assert.ok(long.settlements.every(s=>s.rate===null&&s.absoluteRate===null&&s.source==="ADVERSE_TRAINING_RESERVE"));
 const stress=simulateHourlyAccount({...f,funding:[],adverseFundingBpsPerHour,scenario:HOURLY_SCENARIOS.stress,
  forecasts:[forecast("BTC/USD",0,100,2)]});
 assert.ok(stress.metrics.totalFundingReserveUsd!>0);
});

test("present zero-volume marks remain indicative and cannot be mistaken for executable exits",()=>{
 const f=fixture(8);f.bars.find(b=>b.symbol==="BTC/USD"&&b.openMs===T+3*H)!.volume=0;
 const r=simulateHourlyAccount({...f,forecasts:[forecast()]});
 assert.equal(r.metrics.staleMarkHours,1);assert.equal(r.allSelectedPathsKnown,true);assert.notEqual(r.netPnlUsd,null);
 assert.equal(r.trades[0]!.status,"COMPLETE");
});

test("mark-to-market captures an open loss hidden by a profitable clock exit",()=>{
 const f=fixture(8);price(f.bars,3,50);price(f.bars,5,110);
 const r=simulateHourlyAccount({...f,forecasts:[forecast()]});
 assert.ok(r.netPnlUsd!>0);assert.ok(r.maximumDrawdownUsd!>6);
 assert.ok(r.metrics.maximumLiquidationDrawdownUsd!>=r.maximumDrawdownUsd!);
 assert.equal(r.equity.find(e=>e.atMs===T+3*H)!.positionSymbol,"BTC/USD");
});

test("prequalification keeps stress eligibility/ranking fixed despite greater realized costs",()=>{
 const f=fixture(10),forecasts=[forecast("ETH/USD",0,15,2),forecast("BTC/USD",0,15,2)];
 const blocked=simulateHourlyAccount({...f,forecasts});assert.equal(blocked.trades.length,0);
 const base=simulateHourlyAccount({...f,forecasts,forecastsPrequalified:true});
 const stress=simulateHourlyAccount({...f,forecasts,forecastsPrequalified:true,scenario:HOURLY_SCENARIOS.stress});
 assert.equal(base.trades[0]!.symbol,"BTC/USD");assert.equal(stress.trades[0]!.symbol,"BTC/USD");
 assert.equal(base.trades[0]!.expectedNetBps,stress.trades[0]!.expectedNetBps);
 assert.ok(stress.netPnlUsd!<base.netPnlUsd!);
});

test("zero-volume entry releases its pending slot only when absence of fills is known at candle close",()=>{
 const f=fixture(10);f.bars.find(b=>b.symbol==="BTC/USD"&&b.openMs===T+H)!.volume=0;
 const r=simulateHourlyAccount({...f,forecasts:[forecast(),forecast("ETH/USD",1,1000),forecast("ETH/USD",2)]});
 assert.equal(r.trades[0]!.status,"UNFILLED");assert.equal(r.trades[0]!.entryMs,null);assert.equal(r.trades[0]!.netPnlUsd,0);
 assert.equal(r.trades[0]!.exitMs,T+2*H);assert.equal(r.trades[1]!.decisionMs,T+2*H);
 assert.equal(r.skips.busyForecasts,1);
 assert.equal(r.metrics.unfilled,1);assert.equal(r.metrics.completed,1);assert.equal(r.unknowns.length,0);
 assert.equal(r.allSelectedPathsKnown,true);
});

test("missing entry stays unknown; missing clock exit holds the global inventory slot",()=>{
 const missingEntry=fixture(10);missingEntry.bars=missingEntry.bars.filter(b=>!(b.symbol==="BTC/USD"&&b.openMs===T+H));
 const a=simulateHourlyAccount({...missingEntry,forecasts:[forecast()]});
 assert.equal(a.netPnlUsd,null);assert.ok(a.unknowns.some(u=>u.reason==="MISSING_ENTRY_BAR"));assert.equal(a.maximumDrawdownUsd,null);
 const missingExit=fixture(12);missingExit.bars.find(b=>b.symbol==="BTC/USD"&&b.openMs===T+5*H)!.volume=0;
 const b=simulateHourlyAccount({...missingExit,forecasts:[forecast(),forecast("ETH/USD",6,1000)]});
 assert.equal(b.netPnlUsd,null);assert.equal(b.trades.length,1);assert.equal(b.trades[0]!.exitMs,null);
 assert.ok(b.unknowns.some(u=>u.reason==="ZERO_VOLUME_EXIT_BAR"));
 assert.ok(b.unknowns.some(u=>u.reason==="ENDPOINT_UNRESOLVED_POSITION"));
});

test("missing selected funding or intermediate marks cannot silently become zero",()=>{
 const f=fixture(8);f.funding=f.funding.filter(x=>!(x.symbol==="BTC/USD"&&x.timestampMs===T+2*H));
 const r=simulateHourlyAccount({...f,forecasts:[forecast()]});
 assert.equal(r.trades[0]!.exitMs,T+5*H);assert.equal(r.trades[0]!.netPnlUsd,null);
 assert.equal(r.netPnlUsd,null);assert.equal(r.metrics.totalFundingUsd,null);assert.equal(r.daily[0]!.netPnlUsd,null);
 const marks=fixture(8);marks.bars=marks.bars.filter(b=>!(b.symbol==="BTC/USD"&&b.openMs===T+3*H));
 const m=simulateHourlyAccount({...marks,forecasts:[forecast()]});assert.equal(m.netPnlUsd,null);
 assert.ok(m.unknowns.some(u=>u.reason==="MISSING_MARK_BAR"));
});

test("flat calendar includes idle days with true zero and end-boundary signals do not force exits",()=>{
 const f=fixture(72),r=simulateHourlyAccount({...f,forecasts:[forecast("BTC/USD",71,100,4)]});
 assert.equal(r.trades.length,0);assert.equal(r.skips.endpointForecasts,1);assert.equal(r.netPnlUsd,0);
 assert.equal(r.maximumDrawdownUsd,0);assert.equal(r.daily.length,3);assert.ok(r.daily.every(d=>d.netPnlUsd===0));
});

test("duplicate/conflicting input, malformed OHLC, and unaligned forecasts fail before evaluation",()=>{
 const f=fixture(8);assert.throws(()=>simulateHourlyAccount({...f,bars:[...f.bars,f.bars[0]!],forecasts:[]}),/SIMULATION_BAR/);
 assert.throws(()=>simulateHourlyAccount({...f,funding:[...f.funding,f.funding[0]!],forecasts:[]}),/SIMULATION_FUNDING/);
 assert.throws(()=>simulateHourlyAccount({...f,forecasts:[forecast(),forecast()]}),/SIMULATION_FORECAST/);
 assert.throws(()=>simulateHourlyAccount({...f,forecasts:[{...forecast(),decisionMs:T+1}]}),/SIMULATION_FORECAST/);
 const bad=fixture(8);bad.bars[0]!.high=99;assert.throws(()=>simulateHourlyAccount({...bad,forecasts:[]}),/SIMULATION_BAR/);
});
