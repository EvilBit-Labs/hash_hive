---
module: packages/backend, packages/frontend, packages/shared
date: 2026-05-30
status: active
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

> **History note.** This convention originally enumerated four pillars: shared Zod schema, OpenAPI YAML mirror, integration test, realtime invalidation hook. The OpenAPI YAML mirror pillar collapsed into the schema pillar in PR #188 (dashboard YAML retirement) and the route-as-spec migration completed in PR #189 (control) and U6 (agent) — the `createRoute(...)` definition IS the OpenAPI spec, generated at runtime from the same shared Zod schema this convention requires. The three pillars below are the current contract; the structural parity test `dashboard-api-contract.test.ts` is also gone.

## Context

When issue #161 closed the `/api/v1/dashboard/stats` endpoint, the route, mount, RBAC, and frontend hook were all already in code on `main`. The work that remained was the contract trail AGENTS.md treats as the real Definition of Done — and gaps appeared across several axes:

1. No tests pinning the AC3 "no cross-project leakage" guarantee.
2. The response shape was hand-declared as an `interface` in the consuming frontend hook, violating the "wire shapes live in `@hashhive/shared`" rule.
3. The route mapped status-keyed counts via `Record<string, number>` + `?? 0`, which silently dropped any DB status literal not enumerated in the response shape — `busy` and `benchmarked` agents were already disappearing from the dashboard counts in production.

These gaps are not unique to `/stats`. They repeat across other dashboard read endpoints. Closing them on every endpoint at once is bigger than fits in any one ticket. This convention codifies the pattern so future endpoints adopt it as they're touched, without having to re-discover it.

`/stats` is the worked example.

## Guidance

Every dashboard read endpoint (`GET /api/v1/dashboard/*`) ships with all three of the following artifacts. They land in the same change.

### 1. Shared Zod schema in `packages/shared/src/schemas/index.ts` (also the OpenAPI source of truth)

Response shape defined as a Zod schema with `.strict()` on each object so a stray field fails parse rather than slipping through:

```ts
export const dashboardStatsSchema = z
  .object({
    agents: z.object({ total: z.number().int().nonnegative(), online: ... }).strict(),
    // ...
  })
  .strict()
```

Enum-keyed fields (status counts, kind buckets) **must** be modeled by reusing a canonical Zod enum export — `agentStatusSchema`, `campaignStatusSchema`, `campaignTaskStatsSchema`, and similar — not by re-enumerating literals inline at the use site. The reused enum keeps the schema, the route, and any future migration in sync at one place.

Export the inferred type from `packages/shared/src/types/index.ts`:

```ts
export type DashboardStats = z.infer<typeof dashboardStatsSchema>
```

The route imports the shared schema and binds it to its `createRoute(...)` `responses[200].content['application/json'].schema` block — that registration IS the OpenAPI spec for the endpoint. There is no separate YAML to update; the runtime spec at `GET /api/v1/dashboard/openapi.json` is generated from these route definitions.

### 2. Integration test under `packages/backend/tests/unit/`

Convention: `dashboard-<endpoint>-routes.test.ts`. Mocks the `db` chain via per-table discriminator so the route's parallel queries can be steered independently. The codebase has no real-DB integration harness; `tests/integration/` also mocks the drizzle client. The route test pins:

- **Auth.** 401 unauthenticated.
- **Project context.** 400 when `session.projectId` is missing.
- **Non-member.** 403 when the user is not a member of `session.projectId`.
- **Global admin without project membership.** 403 — pins that `requireProjectAccess()` is not bypassed by a global role. Without this test, a future addition of `requireRole('admin')` to the route would create a silent bypass.
- **Project-scoped query construction.** Each aggregate query calls `.where(...)` filtering by `session.projectId`. Assert via a spy on the mocked `where`. If a future refactor drops the filter on any query, the spy reads 0 for that table and fails loudly.
- **Response shape.** Every status literal in the schema lands on the wire, including DB literals not previously surfaced (e.g., `busy` and `benchmarked` for agents). Round-trip the live response through the shared schema's `.parse()` — schema conformance equals OpenAPI conformance because the route uses the same schema as its `createRoute(...)` response definition.

### 3. Realtime invalidation via the existing `event-routing.ts` map

**Do not introduce a new event type per endpoint.** The frontend's `packages/frontend/src/lib/event-routing.ts` is the central invalidation map; it already aggregates the underlying data-model events into the dashboard read-side query keys. New endpoints add their query key to existing per-event entries:

```ts
// packages/frontend/src/lib/event-routing.ts
const projectInvalidationKeys = {
  agent_status: ['agents', 'dashboard-stats', 'my-new-query-key'],
  campaign_status: ['campaigns', 'dashboard-stats', 'my-new-query-key'],
  // ...
}
```

The brainstorm that produced this convention initially proposed a new `dashboard_stats_changed` event. Doc review found that the `projectInvalidationKeys` map in `packages/frontend/src/lib/event-routing.ts` already invalidates `['dashboard-stats']` on `agent_status`, `campaign_status`, `task_update`, and `crack_result` — adding a new event type would have produced redundant double-invalidations at every publisher site with no behavioral payoff. Future endpoint authors must not repeat this mistake. If the publisher-coupling concern grows enough that the routing map becomes hard to maintain, take it as a separate refactor — not as a per-endpoint pattern.

