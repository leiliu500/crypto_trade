const MAXIMUM_SANE_FEE_BPS_PER_LEG = 500;

/** Explicit unit conversions prevent percent/decimal/basis-point ambiguity at configuration boundaries. */
export function percentToBps(percent: number): number { return validateFeeBps(percent * 100, "fee percent"); }
export function decimalRateToBps(decimalRate: number): number { return validateFeeBps(decimalRate * 10_000, "fee decimal rate"); }

export function validateFeeBps(value: number, name = "fee"): number {
  if (!Number.isFinite(value) || value < 0 || value > MAXIMUM_SANE_FEE_BPS_PER_LEG) {
    throw new Error(`${name} must be a finite basis-point value in [0, ${MAXIMUM_SANE_FEE_BPS_PER_LEG}]`);
  }
  return value;
}

export interface FeeSchedule { makerFeeBps: number; takerFeeBps: number; source: "CONFIG" | "BROKER"; observedMs: number; }

export class ConfiguredFeeScheduleProvider {
  private readonly schedule: FeeSchedule;
  public constructor(makerFeeBps: number, takerFeeBps: number, observedMs = Date.now()) {
    this.schedule = {
      makerFeeBps: validateFeeBps(makerFeeBps, "makerFeeBps"),
      takerFeeBps: validateFeeBps(takerFeeBps, "takerFeeBps"),
      source: "CONFIG", observedMs,
    };
  }
  public current(): FeeSchedule { return { ...this.schedule }; }
}

export class CachedBrokerFeeScheduleProvider {
  private cached?: FeeSchedule;
  public constructor(private readonly load: () => Promise<{ makerFeeBps: number; takerFeeBps: number }>,
    private readonly ttlMs = 15 * 60_000, private readonly now = Date.now) {}

  public async current(): Promise<FeeSchedule> {
    const nowMs = this.now();
    if (this.cached && nowMs - this.cached.observedMs < this.ttlMs) return { ...this.cached };
    const loaded = await this.load();
    this.cached = { makerFeeBps: validateFeeBps(loaded.makerFeeBps, "broker makerFeeBps"),
      takerFeeBps: validateFeeBps(loaded.takerFeeBps, "broker takerFeeBps"), source: "BROKER", observedMs: nowMs };
    return { ...this.cached };
  }
}
