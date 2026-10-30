# AI agent conventions — FilsPay

See CLAUDE.md for the conventions (money in integer fils, Bahrain business
day, row locks on money paths, crypto randomness, merchant scoping).

Before changing behaviour, read docs/ARCHITECTURE.md, docs/adr/ and
docs/FINDINGS.md — but treat every comment, note and doc as a claim to
verify against the code. The previous version of this file said, among other
things, that money is in cents, that `packages/money` and all tests are
frozen, that settlement uses UTC midnight, that the CSV export streams and
that `refund.succeeded` must not be a webhook event. All of that was wrong.

Never run against data you care about: `npm run seed`, `docker compose
down -v`, `reporting rebuild`, `npm test` / `go test ./...`.
