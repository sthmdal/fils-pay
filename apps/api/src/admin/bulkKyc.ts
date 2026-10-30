import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { recordKycReviewInTx } from "../onboarding/review.js";

export interface BulkApproveMerchantsKycInput {
  merchantIds: string[];
  adminUserId: string;
  notes?: string;
}

/**
 * @property approvedMerchantIds Only merchants that moved from a pending
 * state (submitted / under_review) to approved. Already-approved or rejected
 * ids are skipped and not listed.
 */
export interface BulkApproveMerchantsKycResult {
  approvedCount: number;
  approvedMerchantIds: string[];
}

/**
 * Approves the given pending merchants and audits it.
 *
 * The UPDATE used to have no status guard, so a bulk selection flipped
 * REJECTED merchants to approved too (despite the result doc saying they are
 * skipped), and it wrote merchants.kyc_passed directly with no
 * merchant_kyc_reviews row — the only path 0016 allows. Each approval now goes
 * through recordKycReviewInTx, the same write the single-merchant review uses.
 */
export async function bulkApproveMerchantsKyc(
  pool: Pool,
  input: BulkApproveMerchantsKycInput,
): Promise<BulkApproveMerchantsKycResult> {
  return withTransaction(pool, async (client) => {
    const pending = await client.query<{ id: string }>(
      `SELECT id FROM merchants
        WHERE id = ANY($1::uuid[])
          AND onboarding_status IN ('submitted', 'under_review')
        ORDER BY id
        FOR UPDATE`,
      [input.merchantIds],
    );
    const approvedMerchantIds = pending.rows.map((row) => row.id);

    for (const merchantId of approvedMerchantIds) {
      await recordKycReviewInTx(client, {
        merchantId,
        outcome: "approved",
        reviewerIdentifier: `admin:${input.adminUserId}`,
        reviewerAdminUserId: input.adminUserId,
        notes: input.notes,
      });
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "kyc_bulk_approve",
      targetType: "platform",
      targetId: null,
      metadata: {
        requestedMerchantIds: input.merchantIds,
        approvedMerchantIds,
        notes: input.notes ?? null,
      },
    });

    return { approvedCount: approvedMerchantIds.length, approvedMerchantIds };
  });
}
