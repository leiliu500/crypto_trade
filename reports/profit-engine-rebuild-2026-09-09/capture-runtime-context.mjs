/** Read-only allowlist for the import preflight. Run from /app in the existing
 * paper container. It prints no connection credentials or environment dump. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const moduleAt = path => import(pathToFileURL(resolve('dist/src', path)).href);
const { loadConfig } = await moduleAt('config.js');
const { loadKrakenFuturesInstruments } = await moduleAt('kraken/paper-broker.js');
const { policyReserveBps } = await moduleAt('research/policy-planner.js');
const { DISTRIBUTION_SPEC } = await moduleAt('distribution/spec.js');
const cfg = loadConfig();
if (cfg.mode !== 'paper' || !cfg.distributionalSizingPolicy) throw new Error('CURRENT_RISK_BOUNDED_PAPER_ENGINE_REQUIRED');
let instrumentEvidence;
const instruments = await loadKrakenFuturesInstruments(cfg.krakenFutures.productsBySymbol, async (url, options) => {
  const response = await fetch(url, options);
  const bytes = Buffer.from(await response.clone().arrayBuffer());
  instrumentEvidence = { url: String(url), status: response.status,
    fetchedAtUtc: new Date().toISOString(), bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  return response;
});
const assets = Object.fromEntries([...instruments].map(([symbol, instrument]) => [symbol, {
  symbol, minOrderSize: instrument.quantityIncrement, minTradeIncrement: instrument.quantityIncrement,
  priceIncrement: instrument.tickSize, maximumOrderQty: instrument.maximumOrderQty, shortable: true,
}]));
const costs = Object.fromEntries(DISTRIBUTION_SPEC.symbols.map(symbol => [symbol, {
  feeBps: cfg.symbolConfigs[symbol].cost.takerFeeBps, reserveBps: policyReserveBps(cfg.symbolConfigs[symbol]),
}]));
process.stdout.write(JSON.stringify({ generatedAtMs: Date.now(), mode: cfg.mode,
  paperTrial: cfg.distributionalPaperTrialEnabled, efficientTraining: cfg.distributionalEfficientTrainingEnabled,
  regimeModel: cfg.distributionalRegimeModelEnabled, initialEquity: cfg.krakenFutures.initialEquity,
  stateFile: resolve(cfg.distributionalStateFile), historyFile: resolve(cfg.distributionalHistoryFile),
  trainingFile: cfg.distributionalTrainingFile ?? null, paperFile: resolve(cfg.krakenFutures.paperStateFile),
  symbolConfigs: cfg.symbolConfigs, sizingPolicy: cfg.distributionalSizingPolicy, costs, assets, instrumentEvidence,
}) + '\n');
