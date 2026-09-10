import {loadConfig} from "/home/ec2-user/crypto_trade/src/config.ts";
import {createRiskBoundedTrainingContext,trainingContextHash} from "/home/ec2-user/crypto_trade/src/distribution/risk-training-context.ts";
import {readRiskTrainingSourceHashes} from "/home/ec2-user/crypto_trade/src/distribution/risk-training-source.ts";
import {buildDistributionTraining} from "/home/ec2-user/crypto_trade/src/distribution/training-backfill.ts";
import {writeFileSync} from "node:fs";
const cfg=loadConfig({TRADING_MODE:"paper",DISTRIBUTIONAL_ENGINE_ENABLED:"true"});
const riskContext=createRiskBoundedTrainingContext(cfg.symbolConfigs,cfg.distributionalSizingPolicy,100000);
const costs={"BTC/USD":{feeBps:5,reserveBps:3},"ETH/USD":{feeBps:5,reserveBps:3}};
const assets=Object.fromEntries(Object.keys(costs).map(symbol=>[symbol,{symbol,minOrderSize:.001,minTradeIncrement:.001,priceIncrement:.01,maximumOrderQty:100,shortable:true}]));
const start=Date.UTC(2025,0,1),cutoff=start+3603000;
const book=(atMs,symbol="BTC/USD")=>({kind:"BOOK",delta:{symbol,sourceId:`${symbol}:${atMs}`,reset:true,exchangeTsMs:atMs,receiveTsMs:atMs,bids:[{px:100,qty:100}],asks:[{px:100.01,qty:100}]}});
function* events(){for(let at=start;at<=cutoff;at+=1000){yield book(at);yield book(at,"ETH/USD");}}
const initial=await buildDistributionTraining(events(),costs,assets,{cutoffMs:cutoff,riskContext});
const sourceCodeHashes=readRiskTrainingSourceHashes();
const artifact={...initial.state,trainingBackfill:{...initial.report,sourceCodeHashes,sourceCodeSha256:trainingContextHash(sourceCodeHashes)}};
const results=[];
for(const [name,at,accept] of [["Earlier than mature labels",start,false],["After mature labels but before final scheduler receipt",cutoff-1,false],["Later nonoverlapping prefix",cutoff+1000,true]]){
 try{const r=await buildDistributionTraining([book(at),book(at,"ETH/USD")],costs,assets,{cutoffMs:cutoff+2000,riskContext,initialState:artifact});results.push({name,accepted:true,expectedAccepted:accept,retainedSamples:r.state.samples.length,prospectiveSelections:r.state.validationSelections.length});}
 catch(e){results.push({name,accepted:false,expectedAccepted:accept,error:String(e)});}
}
const result={fixture:"Synthetic constant-price books only; no historical performance evaluated",passed:results.every(x=>x.accepted===x.expectedAccepted),initialCompletedMs:Math.max(...initial.state.samples.map(s=>s.completedAtMs)),initialLastObservedMs:initial.report.quality.lastMs,results};
writeFileSync("/home/ec2-user/crypto_trade/reports/profit-engine-rebuild-2026-09-09/risk-training-resume-audit.json",JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result,null,2));
if(!result.passed)process.exitCode=1;
