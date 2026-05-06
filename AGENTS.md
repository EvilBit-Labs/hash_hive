# Agent Context

This file provides AI coding assistants with project context. All substantive documentation lives in the files linked below.

## Project Documentation

- **[Architecture & Design](./ARCHITECTURE.md)** -- system overview, tech stack, schema flow, backend/frontend architecture, API surfaces, data model, documentation hierarchy
- **[Contributing Standards](./CONTRIBUTING.md)** -- code style, naming conventions, git workflow, PR process, issue tracking
- **[Development Setup](./docs/development.md)** -- environment, commands, infrastructure services, environment variables
- **[Testing](./docs/testing.md)** -- test strategy, bun:test patterns, mock patterns, frontend test utilities
- **[Known Gotchas](./GOTCHAS.md)** -- hard-won lessons by domain (TypeScript strict mode, Hono, Drizzle, BetterAuth, bun:test, frontend JSX)

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

## Agent Rules <!-- tessl-managed -->

@.tessl/RULES.md follow the [instructions](.tessl/RULES.md)
