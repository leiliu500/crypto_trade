import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const nowMs = 1_800_000_000_000;
const app = await readFile("src/dashboard/public/app.js", "utf8");
const utilities = app.slice(0, app.indexOf("function setConnection"));
const renderer = app.slice(app.indexOf("function renderDistributionMarket"), app.indexOf("function renderPolicyMarket"));
function market() {
  return { symbol: "BTC/USD", bookValid: true, stale: false, mid: 78_000, bestBid: 77_999.5, bestAsk: 78_000.5,
    distributional: { paperEnabled: true, decision: null as Record<string, unknown> | null,
      statistics: { version: "btc-eth-distributional-control-v1", minimumSamples: 48, minimumEffectiveSamples: 32, minimumDays: 7,
        minimumValidationSelections: 20, minimumValidationDays: 7, entryMode: "VALIDATED",
        selectionPolicyVersion: "btc-eth-selected-policy-v2", completePanels: 0, invalidPanels: 0,
        evaluationIntervalMs: 1_000, trainingIntervalMs: 1_860_000,
        markets: ["BTC/USD", "ETH/USD"].map(symbol => ({ symbol, ready: false, reason: "WARMING_30_MINUTES",
          sampleCount: 0, restoredSampleCount: 0, oldestAtMs: null as number | null, latestAtMs: null as number | null,
          coverageMs: 0, remainingMs: 1_800_000, flowCoverageMs: 0, flowRemainingMs: 30_000 })),
        validation: { selections: 0, observedDays: 0, lowerNetBps: null as number | null, ready: false },
        learning: { byAction: [{ symbol: "BTC/USD", samples: 0 }, { symbol: "BTC/USD", samples: 0 }] },
        nextEvaluations: { "BTC/USD": nowMs + 1_000 },
        nextProposals: { "BTC/USD": nowMs + 1_860_000 } } } };
}
function readyMarket() {
  const value = market();
  for (const item of value.distributional.statistics.markets) Object.assign(item, {
    ready: true, reason: "READY", coverageMs: 1_800_000, remainingMs: 0, flowCoverageMs: 30_000, flowRemainingMs: 0,
  });
  return value;
}
function selected(paperReady = false) {
  return { atMs: nowMs, actionId: "long-15m" as string | null, paperReady, reason: "PROSPECTIVE_VALIDATION", entryMode: "VALIDATED",
    estimates: [{ actionId: "long-15m", meanNetBps: 12, scoreBps: 4.5, samples: 80, effectiveSamples: 65.5, observedDays: 8,
      reason: "POSITIVE_DISTRIBUTIONAL_SCORE" },
      { actionId: "short-15m", meanNetBps: -7, scoreBps: -13, samples: 78, effectiveSamples: 64, observedDays: 8,
        reason: "SCORE_BELOW_MINIMUM" }] };
}

test("independent training displays per-horizon cadence and action counts while entry checks remain frequent", () => {
  const value = readyMarket();
  Object.assign(value.distributional.statistics, {
    trainingMode: "INDEPENDENT_HORIZONS", trainingIntervalMs: null,
    trainingIntervals: [{ horizonMs: 300_000, intervalMs: 360_000 },
      { horizonMs: 900_000, intervalMs: 960_000 }, { horizonMs: 1_800_000, intervalMs: 1_860_000 }],
    pendingTrainingActions: 8,
    efficientTraining: { learnedActions: 10, invalidActions: 2,
      byAction: [{ symbol: "BTC/USD", nextOriginAtMs: nowMs + 120_000 }] },
  });
  const html = render(value);
  assert.match(html, /5m 0s outcomes: every 6m 0s · 15m 0s outcomes: every 16m 0s · 30m 0s outcomes: every 31m 0s/);
  assert.match(html, /Fresh quotes · at most once per 1s per symbol/);
  assert.match(html, /Next training collection eligible in 2m 0s, on a fresh quote/);
  assert.match(html, /learned action outcomes 10 · excluded action outcomes 2 · pending actions 8/);
  assert.doesNotMatch(html, /complete research panels|Every 31m|NaN/);
});
function render(value = market(), snapshot: Record<string, unknown> = {}, elapsedMs = 0, clockOffsetMs = 0): string {
  class Clock extends Date { public static override now() { return nowMs + elapsedMs + clockOffsetMs; } }
  return runInNewContext(`${utilities}\n${renderer}\nstate.snapshot=snapshot;state.snapshotReceivedAt=0;renderDistributionMarket(market);`, {
    market: value, Date: Clock, performance: { now: () => elapsedMs },
    snapshot: { mode: "paper", paper: true, generatedAtMs: nowMs, positions: [], ...snapshot },
  }) as string;
}

