import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FeatureConfig } from "./core/features.js";
import { DEFAULT_FEATURE_CONFIG } from "./core/features.js";
import type { PlannerConfig } from "./execution/planner.js";
import type { PortfolioRiskConfig } from "./risk/portfolio.js";
import type { RiskConfig } from "./risk/sizing.js";
import type { PositionConfig } from "./strategy/position-manager.js";
import type { CostConfig } from "./strategy/cost.js";
import type { ForecastConfig, LinearHead } from "./strategy/forecast.js";
import type { SignalConfig } from "./strategy/signal.js";
import type { DeterministicSignalConfig, SignalMode } from "./strategy/deterministic-entry.js";
import type { EdgeSourceMode } from "./strategy/deterministic-edge-resolver.js";
import type { AnalyticHorizonConfig, EconomicEdgeMode } from "./economics/types.js";
import type { CalibratedEdgeBucket } from "./calibration/calibrated-edge-table.js";
import type { ExtensionConfig } from "./strategy/deterministic-features.js";
import type { DeterministicRegimeConfig } from "./strategy/deterministic-regime.js";
import type { DeterministicHoldConfig } from "./strategy/deterministic-hold.js";
import type { DynamicLiquidityConfig } from "./strategy/dynamic-liquidity.js";
import { DEFAULT_DETERMINISTIC_HOLD_CONFIG, DEFAULT_DETERMINISTIC_REGIME_CONFIG, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG, DEFAULT_EXTENSION_CONFIG } from "./config/deterministic-defaults.js";

export type TradingMode = "record" | "replay" | "shadow" | "paper" | "live";
export interface SymbolConfig {
  symbol: string;
  maximumNotional: number;
  initialStopSigma: number;
  minimumStopSpreadMultiple: number;
  jumpSigma: number;
  strategyVersion: string;
  modelVersion: string;
  configurationVersion: string;
  signalMode: SignalMode;
  feature: FeatureConfig;
  deterministicExtension: ExtensionConfig;
  deterministicRegime: DeterministicRegimeConfig;
  deterministicSignal: DeterministicSignalConfig;
  deterministicHold: DeterministicHoldConfig;
  dynamicLiquidity: DynamicLiquidityConfig;
  forecast: ForecastConfig;
  probabilityHead: LinearHead;
  returnHead: LinearHead;
  signal: SignalConfig;
  cost: CostConfig;
  sizing: RiskConfig;
  position: PositionConfig;
  planner: PlannerConfig;
}

export interface EngineConfig extends Omit<SymbolConfig, "symbol"> {
  mode: TradingMode;
  credentials: { keyId: string; secretKey: string };
  paper: boolean;
  paperEntryExercise: boolean;
  symbols: string[];
  symbolConfigs: Readonly<Record<string, SymbolConfig>>;
  cryptoLocation: string;
  recordFile: string;
  replayFile: string;
  continuousRecordingEnabled: boolean;
  continuousRecordFile: string;
  portfolio: PortfolioRiskConfig;
  rollingLossFraction: number;
  sessionLossFraction: number;
  dashboardEnabled: boolean;
  dashboardHost: string;
  dashboardPort: number;
  databaseEnabled: boolean;
  databaseRequired: boolean;
  databaseUrl: string;
  databaseFlushIntervalMs: number;
  databaseMaxQueue: number;
  databaseMarketSampleMs: number;
  recall: {
    sampleIntervalMs: number;
    opportunityHorizonMs: number;
    minimumNetMoveBps: number;
    minimumTuningDurationMs: number;
    minimumTuningOpportunities: number;
  };
}

const MODEL_DIMENSION = 15;
const zeroWeights = (): number[] => Array.from({ length: MODEL_DIMENSION }, () => 0);

type ParameterValue = string | number | boolean;
interface ParameterFile { schemaVersion: number; symbols: string[]; parameters: Record<string, ParameterValue> }
interface SymbolParameterFile { schemaVersion: number; symbol: string; parameters: Record<string, ParameterValue> }

const RUNTIME_ONLY_KEYS = new Set([
  "ALPACA_API_KEY", "ALPACA_API_SECRET", "APCA_API_KEY_ID", "APCA_API_SECRET_KEY", "ALPACA_PAPER",
  "TRADING_MODE", "ALLOW_LIVE_TRADING", "LIVE_TRADING_CONFIRMATION", "PAPER_ENTRY_EXERCISE", "DATABASE_URL",
  "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_HOST", "POSTGRES_PORT", "CONFIG_DIR",
]);
const GLOBAL_PARAMETER_KEYS = new Set([
  "ALPACA_CRYPTO_LOCATION", "REPLAY_FILE", "RECORD_FILE", "CONTINUOUS_RECORDING_ENABLED", "CONTINUOUS_RECORD_FILE",
  "DASHBOARD_ENABLED", "DASHBOARD_HOST", "DASHBOARD_PORT",
  "DATABASE_ENABLED", "DATABASE_REQUIRED", "DATABASE_FLUSH_INTERVAL_MS", "DATABASE_MAX_QUEUE", "DATABASE_MARKET_SAMPLE_MS",
  "MAXIMUM_GROSS_NOTIONAL", "RECALL_SAMPLE_INTERVAL_MS", "RECALL_OPPORTUNITY_HORIZON_MS", "RECALL_MIN_NET_MOVE_BPS",
  "RECALL_MIN_TUNING_DURATION_MS", "RECALL_MIN_TUNING_OPPORTUNITIES",
]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env, modeOverride?: string): EngineConfig {
  const files = loadParameterFiles(env.CONFIG_DIR ?? "config");
  const configuredEnv = applyParameters(env, files.base.parameters);
  const mode = parseMode(modeOverride ?? env.TRADING_MODE ?? "shadow");
  const keyId = firstNonBlank(env.ALPACA_API_KEY, env.APCA_API_KEY_ID);
  const secretKey = firstNonBlank(env.ALPACA_API_SECRET, env.APCA_API_SECRET_KEY);
  const paper = parseBoolean(env.ALPACA_PAPER, true);
  const paperEntryExercise = parseBoolean(env.PAPER_ENTRY_EXERCISE, false);
  if (mode === "paper" && !paper) throw new Error("Paper mode requires ALPACA_PAPER=true; refusing to route paper-mode orders to the live endpoint");
  if (paperEntryExercise && (mode !== "paper" || !paper)) {
    throw new Error("PAPER_ENTRY_EXERCISE is restricted to the Alpaca paper endpoint");
  }
  if (["record", "shadow", "paper", "live"].includes(mode) && (!keyId || !secretKey)) {
    throw new Error("Alpaca credentials are required via ALPACA_API_KEY/ALPACA_API_SECRET or APCA_API_KEY_ID/APCA_API_SECRET_KEY");
  }
  if (mode === "live") {
    if (paper) throw new Error("Live mode cannot run with ALPACA_PAPER=true");
    if (env.ALLOW_LIVE_TRADING !== "true" || env.LIVE_TRADING_CONFIRMATION !== "I_UNDERSTAND_LIVE_ORDERS_USE_REAL_MONEY") {
      throw new Error("Live trading interlock is not armed");
    }
  }
  const baseline = loadSymbolConfig("__base__", configuredEnv, mode);
  const symbolConfigs: Record<string, SymbolConfig> = {};
  for (const symbol of files.base.symbols) {
    const overlay = files.symbols.get(symbol);
    if (!overlay) throw new Error(`Missing symbol configuration for ${symbol}`);
    symbolConfigs[symbol] = loadSymbolConfig(symbol, applyParameters(configuredEnv, overlay.parameters), mode);
  }
  const { symbol: _baselineSymbol, ...baselineConfig } = baseline;
  return {
    ...baselineConfig,
    mode, credentials: { keyId, secretKey }, paper, paperEntryExercise, symbols: [...files.base.symbols], symbolConfigs,
    cryptoLocation: configuredEnv.ALPACA_CRYPTO_LOCATION ?? "us", recordFile: configuredEnv.RECORD_FILE ?? "data/events.jsonl", replayFile: configuredEnv.REPLAY_FILE ?? "data/events.jsonl",
    continuousRecordingEnabled: parseBoolean(configuredEnv.CONTINUOUS_RECORDING_ENABLED, false),
    continuousRecordFile: configuredEnv.CONTINUOUS_RECORD_FILE ?? "data/continuous-events.jsonl.gz",
    portfolio: { maximumVariance: Number.POSITIVE_INFINITY, maximumClusterPositions: 1, maximumGrossNotional: numberEnv(configuredEnv.MAXIMUM_GROSS_NOTIONAL, 5_000), rollingLossBudgetFraction: .0075 },
    rollingLossFraction: .0075, sessionLossFraction: .0075,
    dashboardEnabled: parseBoolean(configuredEnv.DASHBOARD_ENABLED, true),
    dashboardHost: configuredEnv.DASHBOARD_HOST ?? "0.0.0.0",
    dashboardPort: integerEnv(configuredEnv.DASHBOARD_PORT, 3_001, 1, 65_535),
    databaseEnabled: parseBoolean(configuredEnv.DATABASE_ENABLED, true),
    databaseRequired: parseBoolean(configuredEnv.DATABASE_REQUIRED, false),
    databaseUrl: env.DATABASE_URL ?? buildDatabaseUrl(env),
    databaseFlushIntervalMs: integerEnv(configuredEnv.DATABASE_FLUSH_INTERVAL_MS, 250, 25, 60_000),
    databaseMaxQueue: integerEnv(configuredEnv.DATABASE_MAX_QUEUE, 10_000, 100, 1_000_000),
    databaseMarketSampleMs: integerEnv(configuredEnv.DATABASE_MARKET_SAMPLE_MS, 1_000, 100, 60_000),
    recall: {
      sampleIntervalMs: integerEnv(configuredEnv.RECALL_SAMPLE_INTERVAL_MS, 1_000, 10, 60_000),
      opportunityHorizonMs: integerEnv(configuredEnv.RECALL_OPPORTUNITY_HORIZON_MS, 60_000, 1_000, 86_400_000),
      minimumNetMoveBps: numberEnv(configuredEnv.RECALL_MIN_NET_MOVE_BPS, 5),
      minimumTuningDurationMs: integerEnv(configuredEnv.RECALL_MIN_TUNING_DURATION_MS, 604_800_000, 60_000, 2_147_483_647),
      minimumTuningOpportunities: integerEnv(configuredEnv.RECALL_MIN_TUNING_OPPORTUNITIES, 100, 1, 1_000_000),
    },
  };
}

