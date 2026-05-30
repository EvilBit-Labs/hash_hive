---
title: "Projection layer must narrow z.record(...) wire shapes, not cast"
date: 2026-05-30
problem_type: convention
component: api-contract
severity: medium
module: packages/backend/src/services
applies_when:
  - "A backend projection function maps a DB row whose JSONB column is typed `unknown` into a wire-shape field declared as `z.record(...)` in `@hashhive/shared`"
  - "The DB column can legitimately hold legacy non-object data (primitives, arrays, null) from earlier schema iterations"
  - "The wire-shape contract promises consumers a plain object"
tags:
  - zod
  - wire-contract
  - projection
  - type-narrowing
  - defensive-validation
  - drizzle-jsonb
related_components:
  - testing_framework
  - tooling
---

# Projection layer must narrow `z.record(...)` wire shapes, not cast

## Context

The wire shape `AgentTaskSummary.progress` in `@hashhive/shared` is `z.record(z.string(), z.unknown())` -- a plain object map. The corresponding DB column is `tasks.progress jsonb`, which Drizzle types as `unknown`. Pre-fix, the projection in `packages/backend/src/services/tasks/agent-projection.ts` did:

```ts
progress: (row.progress as Record<string, unknown> | null) ?? {}
```

A reviewer (Copilot, PR #181) caught the contract violation: legacy rows can hold a primitive, an array, or a string sentinel from an older agent. The `as Record<string, unknown> | null` cast lies about the runtime shape, and the `?? {}` fallback only catches `null` / `undefined` -- a truthy string or array slips through unchanged. Downstream consumers expecting an object then encounter `.entries(progress)` or `Object.keys(progress)` returning surprising results.

This isn't a one-off. Any time a Drizzle JSONB column (`unknown`) is projected into a Zod-declared `z.record(...)` wire shape, the same pattern is wrong for the same reason.

## Guidance

Never use `as Record<string, unknown>` against a Drizzle JSONB column when the wire contract is `z.record(...)`. Use a small narrowing helper that validates the runtime shape and collapses anything else to `{}`:

```ts
// packages/backend/src/services/tasks/agent-projection.ts
const narrowProgress = (raw: unknown): Record<string, unknown> => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as Record<string, unknown>
}

return rows.map((row) => ({
  // ...
  progress: narrowProgress(row.progress),
  // ...
}))
```

Three checks in order: reject `null`, reject anything that isn't `typeof === 'object'`, reject arrays (which are `typeof === 'object'` in JavaScript). Only an honest plain object survives. The cast inside the helper is the *one place* where the assertion is correct -- because the three runtime checks have already established it.

## Why This Matters

- **Contract honesty.** A wire shape declared as `z.record(...)` is a promise to consumers. Casting at the projection layer breaks that promise silently -- the route returns a primitive or array masquerading as an object, and the frontend's TypeScript types claim it's a record. The lie surfaces as a runtime crash on the consumer side, far from the source.
- **Legacy data is real.** JSONB columns accumulate shape drift over years. An older agent emitting `"keyspaceProgress": 0` as a bare number (instead of the current `{ keyspaceProgress: 0 }` object) is the kind of thing that lives in production for months before anyone notices.
- **The cost is trivial.** Three lines of runtime check. The cost of *not* doing it is a class of bug that's invisible at compile time and only surfaces when a specific legacy row happens to flow through a specific consumer.

## Examples

Applies anywhere a Drizzle JSONB column flows into a `z.record(...)` wire shape. Current callsites in the backend:

- `packages/backend/src/services/tasks/agent-projection.ts` -- `tasks.progress` → `AgentTaskSummary.progress` (the originating fix).
- Future projections of `agents.capabilities`, `tasks.resultStats`, `tasks.workRange`, and similar JSONB columns into wire shapes that declare them as record/object types.

Audit rule: grep for `as Record<string, unknown>` inside `packages/backend/src/services/` and `packages/backend/src/routes/`. Every match is either a `narrowProgress`-style helper definition (legitimate) or a contract-violating cast (fix it).

## Related

- `docs/solutions/conventions/shared-zod-openapi-wire-contract-mirror-2026-05-25.md` -- the cross-boundary mirror rule (Zod ↔ OpenAPI ↔ route response). This projection-layer convention is the runtime half of that compile-time mirror: the schema declares the shape, the projection enforces it.
- `AGENTS.md` -- "Wire shapes live in `@hashhive/shared` as `z.infer` from Zod schemas" (the upstream rule that makes this convention load-bearing).
