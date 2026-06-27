# Development Setup

## Prerequisites

- **Bun 1.2+** -- runtime, package manager, and test runner
- **Docker and Docker Compose** -- infrastructure services
- **Git**
- **[just](https://github.com/casey/just)** -- task runner (optional but recommended)

## Initial Setup

```bash
git clone <repository-url>
cd hashhive
bun install
cp packages/backend/.env.example packages/backend/.env
docker compose up -d     # PostgreSQL, Redis, SeaweedFS (+ bucket-init sidecar)
bun dev                  # Start all services via Turborepo
```

Or use `just setup` to run the above in one step.

## Monorepo Structure

Turborepo with Bun workspaces. Three packages:

| Package | Name | Description |
|---------|------|-------------|
| `packages/backend` | `@hashhive/backend` | Bun + Hono API |
| `packages/frontend` | `@hashhive/frontend` | React 19 + Vite UI |
| `packages/shared` | `@hashhive/shared` | Drizzle schema, Zod schemas, TypeScript types |

Workspace filters use the full package.json name:

```bash
bun --filter @hashhive/backend dev     # Not `bun --filter backend dev`
```

## Commands

### Development

```bash
bun dev                          # Start all services via Turborepo
bun --filter @hashhive/backend dev   # Backend only
bun --filter @hashhive/frontend dev  # Frontend only
```

### Code Quality

```bash
bun lint                         # Lint all code with oxlint (type-aware)
bun format                       # Format all code with oxfmt (+ taplo for TOML)
bun type-check                   # TypeScript type checking
```

### Building

```bash
bun build                        # Build all packages via Turborepo
```

### Database

```bash
bun --filter @hashhive/backend db:generate   # Generate Drizzle migrations
bun --filter @hashhive/backend db:migrate    # Run migrations
bun --filter @hashhive/backend db:push       # Push schema (dev only)
bun --filter @hashhive/backend db:studio     # Open Drizzle Studio
bun --filter @hashhive/backend db:seed       # Seed admin user (admin@hashhive.local / changeme123)
```

### Maintenance

```bash
just backfill-line-count   # Enqueue line-count jobs for pre-#99 uncounted wordlists/rulelists
```

Resources uploaded before line-count tracking landed (#99) keep a null
`line_count`, so the attack-table Keyspace column reads "Computing..."
permanently for attacks that reference them. This one-shot enqueues a
`LINE_COUNT` job for every `ready` wordlist/rulelist with a null `line_count`.

- **The line-count worker (`worker-jobs.ts`) must be running** — the backfill
  only enqueues; the worker does the counting and the dependent-attack
  recompute. Queued jobs sit until a worker drains them.
- **Idempotent** — safe to re-run. Re-runs before workers drain collapse to the
  same jobs via BullMQ jobId dedup; once a worker completes, the row gains a
  non-null `line_count` and drops out of the next run's candidate set.
- **Exit code** — non-zero if any row failed to enqueue, so a partial run is
  detectable by CI or an operator.
- Masklists are excluded (sized by `keyspace`, not `line_count`; see #231).

### Local CI Check

```bash
just ci-check    # lint -> format-check -> type-check -> build -> test
```

Run this before pushing. It matches what CI runs.

## Infrastructure Services

| Service | Port | Credentials | GUI |
|---------|------|-------------|-----|
| PostgreSQL | 5432 | hashhive/hashhive | Drizzle Studio (`just db-studio`) or psql |
| Redis | 6379 | -- | RedisInsight or `redis-cli` |
| SeaweedFS (S3 API) | 9000 | minioadmin/minioadmin | -- |
| SeaweedFS (master) | 9333 | -- | <http://localhost:9333> (loopback-only — bound to `127.0.0.1` in `docker-compose.yml` because the SeaweedFS master `/cluster/status` page is unauthenticated; not reachable from other hosts on the LAN) |

A one-shot `bucket-init` sidecar runs after SeaweedFS reports healthy on first
`docker compose up`; it creates the `hashhive` bucket via the S3 API and exits.
Re-runs are idempotent (the "bucket already exists" response is swallowed).
SeaweedFS replaces MinIO across the local stack (MinIO upstream was archived in
April 2026); the S3 API surface is identical from the application's perspective.

## Environment Variables

Copy `packages/backend/.env.example` to `packages/backend/.env`. Key variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://hashhive:hashhive@localhost:5432/hashhive` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `S3_ENDPOINT` | Object-store S3 API endpoint (SeaweedFS in dev, AWS S3 in hosted envs) | `http://localhost:9000` |
| `BETTER_AUTH_SECRET` | Session signing secret (min 32 chars) | -- |
| `PORT` | Backend port | `4000` |
| `NODE_ENV` | Environment | `development` |
| `RAW_FLAG_DENYLIST` | Comma/space-separated hashcat flags the agent advanced-config raw-flags field rejects. A footgun guard (not a security control — the model trusts agents) that stops operators from overriding the flags the agent relies on (result capture, `--status-json` telemetry, session/restore). When set it **replaces** the built-in default; set it empty to disable the guard. | output / status / session flags the agent manages |

Generate `BETTER_AUTH_SECRET` with: `openssl rand -base64 32`

## Troubleshooting

**Port conflicts:** `docker compose down`, change ports in `docker-compose.yml` and `.env`.

**Database reset:** `docker compose down -v && docker compose up -d && just db-migrate`

**TimescaleDB:** the `postgres` service runs `timescale/timescaledb:2.17.2-pg16`
(PostgreSQL 16 + the TimescaleDB extension) for RRD-style telemetry retention.
The image is PG16-compatible, so an existing `pgdata` volume mounts unchanged.
On a fresh volume (`docker compose down -v` then `up -d`) the extension is created
automatically (via `docker/postgres/init-timescaledb.sql`). On an existing volume,
the compose `command:` override sets `shared_preload_libraries=timescaledb` so a
restart + the telemetry migration's `CREATE EXTENSION IF NOT EXISTS timescaledb`
enables it without a wipe. Authoritative tables stay plain Postgres; only the
`task_telemetry` hypertable is Timescale-managed. After swapping the image on an
existing volume, watch for libc/collation warnings (alpine/musl → debian/glibc) —
a one-time `REINDEX` of text indexes may be needed.

**Dependency issues:** `just clean && bun install`

**Build fails after schema change:** Delete `**/tsconfig.tsbuildinfo` and rebuild.
