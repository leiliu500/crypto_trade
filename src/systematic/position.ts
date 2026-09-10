import type { Direction } from "../core/market.js";
import { netLiquidation, requiredNetExecutionPrice, validLinearLedger, type LinearLedger } from "../economics/net-liquidation.js";
import { SYSTEMATIC_SPEC as S, type SystematicPositionSpec } from "./spec.js";

/** Cash-unit trail state; the original entry basis survives reductions. */
export interface SystematicProtection {
  referenceEntryPx: number; entryNotional: number; initialRiskUsd: number;
  peakNetUsd: number; floorNetUsd: number; activated: boolean;
}
export interface SystematicExitState {
  side: Direction; qty: number; entryPx: number; openedMs: number; phase: string;
  systematic?: SystematicPositionSpec; ledger?: LinearLedger;
  systematicProtection?: SystematicProtection;
}
export interface SystematicExitEvaluation {
  action: "HOLD" | "EXIT"; reason?: string; protection?: SystematicProtection;
  netLiquidationUsd?: number; floorPx?: number; stopPx?: number;
}

export function validSystematicPositionSpec(value: unknown): value is SystematicPositionSpec {
  if (!value || typeof value !== "object") return false;
  const p = value as SystematicPositionSpec;
  return p.version === S.version && typeof p.signalId === "string" && p.signalId.length > 0
    && Number.isFinite(p.signalBarCloseMs) && p.signalBarCloseMs >= 0
    && [p.stopBps, p.targetBps, p.trailingBps, p.trailActivationR, p.maximumHoldMs]
      .every(n => Number.isFinite(n) && n > 0)
    && p.stopBps < 10_000 && p.maximumHoldMs <= S.maximumHoldMs
    && [p.feeBps, p.fundingReserveBps].every(n => Number.isFinite(n) && n >= 0)
    && p.feeBps < 10_000;
}

export function validSystematicProtection(value: unknown): value is SystematicProtection {
  if (!value || typeof value !== "object") return false;
  const p = value as SystematicProtection;
  return [p.referenceEntryPx, p.entryNotional, p.initialRiskUsd].every(n => Number.isFinite(n) && n > 0)
    && [p.peakNetUsd, p.floorNetUsd].every(Number.isFinite)
    && p.peakNetUsd >= 0 && p.floorNetUsd <= p.peakNetUsd && typeof p.activated === "boolean";
}

/** Pure exit rules shared by paper execution and replay. Prices already include
 * spread/impact; the ledger charges actual entry/exit fees and one reserve. */
export function evaluateSystematicExit(p: SystematicExitState, executableExitPx: number,
  nowMs: number): SystematicExitEvaluation {
  const exit = (reason: string): SystematicExitEvaluation => ({ action: "EXIT", reason });
  if (!validSystematicPositionSpec(p.systematic)) return exit("SYSTEMATIC_INVALID_METADATA");
  if (p.phase === "EXITING") return exit("SYSTEMATIC_EXIT_LATCHED");
  if (![p.qty, p.entryPx, executableExitPx].every(n => Number.isFinite(n) && n > 0)
    || ![1, -1].includes(p.side) || !Number.isFinite(p.openedMs) || !Number.isFinite(nowMs)
    || p.openedMs < 0 || nowMs < p.openedMs) return exit("SYSTEMATIC_INVALID_POSITION");
  const l = p.ledger, spec = p.systematic;
  if (!validLinearLedger(l) || l.side !== p.side || Math.abs(l.remainingQty - p.qty) > Math.max(1e-10, p.qty * 1e-8)
    || Math.abs(l.entryNotional / l.entryQty - p.entryPx) > Math.max(1e-8, p.entryPx * 1e-6)) {
    return exit("SYSTEMATIC_LEDGER_UNCERTAIN");
  }
  const reserveUsd = l.entryNotional * spec.fundingReserveBps / 10_000;
  const referenceEntryPx = l.entryNotional / l.entryQty;
  const hardStopPx = referenceEntryPx * (1 - p.side * spec.stopBps / 10_000);
  const initialRiskUsd = l.entryNotional * spec.stopBps / 10_000;
  if (p.systematicProtection === undefined && p.phase !== "OPEN") {
    return exit("SYSTEMATIC_PROTECTION_UNCERTAIN");
  }
  if (p.systematicProtection !== undefined && (!validSystematicProtection(p.systematicProtection)
    || Math.abs(p.systematicProtection.referenceEntryPx - referenceEntryPx) > referenceEntryPx * 1e-8
    || Math.abs(p.systematicProtection.entryNotional - l.entryNotional) > l.entryNotional * 1e-8
    || Math.abs(p.systematicProtection.initialRiskUsd - initialRiskUsd) > initialRiskUsd * 1e-8)) {
    return exit("SYSTEMATIC_PROTECTION_UNCERTAIN");
  }
  const protection = p.systematicProtection ? { ...p.systematicProtection } : {
    referenceEntryPx, entryNotional: l.entryNotional, initialRiskUsd, peakNetUsd: 0,
    floorNetUsd: netLiquidation(l, hardStopPx, spec.feeBps, reserveUsd), activated: false,
  };
  const net = netLiquidation(l, executableExitPx, spec.feeBps, reserveUsd);
  protection.peakNetUsd = Math.max(protection.peakNetUsd, net);
  if (protection.peakNetUsd >= initialRiskUsd * spec.trailActivationR) protection.activated = true;
  if (protection.activated) protection.floorNetUsd = Math.max(protection.floorNetUsd,
    protection.peakNetUsd - l.entryNotional * spec.trailingBps / 10_000);
  const netStopPx = requiredNetExecutionPrice(l, protection.floorNetUsd, spec.feeBps, reserveUsd);
  const stopPx = netStopPx === null ? hardStopPx : p.side === 1
    ? Math.max(hardStopPx, netStopPx) : Math.min(hardStopPx, netStopPx);
  const state = { protection, netLiquidationUsd: net, stopPx, floorPx: p.side * (stopPx - p.entryPx) };
  const reason = p.side * (executableExitPx - hardStopPx) <= 0 ? "SYSTEMATIC_STOP"
    : net >= l.entryNotional * spec.targetBps / 10_000 ? "SYSTEMATIC_TARGET"
      : protection.activated && net <= protection.floorNetUsd ? "SYSTEMATIC_TRAIL"
        : nowMs - p.openedMs >= Math.min(spec.maximumHoldMs, S.maximumHoldMs) ? "SYSTEMATIC_DEADLINE" : null;
  return reason ? { action: "EXIT", reason, ...state } : { action: "HOLD", ...state };
}
