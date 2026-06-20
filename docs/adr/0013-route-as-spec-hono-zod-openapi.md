# ADR-0013: Route-as-spec via @hono/zod-openapi

**Date**: 2026-06-18
**Status**: accepted
**Deciders**: Project owner (@unclesp1d3r)

## Context

Recorded retroactively. The original plan kept a hand-maintained OpenAPI YAML
(`packages/openapi/agent-api.yaml`) as the contract. That created a
triple-sync problem: the Zod schema, the YAML spec, and the route
implementation could each drift from the others.

## Decision

API contracts for all three surfaces are defined by `createRoute(...)` calls
(@hono/zod-openapi) in the route handlers, which reference the shared Zod
schemas (see [ADR-0010](0010-schema-first-drizzle-zod.md)). OpenAPI 3.1
documents are generated at runtime and served anonymously at
`/api/v1/{agent,dashboard,control}/openapi.json`. There is no static YAML and
no `packages/openapi/` directory.

## Alternatives Considered

### Alternative 1: Hand-maintained OpenAPI YAML (original)

- **Pros**: spec readable without running the app; familiar artifact.
- **Cons**: drifts from the implementation; three things to keep in sync.
- **Why not**: the route is the contract — generating the spec from it
  removes a whole class of drift bugs.

### Alternative 2: Code-first with a separate generated TS type layer

- **Why not**: still duplicates the contract; @hono/zod-openapi binds the
  schema, the runtime validation, and the spec in one definition.

## Consequences

### Positive

- The served spec cannot drift from the routes; changing a shape is one edit
  to the shared schema referenced by `createRoute`.
- Clients fetch a runtime-accurate spec for codegen.

### Negative

- No static YAML artifact for consumers that expected a checked-in file; they
  must use the runtime endpoint.

### Risks

- The spec docs still reference `openapi/agent-api.yaml` and are stale.
  Changing a wire shape means updating the shared schema; a route's
  `createRoute` change is itself a deliberate contract change (subject to
  [ADR-0004](0004-agent-api-revisable-until-1.0.md) /
  [ADR-0005](0005-version-public-api-after-1.0.md)).
