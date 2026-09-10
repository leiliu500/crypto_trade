/** Read-only deployment audit; run from /app inside the reviewed image.
 * node post-deployment-verify.mjs BEFORE_PAPER AFTER_PAPER AFTER_BANK PREFLIGHT STARTUP_JSONL DASHBOARD HEALTH CONTEXT NEW_REPORT
 * Only NEW_REPORT is written. No broker, engine, connection or order API starts.
 */
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const EXPECTED_SOURCE = 'c57475ab04ce281cbd83f86f95f0099d56d24ef5edcee758e293be197f8d036b';
const args = process.argv.slice(2);
if (args.length !== 9 || args.some(p => !p.trim())) throw new Error('Exactly nine nonempty paths required');
const [beforePath, afterPath, bankPath, preflightPath, logPath, dashboardPath, healthPath, contextPath, outputPath] = args;
if (args.slice(0, -1).some(p => resolve(p) === resolve(outputPath))) throw new Error('Output cannot replace an input');
if (await realpath(dirname(resolve(outputPath))) !== '/checks-out') throw new Error('Output parent must be canonical /checks-out');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}` : JSON.stringify(value);
const same = (a, b) => canonical(a) === canonical(b);
const number = n => typeof n === 'number' && Number.isFinite(n);
const time = n => Number.isSafeInteger(n) && n >= 0;
const nowMs = Date.now(), fresh = n => time(n) && n <= nowMs && nowMs - n <= 60_000;
const near = (a, b, epsilon = 1e-12) => number(a) && number(b) && Math.abs(a - b) <= epsilon;
const check = (ok, code) => { if (!ok) throw new Error(code); };
const inputHashes = {}, checks = {};
const report = { version: 'paper-deployment-continuity-audit-v1', verifiedAtUtc: new Date(nowMs).toISOString(),
  sourceCodeSha256: EXPECTED_SOURCE, inputHashes, checks, verified: false,
  brokerOrdersSubmittedByVerifier: 0, runningStateModifiedByVerifier: false,
  trainingLabelsEstablishProfit: false, futureProfitGuaranteed: false };
async function bytesAt(label, path, maximumMiB = 64) {
  const before = await stat(path);
  check(before.isFile() && before.size <= maximumMiB * 1024 * 1024, 'INVALID_OR_OVERSIZED_AUDIT_INPUT');
  const bytes = await readFile(path), after = await stat(path);
  check(before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'AUDIT_INPUT_CHANGED_DURING_READ');
  inputHashes[label] = sha(bytes); return bytes;
}
const moduleAt = path => import(pathToFileURL(resolve('dist/src', path)).href);
const unique = (rows, key, code) => {
  check(Array.isArray(rows), code); const result = new Map();
  for (const row of rows) { const id = key(row); check(typeof id === 'string' && id && !result.has(id), code); result.set(id, row); }
  return result;
};
const terminal = status => ['filled', 'canceled', 'rejected', 'expired'].includes(status);
const positionsAt = state => {
  const result = unique(state.positions, p => p?.symbol, 'INVALID_OR_DUPLICATE_PAPER_POSITION');
  for (const p of result.values()) check([1, -1].includes(p.side) && number(p.qty) && p.qty > 0
    && number(p.entryPx) && p.entryPx > 0 && state.productsBySymbol[p.symbol], 'INVALID_PAPER_POSITION');
  return result;
};
function ordersAt(state) {
  const result = unique(state.orders, o => o?.remote?.id, 'INVALID_OR_DUPLICATE_PAPER_ORDER');
  const clients = new Set();
  for (const o of result.values()) {
    const p = o.plan, r = o.remote;
    check(p && [1, -1].includes(p.side) && number(p.qty) && p.qty > 0 && p.symbol === r.symbol
      && p.clientOrderId === r.client_order_id && !clients.has(r.client_order_id)
      && Number(r.qty) === p.qty && Number.isFinite(Number(r.filled_qty)) && Number(r.filled_qty) >= 0
      && Number(r.filled_qty) <= p.qty + 1e-12 && r.side === (p.side === 1 ? 'buy' : 'sell')
      && ['new', 'partially_filled', 'filled', 'canceled', 'rejected', 'expired'].includes(r.status), 'INVALID_PAPER_ORDER');
    clients.add(r.client_order_id);
  }
  return result;
}
try {
  const { readRiskTrainingSourceHashes } = await moduleAt('distribution/risk-training-source.js');
  const { trainingContextHash, createRiskBoundedTrainingContext } = await moduleAt('distribution/risk-training-context.js');
  const { validatePaperFundingState, paperFundingSnapshot } = await moduleAt('kraken/paper-funding.js');
  const { DistributionController } = await moduleAt('distribution/controller.js');
  const { distributionEntryProfile, DISTRIBUTION_SPEC: S, DISTRIBUTION_ACTIONS } = await moduleAt('distribution/spec.js');
  const { EFFICIENT_TRAINING_SPEC } = await moduleAt('distribution/efficient-trainer.js');
  check(trainingContextHash(readRiskTrainingSourceHashes()) === EXPECTED_SOURCE, 'UNREVIEWED_RUNTIME_SOURCE');
  const labels = ['beforePaper', 'afterPaper', 'afterBank', 'preflight', 'startupLog', 'dashboard', 'health', 'context'];
  const inputs = await Promise.all(args.slice(0, -1).map((path, i) => bytesAt(labels[i], path, i < 2 ? 128 : i === 4 ? 32 : 64)));
  const [before, after, bank, preflight, , dashboard, health, context] = inputs.map((bytes, i) => i === 4 ? null : JSON.parse(bytes));
  check(context.mode === 'paper' && context.paperTrial === true && context.efficientTraining === true
    && context.regimeModel === false && fresh(context.generatedAtMs), 'STALE_OR_INCOMPATIBLE_RUNTIME_CONTEXT');
  check(dashboard.mode === 'paper' && dashboard.paper === true && dashboard.started === true
    && fresh(dashboard.generatedAtMs) && number(dashboard.equity) && dashboard.equity > 0
    && time(dashboard.uptimeMs) && dashboard.uptimeMs <= dashboard.generatedAtMs, 'STALE_OR_INVALID_DASHBOARD');
  check(fresh(health.generatedAtMs) && ['healthy', 'degraded', 'critical'].includes(health.status), 'STALE_OR_INVALID_HEALTH');
  const profile = distributionEntryProfile(context.paperTrial, context.efficientTraining, context.regimeModel);
  const risk = createRiskBoundedTrainingContext(context.symbolConfigs, context.sizingPolicy, context.initialEquity, context.initialEquity);
  checks.currentSourceAndCaptureContextVerified = true;

  // Schema4 continuity preserves the existing epoch; this is not a migration verifier.
  for (const state of [before, after]) {
    check(state.schemaVersion === 4 && number(state.cashEquity) && state.initialEquity === context.initialEquity
      && time(Date.parse(state.savedAt)) && Date.parse(state.savedAt) <= nowMs
      && state.funding && typeof state.funding.priorHistoryFundingUnknown === 'boolean'
      && validatePaperFundingState(state.funding.state, nowMs), 'INVALID_SCHEMA4_PAPER_SNAPSHOT');
    check(same(state.productsBySymbol, state.funding.state.config.productsBySymbol), 'PAPER_FUNDING_PRODUCT_MISMATCH');
  }
  check(Date.parse(after.savedAt) >= Date.parse(before.savedAt), 'PAPER_SNAPSHOT_CLOCK_REVERSED');
  check(before.initialEquity === after.initialEquity && same(before.productsBySymbol, after.productsBySymbol)
    && same(before.funding.state.config, after.funding.state.config)
    && before.funding.priorHistoryFundingUnknown === after.funding.priorHistoryFundingUnknown,
  'ACCOUNT_OR_FUNDING_EPOCH_RESET');
  const beforeEvents = before.funding.state.events, afterEvents = after.funding.state.events;
  check(afterEvents.length >= beforeEvents.length && same(afterEvents.slice(0, beforeEvents.length), beforeEvents)
    && after.funding.state.lastObservedAtMs >= before.funding.state.lastObservedAtMs, 'FUNDING_HISTORY_NOT_APPEND_ONLY');
  const newEvents = afterEvents.slice(beforeEvents.length), newFundingFills = newEvents.filter(e => e.type === 'FILL');
  const beforePositions = positionsAt(before), afterPositions = positionsAt(after), beforeOrders = ordersAt(before), afterOrders = ordersAt(after);
  const beforeActivities = unique(before.activities, a => a?.id, 'INVALID_BEFORE_ACTIVITY_IDS');
  unique(after.activities, a => a?.id, 'INVALID_AFTER_ACTIVITY_IDS');
  // Activity order is reverse commit order, which need not equal transaction timestamp order.
  const anchor = after.activities.findIndex(a => beforeActivities.has(a.id));
  check(before.activities.length === 0 || anchor >= 0, 'ACTIVITY_HISTORY_GAP_RECONCILIATION_UNAVAILABLE');
  const prefixLength = before.activities.length ? anchor : after.activities.length;
  const newActivities = after.activities.slice(0, prefixLength);
  const retainedBefore = after.activities.slice(prefixLength);
  check(same(retainedBefore, before.activities.slice(0, retainedBefore.length))
    && (retainedBefore.length === before.activities.length || after.activities.length === 10_000), 'ACTIVITY_HISTORY_REWRITTEN');
  const committedFills = [...newActivities].reverse();
  check(committedFills.every(a => a.activity_type === 'FILL') && committedFills.length === newFundingFills.length
    && committedFills.every((a, i) => a.id === newFundingFills[i].fill.id), 'FILL_ACTIVITY_FUNDING_COMMIT_ORDER_MISMATCH');
  const activityById = new Map(committedFills.map(a => [a.id, a]));
  const positions = new Map([...beforePositions].map(([symbol, p]) => [symbol, { ...p }]));
  const fillsByOrder = new Map();
  let expectedCash = before.cashEquity, priceRealizationUsd = 0, feeUsd = 0, fundingPostingsUsd = 0;
  for (const event of newEvents) {
    if (event.type === 'POSTING') {
      expectedCash += event.posting.cashDeltaUsd; fundingPostingsUsd += event.posting.cashDeltaUsd;
      continue;
    }
    if (event.type !== 'FILL') continue;
    const a = activityById.get(event.fill.id), o = afterOrders.get(a?.order_id), p = o?.plan;
    const qty = Number(a?.qty), price = Number(a?.price), fee = Number(a?.fee_usd);
    check(a && o && number(qty) && qty > 0 && number(price) && price > 0 && a.fee_usd !== undefined
      && number(fee) && fee >= 0 && a.symbol === p.symbol && event.fill.symbol === p.symbol
      && event.fill.side === p.side && event.fill.qty === qty && event.fill.occurredAtMs === Date.parse(a.transaction_time), 'NEW_FILL_EVIDENCE_INVALID');
    const configuredFeeBps = context.symbolConfigs[p.symbol]?.cost?.[p.style === 'maker' ? 'makerFeeBps' : 'takerFeeBps'];
    check(number(configuredFeeBps) && near(fee, qty * price * configuredFeeBps / 10_000, 1e-8), 'NEW_FILL_FEE_CONTEXT_MISMATCH');
    const old = positions.get(p.symbol); let gross = 0;
    if (p.reduceOnlyIntent) {
      check(old && old.side === -p.side && qty <= old.qty + 1e-12, 'REDUCE_ONLY_FILL_WITHOUT_MATCHING_POSITION');
      gross = old.side * (price - old.entryPx) * qty; old.qty -= qty;
      if (old.qty <= 1e-12) positions.delete(p.symbol);
    } else if (!old) positions.set(p.symbol, { symbol: p.symbol, side: p.side, qty, entryPx: price });
    else {
      check(old.side === p.side, 'UNEXPLAINED_OPPOSITE_NONREDUCE_FILL');
      old.entryPx = (old.entryPx * old.qty + price * qty) / (old.qty + qty); old.qty += qty;
    }
    expectedCash += gross; expectedCash -= fee; priceRealizationUsd += gross; feeUsd += fee;
    const group = fillsByOrder.get(a.order_id) ?? []; group.push({ qty, price }); fillsByOrder.set(a.order_id, group);
  }
  check(positions.size === afterPositions.size && [...positions].every(([symbol, p]) => {
    const actual = afterPositions.get(symbol); return actual && p.side === actual.side && near(p.qty, actual.qty)
      && near(p.entryPx, actual.entryPx, 1e-8);
  }), 'POSITION_CONTINUITY_DOES_NOT_RECONCILE');
  const residualUsd = after.cashEquity - expectedCash;
  check(Math.abs(residualUsd) <= 1e-6, 'PAPER_CASH_DOES_NOT_RECONCILE');
  const cashEvents = newEvents.filter(e => e.type === 'FILL' || e.type === 'POSTING');
  if (!cashEvents.length) check(after.cashEquity === before.cashEquity, 'CASH_CHANGED_WITHOUT_CASH_EVENTS');
  if (!committedFills.length) check(same([...beforePositions].sort(), [...afterPositions].sort()), 'POSITIONS_CHANGED_WITHOUT_FILLS');

  let compatibleNonfillCancellations = 0, newOrders = 0, newUnfilledOrders = 0;
  for (const [id, old] of beforeOrders) check(afterOrders.has(id) && same(old.plan, afterOrders.get(id).plan), 'ORDER_HISTORY_OR_PLAN_CHANGED');
  const mutableRemote = new Set(['status', 'updated_at', 'filled_qty', 'filled_avg_price', 'filled_at', 'canceled_at']);
  const stableRemote = remote => Object.fromEntries(Object.entries(remote).filter(([key]) => !mutableRemote.has(key)));
  for (const [id, order] of afterOrders) {
    const old = beforeOrders.get(id), fills = fillsByOrder.get(id) ?? [];
    if (!old) { newOrders++; if (!fills.length) newUnfilledOrders++; }
    else check(same(stableRemote(old.remote), stableRemote(order.remote)), 'ORDER_IMMUTABLE_REMOTE_FIELDS_CHANGED');
    const oldFilled = Number(old?.remote.filled_qty ?? 0), fillQty = fills.reduce((n, f) => n + f.qty, 0);
    check(near(Number(order.remote.filled_qty), oldFilled + fillQty), 'ORDER_FILLED_QUANTITY_NOT_EXPLAINED_BY_ACTIVITIES');
    if (old && terminal(old.remote.status)) check(same(old.remote, order.remote), 'TERMINAL_ORDER_HISTORY_CHANGED');
    if (old && !fills.length && !terminal(old.remote.status)) {
      const changed = !same(old.remote, order.remote);
      if (changed) {
        check(order.remote.status === 'canceled' && order.remote.filled_avg_price === old.remote.filled_avg_price
          && order.remote.filled_at === old.remote.filled_at && time(Date.parse(order.remote.canceled_at))
          && Date.parse(order.remote.canceled_at) <= nowMs, 'UNEXPLAINED_NONFILL_ORDER_TRANSITION');
        compatibleNonfillCancellations++;
      }
    }
    if (oldFilled + fillQty > 0) {
      const value = oldFilled * Number(old?.remote.filled_avg_price ?? 0) + fills.reduce((n, f) => n + f.qty * f.price, 0);
      check(near(Number(order.remote.filled_avg_price), value / (oldFilled + fillQty), 1e-8), 'ORDER_AVERAGE_PRICE_NOT_RECONCILED');
    } else check(order.remote.filled_avg_price === null, 'UNFILLED_ORDER_HAS_AVERAGE_PRICE');
  }
  const fundingViews = [before, after].map(state => paperFundingSnapshot(state.funding.state,
    Math.max(Date.parse(state.savedAt), state.funding.state.lastObservedAtMs)));
  for (const [i, view] of fundingViews.entries()) for (const row of view.perSymbol) {
    const p = [beforePositions, afterPositions][i].get(row.symbol);
    check(near(row.signedBaseQty, p ? p.side * p.qty : 0), 'FUNDING_INVENTORY_POSITION_MISMATCH');
  }
  checks.fundingEpochAndHistoryPreserved = true; checks.paperCashPositionsAndOrdersReconciled = true;
  report.account = { initialEquityUsd: after.initialEquity, beforeSavedAt: before.savedAt, afterSavedAt: after.savedAt,
    fundingEpochUtc: new Date(after.funding.state.config.startedAtMs).toISOString(),
    beforeCashUsd: before.cashEquity, afterCashUsd: after.cashEquity, actualCashDeltaUsd: after.cashEquity - before.cashEquity,
    realizedPriceDeltaUsd: priceRealizationUsd, recordedFillFeesUsd: feeUsd, postedFundingDeltaUsd: fundingPostingsUsd,
    residualUsd, toleranceUsd: 1e-6, newFills: committedFills.length, newOrders, newUnfilledOrders, compatibleNonfillCancellations,
    beforePositions: beforePositions.size, afterPositions: afterPositions.size,
    exactCashWithoutCashEvents: cashEvents.length ? null : after.cashEquity === before.cashEquity,
    retainedOldActivities: retainedBefore.length, truncatedOldActivityTail: before.activities.length - retainedBefore.length,
    priorHistoryFundingUnknown: after.funding.priorHistoryFundingUnknown,
    beforeEpochFundingKnown: fundingViews[0].fundingAccountingKnown, afterEpochFundingKnown: fundingViews[1].fundingAccountingKnown,
    afterDueUnpostedFundingAdjustments: fundingViews[1].dueModelPostings.length,
    utcSessionDateBefore: before.utcSessionDate, utcSessionDateAfter: after.utcSessionDate,
    sessionRolloverIsNotAccountReset: true, dashboardEquityIsMarkedAndNotCashContinuityEvidence: true,
    interpretation: 'RECORDED_PAPER_CASH_CONTINUITY;NOT_REAL_VENUE_PROFIT_OR_A_STRATEGY_PROFIT_TEST' };

  // Import identity is tied to the startup artifact hash; labels remain training only.
  check(preflight.sourceCodeSha256 === EXPECTED_SOURCE && preflight.sizingPolicyId === risk.sizingPolicyId
    && preflight.repeatedImportAddedSamples === 0 && preflight.brokerOrdersSubmitted === 0
    && preflight.originalRecordingsReplayedByThisPreflight === false && /^[a-f0-9]{64}$/.test(preflight.artifact?.sha256), 'INCOMPATIBLE_IMPORT_PREFLIGHT');
  const logRows = [];
  for (const line of inputs[4].toString('utf8').split('\n')) {
    const start = line.indexOf('{'); if (start < 0) continue;
    try { const row = JSON.parse(line.slice(start)); if (row && typeof row === 'object') logRows.push(row); } catch { /* Plain operational text is never emitted. */ }
  }
  const importRows = logRows.filter(r => r.type === 'distributional-training-ready' && r.file?.sha256 === preflight.artifact.sha256);
  check(importRows.length > 0 && !logRows.some(r => ['distributional-training-invalid', 'distributional-state-error', 'distributional-state-invalid'].includes(r.type)), 'STARTUP_IMPORT_SUCCESS_NOT_VERIFIED');
  const imported = importRows.at(-1);
  check(imported.brokerOrdersSubmitted === 0 && time(imported.addedSamples) && time(imported.retainedSamples), 'INVALID_STARTUP_IMPORT_REPORT');
  check(typeof context.trainingFile === 'string' && context.trainingFile.length > 0
    && resolve(context.trainingFile) === resolve(imported.file.path), 'CONFIGURED_TRAINING_FILE_DIFFERS_FROM_IMPORTED_ARTIFACT');
  check(bank.sizingPolicyId === risk.sizingPolicyId && bank.selectionPolicyVersion === profile.selectionPolicyVersion
    && bank.trainingPolicyVersion === EFFICIENT_TRAINING_SPEC.version, 'ACTIVE_BANK_POLICY_MISMATCH');
  const verifier = new DistributionController(context.costs, context.assets, profile, { efficientTraining: true, sizingPolicy: context.sizingPolicy });
  verifier.restoreState(bank, nowMs);
  const dates = [...new Set(bank.samples.map(s => new Date(s.signalAtMs).toISOString().slice(0, 10)))].sort();
  const datesBeforeStartupDay = dates.filter(day => day < new Date(dashboard.generatedAtMs - dashboard.uptimeMs).toISOString().slice(0, 10));
  check(dates.length >= 3, 'ACTIVE_BANK_HAS_FEWER_THAN_THREE_TRAINING_DATES');
  const byAction = S.symbols.flatMap(symbol => DISTRIBUTION_ACTIONS.map(action => {
    const samples = bank.samples.filter(s => s.symbol === symbol && s.actionId === action.id);
    return { symbol, actionId: action.id, samples: samples.length,
      trainingDates: [...new Set(samples.map(s => new Date(s.signalAtMs).toISOString().slice(0, 10)))].sort(),
      trainedThroughMs: samples.length ? Math.max(...samples.map(s => s.completedAtMs)) : null };
  }));
  const marketMap = unique(dashboard.markets, m => m?.symbol, 'INVALID_DASHBOARD_MARKETS');
  const entryDiagnostics = [];
  for (const symbol of S.symbols) {
    const market = marketMap.get(symbol), stats = market?.distributional?.statistics;
    check(stats && stats.sizingPolicyId === risk.sizingPolicyId && stats.selectionPolicyVersion === profile.selectionPolicyVersion
      && stats.trainingPolicyVersion === EFFICIENT_TRAINING_SPEC.version && stats.sizingMode === 'RISK_BOUNDED'
      && stats.minimumTrainingDays === profile.minimumTrainingDays, 'RUNNING_MODEL_POLICY_MISMATCH');
    for (const expected of byAction) {
      const active = stats.learning?.byAction?.find(row => row.symbol === expected.symbol && row.actionId === expected.actionId);
      check(active && active.samples >= expected.samples && (expected.trainedThroughMs === null || active.trainedThroughMs >= expected.trainedThroughMs), 'DASHBOARD_MODEL_NOT_CAUGHT_UP_WITH_CAPTURED_BANK');
    }
    const query = market.distributional.decision;
    const compatible = query && fresh(query.atMs) && query.symbol === symbol && query.sizingPolicyId === risk.sizingPolicyId
      && query.selectionPolicyVersion === profile.selectionPolicyVersion && Array.isArray(query.features)
      && query.features.length === S.featureDimension && query.features.every(Number.isFinite) && Array.isArray(query.estimates);
    const latestRejection = market.entryPipeline?.lastRejection;
    entryDiagnostics.push({ symbol, freshCompatibleDecision: Boolean(compatible),
      actionId: compatible ? query.actionId : null, decisionReason: compatible ? query.reason : 'NO_FRESH_COMPATIBLE_DECISION',
      paperReady: compatible ? query.paperReady === true : false,
      estimates: compatible ? query.estimates.map(e => ({ actionId: e.actionId, reason: e.reason, eligible: e.eligible,
        scoreBps: e.scoreBps, samples: e.samples, effectiveSamples: e.effectiveSamples, observedDays: e.observedDays })) : [],
      latestPipelineRejection: latestRejection && fresh(latestRejection.atMs)
        ? { atMs: latestRejection.atMs, reason: latestRejection.reason } : null,
      trainingIsNotOrderPermission: true });
  }
  checks.importedBankMatchesRunningPolicy = true; checks.atLeastThreeRetainedTrainingDates = true;
  report.model = { sizingPolicyId: risk.sizingPolicyId, trainingPolicyVersion: bank.trainingPolicyVersion,
    selectionPolicyVersion: bank.selectionPolicyVersion, artifactSha256: preflight.artifact.sha256,
    startupAddedLabels: imported.addedSamples, startupRetainedLabels: imported.retainedSamples,
    capturedBankLabels: bank.samples.length, trainingDates: dates, datesBeforeStartupDay, byAction,
    conditionalNeighborhoodSupportNotGuaranteed: true, requiresProspectiveValidation: profile.requiresProspectiveValidation,
    paperTrialRemainsUnvalidatedExperiment: true };
  report.entryDiagnostics = entryDiagnostics;
  report.health = { dashboardGeneratedAtMs: dashboard.generatedAtMs, healthGeneratedAtMs: health.generatedAtMs,
    status: health.status, dashboardOverall: dashboard.overall, entriesAllowed: dashboard.entriesAllowed,
    haltReasons: dashboard.haltReasons, databaseStatus: health.database,
    fundingEpochAccountingKnown: fundingViews[1].fundingAccountingKnown };
  checks.freshDashboardAndHealth = true;
  checks.operationalHealthHealthy = health.status === 'healthy' && dashboard.overall === 'healthy';
  report.verified = Object.values(checks).every(Boolean);
} catch (error) {
  report.error = error instanceof Error ? error.message : 'POST_DEPLOYMENT_VERIFICATION_FAILED';
}
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ verified: report.verified, checks, error: report.error ?? null,
  brokerOrdersSubmittedByVerifier: 0, runningStateModifiedByVerifier: false }) + '\n');
if (!report.verified) process.exitCode = 2;
