const state={snapshot:null,snapshotReceivedAt:null,paused:false,orderFilter:"all",symbol:"all",socket:null,retry:0,polling:false,lastPollAt:-Infinity};
const monotonicNow=()=>performance.now();
const snapshotAgeMs=()=>state.snapshotReceivedAt===null?Infinity:Math.max(0,monotonicNow()-state.snapshotReceivedAt);
const dashboardNowMs=()=>Number.isFinite(state.snapshot?.generatedAtMs)?state.snapshot.generatedAtMs+(Number.isFinite(snapshotAgeMs())?snapshotAgeMs():0):0;
function acceptSnapshot(snapshot){
  if(state.paused||!Number.isFinite(snapshot?.generatedAtMs)||snapshot.generatedAtMs<0
    ||(state.snapshot&&snapshot.generatedAtMs<=state.snapshot.generatedAtMs))return false;
  state.snapshot=snapshot;state.snapshotReceivedAt=monotonicNow();return true;
}
const el=(id)=>document.getElementById(id);
const esc=(value)=>String(value??"").replace(/[&<>'"]/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]);
const num=(value,digits=2)=>value==null||!Number.isFinite(Number(value))?"—":Number(value).toLocaleString(undefined,{minimumFractionDigits:digits,maximumFractionDigits:digits});
const money=(value,digits=2)=>value==null||!Number.isFinite(Number(value))?"—":Number(value).toLocaleString(undefined,{style:"currency",currency:"USD",minimumFractionDigits:digits,maximumFractionDigits:digits});
const priceDigits=(value)=>{const absolute=Math.abs(Number(value));if(!Number.isFinite(absolute)||absolute===0)return 4;if(absolute>=1000)return 2;if(absolute>=1)return 4;return Math.min(10,Math.max(4,Math.ceil(-Math.log10(absolute))+2));};
const priceMoney=(value)=>money(value,priceDigits(value));
const orderMatchesFilter=(order,filter)=>filter==="all"||(filter==="open"?!order.terminal:filter==="terminal"&&order.terminal);
const signed=(value,suffix="")=>value==null?"—":`${value>=0?"+":""}${num(value,2)}${suffix}`;
const duration=(ms)=>{const s=Math.max(0,Math.floor(ms/1000));const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?`${h}h ${m}m`:m?`${m}m ${s%60}s`:`${s}s`};
const time=(ms)=>new Date(ms).toLocaleTimeString([],{hour12:false,hour:"2-digit",minute:"2-digit",second:"2-digit"});
const relative=(ms)=>{const d=dashboardNowMs()-ms;return d<1000?"now":`${Math.floor(d/1000)}s ago`};
const pnlClass=(value)=>value>0?"positive":value<0?"negative":"";
const signedMoney=(value,digits=4)=>value==null||!Number.isFinite(Number(value))?"—":`${Number(value)>=0?"+":"-"}${money(Math.abs(Number(value)),digits)}`;

function setConnection(kind,label){const node=el("connection-status");node.className=`connection ${kind}`;node.innerHTML=`<i></i>${esc(label)}`;}
async function bootstrap(){
  connect();void refreshDashboard();setInterval(()=>{
    el("clock").textContent=new Date().toLocaleTimeString([],{hour12:false});
    if(state.paused)setConnection("connecting","Paused");
    else if(snapshotAgeMs()>5000){setConnection("offline","Waiting for updates");void refreshDashboard();}
    if(state.snapshot){el("last-update").textContent=`Updated ${relative(state.snapshot.generatedAtMs)}`;refreshFuturesMarketPanels();}
  },1000);
}
async function refreshDashboard(){
  const now=monotonicNow();
  if(state.paused||state.polling||now-state.lastPollAt<5000)return;
  state.polling=true;state.lastPollAt=now;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);
  try{const response=await fetch("/api/dashboard",{cache:"no-store",signal:controller.signal});if(response.ok)applySnapshot(await response.json(),"http");}catch{}
  finally{clearTimeout(timeout);state.polling=false;}
}
function connect(){
  setConnection("connecting","Connecting");const protocol=location.protocol==="https:"?"wss":"ws";const socket=new WebSocket(`${protocol}://${location.host}/ws`);state.socket=socket;
  socket.addEventListener("open",()=>{state.retry=0;setConnection("connecting",state.paused?"Paused":"Waiting for updates");});
  socket.addEventListener("message",(message)=>{try{const parsed=JSON.parse(message.data);if(parsed.type==="snapshot")applySnapshot(parsed.data,"ws");}catch{}});
  socket.addEventListener("close",()=>{setConnection("offline","Reconnecting");state.retry+=1;setTimeout(connect,Math.min(10000,600*2**state.retry));});
  socket.addEventListener("error",()=>socket.close());
}
function applySnapshot(snapshot,source="ws"){
  if(!acceptSnapshot(snapshot))return false;
  setConnection("live",source==="http"?"Live polling":"Live stream");render(snapshot);return true;
}
function render(s){
  const score=s.overall==="healthy"?"100%":s.overall==="degraded"?"68%":"24%";
  const mode=String(s.mode).toUpperCase();el("mode-badge").textContent=`${mode}${s.paper&&mode!=="PAPER"?" · PAPER":""}${s.paperEntryExercise?" · EXERCISE":""}`;
  el("health-title").textContent=s.overall==="healthy"?"Futures market monitoring":s.overall==="degraded"?"Futures monitoring warming or degraded":"Futures monitoring requires attention";
  el("health-description").textContent="Read-only market feeds, account balances, and recorded order activity.";
  el("health-score").textContent=score;el("health-orbit").className=`health-orbit ${s.overall}`;el("health-pulse").style.background=s.overall==="critical"?"var(--red)":s.overall==="degraded"?"var(--amber)":"var(--cyan)";
  el("halt-reasons").innerHTML=(s.haltReasons||[]).map(reason=>`<span class="halt-chip">${esc(reason)}</span>`).join("");
  const sessionKnown=!s.rollingPnlDetails?.fundingIncluded||Number.isFinite(s.rollingPnlDetails.utcSessionNetPnlUsd);
  el("equity").textContent=money(s.equity,5);el("drawdown").textContent=`UTC open ${money(s.sessionStartingEquity,5)} · Peak ${money(s.equityHighWater,5)}`;el("session-pnl").textContent=sessionKnown?signedMoney(s.sessionPnl,5):"Unknown";el("session-pnl").className=sessionKnown?pnlClass(s.sessionPnl):"";renderSessionPnlBreakdown(s.realizedSessionBreakdown,s.rollingPnlDetails);
  const rollingKnown=s.realizedPnlMeasurement==="KNOWN"&&Number.isFinite(s.realizedPnl24h);
  el("rolling-pnl").textContent=rollingKnown?signedMoney(s.realizedPnl24h,5):"Unknown";el("rolling-pnl").className=rollingKnown?pnlClass(s.realizedPnl24h):"";
  el("rolling-pnl-detail").innerHTML=rollingPnlDetailHtml(s.rollingPnlDetails,rollingKnown);
  el("latency").textContent=s.latencyP95Ms==null?"—":`${num(s.latencyP95Ms,1)} ms`;el("uptime").textContent=duration(s.uptimeMs);el("strategy-version").textContent="Futures monitor";el("last-update").textContent=`Updated ${relative(s.generatedAtMs)}`;
  renderLiveness(s.liveness||[]);syncSymbols(s.markets||[]);renderMarkets(filtered(s.markets||[]));renderOrders(filtered(s.orders||[]));renderEvents(s.events||[]);
  el("market-subtitle").textContent="KRAKEN FUTURES · BID / ASK AND FEED STATUS";
  el("footer-detail").textContent=`DB ${s.database.status} · ${s.database.queuedRecords} queued · Futures market and account monitoring`;
}
function rollingPnlDetailHtml(details,known){
  const funded=details?.fundingIncluded===true;
  const status=known?(funded?"After fill fees and posted paper funding":"Price P&L after fill fees · funding excluded"):(details?.reason||"Recorded fill history unavailable");
  if(!funded)return esc(status);
  const amount=value=>Number.isFinite(value)?signedMoney(value,5):"Unknown";
  return `${esc(status)}<br><span>Paper funding cash · 24h ${amount(details.fundingCash24hUsd)} · UTC day ${amount(details.fundingCashUtcSessionUsd)}</span><br><span>Unsettled funding accrual ${amount(details.fundingUnsettledAccrualUsd)} · excluded from cash P&amp;L</span>`;
}
function filtered(items){return state.symbol==="all"?items:items.filter(item=>item.symbol===state.symbol);}
function sessionPnlBreakdownHtml(breakdown,rolling){
  if(!breakdown||![breakdown.realizedPnl,breakdown.unrealizedPnl,breakdown.totalPnl].every(Number.isFinite))return "";
  const entryFeeLabel=breakdown.entryStyle?`Entry ${esc(String(breakdown.entryStyle).toLowerCase().replaceAll("_"," "))} fee`:"Entry fees";
  const exitFeeLabel=breakdown.exitStyle?`Exit ${esc(String(breakdown.exitStyle).toLowerCase().replaceAll("_"," "))} fee`:"Exit fees";
  const execution=[breakdown.grossPricePnl,breakdown.entryFee,breakdown.exitFee].every(Number.isFinite)?`<div class="session-pnl-row"><span>Gross price gain</span><strong class="${pnlClass(breakdown.grossPricePnl)}">${signedMoney(breakdown.grossPricePnl,5)}</strong></div><div class="session-pnl-row"><span>${entryFeeLabel}</span><strong class="negative">${signedMoney(-Math.abs(breakdown.entryFee),5)}</strong></div><div class="session-pnl-row"><span>${exitFeeLabel}</span><strong class="negative">${signedMoney(-Math.abs(breakdown.exitFee),5)}</strong></div>`:"";
  const funded=rolling?.fundingIncluded===true,accountKnown=!funded||Number.isFinite(rolling.utcSessionNetPnlUsd);
  const funding=funded?`<div class="session-pnl-row"><span>Posted paper funding cash · UTC day</span><strong class="${pnlClass(rolling.fundingCashUtcSessionUsd)}">${Number.isFinite(rolling.fundingCashUtcSessionUsd)?signedMoney(rolling.fundingCashUtcSessionUsd,5):"Unknown"}</strong></div>`:"";
  return `${execution}${funding}<div class="session-pnl-row"><span>${funded?"Realized account P&amp;L after fill fees and posted funding":"Realized P&amp;L"}</span><strong class="${accountKnown?pnlClass(breakdown.realizedPnl):""}">${accountKnown?signedMoney(breakdown.realizedPnl,5):"Unknown"}</strong></div><div class="session-pnl-row"><span>Open mark P&amp;L</span><strong class="${pnlClass(breakdown.unrealizedPnl)}">${signedMoney(breakdown.unrealizedPnl,5)}</strong></div><div class="session-pnl-row total"><span>Total UTC-day P&amp;L${funded?" · unsettled funding excluded":""}</span><strong class="${accountKnown?pnlClass(breakdown.totalPnl):""}">${accountKnown?signedMoney(breakdown.totalPnl,5):"Unknown"}</strong></div>`;
}
function renderSessionPnlBreakdown(breakdown,rolling){const node=el("session-pnl-breakdown"),html=sessionPnlBreakdownHtml(breakdown,rolling);node.innerHTML=html;node.hidden=!html;}
function renderLiveness(items){el("liveness-grid").className="liveness-grid";el("liveness-grid").innerHTML=items.map(item=>`<article class="live-card ${item.healthy?"":"bad"}"><span class="status-icon">${item.healthy?"✓":"!"}</span><div><b>${esc(item.label)}</b><small title="${esc(item.detail)}">${esc(item.detail)}</small></div><i class="live-dot"></i></article>`).join("");}
function syncSymbols(markets){const select=el("symbol-filter"),current=select.value||state.symbol,values=[...new Set(markets.map(m=>m.symbol))];select.innerHTML=`<option value="all">All symbols</option>${values.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join("")}`;select.value=values.includes(current)||current==="all"?current:"all";state.symbol=select.value;}
function renderMarkets(items){
  const grid=el("market-grid");
  if(!items.length){grid.className="market-grid empty-grid";grid.innerHTML="<p>Waiting for order books…</p>";return;}
  grid.className="market-grid";grid.innerHTML=items.map(renderFuturesMarket).join("");
}
function renderFuturesMarket(m){
  const elapsed=snapshotAgeMs(),snapshotCurrent=Number.isFinite(elapsed)&&elapsed<5000&&!state.paused;
  const pricesKnown=Number.isFinite(m.bestBid)&&m.bestBid>0&&Number.isFinite(m.bestAsk)&&m.bestAsk>m.bestBid;
  const sourceAge=Number.isFinite(m.providerAgeMs)&&m.providerAgeMs>=0?m.providerAgeMs:null;
  const age=sourceAge!==null&&Number.isFinite(elapsed)?sourceAge+elapsed:null;
  const threshold=Number.isFinite(m.staleThresholdMs)&&m.staleThresholdMs>0?m.staleThresholdMs:null;
  const current=snapshotCurrent&&pricesKnown&&m.bookValid===true&&m.stale===false&&age!==null&&threshold!==null&&age<=threshold;
  const label=!snapshotCurrent?"SNAPSHOT STALE":m.bookValid!==true||!pricesKnown?"BOOK UNAVAILABLE":current?"FEED CURRENT":"FEED UNCONFIRMED";
  const detail=current?"Market data monitoring. This card provides no entry recommendation.":!snapshotCurrent?"Waiting for a new dashboard snapshot. Prices below are last recorded values.":"Fresh market data is unconfirmed. Prices below are recorded values.";
  const midpoint=Number.isFinite(m.mid)&&m.mid>0?m.mid:pricesKnown?(m.bestBid+m.bestAsk)/2:null;
  return `<article class="market-card futures-market-card" data-testid="futures-market-card" data-symbol="${esc(m.symbol)}"><div class="market-top"><div><div class="symbol">${esc(m.symbol)}</div><div class="venue">KRAKEN FUTURES · MARKET MONITORING</div></div><span class="book-state ${current?"":"bad"}">${label}</span></div><div class="market-price">${priceMoney(midpoint)}</div><div class="market-spread">${priceMoney(Number.isFinite(m.bestBid)&&m.bestBid>0?m.bestBid:null)} bid · ${priceMoney(Number.isFinite(m.bestAsk)&&m.bestAsk>0?m.bestAsk:null)} ask</div><div class="market-metrics"><div class="metric"><span>Recorded spread</span><strong>${Number.isFinite(m.spreadBps)&&m.spreadBps>=0?num(m.spreadBps,2):"—"} bp</strong></div><div class="metric"><span>Provider age estimate</span><strong>${age===null?"Unknown":`${num(age,0)} ms`}</strong></div><div class="metric"><span>Dashboard snapshot age</span><strong>${Number.isFinite(elapsed)?`${num(elapsed/1000,1)}s`:"Unknown"}</strong></div></div><p class="futures-market-note">${detail}</p><small class="futures-market-source">Provider age adds elapsed dashboard time to the reported age.${m.staleReason?` Recorded feed status: ${esc(m.staleReason)}.`:""}</small></article>`;
}
function refreshFuturesMarketPanels(){
  if(state.snapshot)renderMarkets(filtered(state.snapshot.markets||[]));
}
function modelTradeResults(items,symbol,mode){
  const entries=items.filter(o=>o.symbol===symbol&&!o.reduceOnlyIntent&&o.crossAssetForecast?.version==="btc-eth-dynamic-bayes-v1"&&o.crossAssetEntryMode===mode);
  const positions=new Map();
  for(const o of items){const p=o.livePosition;if(!p?.entryOrderId)continue;const old=positions.get(p.entryOrderId);
    if(!old||Number.isFinite(p.realizedPnl)||(!Number.isFinite(old.realizedPnl)&&p.active))positions.set(p.entryOrderId,p);}
  const filled=entries.filter(o=>o.filledQty>0),closed=filled.map(o=>positions.get(o.clientOrderId)).filter(p=>p&&!p.active&&Number.isFinite(p.realizedPnl));
  const open=filled.filter(o=>positions.get(o.clientOrderId)?.active).length;
  return {attempts:entries.length,filled:filled.length,closed:closed.length,open,unresolved:filled.length-closed.length-open,
    wins:closed.filter(p=>p.realizedPnl>0).length,net:closed.length?closed.reduce((s,p)=>s+p.realizedPnl,0):null,
    fees:closed.length&&closed.every(p=>Number.isFinite(p.realizedBreakdown?.entryFee)&&Number.isFinite(p.realizedBreakdown?.exitFee))?
      closed.reduce((s,p)=>s+p.realizedBreakdown.entryFee+p.realizedBreakdown.exitFee,0):null};
}
function renderCrossAssetModel(m,nowMs=dashboardNowMs()){
  const p=m.policyPulse,c=p?.research?.crossAsset;
  if(!c)return "";
  const learning=c.learning||{},f=c.forecast;
  // Display the fixed v1 training requirement only for that model version.
  const knownVersion=learning.version==="btc-eth-dynamic-bayes-v1",minimumLabels=knownVersion?24:null;
  const labels=Number.isInteger(learning.labelsPerSymbol)&&learning.labelsPerSymbol>=0?learning.labelsPerSymbol:null;
  const enabled=c.paperSubmissionEnabled===true&&state.snapshot?.crossAssetPaperEntriesEnabled===true
    &&state.snapshot?.mode==="paper"&&state.snapshot?.paper===true&&p.mode==="PAPER_RESEARCH";
  const evaluation=enabled&&c.paperEvaluationEnabled===true&&state.snapshot?.crossAssetPaperEvaluationEnabled===true;
  const modelOnly=state.snapshot?.modelOnlyEntries===true;
  const forecastAge=f&&Number.isFinite(f.atMs)?nowMs-f.atMs:null;
  const forecastValid=knownVersion&&f?.version===learning.version&&f?.symbol===m.symbol&&f.horizonMs===900000
    &&[f.predictedGrossBps,f.conservativeNetBps,f.costHurdleBps,f.parameterUncertaintyBps,f.predictiveStdBps].every(Number.isFinite);
  const current=forecastValid&&forecastAge!==null&&forecastAge>=0&&forecastAge<=1000;
  let status="WAITING FOR MODEL DATA",detail="Waiting for current model telemetry.",tone="waiting";
  if(knownVersion&&labels!==null){
    if(labels<minimumLabels){
      status=labels===0&&!f?"BUILDING PRICE HISTORY":"TRAINING";
      detail="Needs one hour of price history and 24 completed 15-minute training intervals. Gaps can extend warmup.";
    }else if(learning.priceHistoryReady===false){
      status="REBUILDING PRICE HISTORY";detail=`Training is retained. Recent price coverage is ${num((learning.historyCoverageMs||0)/60000,0)} of 60 minutes; a gap over 90 seconds requires the price window to rebuild.`;
    }else if(!f){status="WAITING FOR FORECAST";detail="Training minimum met. Forecasts update once per minute when both BTC and ETH quotes are fresh.";}
    else if(!forecastValid){status="FORECAST UNAVAILABLE";detail="The latest forecast is incomplete or belongs to a different model.";}
    else if(!current){status="FORECAST EXPIRED";detail="Forecasts update once per minute. The last forecast is for reference only; entry checks require a forecast no more than one second old.";}
    else if(f.reason==="OUT_OF_DOMAIN"){status="OUTSIDE MODEL RANGE";detail="Current market features are outside the model's supported range.";}
    else if(evaluation&&(f.reason==="COST_OR_UNCERTAINTY"||f.reason==="POSITIVE_RESEARCH_FORECAST")&&[1,-1].includes(f.side)&&f.side*f.predictedGrossBps>0){
      status="PAPER EVALUATION CANDIDATE";detail="The model direction can trigger a capped paper trade to measure outcomes. Costs, uncertainty and any failed profitability screen remain recorded; liquidity and risk checks still apply.";
    }
    else if(f.reason==="COST_OR_UNCERTAINTY"||f.conservativeNetBps<=0){status="COST / UNCERTAINTY BLOCK";detail="The predicted move does not cover the model's cost and uncertainty allowances.";}
    else if(f.eligible===true&&f.reason==="POSITIVE_RESEARCH_FORECAST"&&[1,-1].includes(f.side)&&f.side*f.predictedGrossBps>0){
      status="FORECAST PASSES SCREEN";tone="qualified";detail="A candidate forecast is present. Current price, exact order costs, liquidity and risk checks still apply.";
    }else{status="FORECAST NOT QUALIFIED";detail="The latest forecast has not qualified for an entry check.";}
  }
  const entryGate=enabled?(state.snapshot.entriesAllowed!==true?"Engine health or risk gates currently block new entries.":
    ({POSITION_OPEN:"An existing position blocks another entry.",ORDER_PENDING:"An order is pending; another entry is blocked.",
      COOLDOWN:`Shared entry cooldown: ${duration(p.cooldownRemainingMs)} remaining.`,LIQUIDITY_BLOCKED:"Current liquidity checks block an entry.",
      ENTRY_BLOCKED:`Latest entry check rejected: ${(p.reasons||[]).join(" · ")||"see entry checks below"}.`,
      DATA_GATED:"Market data checks block new entries.",WARMING:"Market features are still warming up."}[p.status]
      ||(evaluation?"Fresh model directions can enter the paper evaluation checks.":"Qualifying forecasts can enter the paper order checks."))):
    p.mode==="CALIBRATED_PAPER"?"Calibrated-only mode does not submit joint-model experiments.":
      state.snapshot?.mode!=="paper"?"The engine is outside paper mode; joint orders are disabled.":"Joint-model paper submission is disabled.";
  const count=labels===null?"—":`${num(labels,0)}${minimumLabels===null?"":` / ${minimumLabels} minimum`}`;
  const progress=minimumLabels!==null&&labels!==null?`<progress max="${minimumLabels}" value="${Math.min(minimumLabels,labels)}" aria-label="${esc(m.symbol)} completed training intervals">${count}</progress>`:"";
  const restored=c.historyBootstrap;
  const trainingSource=restored?`<small class="joint-training-source">Trained from history · ${num(restored.labelsPerSymbol,0)} completed intervals restored${Number.isFinite(restored.trainedThroughMs)?` · through ${esc(new Date(restored.trainedThroughMs).toISOString().replace("T"," ").slice(0,19))} UTC`:""}</small>`:"";
  const forecastTime=forecastAge===null?(labels!==null&&minimumLabels!==null&&labels>=minimumLabels?"No current forecast":"No forecast yet"):forecastAge<0?"Forecast timestamp is ahead of the current clock":`${time(f.atMs)} · ${duration(forecastAge)} ago${current?" · current":" · not current"}`;
  const metrics=f?`<div class="joint-metrics"><div><span>Forecast direction</span><strong>${f.side===1?"LONG":f.side===-1?"SHORT":"—"} · ${num(f.horizonMs/60000,0)}m</strong></div><div><span>Predicted price return</span><strong>${signed(f.predictedGrossBps," bp")}</strong></div><div><span>Model net score</span><strong class="${current?pnlClass(f.conservativeNetBps):""}">${signed(f.conservativeNetBps," bp")}</strong></div><div><span>Estimated cost hurdle</span><strong>${num(f.costHurdleBps,2)} bp</strong></div><div><span>Parameter uncertainty</span><strong>${num(f.parameterUncertaintyBps,2)} bp</strong></div><div><span>Return volatility</span><strong>${num(f.predictiveStdBps,2)} bp</strong></div></div>`:"";
  const reason=f?`<small class="joint-forecast-reason">Last forecast result: ${esc({TRAINING:"Training incomplete",OUT_OF_DOMAIN:"Outside model range",COST_OR_UNCERTAINTY:"Costs or uncertainty exceed predicted move",POSITIVE_RESEARCH_FORECAST:"Passed the forecast screen when generated"}[f.reason]||f.reason||"unavailable")}</small>`:"";
  const results=modelTradeResults(state.snapshot?.orders||[],m.symbol,evaluation?"PAPER_EVALUATION":"QUALIFIED");
  const resultPanel=`<div class="model-results" data-testid="model-results"><b>${evaluation?"Model paper evaluation":"Qualified model"} results · available history</b><div class="joint-metrics"><div><span>Entry attempts / filled</span><strong>${results.attempts} / ${results.filled}</strong></div><div><span>Closed / open / unresolved</span><strong>${results.closed} / ${results.open} / ${results.unresolved}</strong></div><div><span>Realized after fees</span><strong class="${pnlClass(results.net)}">${results.net===null?"Awaiting closed trades":signedMoney(results.net,5)}</strong></div><div><span>Closed trade fees / wins</span><strong>${results.fees===null?"—":money(results.fees,5)} / ${results.wins}</strong></div></div></div>`;
  return `<section class="cross-asset-panel ${tone}" data-testid="cross-asset-panel" data-symbol="${esc(m.symbol)}" aria-label="${esc(m.symbol)} joint model"><div class="joint-heading"><div><h3>BTC/ETH joint model</h3><small>${esc(learning.version||"Version unavailable")}</small></div><span class="joint-submission ${enabled?"enabled":"disabled"}">PAPER ORDERS ${enabled?"ENABLED":"DISABLED"}</span></div><p class="model-entry-mode">${modelOnly?"MODEL-ONLY ENTRIES · BREAKOUT/RETEST DISABLED":"MODEL + RULE ENTRIES"}<small>${evaluation?"Paper evaluation: collect outcomes even when the profitability screen fails.":"Model entries require the profitability screen to pass."}</small></p><p class="joint-entry-gate">${esc(entryGate)}</p><div class="joint-training"><div><span>Completed 15m training intervals</span><strong>${count}</strong></div>${progress}${trainingSource}<small>${num(learning.historySamples,0)} recent minute samples · ${num(learning.invalidLabelPairs,0)} discarded intervals</small></div><div class="joint-status"><b>${status}</b><p>${esc(detail)}</p></div>${metrics}<div class="joint-forecast-time">${esc(forecastTime)}</div>${reason}${resultPanel}<small class="joint-limit">Paper cap ${money(p.maximumNotional,0)} · shared 30m entry cooldown · profitability unproven</small></section>`;
}
function policyFamilyName(family){return {CONTINUATION:"Trend",EARLY_BREAKOUT:"Breakout",PULLBACK_RECOVERY:"Recovery",BREAKOUT_RETEST:"Breakout retest"}[family]||String(family);}
function renderPolicyMarket(m){
  const p=m.policyPulse;
  if(!p)return `<article class="market-card policy-card"><div class="symbol">${esc(m.symbol)}</div><div class="market-price">${priceMoney(m.mid)}</div><div class="policy-status"><b>WAITING FOR POLICY TELEMETRY</b><p>The policy engine is active; its per-symbol snapshot is not available yet.</p></div></article>`;
  const dataValid=m.bookValid&&!m.stale,motionReady=m.kinematicsReady!==false;
  const bookState=!dataValid?"DATA GATED":!motionReady?"MOTION RESET":"BOOK VALID";
  const mode={PAPER_RESEARCH:p.research?.crossAsset?(state.snapshot?.modelOnlyEntries?"MODEL-ONLY PAPER ENTRIES":"PAPER RESEARCH · JOINT MODEL + POLICIES"):"PAPER RESEARCH · UNSCORED",CALIBRATED_PAPER:"CALIBRATED PAPER ONLY",SHADOW:"SHADOW · NO ORDERS",RECORD:"RECORD · NO ORDERS"}[p.mode]||p.mode;
  const status={DATA_GATED:"DATA GATED",WARMING:"POLICY WARMUP",RISK_BLOCKED:"RISK GATED",POSITION_OPEN:"POSITION OPEN",ORDER_PENDING:"ORDER PENDING",COOLDOWN:"ENTRY COOLDOWN",WAITING_FOR_SIGNAL:"NO QUALIFYING SIGNAL",AWAITING_VALIDATION:"AWAITING VALIDATION",WAITING_FOR_QUOTE:"SIGNAL PRESENT · FRESH-QUOTE CHECKS",LIQUIDITY_BLOCKED:"LIQUIDITY GATED",ENTRY_BLOCKED:"ENTRY CHECK REJECTED"}[p.status]||p.status;
  const details={DATA_GATED:"Fresh executable quotes are required.",WARMING:"Waiting for causal trend and motion features.",RISK_BLOCKED:"Health or risk gates currently block new orders.",POSITION_OPEN:`Managing ${p.activePolicyId||"existing"} position; no additional entry.`,ORDER_PENDING:"An order is in flight; no additional entry.",COOLDOWN:`Next entry check in ${duration(p.cooldownRemainingMs)}.`,WAITING_FOR_SIGNAL:p.research?.crossAsset?(state.snapshot?.modelOnlyEntries?"Waiting for a fresh model entry candidate. Breakout/retest entries are disabled.":"No qualifying entry. Joint-model training and policy signal checks continue."):"No trend, breakout, or recovery predicate currently matches.",AWAITING_VALIDATION:"No current signal has a matching validated model; unscored orders are disabled.",WAITING_FOR_QUOTE:"Entries are checked on fresh quotes, independently of the research timer; sizing and risk checks still apply.",LIQUIDITY_BLOCKED:"A signal matches, but its liquidity checks currently fail.",ENTRY_BLOCKED:"The latest quote failed an entry check; the rejection is shown below."}[p.status]||"";
  const setup=p.setup?`<div class="policy-family"><div><b>${esc({WATCHING:"Watching the prior range",BREAKOUT:"Breakout detected · waiting for retest",RETESTED:"Retest confirmed · waiting for renewed flow",CANDIDATE:"Reacceleration candidate"}[p.setup.phase]||p.setup.phase)}</b><small>${p.setup.boundary==null?`${p.setup.samples} range samples`:`Frozen level ${priceMoney(p.setup.boundary)}`}</small></div></div>`:"";
  const rows=setup+(p.families||[]).map(f=>`<div class="policy-family"><div><b>${esc(policyFamilyName(f.family))}</b><small>${(f.horizonsMs||[]).map(h=>`${num(h/60000,0)}m`).join(" / ")}</small></div><span class="policy-signal ${f.longSignal?"matched":""}">LONG ${f.longSignal?"MATCH":"—"}</span><span class="policy-signal ${f.shortSignal?"matched":""}">SHORT ${f.shortSignal?"MATCH":"—"}</span></div>`).join("");
  const models=p.promotedModels||[];
  const evidence=models.length?models.map(model=>`${model.policyId} ${model.side>0?"LONG":"SHORT"} · LCB ${num(model.lowerNetBps,2)} bp`).join("; "):"No validated models · profitability unproven";
  const sampled=p.lastSample?(p.lastSample.candidates||[]).map(c=>`${c.policyId} ${c.side>0?"LONG":"SHORT"}`).join(", ")||"no candidates":"not sampled yet";
  const nowMs=dashboardNowMs();
  const sampleTime=p.lastSample?`${time(p.lastSample.atMs)} · ${duration(Math.max(0,nowMs-p.lastSample.atMs))} ago`:"waiting for first fresh-quote sample";
  const nextSample=p.nextSampleAtMs==null?"on a fresh quote":p.nextSampleAtMs>nowMs?`in ${duration(p.nextSampleAtMs-nowMs)}`:"waiting for a fresh quote";
  const counters=p.entryCounters||{};
  const lastCheck=`<p><span>Entry checks · every fresh quote</span>${num(counters.quoteChecks||0,0)} quotes · ${num(counters.signalMatches||0,0)} signal matches · ${num(counters.plansApproved||0,0)} approved plans</p><p><span>Research sampling only</span>The periodic sample timer does not delay entry checks.</p><p><span>Liquidity checks</span>${esc((p.liquidityReasons||[]).join(" · ")||"No current liquidity rejection")}</p>${p.lastEvaluation?`<p><span>Last plan check · ${time(p.lastEvaluation.atMs)}</span>${esc(p.lastEvaluation.policyId)} ${p.lastEvaluation.side>0?"LONG":"SHORT"} · ${esc(p.lastEvaluation.reason)}</p>`:""}`;
  const lastBlock=p.lastRejection?`<p><span>Last rejection · ${time(p.lastRejection.atMs)} (history)</span>${esc(p.lastRejection.stage)} · ${esc(p.lastRejection.reason)}</p>`:"";
  const pullback=(side)=>m[`${side}PullbackReady`]?`${num(m[`${side}PullbackDepthBps`],0)} / ${num(m[`${side}PullbackRecoveryBps`],0)} / ${num(m[`${side}PullbackRemainingRoomBps`],0)} bp`:"not ready";
  return `<article class="market-card policy-card" data-testid="policy-market-card"><div class="market-top"><div><div class="symbol">${esc(m.symbol)}</div><div class="venue">KRAKEN FUTURES · ${esc(m.regime||"WARMING")}</div></div><span class="book-state ${!dataValid?"bad":!motionReady?"warn":""}">${bookState}</span></div><div class="market-price">${priceMoney(m.mid)}</div><div class="market-spread">${priceMoney(m.bestBid)} bid · ${priceMoney(m.bestAsk)} ask</div><div class="policy-version">${esc(p.version)}<span>${esc(mode)}</span></div>${renderCrossAssetModel(m)}<div class="policy-families" aria-label="Live directional policy signals">${rows}</div><div class="market-metrics"><div class="metric"><span>Spread / provider age</span><strong>${num(m.spreadBps,2)} bp / ${num(m.providerAgeMs,0)} ms</strong></div><div class="metric"><span>Slow trend 5/15/60m</span><strong>${m.slowTrendReady?`${num(m.trendFastBps,1)} / ${num(m.trendMediumBps,1)} / ${num(m.trendSlowBps,1)} bp`:"warming"}</strong></div><div class="metric"><span>Long pullback depth/recovery/room</span><strong>${pullback("long")}</strong></div><div class="metric"><span>Short pullback depth/recovery/room</span><strong>${pullback("short")}</strong></div></div><div class="policy-evidence"><b>${models.length} validated model${models.length===1?"":"s"}</b><small>${esc(evidence)}</small><small>${p.mode==="PAPER_RESEARCH"?(state.snapshot?.modelOnlyEntries?"Model-only paper entries enabled":"Paper policy experiments enabled"):p.mode==="CALIBRATED_PAPER"?"Validated evidence required":"Order submission disabled"} · cap ${money(p.maximumNotional,0)}</small></div><div class="policy-status"><b>${esc(status)}</b><p>${esc(details)}${p.reasons?.length?` ${esc(p.reasons.join(" · "))}`:""}</p></div><div class="policy-sampling"><p><span>Last sample · ${esc(sampleTime)}</span>${esc(sampled)}</p><p><span>Next sample · ${num(p.sampleIntervalMs/1000,0)}s cadence</span>${esc(nextSample)}</p>${lastCheck}${lastBlock}</div></article>`;
}
function renderEvents(items){el("events-body").innerHTML=items.slice(0,25).map(e=>`<tr><td class="event-time" data-label="Time">${time(e.atMs)}</td><td data-label="Severity"><span class="severity ${esc(e.severity)}">${esc(e.severity)}</span></td><td class="event-type" data-label="Event">${esc(e.type)}</td><td data-label="Context" title="${esc(e.summary)}">${esc(e.summary)}</td></tr>`).join("")||"<tr><td colspan='4' class='empty-row'>Waiting for events…</td></tr>";}

function completePnlHistory(position,checkpointMs=60000){
  const source=(position?.pnlHistory||[]).filter(point=>Number.isFinite(point.atMs)&&Number.isFinite(point.currentPx)&&Number.isFinite(point.unrealizedPnl)).map(point=>({...point})).sort((a,b)=>a.atMs-b.atMs);
  if(!source.length||!(checkpointMs>0))return source;
  const openedMs=Number.isFinite(position.openedMs)?position.openedMs:source[0].atMs;
  const endMs=position.closedAtMs!=null&&Number.isFinite(position.closedAtMs)?position.closedAtMs:openedMs+Math.max(0,Number(position.ageMs)||0);
  const byTime=new Map(source.map(point=>[point.atMs,point]));
  let sourceIndex=0,last=source[0];
  for(let atMs=openedMs+checkpointMs;atMs<endMs;atMs+=checkpointMs){
    while(sourceIndex+1<source.length&&source[sourceIndex+1].atMs<=atMs){sourceIndex+=1;last=source[sourceIndex];}
    if(last.atMs>atMs||byTime.has(atMs))continue;
    byTime.set(atMs,{...last,atMs,kind:"checkpoint",changePnl:0});
  }
  const completed=[...byTime.values()].sort((a,b)=>a.atMs-b.atMs);
  return completed.map((point,index)=>({...point,changePnl:index?point.unrealizedPnl-completed[index-1].unrealizedPnl:null}));
}
function renderLivePnl(position){
  if(!position)return "";
  const totalPnl=!position.active&&Number.isFinite(position.realizedPnl)?position.realizedPnl:position.unrealizedPnl;
  const totalPnlBps=!position.active&&Number.isFinite(position.realizedPnlBps)?position.realizedPnlBps:position.unrealizedPnlBps;
  const historyPoints=completePnlHistory(position);
  const displayedHistory=historyPoints.slice().reverse();
  const history=displayedHistory.map(point=>`<div class="pnl-change-row ${point.kind==="checkpoint"?"checkpoint":""}"><time title="${point.kind==="checkpoint"?"One-minute carry-forward checkpoint":"Observed P&amp;L change"}">${time(point.atMs)}${point.kind==="checkpoint"?" · 1m":""}</time><span>${priceMoney(point.currentPx)}${point.kind==="close"?" exit":""}</span><strong class="${pnlClass(point.unrealizedPnl)}">${signedMoney(point.unrealizedPnl)}</strong><em class="${pnlClass(point.changePnl)}">${point.changePnl==null?"initial":signedMoney(point.changePnl)}</em></div>`).join("");
  const historyEndMs=position.closedAtMs!=null?position.closedAtMs:position.openedMs+Math.max(0,position.ageMs||0);
  const historyCoverage=duration(Math.max(0,historyEndMs-position.openedMs));
  const stateLabel=position.active?"OPEN":"CLOSED";
  const title=position.active?"Estimated net position P&amp;L · funding excluded":"Realized trade P&amp;L · funding excluded";
  const ageLabel=position.active?"Open":"Held";
  const context=position.latestReason||(position.active?"Position is open and monitored by the exit engine":"Position closed; retained P&amp;L samples are read-only history");
  const priceLabel=position.active?"Last mark":"Exit fill";
  const displayPx=position.closePx||position.currentPx;
  const breakdown=renderRealizedPnlBreakdown(position);
  return `<section class="order-live-pnl ${position.active?"active":"closed"}" data-testid="order-live-pnl" aria-live="polite"><div class="live-pnl-head"><div><span>${title}</span><strong class="${pnlClass(totalPnl)}">${signedMoney(totalPnl,position.active?4:5)}</strong></div><div><span class="pnl-position-state">${stateLabel}</span><strong class="${pnlClass(totalPnlBps)}">${signed(totalPnlBps," bp")}</strong></div></div><div class="live-pnl-meta"><span>Entry ${priceMoney(position.entryPx)}</span><span>${priceLabel} ${priceMoney(displayPx)}</span><span>${ageLabel} ${duration(position.ageMs)}</span></div>${breakdown}<div class="pnl-history"><div class="pnl-history-title" title="One-minute carry-forward checkpoints plus every observed P&amp;L change"><span>P&amp;L history · ${historyCoverage} covered</span><span>mark / net / change</span></div>${history||"<div class='pnl-history-empty'>Waiting for the first P&amp;L sample…</div>"}</div><div class="live-pnl-action"><b>${esc(position.latestAction)}</b><span title="${esc(context)}">${esc(context)}</span></div></section>`;
}
function renderRealizedPnlBreakdown(position){
  const breakdown=position&&!position.active?position.realizedBreakdown:null;
  if(!breakdown||![breakdown.grossPricePnl,breakdown.entryFee,breakdown.exitFee,breakdown.realizedPnl].every(Number.isFinite))return "";
  const entryStyle=String(breakdown.entryStyle||"order").toLowerCase().replaceAll("_"," ");
  const exitStyle=String(breakdown.exitStyle||"order").toLowerCase().replaceAll("_"," ");
  return `<div class="realized-pnl-breakdown" data-testid="realized-pnl-breakdown"><div class="realized-pnl-row"><span>Gross price gain</span><strong class="${pnlClass(breakdown.grossPricePnl)}">${signedMoney(breakdown.grossPricePnl,5)}</strong></div><div class="realized-pnl-row"><span>Entry ${esc(entryStyle)} fee</span><strong class="negative">${signedMoney(-Math.abs(breakdown.entryFee),5)}</strong></div><div class="realized-pnl-row"><span>Exit ${esc(exitStyle)} fee</span><strong class="negative">${signedMoney(-Math.abs(breakdown.exitFee),5)}</strong></div><div class="realized-pnl-row total"><span>Price P&amp;L after fill fees</span><strong class="${pnlClass(breakdown.realizedPnl)}">${signedMoney(breakdown.realizedPnl,5)}</strong></div></div>`;
}
function groupOrderCards(items){
  const byId=new Map(items.map(order=>[order.clientOrderId,order]));
  const tradesByEntryId=new Map();
  for(const order of items){
    const position=order.livePosition;
    if(!position?.entryOrderId)continue;
    const entry=byId.get(position.entryOrderId);
    if(!entry)continue;
    const exit=position.exitOrderId?byId.get(position.exitOrderId)||null:null;
    let trade=tradesByEntryId.get(position.entryOrderId);
    if(!trade){trade={kind:"trade",entry,exit,entries:[],exits:[],position,orderIds:new Set()};tradesByEntryId.set(position.entryOrderId,trade);}
    trade.orderIds.add(order.clientOrderId);
    trade.orderIds.add(entry.clientOrderId);
    if(exit)trade.orderIds.add(exit.clientOrderId);
    if(!position.active||trade.position.active)trade.position=exit?.livePosition||order.livePosition||entry.livePosition||position;
  }
  const tradeByOrderId=new Map();
  for(const trade of tradesByEntryId.values()){
    const legs=items.filter(order=>trade.orderIds.has(order.clientOrderId)||order.livePosition?.entryOrderId===trade.entry.clientOrderId)
      .sort((a,b)=>a.createdMs-b.createdMs||a.updatedMs-b.updatedMs||a.clientOrderId.localeCompare(b.clientOrderId));
    trade.entries=legs.filter(order=>!order.reduceOnlyIntent);
    trade.exits=legs.filter(order=>order.reduceOnlyIntent);
    if(!trade.entries.some(order=>order.clientOrderId===trade.entry.clientOrderId))trade.entries.unshift(trade.entry);
    trade.exit=trade.exits.find(order=>order.clientOrderId===trade.position.exitOrderId)||trade.exit||trade.exits.at(-1)||null;
    for(const leg of [...trade.entries,...trade.exits])tradeByOrderId.set(leg.clientOrderId,trade);
  }
  const seenTrades=new Set();
  const grouped=[];
  for(const order of items){
    const trade=tradeByOrderId.get(order.clientOrderId);
    if(!trade){grouped.push({kind:"order",order});continue;}
    if(seenTrades.has(trade.entry.clientOrderId))continue;
    seenTrades.add(trade.entry.clientOrderId);
    grouped.push(trade);
  }
  return grouped;
}
function dashboardCardMatchesFilter(card,filter){
  if(card.kind==="order")return orderMatchesFilter(card.order,filter);
  const terminal=!card.position.active;
  return filter==="all"||(filter==="open"?!terminal:filter==="terminal"&&terminal);
}
function renderOrderTimeline(o,label="Lifecycle"){
  const timeline=(o.timeline||[]).slice(-5).map(t=>`<div class="timeline-item ${esc(t.severity)}" title="${esc(t.label)}">${esc(t.status.replaceAll("_"," "))}<br>${time(t.atMs)}</div>`).join("");
  return `<div class="timeline"><div class="timeline-title">${esc(label)}</div><div class="timeline-items">${timeline||"<div class='timeline-item'>Created</div>"}</div></div>`;
}
function renderEntryForecast(o){
  const f=o.crossAssetForecast;if(o.reduceOnlyIntent||!f)return "";
  return `<section class="entry-forecast" data-testid="entry-forecast"><b>${o.crossAssetEntryMode==="PAPER_EVALUATION"?"MODEL PAPER EVALUATION":"QUALIFIED MODEL ENTRY"}</b><small>${esc(f.version)} · ${time(f.atMs)} · ${f.side===1?"LONG":"SHORT"} ${num(f.horizonMs/60000,0)}m</small><div class="joint-metrics"><div><span>Forecast at entry</span><strong>${signed(f.predictedGrossBps," bp")}</strong></div><div><span>Model net score at entry</span><strong>${signed(f.conservativeNetBps," bp")}</strong></div></div><small>Profitability screen: ${f.eligible?"passed":"failed"} · ${esc(f.reason)}. Actual fills and fees determine the result below.</small></section>`;
}
function renderOrderLeg(o,label){
  const side=o.side>0?"BUY":"SELL",cost=o.expectedCost||{},ttl=o.expiresInMs>0?`${duration(o.expiresInMs)} left`:o.terminal?"complete":"expired";
  const statusText=o.statusLabel||o.status.replaceAll("_"," "),cancelTitle=o.cancelRequestReason?`Requested: ${o.cancelRequestReason.replaceAll("_"," ")}`:"";
  return `<section class="trade-leg" data-testid="${label.toLowerCase()}-leg"><div class="trade-leg-head"><div><span class="trade-leg-label">${esc(label)} · ${side} · ${esc(o.style.toUpperCase())} · ${esc(o.timeInForce.toUpperCase())}</span><div class="order-id" title="${esc(o.clientOrderId)}">${esc(o.clientOrderId)}</div></div><span class="order-status ${esc(o.status)}" title="${esc(cancelTitle)}">${esc(statusText)}</span></div><div class="fill-row"><span>FILLED <strong>${num(o.filledQty,6)} / ${num(o.requestedQty,6)}</strong></span><span>${num(o.fillPercent,1)}%</span></div><div class="fill-bar"><i style="width:${Math.max(0,Math.min(100,o.fillPercent))}%"></i></div><div class="order-main"><div class="metric"><span>Limit</span><strong>${priceMoney(o.limitPx)}</strong></div><div class="metric"><span>Avg fill</span><strong>${o.averageFillPx?priceMoney(o.averageFillPx):"—"}</strong></div><div class="metric"><span>Expected value</span><strong class="${pnlClass(o.expectedValue)}">${money(o.expectedValue)}</strong></div><div class="metric"><span>TTL / age</span><strong>${ttl} · ${duration(o.ageMs)}</strong></div></div><div class="cost-grid"><div><span>Round trip</span><strong>${num(cost.roundTripBps,2)} bp</strong></div><div><span>Impact</span><strong>${num(cost.impactBps,2)} bp</strong></div><div><span>Fill probability</span><strong>${num(o.fillProbability*100,1)}%</strong></div></div>${renderEntryForecast(o)}${renderOrderTimeline(o,`${label} lifecycle`)}</section>`;
}
function renderTradeCard(card){
  const {entry,position}=card,direction=entry.side>0?"LONG":"SHORT",stateLabel=position.active?"OPEN":"CLOSED";
  const entries=card.entries.length>1?card.entries.map((order,index)=>renderOrderLeg(order,`Entry ${index+1}`)).join(""):renderOrderLeg(card.entries[0]||entry,"Entry");
  const exits=card.exits.length?card.exits.map((order,index)=>renderOrderLeg(order,card.exits.length>1?`Exit ${index+1}`:"Exit")).join(""):`<section class="trade-leg pending-leg" data-testid="exit-leg"><div class="trade-leg-head"><span class="trade-leg-label">Exit · pending</span><span class="order-status OPEN">MONITORING</span></div><p>The exit engine is monitoring this open position.</p></section>`;
  return `<article class="order-card trade-card has-live-position" data-testid="trade-card"><div class="order-head"><div><span class="symbol">${esc(entry.symbol)}</span><span class="side-label ${entry.side<0?"sell":""}">TRADE · ${direction}</span></div><span class="order-status ${position.active?"OPEN":"FILLED"}">${stateLabel}</span></div>${renderLivePnl(position)}<div class="trade-legs">${entries}${exits}</div></article>`;
}
function renderOrderAttempt(o){
  const side=o.side>0?"BUY":"SELL",cost=o.expectedCost||{},ttl=o.expiresInMs>0?`${duration(o.expiresInMs)} left`:o.terminal?"complete":"expired";
  const statusText=o.statusLabel||o.status.replaceAll("_"," "),cancelTitle=o.cancelRequestReason?`Requested: ${o.cancelRequestReason.replaceAll("_"," ")}`:"";
  return `<article class="order-card order-attempt-card ${o.livePosition?"has-live-position":""}" data-testid="order-attempt-card"><div class="order-head"><div><span class="symbol">${esc(o.symbol)}</span><span class="side-label ${o.side<0?"sell":""}">ORDER ATTEMPT · ${side} · ${esc(o.style.toUpperCase())} · ${esc(o.timeInForce.toUpperCase())}${o.historical?" · HISTORY":""}</span><div class="order-id" title="${esc(o.clientOrderId)}">${esc(o.clientOrderId.slice(0,32))}</div></div><span class="order-status ${esc(o.status)}" title="${esc(cancelTitle)}">${esc(statusText)}</span></div><div class="fill-row"><span>FILLED <strong>${num(o.filledQty,6)} / ${num(o.requestedQty,6)}</strong></span><span>${num(o.fillPercent,1)}%</span></div><div class="fill-bar"><i style="width:${Math.max(0,Math.min(100,o.fillPercent))}%"></i></div>${renderLivePnl(o.livePosition)}<div class="order-main"><div class="metric"><span>Limit</span><strong>${priceMoney(o.limitPx)}</strong></div><div class="metric"><span>Avg fill</span><strong>${o.averageFillPx?priceMoney(o.averageFillPx):"—"}</strong></div><div class="metric"><span>Expected value</span><strong class="${pnlClass(o.expectedValue)}">${money(o.expectedValue)}</strong></div><div class="metric"><span>TTL / age</span><strong>${ttl} · ${duration(o.ageMs)}</strong></div></div><div class="cost-grid"><div><span>Round trip</span><strong>${num(cost.roundTripBps,2)} bp</strong></div><div><span>Impact</span><strong>${num(cost.impactBps,2)} bp</strong></div><div><span>Fill probability</span><strong>${num(o.fillProbability*100,1)}%</strong></div></div>${renderEntryForecast(o)}${renderOrderTimeline(o)}</article>`;
}
function renderOrders(items){
  const cards=groupOrderCards(items).filter(card=>dashboardCardMatchesFilter(card,state.orderFilter));
  const grid=el("orders-grid");
  if(!cards.length){grid.className="orders-grid empty-grid";grid.innerHTML="<p>No trades or order attempts match this view.</p>";return;}
  grid.className="orders-grid";
  grid.innerHTML=cards.map(card=>card.kind==="trade"?renderTradeCard(card):renderOrderAttempt(card.order)).join("");
}

el("symbol-filter").addEventListener("change",event=>{state.symbol=event.target.value;if(state.snapshot)render(state.snapshot);});
document.querySelectorAll("[data-order-filter]").forEach(button=>button.addEventListener("click",()=>{document.querySelectorAll("[data-order-filter]").forEach(b=>b.classList.remove("active"));button.classList.add("active");state.orderFilter=button.dataset.orderFilter;if(state.snapshot)renderOrders(filtered(state.snapshot.orders||[]));}));
el("pause-button").addEventListener("click",()=>{state.paused=!state.paused;el("pause-button").innerHTML=state.paused?"<span>▶</span> Resume stream":"<span>Ⅱ</span> Pause stream";setConnection("connecting",state.paused?"Paused":"Waiting for updates");if(!state.paused)void refreshDashboard();});
const requestedDashboardView=new URLSearchParams(location.search).get("view");
const dashboardView=["spot","eth40","futures"].includes(requestedDashboardView)?requestedDashboardView:"spot";
document.documentElement.dataset.dashboardView=dashboardView;
for(const [view,panel] of [["spot","spot-system"],["eth40","eth40-system"],["futures","futures-monitoring"]]){
  el(panel).hidden=dashboardView!==view;
  if(dashboardView===view)el(`${view}-view-link`).setAttribute("aria-current","page");
  else el(`${view}-view-link`).removeAttribute("aria-current");
}
if(dashboardView==="eth40"){
  document.title="Northstar · ETH40 Paper Observation";
  el("mode-badge").textContent="ETH40 · PAPER";
  setConnection("connecting","ETH40 connecting");
  el("footer-detail").textContent="ETH40 forward paper observation · Separate funded accounts";
}
if(dashboardView==="futures"){
  document.title="Northstar · Futures Monitoring";
  el("mode-badge").textContent="FUTURES · CONNECTING";
  el("footer-detail").textContent="BTC / ETH futures · Separate paper account";
  bootstrap();
}