test("distribution dashboard distinguishes paper permission from zero-data model readiness", () => {
  const value = market(), warmup = render(value);
  assert.match(warmup, /PAPER PERMISSION ENABLED/); assert.match(warmup, /MARKET WARMUP/);
  assert.match(warmup, /Training outcomes per action \(includes restored\)<\/span><strong>0–0/);
  assert.match(warmup, /Selected action<\/span><strong>FLAT/);
  assert.doesNotMatch(warmup, /PAPER ENTRY CHECKS|ENTRY READY|NaN/);
  const flat = { ...selected(), actionId: null, reason: "INSUFFICIENT_DAYS" };
  value.distributional.decision = flat;
  value.distributional.statistics.markets = readyMarket().distributional.statistics.markets;
  assert.match(render(value), /STAY FLAT/);
  assert.match(render(value), /No supported action currently clears/);
  assert.doesNotMatch(render(value), /PAPER ENTRY CHECKS/);
  for (const snapshot of [{ mode: "shadow" }, { paper: false }]) {
    assert.match(render(value, snapshot), /SHADOW ONLY/);
    assert.doesNotMatch(render(value, snapshot), /PAPER PERMISSION ENABLED/);
  }
});

test("distribution dashboard shows prospective evidence and action estimates without representing them as realized profit", () => {
  const value = readyMarket(); value.distributional.decision = selected();
  value.distributional.statistics.validation = { selections: 12, observedDays: 3, lowerNetBps: -1.25, ready: false };
  value.distributional.statistics.learning.byAction = [{ symbol: "BTC/USD", samples: 80 }, { symbol: "BTC/USD", samples: 100 },
    { symbol: "ETH/USD", samples: 500 }];
  value.distributional.statistics.completePanels = 103; value.distributional.statistics.invalidPanels = 9;
  const html = render(value);
  assert.match(html, /SHADOW VALIDATION/);
  assert.match(html, /Training outcomes per action \(includes restored\)<\/span><strong>80–100/);
  assert.match(html, /Relevant training dates \/ required<\/span><strong>8–8 \/ 7/);
  assert.match(html, /Completed historical data counts toward training dates/);
  assert.match(html, /Prospective selections \/ required<\/span><strong>12 \/ 20/);
  assert.match(html, /Prospective days \/ required<\/span><strong>3 \/ 7/);
  assert.match(html, /Prospective stressed lower mean<\/span><strong>-1\.25 bp/);
  assert.match(html, /Relevant samples \/ required<\/span><strong>78–80 \/ 48/);
  assert.match(html, /Effective samples \/ required<\/span><strong>64\.0–65\.5 \/ 32/);
  assert.match(html, /<td>long-15m<\/td><td>\+12\.00 bp<\/td><td>\+4\.50 bp<\/td><td>Relevant 80 \/ 48<br>Effective 65\.5 \/ 32<br>Dates 8 \/ 7<\/td><td>POSITIVE_DISTRIBUTIONAL_SCORE/);
  assert.match(html, /This run: complete research panels 103 · excluded panels 9/);
  assert.match(html, /Shadow outcomes are hypothetical; actual fills and fees determine account P&amp;L/);
  assert.doesNotMatch(html, /PAPER ENTRY CHECKS/);
});

