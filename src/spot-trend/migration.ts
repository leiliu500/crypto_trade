import { isDeepStrictEqual } from "node:util";
import { markSpotAccount, type SpotAccount } from "./account.js";
import { SPOT_PAPER_SPEC, validateSpotPaperState, type SpotPaperState } from "./paper.js";

export const LEGACY_SPOT_RUNTIME_SHA256 = "afd5901af926b5541021d654a670e342bebd6e8fb9174e9cb8fc5f4192c74a63";
export const LEGACY_SPOT_EVIDENCE_SHA256 = "3eed46dd2a5f17dc48e87e190243971754b1c7b0394ebcadb4eb289d30ebb509";
export const LEGACY_SPOT_VERSION = "btc-spot-weekly-research-paper-runner-v1";
export const PREVIOUS_SPOT_RUNTIME_SHA256 = "7f98cc50ef5158dc075f6a172eeb4343cbce286c5a676debe2a17335dcc229da";
export const PREVIOUS_SPOT_VERSION = "btc-spot-weekly-research-paper-runner-v2";

/** Validate the known prior schema without mutating its source-bound historical state. */
export function validatePreviousSpotState(value: unknown, sourceSha256: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_SPOT_UPGRADE_STATE");
  const state = value as Record<string, unknown>;
  if (sourceSha256 !== PREVIOUS_SPOT_RUNTIME_SHA256 || state.version !== PREVIOUS_SPOT_VERSION
    || state.mode !== "RESEARCH_PAPER" || state.evidenceSha256 !== LEGACY_SPOT_EVIDENCE_SHA256)
    throw new Error("SPOT_UPGRADE_REQUIRES_KNOWN_V2_LEDGER");
  validateSpotPaperState({ ...state, version: SPOT_PAPER_SPEC.version } as unknown as SpotPaperState);
}

/** A policy switch cannot silently adopt requests submitted under the prior timing policy. */
export function migratePreviousSpotState(value: unknown, sourceSha256: string): SpotPaperState {
  validatePreviousSpotState(value, sourceSha256);
  if (String(SPOT_PAPER_SPEC.version) !== "btc-spot-weekly-research-paper-runner-v3")
    throw new Error("SPOT_UPGRADE_REQUIRES_REVIEWED_V3_TARGET");
  const state = value as SpotPaperState;
  if (state.orders.some(order => order.status === "SUBMITTED" || order.status === "ACCEPTED"))
    throw new Error("SPOT_UPGRADE_REQUIRES_NO_PENDING_ORDERS");
  // Account, orders, receipts, clocks, signal, and decision remain the exact prior values.
  return { ...state, version: SPOT_PAPER_SPEC.version };
}

/** The deployed v1 ledger is flat and has no fills. Never invent past order submissions. */
export function migrateLegacySpotState(value: unknown, sourceSha256: string): SpotPaperState {
  if (!value || typeof value !== "object") throw new Error("INVALID_SPOT_MIGRATION_STATE");
  const state = value as Record<string, unknown>, account = state.account as SpotAccount;
  if (sourceSha256 !== LEGACY_SPOT_RUNTIME_SHA256 || state.version !== LEGACY_SPOT_VERSION
    || state.mode !== "RESEARCH_PAPER" || state.evidenceSha256 !== LEGACY_SPOT_EVIDENCE_SHA256
    || "orders" in state || !account || !Array.isArray(account.receipts) || account.receipts.length !== 0
    || account.initialCashUsd !== 100_000 || account.cashUsd !== 100_000 || account.quantity !== 0
    || account.entryCostUsd !== 0 || account.realizedNetUsd !== 0 || account.feesUsd !== 0)
    throw new Error("SPOT_MIGRATION_REQUIRES_KNOWN_UNTRADED_V1_LEDGER");
  markSpotAccount(account, 1, 80);
  const next = { ...state, version: SPOT_PAPER_SPEC.version, orders: [] } as unknown as SpotPaperState;
  validateSpotPaperState(next);
  if (!isDeepStrictEqual(next.account, account)) throw new Error("SPOT_MIGRATION_CHANGED_CAPITAL");
  return next;
}
