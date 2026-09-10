import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
const phase=process.argv[2];assert.ok(['before','after'].includes(phase));
const out='reports/distribution-disabled-2026-09-10';
const previous=phase==='after'?JSON.parse(readFileSync(out+'/account-before.json','utf8')):null;
const prefix=previous?.funding.events??0;
const code=`const fs=require('node:fs'),c=require('node:crypto'),hash=x=>c.createHash('sha256').update(JSON.stringify(x)).digest('hex');const s=JSON.parse(fs.readFileSync('/app/data/kraken-paper-state.json','utf8'));process.stdout.write(JSON.stringify({at:new Date().toISOString(),initialEquity:s.initialEquity,cashEquity:s.cashEquity,orders:s.orders.length,ordersSha256:hash(s.orders),activities:s.activities.length,activitiesSha256:hash(s.activities),positions:s.positions.length,positionsSha256:hash(s.positions),funding:{configSha256:hash(s.funding.state.config),events:s.funding.state.events.length,eventsSha256:hash(s.funding.state.events),priorPrefixSha256:hash(s.funding.state.events.slice(0,${prefix})),newCashEvents:s.funding.state.events.slice(${prefix}).filter(e=>e.type==='FILL'||e.type==='POSTING').length}}));`;
const snapshot=JSON.parse(execFileSync('docker',['exec','crypto-trade-engine','node','-e',code],{encoding:'utf8',maxBuffer:4*1024*1024}));
if(previous){
 for(const key of ['initialEquity','cashEquity','orders','ordersSha256','activities','activitiesSha256','positions','positionsSha256'])assert.deepEqual(snapshot[key],previous[key],key);
 assert.equal(snapshot.funding.configSha256,previous.funding.configSha256);assert.equal(snapshot.funding.priorPrefixSha256,previous.funding.eventsSha256);assert.equal(snapshot.funding.newCashEvents,0);
 snapshot.continuityPassed=true;
}
writeFileSync(out+'/account-'+phase+'.json',JSON.stringify(snapshot,null,2)+'\n');
console.log(JSON.stringify({phase,cashEquity:snapshot.cashEquity,orders:snapshot.orders,activities:snapshot.activities,positions:snapshot.positions,continuityPassed:snapshot.continuityPassed??null}));
