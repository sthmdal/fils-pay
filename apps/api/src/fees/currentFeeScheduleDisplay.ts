import type { Pool } from "pg";

/**
 * effectiveFrom: when the rate starts applying. createdAt: when it was
 * keyed in. The display returns the latest row whose effectiveFrom is not
 * in the future.
 */
export interface CurrentFeeScheduleDisplay {
  mdrBps: number;
  effectiveFrom: Date;
  createdAt: Date;
}

/**
 * Fetches the merchant's current fee schedule for display: the rate that is
 * charged right now. Same resolution as capture (fees/feeSchedule.ts): the
 * newest row whose effective_from has arrived, created_at breaking ties.
 *
 * It used to order by created_at alone, so a backdated correction for an
 * EARLIER period (245 bps from March, keyed in mid-August) displayed as
 * "current" while payments were charged the August renegotiation (225 bps) —
 * the "dashboard shows 245, we charge 225" support ticket. A future-dated row
 * would likewise display before it applied.
 */
export async function getCurrentFeeScheduleForDisplay(
  pool: Pool,
  merchantId: string,
): Promise<CurrentFeeScheduleDisplay | null> {
  const result = await pool.query<{ mdr_bps: number; effective_from: Date; created_at: Date }>(
    `SELECT mdr_bps, effective_from, created_at
       FROM fee_schedules
      WHERE merchant_id = $1 AND effective_from <= now()
      ORDER BY effective_from DESC, created_at DESC
      LIMIT 1`,
    [merchantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { mdrBps: row.mdr_bps, effectiveFrom: row.effective_from, createdAt: row.created_at };
}
