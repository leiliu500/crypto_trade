export interface Exposure { symbol: string; notional: number; cluster: string; stressedLoss: number; }
export interface PortfolioRiskConfig { maximumVariance: number; maximumClusterPositions: number; maximumGrossNotional: number; rollingLossBudgetFraction: number; }

export class PortfolioRiskEngine {
  private readonly exposures = new Map<string, Exposure>();
  private covarianceSymbols: string[] = [];
  private covariance: number[][] = [];
  public constructor(private readonly cfg: PortfolioRiskConfig) {}
  public updateExposure(exposure: Exposure): void {
    if (Math.abs(exposure.notional) <= 1e-12) this.exposures.delete(exposure.symbol);
    else this.exposures.set(exposure.symbol, exposure);
  }
  public setCovariance(symbols: readonly string[], covariance: readonly (readonly number[])[]): void {
    if (covariance.length !== symbols.length || covariance.some((row) => row.length !== symbols.length)) throw new Error("Invalid covariance dimensions");
    this.covarianceSymbols = [...symbols];
    this.covariance = covariance.map((row) => [...row]);
  }
  public portfolioVariance(candidate?: Exposure): number {
    const effective = new Map(this.exposures);
    if (candidate) effective.set(candidate.symbol, candidate);
    const weights = this.covarianceSymbols.map((symbol) => effective.get(symbol)?.notional ?? 0);
    let variance = 0;
    for (let i = 0; i < weights.length; i += 1) for (let j = 0; j < weights.length; j += 1) variance += weights[i]! * (this.covariance[i]?.[j] ?? 0) * weights[j]!;
    return Math.max(0, variance);
  }
  public marginalRiskContribution(symbol: string): number {
    const index = this.covarianceSymbols.indexOf(symbol);
    if (index < 0) return 0;
    const weights = this.covarianceSymbols.map((item) => this.exposures.get(item)?.notional ?? 0);
    const sigmaW = this.covariance[index]!.reduce((sum, value, j) => sum + value * weights[j]!, 0);
    return weights[index]! * sigmaW / Math.max(Math.sqrt(this.portfolioVariance()), 1e-12);
  }
  public canAdd(candidate: Exposure, equity: number, realizedLoss: number): boolean {
    const effective = [...this.exposures.values()].filter((item) => item.symbol !== candidate.symbol);
    const clusterCount = effective.filter((item) => item.cluster === candidate.cluster).length;
    const gross = effective.reduce((sum, item) => sum + Math.abs(item.notional), 0) + Math.abs(candidate.notional);
    const stressedLoss = effective.reduce((sum, item) => sum + item.stressedLoss, 0) + candidate.stressedLoss;
    return clusterCount < this.cfg.maximumClusterPositions
      && gross <= this.cfg.maximumGrossNotional
      && (this.covariance.length === 0 || this.portfolioVariance(candidate) <= this.cfg.maximumVariance)
      && realizedLoss + stressedLoss < equity * this.cfg.rollingLossBudgetFraction;
  }
  public stressedOpenLoss(): number { return [...this.exposures.values()].reduce((sum, item) => sum + item.stressedLoss, 0); }
}
