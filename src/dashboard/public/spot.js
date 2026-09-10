// The spot account has its own order ledger and capital. Never combine it with futures.
const spotView = { snapshot: null, receivedAt: null, referenceAtMs: null, error: null, polling: false, lastPollAt: -Infinity, observations: [], orderHistory: new Map(), orderHistoryAccount: null };
const SPOT_POLL_MS = 5_000;
const SPOT_STALE_MS = 600_000;
const SPOT_WEEK_MS = 604_800_000;
const spotSelected = () => !["eth40", "futures"].includes(new URLSearchParams(location.search).get("view"));
const spotNode = id => document.getElementById(id);
const spotEscape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const spotFinite = value => typeof value === "number" && Number.isFinite(value);
const spotNumber = (value, digits = 2) => spotFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—";
const spotMoney = value => spotFinite(value) ? value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
const spotSignedMoney = value => spotFinite(value) ? `${value < 0 ? "−" : "+"}${spotMoney(Math.abs(value))}` : "—";
const spotPnlClass = value => spotFinite(value) ? value > 0 ? "positive" : value < 0 ? "negative" : "" : "";
const spotUtc = value => spotFinite(value) && value > 0 && value <= 8_640_000_000_000_000 ? `${new Date(value).toISOString().slice(0, 19).replace("T", " ")} UTC` : "Unknown";
const spotHuman = value => String(value ?? "Unknown").toLowerCase().replaceAll("_", " ");
const spotNow = () => spotView.referenceAtMs === null ? Date.now() : spotView.referenceAtMs + Math.max(0, performance.now() - spotView.receivedAt);
const spotAgeMs = timestamp => {
  if (!spotFinite(timestamp) || timestamp <= 0 || spotNow() - timestamp < -5_000) return null;
  return Math.max(0, spotNow() - timestamp);
};
const spotElapsed = milliseconds => {
  if (!spotFinite(milliseconds) || milliseconds < 0) return "Unknown";
  const seconds = Math.floor(milliseconds / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m ${seconds % 60}s` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
};
const spotAgeLabel = timestamp => { const age = spotAgeMs(timestamp); return age === null ? "Unknown" : `${spotElapsed(age)} ago`; };
const spotIntervalMs = snapshot => spotFinite(snapshot?.strategy?.cycleIntervalMs) && snapshot.strategy.cycleIntervalMs > 0 ? snapshot.strategy.cycleIntervalMs : null;
const spotEntrySchedule = snapshot => {
  if (!snapshot?.state) return "unknown";
  const schedule = snapshot?.strategy?.entrySchedule, windowMs = snapshot?.strategy?.entryWindowMs;
  if (schedule === "CONTINUOUS_EACH_CYCLE" && windowMs === null) return "continuous";
  if (schedule === undefined && (windowMs === undefined || windowMs === 3_600_000)) return "weekly";
  return "unknown";
};

function spotEntryPolicy(snapshot) {
  const schedule = spotEntrySchedule(snapshot);
  if (schedule === "continuous") {
    const interval = spotIntervalMs(snapshot);
    const cadence = interval === null ? "Cadence unknown" : interval % 60_000 === 0
      ? `Every ${spotNumber(interval / 60_000, 0)} ${interval === 60_000 ? "minute" : "minutes"}` : `Every ${spotElapsed(interval)}`;
    return { schedule, label: "Entry evaluation", value: `${cadence}, throughout the week`,
      detail: "Uses the delayed, completed-week trend. Entry still requires a qualifying signal, fresh depth, cash, cost, and risk checks. One filled entry per strategy week; no additional buys. Exits are checked each cycle.",
      note: "Entry conditions are evaluated throughout the week, while holding cash or BTC." };
  }
  if (schedule === "weekly") {
    const window = spotNextWindow(spotNow());
    return { schedule, label: window.open ? "Current entry window" : "Next entry window", value: `${spotUtc(window.startMs).slice(0, 10)} · 00:00–01:00 UTC`,
      detail: "Thursdays only. Entry still requires a qualifying signal, fresh depth, and risk checks. Exits are checked each cycle.",
      note: "Evaluations continue while the entry window is closed." };
  }
  return { schedule, label: "Entry evaluation", value: "Schedule unconfirmed", detail: "The service has not supplied a recognized entry schedule.", note: "Recorded evaluations and service responses are shown independently." };
}

function spotCurrentDecisionReason(snapshot) {
  const reason = snapshot?.state?.lastDecision?.reason;
  return spotEntrySchedule(snapshot) === "continuous" && reason === "NEXT_WEEK_ENTRY_WINDOW"
    ? "The previous decision used the weekly entry window. Entries are now evaluated throughout the week."
    : spotReason(reason);
}

function observeSpotEvaluation(snapshot) {
  const state = snapshot.state;
  if (!Number.isSafeInteger(state.cycles) || state.cycles <= 0 || spotAgeMs(state.lastCycleMs) === null
    || !state.lastDecision || state.lastDecision.timestampMs !== state.lastCycleMs) return;
  const key = `${state.startedAtMs}:${state.cycles}`;
  const previous = spotView.observations.find(observation => observation.key === key);
  // An order may settle after its cycle was recorded. Update that observation,
  // without presenting settlement or a repeated poll as a new evaluation.
  if (previous) { if (state.lastCycleMs >= previous.atMs) { previous.atMs = state.lastCycleMs; previous.reason = state.lastDecision.reason; previous.action = state.lastDecision.action; } return; }
  spotView.observations.unshift({ key, cycles: state.cycles, atMs: state.lastCycleMs, reason: state.lastDecision.reason, action: state.lastDecision.action });
  spotView.observations = spotView.observations.slice(0, 3);
}

function spotLivenessCard(id, label, value, detail, tone = "unknown") {
  return `<article id="spot-live-${id}" class="spot-liveness-card ${tone}"><span class="spot-label">${spotEscape(label)}</span><strong>${spotEscape(value)}</strong><p>${spotEscape(detail)}</p></article>`;
}

function renderSpotLiveness() {
  const s = spotView.snapshot, state = s?.state, fresh = spotFreshness();
  const interval = spotIntervalMs(s), cycleAge = spotAgeMs(state?.lastCycleMs), successAge = spotAgeMs(s?.lastSuccessMs);
  const upstreamAge = spotAgeMs(s?.upstreamFetchedAtMs);
  const responseRecent = !!s && !spotView.error && upstreamAge !== null && upstreamAge < 15_000
    && spotView.receivedAt !== null && performance.now() - spotView.receivedAt < 15_000;
  const reliable = responseRecent && (fresh.kind === "healthy" || fresh.kind === "halted");
  const countKnown = Number.isSafeInteger(state?.cycles) && state.cycles >= 0;
  const hasCycle = countKnown && state.cycles > 0 && cycleAge !== null;
  const cycleStale = hasCycle && cycleAge >= (interval === null ? SPOT_STALE_MS : 2 * interval);
  const orders = Array.isArray(state?.orders) ? state.orders : null;
  const pending = orders?.filter(order => ["SUBMITTED", "ACCEPTED"].includes(order?.status)).length;
  const terminal = orders?.filter(order => ["FILLED", "CANCELED", "REJECTED"].includes(order?.status)).length;
  const unknownOrders = orders ? orders.length - pending - terminal : null;
  let serviceValue = !s && !spotView.error ? "Connecting" : spotView.error ? "Unavailable" : responseRecent ? "Responding" : upstreamAge === null ? "Response time unknown" : "Last response stale";
  let serviceDetail = s ? `Last upstream response ${spotAgeLabel(s.upstreamFetchedAtMs)}. Dashboard checks every 5s.` : "Waiting for a response from the spot service.";
  if (spotView.error) serviceDetail = `${spotView.error}${s ? ` Last upstream response ${spotAgeLabel(s.upstreamFetchedAtMs)}.` : ""}`;
  const evaluationValue = countKnown ? `${spotNumber(state.cycles, 0)} recorded` : "Unknown";
  const evaluationDetail = hasCycle ? `${cycleStale ? "No recent recorded evaluation. " : ""}Last evaluation ${spotAgeLabel(state.lastCycleMs)}${!responseRecent ? " · last known state" : ""}.`
    : countKnown && state.cycles === 0 ? "No recorded evaluations yet." : "Evaluation time is unavailable.";
  let nextValue = "Unknown", nextDetail = "Waiting for evaluation timing and cadence.";
  if (hasCycle && interval !== null) {
    if (!reliable || cycleStale) { nextValue = "Estimate unavailable"; nextDetail = "Data is unavailable or stale; waiting for a new recorded evaluation."; }
    else if (pending > 0) { nextValue = "Awaiting order settlement"; nextDetail = "A paper order is pending; the next evaluation time is not confirmed."; }
    else if (cycleAge >= interval) { nextValue = "Due · awaiting update"; nextDetail = "No newer evaluation recorded yet. Work and network delays can extend the interval."; }
    else { nextValue = `About ${spotElapsed(interval - cycleAge)}`; nextDetail = `Approximate ${spotElapsed(interval)} cadence. The timer waits after work completes.`; }
  }
  const successValue = !s || !spotFinite(s.lastSuccessMs) ? "Unknown" : s.lastSuccessMs === 0 ? "No successful check" : successAge === null ? "Time unconfirmed" : `${spotElapsed(successAge)} ago`;
  const successDetail = s?.lastError ? `Last reported error: ${s.lastError}` : !reliable ? "Current market-data check status is unconfirmed. This is not a live quote heartbeat." : "Last market cycle with valid valuation and no error; not a live quote heartbeat.";
  const brokerValue = orders ? `${pending} pending · ${terminal} terminal` : "Ledger unavailable";
  const brokerDetail = !orders ? "No submitted-order ledger received." : `${!responseRecent ? "Last known counts and configuration. " : ""}${s.orderSubmissionEnabled === true ? "Paper submissions enabled" : s.orderSubmissionEnabled === false ? "Paper submissions disabled" : "Submission status unknown"}${unknownOrders ? ` · ${unknownOrders} unknown statuses` : !orders.length ? " · no orders submitted yet" : ". Terminal includes fills, cancels and rejections"}.`;
  const reason = state?.lastDecision?.reason;
  let gateValue = "Unconfirmed", gateDetail = "Waiting for current strategy and risk status.", gateTone = "unknown";
  if (state?.halted === true) { gateValue = "Risk halt"; gateDetail = "Account drawdown limit: new entries are halted."; gateTone = "bad"; }
  else if (!reliable || cycleStale) { gateValue = "Data unconfirmed"; gateDetail = s?.lastError ? `New-entry readiness is unconfirmed: ${s.lastError}` : "Current data and entry readiness cannot be confirmed."; gateTone = "warning"; }
  else if (s.orderSubmissionEnabled !== true) { gateValue = s.orderSubmissionEnabled === false ? "Submissions disabled" : "Submission status unknown"; gateDetail = "A qualifying signal alone cannot submit an order."; gateTone = "warning"; }
  else if (reason) {
    gateValue = reason === "NEXT_WEEK_ENTRY_WINDOW" ? spotEntrySchedule(s) === "continuous" ? "Continuous evaluation" : "Waiting for entry window" : reason === "HOLD_SPOT_NO_ADDITIONS" ? "Holding BTC"
      : reason === "TREND_EXIT" || reason === "HOLD_CASH" ? "Holding cash" : `Last decision: ${spotHuman(state.lastDecision.action)}`;
    gateDetail = spotCurrentDecisionReason(s); gateTone = "neutral";
  }
  const html = [
    spotLivenessCard("service", "Spot API response", serviceValue, serviceDetail, responseRecent ? "good" : spotView.error ? "bad" : "warning"),
    spotLivenessCard("evaluations", "Recorded evaluations", evaluationValue, evaluationDetail, reliable && hasCycle && !cycleStale ? "good" : "warning"),
    spotLivenessCard("next", "Next evaluation · approximate", nextValue, nextDetail, reliable && hasCycle && !cycleStale ? "neutral" : "warning"),
    spotLivenessCard("market", "Last successful market check", successValue, successDetail, reliable && successAge !== null ? "good" : "warning"),
    spotLivenessCard("broker", "Paper order broker", brokerValue, brokerDetail, reliable && orders && !unknownOrders && s.orderSubmissionEnabled === true ? "neutral" : "warning"),
    spotLivenessCard("gate", "Entry / risk gate", gateValue, gateDetail, gateTone),
  ].join("");
  const grid = spotNode("spot-liveness-grid"); if (grid.innerHTML !== html) grid.innerHTML = html;
  const activity = spotView.observations.length ? spotView.observations.map(observation => `<li><strong>Evaluation ${spotNumber(observation.cycles, 0)} · ${spotEscape(String(observation.action ?? "unknown").toUpperCase())}</strong><time>${spotUtc(observation.atMs)}</time><span>${spotEscape(spotReason(observation.reason))}</span></li>`).join("") : "<li>No evaluations observed yet.</li>";
  const list = spotNode("spot-observations"); if (list.innerHTML !== activity) list.innerHTML = activity;
}

function spotNextWindow(nowMs) {
  const week = Math.floor(nowMs / SPOT_WEEK_MS) * SPOT_WEEK_MS;
  const open = nowMs < week + 3_600_000;
  const startMs = open ? week : week + SPOT_WEEK_MS;
  return { open, startMs, endMs: startMs + 3_600_000 };
}

function spotReason(reason) {
  const descriptions = {
    NEXT_WEEK_ENTRY_WINDOW: "Waiting for the next weekly entry window.",
    WEEKLY_ENTRY_ALREADY_CONSUMED: "This week's entry has already been used. No additional buys this week.",
    HOLD_SPOT_NO_ADDITIONS: "Holding the existing BTC position; no additional buys.",
    HOLD_CASH: "Holding cash while the weekly signal is checked.",
    WARMUP: "Waiting for enough completed weeks to calculate the trend.",
    TREND_ENTER: "The completed weekly signal favors holding BTC.",
    TREND_EXIT: "The completed weekly signal favors cash.",
    HOLD_BAND: "The weekly price is in the hold band; the prior signal is retained.",
    WEEKLY_TREND_ENTER: "A weekly entry was sent to the paper order broker.",
    WEEKLY_TREND_EXIT: "A weekly exit was sent to the paper order broker.",
    ACCOUNT_DRAWDOWN_HALT: "The account drawdown limit has halted new entries.",
    HISTORY_UNAVAILABLE: "Completed weekly history is unavailable; new entries are blocked.",
    HISTORY_UNAVAILABLE_EXIT: "The system is reducing BTC because completed history is unavailable.",
    STALE_OR_FUTURE_BOOK: "A current order book is unavailable; waiting for fresh market data.",
    INVALID_BOOK: "The order book failed validation; waiting for usable market data.",
    MARKED_NOTIONAL_CAP: "The system is reducing the position to its exposure limit.",
    NO_SPOT_ENTRY_CASH: "Available spot cash does not support a new buy.",
  };
  const parts = String(reason ?? "").split(":");
  const base = descriptions[parts[0]] ?? (reason ? spotHuman(reason) : "Waiting for the first strategy decision.");
  return parts.length > 1 && descriptions[parts[0]] ? `${base} Broker result: ${spotHuman(parts.slice(1).join(": "))}.` : base;
}

function spotFreshness() {
  if (!spotView.snapshot) return { kind: "unavailable", message: spotView.error ?? "Connecting to the spot order service…" };
  const s = spotView.snapshot;
  const age = spotNow() - s.lastSuccessMs;
  const receiptAge = performance.now() - spotView.receivedAt;
  if (spotView.error) return { kind: "unavailable", message: `${spotView.error} Showing the last known values; they are not current.` };
  const upstreamAge = spotAgeMs(s.upstreamFetchedAtMs);
  if (upstreamAge === null) return { kind: "stale", message: "Spot service response time is unknown. Current order readiness is unconfirmed." };
  if (!spotFinite(s.lastSuccessMs) || s.lastSuccessMs <= 0) return { kind: "stale", message: "No successful spot market cycle recorded. Current valuation is unavailable." };
  if (age < -5_000 || age >= 2 * (spotIntervalMs(s) ?? SPOT_STALE_MS / 2) || receiptAge >= 15_000 || upstreamAge >= 15_000) return { kind: "stale", message: "Spot data is stale. Values below are last known; order readiness is unconfirmed." };
  if (s.mode !== "RESEARCH_PAPER" || s.liveTradingEnabled !== false) return { kind: "unavailable", message: "Unexpected execution mode. Paper order readiness is unconfirmed." };
  if (!s.healthy || s.lastError) return { kind: "stale", message: `Spot service needs attention${s.lastError ? `: ${s.lastError}` : "."} Values are from the last recorded cycle.` };
  if (s.state.halted) return { kind: "halted", message: "Spot service is connected. New entries are halted by the account risk limit." };
  const interval = spotIntervalMs(s);
  return { kind: "healthy", message: `Spot service connected · market cycle ${Math.max(0, Math.floor(age / 60_000))} min ago · ${interval === null ? "cadence unavailable" : `checks about every ${spotElapsed(interval)}`}` };
}

function renderSpotConnection() {
  const fresh = spotFreshness(), s = spotView.snapshot;
  const status = spotNode("spot-service-status");
  status.className = `spot-service-status ${fresh.kind}`;
  if (status.textContent !== fresh.message) status.textContent = fresh.message;
  spotNode("spot-content").classList.toggle("spot-old-values", fresh.kind !== "healthy" && fresh.kind !== "halted");
  const orderMode = spotNode("spot-order-mode");
  const known = s && typeof s.orderSubmissionEnabled === "boolean" && !spotView.error && fresh.kind !== "unavailable" && fresh.kind !== "stale";
  orderMode.textContent = known ? s.orderSubmissionEnabled ? "Paper orders enabled" : "Paper orders disabled" : "Order readiness unknown";
  orderMode.className = `spot-badge ${known && s.orderSubmissionEnabled ? "" : "neutral"}`;
  const exchange = spotNode("spot-exchange-mode");
  exchange.textContent = !s ? "Exchange status unknown" : s.liveTradingEnabled === false ? "Live exchange orders disabled" : "Unexpected exchange mode";
  exchange.className = `spot-badge ${s?.liveTradingEnabled === true ? "warning" : "neutral"}`;
  const header = spotNode("connection-status");
  const connecting = !s && !spotView.error;
  header.className = `connection ${fresh.kind === "healthy" ? "live" : connecting || fresh.kind !== "unavailable" ? "connecting" : "offline"}`;
  header.innerHTML = `<i></i>${connecting ? "Spot connecting" : fresh.kind === "healthy" ? "Spot connected" : fresh.kind === "halted" ? "Spot entries halted" : fresh.kind === "stale" ? "Spot data stale" : "Spot unavailable"}`;
  spotNode("mode-badge").textContent = s?.mode === "RESEARCH_PAPER" ? "SPOT · PAPER" : connecting ? "SPOT · CONNECTING" : "SPOT · UNKNOWN";
  spotNode("clock").textContent = new Date().toLocaleTimeString([], { hour12: false });
  spotNode("footer-detail").textContent = "BTC spot · Paper account · Recorded fills and current valuation";
  const policyNote = spotNode("spot-liveness-note"), note = spotEntryPolicy(s).note;
  if (policyNote.textContent !== note) policyNote.textContent = note;
  renderSpotLiveness();
  updateSpotPositionAges();
}

function spotMetric(label, value, detail = "", className = "") {
  return `<div class="spot-metric"><dt>${spotEscape(label)}</dt><dd class="${className}">${value}</dd>${detail ? `<small>${spotEscape(detail)}</small>` : ""}</div>`;
}

const spotPositionDomId = (kind, orderId) => `spot-position-${kind}-${encodeURIComponent(orderId)}`;
function spotHistoryState(orderId) {
  if (!spotView.orderHistory.has(orderId)) spotView.orderHistory.set(orderId, { expanded: false, latest: new Map(), older: new Map(), nextCursor: null, loadedEarlier: false, loading: false, error: null, revision: 0 });
  return spotView.orderHistory.get(orderId);
}
function spotActivity(orderId) {
  const s = spotView.snapshot, feed = s?.orderActivity;
  if (feed?.available !== true || feed.sourceCycle !== s?.state?.cycles || feed.sourceTimestampMs !== s?.state?.lastCycleMs) return null;
  const activity = feed.orders?.[orderId];
  return activity?.orderId === orderId && activity.direction === "LONG" && ["OPEN_LONG", "CLOSE_LONG"].includes(activity.intent) && Array.isArray(activity.events) ? activity : null;
}
function spotValidEvents(events) {
  return events.filter(event => event && typeof event.id === "string" && event.id.length > 0 && spotFinite(event.timestampMs) && event.timestampMs > 0);
}
function mergeSpotOrderActivity(snapshot) {
  if (spotView.orderHistoryAccount !== snapshot.state.startedAtMs) {
    spotView.orderHistory.clear(); spotView.orderHistoryAccount = snapshot.state.startedAtMs;
  }
  const orderIds = new Set([...(snapshot.state.orders ?? []).map(order => order.orderId).filter(id => typeof id === "string"), ...spotView.orderHistory.keys()]);
  for (const orderId of orderIds) {
    const history = spotHistoryState(orderId), activity = spotActivity(orderId);
    if (!activity) {
      history.latest.clear(); history.older.clear(); history.nextCursor = null; history.loadedEarlier = false;
      history.loading = false; history.error = null; history.revision += 1;
      continue;
    }
    const latest = new Map(spotValidEvents(activity.events).map(event => [event.id, event]));
    const gap = history.latest.size > 0 && latest.size > 0 && ![...latest.keys()].some(id => history.latest.has(id));
    if (history.loadedEarlier) for (const [id, event] of history.latest) if (!latest.has(id)) history.older.set(id, event);
    history.latest = latest;
    if (!history.loadedEarlier || gap) history.nextCursor = typeof activity.nextCursor === "string" ? activity.nextCursor : null;
  }
}
function spotPositionEvents(orderId) {
  const history = spotHistoryState(orderId), unique = new Map(history.latest);
  for (const [id, event] of history.older) if (!unique.has(id)) unique.set(id, event);
  return [...unique.values()].sort((a, b) => b.timestampMs - a.timestampMs);
}
function spotHoldingDuration(activity) {
  if (!spotFinite(activity?.openedAtMs) || activity.openedAtMs <= 0) return "Unknown";
  const end = activity.positionStatus === "CLOSED" ? activity.closedAtMs : spotNow();
  return spotFinite(end) && end >= activity.openedAtMs ? spotElapsed(end - activity.openedAtMs) : "Unknown";
}
function spotPositionFreshness(activity) {
  const fresh = spotFreshness();
  if (!["healthy", "halted"].includes(fresh.kind)) return { stale: true, text: "Position data stale or unavailable; showing last recorded values." };
  if (activity.positionStatus !== "CLOSED" && (!spotFinite(activity.totalNetUsd) || !spotFinite(activity.unrealizedNetUsd) || spotAgeMs(activity.markAtMs) === null))
    return { stale: true, text: "Recorded valuation unavailable; position history remains visible." };
  if (activity.positionStatus !== "CLOSED" && spotAgeMs(activity.markAtMs) >= 2 * (spotIntervalMs(spotView.snapshot) ?? 300_000))
    return { stale: true, text: "Recorded valuation is stale; showing last recorded values." };
  return { stale: false, text: activity.positionStatus === "CLOSED" ? "Closed position · recorded final result." : "Recorded cycle valuation · not a live price." };
}
function updateSpotPositionAges() {
  for (const node of document.querySelectorAll?.("[data-spot-position-mark-age]") ?? []) node.textContent = spotAgeLabel(Number(node.dataset.spotPositionMarkAge));
  for (const node of document.querySelectorAll?.("[data-spot-position-duration]") ?? []) {
    const activity = spotActivity(node.dataset.spotPositionDuration);
    node.textContent = activity ? spotHoldingDuration(activity) : "Unknown";
  }
  for (const node of document.querySelectorAll?.("[data-spot-position-freshness]") ?? []) {
    const activity = spotActivity(node.dataset.spotPositionFreshness), fresh = activity ? spotPositionFreshness(activity) : { stale: true, text: "Position history unavailable; order lifecycle remains recorded." };
    node.textContent = fresh.text; node.classList.toggle("warning", fresh.stale);
    node.closest(".spot-position-summary")?.classList.toggle("spot-position-stale", fresh.stale);
  }
}
function spotPositionEventHtml(event) {
  const values = [event.orderId ? `Order ${event.orderId}` : null,
    Number.isSafeInteger(event.cycle) ? `Evaluation ${event.cycle}` : null,
    event.reason ? spotReason(event.reason) : null,
    spotFinite(event.quantity) ? `${spotNumber(event.quantity, 8)} BTC` : null,
    spotFinite(event.markPrice) ? `Recorded bid ${spotMoney(event.markPrice)}` : null,
    spotFinite(event.totalNetUsd) ? `Net ${spotSignedMoney(event.totalNetUsd)}` : null,
    spotFinite(event.realizedNetUsd) ? `Realized ${spotSignedMoney(event.realizedNetUsd)}` : null,
    spotFinite(event.unrealizedNetUsd) ? `Unrealized ${spotSignedMoney(event.unrealizedNetUsd)}` : null].filter(Boolean);
  return `<li data-spot-position-event="${spotEscape(event.id)}"><b>${spotEscape(spotHuman(event.type))}</b><time>${spotUtc(event.timestampMs)}</time>${values.length ? `<span>${values.map(spotEscape).join(" · ")}</span>` : ""}</li>`;
}
function spotPositionHtml(orderId, order) {
  const activity = spotActivity(orderId);
  if (!activity) {
    const s = spotView.snapshot, feed = s?.orderActivity;
    if (feed?.error === "SPOT_ACTIVITY_HISTORY_LOADING") return '<p class="spot-position-unavailable">Loading position history. The recorded order lifecycle remains visible below.</p>';
    if (feed?.available === true && feed.sourceCycle === s?.state?.cycles && feed.sourceTimestampMs === s?.state?.lastCycleMs
      && order?.request?.side === "buy" && order.filledQuantity === 0)
      return '<p class="spot-position-empty">No position opened yet. This entry order has no recorded fill.</p>';
    return '<p class="spot-position-unavailable">Position history unavailable. The recorded order lifecycle is shown below; a filled order alone does not establish whether its position is still open.</p>';
  }
  const history = spotHistoryState(orderId), events = spotPositionEvents(orderId), fresh = spotPositionFreshness(activity);
  const positionStatus = ["OPEN", "EXIT_PENDING", "PARTIALLY_EXITED", "CLOSED"].includes(activity.positionStatus) ? activity.positionStatus.replaceAll("_", " ") : "UNKNOWN";
  const latestReason = events.find(event => typeof event.reason === "string" && event.reason.length > 0)?.reason;
  const interval = spotIntervalMs(spotView.snapshot);
  return `<section class="spot-position-summary ${fresh.stale ? "spot-position-stale" : ""}" data-spot-position-card="${spotEscape(orderId)}">
    <div class="spot-position-heading"><strong>LONG position</strong><span class="spot-position-status">${positionStatus}</span></div>
    ${activity.intent === "CLOSE_LONG" ? `<p class="spot-position-reason">Entry order: ${spotEscape(activity.entryOrderId)}</p>` : ""}
    <p class="spot-position-freshness ${fresh.stale ? "warning" : ""}" data-spot-position-freshness="${spotEscape(orderId)}">${fresh.text}</p>
    <dl class="spot-position-metrics">
      ${spotMetric("Position net P&L", spotSignedMoney(activity.totalNetUsd), "Recorded realized + unrealized", spotPnlClass(activity.totalNetUsd))}
      ${spotMetric("Realized net P&L", spotSignedMoney(activity.realizedNetUsd), "After recorded fill fees", spotPnlClass(activity.realizedNetUsd))}
      ${spotMetric("Unrealized net P&L", spotSignedMoney(activity.unrealizedNetUsd), "Includes estimated exit fee", spotPnlClass(activity.unrealizedNetUsd))}
      ${spotMetric("Remaining BTC", spotNumber(activity.remainingQuantity, 8))}
      ${spotMetric("Remaining entry cost", spotMoney(activity.remainingEntryCostUsd), "Includes entry fees")}
      ${spotMetric("Recorded bid", spotMoney(activity.markPrice), `${interval === null ? "Cycle" : spotElapsed(interval) + " cycle"} valuation · not live`)}
    </dl>
    <div class="spot-position-times"><span>Valuation age <b data-spot-position-mark-age="${spotFinite(activity.markAtMs) ? activity.markAtMs : ""}">${spotAgeLabel(activity.markAtMs)}</b></span><span>${activity.positionStatus === "CLOSED" ? "Held for" : "Holding duration"} <b data-spot-position-duration="${spotEscape(orderId)}">${spotHoldingDuration(activity)}</b></span></div>
    <p class="spot-position-reason">${latestReason ? spotEscape(spotReason(latestReason)) : "No recorded hold or exit reason available."}</p>
    <details id="${spotPositionDomId("history", orderId)}" class="spot-position-history" data-spot-position-history="${spotEscape(orderId)}" ${history.expanded ? "open" : ""}>
      <summary id="${spotPositionDomId("toggle", orderId)}">Position activity <span>${events.length} shown${Number.isSafeInteger(activity.totalEvents) ? ` / ${activity.totalEvents} recorded` : ""}</span></summary>
      <p>Durable order and strategy records, newest first. Refreshing the dashboard creates no events.</p>
      <ol class="spot-order-events spot-position-events">${events.length ? events.map(spotPositionEventHtml).join("") : "<li>No position events available.</li>"}</ol>
      ${history.error ? `<p class="spot-position-page-error" role="status">${spotEscape(history.error)}</p>` : ""}
      ${history.nextCursor ? `<button id="${spotPositionDomId("earlier", orderId)}" type="button" class="text-button spot-position-earlier" data-spot-position-earlier="${spotEscape(orderId)}" ${history.loading ? "disabled" : ""}>${history.loading ? "Loading earlier events…" : "Load earlier events"}</button>` : '<p class="spot-position-end">All available events shown.</p>'}
    </details>
  </section>`;
}
function renderSpotOrderGrid() {
  const orders = spotView.snapshot?.state?.orders;
  if (!Array.isArray(orders) || !orders.length) return;
  const focusId = document.activeElement?.id;
  spotNode("spot-orders-grid").innerHTML = [...orders].sort((a, b) => (b?.request?.createdAtMs ?? 0) - (a?.request?.createdAtMs ?? 0)).slice(0, 20).map(spotOrderHtml).join("");
  if (focusId?.startsWith("spot-position-")) spotNode(focusId)?.focus?.();
}
async function loadEarlierSpotActivity(orderId) {
  if (!spotSelected() || !spotActivity(orderId)) return;
  const history = spotHistoryState(orderId);
  if (history.loading || !history.nextCursor) return;
  const cursor = history.nextCursor, revision = history.revision, account = spotView.orderHistoryAccount;
  history.loading = true; history.error = null; history.expanded = true; renderSpotOrderGrid();
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 4_500);
  try {
    const query = new URLSearchParams({ orderId, before: cursor });
    const response = await fetch(`/api/spot-order-activity?${query}`, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("Earlier position history unavailable. Try again.");
    const page = await response.json(), activity = page?.activity;
    if (page?.available !== true || activity?.orderId !== orderId || !Array.isArray(activity.events)
      || activity.nextCursor !== null && typeof activity.nextCursor !== "string") throw new Error("Earlier position history unavailable. Try again.");
    if (account !== spotView.orderHistoryAccount || history !== spotView.orderHistory.get(orderId) || history.revision !== revision || !spotActivity(orderId)) return;
    for (const event of spotValidEvents(activity.events)) history.older.set(event.id, event);
    if (activity.nextCursor === cursor) throw new Error("History cursor did not advance. Try again.");
    history.nextCursor = activity.nextCursor; history.loadedEarlier = true;
  } catch (error) { if (history.revision === revision) history.error = error?.message === "History cursor did not advance. Try again." ? error.message : "Earlier position history unavailable. Try again."; }
  finally { clearTimeout(timeout); history.loading = false; renderSpotOrderGrid(); }
}

function spotOrderHtml(order) {
  const r = order?.request ?? {}, events = Array.isArray(order?.events) ? order.events : [];
  const status = String(order?.status ?? "UNKNOWN");
  const statusClass = ["SUBMITTED", "ACCEPTED", "FILLED", "CANCELED", "REJECTED"].includes(status) ? status : "UNKNOWN";
  const partial = status === "CANCELED" && spotFinite(order?.filledQuantity) && order.filledQuantity > 0;
  const result = order?.rejectionReason || order?.cancellationReason;
  const intent = r.side === "buy" ? "OPEN LONG" : r.side === "sell" ? "CLOSE LONG" : "UNKNOWN INTENT";
  return `<article class="spot-order order-card" data-spot-position-order="${spotEscape(order?.orderId ?? "")}">
    <div class="order-head"><div><strong>${intent} · BTC / USD</strong><div class="order-id">${spotEscape(order?.orderId ?? r.clientOrderId ?? "Unknown order")}</div></div><span class="order-status ${statusClass}">${partial ? "PARTIAL FILL · CANCELED" : spotEscape(status)}</span></div>
    <p class="spot-order-time">Submitted ${spotUtc(r.createdAtMs)} · ${spotEscape(r.timeInForce ?? "Unknown time in force")}${r.reduceOnly ? " · Reduce only" : ""}</p>
    <dl class="spot-order-metrics">
      ${spotMetric("Requested BTC", spotNumber(r.quantity, 8))}${spotMetric("Limit price", spotMoney(r.limitPrice))}
      ${spotMetric("Filled BTC", spotNumber(order?.filledQuantity, 8))}${spotMetric("Average fill", spotMoney(order?.averageFillPrice))}${spotMetric("Paid fee", spotMoney(order?.feeUsd))}
    </dl>
    ${result ? `<p class="spot-order-result">${spotEscape(spotHuman(result))}${partial ? ". The filled quantity is booked; the remaining quantity was canceled." : ""}</p>` : ""}
    ${spotPositionHtml(order?.orderId, order)}
    <ol class="spot-order-events" aria-label="Original order lifecycle">${events.length ? events.map(event => `<li><b>${spotEscape(spotHuman(event?.type))}</b><time>${spotUtc(event?.timestampMs)}</time>${event?.detail ? `<span>${spotEscape(event.detail)}</span>` : ""}</li>`).join("") : "<li>Lifecycle events unavailable.</li>"}</ol>
  </article>`;
}

function renderSpot(snapshot) {
  const focusId = document.activeElement?.id;
  const state = snapshot.state, account = state.account ?? {}, decision = state.lastDecision, mark = decision?.mark;
  const signal = state.lastSignal;
  const orders = Array.isArray(state.orders) ? state.orders : null;
  const receipts = Array.isArray(account.receipts) ? account.receipts : null;
  const policy = spotEntryPolicy(snapshot);
  const signalName = signal?.state === "long" ? "BTC / long" : signal?.state === "cash" ? "Cash" : "Unknown";
  const newest = orders ? [...orders].sort((a, b) => (b?.request?.createdAtMs ?? 0) - (a?.request?.createdAtMs ?? 0)).slice(0, 20) : [];
  spotNode("spot-content").innerHTML = `<div class="spot-decision-row">
    <div class="spot-decision"><span class="spot-label">Latest strategy decision</span><h3>${spotEscape(spotCurrentDecisionReason(snapshot))}</h3><p>${decision ? `${spotEscape(String(decision.action ?? "unknown").toUpperCase())} · ${spotUtc(decision.timestampMs)}` : "No strategy cycle completed yet."}</p></div>
    <div id="spot-entry-schedule" class="spot-window" data-schedule="${policy.schedule}"><span class="spot-label">${spotEscape(policy.label)}</span><strong>${spotEscape(policy.value)}</strong><p>${spotEscape(policy.detail)}</p></div>
  </div>
  <dl class="spot-metrics">
    ${spotMetric("Forward net P&L", spotSignedMoney(mark?.netPnlUsd), "Since spot start · includes estimated exit fee", spotPnlClass(mark?.netPnlUsd))}
    ${spotMetric("Spot equity", spotMoney(mark?.equityUsd), "Cash + BTC at the latest bid")}
    ${spotMetric("Cash", spotMoney(account.cashUsd), "USD · separate paper balance")}
    ${spotMetric("BTC held", spotNumber(account.quantity, 8), "Fully funded position")}
    ${spotMetric("Realized net P&L", spotSignedMoney(account.realizedNetUsd), "Closed quantity · after entry and exit fees", spotPnlClass(account.realizedNetUsd))}
    ${spotMetric("Unrealized net P&L", spotSignedMoney(mark?.unrealizedNetUsd), "Open quantity · includes estimated exit fee", spotPnlClass(mark?.unrealizedNetUsd))}
    ${spotMetric("Fees paid", spotMoney(account.feesUsd), "Recorded paper fills only")}
    ${spotMetric("Paper fills", receipts ? spotNumber(receipts.length, 0) : "—", "Order fills · not completed round trips")}
  </dl>
  ${!mark ? '<p class="spot-mark-unavailable">Current market valuation is unavailable. Equity and unrealized P&amp;L will appear after a successful market cycle.</p>' : ""}
  ${snapshot.evidence?.scope === "PARENT_WEEKLY_STRATEGY" ? '<p id="spot-research-status" class="spot-ledger-note">Historical research covers the parent weekly strategy. Revised entry timing is under paper evaluation; profitability remains unvalidated.</p>' : ""}
  <div class="spot-signal-row"><div><span class="spot-label">Delayed closed-week signal</span><strong>${signalName}</strong><small>${spotEscape(spotReason(signal?.reason))}${policy.schedule === "continuous" ? " Re-evaluated each cycle; completed weekly bars supply the trend." : ""}</small></div><div><span class="spot-label">Weekly close / 40-week mean</span><strong>${spotMoney(signal?.close)} / ${spotMoney(signal?.movingAverage)}</strong><small>Signal week ended ${spotUtc(signal?.lastWeekEndMs)}</small></div><div><span class="spot-label">Fresh data as of</span><strong>${spotUtc(snapshot.lastSuccessMs)}</strong><small>Forward account started ${spotUtc(state.startedAtMs)}</small></div></div>
  <div class="spot-orders-heading"><h3>Spot submitted orders</h3><span class="count-pill">${orders ? `${orders.length} submitted` : "Ledger unavailable"}</span></div>
  <p class="spot-ledger-note">Orders route to the spot paper broker. Fills simulate current market depth; no orders are sent to Kraken. Forward account results exclude historical backtest gains.</p>
  <div id="spot-orders-grid" class="spot-orders">${orders === null ? '<p class="spot-empty">The submitted-order ledger is unavailable.</p>' : !orders.length ? `<p class="spot-empty">No spot orders submitted yet. ${spotEscape(spotCurrentDecisionReason(snapshot))} A signal alone does not mean an order was submitted.</p>` : newest.map(spotOrderHtml).join("")}</div>
  ${orders && orders.length > 20 ? `<p class="spot-ledger-note">Showing the latest 20 of ${orders.length} submitted orders.</p>` : ""}`;
  renderSpotConnection();
  if (focusId?.startsWith("spot-position-")) spotNode(focusId)?.focus?.();
}

async function refreshSpot() {
  if (!spotSelected()) return;
  const now = performance.now();
  if (spotView.polling || now - spotView.lastPollAt < SPOT_POLL_MS) return;
  spotView.polling = true; spotView.lastPollAt = now;
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 4_500);
  try {
    const response = await fetch("/api/spot-dashboard", { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error("Spot service unavailable.");
    const snapshot = await response.json();
    if (!snapshot || typeof snapshot !== "object" || !snapshot.state || typeof snapshot.state !== "object"
      || typeof snapshot.healthy !== "boolean" || typeof snapshot.mode !== "string") throw new Error("Spot status response is invalid.");
    spotView.snapshot = snapshot; spotView.receivedAt = performance.now();
    spotView.referenceAtMs = spotFinite(snapshot.generatedAtMs) && snapshot.generatedAtMs > 0 ? snapshot.generatedAtMs : Date.now();
    spotView.error = null;
    observeSpotEvaluation(snapshot);
    mergeSpotOrderActivity(snapshot);
    renderSpot(snapshot);
  } catch (error) {
    spotView.error = error?.message === "Spot status response is invalid." ? error.message : "Spot service unavailable.";
    renderSpotConnection();
  } finally { clearTimeout(timeout); spotView.polling = false; }
}

function bootstrapSpot() {
  if (!spotSelected()) return;
  renderSpotConnection();
  spotNode("spot-content").addEventListener("toggle", event => {
    if (event.target.matches?.("details[data-spot-position-history]") && event.target.isConnected) spotHistoryState(event.target.dataset.spotPositionHistory).expanded = event.target.open;
  }, true);
  spotNode("spot-content").addEventListener("click", event => {
    const button = event.target.closest?.("[data-spot-position-earlier]");
    if (button) { event.preventDefault(); void loadEarlierSpotActivity(button.dataset.spotPositionEarlier); }
  });
  void refreshSpot();
  setInterval(() => { void refreshSpot(); }, SPOT_POLL_MS);
  setInterval(renderSpotConnection, 1_000);
}

bootstrapSpot();
