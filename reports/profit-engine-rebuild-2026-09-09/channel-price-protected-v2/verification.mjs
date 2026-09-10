/** Independent, read-only channel ledger audit. No strategy/replay module is imported.
 * Run from repository root: node reports/profit-engine-rebuild-2026-09-09/channel/verification.mjs
 * Optional first argument is an independently sealed channel report directory.
 * Only this verification.json is written. Raw datasets are filtered before calculations.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = process.cwd();
const out = resolve(process.argv[2] ?? fileURLToPath(new URL('.', import.meta.url)));
const read = p => readFileSync(p);
const json = p => JSON.parse(read(p));
const hash = v => createHash('sha256').update(v).digest('hex');
const protocol = json(join(out, 'protocol.json')), report = json(join(out, 'report.json'));
const S = protocol.strategy, D = protocol.study, H = 3600000, DAY = 86400000;
const protectedVariant = protocol.variant === 'price-protected-v2';
const cutoff = Date.UTC(2025, 6, 1), failures = [], findings = [];
let checks = 0;
const check = (ok, message, detail) => { checks++; if (!ok) failures.push({ message, ...(detail === undefined ? {} : { detail }) }); };
const same = (a, b, label, tolerance = 1e-6) => check(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance, label, { actual: a, expected: b });
const key = (s, t) => `${s}:${t}`;
const finite15 = x => Number(x.toPrecision(15));
const sum = xs => xs.reduce((a, b) => a + b, 0);
check(D.windows.at(-1).endMs === cutoff && cutoff < D.reservedStartMs, 'Only declared development windows permitted');
check(Date.parse(protocol.frozenAtUtc) <= Date.parse(report.generatedAtUtc), 'Declared seal precedes report generation');
if (protectedVariant) {
  const original = json(join(root, 'reports/profit-engine-rebuild-2026-09-09/channel/protocol.json'));
  check(JSON.stringify(D) === JSON.stringify(original.study), 'V2 preserves every original financial acceptance and study gate');
  for (const [field, value] of Object.entries(original.strategy)) if (field !== 'version')
    check(JSON.stringify(S[field]) === JSON.stringify(value), `V2 preserves original strategy control ${field}`);
  check(hash(read(join(out, 'v1-parity.json'))) === protocol.v1ParitySha256, 'Sealed V1 parity artifact hash');
}
const frozenHashes = {};
for (const [p, expected] of Object.entries(protocol.sourceHashes)) {
  const actual = hash(read(join(out, 'sources', p))); frozenHashes[p] = actual;
  check(actual === expected && report.sourceHashes[p] === expected, `Frozen source SHA256 ${p}`);
}
const barsByKey = new Map(), ratesByKey = new Map(), sourceAudit = [];
let duplicateBars = 0, duplicateRates = 0;
for (const input of protocol.inputs) {
  const dir = join(root, input.path), bytes = read(join(dir, 'dataset.json'));
  const manifestBytes = read(join(dir, 'manifest.json')), manifest = JSON.parse(manifestBytes), dataset = JSON.parse(bytes);
  check(hash(bytes) === input.datasetSha256 && hash(bytes) === manifest.datasetSha256, `Dataset hash ${input.path}`);
  check(bytes.length === manifest.datasetBytes && hash(manifestBytes) === input.manifestSha256, `Manifest/size ${input.path}`);
  const rawBars = new Map(), rawRates = new Map(); let rawFiles = 0;
  for (const f of manifest.metadata.sourceFiles) {
    const b = read(join(dir, f.file)); rawFiles++;
    check(hash(b) === f.sha256 && b.length === f.bytes, `Raw file hash/size ${input.path}/${f.file}`);
    if (!/-candles-\d+\.json$/.test(f.file)) continue;
    const symbol = f.file.includes('XBT') ? 'BTC/USD' : 'ETH/USD';
    for (const r of JSON.parse(b).candles) {
      if (r.time < D.warmupStartMs || r.time >= cutoff) continue;
      const row = { symbol, openMs: r.time, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) };
      const k = key(symbol, r.time), prior = rawBars.get(k);
      check(!prior || JSON.stringify(prior) === JSON.stringify(row), `Conflicting raw candle ${k}`); rawBars.set(k, row);
    }
  }
  for (const member of manifest.metadata.funding.members) {
    const b = read(join(dir, member.file));
    check(hash(b) === member.sha256, `Funding CSV hash ${input.path}/${member.file}`);
    const lines = b.toString('utf8').trim().split(/\r?\n/);
    check(lines.shift().replace(/^\uFEFF/, '') === 'timestamp,tradeable,absolute_rate,relative_rate', 'Funding CSV header');
    for (const line of lines) {
      const [date, product, absolute, relative] = line.split(',');
      const sourceAt = Date.parse(date.replace(' ', 'T') + 'Z'), end = sourceAt + H;
      if (end <= D.warmupStartMs || end > cutoff) continue;
      check(product === (member.symbol === 'BTC/USD' ? 'PF_XBTUSD' : 'PF_ETHUSD'), `Funding product ${product}`);
      const row = { symbol: member.symbol, timestampMs: end, rate: Number(relative), absoluteRate: Number(absolute) };
      const k = key(member.symbol, end), prior = rawRates.get(k);
      check(!prior || JSON.stringify(prior) === JSON.stringify(row), `Conflicting raw funding ${k}`); rawRates.set(k, row);
    }
  }
  let selectedBars = 0, selectedRates = 0;
  for (const row of dataset.bars) {
    if (row.openMs < D.warmupStartMs || row.openMs >= cutoff) continue;
    selectedBars++; const k = key(row.symbol, row.openMs), prior = barsByKey.get(k);
    check(JSON.stringify(rawBars.get(k)) === JSON.stringify(row), `Normalized candle matches raw ${k}`);
    if (prior) duplicateBars++;
    check(!prior || JSON.stringify(prior) === JSON.stringify(row), `Conflicting dataset candle ${k}`); barsByKey.set(k, row);
  }
  for (const row of dataset.funding) {
    if (row.timestampMs <= D.warmupStartMs || row.timestampMs > cutoff) continue;
    selectedRates++; const k = key(row.symbol, row.timestampMs), prior = ratesByKey.get(k);
    check(JSON.stringify(rawRates.get(k)) === JSON.stringify(row), `Normalized funding matches raw CSV plus hour ${k}`);
    if (prior) duplicateRates++;
    check(!prior || JSON.stringify(prior) === JSON.stringify(row), `Conflicting dataset funding ${k}`); ratesByKey.set(k, row);
  }
  sourceAudit.push({ path: input.path, rawFiles, selectedBars, selectedRates, datasetSha256: hash(bytes), manifestSha256: hash(manifestBytes) });
}
const bars = [...barsByKey.values()].sort((a, b) => a.openMs - b.openMs || a.symbol.localeCompare(b.symbol));
const funding = [...ratesByKey.values()].sort((a, b) => a.timestampMs - b.timestampMs || a.symbol.localeCompare(b.symbol));
const permittedSha = hash(JSON.stringify({ bars, funding }));
check(permittedSha === protocol.permittedDataSha256 && permittedSha === report.dataSha256, 'Permitted canonical data hash');
check(bars.length === protocol.barRows && funding.length === protocol.fundingRows, 'Permitted row counts');

// Independently aggregate only complete UTC days, then compute past-only breakout
// levels and Wilder ATR. No execution-hour high/low enters these signal inputs.
const dailyBySymbol = new Map(), signals = new Map();
for (const symbol of S.symbols) {
  const daily = [];
  let previousClose, previousDay, atr, seed = [];
  for (let day = D.warmupStartMs; day < cutoff; day += DAY) {
    const hours = Array.from({ length: 24 }, (_, i) => barsByKey.get(key(symbol, day + i * H)));
    if (hours.some(x => !x)) continue;
    if (previousDay !== day - DAY) { previousClose = undefined; atr = undefined; seed = []; }
    const high = Math.max(...hours.map(x => x.high)), low = Math.min(...hours.map(x => x.low));
    const close = hours[23].close;
    const tr = Math.max(high - low, previousClose === undefined ? 0 : Math.abs(high - previousClose), previousClose === undefined ? 0 : Math.abs(low - previousClose));
    if (atr === undefined) { seed.push(tr); if (seed.length === S.atrDays) atr = sum(seed) / S.atrDays; }
    else atr = (atr * (S.atrDays - 1) + tr) / S.atrDays;
    const row = { symbol, end: day + DAY, close, high, low, volume: sum(hours.map(x => x.volume)), atr };
    const prior = daily.slice(-S.entryLookbackDays);
    if (prior.length === S.entryLookbackDays && prior.every((x, i) => x.end === day - (prior.length - 1 - i) * DAY) && atr > 0 && row.volume > 0) {
      const channelHigh = Math.max(...prior.map(x => x.high)), channelLow = Math.min(...prior.map(x => x.low));
      const exitDays = prior.slice(-S.exitLookbackDays);
      signals.set(key(symbol, row.end), { ...row, channelHigh, channelLow,
        side: close > channelHigh ? 1 : close < channelLow ? -1 : null,
        longExit: close < Math.min(...exitDays.map(x => x.low)), shortExit: close > Math.max(...exitDays.map(x => x.high)) });
    }
    daily.push(row); previousClose = close; previousDay = day;
  }
  dailyBySymbol.set(symbol, daily.length);
}

function auditRun(run, filename) {
  const before = failures.length, label = s => `${filename}: ${s}`;
  const feeRate = S.feesBps[run.scenario] / 10000, slip = S.adverseSlippageBps[run.scenario] / 10000;
  const delay = S.executionDelayHoursAfterDayClose[run.scenario] * H;
  const execution = (ref, side, symbol) => {
    const raw = ref * (1 + side * slip) / S.ticks[symbol];
    return finite15((side > 0 ? Math.ceil(raw - 1e-10) : Math.floor(raw + 1e-10)) * S.ticks[symbol]);
  };
  const positions = new Map(), openEvents = new Map(), endEvents = new Map(), latestSignal = new Map(), lastStop = new Map();
  const entryAudit = [], episodes = [], fundingBounds = [], liquidationHours = [];
  let cash = S.initialEquityUsd, fees = 0, gross = 0, funded = 0, fundsHeldHours = 0;
  let peak = cash, dd = 0, envelope = 0, maxGross = 0, maxEntryRisk = 0, priorDayEquity = cash;
  let sessionEquity = cash, priorHourEquity = cash;
  const equityAt = new Map([[run.startMs, cash]]);
  const endReasons = new Set(['PROTECTIVE_INTRAHOUR_TOUCH', 'ACCOUNT_RISK_FLATTEN']);
  const seen = new Set();
  for (const [i, order] of run.orders.entries()) {
    check(order.atMs >= run.startMs && order.atMs <= run.endMs && order.atMs % H === 0, label(`Order time ${i}`));
    const isEnd = endReasons.has(order.reason);
    const map = isEnd ? endEvents : openEvents, at = isEnd ? order.atMs - H : order.atMs;
    const group = map.get(at) ?? []; group.push({ ...order, index: i }); map.set(at, group);
  }
  check(run.endMs <= cutoff, label('No reserved performance'));
  check(run.hourly.length === (run.endMs - run.startMs) / H, label('Every hourly mark retained'));
  for (let t = run.startMs, hi = 0; t < run.endMs; t += H, hi++) {
    if (t % DAY === 0) sessionEquity = priorHourEquity;
    const hour = s => barsByKey.get(key(s, t));
    for (const symbol of S.symbols) {
      const signal = signals.get(key(symbol, t - delay));
      if (!signal) continue;
      latestSignal.set(symbol, signal);
      const p = positions.get(symbol);
      if (p && run.policy === 'channel') {
        const proposed = signal.close - p.side * S.stopAtr * signal.atr;
        p.stop = p.side > 0 ? Math.max(p.stop, proposed) : Math.min(p.stop, proposed);
        p.channelExit ||= p.side > 0 ? signal.longExit : signal.shortExit;
      }
    }
    const markValue = field => cash + sum([...positions.values()].map(p => p.side * p.qty * (hour(p.symbol)[field] - p.entryPx)));
    const applyOrder = (o, closingHour) => {
      check(!seen.has(o.index), label(`Order applied once ${o.index}`)); seen.add(o.index);
      const b = hour(o.symbol), p = positions.get(o.symbol), lot = S.lots[o.symbol];
      check(b && b.volume > 0, label(`Positive-volume source fill proxy ${o.index}`));
      check(o.qty > 0 && Math.abs(o.qty / lot - Math.round(o.qty / lot)) < 1e-7, label(`Valid lot ${o.index}`));
      same(o.feeUsd, o.qty * o.price * feeRate, label(`Full independent fee ${o.index}`));
      let reference = b.open;
      if (o.reason === 'PROTECTIVE_INTRAHOUR_TOUCH') {
        check(p && (p.side > 0 ? b.low <= p.stop : b.high >= p.stop), label(`Stop touched ${o.index}`)); reference = p.stop;
      } else if (o.reason === 'ACCOUNT_RISK_FLATTEN' && closingHour) reference = p.side > 0 ? b.low : b.high;
      else if (o.reason === 'PROTECTIVE_OPEN_GAP') check(p && p.side * (b.open - p.stop) <= 0, label(`Opening gap ${o.index}`));
      else if (o.reason === 'OPPOSITE_20_DAY_CHANNEL') check(p?.channelExit, label(`Completed channel exit ${o.index}`));
      else if (o.reason === 'TERMINAL_FLATTEN') check(t >= run.endMs - S.finalFlattenLeadHours * H, label(`Terminal exit time ${o.index}`));
      same(o.price, execution(reference, o.side, o.symbol), label(`Adverse ticked execution from causal reference ${o.index}`), 1e-8);
      fees += o.feeUsd;
      if (!o.reduceOnly) {
        check(!p && !closingHour, label(`Only new flat-to-position entry ${o.index}`));
        const s = run.policy === 'channel' ? latestSignal.get(o.symbol) : { end: run.startMs, atr: 1, side: 1 };
        check(s && s.side === o.side && s.end + delay <= t && t < s.end + DAY, label(`Mature unexpired signal ${o.index}`));
        check(s.end + S.finalizationLagMs <= t && t < run.endMs - S.noNewEntryLeadHours * H, label(`Finalization and terminal entry restriction ${o.index}`));
        check(s.end > (lastStop.get(o.symbol) ?? -Infinity), label(`No same-signal stop reentry ${o.index}`));
        const equity = markValue('open'), cap = Math.min(S.maximumLegNotionalUsd, equity * S.maximumLegEquityFraction);
        const existingRisk = sum([...positions.values()].map(q => q.qty * (Math.max(0, q.side * (hour(q.symbol).open - q.stop)) + hour(q.symbol).open * 2 * (feeRate + slip))));
        let initialStop = o.price - o.side * S.stopAtr * s.atr, stopDistance = S.stopAtr * s.atr;
        let independentProtection;
        if (protectedVariant && run.policy === 'channel') {
          initialStop = s.close - o.side * S.stopAtr * s.atr;
          stopDistance = o.side * (o.price - initialStop);
          independentProtection = { signalEndMs: s.end, signalClose: s.close, signalAtr: s.atr,
            fixedStopPx: initialStop, actualEntryStopDistance: stopDistance, entryDisplacementAtr: Math.abs(o.price - s.close) / s.atr };
          check(independentProtection.entryDisplacementAtr <= S.maximumEntryDisplacementAtr + 1e-12, label(`V2 fill within declared signal ATR displacement ${o.index}`));
          check(initialStop > 0 && stopDistance >= S.ticks[o.symbol] - 1e-12, label(`V2 signal-anchored stop on correct side ${o.index}`));
          check(Boolean(o.entryProtection), label(`V2 protection evidence retained ${o.index}`));
          for (const [field, value] of Object.entries(independentProtection)) same(value, o.entryProtection?.[field], label(`V2 independent protection ${o.index} ${field}`));
        }
        const unitRisk = stopDistance + o.price * 2 * (feeRate + slip);
        const clusterRisk = existingRisk + o.qty * unitRisk;
        maxEntryRisk = Math.max(maxEntryRisk, clusterRisk);
        check(o.qty * o.price <= cap + 1e-7, label(`Entry notional cap ${o.index}`));
        if (run.policy === 'channel') {
          check(o.qty * unitRisk <= equity * S.riskFractionPerAsset + 1e-7, label(`Per-asset stop risk ${o.index}`));
          check(clusterRisk <= equity * S.maximumClusterRiskFraction + 1e-7, label(`Cluster stop risk ${o.index}`));
          check(o.qty * o.price + sum([...positions.values()].map(q => q.qty * hour(q.symbol).open)) <= S.maximumGrossUsd + 1e-7, label(`Gross entry cap ${o.index}`));
          const rolling = equityAt.get(t - DAY) ?? S.initialEquityUsd;
          const headroom = Math.min(equity - sessionEquity * (1 - S.sessionLossFraction), equity - rolling * (1 - S.rolling24HourLossFraction), equity - peak * (1 - S.maximumAccountDrawdownFraction));
          check(clusterRisk <= headroom + 1e-7, label(`Remaining loss budget ${o.index}`));
          const grossRemaining = Math.max(0, S.maximumGrossUsd - sum([...positions.values()].map(q => q.qty * hour(q.symbol).open)));
          const unrounded = Math.min(cap / o.price, grossRemaining / o.price,
            equity * S.riskFractionPerAsset / unitRisk, Math.max(0, equity * S.maximumClusterRiskFraction - existingRisk) / unitRisk,
            Math.max(0, headroom - existingRisk) / unitRisk);
          same(o.qty, finite15(Math.floor(unrounded / lot + 1e-10) * lot), label(`Exact risk-and-cap quantity with downward lot rounding ${o.index}`), 1e-12);
        }
        same(o.grossPnlUsd, 0, label(`Entry has no realized gain ${o.index}`));
        cash -= o.feeUsd;
        positions.set(o.symbol, { symbol: o.symbol, side: o.side, qty: o.qty, entryQty: o.qty, entryPx: o.price, entryMs: t,
          stop: initialStop, gross: 0, fees: o.feeUsd, funding: 0, reductions: 0, independentProtection });
        if (run.policy === 'channel') entryAudit.push({ orderIndex: o.index, symbol: o.symbol, side: o.side, entryMs: t,
          signalEndMs: s.end, signalInputMaximumMs: s.end - H, signalClose: s.close,
          previous55DayBoundary: o.side > 0 ? s.channelHigh : s.channelLow,
          entryReferenceOpen: b.open, executedPrice: o.price, delayedBeyondScheduledHour: t > s.end + delay,
          executableOpenStillBeyondBreakout: o.side > 0 ? b.open > s.channelHigh : b.open < s.channelLow,
          entryHourTotalVolumeUsedRetrospectively: true, ...(independentProtection ? { independentlyVerifiedProtection: independentProtection } : {}) });
      } else {
        check(p && o.side === -p.side && o.qty <= p.qty + 1e-10, label(`Reduction cannot increase/reverse exposure ${o.index}`));
        const pnl = p.side * o.qty * (o.price - p.entryPx);
        same(o.grossPnlUsd, pnl, label(`Realized fixed-entry-basis gross ${o.index}`));
        cash += pnl - o.feeUsd; gross += pnl; p.gross += pnl; p.fees += o.feeUsd;
        p.qty = finite15(p.qty - o.qty);
        if (o.reason.startsWith('PROTECTIVE_')) lastStop.set(o.symbol, o.atMs);
        if (p.qty <= lot * 1e-6) {
          const e = { symbol: p.symbol, side: p.side, entryMs: p.entryMs, exitMs: o.atMs, entryQty: p.entryQty, entryPx: p.entryPx,
            reason: o.reason, reductions: p.reductions, grossPnlUsd: p.gross, feeUsd: p.fees, fundingCashUsd: p.funding,
            netPnlUsd: p.gross - p.fees + p.funding };
          const expected = run.episodes[episodes.length];
          check(Boolean(expected), label(`Episode present ${episodes.length}`));
          for (const [field, value] of Object.entries(e)) typeof value === 'number' ? same(value, expected[field], label(`Episode ${episodes.length} ${field}`)) : check(value === expected[field], label(`Episode ${episodes.length} ${field}`));
          if (p.independentProtection) for (const [field, value] of Object.entries(p.independentProtection))
            same(value, expected.entryProtection?.[field], label(`Episode ${episodes.length} protection ${field}`));
          episodes.push(e); positions.delete(o.symbol);
        } else p.reductions++;
      }
    };
    for (const o of openEvents.get(t) ?? []) applyOrder(o, false);
    const closers = endEvents.get(t) ?? [];
    const stopped = new Set(closers.filter(o => o.reason === 'PROTECTIVE_INTRAHOUR_TOUCH').map(o => o.symbol));
    // Full intervals are held at constant post-opening quantity; no fee or trade
    // notional is mixed into funding. Ambiguous stop timing is explicitly a bound.
    for (const p of positions.values()) {
      const rate = ratesByKey.get(key(p.symbol, t + H));
      check(Boolean(rate), label(`Held interval has funding ${p.symbol}:${t}`));
      const continuous = -p.side * p.qty * rate.absoluteRate;
      const applied = stopped.has(p.symbol) ? Math.min(0, continuous) : continuous;
      if (stopped.has(p.symbol)) fundingBounds.push({ symbol: p.symbol, intervalStartMs: t, intervalEndMs: t + H,
        qty: p.qty, fullHourSignedFundingUsd: continuous, conservativeAppliedUsd: applied,
        exactStopTimeObserved: false });
      cash += applied; funded += applied; p.funding += applied; fundsHeldHours++;
    }
    // The reported downside envelope is measured after stop cash settlement and
    // before any account-risk flatten. It is not synchronized high-to-low drawdown.
    for (const o of closers.filter(o => o.reason === 'PROTECTIVE_INTRAHOUR_TOUCH')) applyOrder(o, true);
    const worst = cash + sum([...positions.values()].map(p => p.side * p.qty * ((p.side > 0 ? hour(p.symbol).low : hour(p.symbol).high) - p.entryPx)));
    envelope = Math.max(envelope, peak - worst);
    for (const o of closers.filter(o => o.reason !== 'PROTECTIVE_INTRAHOUR_TOUCH')) applyOrder(o, true);
    const marked = markValue('close');
    const liquidation = cash + sum([...positions.values()].map(p => {
      const exit = execution(hour(p.symbol).close, -p.side, p.symbol);
      return p.side * p.qty * (exit - p.entryPx) - p.qty * exit * feeRate;
    }));
    peak = Math.max(peak, liquidation); dd = Math.max(dd, peak - liquidation); envelope = Math.max(envelope, dd);
    const notional = sum([...positions.values()].map(p => p.qty * hour(p.symbol).close)); maxGross = Math.max(maxGross, notional);
    const expected = run.hourly[hi];
    check(expected.atMs === t + H, label(`Hourly timestamp ${hi}`));
    same(cash, expected.cashEquityUsd, label(`Hourly cash ${hi}`));
    same(marked, expected.markedEquityUsd, label(`Hourly marked equity ${hi}`));
    same(notional, expected.grossNotionalUsd, label(`Hourly fixed-unit notional ${hi}`));
    liquidationHours.push(liquidation); priorHourEquity = marked; equityAt.set(t + H, marked);
    if ((t + H) % DAY === 0) {
      const i = (t + H - run.startMs) / DAY - 1, expectedDay = run.dailyNetPnlUsd[i];
      check(expectedDay.dayStartMs === t + H - DAY, label(`Daily timestamp ${i}`));
      same(marked - priorDayEquity, expectedDay.netPnlUsd, label(`Daily cumulative mark difference ${i}`)); priorDayEquity = marked;
    }
  }
  check(seen.size === run.orders.length && positions.size === 0, label('All orders consumed and terminal flat'));
  check(run.orderCount === seen.size && run.closedEpisodes === episodes.length && run.accountingKnown, label('Reported completeness'));
  same(gross, run.grossPnlUsd, label('Total realized gross'));
  same(fees, run.feeUsd, label('All independent entry and exit fees'));
  same(funded, run.fundingCashUsd, label('Continuous funding including adverse stop bound'));
  same(gross - fees + funded, run.netPnlUsd, label('Final realized gross plus funding minus fees'));
  same(cash - S.initialEquityUsd, run.netPnlUsd, label('Final cash change'));
  same(sum(run.dailyNetPnlUsd.map(d => d.netPnlUsd)), run.netPnlUsd, label('Daily mark changes telescope to final net'));
  same(dd, run.maxDrawdownUsd, label('Hourly liquidation-close drawdown'));
  same(envelope, run.conservativeDrawdownEnvelopeUsd, label('Disclosed independent-extrema downside envelope'));
  same(maxGross, run.maximumGrossUsd, label('Maximum hourly gross'));
  same(maxEntryRisk, run.maximumEntryRiskUsd, label('Maximum entry cluster risk'));
  if (run.policy !== 'channel') check(run.orders.length === 2 && episodes.length === 1 && run.orders[0].side === 1, label('Costed benchmark has one fixed-quantity long path'));
  const summary = { filename, policy: run.policy, scenario: run.scenario, startMs: run.startMs, endMs: run.endMs,
    passed: failures.length === before, orders: run.orders.length, episodes: episodes.length, hourlyMarks: run.hourly.length,
    heldSymbolHours: fundsHeldHours, realizedGrossUsd: gross, fullFeesUsd: fees, fundingCashBoundUsd: funded,
    netPnlUsd: gross - fees + funded, hourlyLiquidationCloseDrawdownUsd: dd, adverseExtremaEnvelopeUsd: envelope,
    maximumGrossUsd: maxGross, maximumEntryRiskUsd: maxEntryRisk, entryAudit, ambiguousStopFundingIntervals: fundingBounds };
  return { summary, run, liquidationHours };
}

const audited = [];
for (const window of D.windows) for (const scenario of D.scenarios) for (const policy of ['channel', 'buy-hold-btc', 'buy-hold-eth']) {
  const filename = `${window.id}-${scenario}-${policy}.json`, run = json(join(out, filename));
  audited.push(auditRun(run, filename));
  const summary = [...report.runs, ...report.benchmarks].find(r => r.startMs === run.startMs && r.scenario === scenario && r.policy === policy);
  check(Boolean(summary), `${filename}: present in main report`);
  for (const [k, v] of Object.entries(summary)) check(JSON.stringify(v) === JSON.stringify(run[k]), `${filename}: report summary ${k}`);
}
const combinedBenchmarks = [];
for (const window of D.windows) for (const scenario of D.scenarios) {
  const legs = audited.filter(r => r.run.startMs === window.startMs && r.run.scenario === scenario && r.run.policy !== 'channel');
  let peak = S.initialEquityUsd, drawdown = 0;
  for (let i = 0; i < legs[0].liquidationHours.length; i++) {
    const equity = S.initialEquityUsd + sum(legs.map(r => r.liquidationHours[i] - S.initialEquityUsd));
    peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity);
  }
  combinedBenchmarks.push({ period: window.id, scenario, construction: 'Sum of two independently reported constant-unit long perpetual paths, each with at-most-$1000 entry notional, against one $100000 cash account; descriptive, not risk matched.',
    netPnlUsd: sum(legs.map(x => x.summary.netPnlUsd)), realizedGrossUsd: sum(legs.map(x => x.summary.realizedGrossUsd)),
    feesUsd: sum(legs.map(x => x.summary.fullFeesUsd)), fundingUsd: sum(legs.map(x => x.summary.fundingCashBoundUsd)),
    synchronizedHourlyLiquidationCloseDrawdownUsd: drawdown });
}
const candidates = audited.filter(x => x.run.policy === 'channel'), base = candidates.filter(x => x.run.scenario === 'base');
// Independent calculation of the declared weekly block statistic, using audited
// daily marks. This verifies published statistics; it does not evaluate a candidate.
const weeks = [], monday = Date.UTC(1970, 0, 5), WEEK = 7 * DAY;
for (const { run } of base) {
  const groups = new Map();
  for (const d of run.dailyNetPnlUsd) {
    const start = monday + Math.floor((d.dayStartMs - monday) / WEEK) * WEEK;
    const group = groups.get(start) ?? []; group.push(d); groups.set(start, group);
  }
  for (const [start, group] of groups) if (group.length === 7 && group.every((x, i) => x.dayStartMs === start + i * DAY))
    weeks.push({ windowStartMs: run.startMs, weekStartMs: start, netUsd: sum(group.map(x => x.netPnlUsd)) });
}
const blocks = weeks.flatMap((w, i) => {
  const b = weeks.slice(i, i + D.bootstrap.contiguousBlockWeeks);
  return b.length === D.bootstrap.contiguousBlockWeeks && b.every((x, j) => x.windowStartMs === w.windowStartMs && x.weekStartMs === w.weekStartMs + j * WEEK) ? [b.map(x => x.netUsd)] : [];
});
let seed = D.bootstrap.seed;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const samples = [];
for (let i = 0; i < D.bootstrap.repetitions; i++) {
  const sample = []; while (sample.length < weeks.length) sample.push(...blocks[Math.floor(random() * blocks.length)]);
  samples.push(sum(sample.slice(0, weeks.length)) / weeks.length);
}
samples.sort((a, b) => a - b);
const lower = samples[Math.floor(D.bootstrap.lowerQuantile * (samples.length - 1))];
check(JSON.stringify(weeks) === JSON.stringify(report.bootstrap.weeks), 'Complete Monday weekly group membership and net');
check(weeks.length === report.bootstrap.completeWeeks && blocks.length === report.bootstrap.validBlocks, 'Weekly bootstrap valid counts');
same(lower, report.bootstrap.lowerMeanWeeklyNetUsd, 'Declared seeded four-week-block bootstrap lower mean');
const gates = { allRunsAccounted: candidates.length === 4 && candidates.every(x => x.run.accountingKnown),
  bothPeriodsPositiveBaseAndStress: candidates.length === 4 && candidates.every(x => x.summary.netPnlUsd > 0),
  enoughEpisodes: sum(base.map(x => x.summary.episodes)) >= D.minimumClosedEpisodesTotal,
  lowerBootstrapWeeklyNetPositive: lower > 0 };
check(JSON.stringify(gates) === JSON.stringify(report.checks), 'Declared acceptance checks');
check(Object.values(gates).every(Boolean) === report.historicalDevelopmentEligible, 'Historical eligibility flag');
check(report.reserved2026Evaluated === false && report.runtimeActivated === false && report.futureProfitGuaranteed === false, 'Scope and non-guarantee flags');
const entries = candidates.flatMap(x => x.summary.entryAudit.map(e => ({ run: x.summary.filename, ...e })));
const stale = entries.filter(e => !e.executableOpenStillBeyondBreakout);
if (stale.length) findings.push({ severity: 'MODEL_DESIGN_LIMITATION', code: 'DELAYED_ENTRY_NO_LONGER_BEYOND_COMPLETED_BREAKOUT',
  detail: 'The candidate authorizes a daily close signal for execution after a delay without requiring the current executable open still exceed the historical channel. Accounting is valid, but some fills enter after that breakout has reversed. This must not be described as guaranteed profitable entry selection.', count: stale.length, entries: stale });
if (!gates.lowerBootstrapWeeklyNetPositive) findings.push({ severity: 'STATISTICAL_ACCEPTANCE_FAILED', code: 'LOWER_WEEKLY_BOOTSTRAP_NOT_POSITIVE',
  lowerMeanWeeklyNetUsd: lower,
  detail: 'The independently recomputed lower 5% mean weekly net from the declared four-week block bootstrap is nonpositive. Positive individual historical windows do not satisfy the original acceptance rule. No gate change, reserved-data test or activation is justified by this result.' });
findings.push({ severity: 'EXECUTION_EVIDENCE_LIMITATION', code: 'RETROSPECTIVE_HOURLY_VOLUME_PROXY',
  detail: 'The frozen source uses the completed execution-hour volume to permit an opening-price fill. That hour volume is unknown at the open, so strict executable entry causality is unproven despite past-only daily signals and adverse opening-price math. No historical order book, latency, queue or partial-fill proof exists.' });
findings.push({ severity: 'FUNDING_EVIDENCE_LIMITATION', code: 'FUNDING_PUBLICATION_TIME_ASSUMED',
  detail: 'Raw CSV timestamps plus one hour match every normalized rate. The archive and dataset label this start/end interpretation unverified; the strategy additionally assumes current-period rate availability at interval start. This audit verifies arithmetic under that declared mapping, not publication-time provenance.' });
findings.push({ severity: 'BOUND_NOT_EXACT_CASH', code: 'AMBIGUOUS_STOP_FUNDING',
  detail: 'For a touched intrahour stop, full-hour paying funding is charged and receiving funding is omitted. This is a conservative bound for unknown stop time. Other complete held intervals use signed quantity times absolute USD/base/hour rates exactly.' });
const result = { generatedAtUtc: new Date().toISOString(), verifier: 'Independent raw-source and reported-fill accounting audit; no replay import or call.',
  scriptSha256: hash(read(new URL(import.meta.url))), protocolSha256: hash(read(join(out, 'protocol.json'))), reportSha256: hash(read(join(out, 'report.json'))),
  accountingAndDeclaredProtocolChecksPassed: failures.length === 0, executableCausalProfitabilityEstablished: false, checks, failures,
  numericalToleranceUsd: 1e-6, reserved2026PerformanceEvaluated: false, maximumCalculatedBarOpenMs: bars.at(-1).openMs,
  maximumCalculatedFundingEndMs: funding.at(-1).timestampMs, permittedDataSha256: permittedSha, duplicateBars, duplicateRates,
  sourceAudit, frozenHashes, completeDailyBars: Object.fromEntries(dailyBySymbol), runs: audited.map(x => x.summary),
  descriptiveTwoAssetBenchmarks: combinedBenchmarks, gates, bootstrap: { completeWeeks: weeks.length, validBlocks: blocks.length, lowerMeanWeeklyNetUsd: lower },
  findings, futureProfitGuaranteed: false };
writeFileSync(join(out, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ passed: result.accountingAndDeclaredProtocolChecksPassed, checks, failures: failures.length,
  runs: audited.length, fills: sum(audited.map(x => x.summary.orders)), staleBreakoutEntries: stale.length,
  verificationFile: join(out, 'verification.json'), firstFailures: failures.slice(0, 6) }, null, 2));
if (failures.length) process.exitCode = 1;
