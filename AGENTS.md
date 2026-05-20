# Agent Context

This file provides AI coding assistants with project context. All substantive documentation lives in the files linked below.

## Project Documentation

- **[Architecture & Design](./ARCHITECTURE.md)** -- system overview, tech stack, schema flow, backend/frontend architecture, API surfaces, data model, documentation hierarchy
- **[Contributing Standards](./CONTRIBUTING.md)** -- code style, naming conventions, git workflow, PR process, issue tracking
- **[Development Setup](./docs/development.md)** -- environment, commands, infrastructure services, environment variables
- **[Testing](./docs/testing.md)** -- test strategy, bun:test patterns, mock patterns, frontend test utilities
- **[Known Gotchas](./GOTCHAS.md)** -- hard-won lessons by domain (TypeScript strict mode, Hono, Drizzle, BetterAuth, bun:test, frontend JSX)
- **[Documented Solutions](./docs/solutions/)** -- searchable knowledge store of past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.
- **[Frontend Design Context](./.impeccable.md)** -- users, brand personality, aesthetic direction, anti-references, and the five design principles every UI surface must follow. Read before any frontend visual work.

## API Surfaces

HashHive exposes three distinct API surfaces, each with its own auth, error envelope, and pagination shape:

- **Agent API** (`/api/v1/agent/*`) -- pre-shared Bearer token, used by hashcat worker agents. Spec: `packages/openapi/agent-api.yaml`. Never break this surface.
- **Dashboard API** (`/api/v1/dashboard/*`) -- BetterAuth cookie session, used by the React frontend. `page`/`pageSize` pagination, `{ error: { code, message } }` envelope.
- **Control API** (`/api/v1/control/*`) -- per-user API keys (format `cst_*`, bcrypt-hashed in `users.api_key_hash`), used by CLI tooling, automation, CI, and the planned TUI. RFC 9457 problem-details errors, `offset`/`limit` pagination. Spec: `packages/openapi/control-api.yaml`.

Users issue and rotate Control API keys from the dashboard Account page (`/account`).

## Agent-Specific Notes

- `.kiro/steering/` and `.kiro/specs/` are **authoritative** -- align structural changes with those documents rather than inferring architecture solely from current code. When code conflicts with these documents, the documents win.
- `.kiro/steering/tech.md` contains explicit constraints on what NOT to introduce. Respect these constraints.
- Prefer mermaid diagrams for architectural or sequence diagrams in documentation.
- Agents (hashcat workers) are the primary API consumer. Never break the agent API to improve the dashboard experience.
- **Wire shapes live in `@hashhive/shared` as `z.infer` from Zod schemas.** Do not declare local TypeScript interfaces in `packages/backend/src/services/*` or `packages/frontend/src/hooks/*` for shapes that cross the API boundary — add a schema to `packages/shared/src/schemas/index.ts`, export the `z.infer<...>` type from `packages/shared/src/types/index.ts`, and import. The same rule applies to test fixtures (`tests/fixtures/api-responses.ts`).

## Validation Gates (MANDATORY)

Two gates protect the codebase from drifting red. Both are non-negotiable; if either fails, fix the failures before proceeding -- do not commit a red tree, do not open a PR with failures, and do not ask the human for permission to skip the gate.

- **After completing any change task, you MUST run `just check`.** This runs format, lint, type-check, and build. It is the fast quality gate (typically <30s) and catches the majority of drift before it lands. Run it after every meaningful change, not just at the end of a session.
- **Before committing, you MUST run `just ci-check`.** This runs the full test suite on top of `just check` and is what CI runs. Local `just ci-check` green is the contract; if it fails locally it will fail in CI.
- **If either command fails, you fix it and rerun until green.** This includes test failures you didn't expect, lint findings on adjacent code the formatter touched, and type errors surfaced by upstream dependency changes. The standard is "green at commit time", not "green on the change you intended to make".

Recipes that wrap individual concerns (`just test-frontend`, `just type-check`, etc.) are useful for iterating on a specific failure but never substitute for the two gates above.

## Agent Rules <!-- tessl-managed -->

@.tessl/RULES.md follow the [instructions](.tessl/RULES.md)
