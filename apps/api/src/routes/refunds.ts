import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError } from "../lib/errors.js";

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

interface MerchantIdParams {
  merchantId: string;
}

/** Same contract as routes/transactions.ts: the client owns the key, so a
 *  retried request replays instead of refunding twice. */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

async function handleRefund(
  app: FastifyInstance,
  request: FastifyRequest<{ Body: RefundBody }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = request.merchantAuth!;
  // Rejects admin impersonation before any work is done.
  const actor = requireMerchantWriterActor(auth);
  const idempotencyKey = getIdempotencyKey(request);

  const { transactionId, amountFils, reason } = request.body ?? {};
  if (typeof transactionId !== "string" || transactionId.length === 0) {
    throw new BadRequestError("invalid_request", "transactionId is required");
  }
  if (amountFils !== undefined && (typeof amountFils !== "number" || !Number.isSafeInteger(amountFils) || amountFils <= 0)) {
    throw new BadRequestError("invalid_request", "amountFils must be a positive integer number of fils");
  }
  if (reason !== undefined && typeof reason !== "string") {
    throw new BadRequestError("invalid_request", "reason must be a string");
  }

  const result = await initiateMerchantRefund(app.db, app.acquirer, {
    merchantId: auth.merchantId,
    transactionId,
    amountFils: amountFils !== undefined ? toFils(amountFils) : undefined,
    idempotencyKey,
    actor,
    reason,
  });
  reply.code(result.statusCode).send(result.body);
}

/**
 * Registered with prefix '/v1/merchants': `POST /v1/merchants/:merchantId/refunds`,
 * the path RefundDrawer and initiateMerchantRefund were written against.
 * Full refund when amountFils is omitted, partial otherwise.
 */
export async function refundMerchantRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams; Body: RefundBody }>(
    "/:merchantId/refunds",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      assertRefundRequestScope(request.merchantAuth!, request.params.merchantId);
      await handleRefund(app, request, reply);
    },
  );
}

/**
 * Registered with prefix '/v1/refunds': the older documented path. The
 * merchant comes from the authenticated context only, never the body.
 */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RefundBody }>(
    "/",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      await handleRefund(app, request, reply);
    },
  );
}
