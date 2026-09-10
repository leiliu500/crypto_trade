import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { RiskTrainingOrigin } from "./training-backfill.js";
import { DISTRIBUTION_ACTIONS, DISTRIBUTION_SPEC } from "./spec.js";

export const RISK_TRAINING_ORIGIN_ENCODING = "risk-training-origins-json-gzip-base64-v1";
export const MAXIMUM_DECODED_ORIGIN_BYTES = 256 * 1024 * 1024;
const maximumOrigins = DISTRIBUTION_SPEC.symbols.length * DISTRIBUTION_ACTIONS.length * DISTRIBUTION_SPEC.maximumSamples;
const maximumEncodedBytes = 64 * 1024 * 1024;
export interface PackedRiskTrainingOrigins {
  encoding: typeof RISK_TRAINING_ORIGIN_ENCODING;
  decodedBytes: number;
  decodedSha256: string;
  gzipSha256: string;
  data: string;
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;

/** A lossless representation change only. Decoded origin hashes, labels, source
 * identities and every observed book level remain untouched. */
export function packRiskTrainingOrigins(origins: readonly RiskTrainingOrigin[]): PackedRiskTrainingOrigins {
  if (!Array.isArray(origins) || origins.length > maximumOrigins) throw new Error("INVALID_RISK_TRAINING_ORIGIN_COUNT");
  const decoded = Buffer.from(JSON.stringify(origins));
  if (decoded.length > MAXIMUM_DECODED_ORIGIN_BYTES) throw new Error("RISK_TRAINING_ORIGINS_EXCEED_DECODED_LIMIT");
  const compressed = gzipSync(decoded), data = compressed.toString("base64");
  if (data.length > maximumEncodedBytes) throw new Error("RISK_TRAINING_ORIGINS_EXCEED_ENCODED_LIMIT");
  return { encoding: RISK_TRAINING_ORIGIN_ENCODING, decodedBytes: decoded.length,
    decodedSha256: sha(decoded), gzipSha256: sha(compressed), data };
}

/** Legacy uncompressed v2 is accepted without changing its source provenance.
 * Decompression is capped by both the declared size and a fixed hard bound. */
export function readRiskTrainingOrigins(provenance: Record<string, unknown>): RiskTrainingOrigin[] {
  const raw = Object.hasOwn(provenance, "origins"), packed = Object.hasOwn(provenance, "originsPacked");
  if (raw === packed) throw new Error("INVALID_RISK_TRAINING_ORIGIN_REPRESENTATION");
  if (raw) {
    if (!Array.isArray(provenance.origins) || provenance.origins.length > maximumOrigins)
      throw new Error("INVALID_RISK_TRAINING_ORIGIN_COUNT");
    return provenance.origins as RiskTrainingOrigin[];
  }
  const value = provenance.originsPacked as PackedRiskTrainingOrigins;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "data,decodedBytes,decodedSha256,encoding,gzipSha256"
    || value.encoding !== RISK_TRAINING_ORIGIN_ENCODING
    || !Number.isSafeInteger(value.decodedBytes) || value.decodedBytes < 2 || value.decodedBytes > MAXIMUM_DECODED_ORIGIN_BYTES
    || !hashPattern.test(value.decodedSha256) || !hashPattern.test(value.gzipSha256)
    || typeof value.data !== "string" || value.data.length === 0 || value.data.length > maximumEncodedBytes
    || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data))
    throw new Error("INVALID_RISK_TRAINING_PACKED_ORIGINS");
  const compressed = Buffer.from(value.data, "base64");
  if (compressed.toString("base64") !== value.data || sha(compressed) !== value.gzipSha256)
    throw new Error("RISK_TRAINING_ORIGINS_COMPRESSED_HASH_MISMATCH");
  let decoded: Buffer;
  try { decoded = gunzipSync(compressed, { maxOutputLength: value.decodedBytes }); }
  catch { throw new Error("RISK_TRAINING_ORIGINS_INVALID_OR_OVERSIZED_GZIP"); }
  if (decoded.length !== value.decodedBytes || sha(decoded) !== value.decodedSha256)
    throw new Error("RISK_TRAINING_ORIGINS_DECODED_HASH_OR_SIZE_MISMATCH");
  let origins: unknown;
  try { origins = JSON.parse(decoded.toString("utf8")); }
  catch { throw new Error("RISK_TRAINING_ORIGINS_INVALID_JSON"); }
  if (!Array.isArray(origins) || origins.length > maximumOrigins) throw new Error("INVALID_RISK_TRAINING_ORIGIN_COUNT");
  return origins as RiskTrainingOrigin[];
}
