import type { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";

/**
 * Operational record of a payout-rail instruction for a settlement batch:
 * at most ONE per batch (0057: "one row per paid batch").
 *
 * This runs as the dispatcher's pre-delivery effect for settlement.paid,
 * i.e. once per webhook DELIVERY at attempt 0 — so a merchant with two
 * endpoints, any replay (replay rows start at attempt 0) or an attempt that
 * threw after the effect each recorded another instruction for the same
 * batch. Idempotent per batch now: a transaction-scoped advisory lock on the
 * batch id plus an existence check. (A unique index would need the
 * duplicates already in the table removed first.)
 */
export async function recordPayoutDisbursementEffect(
  pool: Pool,
  settlementBatchId: string,
  amountFils: number,
): Promise<void> {
  if (amountFils <= 0) {
    // Void batches (zero or negative net) carry no payout instruction.
    return;
  }

  await withTransaction(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('payout_disbursement:' || $1))`, [settlementBatchId]);
    await client.query(
      `INSERT INTO settlement_payout_disbursements (settlement_batch_id, amount_fils, disbursement_reference)
       SELECT $1, $2, 'disb_' || gen_random_uuid()
        WHERE NOT EXISTS (SELECT 1 FROM settlement_payout_disbursements WHERE settlement_batch_id = $1)`,
      [settlementBatchId, amountFils],
    );
  });
}
