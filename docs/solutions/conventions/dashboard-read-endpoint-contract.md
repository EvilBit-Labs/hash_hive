---
module: packages/backend, packages/frontend, packages/shared, packages/openapi
date: 2026-05-30
problem_type: convention
component: api-contract
severity: medium
tags:
  - dashboard
  - read-endpoint
  - wire-contract
  - zod
  - openapi
  - shared-types
  - agents-md
  - event-routing
applies_when:
  - "Adding a new `GET /api/v1/dashboard/*` endpoint"
  - "Modifying an existing dashboard read endpoint in a way that touches its response shape"
  - "Adding a status-keyed count field to a wire shape"
---

# Dashboard read-endpoint contract

## Context

When issue #161 closed the `/api/v1/dashboard/stats` endpoint, the route, mount, RBAC, and frontend hook were all already in code on `main`. The work that remained was the contract trail AGENTS.md treats as the real Definition of Done — and four gaps appeared at once:

1. No tests pinning the AC3 "no cross-project leakage" guarantee.
2. No OpenAPI entry; generated clients (Control CLI, planned TUI) couldn't discover the endpoint from the spec.
3. The response shape was hand-declared as an `interface` in the consuming frontend hook, violating the "wire shapes live in `@hashhive/shared`" rule.
4. The route mapped status-keyed counts via `Record<string, number>` + `??  0`, which silently dropped any DB status literal not enumerated in the response shape — `busy` and `benchmarked` agents were already disappearing from the dashboard counts in production.

The four DoD gaps are not unique to `/stats`. They repeat across at least eight other dashboard read endpoints today (`/agents`, `/results`, `/hashes`, `/health`, `/tasks`, `/crackers`, `/attack-templates`, `/system-health`). Closing them on every endpoint at once is bigger than fits in any one ticket. This convention codifies the pattern so future endpoints adopt it as they're touched, without having to re-discover it.

`/stats` is the worked example.

## Guidance

Every dashboard read endpoint (`GET /api/v1/dashboard/*`) ships with all four of the following artifacts. They land in the same change.

### 1. Shared Zod schema in `packages/shared/src/schemas/index.ts`

Response shape defined as a Zod schema with `.strict()` on each object so a stray field fails parse rather than slipping through:

```ts
export const dashboardStatsSchema = z
  .object({
    agents: z.object({ total: z.number().int().nonnegative(), online: ... }).strict(),
    // ...
  })
  .strict()
```

Enum-keyed fields (status counts, kind buckets) **must** be modeled by reusing a canonical Zod enum export — `agentStatusSchema`, the new `campaignStatusSchema`, `campaignTaskStatsSchema`, and similar — not by re-enumerating literals inline at the use site. The reused enum keeps the schema, the route, and any future migration in sync at one place.

Export the inferred type from `packages/shared/src/types/index.ts`:

```ts
export type DashboardStats = z.infer<typeof dashboardStatsSchema>
```

### 2. OpenAPI entry in `packages/openapi/dashboard-api.yaml`

Path block and component schema mirroring the Zod schema field-for-field, including the closed-by-default semantics (`additionalProperties: false`) and the full `required:` list. Tag with an existing dashboard tag or add one if no fitting tag exists. Path description must name: (a) scope is server-managed via `session.session.projectId` (cookie session); (b) sensitivity classification if the response contains operationally meaningful aggregates (cracked hash counts, agent availability); (c) 403 returned for non-members rather than 404 so the endpoint does not aid project enumeration.

### 3. Integration test under `packages/backend/tests/unit/`

Convention: `dashboard-<endpoint>-routes.test.ts`. Mocks the `db` chain via per-table discriminator so the route's parallel queries can be steered independently. The codebase has no real-DB integration harness; `tests/integration/` also mocks the drizzle client. The route test pins:

- **Auth.** 401 unauthenticated.
- **Project context.** 400 when `session.projectId` is missing.
- **Non-member.** 403 when the user is not a member of `session.projectId`.
- **Global admin without project membership.** 403 — pins that `requireProjectAccess()` is not bypassed by a global role. Without this test, a future addition of `requireRole('admin')` to the route would create a silent bypass.
- **Project-scoped query construction.** Each aggregate query calls `.where(...)` filtering by `session.projectId`. Assert via a spy on the mocked `where`. If a future refactor drops the filter on any query, the spy reads 0 for that table and fails loudly.
- **Response shape.** Every status literal in the schema lands on the wire, including DB literals not previously surfaced (e.g., `busy` and `benchmarked` for agents).

### 4. Realtime invalidation via the existing `event-routing.ts` map

**Do not introduce a new event type per endpoint.** The frontend's `packages/frontend/src/lib/event-routing.ts` is the central invalidation map; it already aggregates the underlying data-model events into the dashboard read-side query keys. New endpoints add their query key to existing per-event entries:

```ts
// packages/frontend/src/lib/event-routing.ts
const projectInvalidationKeys = {
  agent_status: ['agents', 'dashboard-stats', 'my-new-query-key'],
  campaign_status: ['campaigns', 'dashboard-stats', 'my-new-query-key'],
  // ...
}
```

The brainstorm that produced this convention initially proposed a new `dashboard_stats_changed` event. Doc review found that `event-routing.ts:73-84` already invalidates `['dashboard-stats']` on `agent_status`, `campaign_status`, `task_update`, and `crack_result` — adding a new event type would have produced redundant double-invalidations at every publisher site with no behavioral payoff. Future endpoint authors must not repeat this mistake. If the publisher-coupling concern grows enough that the routing map becomes hard to maintain, take it as a separate refactor — not as a per-endpoint pattern.

