import { type SpotPaperState } from "./paper.js";
export declare const LEGACY_SPOT_RUNTIME_SHA256 = "afd5901af926b5541021d654a670e342bebd6e8fb9174e9cb8fc5f4192c74a63";
export declare const LEGACY_SPOT_EVIDENCE_SHA256 = "3eed46dd2a5f17dc48e87e190243971754b1c7b0394ebcadb4eb289d30ebb509";
export declare const LEGACY_SPOT_VERSION = "btc-spot-weekly-research-paper-runner-v1";
/** The deployed v1 ledger is flat and has no fills. Never invent past order submissions. */
export declare function migrateLegacySpotState(value: unknown, sourceSha256: string): SpotPaperState;
