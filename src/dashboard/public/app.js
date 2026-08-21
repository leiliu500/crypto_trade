const state={snapshot:null,paused:false,orderFilter:"all",symbol:"all",socket:null,retry:0};
const el=(id)=>document.getElementById(id);
const esc=(value)=>String(value??"").replace(/[&<>'"]/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]);
const num=(value,digits=2)=>value==null||!Number.isFinite(Number(value))?"—":Number(value).toLocaleString(undefined,{minimumFractionDigits:digits,maximumFractionDigits:digits});
const money=(value,digits=2)=>value==null||!Number.isFinite(Number(value))?"—":Number(value).toLocaleString(undefined,{style:"currency",currency:"USD",minimumFractionDigits:digits,maximumFractionDigits:digits});
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
  el("equity").textContent=money(s.equity);el("drawdown").textContent=`Peak ${money(s.equityHighWater)}`;el("session-pnl").textContent=signed(s.realizedSessionPnl," USD");el("session-pnl").className=pnlClass(s.realizedSessionPnl);
  el("latency").textContent=`${num(s.latencyP95Ms,1)} ms`;el("uptime").textContent=duration(s.uptimeMs);el("strategy-version").textContent=`Strategy ${s.strategyVersion}`;el("last-update").textContent=`Updated ${relative(s.generatedAtMs)}`;
  renderLiveness(s.liveness||[]);syncSymbols(s.markets||[]);renderMarkets(filtered(s.markets||[]));renderOrders(filtered(s.orders||[]));renderEvents(s.events||[]);
  el("footer-detail").textContent=`DB ${s.database.status} · ${s.database.queuedRecords} queued · ${s.signalMode||"DETERMINISTIC_ONLY"} · config ${s.configurationVersion||"-"}${s.modelVersion&&s.modelVersion!=="none"?` · model ${s.modelVersion}`:""}`;
}
function filtered(items){return state.symbol==="all"?items:items.filter(item=>item.symbol===state.symbol);}
function renderLiveness(items){el("liveness-grid").className="liveness-grid";el("liveness-grid").innerHTML=items.map(item=>`<article class="live-card ${item.healthy?"":"bad"}"><span class="status-icon">${item.healthy?"✓":"!"}</span><div><b>${esc(item.label)}</b><small title="${esc(item.detail)}">${esc(item.detail)}</small></div><i class="live-dot"></i></article>`).join("");}
function syncSymbols(markets){const select=el("symbol-filter"),current=select.value||state.symbol,values=[...new Set(markets.map(m=>m.symbol))];select.innerHTML=`<option value="all">All symbols</option>${values.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join("")}`;select.value=values.includes(current)||current==="all"?current:"all";state.symbol=select.value;}
function renderMarkets(items){const grid=el("market-grid");if(!items.length){grid.className="market-grid empty-grid";grid.innerHTML="<p>Waiting for order books…</p>";return;}grid.className="market-grid";grid.innerHTML=items.map(m=>{
  const seed=[m.qi1,m.ofi,m.tfi,m.efficiency,m.velocityZ,m.sigmaHBps,1-m.providerAgeMs/(m.staleThresholdMs||1000),m.spreadBps].map((v,i)=>Math.max(3,Math.min(33,6+Math.abs(Number(v)||0)*(i<3?10:4))));
  const focus=Number(m.longScore)>=Number(m.shortScore)?m.longRule:m.shortRule;
  const gateText=(m.blockReasons||[]).slice(0,3).join(", ")||"All deterministic gates ready";
  const ruleDetail=focus?`LCB ${num(focus.lowerBoundNetBps,2)} bp · gross ${num(focus.grossOpportunityBps,2)} · robust cost ${num(focus.robustCostBps,2)} · continuation ${num(100*focus.continuationQuality,0)}% · ${focus.executionPath||"no path"} @ ${num(focus.edgeHorizonMs/60000,0)}m · votes ${focus.bookVotes}/${focus.flowVotes}/${focus.kinematicVotes}`:"";
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
  const stateLabel=m.entryReady?"ENTRY READY":m.candidateReady?`CANDIDATE ${m.candidateSide>0?"LONG":"SHORT"}`:`${esc(m.longPhase||"-")} / ${esc(m.shortPhase||"-")}`;
  return `<article class="market-card"><div class="market-top"><div><div class="symbol">${esc(m.symbol)}</div><div class="venue">ALPACA · CRYPTO · ${esc(m.regime||"WARMING")}</div></div><span class="book-state ${bookStateClass}">${bookState}</span></div><div class="market-price">${money(m.mid,m.mid>1000?2:4)}</div><div class="market-spread">${money(m.bestBid,m.mid>1000?2:4)} bid · ${money(m.bestAsk,m.mid>1000?2:4)} ask</div><div class="micro-bars">${seed.map(h=>`<i style="height:${h}px"></i>`).join("")}</div><div class="market-metrics"><div class="metric"><span>Spread</span><strong>${num(m.spreadBps,2)} bp</strong></div><div class="metric"><span>Dynamic limit</span><strong>${num(m.liquidityTradeThresholdBps,2)} bp</strong></div><div class="metric"><span>Provider age</span><strong>${num(m.providerAgeMs,0)} ms</strong></div></div><div class="decision-strip"><div><small>Rule state</small><b>${stateLabel}</b></div><small title="${esc(blocks)}">${esc(pipeline)} · ${esc(rejection||gateText)}</small></div></article>`;}).join("");}
function renderEvents(items){el("events-body").innerHTML=items.slice(0,25).map(e=>`<tr><td class="event-time">${time(e.atMs)}</td><td><span class="severity ${esc(e.severity)}">${esc(e.severity)}</span></td><td class="event-type">${esc(e.type)}</td><td title="${esc(e.summary)}">${esc(e.summary)}</td></tr>`).join("")||"<tr><td colspan='4' class='empty-row'>Waiting for events…</td></tr>";}

function renderLivePnl(position){
  if(!position)return "";
  const totalPnl=!position.active&&Number.isFinite(position.realizedPnl)?position.realizedPnl:position.unrealizedPnl;
  const totalPnlBps=!position.active&&Number.isFinite(position.realizedPnlBps)?position.realizedPnlBps:position.unrealizedPnlBps;
  const history=(position.pnlHistory||[]).slice().reverse().map(point=>`<div class="pnl-change-row"><time>${time(point.atMs)}</time><span>${money(point.currentPx,point.currentPx>1000?2:4)}${point.kind==="close"?" exit":""}</span><strong class="${pnlClass(point.unrealizedPnl)}">${signedMoney(point.unrealizedPnl)}</strong><em class="${pnlClass(point.changePnl)}">${point.changePnl==null?"initial":signedMoney(point.changePnl)}</em></div>`).join("");
  const stateLabel=position.active?"OPEN":"CLOSED";
  const title=position.active?"Live position P&amp;L":"Realized trade P&amp;L";
  const ageLabel=position.active?"Open":"Held";
  const context=position.latestReason||(position.active?"Position is open and monitored by the exit engine":"Position closed; retained P&amp;L samples are read-only history");
  const priceLabel=position.active?"Last mark":"Exit fill";
  const displayPx=position.closePx||position.currentPx;
  return `<section class="order-live-pnl ${position.active?"active":"closed"}" data-testid="order-live-pnl" aria-live="polite"><div class="live-pnl-head"><div><span>${title}</span><strong class="${pnlClass(totalPnl)}">${signedMoney(totalPnl)}</strong></div><div><span class="pnl-position-state">${stateLabel}</span><strong class="${pnlClass(totalPnlBps)}">${signed(totalPnlBps," bp")}</strong></div></div><div class="live-pnl-meta"><span>Entry ${money(position.entryPx,position.entryPx>1000?2:4)}</span><span>${priceLabel} ${money(displayPx,displayPx>1000?2:4)}</span><span>${ageLabel} ${duration(position.ageMs)}</span></div><div class="pnl-history"><div class="pnl-history-title"><span>All P&amp;L changes</span><span>mark / total / change</span></div>${history||"<div class='pnl-history-empty'>Waiting for the next price change…</div>"}</div><div class="live-pnl-action"><b>${esc(position.latestAction)}</b><span title="${esc(context)}">${esc(context)}</span></div></section>`;
}
function renderOrders(items){
  items=items.filter(order=>order.livePosition||state.orderFilter==="all"||(state.orderFilter==="open"?!order.terminal:order.terminal));
  const grid=el("orders-grid");
  if(!items.length){grid.className="orders-grid empty-grid";grid.innerHTML="<p>No orders match this view.</p>";return;}
  grid.className="orders-grid";
  grid.innerHTML=items.map(o=>{
    const side=o.side>0?"BUY":"SELL",cost=o.expectedCost||{},ttl=o.expiresInMs>0?`${duration(o.expiresInMs)} left`:o.terminal?"complete":"expired";
    const statusText=o.statusLabel||o.status.replaceAll("_"," "),cancelTitle=o.cancelRequestReason?`Requested: ${o.cancelRequestReason.replaceAll("_"," ")}`:"";
    const timeline=(o.timeline||[]).slice(-5).map(t=>`<div class="timeline-item ${esc(t.severity)}" title="${esc(t.label)}">${esc(t.status.replaceAll("_"," "))}<br>${time(t.atMs)}</div>`).join("");
    return `<article class="order-card ${o.livePosition?"has-live-position":""}"><div class="order-head"><div><span class="symbol">${esc(o.symbol)}</span><span class="side-label ${o.side<0?"sell":""}">${side} · ${esc(o.style.toUpperCase())} · ${esc(o.timeInForce.toUpperCase())}${o.historical?" · HISTORY":""}</span><div class="order-id" title="${esc(o.clientOrderId)}">${esc(o.clientOrderId.slice(0,32))}</div></div><span class="order-status ${esc(o.status)}" title="${esc(cancelTitle)}">${esc(statusText)}</span></div><div class="fill-row"><span>FILLED <strong>${num(o.filledQty,6)} / ${num(o.requestedQty,6)}</strong></span><span>${num(o.fillPercent,1)}%</span></div><div class="fill-bar"><i style="width:${Math.max(0,Math.min(100,o.fillPercent))}%"></i></div>${renderLivePnl(o.livePosition)}<div class="order-main"><div class="metric"><span>Limit</span><strong>${money(o.limitPx,o.limitPx>1000?2:4)}</strong></div><div class="metric"><span>Avg fill</span><strong>${o.averageFillPx?money(o.averageFillPx,o.averageFillPx>1000?2:4):"—"}</strong></div><div class="metric"><span>Expected value</span><strong class="${pnlClass(o.expectedValue)}">${money(o.expectedValue)}</strong></div><div class="metric"><span>TTL / age</span><strong>${ttl} · ${duration(o.ageMs)}</strong></div></div><div class="cost-grid"><div><span>Round trip</span><strong>${num(cost.roundTripBps,2)} bp</strong></div><div><span>Impact</span><strong>${num(cost.impactBps,2)} bp</strong></div><div><span>Fill probability</span><strong>${num(o.fillProbability*100,1)}%</strong></div></div><div class="timeline"><div class="timeline-title">Lifecycle</div><div class="timeline-items">${timeline||"<div class='timeline-item'>Created</div>"}</div></div></article>`;
  }).join("");
}

el("symbol-filter").addEventListener("change",event=>{state.symbol=event.target.value;if(state.snapshot)render(state.snapshot);});
document.querySelectorAll("[data-order-filter]").forEach(button=>button.addEventListener("click",()=>{document.querySelectorAll("[data-order-filter]").forEach(b=>b.classList.remove("active"));button.classList.add("active");state.orderFilter=button.dataset.orderFilter;if(state.snapshot)renderOrders(filtered(state.snapshot.orders||[]));}));
el("pause-button").addEventListener("click",()=>{state.paused=!state.paused;el("pause-button").innerHTML=state.paused?"<span>▶</span> Resume stream":"<span>Ⅱ</span> Pause stream";if(!state.paused&&state.snapshot)fetch("/api/dashboard",{cache:"no-store"}).then(r=>r.json()).then(applySnapshot).catch(()=>{});});
bootstrap();