## Compile-time vs. runtime enforcement boundary

The shared schema is the apex source of truth. The route binds it directly via `createRoute(...)` for both **compile-time** typing (the handler's response type narrows against the registered schema) and **spec-time** export (the same schema is emitted into the runtime OpenAPI document). The integration test rounds the live response through `dashboardStatsSchema.parse()` for **CI-time** enforcement.

**The live route does NOT call `.parse()` on its own response.** Adding one would expose Zod errors via the 500 path. At runtime the route silently defaults unknown DB status literals to 0 — the same observable shape as a "field is absent" response. The integration test catches the drift in CI by parsing the real route response through the shared schema; the test fails on any future DB enum migration that adds a literal not covered by the schema.

**Migration safety.** When a future migration adds a new status literal to the underlying DB column, update the shared schema and route mapping in the same PR as the migration. The integration test will fail until both are updated.

## Status-literal rule

Status-keyed counts in any dashboard read endpoint **must** be modeled as Zod literal unions in the schema, referenced from `dashboardStatsSchema`-style wire schemas; the route maps via explicit `.get()` lookups against the schema's known keys. **Never** use `Record<string, number>` + `?? 0` in the route. The `Record` pattern looks equivalent but it silently drops any DB status value not enumerated in the response shape — the bug that motivated D7 in plan #161 and the wire-shape widening that landed `busy` and `benchmarked` agents on the dashboard.

When the DB persists more granular statuses than the operator-facing card needs (e.g., tasks distinguish `assigned` from `running` internally but the operator sees one bucket), the route does the bucketing explicitly and a comment names the mapping. Mirror the precedent at `packages/backend/src/services/campaign-dashboard.ts`'s `getCampaignTaskStats`.

## Scope

This convention applies **strictly to `/api/v1/dashboard/*`** GET endpoints. The agent API (`/api/v1/agent/*`, pre-shared Bearer token) and the control API (`/api/v1/control/*`, per-user `cst_*` API keys with RFC 9457 problem-details errors) have their own conventions. The shared-schema-is-spec rule extends across surfaces (all three are route-as-spec); this convention's specific pillars (cookie session, `dashboard-stats` invalidation map entry, dashboard error envelope) do not.

## Worked example — `/api/v1/dashboard/stats` (issue #161)

| Pillar | Location |
|---|---|
| Shared Zod schema | `packages/shared/src/schemas/index.ts` (`dashboardStatsSchema`, `campaignStatusSchema`, plus the reused `agentStatusSchema` and `campaignTaskStatsSchema`) |
| Shared inferred type | `packages/shared/src/types/index.ts` (`DashboardStats`, `CampaignStatus`) |
| Route (binds shared schema in `createRoute(...)` → published in `/api/v1/dashboard/openapi.json`) | `packages/backend/src/routes/dashboard/stats.ts` |
| Integration test | `packages/backend/tests/unit/dashboard-stats-routes.test.ts` |
| Frontend consumer | `packages/frontend/src/hooks/use-dashboard.ts` (`useDashboardStats`); freshness via the `projectInvalidationKeys` map in `packages/frontend/src/lib/event-routing.ts` |

## Existing endpoints predating this contract

These endpoints currently violate one or more pillars. They are **not** retroactively migrated by this convention. Each picks up the three-pillar trail when next touched for behavioral reasons:

- `/api/v1/dashboard/agents` and `/agents/{id}/*` (errors, benchmarks, tasks, list)
- `/api/v1/dashboard/results`
- `/api/v1/dashboard/hashes/*`
- `/api/v1/dashboard/health`, `/api/v1/dashboard/system-health`
- `/api/v1/dashboard/tasks`
- `/api/v1/dashboard/crackers`
- `/api/v1/dashboard/attack-templates`

The same opportunistic-backfill rule applies to inline-declared response interfaces across `use-campaigns.ts`, `use-resources.ts`, `use-crackers.ts`, `use-results.ts`, and `use-events.ts` (~25+ interfaces).

## When to apply

- Any new `GET /api/v1/dashboard/*` endpoint — all three pillars in the same PR.
- Any modification to an existing dashboard read endpoint that touches its response shape — pick up the missing pillars (schema, integration test) as part of the change.
- Any addition of a status literal to a DB column that drives a dashboard count — schema + route mapping must update in the same PR as the migration.

## Related

- **AGENTS.md** — "Wire shapes live in `@hashhive/shared` as `z.infer` from Zod schemas" and "All three surfaces are route-as-spec via `@hono/zod-openapi`."
- [`docs/solutions/conventions/shared-zod-openapi-wire-contract-mirror-2026-05-25.md`](./shared-zod-openapi-wire-contract-mirror-2026-05-25.md) — the parent triple-sync convention, now superseded by the route-as-spec migration.
- **Issue #161 / PR landing this convention** — closes the original DoD gaps on `/stats` and ships `/stats` as the worked example.
- **`packages/frontend/src/lib/event-routing.ts`** (the `projectInvalidationKeys` map) — the central invalidation map. Read this before proposing any new event type for a dashboard freshness story.
