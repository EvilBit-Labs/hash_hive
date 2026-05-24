# Architecture

HashHive is a distributed hash cracking management system that orchestrates [hashcat](https://hashcat.net/) across multiple agents in a private lab environment. It is a 2026 TypeScript reimplementation of [CipherSwarm](https://github.com/unclesp1d3r/CipherSwarm) (Ruby on Rails + PostgreSQL).

## Production Context

This system runs in an **air-gapped private lab** with no Internet access. The only supported deployment method is **Docker Compose** -- all services (backend, frontend, PostgreSQL, Redis, SeaweedFS) run as containers that must operate without external network connectivity. All images, dependencies, and resources must be fully self-contained.

**Scale:** Minimum 10 cracking nodes with ~25x RTX 4090 GPU capacity. Individual attack resources (wordlists, masklists, rulelists) can exceed 100 GB -- all upload, storage, download, and streaming pipelines must handle files at this scale without full-file buffering. The agent API handles periodic bursts when rigs submit cracked hashes, request work units, and send heartbeats. The web dashboard serves 1-3 concurrent human users.

Optimize for correctness, clarity, and developer experience -- not premature scale.

## Technology Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Bun (latest stable) | JS runtime, package manager, test runner |
| Backend | Hono on `Bun.serve()` | Not Express, not Fastify |
| Database | PostgreSQL + Drizzle ORM | Primary data store |
| Task queue | Redis + BullMQ | Async processing (hash list parsing, task generation, heartbeat monitoring) |
| Object storage | SeaweedFS (S3-compatible, Apache-2.0) | Binary artifacts (hash lists, wordlists, rulelists, masklists). Application talks only to the S3 API, so SeaweedFS is swappable for AWS S3 |
| Frontend | React 19 + Vite | Not Next.js, not CRA |
| UI | Tailwind CSS + shadcn/ui | Catppuccin Macchiato dark theme |
| Server state | TanStack Query v5 | Data fetching and caching |
| Client state | Zustand | UI state (project selection, filters, wizard state) |
| Monorepo | Turborepo + Bun workspaces | Not Nx, not Lerna |
| Linting | oxlint (type-aware) | Not ESLint, not Biome |
| Formatting | oxfmt (JS/TS/JSON/CSS) + taplo (TOML) | Not Prettier, not Biome |
| Testing | bun:test, Testing Library, Playwright | Unit, component, E2E |

See `.kiro/steering/tech.md` for the full details and explicit constraints on what NOT to introduce.

## Schema Flow (Single Source of Truth)

```
Drizzle table definitions --> drizzle-zod --> Zod schemas --> TypeScript types
```

One direction, no duplication.

- **Drizzle tables** in `shared/src/db/schema.ts` define the database schema and generate migrations
- **drizzle-zod** generates Zod schemas from Drizzle tables for API validation
- **z.infer** derives TypeScript types from Zod schemas -- no manually duplicated interfaces
- **Status enums:** Define a canonical `*StatusSchema` covering all DB-valid values, then define API-facing schemas as subsets

When backend route validation changes, update the corresponding shared Zod schema in `shared/src/schemas/index.ts` -- the frontend imports these types via `@hashhive/shared`.

## Backend Architecture

The backend is a Bun + Hono + TypeScript service:

**Routes (`src/routes/`)** -- HTTP endpoints grouped by API surface (Agent API, Dashboard API). Thin handlers: parse/validate input with Zod, call Drizzle queries or service layer, return responses.

**Services (`src/services/`)** -- Optional, only when route handlers become complex:

- `AuthService`: project membership queries (login/logout handled by BetterAuth)
- `AgentService`: registration, capability detection, heartbeat handling
- `CampaignService`: campaign lifecycle, DAG validation, attack configuration
- `TaskDistributionService`: keyspace partitioning, task generation, assignment
- `ResourceService`: file uploads to the S3-compatible object store (SeaweedFS in dev / air-gapped prod), hash list parsing coordination
- `HashAnalysisService`: hash-type identification, hashcat mode mapping
- `EventService`: WebSocket broadcasting for real-time dashboard updates (in-memory v1, Redis pub/sub extension path)

**Database (`src/db/`)** -- Drizzle client setup and connection config.

**Middleware (`src/middleware/`)** -- auth, validation, error handling.

## RBAC

**Roles:** `admin`, `contributor`, `viewer`. Frontend uses `Permission` constants from `packages/frontend/src/lib/permissions.ts` -- components reference capabilities (`Permission.CAMPAIGN_CREATE`), never role strings.

Two RBAC middleware variants in `src/middleware/rbac.ts`:

- `requireProjectAccess()` / `requireRole()` -- reads projectId from `X-Project-Id` header via `currentUser.projectId`; used by most dashboard routes
- `requireParamProjectAccess()` / `requireParamProjectRole()` -- reads projectId from URL param (`c.req.param('projectId')`); used by project management routes

## API Surfaces

Two API surfaces on the same Hono instance, backed by the same service and data layer:

### Agent API (`/api/v1/agent/*`)

- Pre-shared token authenticated REST API for Go-based hashcat agents
- Defined by two OpenAPI spec files (both must be updated for new endpoints):
  - `openapi/agent-api.yaml` -- simplified OpenAPI 3.0.3, inline schemas
  - `packages/openapi/agent-api.yaml` -- detailed OpenAPI 3.1.0, `$ref`-based
- Supports batch operations: bulk inserts for hash submissions via Drizzle or raw `Bun.SQL`
- Core endpoints: `POST /agent/heartbeat`, `POST /agent/tasks/next`, `POST /agent/tasks/:id/report`

### Dashboard API (`/api/v1/dashboard/*`)

- BetterAuth database-backed session + HttpOnly cookie authenticated REST API for the React frontend
- Project scoping is client-side: `projectId` is sent via `X-Project-Id` header on each request
- Standard CRUD operations with Zod validation
- Low traffic (1-3 concurrent users)

Agent API contract tests should validate responses against the OpenAPI spec to keep server and clients in sync. Never break the agent API to improve the dashboard experience.

## Chunked Upload Protocol

Large file uploads (>100MB) use S3 multipart via 5 endpoints under `/api/v1/dashboard/resources/upload/`. Frontend `ChunkedUploadManager` in `packages/frontend/src/lib/chunked-upload/` splits files into 64MB chunks, uploads sequentially with retry, persists state to localStorage for resumption. Backend streams each chunk to S3 without full-file buffering (128MB memory bound). Files <=100MB use existing single-request upload path.

## Frontend Architecture

The frontend is a Vite + React 19 SPA (no server components, no meta-framework):

- **TanStack Query mutations**: Use `onSuccess(_data, variables)` for cache invalidation keys, not Zustand store state (can be stale)
- Tailwind CSS and shadcn/ui for UI components
- Forms built with React Hook Form + Zod schemas from the `shared/` package
- Real-time updates delivered via WebSocket client (with polling fallback on disconnect)
- Zustand for client-side UI state (project selection, filters, wizard state)

### Design Direction

- **Dark only** -- Catppuccin Macchiato palette (`#24273a` base, `#1e2030` surface, `#f5a97f` peach accent)
- **Personality**: Precise, Powerful, Dark -- purpose-built security tool, not a generic admin panel
- **References**: Linear/Vercel (polish), Grafana/Datadog (data density), Hack The Box (security identity)
- **Principles**: Data-forward, precision over decoration, dark-native, status at a glance, crafted not themed

## Data Model

PostgreSQL tables organized by domain:

- **Identity & access**: `users`, `projects`, `project_users` (roles as text array)
- **Auth (BetterAuth)**: `ba_sessions`, `ba_accounts`, `ba_verifications`
- **Agents & telemetry**: `operating_systems`, `agents`, `agent_errors`, `agent_benchmarks`
- **Campaign orchestration**: `campaigns`, `attacks` (with DAG dependencies), `tasks` (work ranges, progress, results)
  - Campaign lifecycle: `draft` -> `running` -> `paused` / `completed` / `cancelled`. Stop action returns to `draft` (not `completed`). Start requires >=1 attack.
  - `hash_items` has unique constraint on `(hashListId, hashValue)` -- use `onConflictDoUpdate` for crack result attribution
- **Resources**: `hash_lists`, `hash_items`, `hash_types`, `word_lists`, `rule_lists`, `mask_lists`

## Documentation Hierarchy

`.kiro/steering/` and `.kiro/specs/` are the **authoritative** sources for architecture, requirements, and constraints. When code conflicts with these documents, the documents win. Update the docs first if behavior needs to change.

### Authoritative (`.kiro/`)

- `.kiro/steering/product.md` -- product overview and core capabilities
- `.kiro/steering/structure.md` -- repository structure, table list, and API routes
- `.kiro/steering/tech.md` -- technology stack, commands, key libraries, and constraints

### Specifications

- `.kiro/specs/mern-migration/requirements.md` -- detailed functional requirements
- `.kiro/specs/mern-migration/design.md` -- end-to-end architecture and data models
- `.kiro/specs/mern-migration/tasks.md` -- implementation task breakdown

### Supplementary

- `docs/v2_rewrite_implementation_plan/` -- historical context from CipherSwarm migration
- `spec/epic/specs/` -- epic-level briefs, tech plan, user journeys, and feature tickets
