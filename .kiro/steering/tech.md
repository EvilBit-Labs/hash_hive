# Technology Stack

## TypeScript Stack Architecture

HashHive is a 2026 TypeScript reimplementation of CipherSwarm, running on Bun with PostgreSQL.

### Backend

- **Runtime**: Bun (latest stable, currently 1.3.x) - JavaScript runtime, package manager, and test runner
- **Framework**: Hono (running natively on Bun.serve())
- **Database**: PostgreSQL with Drizzle ORM
- **Validation**: Zod for all data shapes, drizzle-zod for schema generation
- **Authentication**: Pre-shared tokens for Agent API, BetterAuth database-backed sessions for Dashboard API
- **Testing**: bun:test (Bun's built-in test runner)
- **WebSockets**: hono/websocket for real-time dashboard updates

### Frontend

- **Framework**: React 19 with Vite (not Next.js, not CRA)
- **Styling**: Tailwind CSS
- **Components**: shadcn/ui (copied into project via CLI)
- **Forms**: React Hook Form + Zod resolvers
- **Data Fetching**: TanStack Query v5 (React Query) for all server state
- **State Management**: Zustand for client-side UI state (no Redux, no Context API)
- **Real-time**: WebSocket/SSE client for live updates
- **Testing**: bun:test + Testing Library for components, Playwright for E2E

### Infrastructure

- **Database**: PostgreSQL with Drizzle ORM (primary data store)
- **Task Queue**: Redis + BullMQ for async job processing (hash list parsing, task generation, heartbeat monitoring)
- **Storage**: SeaweedFS (S3-compatible, Apache-2.0) for binary artifacts (hash lists, wordlists, rulelists, masklists). The application layer talks the S3 API only, so SeaweedFS is swappable for AWS S3 in hosted deployments.
- **Configuration**: Environment variables + centralized config module

### Tooling

- **Package Manager**: Bun (exclusively, no npm, yarn, or pnpm)
- **Monorepo**: Turborepo with Bun workspaces
- **Linting & Formatting**: Biome (single tool for linting, formatting, import sorting)
- **Build**: Turborepo for task orchestration and caching

## Common Commands

### Development

```bash
# Start all services
bun dev                  # Start both backend and frontend via Turborepo
bun --filter backend dev     # Start backend only
bun --filter frontend dev    # Start frontend only
```

### Testing

```bash
bun test                 # Run all tests via Turborepo
bun --filter backend test    # Run backend tests
bun --filter frontend test   # Run frontend tests
bun test:e2e             # Run E2E tests (Playwright)
```

### Building & Linting

```bash
bun build                # Build all packages via Turborepo
bun lint                 # Lint all code with Biome
bun format               # Format all code with Biome
bun type-check           # TypeScript type checking
```

### Database

```bash
bun --filter backend db:generate  # Generate Drizzle migrations
bun --filter backend db:migrate   # Run migrations
bun --filter backend db:studio    # Open Drizzle Studio
```

### Turborepo

```bash
turbo run build          # Build all packages with caching
turbo run test --filter=backend  # Run backend tests only
turbo run lint --no-cache        # Lint without cache
```

## API Specifications

- **Agent API**: Defined in `openapi/agent-api.yaml` (single source of truth for Go-based agents)
  - Batch operations for hash submissions
  - Token-based authentication
  - Endpoints: `/api/v1/agent/*`
- **Dashboard API**: RESTful JSON API at `/api/v1/dashboard/*`
  - Session-based authentication for web UI
  - Low traffic (1-3 concurrent users)
  - Standard REST endpoints (no tRPC)

## Key Libraries

- **hono**: Web framework running natively on Bun.serve()
- **drizzle-orm**: Type-safe PostgreSQL ORM
- **drizzle-zod**: Generate Zod schemas from Drizzle tables
- **zod**: Runtime type validation and schema definition
- **@hono/websocket**: WebSocket support for real-time updates
- **name-that-hash**: Hash type identification and analysis

## Type Safety

- **Drizzle table definitions in `shared/db/schema.ts`** are the single source of truth
- **drizzle-zod** generates Zod schemas from Drizzle tables
- All TypeScript types inferred from Zod schemas using `z.infer<typeof schema>`
- No duplicate manual TypeScript interfaces
- Shared schemas consumed by both backend (Hono validation) and frontend (form validation, TanStack Query typing)
- OpenAPI-generated types for Agent API
