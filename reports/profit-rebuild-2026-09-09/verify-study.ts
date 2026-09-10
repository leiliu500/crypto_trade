/** Independent accounting audit. Imports no strategy, replay or validation
 * implementation. It consumes only sealed artifacts and their public inputs. */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const H = 3_600_000, D = 24 * H, W = 7 * D, DELAY = 60_000;
const SYMBOLS = ["BTC/USD", "ETH/USD"];
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const hash = (value: unknown) => sha(JSON.stringify(value));
const load = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
type Any = Record<string, any>;

async function audit(directory: string) {
  const anomalies: string[] = [], maxErrors: Record<string, number> = {};
  let anomalyCount = 0;
  const check = (ok: boolean, message: string) => { if (!ok) { anomalyCount++; if (anomalies.length < 100) anomalies.push(message); } };
  const near = (actual: number, expected: number, field: string, label: string, tolerance = 1e-7) => {
    const error = Math.abs(actual - expected); maxErrors[field] = Math.max(maxErrors[field] ?? 0, error);
    check(Number.isFinite(error) && error <= Math.max(tolerance, Math.abs(expected) * 1e-9), `${label}:${field}:${actual}!=${expected}`);
  };
  const path = resolve(directory), protocol = await load(join(path, "protocol.json")), report = await load(join(path, "report.json"));
  const modelFile = await load(join(path, "models.json")), forecastFile = await load(join(path, "forecasts.json"));
  const fits: Any[] = modelFile.fits, forecasts: Any[] = forecastFile.forecasts;
  for (const [source, expected] of Object.entries(protocol.sourceHashes))
    check(sha(await readFile(join(path, "sources", source))) === expected, `SEALED_SOURCE_HASH:${source}`);
  check(hash(protocol.sourceHashes) === protocol.sourceSha256, "SOURCE_MANIFEST_HASH");
  check(report.sourceSha256 === protocol.sourceSha256, "REPORT_SOURCE_HASH");
  check(protocol.registeredAtMs <= Date.parse(report.generatedAt), "REGISTRATION_AFTER_REPORT");
  check(report.reservedDataEvaluated === false && protocol.study.reservedWindow.evaluated === false, "RESERVED_DATA_STATUS");
  check(report.runtimeActivated === false && report.guaranteedProfitable === false, "UNSUPPORTED_ACTIVATION_OR_PROFIT_CLAIM");
  const modelSpec = protocol.modelSpecification ?? protocol.strategy;
  const windows: Any[] = protocol.study.windows, start = windows[0]!.startMs, end = windows.at(-1)!.endMs;
  const barMap = new Map<string, Any>(), fundingMap = new Map<string, Any>();
  for (const source of protocol.dataSources) {
    check(sha(await readFile(join(source.directory, "dataset.json"))) === source.datasetSha256, `DATASET_HASH:${source.directory}`);
    check(sha(await readFile(join(source.directory, "manifest.json"))) === source.manifestSha256, `DATA_MANIFEST_HASH:${source.directory}`);
    const data = await load(join(source.directory, "dataset.json"));
    for (const row of data.bars) if (row.openMs >= protocol.study.historyStartMs && row.openMs < end) {
      const key = `${row.symbol}:${row.openMs}`, old = barMap.get(key);
      check(!old || hash(old) === hash(row), `CONFLICTING_BAR:${key}`); barMap.set(key, row);
    }
    for (const row of data.funding) if (row.timestampMs >= start && row.timestampMs <= end + H) {
      const key = `${row.symbol}:${row.timestampMs}`, old = fundingMap.get(key);
      check(!old || hash(old) === hash(row), `CONFLICTING_FUNDING:${key}`); fundingMap.set(key, row);
    }
  }
  const bars = [...barMap.values()].sort((a, b) => a.openMs - b.openMs || a.symbol.localeCompare(b.symbol));
  const funding = [...fundingMap.values()].sort((a, b) => a.timestampMs - b.timestampMs || a.symbol.localeCompare(b.symbol));
  check(hash({ bars, funding }) === protocol.dataSha256 && report.dataSha256 === protocol.dataSha256, "CANONICAL_STUDY_DATA_HASH");
  check(bars.every(b => b.openMs < end && b.openMs < protocol.study.reservedWindow.startMs), "FUTURE_BAR_ADMITTED");
  check(funding.every(f => f.timestampMs < protocol.study.reservedWindow.startMs), "FUTURE_FUNDING_ADMITTED");
  const buckets = new Map<string, { rows: Any[]; symbol: string; closeMs: number }>();
  for (const b of bars) {
    const closeMs = Math.floor(b.openMs / D) * D + D, key = `${b.symbol}:${closeMs}`;
    const bucket = buckets.get(key) ?? { rows: [], symbol: b.symbol, closeMs }; bucket.rows.push(b); buckets.set(key, bucket);
  }
  const closes = new Map<string, Any>();
  for (const [key, bucket] of buckets) if (bucket.rows.length === 24 && new Set(bucket.rows.map(b => b.openMs)).size === 24) {
    const last = bucket.rows.find(b => b.openMs === bucket.closeMs - H);
    if (last) closes.set(key, { symbol: bucket.symbol, closeMs: bucket.closeMs, close: last.close });
  }
  const sequence = (symbol: string, from: number, through: number): Any[] | null => {
    const rows: Any[] = [];
    for (let ms = from; ms <= through; ms += D) { const row = closes.get(`${symbol}:${ms}`); if (!row) return null; rows.push(row); }
    return rows;
  };
  const fitById = new Map(fits.map(f => [f.id, f])), forecastById = new Map(forecasts.map(f => [f.id, f]));
  check(fitById.size === fits.length && forecastById.size === forecasts.length, "DUPLICATE_MODEL_OR_FORECAST_ID");
  check(hash(fits) === modelFile.fitSha256, "MODELS_FILE_HASH");
  check(hash(forecasts) === forecastFile.forecastSha256, "FORECASTS_FILE_HASH");
  for (const fit of fits) {
    const { id, ...body } = fit;
    check(hash(body) === id, `MODEL_ID:${id}`);
    check(fit.specSha256 === hash(modelSpec), `MODEL_SPEC_HASH:${id}`);
    check(fit.maximumLabelAvailableAtMs <= fit.fitAtMs && fit.maximumLabelEndMs + D + DELAY <= fit.fitAtMs,
      `UNMATURED_MODEL_LABEL:${id}`);
    check(fit.fitAtMs < end && fit.validUntilMs <= end + DELAY, `MODEL_FUTURE_WINDOW:${id}`);
    const inputs = new Map<string, Any>(), origins: number[] = []; let excludedWeeks = 0;
    const fitClose = fit.fitAtMs - DELAY;
    for (let origin = fitClose - 365 * D; origin + 8 * D <= fitClose; origin += D) {
      if (new Date(origin).getUTCDay() !== 1) continue;
      const paired = SYMBOLS.map(symbol => sequence(symbol, origin - 90 * D, origin + 7 * D));
      if (paired.some(rows => !rows)) { excludedWeeks++; continue; }
      origins.push(origin + DELAY);
      for (const rows of paired) for (const row of rows!) inputs.set(`${row.symbol}:${row.closeMs}`, row);
    }
    const orderedInputs = [...inputs.values()].sort((a, b) => a.closeMs - b.closeMs || a.symbol.localeCompare(b.symbol));
    check(hash({ inputs: orderedInputs, origins }) === fit.inputSha256, `MODEL_TRAINING_INPUT_HASH:${id}`);
    check(fit.nWeeks === origins.length && fit.nRows === 2 * origins.length && fit.excludedWeeks === excludedWeeks, `MODEL_CLUSTER_COUNTS:${id}`);
    check(fit.firstOriginMs === origins[0] && fit.lastOriginMs === origins.at(-1), `MODEL_ORIGIN_RANGE:${id}`);
  }
  for (const f of forecasts) {
    const fit = fitById.get(f.modelId), used = sequence(f.symbol, f.decisionMs - DELAY - 90 * D, f.decisionMs - DELAY);
    check(Boolean(fit && used), `FORECAST_SOURCE_MISSING:${f.id}`); if (!fit || !used) continue;
    check(hash(used) === f.inputSha256 && f.modelInputSha256 === fit.inputSha256, `FORECAST_INPUT_HASH:${f.id}`);
    check(f.id === hash({ version: modelSpec.version, modelId: fit.id, symbol: f.symbol,
      decisionMs: f.decisionMs, inputSha256: f.inputSha256 }), `FORECAST_ID:${f.id}`);
    check(f.decisionMs < end && f.fitAtMs <= f.decisionMs && f.decisionMs < fit.validUntilMs
      && f.maximumLabelAvailableAtMs === fit.maximumLabelAvailableAtMs && f.maximumLabelEndMs === fit.maximumLabelEndMs,
      `FORECAST_CAUSAL_TIMES:${f.id}`);
    check(f.availableAtMs === f.decisionMs && f.expiresAtMs === f.decisionMs + 48 * H
      && f.horizonEndMs === f.decisionMs + W && (f.decisionMs - DELAY) % D === 0
      && new Date(f.decisionMs).getUTCDay() === 1 && f.winProbability === null, `FORECAST_METADATA:${f.id}`);
    const returns = used.slice(-30).map((c, i) => Math.log(c.close) - Math.log(used[used.length - 31 + i]!.close));
    const mean = returns.reduce((a, b) => a + b, 0) / 30;
    const sigma = Math.max(.005, Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / 29));
    const close = used.at(-1)!.close, clip = (n: number) => Math.min(3, Math.max(-3, n));
    const x = [1, clip((Math.log(close) - Math.log(used.at(-8)!.close)) / (sigma * Math.sqrt(7))),
      clip((Math.log(close) - Math.log(used[0]!.close)) / (sigma * Math.sqrt(90)))];
    for (let i = 0; i < 3; i++) near(f.features[i], x[i]!, "feature", f.id);
    near(f.sigmaDay, sigma, "sigmaDay", f.id); near(f.sigmaHorizon, sigma * Math.sqrt(7), "sigmaHorizon", f.id);
    const dot = (beta: number[]) => beta.reduce((sum, b, i) => sum + b * x[i]!, 0) * sigma * Math.sqrt(7) * 10_000;
    near(f.meanGrossBps, dot(fit.coefficients), "forecastMeanBps", f.id);
    const values = fit.bootstrapCoefficients.map(dot).sort((a: number, b: number) => a - b);
    for (const [name, q] of [["lowerGrossBps", .05], ["upperGrossBps", .95]] as const) {
      const at = (values.length - 1) * q, index = Math.floor(at), weight = at - index;
      near(f[name], values[index] * (1 - weight) + values[Math.ceil(at)] * weight, "forecastQuantileBps", f.id);
    }
  }
  const A = protocol.executionAssumptions, allRuns: Any[] = [];
  const runFiles = (await readdir(path)).filter(name => windows.some(w => name.startsWith(w.id + "-")) && name.endsWith(".json")).sort();
  check(runFiles.length === 24, "RUN_COUNT_NOT_24");
  for (const name of runFiles) {
    const r = await load(join(path, name)), feeBps = A.fees[r.scenario], slip = A.adverseSlippage[r.scenario] + A.spreadBps / 2;
    const atHour = new Map<number, Any[]>();
    check(r.startMs >= start && r.endMs <= end && r.endMs <= protocol.study.reservedWindow.startMs, `${name}:RUN_WINDOW`);
    for (const o of r.orders) {
      const hour = Math.floor(o.atMs / H) * H, list = atHour.get(hour) ?? []; list.push(o); atHour.set(hour, list);
    }
    const px = (raw: number, side: number, symbol: string) => {
      const tick = A.ticks[symbol], value = raw * (1 + side * slip / 10_000);
      return Number(((side === 1 ? Math.ceil(value / tick - 1e-10) : Math.floor(value / tick + 1e-10)) * tick).toPrecision(15));
    };
    let p: Any | undefined, cash = 0, totalGross = 0, totalFees = 0, totalFunding = 0, totalExposure = 0;
    let peak = A.initialEquityUsd, maxDrawdown = 0, lastDaily = 0, episodeIndex = 0, fundingHours = 0;
    const dailyCash = new Map<string, number>(), dailyExposure = new Map<string, number>();
    const plus = (map: Map<string, number>, key: string, amount: number) => map.set(key, (map.get(key) ?? 0) + amount);
    const addCash = (at: number, amount: number) => { cash += amount; plus(dailyCash, date(Math.min(at, r.endMs - 1)), amount); };
    const liquidation = (raw: number) => p ? p.side * p.qty * (px(raw, -p.side, p.symbol) - p.entryPx)
      - p.qty * px(raw, -p.side, p.symbol) * feeBps / 10_000 : 0;
    const mark = (raw?: number, accrual = 0) => {
      const value = cash + (p && raw !== undefined ? liquidation(raw) : 0) + accrual;
      peak = Math.max(peak, A.initialEquityUsd + value); maxDrawdown = Math.max(maxDrawdown, peak - A.initialEquityUsd - value);
      return value;
    };
    const fundingAmount = (hour: number, elapsed: number) => {
      if (!p || elapsed === 0) return 0;
      // Stored timestamp is the normalized interval END (source + 1 h).
      // The declared base assigns [end-1 h,end); the alternative shifts that
      // entire interval one hour earlier. Neither is a verified cash receipt.
      const timestamp = hour + H + (r.fundingAssumption === "source-as-end" ? H : 0);
      const row = fundingMap.get(`${p.symbol}:${timestamp}`);
      check(Number.isFinite(row?.absoluteRate), `${name}:MISSING_HELD_FUNDING:${p.symbol}:${hour}`);
      return -p.side * p.qty * row!.absoluteRate * elapsed / H;
    };
    const accrue = (hour: number, elapsed: number) => {
      if (!p || elapsed === 0) return;
      const amount = fundingAmount(hour, elapsed), exposure = p.qty * p.entryPx * elapsed / H;
      p.funding += amount; totalFunding += amount; totalExposure += exposure; fundingHours++;
      plus(dailyExposure, date(hour), exposure); addCash(hour + elapsed, amount);
    };
    const execute = (o: Any, hour: number) => {
      const ownBar = barMap.get(`${o.symbol}:${hour}`), forecast = forecastById.get(o.forecastId);
      check(Boolean(ownBar && ownBar.volume > 0 && forecast && forecast.decisionMs <= o.atMs), `${name}:ORDER_EVIDENCE`);
      near(o.qty / A.lots[o.symbol], Math.round(o.qty / A.lots[o.symbol]), "lotUnits", name);
      const fee = o.qty * o.price * feeBps / 10_000; near(o.feeUsd, fee, "orderFeeUsd", name);
      totalFees += fee; addCash(o.atMs, -fee);
      if (!o.reduceOnly) {
        check(!p, `${name}:OVERLAPPING_OR_ADDED_POSITION`);
        check(o.atMs % H === 0 && o.atMs >= forecast!.decisionMs && o.atMs <= forecast!.expiresAtMs, `${name}:ENTRY_TIME`);
        near(o.price, px(ownBar!.open, o.side, o.symbol), "executionPrice", name);
        check(o.qty * o.price <= Math.min(1000, (A.initialEquityUsd + cash + fee) * .01) + 1e-7, `${name}:ENTRY_CAP`);
        p = { symbol: o.symbol, side: o.side, qty: o.qty, entryQty: o.qty, entryPx: o.price, entryMs: o.atMs,
          stopPx: o.price * (1 - o.side * 4 * forecast!.sigmaDay), forecastId: o.forecastId,
          gross: 0, fee, funding: 0, turnover: o.qty * o.price, reductions: 0 };
        near(o.grossPnlUsd, 0, "orderGrossUsd", name);
      } else {
        check(Boolean(p && p.symbol === o.symbol && p.side === -o.side && o.qty <= p.qty + 1e-9), `${name}:INVALID_REDUCTION`);
        if (!p) return;
        const stopIntrabar = o.reason === "HARD_STOP_4_DAILY_SIGMA" && o.atMs % H !== 0;
        near(o.price, px(stopIntrabar ? p.stopPx : ownBar!.open, o.side, o.symbol), "executionPrice", name);
        const gross = p.side * o.qty * (o.price - p.entryPx);
        near(o.grossPnlUsd, gross, "orderGrossUsd", name); totalGross += gross; addCash(o.atMs, gross);
        p.gross += gross; p.fee += fee; p.turnover += o.qty * o.price; p.reductions++;
        p.qty = Number((p.qty - o.qty).toPrecision(15));
        if (p.qty < A.lots[p.symbol] / 2) {
          const trade = r.trades[episodeIndex++]; check(Boolean(trade), `${name}:MISSING_EPISODE`);
          if (trade) {
            for (const field of ["symbol", "side", "entryMs", "entryQty", "entryPx", "forecastId"])
              check(trade[field] === p[field], `${name}:EPISODE_IDENTITY:${field}`);
            near(trade.grossPnlUsd, p.gross, "episodeGrossUsd", name); near(trade.feeUsd, p.fee, "episodeFeeUsd", name);
            near(trade.fundingCashUsd, p.funding, "episodeFundingUsd", name);
            near(trade.netPnlUsd, p.gross - p.fee + p.funding, "episodeNetUsd", name);
            near(trade.turnoverUsd, p.turnover, "episodeTurnoverUsd", name);
            check(trade.exitMs === o.atMs && trade.exitPx === o.price && trade.reductions === p.reductions, `${name}:EPISODE_EXIT`);
          }
          p = undefined;
        }
      }
    };
    for (let hour = r.startMs; hour < r.endMs; hour += H) {
      const hourOrders = atHour.get(hour) ?? [];
      if (p) mark(barMap.get(`${p.symbol}:${hour}`)!.open); else mark();
      for (const o of hourOrders.filter(o => o.atMs === hour)) execute(o, hour);
      const later = hourOrders.filter(o => o.atMs !== hour);
      if (p) {
        const b = barMap.get(`${p.symbol}:${hour}`)!, favorable = p.side === 1 ? b.high : b.low, adverse = p.side === 1 ? b.low : b.high;
        mark(b.open);
        if (later.length) {
          check(later.length === 1 && later[0]!.atMs === hour + 2 * H / 3
            && later[0]!.reason === "HARD_STOP_4_DAILY_SIGMA", `${name}:UNDECLARED_INTRABAR_ORDER`);
          mark(favorable, fundingAmount(hour, H / 3)); accrue(hour, 2 * H / 3);
          for (const o of later) execute(o, hour); mark();
        } else {
          mark(favorable, fundingAmount(hour, H / 3)); mark(adverse, fundingAmount(hour, 2 * H / 3));
          mark(b.close, fundingAmount(hour, H)); accrue(hour, H); mark(b.close);
        }
      } else { check(later.length === 0, `${name}:ORPHAN_INTRABAR_ORDER`); mark(); }
      if ((hour + H) % D === 0) {
        const net = cash + (p ? liquidation(barMap.get(`${p.symbol}:${hour}`)!.close) : 0);
        const row = r.dailyNetPnlUsd[(hour + H - r.startMs) / D - 1];
        check(row?.date === date(hour), `${name}:DAILY_DATE`); near(row.netPnlUsd, net - lastDaily, "dailyNetUsd", name); lastDaily = net;
      }
    }
    check(!p && r.unresolvedPosition === null && r.accountingKnown === true, `${name}:UNRESOLVED_OR_UNKNOWN_ACCOUNTING`);
    check(episodeIndex === r.completedTrades && episodeIndex === r.trades.length && r.orderCount === r.orders.length, `${name}:ORDER_EPISODE_COUNTS`);
    check(fundingHours === r.fundingRequiredHours && fundingHours === r.fundingObservedHours && r.missingFundingHours === 0, `${name}:FUNDING_COUNTS`);
    for (const row of r.dailyNetPnlUsd) {
      near(row.knownCashPnlUsd, dailyCash.get(row.date) ?? 0, "dailyCashUsd", name);
      near(row.exposureNotionalHours, dailyExposure.get(row.date) ?? 0, "dailyExposure", name);
    }
    near(r.grossPnlUsd, totalGross, "runGrossUsd", name); near(r.feeUsd, totalFees, "runFeeUsd", name);
    near(r.fundingCashUsd, totalFunding, "runFundingUsd", name); near(r.netPnlUsd, cash, "runNetUsd", name);
    near(r.netPnlUsd, totalGross - totalFees + totalFunding, "runIdentityUsd", name);
    near(r.exposureNotionalHours, totalExposure, "runExposure", name); near(r.maxDrawdownUsd, maxDrawdown, "drawdownUsd", name);
    near(r.dailyNetPnlUsd.reduce((sum: number, row: Any) => sum + row.netPnlUsd, 0), cash, "calendarSumUsd", name);
    check(r.perAsset.length === 2 && new Set(r.perAsset.map((a: Any) => a.symbol)).size === 2, `${name}:ASSET_SET`);
    for (const symbol of SYMBOLS) {
      const own = r.perAsset.find((a: Any) => a.symbol === symbol), episodes = r.trades.filter((t: Any) => t.symbol === symbol);
      check(Boolean(own), `${name}:ASSET_MISSING:${symbol}`); if (!own) continue;
      for (const field of ["grossPnlUsd", "feeUsd", "fundingCashUsd", "netPnlUsd", "turnoverUsd"])
        near(own[field], episodes.reduce((sum: number, t: Any) => sum + t[field], 0), `asset:${field}`, name);
      check(own.completedTrades === episodes.length && own.orders === r.orders.filter((o: Any) => o.symbol === symbol).length,
        `${name}:ASSET_COUNTS:${symbol}`);
    }
    const summary = [...report.runs, ...report.benchmarks].find(s => s.policy === r.policy && s.startMs === r.startMs
      && s.scenario === r.scenario && s.fundingAssumption === r.fundingAssumption);
    check(Boolean(summary), `${name}:REPORT_SUMMARY_MISSING`);
    if (summary) for (const field of ["netPnlUsd", "grossPnlUsd", "feeUsd", "fundingCashUsd", "maxDrawdownUsd", "completedTrades", "orderCount"])
      check(summary[field] === r[field], `${name}:REPORT_SUMMARY:${field}`);
    allRuns.push({ file: name, policy: r.policy, scenario: r.scenario, fundingAssumption: r.fundingAssumption,
      startMs: r.startMs, orders: r.orderCount, episodes: r.completedTrades, independentlyComputedNetPnlUsd: cash,
      independentlyComputedFundingCashUsd: totalFunding, independentlyComputedDrawdownUsd: maxDrawdown });
  }
  const candidate = allRuns.filter(r => r.policy.startsWith("weekly-"));
  const benchmarkComparisons = ["source-plus-hour", "source-as-end"].map(fundingAssumption => {
    const periods = windows.map(window => {
      const select = (policy: string) => allRuns.find(r => r.startMs === window.startMs && r.scenario === "base"
        && r.fundingAssumption === fundingAssumption && (policy === "candidate" ? r.policy.startsWith("weekly-") : r.policy === policy))!;
      const candidateNetPnlUsd = select("candidate").independentlyComputedNetPnlUsd;
      const benchmarkMeanNetPnlUsd = (select("risk-managed-long-btc").independentlyComputedNetPnlUsd
        + select("risk-managed-long-eth").independentlyComputedNetPnlUsd) / 2;
      return { windowId: window.id, candidateNetPnlUsd, benchmarkMeanNetPnlUsd,
        excessNetPnlUsd: candidateNetPnlUsd - benchmarkMeanNetPnlUsd };
    });
    const candidateNetPnlUsd = periods.reduce((sum, p) => sum + p.candidateNetPnlUsd, 0);
    const benchmarkMeanNetPnlUsd = periods.reduce((sum, p) => sum + p.benchmarkMeanNetPnlUsd, 0);
    const comparison = { fundingAssumption, candidateNetPnlUsd, benchmarkMeanNetPnlUsd,
      excessNetPnlUsd: candidateNetPnlUsd - benchmarkMeanNetPnlUsd, periods };
    const recorded = report.validation.benchmarkComparisons.find((c: Any) => c.fundingAssumption === fundingAssumption);
    check(Boolean(recorded), `BENCHMARK_COMPARISON_MISSING:${fundingAssumption}`);
    if (recorded) for (const field of ["candidateNetPnlUsd", "benchmarkMeanNetPnlUsd", "excessNetPnlUsd"] as const)
      near(recorded[field], comparison[field], "benchmarkComparisonUsd", fundingAssumption);
    return comparison;
  });
  return { directory: path, passed: anomalyCount === 0, anomalyCount, anomalies, maximumAbsoluteErrors: maxErrors,
    sourceFilesVerified: Object.keys(protocol.sourceHashes).length, sourceSha256: protocol.sourceSha256,
    studyDataSha256: protocol.dataSha256, barsAdmitted: bars.length, fundingRowsAdmitted: funding.length,
    maximumAdmittedBarMs: bars.at(-1)!.openMs, maximumAdmittedFundingMs: funding.at(-1)!.timestampMs,
    modelCount: fits.length, forecastCount: forecasts.length, runsVerified: allRuns.length,
    candidateProfitableRuns: candidate.filter(r => r.independentlyComputedNetPnlUsd > 0).length,
    candidateLosingRuns: candidate.filter(r => r.independentlyComputedNetPnlUsd < 0).length,
    candidateZeroNetRuns: candidate.filter(r => r.independentlyComputedNetPnlUsd === 0).length,
    candidateTotalOrders: candidate.reduce((sum, r) => sum + r.orders, 0), benchmarkComparisons, runs: allRuns,
    limits: "INDEPENDENT_ARITHMETIC_AND_SEALED_ARTIFACT_AUDIT; DOES_NOT_ESTABLISH_EXECUTABLE_FILLS_OR_VALIDATE_REUSED_DATA_PROFITS" };
}

const directories = process.argv.slice(2);
if (!directories.length) throw new Error("Pass one or more completed economic study directories");
const studies = [];
for (const directory of directories) studies.push(await audit(directory));
const output = { auditedAt: new Date().toISOString(), auditSourceSha256: sha(await readFile(fileURLToPath(import.meta.url))),
  passed: studies.every(s => s.passed), studies };
await writeFile(resolve("reports/profit-rebuild-2026-09-09/verification.json"), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ passed: output.passed, studies: studies.map(s => ({ directory: s.directory,
  passed: s.passed, anomalyCount: s.anomalyCount, anomalies: s.anomalies.slice(0, 8),
  runsVerified: s.runsVerified, candidateProfitableRuns: s.candidateProfitableRuns,
  maximumAbsoluteErrors: s.maximumAbsoluteErrors })) }, null, 2));
if (!output.passed) process.exitCode = 1;
