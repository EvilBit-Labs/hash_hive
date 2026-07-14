# hashhive - Agent Context

This file provides AI coding assistants with project context. Substantive documentation lives in the files linked below; the configuration sections here capture conventions, boundaries, and gates that apply to every task.

## Project Documentation

- **[Architecture & Design](./ARCHITECTURE.md)** -- system overview, tech stack, schema flow, backend/frontend architecture, API surfaces, data model, documentation hierarchy
- **[Contributing Standards](./CONTRIBUTING.md)** -- code style, naming conventions, git workflow, PR process, issue tracking
- **[Development Setup](./docs/development.md)** -- environment, commands, infrastructure services, environment variables
- **[Testing](./docs/testing.md)** -- test strategy, bun:test patterns, mock patterns, frontend test utilities
- **[Known Gotchas](./GOTCHAS.md)** -- hard-won lessons by domain (TypeScript strict mode, Hono, Drizzle, BetterAuth, bun:test, frontend JSX)
- **[Documented Solutions](./docs/solutions/)** -- searchable knowledge store of past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.
- **[Domain Concepts](./CONCEPTS.md)** -- shared domain vocabulary (entities, named processes, status concepts) with project-specific meaning. Relevant when orienting to the codebase or discussing domain concepts.
- **[Frontend Design Context](./.impeccable.md)** -- users, brand personality, aesthetic direction, anti-references, and the five design principles every UI surface must follow. Read before any frontend visual work.

## Planning & Status