test("distribution dashboard expires entry checks and gives existing positions and stale data priority", () => {
  const value = readyMarket(); value.distributional.decision = selected(true);
  value.distributional.statistics.validation = { selections: 30, observedDays: 8, lowerNetBps: 5, ready: true };
  assert.match(render(value), /PAPER ENTRY CHECKS/);
  const expired = render(value, {}, 1001);
  assert.match(expired, /reference only/); assert.doesNotMatch(expired, /PAPER ENTRY CHECKS/);
  value.distributional.decision = { ...selected(true), atMs: nowMs + 1 };
  assert.match(render(value), /reference only/); assert.doesNotMatch(render(value), /PAPER ENTRY CHECKS/);
  value.distributional.decision = selected(true);
  const occupied = render(value, { positions: [{ symbol: "ETH/USD", active: true }] });
  assert.match(occupied, /POSITION OPEN/); assert.match(occupied, /An existing position blocks another entry/);
  assert.doesNotMatch(occupied, /PAPER ENTRY CHECKS/);
  assert.match(render({ ...value, stale: true }), /WAITING FOR FRESH DATA/);
  assert.match(render({ ...value, bookValid: false }), /DATA GATED/);
});

test("distribution dashboard escapes dynamic action, symbol, model and reason strings", () => {
  const value = readyMarket(), d = selected();
  value.symbol = "<script>symbol()</script>";
  value.distributional.statistics.version = "<img src=x onerror=version()>";
  d.actionId = "<img src=x onerror=action()>"; d.estimates[0]!.actionId = "<svg onload=estimate()>";
  d.estimates[0]!.reason = "<em onmouseover=gate()>unknown</em>";
  d.reason = "<b>unsafe & quoted</b>"; value.distributional.decision = d;
  value.distributional.statistics.markets[0]!.reason = "<svg onload=history()>";
  const html = render(value);
  assert.doesNotMatch(html, /<script>|<img src=x|<svg onload|<b>unsafe/);
  for (const escaped of ["&lt;script&gt;symbol()&lt;/script&gt;", "&lt;img src=x onerror=version()&gt;",
    "&lt;img src=x onerror=action()&gt;", "&lt;svg onload=estimate()&gt;", "&lt;b&gt;unsafe &amp; quoted&lt;/b&gt;",
    "&lt;svg onload=history()&gt;", "&lt;em onmouseover=gate()&gt;unknown&lt;/em&gt;"]) {
    assert.ok(html.includes(escaped), escaped);
  }
});

test("the dashboard clock expires distribution entry checks when no new snapshot arrives", () => {
  const value = readyMarket(); value.distributional.decision = selected(true);
  const card = { dataset: { symbol: value.symbol }, outerHTML: render(value) };
  assert.match(card.outerHTML, /PAPER ENTRY CHECKS/);
  const refresh = app.slice(app.indexOf("function refreshCrossAssetPanels"), app.indexOf("function policyFamilyName"));
  class Clock extends Date { public static override now() { return nowMs + 1001; } }
  runInNewContext(`${utilities}\n${renderer}\n${refresh}\nstate.snapshot=snapshot;state.snapshotReceivedAt=0;refreshCrossAssetPanels();`, {
    Date: Clock, performance: { now: () => 1001 },
    snapshot: { mode: "paper", paper: true, generatedAtMs: nowMs, positions: [], markets: [value] },
    document: { querySelectorAll: (selector: string) => selector.includes("distribution-market-card") ? [card] : [] },
  });
  assert.match(card.outerHTML, /reference only/);
  assert.doesNotMatch(card.outerHTML, /PAPER ENTRY CHECKS/);
});

test("warmup shows separately observed BTC and ETH history and never advances on a stale dashboard clock", () => {
  const value = market(), markets = value.distributional.statistics.markets;
  Object.assign(markets[0]!, { coverageMs: 720_000, flowCoverageMs: 22_000 });
  Object.assign(markets[1]!, { coverageMs: 360_000, flowCoverageMs: 16_000 });
  const initial = render(value), stale = render(value, {}, 60_000);
  for (const html of [initial, stale]) {
    assert.match(html, /BTC\/USD observed price history<\/span><strong>12m 0s \/ 30m/);
    assert.match(html, /ETH\/USD observed price history<\/span><strong>6m 0s \/ 30m/);
    assert.match(html, /Fresh live flow 22s \/ 30s/);
    assert.match(html, /Fresh live flow 16s \/ 30s/);
    assert.match(html, /value="720000"/); assert.match(html, /value="360000"/);
    assert.doesNotMatch(html, /13m 0s|7m 0s|PAPER ENTRY CHECKS/);
  }
  assert.match(initial, /MARKET WARMUP/);
  assert.match(stale, /DASHBOARD STALE/);
  assert.match(stale, /Dashboard updates are stale/);
  assert.match(stale, /does not advance until new updates arrive/);
  assert.doesNotMatch(stale, /BOOK VALID|DATA GATED/);
});