## Compile-time vs. runtime enforcement boundary

The shared schema is the apex source of truth. The OpenAPI component mirrors it. The route is annotated with the inferred type for **compile-time** enforcement. The contract test rounds the live response through `dashboardStatsSchema.parse()` for **CI-time** enforcement.

**The live route does NOT call `.parse()` on its own response.** Adding one would expose Zod errors via the 500 path (the global error handler in `packages/backend/src/index.ts:166-167` suppresses internal details, but the path itself shouldn't fire on a happy request). At runtime the route silently defaults unknown DB status literals to 0 — the same observable shape as a "field is absent" response. The contract test in `packages/backend/tests/unit/dashboard-api-contract.test.ts` catches the drift in CI by parsing the real route response through the shared schema; the test fails on any future DB enum migration that adds a literal not covered by the schema.

**Migration safety.** When a future migration adds a new status literal to the underlying DB column, update the shared schema, OpenAPI spec, and route mapping in the same PR as the migration. The contract test will fail until all three are updated.

## Status-literal rule

Status-keyed counts in any dashboard read endpoint **must** be modeled as Zod literal unions in the schema, referenced from `dashboardStatsSchema`-style wire schemas; the route maps via explicit `.get()` lookups against the schema's known keys. **Never** use `Record<string, number>` + `??  0` in the route. The `Record` pattern looks equivalent but it silently drops any DB status value not enumerated in the response shape — the bug that motivated D7 in plan #161 and the wire-shape widening that landed `busy` and `benchmarked` agents on the dashboard.

When the DB persists more granular statuses than the operator-facing card needs (e.g., tasks distinguish `assigned` from `running` internally but the operator sees one bucket), the route does the bucketing explicitly and a comment names the mapping. Mirror the precedent at `packages/backend/src/services/campaign-dashboard.ts`'s `getCampaignTaskStats`.

## Scope

This convention applies **strictly to `/api/v1/dashboard/*`** GET endpoints. The agent API (`/api/v1/agent/*`, pre-shared Bearer token) and the control API (`/api/v1/control/*`, per-user `cst_*` API keys with RFC 9457 problem-details errors) have their own conventions. The triple-sync triangle (Zod ↔ OpenAPI ↔ contract test) extends across surfaces; this convention's specific pillars (cookie session, `dashboard-stats` invalidation map entry, dashboard error envelope) do not.

## Worked example — `/api/v1/dashboard/stats` (issue #161)

| Pillar | Location |
|---|---|
| Shared Zod schema | `packages/shared/src/schemas/index.ts` (`dashboardStatsSchema`, `campaignStatusSchema`, plus the reused `agentStatusSchema` and `campaignTaskStatsSchema`) |
| Shared inferred type | `packages/shared/src/types/index.ts` (`DashboardStats`, `CampaignStatus`) |
| Route | `packages/backend/src/routes/dashboard/stats.ts` |
| OpenAPI path + component | `packages/openapi/dashboard-api.yaml` (`/stats` path; `DashboardStats` component schema; `Stats` tag) |
| Integration test | `packages/backend/tests/unit/dashboard-stats-routes.test.ts` |
| Contract test (`.parse()` round-trip + OpenAPI presence) | `packages/backend/tests/unit/dashboard-api-contract.test.ts` (search for `/stats` block) |
| Frontend consumer | `packages/frontend/src/hooks/use-dashboard.ts` (`useDashboardStats`); freshness via `packages/frontend/src/lib/event-routing.ts:73-84` |

## Existing endpoints predating this contract

These endpoints currently violate one or more pillars. They are **not** retroactively migrated by this convention. Each picks up the four-pillar trail when next touched for behavioral reasons:

- `/api/v1/dashboard/agents` and `/agents/{id}/*` (errors, benchmarks, tasks, list)
- `/api/v1/dashboard/results`
- `/api/v1/dashboard/hashes/*`
- `/api/v1/dashboard/health`, `/api/v1/dashboard/system-health`
- `/api/v1/dashboard/tasks`
- `/api/v1/dashboard/crackers`
- `/api/v1/dashboard/attack-templates`

The same opportunistic-backfill rule applies to inline-declared response interfaces across `use-campaigns.ts`, `use-resources.ts`, `use-crackers.ts`, `use-results.ts`, and `use-events.ts` (~25+ interfaces). The dashboard OpenAPI spec's preamble already calls out a future revision will expand coverage; this convention is the structural framework that revision should land against.

## When to apply

- Any new `GET /api/v1/dashboard/*` endpoint — all four pillars in the same PR.
- Any modification to an existing dashboard read endpoint that touches its response shape — pick up the missing pillars (schema, OpenAPI, contract test) as part of the change.
- Any addition of a status literal to a DB column that drives a dashboard count — schema + OpenAPI + route mapping must update in the same PR as the migration.

## Related

- **AGENTS.md** — "Wire shapes live in `@hashhive/shared` as `z.infer` from Zod schemas" and "Keep the OpenAPI spec in sync with shared types."
- [`docs/solutions/conventions/shared-zod-openapi-wire-contract-mirror-2026-05-25.md`](./shared-zod-openapi-wire-contract-mirror-2026-05-25.md) — the parent triple-sync convention this extends.
- **Issue #161 / PR landing this convention** — closes the four DoD gaps on `/stats` and ships `/stats` as the worked example.
- **`packages/frontend/src/lib/event-routing.ts:73-84`** — the central invalidation map. Read this before proposing any new event type for a dashboard freshness story.
