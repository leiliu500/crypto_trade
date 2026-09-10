import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const H=3600000,D=24*H,S=['BTC/USD','ETH/USD'];
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const grouped=(rows,key)=>{const m=new Map();for(const row of rows){const k=key(row);if(!m.has(k))m.set(k,[]);m.get(k).push(row);}return m;};
const date=t=>new Date(t).toISOString().slice(0,10);
const rounded=(v,tick,buy)=>(buy?Math.ceil(v/tick-1e-10):Math.floor(v/tick+1e-10))*tick;

/** Independent auditor: imports only Node built-ins. It reconstructs cash,
 * inventory, hourly liquidation value and risk decisions from saved execution
 * evidence; no implementation accounting/governor functions are imported. */
export function auditRiskRun(run,input,{name='run'}={}){
 let checks=0,maximumNumericDifference=0;const failures=[];
 const ok=(condition,label)=>{checks++;if(!condition)failures.push(label);};
 const near=(actual,expected,label,tolerance=1e-7)=>{
  if(actual===null||expected===null){ok(actual===expected,label);return;}
  const diff=Math.abs(actual-expected);maximumNumericDifference=Math.max(maximumNumericDifference,diff);
  ok(Number.isFinite(actual)&&Number.isFinite(expected)&&diff<=tolerance,label);
 };
 const rules=input.rules,scenario=run.scenario;
 for(const key of ['bars','funding','targets','rules'])if(input[key]!==undefined){
  ok(run.inputReceipts[key].sha256===sha(input[key]),'input receipt '+key);
 }
 const bars=new Map((input.bars??[]).map(b=>[`${b.symbol}:${b.openMs}`,b]));
 const fundSource=new Map((input.funding??[]).map(f=>[`${f.symbol}:${f.timestampMs+scenario.fundingShiftMs}`,f]));
 const targets=new Map(input.targets.map(t=>[t.decisionMs,t]));
 const fills=grouped(run.fills,f=>f.atMs), funds=grouped(run.fundingReceipts,f=>f.atMs);
 const plans=new Map(run.plans.map(p=>[p.atMs,p])), attempts=new Map(run.attempts.map(a=>[a.orderId,a]));
 const cancelled=new Map(run.riskCancelledOrders.map(c=>[c.orderId,c]));
 const fillsByOrder=new Map(run.fills.map(f=>[f.orderId,f]));
 const quantities=Object.fromEntries(S.map(s=>[s,0])), average=Object.fromEntries(S.map(s=>[s,0]));
 const fees=Object.fromEntries(S.map(s=>[s,0])), paidFunding=Object.fromEntries(S.map(s=>[s,0]));
 const realized=Object.fromEntries(S.map(s=>[s,0]));
 let cash=run.finalState.initialEquityUsd, priorEquity=cash, peakEquity=cash, markDD=0, peakLiq=cash, liqDD=0;
 let riskPeak=cash, dayReference=null, currentDay=null, riskDDMax=0, riskDayLossMax=0;
 let ddHalt=false, dayHalt=false, unknownHalt=false, riskIndex=0, seenUnknown=false;
 let lastDayLoss=null,lastDrawdown=null,lastDayPreviousLoss=null,lastDayPreviousHalt=null,lastKnown=false;
 const daily=new Map();let expectedFunding=0;
 const addDay=(at,value)=>{const k=date(Math.max(run.startMs,Math.min(run.endMs-1,at)));daily.set(k,(daily.get(k)??0)+value);};
 const equity=marks=>cash+S.reduce((n,s)=>n+quantities[s]*(marks[s]-average[s]),0);
 const liquidation=marks=>equity(marks)-S.reduce((n,s)=>{
  const q=quantities[s];if(!q)return n;
  const closePx=rounded(marks[s]*(1-Math.sign(q)*scenario.slippageBps/10000),rules[s].priceIncrement,q<0);
  return n+q*(marks[s]-closePx)+Math.abs(q)*closePx*scenario.feeBps/10000;
 },0);
 const observe=(at,phase,marks,known)=>{
  const recorded=run.riskTimeline[riskIndex++];ok(!!recorded,`risk row ${riskIndex} exists`);if(!recorded)return {cap:0,scale:0,flat:true};
  ok(recorded.atMs===at&&recorded.phase===phase,`risk ${riskIndex} phase/time`);
  const value=known?liquidation(marks):null;near(recorded.liquidationEquityUsd,value,`risk ${riskIndex} reconstructed liquidation`);
  ok(recorded.accountingKnown===known,`risk ${riskIndex} known flag`);
  const nextDay=Math.floor(at/D)*D;
  let dd=null,dayLoss=null,previousDayLoss=null,previousDayHalt=null;
  unknownHalt||=!known;
  if(known){
   riskPeak=Math.max(riskPeak,value);dd=Math.max(0,riskPeak-value);riskDDMax=Math.max(riskDDMax,dd);
   ddHalt||=dd>=3||3-dd<=Number.EPSILON*8*Math.max(1,Math.abs(riskPeak));
   if(dayReference!==null){
    dayLoss=Math.max(0,dayReference-value);riskDayLossMax=Math.max(riskDayLossMax,dayLoss);
    dayHalt||=dayLoss>=1.2||1.2-dayLoss<=Number.EPSILON*8*Math.max(1,Math.abs(dayReference));
   }
  }
  if(currentDay!==null&&currentDay!==nextDay){
   previousDayLoss=dayLoss;previousDayHalt=dayHalt;
   unknownHalt||=at!==nextDay||nextDay!==currentDay+D;
   dayReference=value;dayLoss=value===null?null:0;dayHalt=false;
  }else if(currentDay===null){dayReference=value;dayLoss=value===null?null:0;}
  if(dayReference===null)unknownHalt=true;
  currentDay=nextDay;
  const halted=unknownHalt||ddHalt||dayHalt||!known;
  const scale=halted?0:Math.min(1,Math.max(0,1-dd/3),Math.max(0,1-dayLoss/1.2)),cap=12*scale;
  const d=recorded.decision;
  near(d.maximumGrossNotionalUsd,cap,`risk ${riskIndex} cap`);near(d.exposureScale,scale,`risk ${riskIndex} scale`);
  near(d.drawdownUsd,dd,`risk ${riskIndex} drawdown`);near(d.dailyLossUsd,dayLoss,`risk ${riskIndex} daily loss`);
  near(d.previousDayLossUsd,previousDayLoss,`risk ${riskIndex} old day loss`);
  ok(d.previousDayHalted===previousDayHalt,`risk ${riskIndex} old day latch`);
  ok(d.drawdownHalted===ddHalt&&d.dailyHalted===dayHalt&&d.accountingHalted===unknownHalt,`risk ${riskIndex} persistent latches`);
  ok(d.forceFlat===(scale===0)&&d.accountingKnown===known,`risk ${riskIndex} decision status`);
  lastDayLoss=dayLoss;lastDrawdown=dd;lastDayPreviousLoss=previousDayLoss;lastDayPreviousHalt=previousDayHalt;lastKnown=known;
  return {cap,scale,flat:scale===0};
 };
 const execute=(f,marks)=>{
  const s=f.symbol,q=f.signedQty,old=quantities[s],price=f.price;
  near(Math.abs(q)/rules[s].minTradeIncrement,Math.round(Math.abs(q)/rules[s].minTradeIncrement),'fill lot');
  near(price/rules[s].priceIncrement,Math.round(price/rules[s].priceIncrement),'fill tick');
  near(f.feeUsd,Math.abs(q)*price*scenario.feeBps/10000,'fill fee');
  const intended=rounded(marks[s]*(1+Math.sign(q)*scenario.slippageBps/10000),rules[s].priceIncrement,q>0);
  near(price,intended,'adverse execution proxy');
  let gain=0;
  if(!old||Math.sign(old)===Math.sign(q))average[s]=(Math.abs(old)*average[s]+Math.abs(q)*price)/(Math.abs(old)+Math.abs(q));
  else{ok(Math.abs(q)<=Math.abs(old)+1e-12,'no unconfirmed reversal');gain=Math.sign(old)*Math.abs(q)*(price-average[s]);}
  quantities[s]=Number((old+q).toFixed(12));if(!quantities[s])average[s]=0;
  realized[s]+=gain;fees[s]+=f.feeUsd;cash+=gain-f.feeUsd;
 };
 const sampled=new Set();
 for(let i=0;i<run.equity.length;i++){
  const row=run.equity[i],at=row.atMs,marks=row.marks;
  ok(at===run.startMs+i*H,'hourly continuity');
  // Missing exposed prices/funding are discovered before PRE_TRADE. Missing
  // adjustment quotes are discovered during planning; terminal inventory at FINAL_STATUS.
  if(run.unknowns.some(u=>u.atMs<=at&&!['MISSING_ADJUSTMENT_QUOTES','TERMINAL_OPEN_INVENTORY','TERMINAL_UNRESOLVED_ORDERS'].includes(u.reason)))seenUnknown=true;
  const actualFunds=funds.get(at)??[];
  if(at>run.startMs)for(const s of S)if(quantities[s]){
   expectedFunding++;const found=actualFunds.filter(f=>f.symbol===s);ok(found.length===1,'one settlement per exposed interval');
   const f=found[0];if(!f)continue;
   near(f.signedQty,quantities[s],'funding prior inventory');
   const raw=fundSource.get(`${s}:${at}`);
   if(input.funding){near(f.absoluteRate,raw?.absoluteRate??null,'source absolute rate');}
   const cost=f.absoluteRate===null?null:quantities[s]*f.absoluteRate;
   near(f.actualCostUsd,cost,'signed funding amount');
   const priorBar=bars.get(`${s}:${at-H}`);if(priorBar)near(f.mark,priorBar.close,'funding mark from completed bar');
   const extra=Math.abs(quantities[s])*f.mark*scenario.extraFundingBpsPerDay/24/10000;
   near(f.extraCostUsd,extra,'stress funding charge');near(f.knownCostUsd,(cost??0)+extra,'funding known components');
   cash-=(cost??0)+extra;paidFunding[s]+=(cost??0)+extra;
  }
  const pre=equity(marks),preLiquidation=liquidation(marks);
  near(row.preTradeEquityUsd,seenUnknown?null:pre,'pretrade equity');
  addDay(at===run.startMs?at:at-1,pre-priorEquity);
  peakEquity=Math.max(peakEquity,pre);markDD=Math.max(markDD,peakEquity-pre);
  peakLiq=Math.max(peakLiq,preLiquidation);liqDD=Math.max(liqDD,peakLiq-preLiquidation);
  let risk=observe(at,'PRE_TRADE',marks,!seenUnknown);
  const plan=plans.get(at);
  if(plan){
   near(plan.maximumGrossNotionalUsd,risk.cap,'planned risk cap');
   const declared=targets.get(plan.targetDecisionMs);
   const target=declared&&declared.decisionMs<=at-scenario.delayHours*H&&declared.availableAtMs<=at?declared:null;
   if(plan.orders.length)ok(!!target,'orders require an activated target');
   const mustFlat=risk.flat||at>=run.endMs-48*H||target&&at>=target.validUntilMs;
   for(const s of S)near(plan.desiredUsd[s],mustFlat?0:(target?.targetUsd[s]??0)*risk.scale,'target scaled once');
   if(plan.status==='INCREASE')ok(plan.grossNotionalUsd<=risk.cap+1e-10,'increase respects declared cap');
   const pending=plan.orders.map(o=>({...o}));
   for(const order of plan.orders){
    const projected=S.reduce((n,s)=>n+Math.abs(quantities[s]+pending.filter(o=>o.symbol===s&&!o.reduceOnly).reduce((x,o)=>x+o.signedQty,0))*plan.riskPrices[s],0);
    const shouldCancel=!order.reduceOnly&&(risk.flat||projected>risk.cap+1e-10);
    const cancel=cancelled.get(order.id),attempt=attempts.get(order.id),fill=fillsByOrder.get(order.id);
    ok(shouldCancel===!!cancel,'risk cancellation justified by contemporaneous cap');
    if(cancel){near(cancel.capUsd,risk.cap,'cancel cap');ok(!fill&&!attempt,'cancel is not a fill/no-fill');pending.splice(pending.findIndex(o=>o.id===order.id),1);continue;}
    ok(!!attempt,'noncancelled reservation gets execution receipt');if(!attempt)continue;
    if(attempt.status==='ZERO_VOLUME_UNFILLED'){
     ok(!fill&&attempt.knownAtMs===at+H,'zero-volume receipt delayed');
     const b=bars.get(`${order.symbol}:${at}`);if(b)ok(b.volume===0,'zero-volume source');
    }else{
     ok(!!fill&&attempt.knownAtMs===at,'fill immediate under open proxy');if(!fill)continue;
     ok(!sampled.has(fill.id),'unique consumed fill');sampled.add(fill.id);
     near(fill.signedQty,order.signedQty,'fill reserved quantity');ok(fill.atMs===at,'fill planned time');
     const b=bars.get(`${order.symbol}:${at}`);if(b)ok(b.volume>0,'positive volume fill proxy');
     execute(fill,marks);pending.splice(pending.findIndex(o=>o.id===order.id),1);
     risk=observe(at,'POST_FILL',marks,!seenUnknown);
    }
   }
  }
  if(run.unknowns.some(u=>u.atMs<=at&&u.reason==='MISSING_ADJUSTMENT_QUOTES'))seenUnknown=true;
  observe(at,'POST_TRADE',marks,!seenUnknown);
  const after=equity(marks),afterLiq=liquidation(marks);
  near(row.indicativeEquityUsd,after,'hourly reconstructed indicative equity');
  near(row.indicativeLiquidationEquityUsd,afterLiq,'hourly reconstructed liquidation');
  near(row.cashUsd,cash,'cash ledger');for(const s of S)near(row.quantities[s],quantities[s],'position ledger');
  addDay(at,after-pre);priorEquity=after;
  peakEquity=Math.max(peakEquity,after);markDD=Math.max(markDD,peakEquity-after);
  peakLiq=Math.max(peakLiq,afterLiq);liqDD=Math.max(liqDD,peakLiq-afterLiq);
 }
 if(!run.allPathsKnown)observe(run.endMs,'FINAL_STATUS',run.equity.at(-1).marks,false);
 ok(riskIndex===run.riskTimeline.length,'all risk observations consumed');ok(sampled.size===run.fills.length,'all fills reconstructed');
 ok(expectedFunding===run.fundingReceipts.length,'no hidden funding receipts');
 near(run.indicativeNetPnlUsd,priorEquity-run.finalState.initialEquityUsd,'indicative account net');
 near(run.maximumDrawdownUsd,run.allPathsKnown?markDD:null,'reported mark drawdown');
 near(run.maximumLiquidationDrawdownUsd,run.allPathsKnown?liqDD:null,'reported liquidation drawdown');
 for(const d of run.daily)near(d.indicativeNetPnlUsd,daily.get(d.date)??0,'full calendar daily PnL');
 for(const s of S){
  near(run.perAsset[s].feesUsd,fees[s],'asset fees');near(run.perAsset[s].pricePnlUsd,realized[s],'asset realized PnL');
  near(run.perAsset[s].actualFundingCostUsd+run.perAsset[s].extraFundingCostUsd,paidFunding[s],'asset funding');
 }
 const st=run.finalRiskState;
 near(st.peakLiquidationEquityUsd,riskPeak,'final monotonic liquidation peak');
 near(st.dailyReferenceEquityUsd,dayReference,'final daily reference');near(st.maximumDrawdownUsd,riskDDMax,'final max risk drawdown');
 near(st.maximumObservedDailyLossUsd,riskDayLossMax,'final max risk daily loss');
 near(st.drawdownUsd,lastDrawdown,'final risk drawdown');near(st.dailyLossUsd,lastDayLoss,'final risk daily loss');
 near(st.previousDayLossUsd,lastDayPreviousLoss,'final prior day loss');ok(st.previousDayHalted===lastDayPreviousHalt,'final prior day latch');
 ok(st.drawdownHalted===ddHalt&&st.dailyHalted===dayHalt&&st.accountingHalted===unknownHalt,'final latches');
 ok(st.lastAccountingKnown===lastKnown&&st.utcDayStartMs===currentDay,'final timing/known');
 const observations=run.riskTimeline.map(r=>({atMs:r.atMs,liquidationEquityUsd:r.liquidationEquityUsd,accountingKnown:r.accountingKnown}));
 ok(JSON.stringify(observations)===JSON.stringify(st.observations),'checkpoint risk history matches timeline');
 let chain=sha({spec:run.riskSpec,initialEquityUsd:st.initialEquityUsd});
 for(const observation of observations)chain=sha({previous:chain,observation});
 ok(chain===st.observationsSha256,'complete observation hash chain');
 const {observations:_o,observationsSha256:_h,stateSha256,...core}=st;
 ok(sha({...core,observationCount:observations.length,observationsSha256:chain})===stateSha256,'risk state core hash');
 return {name,passed:failures.length===0,checks,maximumNumericDifference,failures,
  fills:run.fills.length,fundingReceipts:run.fundingReceipts.length,riskObservations:riskIndex,
  unknowns:run.unknowns.length,cancellations:run.riskCancelledOrders.length,
  finalDrawdownHalted:ddHalt,finalAccountingHalted:unknownHalt};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv[2]!=='--synthetic')throw new Error('Explicit --synthetic required; real study audit awaits parent release');
 const cases=JSON.parse(await readFile('/tmp/portfolio-v2-audit-fixtures.json','utf8'));
 const rows=cases.map(c=>auditRiskRun(c.run,c.input,{name:c.name}));
 const controls=[
  ['altered-fill-fee',r=>{r.fills[0].feeUsd+=.1;}],
  ['altered-signed-funding',r=>{r.fundingReceipts[0].actualCostUsd+=.1;}],
  ['altered-risk-cap',r=>{r.riskTimeline[0].decision.maximumGrossNotionalUsd=11;}],
  ['reset-peak-checkpoint',r=>{r.finalRiskState.peakLiquidationEquityUsd=1;}],
  ['missing-risk-observation',r=>{r.riskTimeline.splice(1,1);}],
 ].map(([name,mutate])=>{
  const changed=structuredClone(cases[0].run);mutate(changed);
  const audited=auditRiskRun(changed,cases[0].input,{name});
  return{name,rejected:!audited.passed,discrepancyCount:audited.failures.length};
 });
 const report={version:'independent-v2-auditor-synthetic-v1',createdAtUtc:new Date().toISOString(),
  scope:'Synthetic fixtures only; no historical financial evaluation',
  passed:rows.every(r=>r.passed)&&controls.every(c=>c.rejected),rows,negativeControls:controls};
 await writeFile('/tmp/portfolio-v2-auditor-synthetic-report.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
}