test("restored price history still waits for live flow and cannot reuse an old paper-ready decision", () => {
  const value = readyMarket(); value.distributional.decision = selected(true);
  for (const item of value.distributional.statistics.markets) Object.assign(item, {
    ready: false, reason: "WARMING_FLOW_30_SECONDS", restoredSampleCount: 181, flowCoverageMs: 12_000,
  });
  const html = render(value);
  assert.match(html, /MARKET WARMUP/);
  assert.match(html, /Recorded price history is restored/);
  assert.match(html, /30 seconds of live book and trade flow/);
  assert.match(html, /30m 0s \/ 30m/);
  assert.match(html, /Fresh live flow 12s \/ 30s · 181 recorded price samples restored/);
  assert.match(html, /training and prospective validation requirements still apply/);
  assert.match(html, /reference only/);
  assert.match(html, /Next entry evaluation after market warmup/);
  assert.doesNotMatch(html, /PAPER ENTRY CHECKS|SHADOW VALIDATION/);
});

test("warmup readiness requires both markets and completed context is distinct from a first evaluation", () => {
  const value = readyMarket(); value.distributional.decision = selected(true);
  value.distributional.statistics.markets[1]!.ready = false;
  value.distributional.statistics.markets[1]!.reason = "PEER_NOT_SYNCHRONIZED";
  const blocked = render(value);
  assert.match(blocked, /MARKET WARMUP/);
  assert.match(blocked, /Waiting for synchronized BTC and ETH quotes/);
  assert.doesNotMatch(blocked, /PAPER ENTRY CHECKS/);
  const waiting = render(readyMarket());
  assert.match(waiting, /WAITING FOR EVALUATION/);
  assert.match(waiting, /Market context is ready/);
  assert.doesNotMatch(waiting, /MARKET WARMUP|PAPER ENTRY CHECKS/);
});

test("browser clock offsets cannot gate valid books or change entry expiration", () => {
  const value = readyMarket(); value.distributional.decision = selected(true);
  for (const clockOffsetMs of [-3_600_000, 6_000, 3_600_000]) {
    const initial = render(value, {}, 0, clockOffsetMs);
    assert.match(initial, /BOOK VALID/); assert.match(initial, /PAPER ENTRY CHECKS/);
    assert.doesNotMatch(initial, /DATA GATED|DASHBOARD STALE/);
    const expired = render(value, {}, 1_001, clockOffsetMs);
    assert.match(expired, /BOOK VALID/); assert.match(expired, /reference only/);
    assert.doesNotMatch(expired, /PAPER ENTRY CHECKS/);
    const stale = render(value, {}, 5_001, clockOffsetMs);
    assert.match(stale, /DASHBOARD STALE/);
    assert.doesNotMatch(stale, /PAPER ENTRY CHECKS|BOOK VALID|DATA GATED/);
  }
});

test("entry timing uses the fresh-quote throttle independently of training collection", () => {
  const value = readyMarket(); value.distributional.decision = selected();
  const html = render(value);
  assert.match(html, /Entry evaluation cadence<\/span><strong>Fresh quotes · at most once per 1s per symbol/);
  assert.match(html, /Training collection cadence<\/span><strong>Every 31m 0s/);
  assert.match(html, /Next entry evaluation eligible in 1s, on a fresh quote/);
  assert.match(html, /Next training collection eligible in 31m 0s, on a fresh quote/);
  assert.match(html, /Faster checks do not force orders; training, validation and execution requirements still apply/);
  const eligible = render(value, {}, 1_001);
  assert.match(eligible, /Next entry evaluation on the next fresh quote/);
  assert.match(eligible, /Next training collection eligible in 30m 59s/);
  assert.match(eligible, /reference only/);
  assert.doesNotMatch(eligible, /PAPER ENTRY CHECKS/);
});

