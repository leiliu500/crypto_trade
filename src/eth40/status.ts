import { DAY_MS, ETH40_SPEC } from "./spec.js";
import type { CycleResult, MarketSnapshot, PaperState } from "./types.js";

export function eth40Status(input: { state: PaperState; sequence: number; lastHash: string;
  lastCycle: CycleResult | null; market: MarketSnapshot | null; processStartedAtMs: number;
  fatalError: string | null; nowMs: number }) {
  const { state, market, lastCycle, nowMs } = input;
  const heartbeatAgeMs = state.lastCycleAtMs > 0 ? nowMs - state.lastCycleAtMs : null;
  const collectorHealthy = input.fatalError === null && lastCycle !== null && input.sequence > 1
    && heartbeatAgeMs !== null && heartbeatAgeMs >= 0 && heartbeatAgeMs < 120_000;
  const day = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const nextExecutionWindowMs = Math.max(state.firstExecutionDayMs,
    nowMs < day + ETH40_SPEC.executionWindowMs ? day : day + DAY_MS);
  const accounts = lastCycle?.valuations.map(value => {
    const portfolio = state.portfolios[value.accountId];
    return { ...value, symbol: portfolio.symbol, initialCashUsd: portfolio.account.initialCashUsd,
      returnOnAccountPct: value.netPnlUsd === null ? null : value.netPnlUsd / portfolio.account.initialCashUsd * 100,
      fills: portfolio.account.receipts.length, completedEpisodes: portfolio.completedEpisodes,
      sampledMaxDrawdownUsd: portfolio.maxDrawdownUsd,
      sampledMaxDrawdownPctInitial: portfolio.maxDrawdownUsd / portfolio.account.initialCashUsd * 100,
      firstFillAtMs: portfolio.account.receipts[0]?.timestampMs ?? null };
  }) ?? [];
  const strategy = accounts.find(x => x.accountId === "eth40");
  const excess = (id: string) => {
    const benchmark = accounts.find(x => x.accountId === id);
    return strategy?.netPnlUsd != null && benchmark?.netPnlUsd != null ? strategy.netPnlUsd - benchmark.netPnlUsd : null;
  };
  return { service: "ETH40 isolated spot paper observation", liveTradingEnabled: false,
    historicalScreenPassed: false, validatedProfitable: false, automaticPromotionAllowed: false,
    collectorHealthy, fatalError: input.fatalError, processStartedAtMs: input.processStartedAtMs,
    startedAtMs: state.startedAtMs, recordedAtMs: state.lastCycleAtMs, heartbeatAgeMs,
    sequence: input.sequence, lastHash: input.lastHash, firstExecutionDayMs: state.firstExecutionDayMs,
    nextExecutionWindowMs, reviewAtMs: state.reviewAtMs,
    reviewStatus: nowMs < state.reviewAtMs ? "COLLECTING" : state.portfolios.eth40.completedEpisodes < ETH40_SPEC.minimumCompletedEpisodes
      ? "INCONCLUSIVE_TOO_FEW_COMPLETED_EPISODES" : "REVIEW_REQUIRED_NO_AUTOMATIC_PROMOTION",
    cashBenchmark: { initialCashUsd: ETH40_SPEC.initialCashUsd, equityUsd: ETH40_SPEC.initialCashUsd, netPnlUsd: 0, interestAssumed: 0 },
    benchmarkSizing: ETH40_SPEC.launchContract,
    accounts, excessVsCashUsd: strategy?.netPnlUsd ?? null,
    excessVsPassiveEthUsd: excess("passiveEth"), excessVsPassiveBtcUsd: excess("passiveBtc"),
    lastDecisions: lastCycle?.decisions ?? [],
    capturedMarkets: market ? { observedAtMs: market.observedAtMs, errors: market.errors,
      rulesFetchedAtMs: market.rulesFetchedAtMs, rulesFetchedAtMsByAsset: market.rulesFetchedAtMsByAsset ?? null, rules: market.rules,
      quotes: Object.values(market.books).map(book => ({ symbol: book.symbol, bid: book.bids[0]?.[0], ask: book.asks[0]?.[0],
        receivedAtMs: book.receivedAtMs, exchangeUpdateAtMs: book.exchangeUpdateAtMs,
        ageAtCaptureMs: market.observedAtMs - book.receivedAtMs, checksumValid: book.checksumValid,
        checksum: book.checksum, connectionId: book.connectionId })),
      completedHistory: Object.fromEntries(Object.entries(market.histories).map(([asset, bars]) => [asset,
        { bars: bars.length, firstOpenTimeMs: bars[0]?.openTimeMs, lastOpenTimeMs: bars.at(-1)?.openTimeMs }])),
    } : null,
    valuationConvention: "Values are as of recordedAtMs. Inventory is marked to fresh verified bid less assumed exit fee; stale or unavailable inventory quotes produce null P&L. Drawdown is sampled, not a complete intraday maximum.",
    spec: ETH40_SPEC };
}

