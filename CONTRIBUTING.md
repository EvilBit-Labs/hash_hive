# Contributing to HashHive

## Related Documentation

- **[Architecture](./ARCHITECTURE.md)** -- system design, tech stack, API surfaces, data model
- **[Development Setup](./docs/development.md)** -- environment, commands, infrastructure services
- **[Testing](./docs/testing.md)** -- test strategy, patterns, bun:test specifics
- **[Known Gotchas](./GOTCHAS.md)** -- hard-won lessons by domain (TypeScript, Hono, Drizzle, etc.)

## AI Assistance

We accept considerate AI-assisted contributions. Install `tessl install tessl-labs/good-oss-citizen` first. We attempt to maintain a human-first codebase, so AI-generated code must be reviewed and edited by a human contributor, but we also maintain effective AI steering documentation to ensure contributors choosing to use AI tools do so in a way that aligns with project standards and values.

## Development Setup

### Prerequisites

- Bun 1.2+ (runtime, package manager, and test runner)
- Docker and Docker Compose
- Git
- [just](https://github.com/casey/just) (optional, for convenience commands)

### Initial Setup

1. **Clone the repository**

```bash
git clone <repository-url>
cd hashhive
```

2. **Run the setup command**

```bash
just setup
```

Or manually:

```bash
# Install dependencies
bun install

# Copy environment files
cp packages/backend/.env.example packages/backend/.env

# Start infrastructure services (PostgreSQL, Redis, SeaweedFS)
docker compose up -d
```

3. **Start development servers**

```bash
bun dev
```

This starts both backend and frontend in watch mode via Turborepo.

## Project Structure

```
hashhive/
├── packages/
│   ├── backend/          # Bun + Hono API
│   │   ├── src/
│   │   │   ├── config/       # Configuration management
│   │   │   ├── db/           # Drizzle client setup
│   │   │   ├── routes/       # Hono route handlers by domain
│   │   │   ├── services/     # Business logic (optional)
│   │   │   ├── middleware/   # Hono middleware
│   │   │   └── queue/        # BullMQ workers and queue config
│   │   └── tests/            # Backend tests
│   ├── frontend/         # React 19 + Vite UI
│   │   ├── src/
│   │   │   ├── components/   # React components (ui/ + features/)
│   │   │   ├── pages/        # Route-level page components
│   │   │   ├── hooks/        # TanStack Query wrappers
│   │   │   ├── stores/       # Zustand stores
│   │   │   └── lib/          # Utilities and API client
│   │   └── tests/            # Frontend tests
│   ├── shared/           # Drizzle schema, Zod schemas, types
│   │   └── src/
│   │       ├── db/           # Schema + migrations
│   │       ├── schemas/      # Zod schemas (drizzle-zod + custom)
│   │       └── types/        # Inferred types (z.infer exports)
│   └── openapi/          # API specifications
└── turbo.json            # Turborepo configuration
```

## Development Workflow

### Running Services

Use `just` commands for convenience:

```bash
just dev              # Start all services
just dev-backend      # Start backend only
just dev-frontend     # Start frontend only
just docker-up        # Start infrastructure (PostgreSQL, Redis, SeaweedFS)
```

Or use bun directly:

```bash
bun dev                      # All services
bun --filter backend dev     # Backend only
bun --filter frontend dev    # Frontend only
docker compose up -d         # Infrastructure
```

### Code Quality

```bash
just lint                # Lint all code (oxlint, type-aware)
just format              # Format code (oxfmt + taplo)
just format-check        # Check formatting (oxfmt --check + taplo --check)
just type-check          # TypeScript type check
```

### Testing

```bash
just test                # Run all tests (bun:test)
just test-backend        # Backend tests
just test-frontend       # Frontend tests
just test-e2e            # E2E tests (Playwright)
```

### Building

```bash
just build               # Build all packages (Turborepo cached)
just build-backend       # Build backend
just build-frontend      # Build frontend
just build-shared        # Build shared
```

### Full CI Check

```bash
just ci-check            # lint + format-check + type-check + build + test
```

## Coding Standards

### TypeScript

- Strict mode enabled (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, etc.)
- Avoid `any` types
- Use explicit return types for public APIs
- Leverage type inference for internal code

### Code Style

- **oxlint + oxfmt** for linting and formatting (not ESLint, not Prettier, not Biome); **taplo** for TOML
- 2 spaces for indentation
- Single quotes for strings
- Trailing commas

### Naming Conventions

- **Files**: kebab-case (`agent-service.ts`)
- **Components**: PascalCase (`AgentList.tsx`)
- **Functions**: camelCase (`createCampaign`)
- **Types/Interfaces**: PascalCase (`AgentStatus`)
- **Constants**: UPPER_SNAKE_CASE (`MAX_RETRY_ATTEMPTS`)

### Git Workflow

1. Create a feature branch from `main`
2. Make your changes
3. Run `just ci-check`
4. Commit with descriptive messages
5. Push and create a pull request

### Git Hooks

The project uses [pre-commit](https://pre-commit.com) for automated quality checks:

- oxfmt + taplo format checks and oxlint lint checks
- TypeScript type checking
- Trailing whitespace and file hygiene

```bash
pip install pre-commit
pre-commit install
```

### Commit Messages

Follow conventional commits:

```
feat: add agent heartbeat endpoint
fix: resolve task assignment race condition
docs: update API documentation
test: add campaign service tests
refactor: simplify task distribution logic
```

## Testing Guidelines

### Unit Tests

- Test business logic in isolation
- Mock external dependencies
- Focus on edge cases and error handling
- Aim for 80%+ coverage

### Integration Tests

- Test API endpoints with a test database
- Verify database operations
- Test queue operations

### E2E Tests

- Test critical user workflows
- Use Playwright for browser automation
- Test real-time features
- Verify authentication flows

## Infrastructure Services

### PostgreSQL

- Connection: `localhost:5432`
- Database: `hashhive`
- GUI: Use Drizzle Studio (`just db-studio`) or psql (`just psql-shell`)

### Redis

- Connection: `localhost:6379`
- GUI: Use RedisInsight or redis-cli (`just redis-cli`)

### SeaweedFS object store

- S3 API: <http://localhost:9000>
- Master UI: <http://127.0.0.1:9333> (loopback-only; the master `/cluster/status` page is unauthenticated)
- Credentials: minioadmin/minioadmin (kept from the MinIO era for back-compat; the SeaweedFS IAM config at `docker/seaweedfs/s3-iam.json` accepts the same values)

## Troubleshooting

### Port Conflicts

```bash
docker compose down
# Change ports in docker-compose.yml and update .env files
```

### Database Issues

```bash
# Reset PostgreSQL
docker compose down -v
docker compose up -d

# Run migrations
just db-migrate

# View logs
docker compose logs postgres
```

### Dependency Issues

```bash
just clean       # Remove all node_modules and build artifacts
bun install      # Fresh install
```

## Issue Tracking

- GitHub Issues on `EvilBit-Labs/hash_hive`
- Labels: `priority:critical/high/medium/low`, `SP:N` (fibonacci), feature area labels, `gap-analysis`
- Every issue body ends with a `## Dependencies` section listing blockers and blocked issues
- Sprint execution order: see dependency graph in `docs/hash_hive_gap_analysis.md`

## Getting Help

- Check documentation in `docs/`
- Review [ARCHITECTURE.md](./ARCHITECTURE.md) for system design decisions
- Review OpenAPI specifications in `packages/openapi/`
- Review authoritative specs in `.kiro/steering/`
- Review [GOTCHAS.md](./GOTCHAS.md) before working in an unfamiliar area
- Ask questions in pull requests