test("entry timing waits for fresh data without counting down stale telemetry", () => {
  const value = readyMarket(); value.distributional.decision = selected(true);
  const staleBook = render({ ...value, stale: true });
  assert.match(staleBook, /Next entry evaluation on a fresh executable quote/);
  assert.match(staleBook, /Next training collection on a fresh executable quote/);
  const staleSnapshot = render(value, {}, 5_001);
  assert.match(staleSnapshot, /Next entry evaluation after fresh dashboard and market updates/);
  assert.match(staleSnapshot, /Next training collection after fresh dashboard and market updates/);
  assert.doesNotMatch(staleSnapshot, /eligible in|PAPER ENTRY CHECKS/);
  value.distributional.statistics.nextEvaluations["BTC/USD"] = nowMs + 500;
  assert.match(render(value), /Next entry evaluation eligible in 1s, on a fresh quote/);
});

test("missing entry cadence telemetry never presents the training timer as an entry timer", () => {
  const value = readyMarket();
  const statistics = value.distributional.statistics as Record<string, unknown>;
  delete statistics.evaluationIntervalMs; delete statistics.trainingIntervalMs; delete statistics.nextEvaluations;
  const html = render(value);
  assert.match(html, /Entry evaluation cadence<\/span><strong>Waiting for cadence telemetry/);
  assert.match(html, /Next entry evaluation timing unavailable; waiting for current controller telemetry/);
  assert.match(html, /Next training collection eligible in 31m 0s/);
  assert.doesNotMatch(html, /Next entry evaluation eligible in 31m/);
});

function trialMarket(paperReady = true) {
  const value = readyMarket();
  Object.assign(value.distributional.statistics, { entryMode: "PAPER_TRIAL", minimumDays: 3,
    selectionPolicyVersion: "btc-eth-selected-policy-paper-trial-3d-v1" });
  const d = { ...selected(paperReady), entryMode: "PAPER_TRIAL", reason: "PAPER_TRIAL_NET_RETURN" };
  for (const estimate of d.estimates) estimate.observedDays = 3;
  value.distributional.decision = d;
  return value;
}

test("paper trial clearly permits unvalidated paper checks while keeping prospective progress separate", () => {
  const value = trialMarket(), html = render(value);
  assert.match(html, /<b>PAPER TRIAL · UNVALIDATED<\/b>/);
  assert.match(html, /Paper trial permits eligible paper orders while prospective evidence is collected/);
  assert.match(html, /without being an entry prerequisite/);
  assert.match(html, /Relevant training dates \/ required<\/span><strong>3–3 \/ 3/);
  assert.match(html, /Effective samples \/ required<\/span><strong>64\.0–65\.5 \/ 32/);
  assert.match(html, /Prospective selections \/ required<\/span><strong>0 \/ 20/);
  assert.match(html, /Prospective days \/ required<\/span><strong>0 \/ 7/);
  assert.match(html, /no forced trades/);
  assert.match(html, /PAPER_TRIAL_NET_RETURN/);
  assert.doesNotMatch(html, /PAPER ENTRY CHECKS|ENTRY READY|SHADOW VALIDATION|must pass prospective validation/);
  value.distributional.statistics.validation = { selections: 30, observedDays: 8, lowerNetBps: 5, ready: true };
  assert.match(render(value), /<b>PAPER TRIAL · UNVALIDATED<\/b>/,
    "collecting positive prospective evidence does not silently change the configured trial profile");
});

test("paper trial retains sample and score gates instead of promising entries from three dates alone", () => {
  for (const reason of ["INSUFFICIENT_DAYS", "INSUFFICIENT_SAMPLES", "INSUFFICIENT_EFFECTIVE_SAMPLES", "SCORE_BELOW_MINIMUM"]) {
    const value = trialMarket(false);
    Object.assign(value.distributional.decision!, { actionId: null, reason });
    const html = render(value);
    assert.match(html, /PAPER TRIAL · UNVALIDATED/);
    assert.match(html, /<b>STAY FLAT<\/b>/);
    assert.ok(html.includes(`Paper trial stays flat: ${reason}.`));
    assert.match(html, /Positive stressed net returns and execution checks remain required/);
    assert.doesNotMatch(html, /<b>PAPER TRIAL · UNVALIDATED<\/b>|PAPER ENTRY CHECKS|ENTRY READY/);
  }
});

