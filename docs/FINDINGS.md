# FP-300 handover findings

Money is integer fils (1 BD = 1000 fils). CLAUDE.md, AGENTS.md and .cursorrules wrongly say "cents". Nothing here has been run: no Node, Go or Postgres was available. Every change was made by reading the code.

## The feature: refunds (FP-300)
- **`routes/refunds.ts` + `app.ts`**
  - Wired `POST /v1/merchants/:merchantId/refunds`, with `/v1/refunds` kept as an alias.
  - Owner/finance only; admin impersonation is rejected.
  - Requires an `Idempotency-Key`. Bad amounts return 400.
- **`payments/processRefund.ts`**
  - **Concurrency:** one transaction, with the transaction row locked `FOR UPDATE` across the acquirer call. Two concurrent refunds can no longer both pay (FP-209), and a crash no longer leaves the idempotency key stuck.
  - **Ceiling:** the refundable amount is captured minus refunded. It used to be authorized minus refunded, which allowed refunding more than was charged.
  - **Fee reversal:** reverses the *net* fee (MDR minus negotiated discount), computed cumulatively, so partial refunds sum exactly to the fee charged.
  - **Reason:** defaults to `unspecified`. Migration 0070 rejects a NULL reason, so every refund without one used to fail.
- **`refunds/initiateMerchantRefund.ts`:** the transaction is looked up by id *and* merchant. Merchant A could previously refund merchant B's transactions.
- **Webhooks:** added the `refund.succeeded` envelope and made it webhook-eligible.
- **Reporting:** consumes `refund.succeeded` (bucketed by Bahrain date). Migration 0073 adds the columns and fixes the 0072 view, which joined `t.id = r.id`.
- **Settlement (`batch.go`):**
  - CloseBatch nets out unbatched refunds using their stored fee reversals. If that would make the payout negative, the refunds carry forward to the next batch.
- **Reconciliation:**
  - Unbatched refunds now count as pending.
  - Payout legs are excluded from ledger activity.
  - Pending fees use the fee actually charged, not a float estimate.
- **Serializer and web:**
  - Added `refundedFils`.
  - `bhd()` handled negative values badly, which crashed the timeline.
  - RefundDrawer is wired up, uses one idempotency key per opening, and allows refunds on `partially_refunded` transactions.
- **Tests:** replaced the 501 test with end-to-end, cross-merchant, ceiling, concurrency and fee-drift tests.

## Other bugs fixed (at source)
**Auth and access**
- Pre-OTP session counted as logged in. Fixed in `auth/sessions.ts` and migration 0074.
- OTP was sent to another merchant's user (`routes/auth.ts`).
- Parallel OTP guesses got around the attempt limit. Attempts are now counted atomically, for merchants and admins.
- `Math.random` generated OTPs, payment-link tokens and invites. Replaced with `crypto.randomInt`.
- Impersonation mapped admins to merchant "owner" and allowed writes. All roles now map to support, read-only. Disabled admins no longer keep their grants.
- Capture and void had no role check.
- Admin API-key rotation never revoked the old key.

**Cross-merchant data access**
- Merchant A could cancel merchant B's payment link.
- Reporting leaked split-child data to any merchant.
- `/v1/reporting/export-summary` had no authentication.

**Payment links**
- FP-187: payment-link expiry trusted the client's `submittedAt`. Now uses the server clock.
- Incident 05-14: a link could be charged twice. Idempotency keys now use the link's attempt number (migration 0076).
- Payment links skipped the negotiated discount.

**Admin plane**
- Credit two-person approval compared display names instead of admin ids.
- Support-role admins could create credits.
- Bulk KYC approved rejected merchants and wrote no review rows.
- The recompute tool flipped `test_mode` off. Removed.

**Webhooks and callbacks**
- FP-240: the dispatcher signed different bytes from the ones it sent. Now it sends exactly the signed bytes.
- Webhook replays minted a new delivery id. They now keep the original.
- Payout disbursements were recorded once per endpoint or replay. Now one per batch.
- FP-201: acquirer callbacks were deduplicated by nothing. Now deduplicated per `callbackId`.
- Inbound callbacks were accepted without a signature, compared non-constant-time, and replayable. All three fixed.

