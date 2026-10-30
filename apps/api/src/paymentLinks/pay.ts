import type { Pool } from "pg";
import { toFils } from "@filspay/money";
import { authorizeTransaction } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { applyCaptureDiscountAdjustment } from "../payments/discountAdjustment.js";
import { ConflictError, UnprocessableEntityError } from "../lib/errors.js";
import type { AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";

export interface PayPaymentLinkInput {
  token: string;
  card: SimulatedCardInput;
  idempotencyKey: string;
  /** Accepted for wire compatibility and ignored: see payPaymentLink. */
  submittedAt?: string;
}

export interface PayPaymentLinkResult {
  statusCode: number;
  body: unknown;
}

/** Returned by the claim UPDATE; merchant_id comes from the link row, never from the request. */
interface ClaimedLinkRow {
  id: string;
  merchant_id: string;
  amount_fils: string | number;
  reference: string | null;
  pay_attempt: number;
}

interface LinkStatusRow {
  status: string;
  expired: boolean;
}

const PROCESSING = { statusCode: 409, body: { error: "payment_link_processing" } };

/**
 * `POST /v1/payment-links/:token/pay` business logic (public,
 * unauthenticated). Calls `authorizeTransaction` then `captureTransaction`
 * directly, in sequence, never issuing an HTTP request back into the API's
 * own /v1/transactions routes.
 *
 * Expiry is judged by the SERVER's clock only (FP-187). This route is
 * public; the old code compared expires_at against the body's `submittedAt`,
 * so anyone could pay an expired link by sending an old timestamp.
 *
 * Concurrency: reserve the link with a single atomic conditional UPDATE, run
 * authorize+capture with no lock held on payment_links, then finalize with a
 * second conditional UPDATE. A reservation older than the timeout can be
 * re-claimed (self-heals a crash between claim and finalize) — and because
 * the acquirer idempotency keys are derived from the link's pay_attempt, not
 * from the client's key, a re-claim while the first attempt is merely slow
 * replays that attempt's charge rather than making a second one
 * (incident 2026-05-14).
 */
export async function payPaymentLink(
  pool: Pool,
  acquirer: AcquirerSimulator,
  config: { paymentLinkReservationTimeoutSeconds: number },
  input: PayPaymentLinkInput,
): Promise<PayPaymentLinkResult> {
  // Step 1 — claim. A single UPDATE is already atomic.
  const claimResult = await pool.query<ClaimedLinkRow>(
    `UPDATE payment_links
        SET status = 'reserved', reserved_at = now()
      WHERE token = $1
        AND (
             status = 'active'
             OR (status = 'reserved' AND reserved_at < now() - ($2 || ' seconds')::interval)
            )
        AND expires_at > now()
      RETURNING id, merchant_id, amount_fils, reference, pay_attempt`,
    [input.token, config.paymentLinkReservationTimeoutSeconds],
  );

  const claimedRow = claimResult.rows[0];
  if (!claimedRow) {
    return classifyClaimFailure(pool, input.token);
  }

  const link = {
    id: claimedRow.id,
    merchantId: claimedRow.merchant_id,
    amountFils: toFils(Number(claimedRow.amount_fils)),
    reference: claimedRow.reference,
    attempt: claimedRow.pay_attempt,
  };
  const keyBase = `paylink:${link.id}:${link.attempt}`;

  // Step 2 — authorize.
  let authResult;
  try {
    authResult = await authorizeTransaction(pool, acquirer, {
      merchantId: link.merchantId,
      amountFils: link.amountFils,
      card: input.card,
      reference: link.reference ?? undefined,
      idempotencyKey: `${keyBase}:authorize`,
      // No merchant session/API key initiated this — a customer did, via
      // the public link.
      actor: { type: "system" },
    });
  } catch (err) {
    // The same attempt is already being paid with a different card (hash
    // mismatch) or is still mid-flight. The link is busy, not failed: keep
    // the other request's reservation and its charge intact.
    if (err instanceof UnprocessableEntityError || err instanceof ConflictError) {
      return PROCESSING;
    }
    throw err;
  }

  if (authResult.statusCode !== 201) {
    await releaseReservation(pool, link.id, link.attempt);
    return {
      statusCode: authResult.statusCode,
      body: { stage: "authorize", ...(authResult.body as Record<string, unknown>) },
    };
  }

  const txnId = (authResult.body as { id: string }).id;

  // Step 3 — capture (full amount, immediately).
  let captureResult;
  try {
    captureResult = await captureTransaction(pool, acquirer, {
      transactionId: txnId,
      merchantId: link.merchantId,
      idempotencyKey: `${keyBase}:capture`,
      actor: { type: "system", id: link.id },
    });
  } catch (err) {
    if (err instanceof UnprocessableEntityError || err instanceof ConflictError) {
      return PROCESSING;
    }
    throw err;
  }

  if (captureResult.statusCode !== 200) {
    await releaseReservation(pool, link.id, link.attempt);
    return {
      statusCode: captureResult.statusCode,
      body: { stage: "capture", ...(captureResult.body as Record<string, unknown>) },
    };
  }

  // The negotiated discount is part of what a capture costs the merchant.
  // It was only applied by the /v1/transactions capture route, so every
  // payment-link sale by a discounted merchant was overcharged. Idempotent
  // (one adjustment per capture event), so a replayed capture is a no-op.
  await applyCaptureDiscountAdjustment(pool, { merchantId: link.merchantId, transactionId: txnId });

  // Step 4 — finalize.
  const finalizeResult = await pool.query<{ id: string; paid_at: Date }>(
    `UPDATE payment_links
        SET status = 'paid', paid_at = now(), transaction_id = $2, reserved_at = NULL
      WHERE id = $1 AND status = 'reserved'
      RETURNING id, paid_at`,
    [link.id, txnId],
  );

  let paidAt = finalizeResult.rows[0]?.paid_at;
  if (!paidAt) {
    // A concurrent request for the same attempt finalized first. With the
    // attempt-scoped keys it captured the SAME transaction, so this is a
    // success, not a second charge.
    const current = await pool.query<{ transaction_id: string | null; paid_at: Date | null }>(
      `SELECT transaction_id, paid_at FROM payment_links WHERE id = $1`,
      [link.id],
    );
    const row = current.rows[0];
    if (row?.transaction_id !== txnId || !row.paid_at) {
      console.error(
        `payPaymentLink: link ${link.id} finalized with transaction ${row?.transaction_id ?? "none"} ` +
          `but this request captured ${txnId} — invariant violation, investigate`,
      );
      return { statusCode: 409, body: { error: "payment_link_already_paid" } };
    }
    paidAt = row.paid_at;
  }

  return {
    statusCode: 200,
    body: {
      status: "paid",
      transactionId: txnId,
      amountFils: link.amountFils,
      paidAt: paidAt.toISOString(),
    },
  };
}

/**
 * Used by the decline branches above: the attempt definitively failed, so
 * the link goes back to 'active' and the next attempt gets fresh keys. Only
 * releases the reservation this attempt holds.
 */
async function releaseReservation(pool: Pool, linkId: string, attempt: number): Promise<void> {
  await pool.query(
    `UPDATE payment_links
        SET status = 'active', reserved_at = NULL, pay_attempt = pay_attempt + 1
      WHERE id = $1 AND status = 'reserved' AND pay_attempt = $2`,
    [linkId, attempt],
  );
}

/**
 * The claim UPDATE matched 0 rows. This read only explains a decision
 * already made by the failed UPDATE; nothing further is decided from it.
 */
async function classifyClaimFailure(pool: Pool, token: string): Promise<PayPaymentLinkResult> {
  const result = await pool.query<LinkStatusRow>(
    `SELECT status, expires_at <= now() AS expired FROM payment_links WHERE token = $1`,
    [token],
  );
  const row = result.rows[0];

  if (!row) {
    return { statusCode: 404, body: { error: "payment_link_not_found" } };
  }
  if (row.status === "paid") {
    return { statusCode: 409, body: { error: "payment_link_already_paid" } };
  }
  if (row.status === "canceled") {
    return { statusCode: 409, body: { error: "payment_link_canceled" } };
  }
  if (row.expired) {
    return { statusCode: 410, body: { error: "payment_link_expired" } };
  }
  if (row.status === "reserved") {
    return PROCESSING;
  }
  return { statusCode: 409, body: { error: "payment_link_not_payable", status: row.status } };
}
