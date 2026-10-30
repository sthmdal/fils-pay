# FilsPay — notes for AI-assisted development

Rewritten during the FP-300 handover. The previous version of this file (and
AGENTS.md / .cursorrules) contained claims that were false; see
docs/FINDINGS.md. Verify against the code, not against notes.

## Money
- All amounts are **integer fils: 1 BD = 1000 fils** (ADR-0001). Never cents,
  never floats. Columns are `BIGINT`, TypeScript uses the branded `Fils`, Go
  uses `money.Fils` (int64).
- Parse BD text with `parseBhdToFils` (3 decimals, rejects more). Rates are
  basis points applied with `applyRateFils` (half-to-even).
- Splitting a total (fees across partial refunds, split payouts) must sum
  back exactly: allocate cumulatively or by largest remainder.
- `packages/money` is not frozen. It is correct; most money bugs were callers
  bypassing it.

## Time
- Settlement business day = Asia/Bahrain midnight to midnight (UTC+3, no
  DST). Convert instants with `InBusinessDayLocation` before taking a date.

## Concurrency
- Money-moving paths lock the row they change (`SELECT ... FOR UPDATE`) and
  validate under the lock, like `payments/capture.ts` and
  `payments/processRefund.ts`.
- "Check then insert" needs a lock or a unique constraint; advisory locks are
  used where existing duplicate data prevents a unique index.

## Security
- Bearer secrets (OTPs, payment-link tokens, invites, API keys, sessions) use
  `crypto` randomness (`lib/random.ts`, `lib/crypto.ts`).
- Merchant-scoped queries filter by the authenticated merchant id, every time.
- Admin impersonation is read-only (`support`); write routes reject it.

## Tests
- Tests are not sacred. A test that asserts a bug gets fixed with the bug.
- Integration tests need `DATABASE_URL` and write to that database — never
  point them at real data.

## Dangerous commands
See ops/README.md: `npm run seed`, `docker compose down -v`, `reporting
rebuild`, and running test suites against shared data.