**Money and fees**
- The CSV import read BD amounts as cents (4.75 BD became 0.475 BD).
- The fee display showed a backdated row (245 bps vs 225 bps actually charged).
- The settlement summary double-counted.

**Performance and resource limits**
- The slow ledger query couldn't use the index (made sargable).
- The CSV export was fully in memory and had formula injection. Now streams with keyset paging.
- KYC thumbnails had no pixel limit (decompression bomb).
- Uploads accepted unlimited file parts.
- The webhook transport followed redirects and read unbounded response bodies.

**Settlement (Go)**
- The scheme file carried rounded amounts while the ledger truncated, and the residue was never journaled. That is the "scheme is always a few fils over" report.
- Net payout was computed in float32. Now integer.
- The platform volume counter overflowed at int32 (migration 0075 widens it).
- The lifetime payout estimate was float.
- The settlement discount formula differed from the API's, so fees were off by a fil.
- Split payouts didn't sum to the parent's total. Now uses largest-remainder allocation and requires weights to sum to 10000.
- FP-203: the "Recalculate cached balances" button rebuilt from scheme export lines. It now rebuilds from the ledger, in one locked pass.
- MDR recalculation rewrote batches that were already paid, using the wrong rate.
- The daily close ran at about 03:15 Bahrain time instead of midnight.
- Days could be closed before they ended.
- Incident 08-21: duplicate `settlement.paid` events.
- The fee schedule had no tie-break between rows.

**Reporting**
- The cursor wasn't locked, so a second process could double-apply events.
- Events were consumed in id order rather than commit order. Fixed with a safety lag.
- One poison event stopped all reporting.

**Migrations**
- 0054 and 0055 broke a fresh `migrate`. Both are edited in place; the runner has no checksum.

## Intentionally left
- `/readyz` only checks at boot. This is documented base-platform behaviour and has its own test.

## Scripts and ops
- **`scripts/expire_holds.ts`:** on a night with nothing expired, the empty id list became `DELETE FROM holds` with no WHERE clause, wiping every hold. Even on a normal night it hard-deleted history. Now one atomic `UPDATE ... SET status='expired'`, and `buildDelete` refuses to emit a DELETE without a WHERE.
- **`scripts/reconcile_march.ts`:**
  - Ran twice, it doubled the gap: a random `entry_group_id` deduplicated nothing. It now refuses to post again and is a dry run unless `--apply` is passed.
  - It used the UTC month; now the Bahrain month.
  - It debited `merchant_payable`; it now posts ADR-0002's legs instead.
  - Any earlier production run with the old legs needs a finance-approved reversal.
- **`npm run seed`:** it TRUNCATEs the whole database. It now refuses if merchants exist, unless `SEED_ALLOW_WIPE=yes`.
- **Compose:**
  - The seed ran on every `up`; it is now behind an opt-in profile.
  - Added the two missing Dockerfiles.
  - Secrets now come from a gitignored `ops/.env` (template: `.env.example`).
  - Added restart policies, memory limits and healthchecks, and tuned Postgres for 2 GB.
  - Postgres is bound to 127.0.0.1, and apps wait for migrate to finish.
- **Leaked secret:** the committed `.env.docker` contained the acquirer signing secret and was not actually gitignored. It is removed, but **rotate that secret**.
- **Agent-config files:** CLAUDE.md, AGENTS.md and .cursorrules are rewritten to describe the system accurately.

## Still to do
- **Build and test:** nothing has been compiled or run, because there was no Node, Go or Postgres on the machine. Run `npm ci`, `npm run typecheck`, migrate on a fresh DB, `npm test`, and `go test ./...`, then fix anything that fails.
- **Deployment:** Dilmune Cloud deployment.
- **Database hardening:** per-service DB roles and TLS.
- **Webhook dispatcher:** has no `SKIP LOCKED`, so it must run as a single API replica.
