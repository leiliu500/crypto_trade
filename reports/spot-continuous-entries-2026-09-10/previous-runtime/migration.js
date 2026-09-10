import { isDeepStrictEqual } from "node:util";
import { markSpotAccount } from "./account.js";
import { SPOT_PAPER_SPEC, validateSpotPaperState } from "./paper.js";
export const LEGACY_SPOT_RUNTIME_SHA256 = "afd5901af926b5541021d654a670e342bebd6e8fb9174e9cb8fc5f4192c74a63";
export const LEGACY_SPOT_EVIDENCE_SHA256 = "3eed46dd2a5f17dc48e87e190243971754b1c7b0394ebcadb4eb289d30ebb509";
export const LEGACY_SPOT_VERSION = "btc-spot-weekly-research-paper-runner-v1";
/** The deployed v1 ledger is flat and has no fills. Never invent past order submissions. */
export function migrateLegacySpotState(value, sourceSha256) {
    if (!value || typeof value !== "object")
        throw new Error("INVALID_SPOT_MIGRATION_STATE");
    const state = value, account = state.account;
    if (sourceSha256 !== LEGACY_SPOT_RUNTIME_SHA256 || state.version !== LEGACY_SPOT_VERSION
        || state.mode !== "RESEARCH_PAPER" || state.evidenceSha256 !== LEGACY_SPOT_EVIDENCE_SHA256
        || "orders" in state || !account || !Array.isArray(account.receipts) || account.receipts.length !== 0
        || account.initialCashUsd !== 100_000 || account.cashUsd !== 100_000 || account.quantity !== 0
        || account.entryCostUsd !== 0 || account.realizedNetUsd !== 0 || account.feesUsd !== 0)
        throw new Error("SPOT_MIGRATION_REQUIRES_KNOWN_UNTRADED_V1_LEDGER");
    markSpotAccount(account, 1, 80);
    const next = { ...state, version: SPOT_PAPER_SPEC.version, orders: [] };
    validateSpotPaperState(next);
    if (!isDeepStrictEqual(next.account, account))
        throw new Error("SPOT_MIGRATION_CHANGED_CAPITAL");
    return next;
}
//# sourceMappingURL=migration.js.map