function loadParameterFiles(configDirectory: string): { base: ParameterFile; symbols: Map<string, SymbolParameterFile> } {
  const directory = resolve(configDirectory);
  const basePath = resolve(directory, "base.json");
  const base = readParameterFile(basePath);
  if (base.schemaVersion !== 1) throw new Error(`${basePath}: unsupported schemaVersion ${base.schemaVersion}`);
  if (!Array.isArray(base.symbols) || base.symbols.length === 0 || base.symbols.some((symbol) => typeof symbol !== "string" || !symbol.trim())) {
    throw new Error(`${basePath}: symbols must be a non-empty string array`);
  }
  base.symbols = base.symbols.map((symbol) => symbol.trim());
  if (new Set(base.symbols).size !== base.symbols.length) throw new Error(`${basePath}: symbols must be unique`);
  validateParameters(base.parameters, basePath);

  const symbols = new Map<string, SymbolParameterFile>();
  for (const symbol of base.symbols) {
    const path = resolve(directory, `${symbolFileStem(symbol)}.json`);
    const overlay = readSymbolParameterFile(path);
    if (overlay.schemaVersion !== 1) throw new Error(`${path}: unsupported schemaVersion ${overlay.schemaVersion}`);
    if (overlay.symbol !== symbol) throw new Error(`${path}: expected symbol ${symbol}, received ${overlay.symbol}`);
    validateParameters(overlay.parameters, path);
    for (const key of Object.keys(overlay.parameters)) {
      if (!(key in base.parameters)) throw new Error(`${path}: ${key} is not defined by base.json`);
      if (GLOBAL_PARAMETER_KEYS.has(key)) throw new Error(`${path}: ${key} is global and cannot be overridden per symbol`);
    }
    symbols.set(symbol, overlay);
  }
  return { base, symbols };
}

function readParameterFile(path: string): ParameterFile {
  const value = readJsonObject(path);
  assertOnlyKeys(value, ["schemaVersion", "symbols", "parameters"], path);
  if (typeof value.schemaVersion !== "number" || !Array.isArray(value.symbols) || !isObject(value.parameters)) throw new Error(`${path}: invalid base configuration document`);
  return value as unknown as ParameterFile;
}

function readSymbolParameterFile(path: string): SymbolParameterFile {
  const value = readJsonObject(path);
  assertOnlyKeys(value, ["schemaVersion", "symbol", "parameters"], path);
  if (typeof value.schemaVersion !== "number" || typeof value.symbol !== "string" || !isObject(value.parameters)) throw new Error(`${path}: invalid symbol configuration document`);
  return value as unknown as SymbolParameterFile;
}

function readJsonObject(path: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Unable to load configuration ${path}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!isObject(parsed)) throw new Error(`${path}: root must be an object`);
  return parsed;
}

function validateParameters(parameters: Record<string, ParameterValue>, path: string): void {
  for (const [key, value] of Object.entries(parameters)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`${path}: invalid parameter name ${key}`);
    if (RUNTIME_ONLY_KEYS.has(key)) throw new Error(`${path}: ${key} is runtime-only and must remain in .env`);
    if (!["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) {
      throw new Error(`${path}: ${key} must be a finite number, boolean, or string`);
    }
  }
}

function applyParameters(env: NodeJS.ProcessEnv, parameters: Record<string, ParameterValue>): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const [key, value] of Object.entries(parameters)) result[key] = String(value);
  return result;
}

