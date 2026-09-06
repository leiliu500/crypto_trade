import assert from "node:assert/strict";
import test from "node:test";
import { BreakoutRetest } from "../src/strategy/breakout-retest.js";
import { SignalEpisodeCollector } from "../src/research/signal-episodes.js";
import type { BookState } from "../src/core/market.js";
import type { DeterministicFeatures } from "../src/strategy/deterministic-features.js";
const book=(at:number,mid:number):BookState=>({symbol:"BTC/USD",receiveTsMs:at,exchangeTsMs:at,sequence:BigInt(at),
  valid:true,sourceReset:false,bids:[{px:mid-.005,qty:100}],asks:[{px:mid+.005,qty:100}]});
test("longer range preserves prior extremes outside the one-minute window",()=>{
  const short=new BreakoutRetest(),long=new BreakoutRetest(300_000);
  for(let second=1;second<=301;second++)for(const d of [short,long])d.observe(book(second*1000,second===100?100.1:100));
  for(const d of [short,long]){
    d.onTrade({id:"buy",symbol:"BTC/USD",qty:1,px:100.03,aggressor:1,receiveTsMs:302000,exchangeTsMs:302000});
    d.observe(book(302000,100.03));
  }
  assert.equal(short.snapshot().phase,"BREAKOUT");
  assert.equal(long.snapshot().phase,"WATCHING");
  assert.equal(long.snapshot().rangeMs,300000);
  long.observe(book(310000,100));
  assert.equal(long.snapshot().samples,0,"gaps invalidate the longer context too");
  assert.throws(()=>new BreakoutRetest(120000));
});
for(const side of [1,-1] as const)test(`five-minute retest collects isolated shadow policies for side ${side}`,()=>{
  const c=new SignalEpisodeCollector("test","BTC/USD",5,3);
  const context={healthAllowed:true,healthReasons:[],liquidityPass:true,liquidityReasons:[],positionOpen:true,
    pendingOrder:true,cooldownRemainingMs:100000,sizing:"VENUE_NOTIONAL_ONLY" as const};
  const asset={symbol:"BTC/USD",minOrderSize:.001,minTradeIncrement:.001,priceIncrement:.001,maximumOrderQty:100,shortable:true};
  const quote=(second:number,move:number)=>{
    const at=second*1000,mid=100+side*move;
    c.onTrade({id:String(second),symbol:"BTC/USD",qty:1,px:mid,aggressor:side,exchangeTsMs:at,receiveTsMs:at});
    const f={symbol:"BTC/USD",receiveTsMs:at,mid,spreadBps:1,stale:false,warmedUp:true,
      trendFastBps:0,trendMediumBps:0,trendSlowBps:0,slowTrendEfficiency:0,ofi:0,tfi:0,
      impulseBps:0,breakoutUpBps:0,breakoutDownBps:0,velocityZ:0} as DeterministicFeatures;
    return c.observe(book(at,mid),f,asset,{long:context,short:context});
  };
  for(let s=1;s<=301;s++)assert.deepEqual(quote(s,0),[]);
  quote(302,.03);quote(303,.08);quote(304,.005);quote(305,.006);quote(306,.007);
  const starts=quote(307,.009);
  assert.equal(starts.length,20,"four exits times five execution stresses");
  assert.ok(starts.every(o=>o.hypothesisId==="breakout-retest-5m"&&o.family==="BREAKOUT_RETEST"
    &&o.side===side&&o.features.rangeMs===300000&&Number.isFinite(o.features.invalidationPx)));
  assert.ok(starts.every(o=>o.context.positionOpen&&o.context.cooldownRemainingMs>0));
  assert.equal(c.stats().episodes,1);
});