test("trial display never promotes expired, mismatched, unauthorized or occupied decisions to active checks", () => {
  const value = trialMarket();
  for (const snapshot of [{ mode: "shadow" }, { paper: false }]) {
    const html = render(value, snapshot);
    assert.match(html, /SHADOW ONLY/); assert.match(html, /<b>TRIAL SIGNAL · UNVALIDATED<\/b>/);
  }
  const expired = render(value, {}, 1_001);
  assert.match(expired, /reference only/); assert.match(expired, /<b>TRIAL SIGNAL · UNVALIDATED<\/b>/);
  value.distributional.decision!.entryMode = "VALIDATED";
  assert.match(render(value), /<b>TRIAL SIGNAL · UNVALIDATED<\/b>/);
  value.distributional.decision!.entryMode = "PAPER_TRIAL";
  const occupied = render(value, { positions: [{ symbol: "ETH/USD", active: true }] });
  assert.match(occupied, /<b>POSITION OPEN<\/b>/); assert.match(occupied, /An existing position blocks another entry/);
  assert.match(render({ ...value, stale: true }), /<b>WAITING FOR FRESH DATA<\/b>/);
  value.distributional.statistics.entryMode = "VALIDATED";
  assert.doesNotMatch(render(value), /PAPER ENTRY CHECKS/);
});

test("stored outcomes cannot be mistaken for the relevant-sample gate in a three-date trial", () => {
  const value = trialMarket(false);
  value.distributional.statistics.learning.byAction = [{ symbol: "BTC/USD", samples: 82 }, { symbol: "BTC/USD", samples: 82 }];
  const d = selected(false); d.actionId = null; d.reason = "INSUFFICIENT_SAMPLES"; d.entryMode = "PAPER_TRIAL";
  for (const estimate of d.estimates) Object.assign(estimate, { samples: 47, effectiveSamples: 44.47,
    observedDays: 3, scoreBps: -5, reason: "INSUFFICIENT_SAMPLES" });
  value.distributional.decision = d;
  for (const elapsedMs of [0, 60_000]) {
    const html = render(value, {}, elapsedMs);
    assert.match(html, /Training outcomes per action \(includes restored\)<\/span><strong>82–82/);
    assert.match(html, /Relevant samples \/ required<\/span><strong>47–47 \/ 48/);
    assert.match(html, /Effective samples \/ required<\/span><strong>44\.5–44\.5 \/ 32/);
    assert.match(html, /Relevant training dates \/ required<\/span><strong>3–3 \/ 3/);
    assert.match(html, /Relevant 47 \/ 48<br>Effective 44\.5 \/ 32<br>Dates 3 \/ 3<\/td><td>INSUFFICIENT_SAMPLES/);
    assert.match(html, /Only completed outcomes from similar market conditions count toward relevant samples/);
    assert.match(html, /Relevant and effective counts can change as market conditions change/);
    assert.match(html, /PAPER TRIAL · UNVALIDATED/);
    assert.doesNotMatch(html, /PAPER ENTRY CHECKS|ENTRY READY/);
    if (!elapsedMs) assert.match(html, /Each action requires at least 48 relevant samples and 32 effective samples/);
    else { assert.match(html, /DASHBOARD STALE/); assert.match(html, /reference only/); }
  }
});

test("missing or invalid support telemetry stays unavailable instead of becoming zero samples", () => {
  const value = readyMarket();
  let html = render(value);
  assert.match(html, /Relevant samples \/ required<\/span><strong>— \/ 48/);
  assert.match(html, /Effective samples \/ required<\/span><strong>— \/ 32/);
  const d = selected();
  const first = d.estimates[0]! as Record<string, unknown>;
  delete first.samples; first.effectiveSamples = NaN;
  value.distributional.decision = d;
  html = render(value);
  assert.match(html, /Relevant samples \/ required<\/span><strong>— \/ 48/);
  assert.match(html, /Effective samples \/ required<\/span><strong>— \/ 32/);
  assert.match(html, /Relevant — \/ 48<br>Effective — \/ 32/);
  assert.doesNotMatch(html, /NaN|Relevant samples \/ required<\/span><strong>0/);
});
