/** Independent source, causal-rule and cash audit. Imports no application modules. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const own = relative(root, fileURLToPath(import.meta.url));
const base = 'reports/new-spot-system-2026-09-10';
const studyRoot = `${base}/historical-study`, dataRoot = `${base}/market-data`;
const fileHashes = {}, runAudits = [];
let checks = 0, greatestNumericResidual = 0;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function assert(ok, label) { checks++; if (!ok) throw new Error(`INDEPENDENT_SPOT_AUDIT_FAILED:${label}`); }
function equal(actual, expected, label) { assert(JSON.stringify(actual) === JSON.stringify(expected), label); }
function near(actual, expected, label, tolerance = 2e-8) {
  const error = Math.abs(actual - expected);
  greatestNumericResidual = Math.max(greatestNumericResidual, error);
  assert(Number.isFinite(actual) && Number.isFinite(expected) && error <= tolerance, `${label}:${actual}:${expected}`);
}
async function bytes(path) {
  assert(!path.startsWith('/') && !path.split('/').includes('..'), `BOUND_PATH:${path}`);
  const content = await readFile(join(root, path)); fileHashes[path] = sha(content); return content;
}
async function json(path) { return JSON.parse((await bytes(path)).toString('utf8')); }

// Exact decimal cash reconciliation, independent of the application's binary floating-point ledger.
function gcd(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; }
function fraction(n, d = 1n) { const g = gcd(n, d); return [n / g, d / g]; }
function decimal(value) {
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole, tail = ''] = mantissa.split('.'); const scale = tail.length - Number(exponent);
  return scale >= 0 ? fraction(BigInt(whole + tail), 10n ** BigInt(scale))
    : fraction(BigInt(whole + tail) * 10n ** BigInt(-scale));
}
const add = (a, b) => fraction(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const multiply = (a, b) => fraction(a[0] * b[0], a[1] * b[1]);
const negate = a => [-a[0], a[1]];
const number = a => Number(a[0]) / Number(a[1]);

await bytes(own);
const protocol = await json(`${studyRoot}/protocol.json`), report = await json(`${studyRoot}/report.json`);
await bytes(`${studyRoot}/report.md`);
const S = protocol.strategy, D = protocol.study, W = 604800000;
equal(S.version, 'btc-spot-funded-weekly-trend-v1', 'FROZEN_VERSION');
equal([S.movingAverageWeeks, S.entryBufferFraction, S.initialCashUsd, S.maximumEntryPrincipalUsd,
  S.entryPrincipalEquityFraction, S.maximumMarkedNotionalUsd, S.maximumMarkedEquityFraction,
  S.maximumAccountDrawdownFraction, S.historicalLotSize, S.historicalMinimumQuantity,
  S.historicalMinimumNotionalUsd, S.historicalTickSize],
  [40, .0166, 100000, 1000, .001, 1000, .01, .05, 1e-8, .00005, .5, .1], 'PRE_OUTCOME_RULE_CONSTANTS');
equal(S.scenarios, { base: { feeBps: 80, adverseSlippageBps: 3, additionalDelayWeeks: 0 },
  stress: { feeBps: 100, adverseSlippageBps: 10, additionalDelayWeeks: 1 } }, 'PRE_OUTCOME_SCENARIOS');
equal([D.startMs, D.endMsExclusive, D.minimumClosedEpisodes],
  [Date.UTC(2017, 0, 1), Date.UTC(2026, 8, 10), 8], 'PRE_OUTCOME_WINDOW_AND_COUNT');
equal(D.bootstrap, { blockWeeks: 13, repetitions: 2000, lowerQuantile: .05, seed: 0x49197bd3 }, 'PRE_OUTCOME_BOOTSTRAP');
equal(protocol.sourceHashes, report.sourceHashes, 'PROTOCOL_REPORT_SOURCE_BINDING');
equal(Object.keys(protocol.sourceHashes).sort(), ['src/spot-trend/spec.ts', 'src/spot-trend/data.ts',
  'src/spot-trend/account.ts', 'src/spot-trend/signal.ts', 'src/spot-trend/replay.ts',
  'src/spot-trend/study-main.ts', 'package-lock.json', 'tsconfig.json'].sort(), 'FULL_STUDY_SOURCE_CLOSURE');
for (const [path, hash] of Object.entries(protocol.sourceHashes)) {
  equal(sha(await bytes(path)), hash, `CURRENT_SOURCE:${path}`);
  equal(sha(await bytes(`${studyRoot}/sources/${path}`)), hash, `SEALED_SOURCE:${path}`);
}
assert(Date.parse(protocol.sealedAtUtc) <= Date.parse(report.generatedAtUtc), 'SEAL_BEFORE_REPORT');
assert(protocol.historicalStrategyOutcomesComputedBeforeSeal === false && protocol.independentHoldoutClaimed === false,
  'DECLARED_EVIDENCE_LIMITS');
const manifest = await json(`${dataRoot}/manifest.json`), dataset = await json(`${dataRoot}/dataset.json`);
const registration = await json(`${dataRoot}/registration.json`), source = await json(`${dataRoot}/source.json`);
equal(fileHashes[`${dataRoot}/manifest.json`], protocol.inputManifestSha256, 'MANIFEST_BOUND');
equal(fileHashes[`${dataRoot}/dataset.json`], protocol.datasetSha256, 'PROTOCOL_DATASET_BOUND');
equal(fileHashes[`${dataRoot}/dataset.json`], manifest.datasetSha256, 'MANIFEST_DATASET_BOUND');
equal(fileHashes[`${dataRoot}/dataset.json`], report.datasetSha256, 'REPORT_DATASET_BOUND');
equal(fileHashes[`${dataRoot}/source.json`], manifest.sourceSha256, 'MANIFEST_SOURCE_BOUND');
equal(fileHashes[`${dataRoot}/source.json`], report.sourceDataSha256, 'REPORT_SOURCE_BOUND');
equal(registration.spec, manifest.spec, 'DATA_REGISTRATION_SPEC');
assert(registration.strategyPerformanceComputed === false && registration.registeredAtMs <= manifest.retrievedAtMs,
  'DATA_ACQUISITION_REGISTRATION');
equal(source.error, [], 'PUBLIC_SOURCE_NO_ERRORS');
assert(Array.isArray(source.result.XXBTZUSD), 'OFFICIAL_SPOT_PAIR');
const bars = [];
for (const row of source.result.XXBTZUSD) {
  const openMs = row[0] * 1000, endMs = openMs + W, availableAtMs = endMs + 60000;
  assert(Number.isSafeInteger(openMs) && openMs % W === 0, 'NATIVE_SOURCE_WEEK');
  if (availableAtMs > manifest.retrievedAtMs) continue;
  const [open, high, low, close, vwap, volume] = row.slice(1, 7).map(Number);
  assert([open, high, low, close, vwap, volume].every(Number.isFinite) && Math.min(open, low, close, vwap) > 0,
    'VALID_SOURCE_PRICES');
  assert(high >= Math.max(open, low, close, vwap) && low <= Math.min(open, close, vwap) && volume >= 0,
    'VALID_SOURCE_OHLC');
  assert(!bars.length || bars.at(-1).endMs === openMs, 'NO_SOURCE_GAPS');
  bars.push({ openMs, endMs, availableAtMs, open, high, low, close, volume, trades: row[7] });
}
equal(bars, dataset.bars, 'INDEPENDENT_SOURCE_RECONSTRUCTION');
equal(report.coverage, dataset.coverage, 'REPORT_SOURCE_COVERAGE');
equal(bars.length, dataset.coverage.retainedBars, 'SOURCE_RETAINED_COUNT');

// Compute each history state once from the raw source. No production signal/replay functions are used.
const states = [];
let state = 'cash';
for (let i = 0; i < bars.length; i++) {
  const b = bars[i]; let reason = 'WARMUP';
  if (i >= 39) {
    const mean = bars.slice(i - 39, i + 1).reduce((sum, row) => sum + row.close, 0) / 40;
    if (b.close <= mean) { state = 'cash'; reason = 'TREND_EXIT'; }
    else if (b.close > mean * 1.0166) { state = 'long'; reason = 'TREND_ENTER'; }
    else reason = 'HOLD_BAND';
  }
  states.push({ availableAtMs: b.availableAtMs, state, reason });
}
const runMap = new Map();
equal(report.runs.length, 24, 'ALL_DECLARED_RUNS_PRESENT');
for (const summary of report.runs) {
  const expectedFile = `${summary.window}-${summary.scenario}-${summary.policy}.json`;
  equal(summary.file, expectedFile, 'CANONICAL_RUN_FILE');
  assert(!runMap.has(expectedFile), 'UNIQUE_RUN');
  const run = await json(`${studyRoot}/${expectedFile}`); runMap.set(expectedFile, run);
  const { orders, weekly, ...metrics } = run;
  const { window, file, ...summaryMetrics } = summary;
  equal(metrics, summaryMetrics, `REPORT_RUN_SUMMARY:${file}`);
  const scope = window === 'full' ? { startMs: D.startMs, endMs: D.endMsExclusive } : D.periods.find(p => p.id === window);
  assert(scope !== undefined, 'DECLARED_RUN_WINDOW');
  equal([run.startMs, run.endMs], [scope.startMs, scope.endMs], 'RUN_WINDOW_BOUND');
  const rows = bars.filter(b => b.openMs >= run.startMs && b.endMs <= run.endMs), cost = S.scenarios[run.scenario];
  equal(weekly.length, rows.length, 'EVERY_ELIGIBLE_WEEK_ACCOUNTED');
  equal([run.firstEligibleExecutionOpenMs, run.finalEligibleExecutionOpenMs], [rows[0].openMs, rows.at(-1).openMs], 'ELIGIBLE_BOUNDARIES');
  const price = (reference, side) => {
    const raw = reference * (1 + (side === 'buy' ? 1 : -1) * cost.adverseSlippageBps / 10000);
    return (side === 'buy' ? Math.ceil(raw * 10) : Math.floor(raw * 10)) / 10;
  };
  let cash = 100000, quantity = 0, acquisition = 0, realized = 0, feeTotal = 0, orderCursor = 0;
  let previousEquity = cash, sampledPeak = cash, closePeak = cash, drawdown = 0, lowDiagnostic = 0;
  let maxNotional = 0, invested = 0, episodes = 0, halted = false, turnover = 0, buyCount = 0, sellCount = 0;
  let exactCash = decimal(cash), exactFees = decimal(0);
  const ids = new Set();
  for (let i = 0; i < rows.length; i++) {
    const bar = rows[i], row = weekly[i], cutoff = bar.openMs - cost.additionalDelayWeeks * W;
    const sig = states.findLast(s => s.availableAtMs <= cutoff);
    assert(sig !== undefined && sig.availableAtMs < cutoff, 'STRICT_CAUSAL_SIGNAL_AVAILABILITY');
    equal([row.openMs, row.endMs, row.signalAvailableAtMs, row.signalState, row.signalReason],
      [bar.openMs, bar.endMs, sig.availableAtMs, sig.state, sig.reason], 'INDEPENDENT_WEEKLY_SIGNAL');
    const openingEquity = cash + quantity * price(bar.open, 'sell') * (1 - cost.feeBps / 10000);
    sampledPeak = Math.max(sampledPeak, openingEquity);
    if (run.policy === 'trend' && openingEquity <= sampledPeak * .95) halted = true;
    const beforeQuantity = quantity, beforeCash = cash, atOpen = [];
    while (orderCursor < orders.length && orders[orderCursor].timestampMs === bar.openMs) {
      const fill = orders[orderCursor++]; atOpen.push(fill);
      assert(!ids.has(fill.id), 'NO_DUPLICATE_FILL'); ids.add(fill.id);
      assert(bar.volume > 0 && fill.quantity >= .00005 && fill.quantity * fill.price >= .5, 'FILL_MINIMUM_AND_NONZERO_VOLUME');
      near(fill.quantity / 1e-8, Math.round(fill.quantity / 1e-8), 'LOT_ALIGNMENT', 2e-7);
      near(fill.feeBps, cost.feeBps, 'SCENARIO_FEE', 0);
      // Independent decimal tick rounding may differ by one adverse tick at binary boundaries.
      const intended = price(bar.open, fill.side), adverseDifference = (fill.price - intended) * (fill.side === 'buy' ? 1 : -1);
      assert(adverseDifference >= -1e-7 && adverseDifference <= .1000001, 'NO_OPTIMISTIC_FILL_ROUNDING');
      const notional = fill.quantity * fill.price, fee = notional * cost.feeBps / 10000;
      const exactNotional = multiply(decimal(fill.quantity), decimal(fill.price));
      const exactFee = multiply(exactNotional, fraction(BigInt(cost.feeBps), 10000n));
      exactFees = add(exactFees, exactFee);
      if (fill.side === 'buy') {
        assert(quantity === 0 && !halted && i !== rows.length - 1, 'NO_ADDITIONS_OR_TERMINAL_ENTRY');
        assert(run.policy === 'buy-hold' ? buyCount === 0 : run.policy === 'trend' && sig.state === 'long', 'ENTRY_POLICY');
        const budget = run.policy === 'buy-hold' ? 100 : Math.min(1000, .001 * cash);
        assert(notional + fee <= budget + 1e-9 && notional + fee <= cash, 'ENTIRE_ENTRY_DEBIT_WITHIN_PRINCIPAL_BUDGET');
        assert(budget - (notional + fee) < 1.00001e-8 * fill.price * (1 + cost.feeBps / 10000), 'MAXIMAL_AFFORDABLE_ENTRY_LOTS');
        cash -= notional + fee; quantity += fill.quantity; acquisition += notional + fee; buyCount++;
        exactCash = add(exactCash, negate(add(exactNotional, exactFee)));
      } else {
        equal(fill.side, 'sell', 'NO_UNKNOWN_SIDE');
        assert(fill.quantity <= quantity, 'NO_SHORT_OR_INVENTED_INVENTORY');
        const costReleased = acquisition * fill.quantity / quantity;
        cash += notional - fee; realized += notional - fee - costReleased; acquisition -= costReleased;
        quantity -= fill.quantity; sellCount++;
        exactCash = add(exactCash, add(exactNotional, negate(exactFee)));
        if (quantity === 0) { episodes++; acquisition = 0; }
        if (fill.reason === 'TERMINAL_LIQUIDATION') assert(i === rows.length - 1, 'TERMINAL_TIMING');
        else if (fill.reason.startsWith('MARKED_NOTIONAL_CAP'))
          assert(run.policy === 'trend' && beforeQuantity * bar.open > Math.min(1000, .01 * openingEquity), 'CAP_REDUCTION_JUSTIFICATION');
        else assert(run.policy === 'trend' && (sig.state === 'cash' || halted), 'EXIT_POLICY');
      }
      feeTotal += fee; turnover += notional;
      near(cash, number(exactCash), 'EXACT_DECIMAL_FILL_CASH');
      assert(cash >= 0 && quantity >= 0, 'NO_BORROWING');
    }
    assert(atOpen.length <= 1, 'AT_MOST_ONE_WEEKLY_ACTION');
    assert(orderCursor === orders.length || orders[orderCursor].timestampMs > bar.openMs, 'NO_REVERSED_OR_OFF_GRID_FILL');
    // Verify absence of omitted eligible actions, separately from reconciling published fills.
    const terminal = i === rows.length - 1;
    if (bar.volume > 0 && beforeQuantity > 0 && (terminal || run.policy === 'trend' && (sig.state === 'cash' || halted))) {
      if (beforeQuantity >= .00005 && beforeQuantity * price(bar.open, 'sell') >= .5)
        assert(atOpen.length === 1 && quantity === 0, 'REQUIRED_EXIT_PRESENT');
    }
    if (bar.volume > 0 && beforeQuantity === 0 && !terminal && !halted &&
      (run.policy === 'trend' && sig.state === 'long' || run.policy === 'buy-hold' && buyCount === 0)) {
      const b = run.policy === 'buy-hold' ? 100 : Math.min(1000, .001 * beforeCash);
      const q = Math.floor(b / (price(bar.open, 'buy') * (1 + cost.feeBps / 10000)) / 1e-8) * 1e-8;
      if (q >= .00005 && q * price(bar.open, 'buy') >= .5) assert(atOpen.length === 1, 'REQUIRED_ENTRY_PRESENT');
    }
    if (run.policy === 'cash') assert(atOpen.length === 0 && quantity === 0 && cash === 100000, 'CASH_BASELINE');
    const equity = cash + quantity * price(bar.close, 'sell') * (1 - cost.feeBps / 10000);
    const low = cash + quantity * price(bar.low, 'sell') * (1 - cost.feeBps / 10000);
    near(row.quantity, quantity, 'WEEKLY_ACTUAL_INVENTORY', 1e-12); near(row.cashUsd, cash, 'WEEKLY_CASH');
    near(row.liquidationEquityUsd, equity, 'WEEKLY_LIQUIDATION_EQUITY', .10001 * quantity + 2e-8);
    near(row.weeklyLowLiquidationEquityUsd, low, 'WEEKLY_LOW_MARK', .10001 * quantity + 2e-8);
    near(row.markedNotionalUsd, quantity * bar.close, 'WEEKLY_NOTIONAL');
    near(row.weeklyNetUsd, row.liquidationEquityUsd - previousEquity, 'WEEKLY_NET_CHANGE');
    near(row.liquidationEquityUsd - 100000, realized + quantity * price(bar.close, 'sell') * (1 - cost.feeBps / 10000) - acquisition,
      'REALIZED_UNREALIZED_CONSERVATION', .10001 * quantity + 2e-8);
    lowDiagnostic = Math.max(lowDiagnostic, sampledPeak - row.weeklyLowLiquidationEquityUsd);
    sampledPeak = Math.max(sampledPeak, row.liquidationEquityUsd);
    closePeak = Math.max(closePeak, row.liquidationEquityUsd); drawdown = Math.max(drawdown, closePeak - row.liquidationEquityUsd);
    maxNotional = Math.max(maxNotional, quantity * bar.high); if (quantity > 0) invested++;
    previousEquity = row.liquidationEquityUsd;
  }
  equal(orderCursor, orders.length, 'ALL_FILLS_RECONCILED');
  near(run.finalCashUsd, number(exactCash), 'FINAL_EXACT_DECIMAL_CASH');
  near(run.finalQuantity, quantity, 'FINAL_QUANTITY', 1e-12); near(run.realizedNetUsd, realized, 'FINAL_REALIZED_NET');
  near(run.feesUsd, number(exactFees), 'EXACT_DECIMAL_FEES'); near(run.feesUsd, feeTotal, 'SUM_FILL_FEES');
  near(run.netPnlUsd, previousEquity - 100000, 'FINAL_NET'); near(run.turnoverUsd, turnover, 'TURNOVER');
  near(run.netPnlUsd, weekly.reduce((sum, row) => sum + row.weeklyNetUsd, 0), 'WEEKLY_NET_TELESCOPE');
  equal([run.buys, run.sells, run.closedEpisodes, run.investedWeeks], [buyCount, sellCount, episodes, invested], 'COUNTS');
  equal([run.terminalFlat, run.accountDrawdownHalted], [quantity === 0, halted], 'TERMINAL_AND_HALT_STATUS');
  near(run.maxWeeklyCloseDrawdownUsd, drawdown, 'CLOSE_TO_CLOSE_DRAWDOWN');
  near(run.sampledPeakToWeeklyLowUsd, lowDiagnostic, 'SAMPLED_PEAK_LOW_DIAGNOSTIC', .10001 * maxNotional / 100 + 2e-8);
  near(run.maximumMarkedNotionalUsd, maxNotional, 'HIGH_MARKED_EXPOSURE');
  const hurdle = 100 * .05 * (run.endMs - run.startMs) / (365.25 * 86400000);
  near(run.fivePercentInitialBudgetHurdleUsd, hurdle, 'FULL_CALENDAR_HURDLE');
  near(run.netAboveAllocatedCapitalHurdleUsd, run.netPnlUsd - hurdle, 'NET_VERSUS_HURDLE');
  near(run.netReturnOnInitialEntryBudgetFraction, run.netPnlUsd / 100, 'SLEEVE_NET_RATIO');
  near(run.drawdownOnInitialEntryBudgetFraction, drawdown / 100, 'SLEEVE_DRAWDOWN_RATIO');
  near(run.netAccountReturnFraction, run.netPnlUsd / 100000, 'ACCOUNT_NET_RATIO');
  if (run.policy === 'buy-hold') {
    const first = rows.find(b => b.volume > 0);
    assert(orders.length === 2 && orders[0].timestampMs === first.openMs && orders[1].timestampMs === rows.at(-1).openMs,
      'BUY_HOLD_INDEPENDENT_START_AND_FIXED_UNITS');
    near(orders[0].quantity, orders[1].quantity, 'BUY_HOLD_FIXED_UNITS', 0);
  }
  runAudits.push({ file, cashReconciled: true, sourceWeeks: rows.length, fills: orders.length,
    exactDecimalCashResidualUsd: run.finalCashUsd - number(exactCash), closedEpisodes: episodes });
}

const primary = ['base', 'stress'].map(s => runMap.get(`full-${s}-trend.json`));
const stressHold = runMap.get('full-stress-buy-hold.json');
const expectedChecks = {
  allRunsTerminalFlat: [...runMap.values()].every(r => r.terminalFlat),
  bothPrimaryScenariosPositive: primary.every(r => r.netPnlUsd > 0),
  enoughEpisodesInEachScenario: primary.every(r => r.closedEpisodes >= 8),
  lessStressDollarDrawdownThanBuyHold: primary[1].maxWeeklyCloseDrawdownUsd < stressHold.maxWeeklyCloseDrawdownUsd,
  noAccountDrawdownHalt: primary.every(r => !r.accountDrawdownHalted),
  netExceedsAllocatedCapitalHurdleBothScenarios: primary.every(r => r.netAboveAllocatedCapitalHurdleUsd > 0),
};
equal(report.checks, expectedChecks, 'FROZEN_ECONOMIC_SCREEN');
equal(report.researchPaperEligible, Object.values(expectedChecks).every(Boolean), 'RESEARCH_ELIGIBILITY_IS_EXACT_SCREEN');
// Independent moving-block resampling of the primary series only, with the frozen LCG sequence.
const panel = primary[0].weekly.map(row => row.weeklyNetUsd), outcomes = [];
let random = BigInt(D.bootstrap.seed), countBlocks = panel.length - 13 + 1;
for (let repetition = 0; repetition < 2000; repetition++) {
  const resampled = [];
  while (resampled.length < panel.length) {
    random = (1664525n * random + 1013904223n) % 4294967296n;
    const start = Math.floor(Number(random) / 4294967296 * countBlocks);
    resampled.push(...panel.slice(start, start + 13));
  }
  outcomes.push(resampled.slice(0, panel.length).reduce((sum, value) => sum + value, 0) / panel.length);
}
outcomes.sort((a, b) => a - b);
const lower = outcomes[Math.floor(1999 * .05)];
near(report.bootstrap.lowerMeanWeeklyNetUsd, lower, 'INDEPENDENT_BLOCK_BOOTSTRAP', 1e-12);
equal([report.bootstrap.completeWeeks, report.bootstrap.blocks], [panel.length, countBlocks], 'BOOTSTRAP_PANEL');
equal(report.lowerBootstrapMeanPositive, lower > 0, 'UNCERTAINTY_CAVEAT_RETAINED');
for (const field of ['provenProfitable', 'independentValidationPassed', 'liveTradingAllowed', 'runtimeActivated'])
  equal(report[field], false, `NO_UNSUPPORTED_CLAIM:${field}`);
for (const [path, hash] of Object.entries(fileHashes)) equal(sha(await readFile(join(root, path))), hash, `UNCHANGED_DURING_AUDIT:${path}`);
const audit = { version: 'independent-spot-trend-audit-v1', auditedAtUtc: new Date().toISOString(),
  passed: true, checks, fileHashes, studyDirectory: studyRoot, dataDirectory: dataRoot,
  strategyVersion: S.version, researchPaperEligible: report.researchPaperEligible,
  applicationModulesImported: false, exactDecimalCashReconciled: true, greatestNumericResidual,
  runs: runAudits, bootstrapLowerMeanWeeklyNetUsd: lower,
  provenProfitable: false, independentProspectiveValidationPassed: false, liveTradingAllowed: false,
  limitations: ['Mathematical and source consistency is not a guarantee of executable or future profit.',
    'Historical market prices were already known; this audit is not an untouched strategy holdout.',
    'Weekly proxy fills, unknown intraperiod price order and current fee assumptions retain all report limitations.',
    'Buy-and-hold has the same initial purchase budget but is not exposure- or risk-matched.',
    'The negative lower bootstrap mean remains inconclusive even when the small research-paper nomination screen passes.'] };
await writeFile(join(root, base, 'audit.json'), JSON.stringify(audit, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ passed: true, checks, runs: runAudits.length,
  fills: runAudits.reduce((n, run) => n + run.fills, 0), fileHashes: Object.keys(fileHashes).length,
  bootstrapLowerMeanWeeklyNetUsd: lower, output: `${base}/audit.json` }) + '\n');
