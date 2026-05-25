---
module: packages/shared, packages/openapi, packages/backend
date: 2026-05-25
problem_type: convention
component: api-contract
severity: medium
tags:
  - zod
  - openapi
  - shared-types
  - wire-contract
  - agents-md
  - verification-sweep
  - contract-test
applies_when:
  - "Adding or changing a field on a shape that crosses the agent/dashboard/control API boundary"
  - "A response field is intentionally omit-when-false (the field is absent rather than carrying an explicit false value)"
  - "An issue's acceptance criteria are largely already met on main and the work is a verification sweep, not greenfield implementation"
---

# Mirror agent-API wire shapes across Zod + OpenAPI + route boundary

## Context

PR #169 closed issue #155 (Task Distribution & Assignment). Code exploration showed every behavioral AC was already implemented on `main` — the runtime path for strict assignment, hybrid generation, reassignment, retry logic, priority queuing, and the `hasHighPriorityTasks` heartbeat flag had been complete since prior scheduler work. What was missing was the AGENTS.md-mandated contract sync: `hasHighPriorityTasks` lived only in `packages/backend/src/services/agents.ts` and the route handler. There was no Zod schema in `@hashhive/shared`, no field in `packages/openapi/agent-api.yaml`, and no contract test asserting the response shape. Generated agent SDKs reading the spec had no typed access to a flag the server has been emitting for sprints.

This isn't a one-off oversight pattern. The AGENTS.md rules exist precisely because it's easy to ship a backend-only field that violates the cross-boundary contract — `just check` and the unit tests stay green, agents still get the field on the wire, nothing breaks loudly. The drift compounds silently until a downstream SDK consumer tries to regenerate against the OpenAPI spec.

## Guidance

When a field crosses the agent/dashboard/control API boundary, land it in **three places in the same change**: the shared Zod schema, the OpenAPI spec, and a contract test that round-trips the route's actual response body through the shared schema.

### 1. Shared Zod schema (`packages/shared/src/schemas/index.ts`)

For a field with an omit-when-false wire policy, use `z.literal(true).optional()` (not `z.boolean().optional()`). The literal mirrors the OpenAPI `enum: [true]` constraint and makes a route refactor that emits `false` a compile error.

Use `.strict()` to mirror OpenAPI's closed-by-default semantics — extra fields fail parse rather than slip through.

```typescript
export const agentHeartbeatResponseSchema = z
  .object({
    acknowledged: z.literal(true),
    // The schema enforces "if present, value is true." The omit-when-false
    // POLICY lives in the route's conditional spread; the schema does not
    // enforce policy, only value shape.
    hasHighPriorityTasks: z.literal(true).optional(),
  })
  .strict()
```

Export the inferred type from `packages/shared/src/types/index.ts`:

```typescript
export type AgentHeartbeatResponse = z.infer<typeof agentHeartbeatResponseSchema>
```

### 2. OpenAPI component schema (`packages/openapi/agent-api.yaml`)

Mirror the Zod schema field-for-field. Use `enum: [true]` on a boolean to mirror `z.literal(true)`. Do **not** list omit-when-false fields in `required`.

```yaml
HeartbeatResponse:
  type: object
  required: [acknowledged]
  properties:
    acknowledged:
      type: boolean
      enum: [true]
    hasHighPriorityTasks:
      type: boolean
      enum: [true]
      description: |
        Omitted (not `false`) when no high-priority work is available.
        Agents must treat absence as "no priority signal."
```

Wire the endpoint's 200 response to this schema specifically rather than reusing a generic `Acknowledged` response — the heartbeat now carries more shape than other acknowledged endpoints.

### 3. Route handler (`packages/backend/src/routes/agent/index.ts`)

Annotate the response body with the shared inferred type **before** passing to `c.json`. This makes shape drift a compile error at the boundary:

```typescript
const body: AgentHeartbeatResponse = {
  acknowledged: true,
  ...(result.hasHighPriorityTasks ? { hasHighPriorityTasks: true } : {}),
}
return c.json(body)
```

The conditional spread is the omit-when-false policy. A naive `{ hasHighPriorityTasks: result.hasHighPriorityTasks }` would fail to type-check against `true | undefined`.

### 4. Contract test (`packages/backend/tests/unit/agent-api-contract.test.ts`)

