// Independent forward paper accounts; all requests stay on the dashboard origin.
const eth40View = { snapshot: null, receivedAt: null, referenceAtMs: null, error: null,
  polling: false, lastPollAt: -Infinity, receipts: null, receiptError: false, receiptSequence: null, observations: [] };
const ETH40_POLL_MS = 5_000, ETH40_RESPONSE_STALE_MS = 15_000, ETH40_CAPTURE_STALE_MS = 120_000;
const eth40Selected = () => new URLSearchParams(location.search).get("view") === "eth40";
const eth40Node = id => document.getElementById(id);
const eth40Finite = value => typeof value === "number" && Number.isFinite(value);
const eth40Time = value => Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
const eth40Escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const eth40Number = (value, digits = 2) => eth40Finite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "Unavailable";
const eth40Money = value => eth40Finite(value) ? value.toLocaleString("en-US", { style: "currency", currency: "USD" }) : "Unavailable";
const eth40Signed = value => eth40Finite(value) ? `${value < 0 ? "−" : "+"}${eth40Money(Math.abs(value))}` : "Unavailable";
const eth40PnlClass = value => eth40Finite(value) ? value > 0 ? "positive" : value < 0 ? "negative" : "" : "";
const eth40Utc = value => eth40Finite(value) && value > 0 && value <= 8_640_000_000_000_000
  ? `${new Date(value).toISOString().slice(0, 19).replace("T", " ")} UTC` : "Unknown";
const eth40Now = () => eth40View.referenceAtMs === null ? null
  : eth40View.referenceAtMs + Math.max(0, performance.now() - eth40View.receivedAt);
const eth40Age = timestamp => {
  const now = eth40Now();
  return now !== null && eth40Finite(timestamp) && timestamp > 0 && timestamp <= now ? now - timestamp : null;
};
const eth40AgeLabel = age => eth40Finite(age) && age >= 0 ? age < 60_000
  ? `${Math.floor(age / 1_000)}s ago` : `${Math.floor(age / 60_000)}m ${Math.floor(age % 60_000 / 1_000)}s ago` : "Time unconfirmed";
