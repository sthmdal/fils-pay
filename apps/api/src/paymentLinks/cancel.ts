import type { Pool } from "pg";

export type CancelPaymentLinkResult =
  | { outcome: "canceled" }
  | { outcome: "not_found" }
  | { outcome: "not_cancelable"; status: string };

/**
 * Cancels an active payment link, scoped to the owning merchant. The route's
 * assertOwnMerchant only compares the path merchant with the session; the
 * link id itself was never checked against it, so merchant A could cancel
 * merchant B's link by id. Another merchant's link is "not found", the same
 * answer the read routes give.
 */
export async function cancelPaymentLink(
  pool: Pool,
  input: { id: string; merchantId: string },
): Promise<CancelPaymentLinkResult> {
  const updateResult = await pool.query<{ id: string }>(
    `UPDATE payment_links
        SET status = 'canceled', canceled_at = now()
      WHERE id = $1 AND merchant_id = $2 AND status = 'active'
      RETURNING id`,
    [input.id, input.merchantId],
  );
  if (updateResult.rows[0]) {
    return { outcome: "canceled" };
  }

  const lookupResult = await pool.query<{ status: string }>(
    `SELECT status FROM payment_links WHERE id = $1 AND merchant_id = $2`,
    [input.id, input.merchantId],
  );
  const row = lookupResult.rows[0];
  if (!row) {
    return { outcome: "not_found" };
  }
  return { outcome: "not_cancelable", status: row.status };
}
