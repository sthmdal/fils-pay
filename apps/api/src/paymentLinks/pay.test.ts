/**
 * expiryReferenceTime is gone (FP-187): payment-link expiry is judged by the
 * server's clock only, inside the claim UPDATE (`expires_at > now()`). Taking
 * the public, unauthenticated request body's `submittedAt` as the reference
 * time let anyone pay an expired link by sending an old timestamp.
 *
 * The behaviour is covered against a real database in
 * routes/paymentLinks.test.ts ("FP-187: an expired link cannot be paid by
 * sending an old submittedAt"). This file only guards that the old helper is
 * not reintroduced.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as pay from "./pay.js";

test("pay.ts no longer exports a client-clock expiry helper", () => {
  assert.equal((pay as Record<string, unknown>).expiryReferenceTime, undefined);
});
