import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=resolve('reports/spot-continuous-entries-2026-09-10');
const old=await import(pathToFileURL(join(root,'previous-runtime/paper.js')));
const revised=await import(pathToFileURL(resolve('dist/src/spot-trend/paper.js')));
const hash=raw=>createHash('sha256').update(raw).digest('hex');
assert.equal(old.SPOT_PAPER_SPEC.version,'btc-spot-weekly-research-paper-runner-v2');
assert.equal(revised.SPOT_PAPER_SPEC.entrySchedule,'CONTINUOUS_EACH_CYCLE');
const envelope=JSON.parse(await readFile(join(root,'baseline-journal/state.json'),'utf8'));
const files=(await readdir(join(root,'baseline-journal/cycles'))).sort((a,b)=>Number(a.split('-')[0])-Number(b.split('-')[0]));
const cycles=[], bindings={};
for(const file of files){const raw=await readFile(join(root,'baseline-journal/cycles',file));const cycle=JSON.parse(raw);bindings[file]=hash(raw);if(cycle.phase!=='BROKER_SETTLEMENT')cycles.push(cycle);}
const summaries={};
for(const [label,runtime] of [['previous',old],['revised',revised]]){
 let state=runtime.createSpotPaperState(envelope.state.evidenceSha256,envelope.state.startedAtMs);
 const reasons={}, observations=[];
 for(const cycle of cycles){const result=runtime.advanceSpotPaper(state,cycle.market,cycle.recordedAtMs);state=result.state;
  reasons[result.decision.reason]=(reasons[result.decision.reason]??0)+1;
  observations.push({atMs:cycle.recordedAtMs,reason:result.decision.reason,action:result.decision.action,fill:result.decision.fill,netPnlUsd:result.decision.mark?.netPnlUsd??null});
 }
 runtime.validateSpotPaperState(state);
 summaries[label]={version:runtime.SPOT_PAPER_SPEC.version,cycles:state.cycles,orders:state.orders.length,filledOrders:state.account.receipts.length,
  closedEpisodes:state.account.receipts.filter(r=>r.side==='sell').length,cashUsd:state.account.cashUsd,quantity:state.account.quantity,feesUsd:state.account.feesUsd,
  realizedNetUsd:state.account.realizedNetUsd,liquidationNetUsd:state.lastDecision.mark?.netPnlUsd??null,reasons,receipts:state.account.receipts};
 await writeFile(join(root,`replay-${label}.json`),JSON.stringify({summary:summaries[label],observations},null,2)+'\n');
}
assert.equal(summaries.previous.orders,0);
assert.equal(summaries.previous.reasons.NEXT_WEEK_ENTRY_WINDOW,cycles.length);
assert.equal(summaries.revised.filledOrders,1);
assert.equal(summaries.revised.reasons.NEXT_WEEK_ENTRY_WINDOW,undefined);
assert.ok(summaries.revised.quantity>0);
assert.ok(summaries.revised.feesUsd>0);
const report={version:'recorded-books-timing-comparison-v1',recordedAt:new Date().toISOString(),passed:true,sourceDataSha256:hash(JSON.stringify(bindings)),inputBindings:bindings,
 firstTimestamp:new Date(cycles[0].recordedAtMs).toISOString(),lastTimestamp:new Date(cycles.at(-1).recordedAtMs).toISOString(),observedCycles:cycles.length,
 ...summaries,profitsProven:false,historicalIndependentHoldout:false,capitalMutated:false,
 limitations:['Retrospective short sample using existing recorded books; zero closed trend episodes.','Immediate simulated IOC settlement uses recorded book, with declared fees, price collar and depth participation; no real venue fill observed.','Current liquidation PnL includes estimated exit fee at best bid; actual exit liquidity, timing and price can differ.','Revised execution timing has no independently validated profitability claim.']};
await writeFile(join(root,'replay-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,inputBindings:undefined},null,2));