function eth40Freshness() {
  const s = eth40View.snapshot, responseAge = eth40Age(s?.dashboardFetchedAtMs), captureAge = eth40Age(s?.recordedAtMs);
  const healthy = eth40View.error === null && s?.available === true && s.collectorHealthy === true && s.fatalError === null
    && responseAge !== null && responseAge < ETH40_RESPONSE_STALE_MS
    && captureAge !== null && captureAge < ETH40_CAPTURE_STALE_MS && s.sequence > 1;
  return { healthy, responseAge, captureAge };
}
function eth40Reason(decision) {
  const reasons = {
    WAITING_FOR_FIRST_PROSPECTIVE_EXECUTION_DAY: "Waiting for the first prospective execution day",
    EXECUTION_WINDOW_MISSED_NO_RETROFILL: "Waiting for the next daily opening window",
    ACCOUNT_ALREADY_FILLED_THIS_DAY: "Today's paper fill is complete",
    HOLD_LONG_NO_ADDITIONS: "Holding the existing ETH position",
    TARGET_CASH: "The daily trend target is cash",
    PASSIVE_PURCHASE_ALREADY_COMPLETED: "The one-time passive purchase is complete",
    PARTIAL_EXIT_RESIDUAL_REMAINS: "Part of the ETH position was sold; residual inventory remains",
    PAPER_FILL: decision?.action === "sell" ? "ETH paper sale recorded" : "ETH paper purchase recorded",
    NO_COMPLETED_DAY_VOLUME_BUDGET: "Waiting for sufficient completed-day volume",
  };
  const reason = decision?.reason;
  if (Object.hasOwn(reasons, reason)) return reasons[reason];
  if (typeof reason !== "string" || !reason.length) return "Decision unavailable";
  if (/HISTORY|CANDLE|WARMUP/.test(reason)) return "Waiting for valid completed daily history";
  if (/BOOK|QUOTE|CHECKSUM|EXCHANGE_UPDATE/.test(reason)) return "Waiting for a fresh verified ETH book";
  if (/INSTRUMENT_RULES/.test(reason)) return "Waiting for current ETH trading rules";
  return reason.toLowerCase().replaceAll("_", " ");
}
function eth40Metric(label, value, note = "", tone = "") {
  return `<div class="spot-metric"><dt>${label}</dt><dd class="${tone}">${value}</dd>${note ? `<small>${note}</small>` : ""}</div>`;
}
const eth40Duration = ms => {
  if (!eth40Finite(ms) || ms < 0) return "Unknown";
  const seconds = Math.floor(ms / 1_000), days = Math.floor(seconds / 86_400), hours = Math.floor(seconds % 86_400 / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60), remainder = seconds % 60;
  return `${days ? `${days}d ` : ""}${days || hours ? `${hours}h ` : ""}${days || hours || minutes ? `${minutes}m ` : ""}${remainder}s`;
};
function eth40LivenessCard(id, label, value, detail, tone = "") {
  return `<article id="${id}" class="spot-liveness-card ${tone}"><span class="spot-label">${eth40Escape(label)}</span><strong>${eth40Escape(value)}</strong><p>${eth40Escape(detail)}</p></article>`;
}
function observeEth40Commit(s) {
  if (!Number.isSafeInteger(s.sequence) || s.sequence <= 1 || !eth40Time(s.recordedAtMs)
    || eth40Age(s.recordedAtMs) === null || eth40View.observations.some(row => row.sequence === s.sequence)) return;
  const decision = s.lastDecisions.find(row => row.accountId === "eth40");
  eth40View.observations.unshift({ sequence: s.sequence, atMs: s.recordedAtMs, reason: eth40Reason(decision) });
  eth40View.observations = eth40View.observations.slice(0, 6);
}
function eth40QuoteAtCapture(s, symbol) {
  const market = s?.capturedMarkets, capture = market?.observedAtMs;
  const quote = Array.isArray(market?.quotes) ? market.quotes.find(q => q?.symbol === symbol) : null;
  const limit = s?.spec?.maximumQuoteAgeMs, lead = s?.spec?.maximumExchangeClockLeadMs;
  const local = eth40Time(capture) && eth40Time(quote?.receivedAtMs) ? capture - quote.receivedAtMs : null;
  const exchange = eth40Time(capture) && eth40Time(quote?.exchangeUpdateAtMs) ? capture - quote.exchangeUpdateAtMs : null;
  const timingKnown = eth40Finite(limit) && limit > 0 && eth40Finite(lead) && lead >= 0
    && local !== null && exchange !== null && eth40Finite(quote?.ageAtCaptureMs) && quote.ageAtCaptureMs === local;
  const priceKnown = eth40Finite(quote?.bid) && quote.bid > 0 && eth40Finite(quote?.ask) && quote.ask > quote.bid;
  const relevantError = Array.isArray(market?.errors) && market.errors.some(error => typeof error === "string"
    && error.startsWith(`${symbol}:`) && /BOOK|QUOTE|CHECKSUM/.test(error));
  const valid = eth40Time(capture) && capture === s?.recordedAtMs && quote?.checksumValid === true && priceKnown && timingKnown
    && local >= 0 && local <= limit && exchange >= -lead && exchange <= limit && !relevantError;
  return { valid, local, exchange, present: Boolean(quote), timingKnown };
}
function eth40Window(s) {
  const now = eth40Now(), first = s?.firstExecutionDayMs, width = s?.spec?.executionWindowMs;
  if (now === null || !eth40Time(first) || first % 86_400_000 !== 0 || !eth40Finite(width) || width <= 0 || width >= 86_400_000) return null;
  const today = Math.floor(now / 86_400_000) * 86_400_000;
  const next = Math.max(first, now - today < width ? today : today + 86_400_000);
  return { next, waitingFirst: now < first, open: now >= next && now < next + width,
    remainingMs: now >= next ? next + width - now : next - now };
}
function renderEth40Liveness() {
  if (!eth40Selected()) return;
  const s = eth40View.snapshot, f = eth40Freshness(), market = s?.capturedMarkets, capture = market?.observedAtMs;
  const responseKnown = eth40View.error === null && s?.available === true && f.responseAge !== null && f.responseAge < ETH40_RESPONSE_STALE_MS;
  const captured = f.healthy && eth40Time(capture) && capture === s?.recordedAtMs;
  const processAge = eth40Age(s?.processStartedAtMs), trialAge = eth40Age(s?.startedAtMs);
  const observations = Number.isSafeInteger(s?.sequence) && s.sequence >= 1 ? s.sequence - 1 : null;
  const api = eth40LivenessCard("eth40-live-api", "Dashboard API response",
    responseKnown ? `Responded ${eth40AgeLabel(f.responseAge)}` : "Response unconfirmed",
    `Last dashboard fetch: ${eth40Utc(s?.dashboardFetchedAtMs)}. ${f.healthy && processAge !== null ? `Process started ${eth40Duration(processAge)} ago.` : "Current process age unconfirmed."}`,
    responseKnown ? "good" : "bad");
  const recorder = eth40LivenessCard("eth40-live-observations", "Durable observations",
    observations === null ? "Count unavailable" : `${eth40Number(observations, 0)} recorded`,
    `${observations === 0 ? "No committed observation yet." : `Last record: ${eth40AgeLabel(f.captureAge)}.`} ${f.healthy ? "Collector recording." : "Collector progress unconfirmed."} ${trialAge !== null ? `Trial elapsed: ${eth40Duration(trialAge)}.` : "Trial start unconfirmed."}`,
    f.healthy ? "good" : observations === 0 ? "" : "warning");
  const quoteCard = (symbol, id, label) => {
    const q = eth40QuoteAtCapture(s, symbol), verified = captured && q.valid;
    const local = q.local === null ? "unconfirmed" : `${eth40Number(q.local, 0)} ms`;
    const exchange = q.exchange === null ? "unconfirmed" : q.exchange < 0
      ? `${eth40Number(-q.exchange, 0)} ms ahead` : `${eth40Number(q.exchange, 0)} ms`;
    return eth40LivenessCard(id, label, verified ? "Verified at capture" : !captured ? "Capture unconfirmed" : "Quote unconfirmed",
      `Local age at capture: ${local}; exchange age at capture: ${exchange}. Observation: ${eth40AgeLabel(f.captureAge)}. ${verified ? "This is a recorded quote check, not a live connection." : "A fresh verified quote is not confirmed by this observation."}`,
      verified ? "good" : "warning");
  };
  const history = market?.completedHistory?.["ETH/USD"], daily = 86_400_000;
  const countKnown = Number.isSafeInteger(history?.bars) && history.bars >= 0;
  const historyError = Array.isArray(market?.errors) && market.errors.some(error => typeof error === "string"
    && error.startsWith("ETH/USD:") && /HISTORY|CANDLE/.test(error));
  const delay = s?.spec?.signalToExecutionDays, warmup = s?.spec?.warmupBars;
  const requiredDay = eth40Time(capture) && Number.isSafeInteger(delay) && delay >= 0 ? Math.floor(capture / daily) * daily - delay * daily : null;
  const coverage = countKnown && Number.isSafeInteger(warmup) && warmup >= 0 && history.bars > warmup
    && history.firstOpenTimeMs === Date.UTC(2024, 8, 20) && eth40Time(history.lastOpenTimeMs)
    && history.lastOpenTimeMs % daily === 0 && history.bars === (history.lastOpenTimeMs - history.firstOpenTimeMs) / daily + 1
    && requiredDay !== null && history.firstOpenTimeMs <= requiredDay && history.lastOpenTimeMs >= requiredDay
    && eth40Finite(s?.spec?.finalizationDelayMs) && s.spec.finalizationDelayMs >= 0
    && history.lastOpenTimeMs + daily + s.spec.finalizationDelayMs <= capture && !historyError;
  const historyCard = eth40LivenessCard("eth40-live-history", "ETH completed daily history",
    captured && coverage ? `${eth40Number(history.bars, 0)} daily candles` : "Coverage unconfirmed",
    `${countKnown ? `${eth40Number(history.bars, 0)} candles recorded; ` : "Candle count unavailable. "}Last daily open: ${eth40Utc(history?.lastOpenTimeMs)}. ${captured && coverage ? "Eligible signal history present at capture; coverage is the collector's recorded summary." : "Eligible signal history is not confirmed."}`,
    captured && coverage ? "good" : "warning");
  const rules = market?.rules?.["ETH/USD"], rulesAt = market?.rulesFetchedAtMsByAsset?.["ETH/USD"] ?? market?.rulesFetchedAtMs;
  const rulesAge = eth40Time(capture) && eth40Time(rulesAt) ? capture - rulesAt : null, rulesLimit = s?.spec?.maximumRulesAgeMs;
  const rulesGood = captured && rules && [rules.lotSize, rules.minimumQuantity, rules.tickSize].every(x => eth40Finite(x) && x > 0)
    && eth40Finite(rules.minimumNotionalUsd) && rules.minimumNotionalUsd >= 0
    && eth40Finite(rulesLimit) && rulesLimit >= 0 && rulesAge !== null && rulesAge >= 0 && rulesAge <= rulesLimit;
  const rulesCard = eth40LivenessCard("eth40-live-rules", "ETH instrument rules",
    rulesGood ? "Present at capture" : "Rules unconfirmed",
    `ETH metadata fetched: ${eth40Utc(rulesAt)}. Age at capture: ${eth40Duration(rulesAge)}. BTC benchmark metadata is separate.`,
    rulesGood ? "good" : "warning");
  const window = eth40Window(s);
  const execution = eth40LivenessCard("eth40-live-execution", "Daily execution window",
    !f.healthy || !window ? "Schedule unconfirmed" : window.open ? `Window closes in ${eth40Duration(window.remainingMs)}`
      : `${window.waitingFirst ? "First window" : "Next window"} in ${eth40Duration(window.remainingMs)}`,
    `${window ? `${eth40Utc(window.next)}. ` : ""}A scheduled opening is not a promised fill. Signal, history, rules and quote checks still apply.`,
    f.healthy && window ? "" : "warning");
  const decision = s?.lastDecisions?.find(row => row.accountId === "eth40"), reason = eth40Reason(decision);
  const waiting = decision?.reason === "WAITING_FOR_FIRST_PROSPECTIVE_EXECUTION_DAY" || decision?.reason === "EXECUTION_WINDOW_MISSED_NO_RETROFILL" || decision?.reason === "ACCOUNT_ALREADY_FILLED_THIS_DAY";
  const decisionCard = eth40LivenessCard("eth40-live-decision", "Latest recorded ETH40 decision",
    f.healthy && decision ? reason : "Decision unconfirmed",
    `${!f.healthy && decision ? `Last record: ${reason}. ` : ""}${waiting ? "Waiting for a scheduled opportunity is normal." : "This decision describes the recorded cycle."} It does not confirm current execution readiness.`,
    f.healthy && decision ? decision.action === "blocked" && !waiting ? "warning" : "" : "warning");
  eth40Node("eth40-liveness-grid").innerHTML = [api, recorder,
    quoteCard("ETH/USD", "eth40-live-eth-book", "ETH verified quote at capture"),
    quoteCard("BTC/USD", "eth40-live-btc-book", "BTC benchmark quote at capture"), historyCard, rulesCard, execution, decisionCard].join("");
  const errors = Array.isArray(market?.errors) ? market.errors.filter(error => typeof error === "string") : null;
  eth40Node("eth40-market-errors").textContent = errors === null ? "Recorded market-data errors unavailable."
    : errors.length ? `Recorded data issues: ${errors.map(error => error.toLowerCase().replaceAll("_", " ")).join(" · ")}`
    : captured ? "No market-data errors recorded at capture. This does not guarantee a fill." : "No errors in the last capture; current market state is unconfirmed.";
  eth40Node("eth40-observations").innerHTML = eth40View.observations.length ? eth40View.observations.map(row =>
    `<li data-eth40-observation="${row.sequence}" data-eth40-observation-at-ms="${row.atMs}"><strong>Observation ${eth40Number(row.sequence - 1, 0)}</strong><time>${eth40Utc(row.atMs)}</time><span>${eth40Escape(row.reason)} · ${eth40AgeLabel(eth40Age(row.atMs))}</span></li>`).join("")
    : "<li>No committed observations seen yet.</li>";
}
function renderEth40() {
  if (!eth40Selected()) return;
  const s = eth40View.snapshot, f = eth40Freshness(), node = eth40Node("eth40-service-status");
  const failed = eth40View.error !== null || !s;
  node.className = `spot-service-status ${f.healthy ? "healthy" : failed ? "unavailable" : "stale"}`;
  node.textContent = f.healthy ? "Collector recording · Paper observation only. Captured data checks are shown below."
    : failed ? "ETH40 data unavailable. Current account values and readiness cannot be confirmed."
    : "ETH40 observation delayed or unconfirmed. Current account values and readiness are unavailable.";
  const connection = eth40Node("connection-status");
  connection.className = `connection ${f.healthy ? "live" : "offline"}`;
  connection.innerHTML = `<i></i>${f.healthy ? "ETH40 recording" : "ETH40 unavailable"}`;
  eth40Node("mode-badge").textContent = "ETH40 · PAPER";
  eth40Node("clock").textContent = eth40Now() === null ? "--:--:--" : new Date(eth40Now()).toLocaleTimeString([], { hour12: false });
  renderEth40Liveness();
  if (!s) {
    eth40Node("eth40-content").innerHTML = '<p class="spot-empty">Waiting for a confirmed ETH40 observation. No forward results are available.</p>';
    eth40Node("eth40-quotes").innerHTML = '<p class="spot-empty">Quote capture unavailable.</p>';
    return;
  }
  const accounts = s.accounts, strategy = accounts.find(a => a.accountId === "eth40");
  const current = value => f.healthy && eth40Finite(value) ? value : null;
  const decision = s.lastDecisions.find(d => d.accountId === "eth40");
  const episodes = strategy?.completedEpisodes;
  const next = eth40Finite(s.firstExecutionDayMs) && eth40Now() !== null
    ? Math.max(s.firstExecutionDayMs, Math.floor(eth40Now() / 86_400_000) * 86_400_000
      + (eth40Now() % 86_400_000 < 60_000 ? 0 : 86_400_000)) : null;
  const review = s.reviewStatus === "COLLECTING" ? "Collecting forward evidence"
    : s.reviewStatus === "INCONCLUSIVE_TOO_FEW_COMPLETED_EPISODES" ? "Inconclusive: fewer than ten completed episodes"
    : "Review required; no automatic promotion";
  const metricPnl = current(strategy?.netPnlUsd);
  eth40Node("eth40-content").innerHTML = `
    <div class="spot-decision-row"><div class="spot-decision"><span class="spot-label">Latest recorded ETH40 decision</span><h3>${eth40Escape(eth40Reason(decision))}</h3><p>${decision?.signalDayMs ? `Signal candle: ${eth40Utc(decision.signalDayMs)}. ` : ""}${f.healthy ? "" : "This is the last recorded decision; present readiness is unconfirmed."}</p></div><div class="spot-window"><span class="spot-label">Next daily eligible window</span><strong>${eth40Utc(next)}</strong><p>First 60 seconds of the UTC day. A qualifying target and valid market data are required.</p></div></div>
    <dl class="spot-metrics">
      ${eth40Metric("Forward net P&amp;L", eth40Signed(metricPnl), "From actual paper fills and the recorded net bid mark", eth40PnlClass(metricPnl))}
      ${eth40Metric("Net liquidation value", eth40Money(current(strategy?.liquidationEquityUsd)), "Open inventory includes estimated exit fees")}
      ${eth40Metric("Cash", eth40Money(current(strategy?.cashUsd)))}
      ${eth40Metric("ETH quantity", eth40Number(current(strategy?.quantity), 8))}
      ${eth40Metric("Fees paid", eth40Money(current(strategy?.feesUsd)), "Assumed paper fees: 0.80% per side")}
      ${eth40Metric("Realized net P&amp;L", eth40Signed(current(strategy?.realizedNetUsd)))}
      ${eth40Metric("Completed ETH40 episodes", eth40Number(episodes, 0), "A complete sale must flatten the inventory")}
      ${eth40Metric("Sampled maximum drawdown", eth40Money(current(strategy?.sampledMaxDrawdownUsd)), "Full account; observations may miss intraday lows")}
    </dl>
    ${f.healthy && strategy?.netPnlUsd == null ? '<p class="spot-mark-unavailable">The recorded ETH valuation is unavailable. Missing P&amp;L is not zero profit.</p>' : ""}
    <div class="spot-signal-row"><div><span class="spot-label">Recorded observations</span><strong>${eth40Number(Math.max(0, s.sequence - 1), 0)}</strong><small>Each committed observation counts once. Dashboard polling adds none.</small></div><div><span class="spot-label">Account capture</span><strong>${eth40Utc(s.recordedAtMs)}</strong><small>${eth40AgeLabel(f.captureAge)} · dashboard response ${eth40AgeLabel(f.responseAge)}</small></div><div><span class="spot-label">Six-month review</span><strong>${eth40Utc(s.reviewAtMs)}</strong><small>${review}. At least ten completed ETH40 episodes are required.</small></div></div>
    <div class="spot-orders-heading"><h3>Separate funded account comparisons</h3></div><p class="spot-ledger-note">Each account starts at $10,000. Passive ETH and BTC buy once with the same $1,000 / 10% entry cap and retain unused cash. Their results are separate allocations.</p>
    <div class="eth40-table-wrap"><table class="eth40-table"><thead><tr><th>Account</th><th>Net liquidation</th><th>Net P&amp;L</th><th>First paper fill (UTC)</th></tr></thead><tbody>
    ${[["eth40", "ETH40"], ["passiveEth", "Passive ETH"], ["passiveBtc", "Passive BTC"], ["cash", "Cash"]].map(([id, label]) => {
      const a = id === "cash" ? s.cashBenchmark : accounts.find(value => value.accountId === id);
      const pnl = current(a?.netPnlUsd), equity = current(id === "cash" ? a?.equityUsd : a?.liquidationEquityUsd);
      return `<tr><th scope="row">${label}</th><td>${eth40Money(equity)}</td><td class="${eth40PnlClass(pnl)}">${eth40Signed(pnl)}</td><td>${id === "cash" ? "No trading" : a?.firstFillAtMs == null ? "No recorded fill" : eth40Utc(a.firstFillAtMs)}</td></tr>`;
    }).join("")}</tbody></table></div>
    <p class="spot-ledger-note">ETH40 excess vs cash: ${eth40Signed(current(s.excessVsCashUsd))} · vs passive ETH: ${eth40Signed(current(s.excessVsPassiveEthUsd))} · vs passive BTC: ${eth40Signed(current(s.excessVsPassiveBtcUsd))}</p>`;
  const quotes = Array.isArray(s.capturedMarkets?.quotes) ? s.capturedMarkets.quotes : [];
  eth40Node("eth40-quotes").innerHTML = ["ETH/USD", "BTC/USD"].map(symbol => {
    const q = quotes.find(value => value?.symbol === symbol && value.checksumValid === true);
    return `<article class="eth40-quote"><strong>${symbol === "ETH/USD" ? "ETH / USD" : "BTC / USD · passive benchmark"}</strong><p>${q ? `${eth40Money(q.bid)} bid · ${eth40Money(q.ask)} ask` : "No verified quote at capture"}</p><small>${q ? `Age at capture: ${eth40Number(q.ageAtCaptureMs, 0)} ms · ${eth40Utc(s.capturedMarkets.observedAtMs)}` : "Quote age unavailable"}${f.healthy ? "" : " · observation stale or unavailable"}</small></article>`;
  }).join("");
}
function renderEth40Receipts() {
  const node = eth40Node("eth40-receipts");
  if (eth40View.receiptError || !eth40View.receipts) {
    node.innerHTML = '<p class="spot-empty">The paper fill ledger is unavailable.</p>'; return;
  }
  const section = (id, label) => {
    const record = eth40View.receipts[id], receipts = record?.account?.receipts;
    if (!Array.isArray(receipts) || receipts.some(fill => !fill || typeof fill !== "object")) return `<p class="spot-empty">${label} fill ledger unavailable.</p>`;
    if (!receipts.length) return `<p class="spot-empty">No ${label} paper fills recorded yet.</p>`;
    const recent = [...receipts].sort((a, b) => b.timestampMs - a.timestampMs).slice(0, 12);
    return `<div class="eth40-table-wrap"><table class="eth40-table"><thead><tr><th>Recorded time (UTC)</th><th>Action</th><th>Quantity</th><th>Fill price</th><th>Fee</th></tr></thead><tbody>${recent.map(fill => `<tr><td>${eth40Utc(fill.timestampMs)}</td><td>${eth40Escape(fill.side === "buy" ? "Buy" : fill.side === "sell" ? "Sell" : fill.side)}</td><td>${eth40Number(fill.quantity, 8)}</td><td>${eth40Money(fill.price)}</td><td>${eth40Money(eth40Finite(fill.quantity) && eth40Finite(fill.price) && eth40Finite(fill.feeBps) ? fill.quantity * fill.price * fill.feeBps / 10_000 : null)}</td></tr>`).join("")}</tbody></table></div><p class="spot-ledger-note">Latest ${recent.length} of ${receipts.length} ${label} paper fills.</p>`;
  };
  node.innerHTML = `${section("eth40", "ETH40")}<details class="eth40-details"><summary>Separate passive benchmark fills</summary><h4>Passive ETH</h4>${section("passiveEth", "passive ETH")}<h4>Passive BTC</h4>${section("passiveBtc", "passive BTC")}</details>`;
}
async function eth40Get(path) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 4_500);
  try {
    const response = await fetch(path, { method: "GET", cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("ETH40 data unavailable");
    return await response.json();
  } finally { clearTimeout(timeout); }
}
async function refreshEth40() {
  if (!eth40Selected() || eth40View.polling || performance.now() - eth40View.lastPollAt < ETH40_POLL_MS) return;
  eth40View.polling = true; eth40View.lastPollAt = performance.now();
  try {
    const s = await eth40Get("/api/eth40/status");
    if (!s || s.available !== true || typeof s.collectorHealthy !== "boolean" || s.liveTradingEnabled !== false
      || !eth40Finite(s.dashboardFetchedAtMs) || s.dashboardFetchedAtMs <= 0
      || !Number.isSafeInteger(s.sequence) || s.sequence < 1
      || !Array.isArray(s.accounts) || s.accounts.some(a => !a || typeof a !== "object")
      || !Array.isArray(s.lastDecisions) || s.lastDecisions.some(d => !d || typeof d !== "object")) throw new Error("Invalid ETH40 status");
    if (eth40View.snapshot && (s.sequence < eth40View.snapshot.sequence
      || s.recordedAtMs < eth40View.snapshot.recordedAtMs)) throw new Error("ETH40 observation moved backwards");
    // Cached responses cannot roll the clock backwards or renew an old observation.
    eth40View.referenceAtMs = Math.max(s.dashboardFetchedAtMs, eth40Now() ?? s.dashboardFetchedAtMs);
    eth40View.receivedAt = performance.now(); eth40View.snapshot = s; eth40View.error = null;
    observeEth40Commit(s);
    renderEth40();
    if (eth40View.receiptSequence !== s.sequence) {
      try {
        const receipts = await eth40Get("/api/eth40/receipts");
        if (!receipts || typeof receipts !== "object" || receipts.available === false) throw new Error("Invalid fill ledger");
        eth40View.receipts = receipts; eth40View.receiptError = false; eth40View.receiptSequence = s.sequence;
      } catch { eth40View.receipts = null; eth40View.receiptError = true; }
      renderEth40Receipts();
    }
  } catch {
    eth40View.error = "ETH40 data unavailable"; eth40View.receipts = null; eth40View.receiptError = true;
    eth40View.receiptSequence = null; renderEth40(); renderEth40Receipts();
  } finally { eth40View.polling = false; }
}
function bootstrapEth40() {
  if (!eth40Selected()) return;
  renderEth40(); void refreshEth40();
  setInterval(() => { void refreshEth40(); }, ETH40_POLL_MS);
  setInterval(renderEth40, 1_000);
}
bootstrapEth40();
