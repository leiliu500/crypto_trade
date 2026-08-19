import { quantile } from "../core/statistics.js";

export interface BacktestTrade {
  symbol: string;
  side: 1 | -1;
  regime: string;
  openedMs: number;
  closedMs: number;
  entryPx: number;
  exitPx: number;
  qty: number;
  grossPnl: number;
  fees: number;
  funding: number;
  slippage: number;
  netPnl: number;
  predictedReturnBps: number;
  realizedReturnBps: number;
  probability: number;
  profitableLabel: 0 | 1;
  mfe: number;
  mae: number;
  implementationShortfall: number;
  maker: boolean;
  makerFilled: boolean;
  makerAdverseSelection: number;
  latencyMs: number;
  volatilityState: string;
}

export interface BacktestMetrics {
  tradeCount: number;
  netExpectancy: number;
  totalNetPnl: number;
  maximumDrawdown: number;
  cvar99: number;
  profitFactor: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  payoffRatio: number;
  mfe: number[];
  mae: number[];
  edgeCapture: number;
  implementationShortfall: number;
  makerFillProbability: number;
  makerAdverseSelection: number;
  takerSlippage: number;
  feePercentageOfGrossAlpha: number;
  latency: { p50: number; p90: number; p95: number; p99: number; max: number };
  canceledOrderRatio: number;
  unknownOrderStateIncidents: number;
  pnlByRegime: Record<string, number>;
  pnlBySide: Record<string, number>;
  pnlBySymbol: Record<string, number>;
  pnlByHourUtc: Record<string, number>;
  pnlByVolatilityState: Record<string, number>;
  brierScore: number;
  predictedRealizedCorrelation: number;
  modelDrift: number;
  featureDrift: number;
}

export function calculateMetrics(trades: readonly BacktestTrade[], orderStats: { submitted: number; canceled: number; unknown: number } = { submitted: 0, canceled: 0, unknown: 0 }): BacktestMetrics {
  const wins = trades.filter((trade) => trade.netPnl > 0), losses = trades.filter((trade) => trade.netPnl < 0);
  const grossWins = sum(wins.map((trade) => trade.netPnl));
  const grossLosses = Math.abs(sum(losses.map((trade) => trade.netPnl)));
  const averageWin = wins.length ? grossWins / wins.length : 0;
  const averageLoss = losses.length ? grossLosses / losses.length : 0;
  const equity = trades.reduce<number[]>((curve, trade) => [...curve, curve.at(-1)! + trade.netPnl], [0]);
  let peak = 0, maximumDrawdown = 0;
  for (const value of equity) { peak = Math.max(peak, value); maximumDrawdown = Math.max(maximumDrawdown, peak - value); }
  const tailCount = Math.max(1, Math.ceil(trades.length * .01));
  const lossesSorted = trades.map((trade) => -trade.netPnl).sort((a, b) => b - a);
  const maker = trades.filter((trade) => trade.maker), taker = trades.filter((trade) => !trade.maker);
  const latency = trades.map((trade) => trade.latencyMs);
  const predicted = trades.map((trade) => trade.predictedReturnBps);
  const realized = trades.map((trade) => trade.realizedReturnBps);
  const midpoint = Math.floor(trades.length / 2);
  const earlyError = mean(trades.slice(0, midpoint).map((trade) => Math.abs(trade.predictedReturnBps - trade.realizedReturnBps)));
  const lateError = mean(trades.slice(midpoint).map((trade) => Math.abs(trade.predictedReturnBps - trade.realizedReturnBps)));
  return {
    tradeCount: trades.length,
    netExpectancy: mean(trades.map((trade) => trade.netPnl)), totalNetPnl: sum(trades.map((trade) => trade.netPnl)), maximumDrawdown,
    cvar99: mean(lossesSorted.slice(0, tailCount)), profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Number.POSITIVE_INFINITY : 0,
    winRate: trades.length ? wins.length / trades.length : 0, averageWin, averageLoss, payoffRatio: averageLoss > 0 ? averageWin / averageLoss : 0,
    mfe: trades.map((trade) => trade.mfe), mae: trades.map((trade) => trade.mae),
    edgeCapture: ratio(sum(realized), sum(predicted)), implementationShortfall: mean(trades.map((trade) => trade.implementationShortfall)),
    makerFillProbability: maker.length ? maker.filter((trade) => trade.makerFilled).length / maker.length : 0,
    makerAdverseSelection: mean(maker.map((trade) => trade.makerAdverseSelection)), takerSlippage: mean(taker.map((trade) => trade.slippage)),
    feePercentageOfGrossAlpha: 100 * ratio(sum(trades.map((trade) => trade.fees)), Math.abs(sum(trades.map((trade) => trade.grossPnl)))),
    latency: { p50: quantile(latency, .5), p90: quantile(latency, .9), p95: quantile(latency, .95), p99: quantile(latency, .99), max: latency.length ? Math.max(...latency) : 0 },
    canceledOrderRatio: ratio(orderStats.canceled, orderStats.submitted), unknownOrderStateIncidents: orderStats.unknown,
    pnlByRegime: groupPnl(trades, (trade) => trade.regime), pnlBySide: groupPnl(trades, (trade) => trade.side === 1 ? "long" : "short"),
    pnlBySymbol: groupPnl(trades, (trade) => trade.symbol),
    pnlByHourUtc: groupPnl(trades, (trade) => String(new Date(trade.openedMs).getUTCHours()).padStart(2, "0")),
    pnlByVolatilityState: groupPnl(trades, (trade) => trade.volatilityState),
    brierScore: mean(trades.map((trade) => Math.pow(trade.probability - trade.profitableLabel, 2))),
    predictedRealizedCorrelation: correlation(predicted, realized), modelDrift: lateError - earlyError, featureDrift: 0,
  };
}

function groupPnl(trades: readonly BacktestTrade[], key: (trade: BacktestTrade) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const trade of trades) result[key(trade)] = (result[key(trade)] ?? 0) + trade.netPnl;
  return result;
}
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const mean = (values: readonly number[]): number => values.length ? sum(values) / values.length : 0;
const ratio = (numerator: number, denominator: number): number => denominator ? numerator / denominator : 0;
function correlation(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length < 2) return 0;
  const ma = mean(a), mb = mean(b);
  let covariance = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i += 1) { const da = a[i]! - ma, db = b[i]! - mb; covariance += da * db; va += da * da; vb += db * db; }
  return covariance / Math.max(Math.sqrt(va * vb), 1e-12);
}
