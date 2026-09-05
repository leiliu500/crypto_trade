const state={snapshot:null,paused:false,orderFilter:"all",symbol:"all",socket:null,retry:0};
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
const relative=(ms)=>{const d=Date.now()-ms;return d<1000?"now":`${Math.floor(d/1000)}s ago`};
const pnlClass=(value)=>value>0?"positive":value<0?"negative":"";
const signedMoney=(value,digits=4)=>value==null||!Number.isFinite(Number(value))?"—":`${Number(value)>=0?"+":"-"}${money(Math.abs(Number(value)),digits)}`;

function setConnection(kind,label){const node=el("connection-status");node.className=`connection ${kind}`;node.innerHTML=`<i></i>${esc(label)}`;}
async function bootstrap(){
  try{const response=await fetch("/api/dashboard",{cache:"no-store"});if(response.ok)applySnapshot(await response.json());}catch{}
  connect();setInterval(()=>{el("clock").textContent=new Date().toLocaleTimeString([],{hour12:false});if(state.snapshot)el("last-update").textContent=`Updated ${relative(state.snapshot.generatedAtMs)}`;},1000);
}
function connect(){
  setConnection("connecting","Connecting");const protocol=location.protocol==="https:"?"wss":"ws";const socket=new WebSocket(`${protocol}://${location.host}/ws`);state.socket=socket;
  socket.addEventListener("open",()=>{state.retry=0;setConnection("live","Live stream");});
  socket.addEventListener("message",(message)=>{try{const parsed=JSON.parse(message.data);if(parsed.type==="snapshot"&&!state.paused)applySnapshot(parsed.data);}catch{}});
  socket.addEventListener("close",()=>{setConnection("offline","Reconnecting");state.retry+=1;setTimeout(connect,Math.min(10000,600*2**state.retry));});
  socket.addEventListener("error",()=>socket.close());
}
function applySnapshot(snapshot){state.snapshot=snapshot;render(snapshot);}
function render(s){
  const score=s.overall==="healthy"?"100%":s.overall==="degraded"?"68%":"24%";
  const mode=String(s.mode).toUpperCase();el("mode-badge").textContent=`${mode}${s.paper&&mode!=="PAPER"?" · PAPER":""}${s.paperEntryExercise?" · EXERCISE":""}`;
  el("health-title").textContent=s.overall==="healthy"?"All systems operational":s.overall==="degraded"?"System warming or degraded":"Trading gates are closed";
  el("health-description").textContent=s.entriesAllowed?"All causal data, account, order-book, and risk invariants currently permit new entries.":"The engine remains fail-closed until every execution invariant is healthy.";
  el("health-score").textContent=score;el("health-orbit").className=`health-orbit ${s.overall}`;el("health-pulse").style.background=s.overall==="critical"?"var(--red)":s.overall==="degraded"?"var(--amber)":"var(--cyan)";
  el("halt-reasons").innerHTML=(s.haltReasons||[]).map(reason=>`<span class="halt-chip">${esc(reason)}</span>`).join("");
  el("equity").textContent=money(s.equity,5);el("drawdown").textContent=`UTC open ${money(s.sessionStartingEquity,5)} · Peak ${money(s.equityHighWater,5)}`;el("session-pnl").textContent=signedMoney(s.sessionPnl,5);el("session-pnl").className=pnlClass(s.sessionPnl);renderSessionPnlBreakdown(s.realizedSessionBreakdown);
  el("latency").textContent=s.latencyP95Ms==null?"—":`${num(s.latencyP95Ms,1)} ms`;el("uptime").textContent=duration(s.uptimeMs);el("strategy-version").textContent=`Strategy ${s.strategyVersion}`;el("last-update").textContent=`Updated ${relative(s.generatedAtMs)}`;
  renderLiveness(s.liveness||[]);syncSymbols(s.markets||[]);renderMarkets(filtered(s.markets||[]));renderOrders(filtered(s.orders||[]));renderEvents(s.events||[]);
  el("market-subtitle").textContent=s.policyEngineEnabled&&!s.paperEntryExercise?"EXECUTABLE POLICIES · LIVE SIGNALS & PAPER RESEARCH":"KRAKEN FUTURES MARKET DATA · LEGACY RULES";
  el("footer-detail").textContent=`DB ${s.database.status} · ${s.database.queuedRecords} queued · ${s.policyEngineEnabled&&!s.paperEntryExercise?"EXECUTABLE POLICIES":s.signalMode||"DETERMINISTIC_ONLY"} · config ${s.configurationVersion||"-"}${s.modelVersion&&s.modelVersion!=="none"?` · model ${s.modelVersion}`:""}`;
}
function filtered(items){return state.symbol==="all"?items:items.filter(item=>item.symbol===state.symbol);}
function sessionPnlBreakdownHtml(breakdown){
  if(!breakdown||![breakdown.realizedPnl,breakdown.unrealizedPnl,breakdown.totalPnl].every(Number.isFinite))return "";
  const entryFeeLabel=breakdown.entryStyle?`Entry ${esc(String(breakdown.entryStyle).toLowerCase().replaceAll("_"," "))} fee`:"Entry fees";
  const exitFeeLabel=breakdown.exitStyle?`Exit ${esc(String(breakdown.exitStyle).toLowerCase().replaceAll("_"," "))} fee`:"Exit fees";
  const execution=[breakdown.grossPricePnl,breakdown.entryFee,breakdown.exitFee].every(Number.isFinite)?`<div class="session-pnl-row"><span>Gross price gain</span><strong class="${pnlClass(breakdown.grossPricePnl)}">${signedMoney(breakdown.grossPricePnl,5)}</strong></div><div class="session-pnl-row"><span>${entryFeeLabel}</span><strong class="negative">${signedMoney(-Math.abs(breakdown.entryFee),5)}</strong></div><div class="session-pnl-row"><span>${exitFeeLabel}</span><strong class="negative">${signedMoney(-Math.abs(breakdown.exitFee),5)}</strong></div>`:"";
  return `${execution}<div class="session-pnl-row"><span>Realized P&amp;L</span><strong class="${pnlClass(breakdown.realizedPnl)}">${signedMoney(breakdown.realizedPnl,5)}</strong></div><div class="session-pnl-row"><span>Open mark P&amp;L</span><strong class="${pnlClass(breakdown.unrealizedPnl)}">${signedMoney(breakdown.unrealizedPnl,5)}</strong></div><div class="session-pnl-row total"><span>Total UTC-day P&amp;L</span><strong class="${pnlClass(breakdown.totalPnl)}">${signedMoney(breakdown.totalPnl,5)}</strong></div>`;
}
function renderSessionPnlBreakdown(breakdown){const node=el("session-pnl-breakdown"),html=sessionPnlBreakdownHtml(breakdown);node.innerHTML=html;node.hidden=!html;}
function renderLiveness(items){el("liveness-grid").className="liveness-grid";el("liveness-grid").innerHTML=items.map(item=>`<article class="live-card ${item.healthy?"":"bad"}"><span class="status-icon">${item.healthy?"✓":"!"}</span><div><b>${esc(item.label)}</b><small title="${esc(item.detail)}">${esc(item.detail)}</small></div><i class="live-dot"></i></article>`).join("");}
function syncSymbols(markets){const select=el("symbol-filter"),current=select.value||state.symbol,values=[...new Set(markets.map(m=>m.symbol))];select.innerHTML=`<option value="all">All symbols</option>${values.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join("")}`;select.value=values.includes(current)||current==="all"?current:"all";state.symbol=select.value;}
function renderMarkets(items){const grid=el("market-grid");if(!items.length){grid.className="market-grid empty-grid";grid.innerHTML="<p>Waiting for order books…</p>";return;}grid.className="market-grid";grid.innerHTML=items.map(m=>{
  if(m.policyPulse||(state.snapshot?.policyEngineEnabled&&!state.snapshot?.paperEntryExercise))return renderPolicyMarket(m);
  const seed=[m.qi1,m.ofi,m.tfi,m.efficiency,m.velocityZ,m.sigmaHBps,1-m.providerAgeMs/(m.staleThresholdMs||1000),m.spreadBps].map((v,i)=>Math.max(3,Math.min(33,6+Math.abs(Number(v)||0)*(i<3?10:4))));
  const focus=Number(m.longScore)>=Number(m.shortScore)?m.longRule:m.shortRule;
  const gateText=(m.blockReasons||[]).slice(0,3).join(", ")||"All deterministic gates ready";
  const ruleDetail=focus?`${esc(focus.family||"CONTINUATION")} · LCB ${num(focus.lowerBoundNetBps,2)} bp · gross ${num(focus.grossOpportunityBps,2)} · robust cost ${num(focus.robustCostBps,2)} · continuation ${num(100*focus.continuationQuality,0)}% · structure ${focus.slowTrendPass?"pass":"blocked"} · ${focus.executionPath||"no path"} @ ${num(focus.edgeHorizonMs/60000,0)}m · votes ${focus.bookVotes}/${focus.flowVotes}/${focus.kinematicVotes}`:"";
  const rejection=m.entryPipeline&&m.entryPipeline.lastRejection?`${m.entryPipeline.lastRejection.stage}: ${m.entryPipeline.lastRejection.reason}`:"";
  const counts=m.entryPipeline&&m.entryPipeline.counts?m.entryPipeline.counts:{};
  const pipeline=`micro ${counts.MICRO_EVENT||0} · armed ${counts.MICRO_ARMED||0} · candidates ${counts.MICRO_CANDIDATE||0} · cost-qualified ${counts.COST_QUALITY_PASS||0} · sends ${counts.ORDER_SEND_ATTEMPT||0}`;
  const liquidity=`spread limit ${num(m.liquidityTradeThresholdBps,2)} bp · stress ${num(m.liquidityStressThresholdBps,2)} bp`;
  const dataValid=m.bookValid&&!m.stale;
  const motionReady=m.kinematicsReady!==false;
  const bookState=dataValid?(motionReady?"BOOK VALID":"MOTION RESET"):"DATA GATED";
  const bookStateClass=!dataValid?"bad":!motionReady?"warn":"";
  const freshness=!dataValid?(m.staleReason?`freshness ${m.staleReason}`:"market data unavailable"):!motionReady?"motion evidence unavailable until the next valid update":"";
  const blocks=[pipeline,gateText,ruleDetail,liquidity,freshness,rejection].filter(Boolean).join(" · ");
  const stateLabel=!m.slowTrendReady?"TREND WARMUP":m.entryReady?"ENTRY READY":m.candidateReady?`CANDIDATE ${m.candidateSide>0?"LONG":"SHORT"}`:`${esc(m.longPhase||"-")} / ${esc(m.shortPhase||"-")}`;
  const slowTrend=m.slowTrendReady?`${num(m.trendFastBps,0)} / ${num(m.trendMediumBps,0)} / ${num(m.trendSlowBps,0)} bp`:"warming";
  const pullback=m.longPullbackReady?`${num(m.longPullbackDepthBps,0)} / ${num(m.longPullbackRecoveryBps,0)} / ${num(m.longPullbackRemainingRoomBps,0)} bp`:"warming";
  return `<article class="market-card"><div class="market-top"><div><div class="symbol">${esc(m.symbol)}</div><div class="venue">KRAKEN FUTURES · ${esc(m.regime||"WARMING")}</div></div><span class="book-state ${bookStateClass}">${bookState}</span></div><div class="market-price">${priceMoney(m.mid)}</div><div class="market-spread">${priceMoney(m.bestBid)} bid · ${priceMoney(m.bestAsk)} ask</div><div class="micro-bars">${seed.map(h=>`<i style="height:${h}px"></i>`).join("")}</div><div class="market-metrics"><div class="metric"><span>Spread</span><strong>${num(m.spreadBps,2)} bp</strong></div><div class="metric"><span>Slow trend 5/15/60m</span><strong>${slowTrend}</strong></div><div class="metric"><span>Pullback depth/recovery/room</span><strong>${pullback}</strong></div><div class="metric"><span>Provider age</span><strong>${num(m.providerAgeMs,0)} ms</strong></div></div><div class="decision-strip"><div><small>Rule state</small><b>${stateLabel}</b></div><small title="${esc(blocks)}">${esc(pipeline)} · ${esc(rejection||gateText)}</small></div></article>`;}).join("");}
