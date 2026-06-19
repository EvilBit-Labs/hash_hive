# ADR-0014: Turborepo + Bun workspaces over NX

**Date**: 2026-06-18
**Status**: accepted
**Deciders**: Project owner (@unclesp1d3r)

## Context

Recorded retroactively. HashHive is a monorepo (`@hashhive/backend`,
`@hashhive/frontend`, `@hashhive/shared`). The project migrated off an
earlier NX-based setup as part of the broader stack change
(Express→Hono, Next.js→Vite+React, MongoDB→PostgreSQL+Drizzle, Jest→bun:test).
Monorepo tooling touches every build, test, and lint command and the CI
pipeline.

## Decision

Use Turborepo for task orchestration over Bun workspaces. Bun is the runtime
and package manager; Turborepo provides the task graph and caching. NX and
Lerna are not used.

## Alternatives Considered

### Alternative 1: NX (prior tooling)

- **Pros**: powerful generators, mature task graph.
- **Cons**: heavier conceptual surface and config than this project needs;
  was being shed along with the rest of the legacy stack.
- **Why not**: Turborepo + Bun is lighter and aligns with the Bun-native
  toolchain.

### Alternative 2: Lerna

- **Why not**: largely superseded for task running/caching; explicitly not
  chosen.

### Alternative 3: Plain Bun workspaces, no orchestrator

- **Pros**: zero extra tooling.
- **Why not**: loses cross-package task caching and the dependency-aware task
  graph Turborepo provides.

## Consequences

### Positive

- Light, Bun-native monorepo with cached, dependency-aware task running
  (`turbo run build|test|lint|type-check`).
- Consistent local and CI command surface (the `just` recipes wrap it).

### Negative

- Turborepo remote-cache features are unused (disabled); caching is local
  only.

### Risks

- The Tech Plan still lists the older tooling and is stale; ARCHITECTURE.md is
  authoritative.
