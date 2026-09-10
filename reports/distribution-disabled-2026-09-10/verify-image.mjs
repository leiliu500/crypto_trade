import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const out='reports/distribution-disabled-2026-09-10';
const run=args=>execFileSync('docker',args,{encoding:'utf8',maxBuffer:16*1024*1024});
const [before,after]=JSON.parse(run(['image','inspect','crypto-trade-engine:spot-dashboard-v7','crypto-trade-engine:spot-dashboard-v8']));
assert.equal(before.Id,'sha256:e7e2f35eb9586863054ce67c1b2d57cc4bfddee34d6f20a4d01e0513779187f9');
assert.deepEqual(before.Config,after.Config,'Dashboard patch must preserve image command/environment/user/health configuration');
assert.deepEqual(after.RootFS.Layers.slice(0,before.RootFS.Layers.length),before.RootFS.Layers);
const code=`const fs=require('node:fs');const c=require('node:crypto');const files=[];function scan(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const f=p+'/'+e.name;if(e.isDirectory()){if(f!=='/app/dist/src/dashboard/public'&&f!=='/app/src/dashboard/public')scan(f)}else if(e.isFile())files.push({file:f,sha256:c.createHash('sha256').update(fs.readFileSync(f)).digest('hex')})}}for(const p of ['/app/src','/app/dist/src','/app/config'])scan(p);for(const p of ['/app/package.json','/app/package-lock.json'])files.push({file:p,sha256:c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')});files.sort((a,b)=>a.file.localeCompare(b.file));process.stdout.write(JSON.stringify(files));`;
const fingerprints= [before,after].map(image=>JSON.parse(run(['run','--rm','--network','none','--read-only','--entrypoint','node',image.Id,'-e',code])));
const allowedFiles=['/app/dist/src/engine/trading-engine.js','/app/dist/src/engine/trading-engine.js.map','/app/src/engine/trading-engine.ts'];
assert.deepEqual(fingerprints[0].filter(f=>!allowedFiles.includes(f.file)),fingerprints[1].filter(f=>!allowedFiles.includes(f.file)),'Unrelated runtime/config/dependency bytes unchanged');
for(const file of allowedFiles){
 const expected=createHash('sha256').update(readFileSync(file.replace('/app/',''))).digest('hex');
 assert.equal(fingerprints[1].find(f=>f.file===file)?.sha256,expected,'Image matches reviewed file '+file);
}
const guardBefore='const policyEvents = quoteEvent && !this.cfg.paperEntryExercise && !this.distributional';
const guardAfter='const policyEvents = quoteEvent && this.cfg.policyEngineEnabled && !this.cfg.paperEntryExercise && !this.distributional';
const reader="const fs=require('node:fs');process.stdout.write(JSON.stringify(['/app/src/engine/trading-engine.ts','/app/dist/src/engine/trading-engine.js'].map(p=>fs.readFileSync(p,'utf8'))))";
const sources=[before,after].map(img=>JSON.parse(run(['run','--rm','--network','none','--read-only','--entrypoint','node',img.Id,'-e',reader])));
for(let i=0;i<2;i++){assert.ok(sources[0][i].includes(guardBefore));assert.equal(sources[0][i].replace(guardBefore,guardAfter),sources[1][i],'Only the disabled-policy collection guard changes');}

const result={passed:true,beforeImage:before.Id,afterImage:after.Id,inheritedLayers:before.RootFS.Layers.length,imageConfigUnchanged:true,onlyRuntimeChange:"Honor disabled policy-engine flag during research collection",allowedFiles,nonStaticFilesCompared:fingerprints[0].length,nonStaticFingerprints:fingerprints[0]};
writeFileSync(out+'/image-verification.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({passed:true,beforeImage:before.Id,afterImage:after.Id,inheritedLayers:result.inheritedLayers,nonStaticFilesCompared:result.nonStaticFilesCompared}));
