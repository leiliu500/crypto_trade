import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const out='reports/distribution-disabled-2026-09-10';
const read=name=>JSON.parse(readFileSync(out+'/'+name+'.json','utf8'));
const before=read('preflight'), image=read('image-verification');
const oldSpot=read('before-spot'),oldFutures=read('before-futures'),oldEth=read('before-eth40');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const containers=JSON.parse(execFileSync('docker',['inspect','crypto-trade-engine','crypto-spot-trend-paper','crypto-eth40-paper'],{encoding:'utf8'}));
assert.equal(containers[0].Image,image.afterImage);
assert.equal(containers[1].Id,before.containers[1].id);assert.equal(containers[1].State.StartedAt,before.containers[1].startedAt);
assert.equal(containers[2].Image,before.containers[2].image);
assert.equal(containers[2].Id,before.containers[2].id);assert.equal(containers[2].State.StartedAt,before.containers[2].startedAt);
for(let i=0;i<containers.length;i++){
 const c=containers[i];assert.equal(hash([...c.Config.Env].sort()),i===0?before.desiredEngineEnvironmentSha256:before.containers[i].environmentSha256);
 assert.deepEqual(c.Mounts.map(m=>({name:m.Name,destination:m.Destination,readWrite:m.RW})).sort((a,b)=>a.destination.localeCompare(b.destination)),[...before.containers[i].mounts].sort((a,b)=>a.destination.localeCompare(b.destination)));
 assert.equal(c.State.Running,true);assert.equal(c.State.Health?.Status,'healthy',c.Name);
}
assert.equal(Object.values(containers[2].HostConfig.PortBindings??{}).flat().filter(Boolean).length,0,'ETH40 must publish no host port');
assert.ok(containers[2].NetworkSettings.Networks['crypto-trade_default']);
const get=async path=>{const r=await fetch('http://127.0.0.1:3001'+path,{signal:AbortSignal.timeout(5000)});assert.ok(r.ok,path);return r.json()};
const [eth,receipts,manifest,spot,futures]=await Promise.all(['/api/eth40/status','/api/eth40/receipts','/api/eth40/manifest','/api/spot-dashboard','/api/dashboard'].map(get));
assert.equal(eth.available,true);assert.equal(eth.collectorHealthy,true);assert.equal(eth.liveTradingEnabled,false);
for(const key of ['startedAtMs','firstExecutionDayMs','reviewAtMs'])assert.equal(eth[key],oldEth[key]);
assert.ok(eth.sequence>oldEth.sequence);assert.deepEqual(receipts,read('before-eth40Receipts'));assert.deepEqual(manifest,read('before-eth40Manifest'));
assert.equal(spot.healthy,true);assert.equal(spot.orderActivity.available,true);assert.deepEqual(spot.state.account,oldSpot.state.account);assert.deepEqual(spot.state.orders,oldSpot.state.orders);assert.equal(spot.state.startedAtMs,oldSpot.state.startedAtMs);
assert.equal(futures.overall,'healthy');for(const key of ['mode','paper','configurationVersion','equity','sessionStartingEquity'])assert.deepEqual(futures[key],oldFutures[key],key);
assert.equal(futures.policyEngineEnabled,false);assert.equal(futures.crossAssetPaperEntriesEnabled,false);assert.equal(futures.crossAssetPaperEvaluationEnabled,false);assert.equal(futures.modelOnlyEntries,true);
assert.ok(futures.markets.every(m=>m.distributional==null&&m.policyPulse==null),'No active model telemetry');
const served=[];for(const file of ['index.html','app.js','spot.js','eth40.js','styles.css']){
 const r=await fetch('http://127.0.0.1:3001/'+(file==='index.html'?'?view=eth40':file));assert.ok(r.ok,file);
 const bytes=Buffer.from(await r.arrayBuffer());assert.deepEqual(bytes,readFileSync('src/dashboard/public/'+file));
 served.push({file,sha256:createHash('sha256').update(bytes).digest('hex')});
}
let oldPortClosed=false;try{await fetch('http://127.0.0.1:3003/healthz',{signal:AbortSignal.timeout(1000)})}catch{oldPortClosed=true}assert.equal(oldPortClosed,true);
for(const [key,value] of Object.entries({eth40:eth,receipts,manifest,spot,futures}))writeFileSync(out+'/after-'+key+'.json',JSON.stringify(value,null,2)+'\n');
const result={passed:true,checkedAt:new Date().toISOString(),path:'/?view=eth40',dashboardPort:3001,eth40HostPortRemoved:true,eth40ImageManifestAndAccountsPreserved:true,btcPaperContainerAndAccountsPreserved:true,futuresDashboardStatePreserved:true,eth40Sequence:eth.sequence,served,containers:containers.map(c=>({name:c.Name,id:c.Id,image:c.Image,startedAt:c.State.StartedAt,health:c.State.Health.Status,publishedPorts:c.HostConfig.PortBindings,networks:Object.keys(c.NetworkSettings.Networks)}))};
writeFileSync(out+'/deployment-verification.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({passed:true,path:result.path,eth40Sequence:eth.sequence,eth40HostPortRemoved:true,allServicesHealthy:true}));
