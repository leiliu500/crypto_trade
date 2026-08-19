/**
 * Exact decimal conversion at the Alpaca adapter boundary. Values remain bigint
 * ticks/lots until strategy math explicitly converts validated units to number.
 */
export interface DecimalGrid {
  increment: string;
  scale: number;
  incrementUnits: bigint;
}

const DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;

export function decimalPlaces(value: string): number {
  const match = DECIMAL_RE.exec(value);
  if (!match) throw new Error(`Invalid unsigned decimal: ${value}`);
  return match[1]?.length ?? 0;
}

export function decimalToUnits(value: string, scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new Error("scale must be an integer from 0 through 18");
  }
  const match = DECIMAL_RE.exec(value);
  if (!match) throw new Error(`Invalid unsigned decimal: ${value}`);
  const fraction = match[1] ?? "";
  if (fraction.length > scale) {
    const discarded = fraction.slice(scale);
    if (/[1-9]/.test(discarded)) {
      throw new Error(`${value} has precision beyond scale ${scale}`);
    }
  }
  const padded = fraction.slice(0, scale).padEnd(scale, "0");
  return BigInt(match[0]!.split(".")[0]!) * 10n ** BigInt(scale) + BigInt(padded || "0");
}

export function unitsToDecimal(units: bigint, scale: number): string {
  if (units < 0n) throw new Error("units must be unsigned");
  const divisor = 10n ** BigInt(scale);
  const whole = units / divisor;
  if (scale === 0) return whole.toString();
  const fraction = (units % divisor).toString().padStart(scale, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function createGrid(increment: string): DecimalGrid {
  const scale = decimalPlaces(increment);
  const incrementUnits = decimalToUnits(increment, scale);
  if (incrementUnits <= 0n) throw new Error("increment must be positive");
  return { increment, scale, incrementUnits };
}

export function floorToGrid(value: string, grid: DecimalGrid): string {
  const units = decimalToUnits(value, grid.scale);
  return unitsToDecimal((units / grid.incrementUnits) * grid.incrementUnits, grid.scale);
}

export function ceilToGrid(value: string, grid: DecimalGrid): string {
  const units = decimalToUnits(value, grid.scale);
  const rounded = ((units + grid.incrementUnits - 1n) / grid.incrementUnits) * grid.incrementUnits;
  return unitsToDecimal(rounded, grid.scale);
}

export function numberToDecimal(value: number, scale = 12): string {
  if (!Number.isFinite(value) || value < 0) throw new Error("value must be finite and unsigned");
  return value.toFixed(scale).replace(/\.?0+$/, "");
}

export function validatedNumber(value: string, name: string): number {
  if (!DECIMAL_RE.test(value)) throw new Error(`Invalid ${name}: ${value}`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`Invalid ${name}: ${value}`);
  return result;
}