- **[STRATEGY.md](./STRATEGY.md)** -- target problem, approach, primary persona, the five key metrics, and the four investment tracks. Read before proposing scope changes or new features.
- **[BACKLOG.md](./BACKLOG.md)** -- authoritative status of remaining work. Phase 1 is the 11 unfinished `spec/tickets/`; Phase 2 is the open GitHub issue backlog (#97-#124, grouped under epics #117-#121). Do NOT infer ticket completion from matching commit titles or file existence -- BACKLOG.md is the source of truth.

## Project Overview

HashHive is a distributed password-cracking platform. It is an open-source project (Apache-2.0, hosted on GitHub) -- consider community guidelines and contribution standards when working in it.

- **Architecture:** Monolith
- **CI/CD:** GitHub Actions
- **Deployment:** Docker / docker-compose; container builds publish to the GitHub Container Registry
- **Versioning:** [Semantic Versioning](https://semver.org)
- **Commits:** [Conventional Commits](https://conventionalcommits.org)

### Tech Stack

TypeScript, React, Hono, Tailwind CSS, shadcn, Playwright, Drizzle, Zustand, TanStack, PostgreSQL, Redis, TimescaleDB, BullMQ, SeaweedFS. See [ARCHITECTURE.md](./ARCHITECTURE.md) for how these fit together.

## Before Starting Any Coding Task

1. Check existing worktrees with `git worktree list` and create a new one for this task if needed.
2. Use the naming convention: `git worktree add -b ai/<task> .worktrees/<task>`.
3. Navigate to the worktree directory before making any changes.
4. Commit changes when the task is finished, merge to main, then clean the worktree.

Create feature branches and open a PR for review before merging. Use descriptive branch names (e.g. `feat/add-login`, `fix/button-styling`). Do NOT commit directly to `main`.

## API Surfaces

HashHive exposes three distinct API surfaces, each with its own auth, error envelope, and pagination shape:

- **Agent API** (`/api/v1/agent/*`) -- pre-shared Bearer token, used by hashcat worker agents. Spec is generated from `@hono/zod-openapi` route definitions in `packages/backend/src/routes/agent/*` and served anonymously at runtime at `GET /api/v1/agent/openapi.json` (no static YAML file). Never break this surface.
- **Dashboard API** (`/api/v1/dashboard/*`) -- BetterAuth cookie session, used by the React frontend. `limit`/`offset` pagination, `{ error: { code, message } }` envelope. Spec is generated from `@hono/zod-openapi` route definitions in `packages/backend/src/routes/dashboard/*` and served anonymously at runtime at `GET /api/v1/dashboard/openapi.json` (no static YAML file).
- **Control API** (`/api/v1/control/*`) -- per-user API keys (format `cst_*`, bcrypt-hashed in `users.api_key_hash`), used by CLI tooling, automation, CI, and the planned TUI. RFC 9457 problem-details errors (`application/problem+json`), `offset`/`limit` pagination. Spec is generated from `@hono/zod-openapi` route definitions in `packages/backend/src/routes/control/*` and served anonymously at runtime at `GET /api/v1/control/openapi.json` (no static YAML file).

Users issue and rotate Control API keys from the dashboard Account page (`/account`).

## Agent-Specific Notes

- `.kiro/steering/` and `.kiro/specs/` are **authoritative** -- align structural changes with those documents rather than inferring architecture solely from current code. When code conflicts with these documents, the documents win.
- `.kiro/steering/tech.md` contains explicit constraints on what NOT to introduce. Respect these constraints.
- Prefer mermaid diagrams for architectural or sequence diagrams in documentation.
- Agents (hashcat workers) are the primary API consumer. Never break the agent API to improve the dashboard or control experience.
- **Wire shapes live in `@hashhive/shared` as `z.infer` from Zod schemas.** Do not declare local TypeScript interfaces in `packages/backend/src/services/*` or `packages/frontend/src/hooks/*` for shapes that cross the API boundary — add a schema to `packages/shared/src/schemas/index.ts`, export the `z.infer<...>` type from `packages/shared/src/types/index.ts`, and import. The same rule applies to test fixtures (`tests/fixtures/api-responses.ts`).
- **All three surfaces are route-as-spec via `@hono/zod-openapi`.** The `createRoute(...)` definition in `packages/backend/src/routes/{agent,dashboard,control}/*` IS the contract, and the served `/api/v1/{agent,dashboard,control}/openapi.json` is generated from it. When changing a wire shape, update the shared Zod schema in `@hashhive/shared` and reference it from the relevant `createRoute(...)` — there is no separate YAML to keep in sync, and there is no `packages/openapi/` directory.
- **Contract-test mocks must mirror the service's `ReturnType`, not the route's response schema.** When mocking a service in a `*-routes.test.ts` or `*-contract.test.ts`, pin via `satisfies Awaited<ReturnType<typeof svc>>` (static fixtures) or `mock<typeof svc[fnName]>(...)` (dynamic factories). Mocking against the route schema means the schema is testing itself — see [`docs/solutions/conventions/contract-test-mocks-mirror-service-not-schema.md`](./docs/solutions/conventions/contract-test-mocks-mirror-service-not-schema.md) for the patterns and anti-patterns.

## AI Behavior Rules

- Optimize code for LLM reasoning: prefer flat/explicit patterns, minimal abstractions, structured logging, and linear control flow.
- When you learn new project patterns or conventions, suggest updates to this file.
- Always verify your work before returning: run tests, check builds, confirm changes work as expected.
- Always check documentation (via MCP or project docs) before assuming knowledge about APIs or libraries.
- Use Plan Mode for complex tasks, multi-step changes, or risky modifications.
- When stuck, attempt creative workarounds before asking for help.

## Boundaries

- **Always (do without asking):** update API contracts, update docs, edit the README.
- **Ask first:** refactoring architecture, modifying auth logic.
- **Never:** delete failing tests, skip tests temporarily.

## Code Style

- **Naming:** idiomatic conventions for the primary language (TypeScript).
- **Errors:** handle explicitly with try/catch; never silently swallow.
- **Logging:** pino.
- Use TypeScript strict mode; prefer `const` over `let`, avoid `var`.
- Use `async`/`await` over raw promises; use descriptive names.
- Functional React components with hooks; keep components small and focused.
- Colocate related files (component, styles, tests); write self-documenting code and comment only complex logic.

## Testing Strategy

Levels: smoke (critical-path sanity), unit, integration, and E2E (full user flows). Frameworks: Node Test Runner / bun:test and Playwright. Coverage target: 80%. Prefer E2E and integration tests over mocked tests. See [docs/testing.md](./docs/testing.md) for patterns.

## Validation Gates (MANDATORY)

Two gates protect the codebase from drifting red. Both are non-negotiable; if either fails, fix the failures before proceeding -- do not commit a red tree, do not open a PR with failures, and do not ask the human for permission to skip the gate.

- **After completing any change task, you MUST run `just check`.** This runs format, lint, type-check, and build. It is the fast quality gate (typically <30s) and catches the majority of drift before it lands. Run it after every meaningful change, not just at the end of a session.
- **Before committing, you MUST run `just ci-check`.** This runs the full test suite on top of `just check` and is what CI runs. Local `just ci-check` green is the contract; if it fails locally it will fail in CI.
- **If either command fails, you fix it and rerun until green.** This includes test failures you didn't expect, lint findings on adjacent code the formatter touched, and type errors surfaced by upstream dependency changes. The standard is "green at commit time", not "green on the change you intended to make".

Recipes that wrap individual concerns (`just test-frontend`, `just type-check`, etc.) are useful for iterating on a specific failure but never substitute for the two gates above.

## Security

Authentication supports Email/Password and directory sign-in via LDAP/Active Directory (group-gated, fail-closed, off by default), plus per-user Control API keys (`cst_*`) and pre-shared agent Bearer tokens. Data handling covers encryption at rest and in transit (TLS), data-retention policies, audit logging, and RBAC. Secrets come from environment variables.

Security tooling: Dependabot, Renovate, Snyk, CodeQL, Trivy, Grype, Checkov, OSSF Scorecard.

> **Never commit secrets.** Use environment variables, secret managers, or secure vaults for credentials, and secure transport for anything sensitive.

When a change touches authentication, data handling, API endpoints, or dependencies, proactively offer a security review of the affected code.
