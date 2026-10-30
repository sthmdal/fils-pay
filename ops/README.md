# ops/

The FilsPay stack: Postgres plus the three services that talk to it directly
(apps/api, apps/settlement, apps/reporting). apps/web and apps/admin are
static Vite front-ends that call apps/api over HTTP.

## Quick start

```
cp ops/.env.example ops/.env          # fill in real secrets first
docker compose -f ops/docker-compose.yml up -d --build
```

`up` starts Postgres, runs `migrate` once, then starts api, settlement and
reporting (each waits for migrate to succeed). It does **not** seed.

Seed a brand-new, empty database only:

```
docker compose -f ops/docker-compose.yml --profile seed run --rm seed
```

## Commands that destroy data — do not run against real data

| Command | Why |
|---|---|
| `seed` (`npm run seed`) | `TRUNCATE ... RESTART IDENTITY CASCADE` on every core table — effectively the whole database. Now refuses if merchants exist unless `SEED_ALLOW_WIPE=yes`. |
| `docker compose ... down -v` | `-v` deletes the `filspay_pgdata` volume. |
| `npm test` / `go test ./...` | integration tests write to and delete from the database in `DATABASE_URL`. |
| `reporting rebuild` | truncates the rollup tables before replaying. |

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | the stack (restart policies, memory limits, healthchecks) |
| `.env.example` | template for `ops/.env` (gitignored): secrets and settings |
| `Dockerfile.node` | image for api, reporting, migrate and seed |
| `Dockerfile.go` | multi-stage build of `apps/settlement` (static binary, distroless) |

The old committed `.env.docker` held the acquirer signing secret and was not
actually gitignored (`.env` does not match `.env.docker`). It is removed; the
secret it contained must be treated as leaked and rotated.

## Database

All services use one `filspay` role over the compose network with
`sslmode=disable`; Postgres is published on `127.0.0.1` only. Per-service
roles and TLS are still to do before handling real card data.

`PGCONN_SETTLEMENT`, if set, overrides `DATABASE_URL` for the settlement
worker (not the other way round, as this README used to say).

## Required settings

| Service | Needs |
|---|---|
| api | `DATABASE_URL`, `SETTLEMENT_INTERNAL_URL`, `SETTLEMENT_INTERNAL_TOKEN`, `WEBHOOK_SECRET_ENCRYPTION_KEY`, `ACQUIRER_CALLBACK_SIGNING_SECRET` |
| settlement | `DATABASE_URL`, `SETTLEMENT_INTERNAL_TOKEN` (exits at boot without it — there is no `dev-token` fallback) |
| reporting | `DATABASE_URL` |

## Resource sizing

Target box: 0.5 vCPU / 2 GB RAM / 2 GB disk. Memory limits: postgres 640 MB,
api 512 MB, settlement 256 MB, reporting 256 MB. Build images off the box
(or use the multi-stage Go build, whose toolchain never ships) — a `go build`
on the box filled its disk before.