Add both branches and parse the actual response body through the shared schema:

```typescript
it('omits hasHighPriorityTasks when service reports no priority work', async () => {
  const res = await app.request(`${AGENT_BASE}/heartbeat`, { /* ... */ })
  const body = (await res.json()) as Record<string, unknown>
  expect(body['hasHighPriorityTasks']).toBeUndefined()
  // Triple-sync proof: parse() success means route ↔ Zod ↔ OpenAPI agree.
  expect(() => agentHeartbeatResponseSchema.parse(body)).not.toThrow()
})

it('surfaces hasHighPriorityTasks=true when service reports priority work', async () => {
  ;(processHeartbeat as unknown as { mockImplementationOnce: (fn: () => unknown) => void })
    .mockImplementationOnce(() => Promise.resolve({ hasHighPriorityTasks: true }))
  const res = await app.request(`${AGENT_BASE}/heartbeat`, { /* ... */ })
  const body = (await res.json()) as Record<string, unknown>
  expect(body['hasHighPriorityTasks']).toBe(true)
  const parsed = agentHeartbeatResponseSchema.parse(body)
  expect(parsed.hasHighPriorityTasks).toBe(true)
})
```

A `parse()` success against the schema is the actual contract proof — not just a `toBe` assertion on individual fields.

## Why This Matters

- **Generated agent SDKs read the OpenAPI spec, not the TypeScript type.** If the spec is missing a field, downstream Go/Python/Rust agent clients have no typed access to it even though it's on the wire. This is the silent class of drift that violates AGENTS.md.
- **The Zod ↔ OpenAPI mirror is the single source of truth for the wire contract.** Either alone is insufficient: TypeScript types don't survive language boundaries; OpenAPI without Zod doesn't catch server-side regressions at compile time. The pair plus the contract test forms a triangle that fails loudly on any drift.
- **`z.literal(true)` + `enum: [true]` + `.strict()` is the omit-when-false canon.** `z.boolean().optional()` looks equivalent but accepts `false`, which violates the omit policy. The literal pattern makes the policy a property of the type system, not a property of the route handler's branching.

## When to Apply

- Any new field on an `/api/v1/agent/*`, `/api/v1/dashboard/*`, or `/api/v1/control/*` response — even if it's "just a hint" the server emits.
- Any time a backend service starts producing a value that wasn't on the original response shape.
- When closing a verification-sweep ticket where most ACs are already met: the AC↔code↔test matrix often surfaces undocumented wire fields as the real remaining work.

## Examples

### The verification-sweep matrix as a pre-implementation step

For issues where most acceptance criteria are claimed to be already met (e.g., "the work is mostly done; finish it"), build a literal AC↔code↔test matrix **before** writing any code:

| # | Acceptance criterion | Production symbol | Test reference | Status |
|---|---|---|---|---|
| 1.1 | Filters by `project_id` AND capabilities in WHERE | `services/tasks.ts:430-440` | `tests/unit/tasks.test.ts:393` | ✅ |
| 6 — Shared schema | No `agentHeartbeatResponseSchema` in `@hashhive/shared` | — | — | ❌ Orphan |

This converts a vague "implement issue #155" into a precise diff: most rows have ✅; the real work is whatever's marked ❌ or 🟡. Saved an entire re-implementation pass on PR #169 and surfaced the only legitimate gap (contract artifacts) as the highest-leverage work.

The matrix lives in the PR's `docs/issues/<n>-ac-traceability-matrix.md` so reviewers can verify the "already done" claims independently.

### Before / after of a contract gap

**Before (PR #169 base):** field present in route + service + tests; absent from OpenAPI and shared schema. AGENTS.md violation. Silent.

**After:** field present in all three locations + contract test parses route response through shared schema. Drift in any one corner is now a compile error or a contract-test failure.

## Related

- **AGENTS.md** — "Wire shapes live in `@hashhive/shared` as `z.infer` from Zod schemas" and "Keep the OpenAPI spec in sync with shared types."
- **PR #169** — first PR to land this triple-sync pattern; closed issue #155.
- **Issue #170** — follow-up for the heartbeat error envelope (separate pattern: error-envelope per-surface, not response-shape mirror).
- `docs/solutions/conventions/form-submit-payload-null-checks-2026-05-19.md` — sibling convention on explicit checks across the wire boundary.