function policyFamilyName(family){return {CONTINUATION:"Trend",EARLY_BREAKOUT:"Breakout",PULLBACK_RECOVERY:"Recovery",BREAKOUT_RETEST:"Breakout retest"}[family]||String(family);}
function renderPolicyMarket(m){
  const p=m.policyPulse;
  if(!p)return `<article class="market-card policy-card"><div class="symbol">${esc(m.symbol)}</div><div class="market-price">${priceMoney(m.mid)}</div><div class="policy-status"><b>WAITING FOR POLICY TELEMETRY</b><p>The policy engine is active; its per-symbol snapshot is not available yet.</p></div></article>`;
  const dataValid=m.bookValid&&!m.stale,motionReady=m.kinematicsReady!==false;
  const bookState=!dataValid?"DATA GATED":!motionReady?"MOTION RESET":"BOOK VALID";
  const mode={PAPER_RESEARCH:"PAPER RESEARCH · UNSCORED",CALIBRATED_PAPER:"CALIBRATED PAPER ONLY",SHADOW:"SHADOW · NO ORDERS",RECORD:"RECORD · NO ORDERS"}[p.mode]||p.mode;
  const status={DATA_GATED:"DATA GATED",WARMING:"POLICY WARMUP",RISK_BLOCKED:"RISK GATED",POSITION_OPEN:"POSITION OPEN",ORDER_PENDING:"ORDER PENDING",COOLDOWN:"ENTRY COOLDOWN",WAITING_FOR_SIGNAL:"NO QUALIFYING SIGNAL",AWAITING_VALIDATION:"AWAITING VALIDATION",WAITING_FOR_QUOTE:"SIGNAL PRESENT · FRESH-QUOTE CHECKS",LIQUIDITY_BLOCKED:"LIQUIDITY GATED",ENTRY_BLOCKED:"ENTRY CHECK REJECTED"}[p.status]||p.status;
  const details={DATA_GATED:"Fresh executable quotes are required.",WARMING:"Waiting for causal trend and motion features.",RISK_BLOCKED:"Health or risk gates currently block new orders.",POSITION_OPEN:`Managing ${p.activePolicyId||"existing"} position; no additional entry.`,ORDER_PENDING:"An order is in flight; no additional entry.",COOLDOWN:`Next entry check in ${duration(p.cooldownRemainingMs)}.`,WAITING_FOR_SIGNAL:"No trend, breakout, or recovery predicate currently matches.",AWAITING_VALIDATION:"No current signal has a matching validated model; unscored orders are disabled.",WAITING_FOR_QUOTE:"Entries are checked on fresh quotes, independently of the research timer; sizing and risk checks still apply.",LIQUIDITY_BLOCKED:"A signal matches, but its liquidity checks currently fail.",ENTRY_BLOCKED:"The latest quote failed an entry check; the rejection is shown below."}[p.status]||"";
  const setup=p.setup?`<div class="policy-family"><div><b>${esc({WATCHING:"Watching the prior range",BREAKOUT:"Breakout detected · waiting for retest",RETESTED:"Retest confirmed · waiting for renewed flow",CANDIDATE:"Reacceleration candidate"}[p.setup.phase]||p.setup.phase)}</b><small>${p.setup.boundary==null?`${p.setup.samples} range samples`:`Frozen level ${priceMoney(p.setup.boundary)}`}</small></div></div>`:"";
  const rows=setup+(p.families||[]).map(f=>`<div class="policy-family"><div><b>${esc(policyFamilyName(f.family))}</b><small>${(f.horizonsMs||[]).map(h=>`${num(h/60000,0)}m`).join(" / ")}</small></div><span class="policy-signal ${f.longSignal?"matched":""}">LONG ${f.longSignal?"MATCH":"—"}</span><span class="policy-signal ${f.shortSignal?"matched":""}">SHORT ${f.shortSignal?"MATCH":"—"}</span></div>`).join("");
  const models=p.promotedModels||[];
  const evidence=models.length?models.map(model=>`${model.policyId} ${model.side>0?"LONG":"SHORT"} · LCB ${num(model.lowerNetBps,2)} bp`).join("; "):"No validated models · profitability unproven";
  const sampled=p.lastSample?(p.lastSample.candidates||[]).map(c=>`${c.policyId} ${c.side>0?"LONG":"SHORT"}`).join(", ")||"no candidates":"not sampled yet";
  const nowMs=state.snapshot?.generatedAtMs??Date.now();
  const sampleTime=p.lastSample?`${time(p.lastSample.atMs)} · ${duration(Math.max(0,nowMs-p.lastSample.atMs))} ago`:"waiting for first fresh-quote sample";
  const nextSample=p.nextSampleAtMs==null?"on a fresh quote":p.nextSampleAtMs>nowMs?`in ${duration(p.nextSampleAtMs-nowMs)}`:"waiting for a fresh quote";
  const counters=p.entryCounters||{};
  const lastCheck=`<p><span>Entry checks · every fresh quote</span>${num(counters.quoteChecks||0,0)} quotes · ${num(counters.signalMatches||0,0)} signal matches · ${num(counters.plansApproved||0,0)} approved plans</p><p><span>Research sampling only</span>The periodic sample timer does not delay entry checks.</p><p><span>Liquidity checks</span>${esc((p.liquidityReasons||[]).join(" · ")||"No current liquidity rejection")}</p>${p.lastEvaluation?`<p><span>Last plan check · ${time(p.lastEvaluation.atMs)}</span>${esc(p.lastEvaluation.policyId)} ${p.lastEvaluation.side>0?"LONG":"SHORT"} · ${esc(p.lastEvaluation.reason)}</p>`:""}`;
  const lastBlock=p.lastRejection?`<p><span>Last rejection · ${time(p.lastRejection.atMs)} (history)</span>${esc(p.lastRejection.stage)} · ${esc(p.lastRejection.reason)}</p>`:"";
  const pullback=(side)=>m[`${side}PullbackReady`]?`${num(m[`${side}PullbackDepthBps`],0)} / ${num(m[`${side}PullbackRecoveryBps`],0)} / ${num(m[`${side}PullbackRemainingRoomBps`],0)} bp`:"not ready";
  return `<article class="market-card policy-card" data-testid="policy-market-card"><div class="market-top"><div><div class="symbol">${esc(m.symbol)}</div><div class="venue">KRAKEN FUTURES · ${esc(m.regime||"WARMING")}</div></div><span class="book-state ${!dataValid?"bad":!motionReady?"warn":""}">${bookState}</span></div><div class="market-price">${priceMoney(m.mid)}</div><div class="market-spread">${priceMoney(m.bestBid)} bid · ${priceMoney(m.bestAsk)} ask</div><div class="policy-version">${esc(p.version)}<span>${esc(mode)}</span></div><div class="policy-families" aria-label="Live directional policy signals">${rows}</div><div class="market-metrics"><div class="metric"><span>Spread / provider age</span><strong>${num(m.spreadBps,2)} bp / ${num(m.providerAgeMs,0)} ms</strong></div><div class="metric"><span>Slow trend 5/15/60m</span><strong>${m.slowTrendReady?`${num(m.trendFastBps,1)} / ${num(m.trendMediumBps,1)} / ${num(m.trendSlowBps,1)} bp`:"warming"}</strong></div><div class="metric"><span>Long pullback depth/recovery/room</span><strong>${pullback("long")}</strong></div><div class="metric"><span>Short pullback depth/recovery/room</span><strong>${pullback("short")}</strong></div></div><div class="policy-evidence"><b>${models.length} validated model${models.length===1?"":"s"}</b><small>${esc(evidence)}</small><small>${p.mode==="PAPER_RESEARCH"?"Unscored experiments enabled":p.mode==="CALIBRATED_PAPER"?"Validated evidence required":"Order submission disabled"} · cap ${money(p.maximumNotional,0)}</small></div><div class="policy-status"><b>${esc(status)}</b><p>${esc(details)}${p.reasons?.length?` ${esc(p.reasons.join(" · "))}`:""}</p></div><div class="policy-sampling"><p><span>Last sample · ${esc(sampleTime)}</span>${esc(sampled)}</p><p><span>Next sample · ${num(p.sampleIntervalMs/1000,0)}s cadence</span>${esc(nextSample)}</p>${lastCheck}${lastBlock}</div></article>`;
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
  const title=position.active?"Estimated net position P&amp;L":"Realized trade P&amp;L";
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
  return `<div class="realized-pnl-breakdown" data-testid="realized-pnl-breakdown"><div class="realized-pnl-row"><span>Gross price gain</span><strong class="${pnlClass(breakdown.grossPricePnl)}">${signedMoney(breakdown.grossPricePnl,5)}</strong></div><div class="realized-pnl-row"><span>Entry ${esc(entryStyle)} fee</span><strong class="negative">${signedMoney(-Math.abs(breakdown.entryFee),5)}</strong></div><div class="realized-pnl-row"><span>Exit ${esc(exitStyle)} fee</span><strong class="negative">${signedMoney(-Math.abs(breakdown.exitFee),5)}</strong></div><div class="realized-pnl-row total"><span>Actual realized P&amp;L</span><strong class="${pnlClass(breakdown.realizedPnl)}">${signedMoney(breakdown.realizedPnl,5)}</strong></div></div>`;
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
function renderOrderLeg(o,label){
  const side=o.side>0?"BUY":"SELL",cost=o.expectedCost||{},ttl=o.expiresInMs>0?`${duration(o.expiresInMs)} left`:o.terminal?"complete":"expired";
  const statusText=o.statusLabel||o.status.replaceAll("_"," "),cancelTitle=o.cancelRequestReason?`Requested: ${o.cancelRequestReason.replaceAll("_"," ")}`:"";
  return `<section class="trade-leg" data-testid="${label.toLowerCase()}-leg"><div class="trade-leg-head"><div><span class="trade-leg-label">${esc(label)} · ${side} · ${esc(o.style.toUpperCase())} · ${esc(o.timeInForce.toUpperCase())}</span><div class="order-id" title="${esc(o.clientOrderId)}">${esc(o.clientOrderId)}</div></div><span class="order-status ${esc(o.status)}" title="${esc(cancelTitle)}">${esc(statusText)}</span></div><div class="fill-row"><span>FILLED <strong>${num(o.filledQty,6)} / ${num(o.requestedQty,6)}</strong></span><span>${num(o.fillPercent,1)}%</span></div><div class="fill-bar"><i style="width:${Math.max(0,Math.min(100,o.fillPercent))}%"></i></div><div class="order-main"><div class="metric"><span>Limit</span><strong>${priceMoney(o.limitPx)}</strong></div><div class="metric"><span>Avg fill</span><strong>${o.averageFillPx?priceMoney(o.averageFillPx):"—"}</strong></div><div class="metric"><span>Expected value</span><strong class="${pnlClass(o.expectedValue)}">${money(o.expectedValue)}</strong></div><div class="metric"><span>TTL / age</span><strong>${ttl} · ${duration(o.ageMs)}</strong></div></div><div class="cost-grid"><div><span>Round trip</span><strong>${num(cost.roundTripBps,2)} bp</strong></div><div><span>Impact</span><strong>${num(cost.impactBps,2)} bp</strong></div><div><span>Fill probability</span><strong>${num(o.fillProbability*100,1)}%</strong></div></div>${renderOrderTimeline(o,`${label} lifecycle`)}</section>`;
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
  return `<article class="order-card order-attempt-card ${o.livePosition?"has-live-position":""}" data-testid="order-attempt-card"><div class="order-head"><div><span class="symbol">${esc(o.symbol)}</span><span class="side-label ${o.side<0?"sell":""}">ORDER ATTEMPT · ${side} · ${esc(o.style.toUpperCase())} · ${esc(o.timeInForce.toUpperCase())}${o.historical?" · HISTORY":""}</span><div class="order-id" title="${esc(o.clientOrderId)}">${esc(o.clientOrderId.slice(0,32))}</div></div><span class="order-status ${esc(o.status)}" title="${esc(cancelTitle)}">${esc(statusText)}</span></div><div class="fill-row"><span>FILLED <strong>${num(o.filledQty,6)} / ${num(o.requestedQty,6)}</strong></span><span>${num(o.fillPercent,1)}%</span></div><div class="fill-bar"><i style="width:${Math.max(0,Math.min(100,o.fillPercent))}%"></i></div>${renderLivePnl(o.livePosition)}<div class="order-main"><div class="metric"><span>Limit</span><strong>${priceMoney(o.limitPx)}</strong></div><div class="metric"><span>Avg fill</span><strong>${o.averageFillPx?priceMoney(o.averageFillPx):"—"}</strong></div><div class="metric"><span>Expected value</span><strong class="${pnlClass(o.expectedValue)}">${money(o.expectedValue)}</strong></div><div class="metric"><span>TTL / age</span><strong>${ttl} · ${duration(o.ageMs)}</strong></div></div><div class="cost-grid"><div><span>Round trip</span><strong>${num(cost.roundTripBps,2)} bp</strong></div><div><span>Impact</span><strong>${num(cost.impactBps,2)} bp</strong></div><div><span>Fill probability</span><strong>${num(o.fillProbability*100,1)}%</strong></div></div>${renderOrderTimeline(o)}</article>`;
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
el("pause-button").addEventListener("click",()=>{state.paused=!state.paused;el("pause-button").innerHTML=state.paused?"<span>▶</span> Resume stream":"<span>Ⅱ</span> Pause stream";if(!state.paused&&state.snapshot)fetch("/api/dashboard",{cache:"no-store"}).then(r=>r.json()).then(applySnapshot).catch(()=>{});});
bootstrap();
