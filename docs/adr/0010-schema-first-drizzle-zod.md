# ADR-0010: Schema-first — Drizzle tables as the single source of types

**Date**: 2026-06-18
**Status**: accepted
**Deciders**: Project owner (@unclesp1d3r)

## Context

Recorded retroactively (Tech Plan "Schema-First Architecture"). A platform
with three API surfaces and a shared frontend risks the same shape being
declared three times (DB row, wire schema, TS interface) and drifting. The
spec chose to derive everything from one definition.

## Decision

Data shapes flow from Drizzle table definitions → Zod schemas in
`@hashhive/shared` → TypeScript types via `z.infer`. Cross-API-boundary
shapes are never hand-declared as local interfaces in
`packages/backend/src/services/*` or `packages/frontend/src/hooks/*`; they
are added to the shared schema and imported. The `createRoute(...)`
definition references the same shared schemas (see
[ADR-0013](0013-route-as-spec-hono-zod-openapi.md)).

## Alternatives Considered

### Alternative 1: Hand-written TypeScript interfaces per layer

- **Pros**: no codegen indirection; each layer is self-contained.
- **Cons**: the same shape is duplicated across DB/wire/UI and drifts
  silently; a column change requires hunting every copy.
- **Why not**: drift is the exact failure mode this architecture exists to
  prevent.

## Consequences

### Positive

- One definition; a schema change propagates as a type error everywhere it
  matters.
- Validation (Zod) and types come from the same source, so runtime and
  compile-time agree.

### Negative

- Tight coupling from the DB schema out to the wire contract — a DB change
  can ripple to clients and must be made deliberately.

### Risks

- Local-interface duplication re-introduces drift; it is treated as a review
  failure (AGENTS.md) and was the subject of a PR #245 finding.
