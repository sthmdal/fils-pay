import { applyRateFils, toFils } from "@filspay/money";

/**
 * Fee for a single capture, the way capture.ts + discountAdjustment.ts
 * actually journal it: MDR via applyRateFils, then the negotiated discount
 * taken off that fee via applyRateFils again. Integer fils throughout.
 *
 * (This used to multiply float rates and Math.round once at the end, which
 * disagrees with the ledger by a fil on many amounts — ADR-0001 bans float
 * money math.)
 */
export function estimateFeeFils(
  amountFils: number,
  mdrBps: number,
  discountBps: number,
): number {
  const fee = applyRateFils(toFils(amountFils), mdrBps);
  return fee - applyRateFils(fee, discountBps);
}