function symbolFileStem(symbol: string): string {
  return symbol.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${path}: unknown property ${key}`);
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function loadSymbolConfig(symbol: string, env: NodeJS.ProcessEnv, mode: TradingMode): SymbolConfig {
  const paperEntryExercise = mode === "paper" && parseBoolean(env.PAPER_ENTRY_EXERCISE, false);
  const feature: FeatureConfig = {
    ...DEFAULT_FEATURE_CONFIG,
    forecastHorizonMs: numberEnv(env.FORECAST_HORIZON_MS, 5_000),
    absoluteMaxProviderAgeMs: numberEnv(env.MAX_PROVIDER_AGE_MS, 2_000),
    maximumProviderFutureSkewMs: numberEnv(env.MAX_PROVIDER_FUTURE_SKEW_MS, DEFAULT_FEATURE_CONFIG.maximumProviderFutureSkewMs),
    maximumKinematicsGapMs: integerEnv(env.MAX_KINEMATICS_GAP_MS, DEFAULT_FEATURE_CONFIG.maximumKinematicsGapMs, 1, 3_600_000),
  };
  const signalMode = parseSignalMode(env.SIGNAL_MODE ?? env.ENTRY_MODE);
  if (signalMode !== "DETERMINISTIC_ONLY" && !env.MODEL_CONFIG_JSON) throw new Error(`${signalMode} requires MODEL_CONFIG_JSON; optional model modes fail closed without a model`);
  const model = signalMode === "DETERMINISTIC_ONLY" ? parseModel(undefined) : parseModel(env.MODEL_CONFIG_JSON);
  const baseConfigurationVersion = env.DETERMINISTIC_CONFIG_VERSION ?? DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.configurationVersion;
  const configurationVersion = paperEntryExercise ? `${baseConfigurationVersion}-paper-entry-exercise` : baseConfigurationVersion;
  const deterministicExtension = loadExtensionConfig(env);
  const deterministicRegime = loadDeterministicRegimeConfig(env);
  const configuredDeterministicSignal = loadDeterministicSignalConfig(env, signalMode, configurationVersion, mode);
  const deterministicSignal: DeterministicSignalConfig = paperEntryExercise ? {
    ...configuredDeterministicSignal,
    costSafetyFactor: 1,
    minimumNetEdgeBps: 0,
    minimumMakerFillProbability: 1,
    positiveCostErrorP95Bps: 0,
    analyticHorizons: configuredDeterministicSignal.analyticHorizons.map((horizon) => ({
      ...horizon,
      sigmaCaptureFraction: 1,
      breakoutWeight: 1,
      baseUncertaintyBps: 0,
      sigmaUncertaintyFraction: 0,
    })),
    analyticEdge: {
      ...configuredDeterministicSignal.analyticEdge,
      sigmaCaptureFraction: 1,
      breakoutWeight: 1,
      baseUncertaintyBps: 0,
      sigmaUncertaintyFraction: 0,
      spreadUncertaintyWeight: 0,
      flipUncertaintyWeight: 0,
    },
  } : configuredDeterministicSignal;
  const deterministicHold = loadDeterministicHoldConfig(env);
  const shadowTradeCapBps = numberEnv(env.DYNAMIC_SHADOW_TRADE_CAP_BPS, deterministicSignal.maximumSpreadBps);
  const absoluteTradeCapBps = ["shadow", "replay"].includes(mode)
    ? shadowTradeCapBps : deterministicSignal.maximumSpreadBps;
  const dynamicLiquidity: DynamicLiquidityConfig = {
    maximumSamples: integerEnv(env.DYNAMIC_SPREAD_MAX_SAMPLES, 512, 10, 100_000),
    minimumSamples: integerEnv(env.DYNAMIC_SPREAD_MIN_SAMPLES, 30, 2, 100_000),
    tradeQuantile: numberEnv(env.DYNAMIC_SPREAD_TRADE_QUANTILE, .65),
    tradeMadMultiple: numberEnv(env.DYNAMIC_SPREAD_TRADE_MAD_MULTIPLE, 3),
    stressMadMultiple: numberEnv(env.DYNAMIC_SPREAD_STRESS_MAD_MULTIPLE, 6),
    absoluteTradeCapBps,
    absoluteStressCapBps: Math.max(absoluteTradeCapBps, numberEnv(env.DYNAMIC_SPREAD_STRESS_CAP_BPS, 60)),
    maximumSpreadZ: deterministicSignal.maximumSpreadZ,
    minimumDepthZ: deterministicSignal.minimumDepthZ,
    maximumImpactBps: deterministicSignal.maximumImpactBps,
  };
  const forecast: ForecastConfig = {
    alphaDecayTauMs: numberEnv(env.ALPHA_DECAY_TAU_MS, 4_000),
    intendedHoldMs: numberEnv(env.INTENDED_HOLD_MS, 30 * 60_000),
    residualWindowMs: 86_400_000,
    fallbackResidualQ95Bps: numberEnv(env.RESIDUAL_Q95_BPS, 8),
  };
  const position = defaultPositionConfig(env);
  validateStrategyHorizons(deterministicSignal.analyticHorizons.map((item) => item.horizonMs), position.maximumHoldMs);
  return {
    symbol,
    maximumNotional: paperEntryExercise ? Math.min(25, numberEnv(env.MAXIMUM_NOTIONAL, 1_000)) : numberEnv(env.MAXIMUM_NOTIONAL, 1_000),
    initialStopSigma: numberEnv(env.INITIAL_STOP_SIGMA, 3),
    minimumStopSpreadMultiple: numberEnv(env.MINIMUM_STOP_SPREAD_MULTIPLE, 3), jumpSigma: numberEnv(env.JUMP_SIGMA, 5),
    strategyVersion: env.STRATEGY_VERSION ?? "1.0.0", modelVersion: signalMode === "DETERMINISTIC_ONLY" ? "none" : model.version,
    configurationVersion, signalMode, feature, deterministicExtension, deterministicRegime, deterministicSignal, deterministicHold, dynamicLiquidity,
    forecast,
    probabilityHead: model.probabilityHead, returnHead: model.returnHead,
    signal: { costSafetyFactor: 1.75, minimumDirectionProbability: .62, minimumNetEdgeBps: 1, fullQualityEdgeBps: 20 },
    cost: { makerFeeBps: paperEntryExercise ? 0 : numberEnv(env.MAKER_FEE_BPS, 15), takerFeeBps: paperEntryExercise ? 0 : numberEnv(env.TAKER_FEE_BPS, 25),
      makerExitFillProbability: paperEntryExercise ? 0 : fractionEnv(env.MAKER_EXIT_FILL_PROBABILITY, .65),
      makerExitFallbackAdverseBps: paperEntryExercise ? 0 : numberEnv(env.MAKER_EXIT_FALLBACK_ADVERSE_BPS, 2),
      latencyAdverseFraction: paperEntryExercise ? 0 : .25, adverseSelectionBps: paperEntryExercise ? 0 : 1, fundingBps: 0, borrowBps: 0,
      positiveCostErrorP95Bps: deterministicSignal.positiveCostErrorP95Bps },
    sizing: { baseRiskFraction: .001, maximumDrawdown: .05, maximumBookParticipation: .01, fractionalKelly: .1, maximumKellyFraction: .05, targetSigmaHBps: 20, minimumQualityScale: .1 },
    position, planner: defaultPlannerConfig(env, deterministicSignal.minimumMakerFillProbability, paperEntryExercise ? 5 : 0),
  };
}

function defaultPositionConfig(env: NodeJS.ProcessEnv): PositionConfig {
  return { recoveryArmR: .5, trailActivationR: .75, minimumProgressR: .25,
    minimumHoldMs: integerEnv(env.POSITION_MINIMUM_HOLD_MS, 1_000, 0, 2_147_483_647),
    maximumHoldMs: integerEnv(env.POSITION_MAXIMUM_HOLD_MS, 30 * 60_000, 1, 2_147_483_647),
    reentryCooldownMs: integerEnv(env.POSITION_REENTRY_COOLDOWN_MS, 0, 0, 2_147_483_647),
    makerExitTtlMs: integerEnv(env.MAKER_EXIT_TTL_MS, 30_000, 1_000, 300_000),
    evidenceConfirmationMs: integerEnv(env.POSITION_EVIDENCE_CONFIRMATION_MS, 750, 0, 2_147_483_647),
    profitActivationCostMultiple: numberEnv(env.POSITION_PROFIT_ACTIVATION_COST_MULTIPLE, 1.25),
    lockMin: .1, lockMax: .85, lockMaturityRate: .8, lockReversalWeight: .3, lockTrendDiscount: .15,
    baseVolatilityMultiple: 2, trendVolatilityBonus: 1, reversalVolatilityPenalty: 1.25, minimumVolatilityMultiple: .5, maximumVolatilityMultiple: 4,
    partialExitThreshold: .7, maximumPartialExitFraction: .5, minimumPartialExitBenefitBps: 2 };
}
function defaultPlannerConfig(env: NodeJS.ProcessEnv, minimumFillProbability: number, takerLimitBufferBps: number): PlannerConfig {
  return { makerTtlMs: 1_500, alphaHalfLifeMs: 2_772,
    pullbackMakerTtlMs: integerEnv(env.PULLBACK_MAKER_TTL_MS, 20_000, 1_000, 300_000),
    pullbackKinematicsGraceMs: integerEnv(env.PULLBACK_KINEMATICS_GRACE_MS, 5_000, 1, 299_999),
    pullbackKinematicsGraceEvents: integerEnv(env.PULLBACK_KINEMATICS_GRACE_EVENTS, 2, 2, 100),
    pullbackSignalInvalidationGraceMs: integerEnv(env.PULLBACK_SIGNAL_INVALIDATION_GRACE_MS, 5_000, 1, 299_999),
    pullbackSignalInvalidationGraceEvents: integerEnv(env.PULLBACK_SIGNAL_INVALIDATION_GRACE_EVENTS, 3, 2, 100),
    minimumFillProbability, takerLimitBufferBps, cancelAheadFraction: .5,
    fillHazardIntercept: -1, fillHazardAggressiveWeight: .1, fillHazardFlowWeight: 1, fillHazardImbalanceWeight: .5, fillHazardSpreadWeight: .05,
    makerOpportunityCostBps: 2, staleOrderCostBps: 1, maximumImpactBps: 10, maximumIterations: 5 };
}
function parseMode(value: string): TradingMode {
  if (!["record", "replay", "shadow", "paper", "live"].includes(value)) throw new Error(`Unknown trading mode: ${value}`);
  return value as TradingMode;
}

function validateStrategyHorizons(economicHorizonsMs: readonly number[], maximumHoldMs: number): void {
  const maximumEconomicHorizonMs = Math.max(...economicHorizonsMs);
  if (maximumHoldMs < maximumEconomicHorizonMs) {
    throw new Error(`POSITION_MAXIMUM_HOLD_MS (${maximumHoldMs}) must cover the largest economic horizon (${maximumEconomicHorizonMs})`);
  }
}
function parseSignalMode(value: string | undefined): SignalMode {
  if (value === undefined || value.toLowerCase() === "rules") return "DETERMINISTIC_ONLY";
  if (value.toLowerCase() === "linear") return "DETERMINISTIC_WITH_MODEL_VETO";
  const normalized = value.toUpperCase();
  if (["DETERMINISTIC_ONLY", "DETERMINISTIC_WITH_MODEL_VETO", "DETERMINISTIC_WITH_MODEL_RANKING"].includes(normalized)) return normalized as SignalMode;
  throw new Error(`Unknown SIGNAL_MODE: ${value}`);
}
function parseBoolean(value: string | undefined, fallback: boolean): boolean { return value === undefined ? fallback : value.toLowerCase() === "true"; }
function firstNonBlank(...values: (string | undefined)[]): string {
  return values.find((value) => value?.trim())?.trim() ?? "";
}
function numberEnv(value: string | undefined, fallback: number): number { const n = value === undefined ? fallback : Number(value); if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid numeric configuration: ${value}`); return n; }
function fractionEnv(value: string | undefined, fallback: number): number { const n = numberEnv(value, fallback); if (n > 1) throw new Error(`Invalid fractional configuration: ${value}`); return n; }
function finiteNumberEnv(value: string | undefined, fallback: number): number { const n = value === undefined ? fallback : Number(value); if (!Number.isFinite(n)) throw new Error(`Invalid finite numeric configuration: ${value}`); return n; }
function integerEnv(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Invalid integer configuration: ${value}`);
  return parsed;
}
function buildDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const user = encodeURIComponent(env.POSTGRES_USER ?? "crypto_trade");
  const password = encodeURIComponent(env.POSTGRES_PASSWORD ?? "crypto_trade_dev");
  const host = env.POSTGRES_HOST ?? "127.0.0.1";
  const port = integerEnv(env.POSTGRES_PORT, 5_433, 1, 65_535);
  const database = encodeURIComponent(env.POSTGRES_DB ?? "crypto_trade");
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}
function loadExtensionConfig(env: NodeJS.ProcessEnv): ExtensionConfig {
  return {
    impulseWindowMs: numberEnv(env.RULE_IMPULSE_WINDOW_MS, DEFAULT_EXTENSION_CONFIG.impulseWindowMs),
    breakoutWindowMs: numberEnv(env.RULE_BREAKOUT_WINDOW_MS, DEFAULT_EXTENSION_CONFIG.breakoutWindowMs),
    anchorWindowMs: numberEnv(env.RULE_ANCHOR_WINDOW_MS, DEFAULT_EXTENSION_CONFIG.anchorWindowMs),
    flipWindowMs: numberEnv(env.RULE_FLIP_WINDOW_MS, DEFAULT_EXTENSION_CONFIG.flipWindowMs),
    maximumStoredWindowMs: numberEnv(env.RULE_MAX_STORED_WINDOW_MS, DEFAULT_EXTENSION_CONFIG.maximumStoredWindowMs),
    cusumDrift: numberEnv(env.RULE_CUSUM_DRIFT, DEFAULT_EXTENSION_CONFIG.cusumDrift),
    cusumCap: numberEnv(env.RULE_CUSUM_CAP, DEFAULT_EXTENSION_CONFIG.cusumCap),
    alignmentDeadband: numberEnv(env.RULE_ALIGNMENT_DEADBAND, DEFAULT_EXTENSION_CONFIG.alignmentDeadband),
    trendSampleIntervalMs: numberEnv(env.RULE_TREND_SAMPLE_INTERVAL_MS, DEFAULT_EXTENSION_CONFIG.trendSampleIntervalMs),
    trendFastWindowMs: numberEnv(env.RULE_TREND_FAST_WINDOW_MS, DEFAULT_EXTENSION_CONFIG.trendFastWindowMs),
    trendMediumWindowMs: numberEnv(env.RULE_TREND_MEDIUM_WINDOW_MS, DEFAULT_EXTENSION_CONFIG.trendMediumWindowMs),
    trendSlowWindowMs: numberEnv(env.RULE_TREND_SLOW_WINDOW_MS, DEFAULT_EXTENSION_CONFIG.trendSlowWindowMs),
    trendMinimumCoverage: numberEnv(env.RULE_TREND_MINIMUM_COVERAGE, DEFAULT_EXTENSION_CONFIG.trendMinimumCoverage),
    pullbackWindowMs: numberEnv(env.RULE_PULLBACK_WINDOW_MS, DEFAULT_EXTENSION_CONFIG.pullbackWindowMs),
    pullbackMinimumCoverage: numberEnv(env.RULE_PULLBACK_MINIMUM_COVERAGE, DEFAULT_EXTENSION_CONFIG.pullbackMinimumCoverage),
    pullbackSampleIntervalMs: numberEnv(env.RULE_PULLBACK_SAMPLE_INTERVAL_MS, DEFAULT_EXTENSION_CONFIG.pullbackSampleIntervalMs),
  };
}
function loadDeterministicRegimeConfig(env: NodeJS.ProcessEnv): DeterministicRegimeConfig {
  return {
    ...DEFAULT_DETERMINISTIC_REGIME_CONFIG,
    trendEfficiency: numberEnv(env.RULE_TREND_EFFICIENCY, DEFAULT_DETERMINISTIC_REGIME_CONFIG.trendEfficiency),
    chopEfficiency: numberEnv(env.RULE_CHOP_EFFICIENCY, DEFAULT_DETERMINISTIC_REGIME_CONFIG.chopEfficiency),
    maximumTrendFlipRate: numberEnv(env.RULE_MAX_TREND_FLIP_RATE, DEFAULT_DETERMINISTIC_REGIME_CONFIG.maximumTrendFlipRate),
    chopFlipRate: numberEnv(env.RULE_CHOP_FLIP_RATE, DEFAULT_DETERMINISTIC_REGIME_CONFIG.chopFlipRate),
    regimeMicroEdgeBps: numberEnv(env.RULE_REGIME_MICRO_EDGE_BPS, DEFAULT_DETERMINISTIC_REGIME_CONFIG.regimeMicroEdgeBps),
    regimeQiK: numberEnv(env.RULE_REGIME_QIK, DEFAULT_DETERMINISTIC_REGIME_CONFIG.regimeQiK),
    regimeOfi: numberEnv(env.RULE_REGIME_OFI, DEFAULT_DETERMINISTIC_REGIME_CONFIG.regimeOfi),
    regimeTfi: numberEnv(env.RULE_REGIME_TFI, DEFAULT_DETERMINISTIC_REGIME_CONFIG.regimeTfi),
    regimeVelocityZ: numberEnv(env.RULE_REGIME_VELOCITY_Z, DEFAULT_DETERMINISTIC_REGIME_CONFIG.regimeVelocityZ),
    maximumOpposingAccelerationZ: numberEnv(env.RULE_REGIME_MAX_OPPOSING_ACCELERATION_Z, DEFAULT_DETERMINISTIC_REGIME_CONFIG.maximumOpposingAccelerationZ),
    breakoutBps: numberEnv(env.RULE_REGIME_BREAKOUT_BPS, DEFAULT_DETERMINISTIC_REGIME_CONFIG.breakoutBps),
    breakoutCusum: numberEnv(env.RULE_REGIME_BREAKOUT_CUSUM, DEFAULT_DETERMINISTIC_REGIME_CONFIG.breakoutCusum),
    breakoutOfi: numberEnv(env.RULE_REGIME_BREAKOUT_OFI, DEFAULT_DETERMINISTIC_REGIME_CONFIG.breakoutOfi),
    breakoutTfi: numberEnv(env.RULE_REGIME_BREAKOUT_TFI, DEFAULT_DETERMINISTIC_REGIME_CONFIG.breakoutTfi),
    neutralOfi: numberEnv(env.RULE_REGIME_NEUTRAL_OFI, DEFAULT_DETERMINISTIC_REGIME_CONFIG.neutralOfi),
    neutralTfi: numberEnv(env.RULE_REGIME_NEUTRAL_TFI, DEFAULT_DETERMINISTIC_REGIME_CONFIG.neutralTfi),
    hysteresisResetRatio: numberEnv(env.RULE_REGIME_RESET_RATIO, DEFAULT_DETERMINISTIC_REGIME_CONFIG.hysteresisResetRatio),
  };
}
function loadDeterministicSignalConfig(env: NodeJS.ProcessEnv, mode: SignalMode, configurationVersion: string,
  tradingMode: TradingMode): DeterministicSignalConfig {
  return {
    ...DEFAULT_DETERMINISTIC_SIGNAL_CONFIG, mode, configurationVersion,
    maximumSpreadBps: numberEnv(env.RULE_MAX_SPREAD_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.maximumSpreadBps),
    maximumSpreadZ: numberEnv(env.RULE_MAX_SPREAD_Z, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.maximumSpreadZ),
    minimumDepthZ: finiteNumberEnv(env.RULE_MIN_DEPTH_Z, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.minimumDepthZ),
    maximumImpactBps: numberEnv(env.RULE_MAX_IMPACT_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.maximumImpactBps),
    microEdgeBps: numberEnv(env.RULE_MICRO_EDGE_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microEdgeBps),
    qi1: numberEnv(env.RULE_QI1, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.qi1), qiK: numberEnv(env.RULE_QIK, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.qiK),
    ofi: numberEnv(env.RULE_OFI, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.ofi), tfi: numberEnv(env.RULE_TFI, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.tfi),
    replenishment: numberEnv(env.RULE_REPLENISHMENT, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.replenishment),
    velocityZ: numberEnv(env.RULE_VELOCITY_Z, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.velocityZ),
    maximumOpposingAccelerationZ: numberEnv(env.RULE_MAX_OPPOSING_ACCELERATION_Z, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.maximumOpposingAccelerationZ),
    impulseBps: numberEnv(env.RULE_IMPULSE_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.impulseBps),
    breakoutBps: numberEnv(env.RULE_BREAKOUT_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.breakoutBps),
    cusum: numberEnv(env.RULE_CUSUM, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.cusum),
    efficiency: numberEnv(env.RULE_EFFICIENCY, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.efficiency),
    maximumFlipRate: numberEnv(env.RULE_MAX_FLIP_RATE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.maximumFlipRate),
    minimumBookVotes: integerEnv(env.RULE_MIN_BOOK_VOTES, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.minimumBookVotes, 1, 3),
    minimumFlowVotes: integerEnv(env.RULE_MIN_FLOW_VOTES, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.minimumFlowVotes, 1, 3),
    minimumKinematicVotes: integerEnv(env.RULE_MIN_KINEMATIC_VOTES, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.minimumKinematicVotes, 1, 5),
    scoreEnter: numberEnv(env.RULE_SCORE_ENTER, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.scoreEnter),
    scoreReset: numberEnv(env.RULE_SCORE_RESET, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.scoreReset),
    arbitrationMargin: numberEnv(env.RULE_ARBITRATION_MARGIN, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.arbitrationMargin),
    scoreWeights: {
      micro: numberEnv(env.RULE_WEIGHT_MICRO, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.scoreWeights.micro),
      qi1: numberEnv(env.RULE_WEIGHT_QI1, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.scoreWeights.qi1),
      qiK: numberEnv(env.RULE_WEIGHT_QIK, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.scoreWeights.qiK),
      ofi: numberEnv(env.RULE_WEIGHT_OFI, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.scoreWeights.ofi),
      tfi: numberEnv(env.RULE_WEIGHT_TFI, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.scoreWeights.tfi),
      replenishment: numberEnv(env.RULE_WEIGHT_REPLENISHMENT, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.scoreWeights.replenishment),
      velocity: numberEnv(env.RULE_WEIGHT_VELOCITY, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.scoreWeights.velocity),
      acceleration: numberEnv(env.RULE_WEIGHT_ACCELERATION, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.scoreWeights.acceleration),
      impulse: numberEnv(env.RULE_WEIGHT_IMPULSE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.scoreWeights.impulse),
      cusum: numberEnv(env.RULE_WEIGHT_CUSUM, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.scoreWeights.cusum),
      efficiency: numberEnv(env.RULE_WEIGHT_EFFICIENCY, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.scoreWeights.efficiency),
      flipQuality: numberEnv(env.RULE_WEIGHT_FLIP_QUALITY, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.scoreWeights.flipQuality),
    },
    persistenceWindowMs: numberEnv(env.RULE_PERSISTENCE_WINDOW_MS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.persistenceWindowMs),
    minimumPersistence: numberEnv(env.RULE_MIN_PERSISTENCE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.minimumPersistence),
    minimumConfirmationMs: numberEnv(env.RULE_MIN_CONFIRMATION_MS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.minimumConfirmationMs),
    minimumConfirmationEvents: integerEnv(env.RULE_MIN_CONFIRMATION_EVENTS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.minimumConfirmationEvents, 1, 10_000),
    cooldownMs: numberEnv(env.RULE_COOLDOWN_MS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.cooldownMs),
    resetMs: numberEnv(env.RULE_RESET_MS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.resetMs),
    maximumImpulseZ: numberEnv(env.RULE_MAX_IMPULSE_Z, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.maximumImpulseZ),
    maximumChaseBps: numberEnv(env.RULE_MAX_CHASE_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.maximumChaseBps),
    maximumAnchorZ: numberEnv(env.RULE_MAX_ANCHOR_Z, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.maximumAnchorZ),
    costSafetyFactor: numberEnv(env.COST_SAFETY_FACTOR, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.costSafetyFactor),
    minimumNetEdgeBps: numberEnv(env.RULE_MIN_NET_EDGE_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.minimumNetEdgeBps),
    fullQualityEdgeBps: numberEnv(env.RULE_FULL_QUALITY_EDGE_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.fullQualityEdgeBps),
    economicEdgeMode: parseEconomicEdgeMode(env.RULE_ECONOMIC_EDGE_MODE, tradingMode),
    minimumEconomicSizeScale: numberEnv(env.RULE_MIN_ECONOMIC_SIZE_SCALE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.minimumEconomicSizeScale),
    minimumMakerFillProbability: numberEnv(env.RULE_MIN_MAKER_FILL_PROBABILITY, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.minimumMakerFillProbability),
    requireMakerEntry: parseBoolean(env.RULE_REQUIRE_MAKER_ENTRY, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.requireMakerEntry),
    minimumSlowTrendAlignment: numberEnv(env.RULE_MIN_SLOW_TREND_ALIGNMENT, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.minimumSlowTrendAlignment),
    minimumSlowTrendEfficiency: numberEnv(env.RULE_MIN_SLOW_TREND_EFFICIENCY, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.minimumSlowTrendEfficiency),
    minimumSlowTrendMoveBps: numberEnv(env.RULE_MIN_SLOW_TREND_MOVE_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.minimumSlowTrendMoveBps),
    minimumEffectiveSampleCount: numberEnv(env.RULE_MIN_EFFECTIVE_SAMPLES, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.minimumEffectiveSampleCount),
    positiveCostErrorP95Bps: numberEnv(env.COST_POSITIVE_ERROR_P95_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.positiveCostErrorP95Bps),
    maximumReasonableCostBps: numberEnv(env.COST_MAXIMUM_REASONABLE_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.maximumReasonableCostBps),
    maximumReasonableGrossBps: numberEnv(env.RULE_MAXIMUM_REASONABLE_GROSS_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.maximumReasonableGrossBps),
    analyticHorizons: parseAnalyticHorizons(env.RULE_ANALYTIC_HORIZONS_JSON),
    calibratedEdges: parseCalibratedEdges(env.RULE_CALIBRATED_EDGE_TABLE_JSON),
    pullbackRecovery: {
      enabled: parseBoolean(env.RULE_PULLBACK_ENABLED, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.pullbackRecovery.enabled),
      horizonMs: numberEnv(env.RULE_PULLBACK_HORIZON_MS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.pullbackRecovery.horizonMs),
      minimumStructuralMoveBps: numberEnv(env.RULE_PULLBACK_MIN_STRUCTURAL_MOVE_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.pullbackRecovery.minimumStructuralMoveBps),
      minimumPullbackDepthBps: numberEnv(env.RULE_PULLBACK_MIN_DEPTH_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.pullbackRecovery.minimumPullbackDepthBps),
      minimumRecoveryBps: numberEnv(env.RULE_PULLBACK_MIN_RECOVERY_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.pullbackRecovery.minimumRecoveryBps),
      minimumRetainedTrendBps: numberEnv(env.RULE_PULLBACK_MIN_RETAINED_TREND_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.pullbackRecovery.minimumRetainedTrendBps),
      minimumRemainingRoomBps: numberEnv(env.RULE_PULLBACK_MIN_REMAINING_ROOM_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.pullbackRecovery.minimumRemainingRoomBps),
      maximumRecoveryFraction: fractionEnv(env.RULE_PULLBACK_MAX_RECOVERY_FRACTION, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.pullbackRecovery.maximumRecoveryFraction),
      captureFraction: fractionEnv(env.RULE_PULLBACK_CAPTURE_FRACTION, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.pullbackRecovery.captureFraction),
      baseUncertaintyBps: numberEnv(env.RULE_PULLBACK_BASE_UNCERTAINTY_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.pullbackRecovery.baseUncertaintyBps),
      roomUncertaintyFraction: fractionEnv(env.RULE_PULLBACK_ROOM_UNCERTAINTY_FRACTION, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.pullbackRecovery.roomUncertaintyFraction),
      maximumGrossBps: numberEnv(env.RULE_PULLBACK_MAX_GROSS_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.pullbackRecovery.maximumGrossBps),
    },
    continuationQuality: {
      ...DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.continuationQuality,
      velocityScale: numberEnv(env.RULE_CONTINUATION_VELOCITY_SCALE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.continuationQuality.velocityScale),
      breakoutScaleBps: numberEnv(env.RULE_CONTINUATION_BREAKOUT_SCALE_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.continuationQuality.breakoutScaleBps),
      volatilityTargetBps: numberEnv(env.RULE_CONTINUATION_VOLATILITY_TARGET_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.continuationQuality.volatilityTargetBps),
      volatilityToleranceBps: numberEnv(env.RULE_CONTINUATION_VOLATILITY_TOLERANCE_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.continuationQuality.volatilityToleranceBps),
    },
    edgeSourceMode: parseEdgeSourceMode(env.RULE_EDGE_SOURCE_MODE),
    analyticEdge: {
      economicHorizonMs: numberEnv(env.RULE_ECONOMIC_HORIZON_MS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge.economicHorizonMs),
      qiKScale: numberEnv(env.RULE_EDGE_QIK_SCALE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge.qiKScale),
      ofiScale: numberEnv(env.RULE_EDGE_OFI_SCALE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge.ofiScale),
      tfiScale: numberEnv(env.RULE_EDGE_TFI_SCALE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge.tfiScale),
      velocityScale: numberEnv(env.RULE_EDGE_VELOCITY_SCALE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge.velocityScale),
      microEdgeScaleBps: numberEnv(env.RULE_EDGE_MICRO_BPS_SCALE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge.microEdgeScaleBps),
      breakoutScaleBps: numberEnv(env.RULE_EDGE_BREAKOUT_BPS_SCALE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge.breakoutScaleBps),
      sigmaCaptureFraction: numberEnv(env.RULE_EDGE_SIGMA_CAPTURE_FRACTION, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge.sigmaCaptureFraction),
      breakoutWeight: numberEnv(env.RULE_EDGE_BREAKOUT_WEIGHT, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge.breakoutWeight),
      maximumGrossBps: numberEnv(env.RULE_EDGE_MAX_GROSS_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge.maximumGrossBps),
      baseUncertaintyBps: numberEnv(env.RULE_EDGE_BASE_UNCERTAINTY_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge.baseUncertaintyBps),
      sigmaUncertaintyFraction: numberEnv(env.RULE_EDGE_SIGMA_UNCERTAINTY_FRACTION, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge.sigmaUncertaintyFraction),
      spreadUncertaintyWeight: numberEnv(env.RULE_EDGE_SPREAD_UNCERTAINTY_WEIGHT, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge.spreadUncertaintyWeight),
      flipUncertaintyWeight: numberEnv(env.RULE_EDGE_FLIP_UNCERTAINTY_WEIGHT, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge.flipUncertaintyWeight),
      fullEvidence: numberEnv(env.RULE_EDGE_FULL_EVIDENCE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticEdge.fullEvidence),
    },
    microTrigger: {
      noiseTauMs: numberEnv(env.MICRO_NOISE_TAU_MS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.noiseTauMs),
      microPressureScale: numberEnv(env.MICRO_PRESSURE_SCALE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.microPressureScale),
      qiKScale: numberEnv(env.MICRO_QIK_SCALE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.qiKScale),
      ofiScale: numberEnv(env.MICRO_OFI_SCALE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.ofiScale),
      tfiScale: numberEnv(env.MICRO_TFI_SCALE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.tfiScale),
      replenishmentScale: numberEnv(env.MICRO_REPLENISHMENT_SCALE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.replenishmentScale),
      velocityScale: numberEnv(env.MICRO_VELOCITY_SCALE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.velocityScale),
      breakoutScaleBps: numberEnv(env.MICRO_BREAKOUT_SCALE_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.breakoutScaleBps),
      microWeight: numberEnv(env.MICRO_WEIGHT_MICRO, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.microWeight),
      qiKWeight: numberEnv(env.MICRO_WEIGHT_QIK, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.qiKWeight),
      ofiWeight: numberEnv(env.MICRO_WEIGHT_OFI, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.ofiWeight),
      tfiWeight: numberEnv(env.MICRO_WEIGHT_TFI, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.tfiWeight),
      replenishmentWeight: numberEnv(env.MICRO_WEIGHT_REPLENISHMENT, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.replenishmentWeight),
      velocityWeight: numberEnv(env.MICRO_WEIGHT_VELOCITY, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.velocityWeight),
      breakoutWeight: numberEnv(env.MICRO_WEIGHT_BREAKOUT, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.breakoutWeight),
      minimumMicroPressure: numberEnv(env.MICRO_MIN_PRESSURE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.minimumMicroPressure),
      minimumQiK: numberEnv(env.MICRO_MIN_QIK, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.minimumQiK),
      minimumOfi: numberEnv(env.MICRO_MIN_OFI, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.minimumOfi),
      minimumTfi: numberEnv(env.MICRO_MIN_TFI, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.minimumTfi),
      minimumReplenishment: numberEnv(env.MICRO_MIN_REPLENISHMENT, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.minimumReplenishment),
      minimumVelocityZ: numberEnv(env.MICRO_MIN_VELOCITY_Z, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.minimumVelocityZ),
      minimumBreakoutBps: numberEnv(env.MICRO_MIN_BREAKOUT_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.minimumBreakoutBps),
      minimumCusum: numberEnv(env.MICRO_MIN_CUSUM, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.minimumCusum),
      minimumMicroMoveBps: numberEnv(env.MICRO_MIN_MOVE_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.minimumMicroMoveBps),
      noiseMovementMultiplier: numberEnv(env.MICRO_NOISE_MOVEMENT_MULTIPLIER, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.noiseMovementMultiplier),
      armScore: numberEnv(env.MICRO_ARM_SCORE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.armScore),
      strongScore: numberEnv(env.MICRO_STRONG_SCORE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.strongScore),
      releaseScore: numberEnv(env.MICRO_RELEASE_SCORE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.releaseScore),
      evidenceDriftAllowance: numberEnv(env.MICRO_EVIDENCE_DRIFT_ALLOWANCE, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.evidenceDriftAllowance),
      opposingEvidencePenalty: numberEnv(env.MICRO_OPPOSING_EVIDENCE_PENALTY, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.opposingEvidencePenalty),
      evidenceTauMs: numberEnv(env.MICRO_EVIDENCE_TAU_MS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.evidenceTauMs),
      fireEvidenceScoreSeconds: numberEnv(env.MICRO_FIRE_EVIDENCE_SCORE_SECONDS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.fireEvidenceScoreSeconds),
      occupancyTauMs: numberEnv(env.MICRO_OCCUPANCY_TAU_MS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.occupancyTauMs),
      minimumOccupancy: numberEnv(env.MICRO_MIN_OCCUPANCY, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.minimumOccupancy),
      minimumConfirmationMs: numberEnv(env.MICRO_MIN_CONFIRMATION_MS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.minimumConfirmationMs),
      strongConfirmationMs: numberEnv(env.MICRO_STRONG_CONFIRMATION_MS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.strongConfirmationMs),
      minimumConfirmationEvents: integerEnv(env.MICRO_MIN_CONFIRMATION_EVENTS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.minimumConfirmationEvents, 1, 10_000),
      strongConfirmationEvents: integerEnv(env.MICRO_STRONG_CONFIRMATION_EVENTS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.strongConfirmationEvents, 1, 10_000),
      maximumChaseBps: numberEnv(env.MICRO_MAX_CHASE_BPS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.maximumChaseBps),
      arbitrationMargin: numberEnv(env.MICRO_ARBITRATION_MARGIN, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.arbitrationMargin),
      candidateRetryMs: integerEnv(env.MICRO_CANDIDATE_RETRY_MS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.candidateRetryMs, 0, 60_000),
      cooldownMs: numberEnv(env.MICRO_COOLDOWN_MS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.cooldownMs),
      maximumEventGapMs: numberEnv(env.MICRO_MAX_EVENT_GAP_MS, DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.microTrigger.maximumEventGapMs),
    },
  };
}

function parseEdgeSourceMode(value: string | undefined): EdgeSourceMode {
  const normalized = (value ?? DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.edgeSourceMode).toUpperCase();
  if (!["CALIBRATED_REQUIRED", "CALIBRATED_OR_ANALYTIC", "ANALYTIC_ONLY"].includes(normalized)) {
    throw new Error(`Unknown RULE_EDGE_SOURCE_MODE: ${value}`);
  }
  return normalized as EdgeSourceMode;
}
function parseEconomicEdgeMode(value: string | undefined, tradingMode: TradingMode): EconomicEdgeMode {
  const fallback: EconomicEdgeMode = tradingMode === "live" ? "CALIBRATED_LIVE"
    : tradingMode === "paper" ? "ANALYTIC_PAPER" : "ANALYTIC_SHADOW";
  const normalized = (value ?? fallback).toUpperCase();
  if (!["ANALYTIC_SHADOW", "ANALYTIC_PAPER", "CALIBRATED_PAPER", "CALIBRATED_LIVE"].includes(normalized)) {
    throw new Error(`Unknown RULE_ECONOMIC_EDGE_MODE: ${value}`);
  }
  const parsed = normalized as EconomicEdgeMode;
  if (tradingMode === "live" && parsed !== "CALIBRATED_LIVE") {
    throw new Error("Live trading requires RULE_ECONOMIC_EDGE_MODE=CALIBRATED_LIVE");
  }
  if (tradingMode !== "live" && parsed === "CALIBRATED_LIVE") {
    throw new Error("CALIBRATED_LIVE economic mode is reserved for live trading");
  }
  return parsed;
}
function parseAnalyticHorizons(value: string | undefined): AnalyticHorizonConfig[] {
  if (value === undefined) return DEFAULT_DETERMINISTIC_SIGNAL_CONFIG.analyticHorizons.map((item) => ({ ...item }));
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) {
    throw new Error(`RULE_ANALYTIC_HORIZONS_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("RULE_ANALYTIC_HORIZONS_JSON must be an array");
  return parsed.map((item, index) => {
    if (!isObject(item)) throw new Error(`RULE_ANALYTIC_HORIZONS_JSON[${index}] must be an object`);
    assertOnlyKeys(item, ["horizonMs", "sigmaCaptureFraction", "breakoutWeight", "maximumGrossBps", "baseUncertaintyBps", "sigmaUncertaintyFraction",
      "trendCaptureFraction", "trendUncertaintyFraction"], `RULE_ANALYTIC_HORIZONS_JSON[${index}]`);
    const numeric = (key: keyof AnalyticHorizonConfig): number => {
      const candidate = item[key];
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) throw new Error(`RULE_ANALYTIC_HORIZONS_JSON[${index}].${key} must be finite`);
      return candidate;
    };
    return { horizonMs: numeric("horizonMs"), sigmaCaptureFraction: numeric("sigmaCaptureFraction"),
      breakoutWeight: numeric("breakoutWeight"), maximumGrossBps: numeric("maximumGrossBps"),
      baseUncertaintyBps: numeric("baseUncertaintyBps"), sigmaUncertaintyFraction: numeric("sigmaUncertaintyFraction"),
      trendCaptureFraction: numeric("trendCaptureFraction"), trendUncertaintyFraction: numeric("trendUncertaintyFraction") };
  });
}
function parseCalibratedEdges(value: string | undefined): CalibratedEdgeBucket[] {
  if (value === undefined) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) {
    throw new Error(`RULE_CALIBRATED_EDGE_TABLE_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("RULE_CALIBRATED_EDGE_TABLE_JSON must be an array");
  return parsed.map((item) => isObject(item) && item.family === undefined
    ? { ...item, family: "CONTINUATION" } : item) as CalibratedEdgeBucket[];
}
function loadDeterministicHoldConfig(env: NodeJS.ProcessEnv): DeterministicHoldConfig {
  return {
    ...DEFAULT_DETERMINISTIC_HOLD_CONFIG,
    holdHorizonMs: numberEnv(env.RULE_HOLD_HORIZON_MS, DEFAULT_DETERMINISTIC_HOLD_CONFIG.holdHorizonMs),
    kinematicSigmaCap: numberEnv(env.RULE_HOLD_KINEMATIC_SIGMA_CAP, DEFAULT_DETERMINISTIC_HOLD_CONFIG.kinematicSigmaCap),
    flowSigmaScale: numberEnv(env.RULE_HOLD_FLOW_SIGMA_SCALE, DEFAULT_DETERMINISTIC_HOLD_CONFIG.flowSigmaScale),
    totalSigmaCap: numberEnv(env.RULE_HOLD_TOTAL_SIGMA_CAP, DEFAULT_DETERMINISTIC_HOLD_CONFIG.totalSigmaCap),
    minimumContinuationScore: numberEnv(env.RULE_MIN_CONTINUATION_SCORE, DEFAULT_DETERMINISTIC_HOLD_CONFIG.minimumContinuationScore),
    reversalVoteThreshold: integerEnv(env.RULE_REVERSAL_VOTE_THRESHOLD, DEFAULT_DETERMINISTIC_HOLD_CONFIG.reversalVoteThreshold, 1, 5),
    opposingAccelerationZ: numberEnv(env.RULE_REVERSAL_ACCELERATION_Z, DEFAULT_DETERMINISTIC_HOLD_CONFIG.opposingAccelerationZ),
    opposingOfi: numberEnv(env.RULE_REVERSAL_OFI, DEFAULT_DETERMINISTIC_HOLD_CONFIG.opposingOfi),
    opposingTfi: numberEnv(env.RULE_REVERSAL_TFI, DEFAULT_DETERMINISTIC_HOLD_CONFIG.opposingTfi),
    opposingReplenishment: numberEnv(env.RULE_REVERSAL_REPLENISHMENT, DEFAULT_DETERMINISTIC_HOLD_CONFIG.opposingReplenishment),
    opposingCusum: numberEnv(env.RULE_REVERSAL_CUSUM, DEFAULT_DETERMINISTIC_HOLD_CONFIG.opposingCusum),
    uncertaintySpreadPenaltyBps: numberEnv(env.RULE_HOLD_SPREAD_PENALTY_BPS, DEFAULT_DETERMINISTIC_HOLD_CONFIG.uncertaintySpreadPenaltyBps),
    uncertaintyFlipPenaltyBps: numberEnv(env.RULE_HOLD_FLIP_PENALTY_BPS, DEFAULT_DETERMINISTIC_HOLD_CONFIG.uncertaintyFlipPenaltyBps),
    minimumHoldEdgeBps: numberEnv(env.RULE_MIN_HOLD_EDGE_BPS, DEFAULT_DETERMINISTIC_HOLD_CONFIG.minimumHoldEdgeBps),
  };
}
function parseModel(json: string | undefined): { version: string; probabilityHead: LinearHead; returnHead: LinearHead } {
  if (!json) return { version: "untrained-zero", probabilityHead: { intercept: 0, weights: zeroWeights() }, returnHead: { intercept: 0, weights: zeroWeights() } };
  const parsed = JSON.parse(json) as { version?: unknown; probabilityHead?: LinearHead; returnHead?: LinearHead };
  if (!parsed.probabilityHead || !parsed.returnHead || parsed.probabilityHead.weights.length !== MODEL_DIMENSION || parsed.returnHead.weights.length !== MODEL_DIMENSION) throw new Error(`MODEL_CONFIG_JSON must contain ${MODEL_DIMENSION}-element probability and return heads`);
  return { version: typeof parsed.version === "string" ? parsed.version : "external", probabilityHead: parsed.probabilityHead, returnHead: parsed.returnHead };
}
