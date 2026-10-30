import type { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { AppError, NotFoundError } from "../lib/errors.js";

/** @property outcome Validated against the two allowed values by the route. */
export interface AcquirerCallbackInput {
  callbackId: string;
  type: "fraud_review.completed";
  transactionId: string;
  occurredAt: string;
  outcome: "cleared" | "confirmed_fraud";
  note: string;
}

interface TransactionMerchantRow {
  merchant_id: string;
}

/**
 * Applies one acquirer callback: looks up the transaction it refers to and
 * appends a note recording the acquirer's own delayed verdict.
 * acquirer_callback_notes is append-only and surfaced on the transaction
 * timeline for support/finance to read — a fraud-review verdict is
 * informational, not a state transition, so this never touches
 * transactions.status or the ledger; a confirmed-fraud outcome still needs
 * a human decision to void/refund, exactly as today.
 *
 * Idempotent per callbackId (FP-201). The acquirer redelivers, and there is
 * no processed_events table or unique index (the 1.9.0 notes say there is;
 * there isn't), so the same callback was saved twice. A transaction-scoped
 * advisory lock on the callbackId serializes concurrent redeliveries, and
 * the existence check inside it makes a repeat a no-op. (A unique index
 * can't be added without first deleting the duplicates already in the table.)
 */
export async function applyAcquirerCallback(pool: Pool, callback: AcquirerCallbackInput): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('acquirer_callback:' || $1))`, [callback.callbackId]);

    const existing = await client.query(`SELECT 1 FROM acquirer_callback_notes WHERE callback_id = $1 LIMIT 1`, [
      callback.callbackId,
    ]);
    if (existing.rows.length > 0) return;

    const txnResult = await client.query<TransactionMerchantRow>(
      `SELECT merchant_id FROM transactions WHERE id = $1`,
      [callback.transactionId],
    );
    const txnRow = txnResult.rows[0];
    if (!txnRow) {
      throw new NotFoundError("transaction_not_found");
    }

    await client.query(
      `INSERT INTO acquirer_callback_notes
          (transaction_id, merchant_id, callback_id, callback_type, outcome, note, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        callback.transactionId,
        txnRow.merchant_id,
        callback.callbackId,
        callback.type,
        callback.outcome,
        callback.note,
        callback.occurredAt,
      ],
    );
  });
}

/**
 * Defaults: 3 attempts, 50 ms apart.
 * — FH
 */
export interface CallbackRetryOptions {
  maxAttempts?: number;
  delayMs?: number;
}

/**
 * Retries transient failures only. A business answer (an AppError such as
 * 404 transaction_not_found) is final and is rethrown immediately — retrying
 * a non-idempotent insert on every error is how one callback became several
 * notes.
 */
export async function withCallbackRetry<T>(fn: () => Promise<T>, options: CallbackRetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const delayMs = options.delayMs ?? 50;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}
