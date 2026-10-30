import { createHmac } from "node:crypto";
import { timingSafeEqualHex } from "../lib/crypto.js";

/** Verifies the signature on an inbound acquirer callback. */

interface ParsedAcquirerSignatureHeader {
  timestamp: number;
  signature: string;
}

function parseAcquirerSignatureHeader(header: string): ParsedAcquirerSignatureHeader | null {
  let timestampStr: string | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key === "t") timestampStr = value;
    else if (key === "v1") signature = value;
  }

  if (!timestampStr || !signature) return null;
  if (!/^\d+$/.test(timestampStr)) return null;

  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return null;

  return { timestamp, signature };
}

export type VerifyAcquirerCallbackFailureReason =
  | "malformed_header"
  | "missing_signature"
  | "signature_mismatch"
  | "timestamp_out_of_tolerance";

export interface VerifyAcquirerCallbackResult {
  valid: boolean;
  reason?: VerifyAcquirerCallbackFailureReason;
}

/**
 * Verifies the acquirer callback signature. This is the ONLY authentication
 * the public /v1/acquirer/callbacks endpoint has, so:
 *
 * - A missing header is a rejection by default. It used to be accepted
 *   whenever ACQUIRER_CALLBACK_REQUIRE_SIGNATURE was unset (the default), so
 *   anyone could post fraud verdicts by simply leaving the header off.
 * - An empty secret never verifies (an HMAC keyed with "" is forgeable).
 * - The compare is constant-time (timingSafeEqualHex). The old
 *   "constantTimeEquals" was Buffer.compare, which is not.
 * - The signed timestamp must be within the tolerance, so a captured callback
 *   can't be replayed later.
 */
export function verifyAcquirerCallbackSignature(
  payload: unknown,
  header: string | undefined,
  secret: string,
  requireSignature = true,
  options?: { toleranceSeconds?: number; now?: number },
): VerifyAcquirerCallbackResult {
  if (!header) {
    return requireSignature ? { valid: false, reason: "missing_signature" } : { valid: true };
  }
  if (secret === "") {
    return { valid: false, reason: "signature_mismatch" };
  }

  const parsed = parseAcquirerSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  const expected = createHmac("sha256", secret)
    .update(`${parsed.timestamp}.${JSON.stringify(payload)}`)
    .digest("hex");

  if (!timingSafeEqualHex(expected, parsed.signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  const now = options?.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options?.toleranceSeconds ?? 300;
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  return { valid: true };
}