export const ETH40_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ETH40 paper observation</title><style>
:root{color-scheme:dark;font:16px system-ui;background:#111923;color:#e4edf5}body{max-width:1100px;margin:40px auto;padding:0 24px}h1{font-size:30px}p{color:#acbdcc;line-height:1.6}table{border-collapse:collapse;width:100%;margin:28px 0}th,td{text-align:right;padding:13px;border-bottom:1px solid #304252}th:first-child,td:first-child{text-align:left}code{color:#87d5d5}a{color:#87d5d5}.badge{font-size:13px;border:1px solid #65829a;padding:5px 10px;border-radius:5px}#error{color:#ffb4a8}.grid{display:flex;gap:36px;flex-wrap:wrap}.grid div{min-width:220px}strong{color:#fff}small{color:#acbdcc}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
</style><span class="badge">PAPER • ETH/USD • FROZEN RULE</span><h1>ETH40 forward observation</h1>
<p>The strategy holds funded ETH or cash. Passive ETH and BTC each buy once using the same $1,000 / 10% entry cap on a separate $10,000 account. All accounts retain unused cash.</p>
<p id="error"></p><div class="grid"><div>Collector<br><strong id="health">Starting…</strong></div><div>Next execution window (UTC)<br><strong id="next">—</strong></div><div>Economic review (UTC)<br><strong id="review">—</strong></div></div>
<table><thead><tr><th>Account</th><th>Net liquidation</th><th>Net P&amp;L</th><th>Fees paid</th><th>Completed episodes</th></tr></thead><tbody id="accounts"></tbody></table>
<p id="capture"></p><p id="decisions"></p><p id="excess"></p>
<p>Entries use close &gt; SMA40 × 1.01673889; exits use close ≤ SMA40. Signals trade during the first minute of UTC day i+2. The fee assumption is 0.80% per side; paper fills walk verified displayed depth. These assumptions do not establish actual exchange fills.</p>
<p>Profitability remains unvalidated. Review requires six calendar months and at least ten completed ETH40 episodes; there is no automatic promotion to live trading. Open holdings include estimated exit fees but are not forced closed for reporting.</p>
<details><summary>Recorded market data and decisions</summary><pre id="details"></pre></details><p><a href="/api/status">Status JSON</a> · <a href="/api/receipts">Fill receipts</a> · <a href="/api/manifest">Frozen manifest</a></p>
<script>
const money=v=>v===null?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(v);
const date=v=>new Date(v).toISOString().replace('T',' ').replace('.000Z',' UTC');
async function refresh(){try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error('Status unavailable');const s=await r.json();
document.getElementById('health').textContent=s.collectorHealthy?'Recording':'Starting or delayed';document.getElementById('next').textContent=date(s.nextExecutionWindowMs);document.getElementById('review').textContent=date(s.reviewAtMs);
document.getElementById('error').textContent=s.fatalError||'';
const rows=[{accountId:'cash',liquidationEquityUsd:10000,netPnlUsd:0,feesUsd:0,completedEpisodes:0},...s.accounts];const body=document.getElementById('accounts');body.replaceChildren();
for(const a of rows){const tr=document.createElement('tr');for(const value of [({cash:'Cash',eth40:'ETH40',passiveEth:'Passive ETH',passiveBtc:'Passive BTC'})[a.accountId],money(a.liquidationEquityUsd),money(a.netPnlUsd),money(a.feesUsd),a.completedEpisodes]){const td=document.createElement('td');td.textContent=String(value);tr.append(td)}body.append(tr)}
document.getElementById('capture').textContent='Recorded '+date(s.recordedAtMs)+' · '+s.sequence+' durable observations. Quote ages shown in details are measured at capture.';
document.getElementById('decisions').textContent=s.lastDecisions.map(d=>d.accountId+': '+d.reason).join(' · ');
document.getElementById('excess').textContent='ETH40 excess versus passive ETH: '+money(s.excessVsPassiveEthUsd)+'; versus passive BTC: '+money(s.excessVsPassiveBtcUsd)+'.';
document.getElementById('details').textContent=JSON.stringify({market:s.capturedMarkets,decisions:s.lastDecisions},null,2);
}catch(e){document.getElementById('error').textContent=String(e)}}refresh();setInterval(refresh,10000);
</script></html>`;
