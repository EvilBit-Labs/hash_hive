---
date: 2026-05-29
topic: dashboard-stats-and-read-endpoint-contract
---

# Dashboard Stats Endpoint + Dashboard Read-Endpoint Contract (Issue #161)

## Summary

Close the dashboard stats endpoint (issue #161) as the **exemplar instance** of a documented dashboard read-endpoint contract. The route, mount, RBAC, and frontend hook already exist in code; the work establishes the four-pillar Definition of Done — shared Zod schema as source of truth, `z.infer` wire type exported from `@hashhive/shared`, OpenAPI documented in `packages/openapi/dashboard-api.yaml`, integration tests for project-scoped correctness — and adds one new realtime piece: a project-scoped `dashboard_stats_changed` event that fires alongside existing status-change publishers so the stats card stays fresh without bespoke per-card polling.

The contract section in this doc is short and prescriptive. Other dashboard read endpoints currently violating it (inline-typed hooks, undocumented OpenAPI surfaces) are noted as known debt but are **not** backfilled here — they pick up the contract opportunistically when next touched.

---

## Problem Frame

`packages/backend/src/routes/dashboard/stats.ts` exists, is mounted at `/api/v1/dashboard/stats`, is guarded by `requireSession` + `requireProjectAccess()`, and returns four aggregate counts (agents, campaigns, tasks, cracked hashes). `packages/frontend/src/hooks/use-dashboard.ts` already consumes it via `useDashboardStats()` with a 30-second `refetchInterval`. AC1–AC4 from the source ticket (`spec/tickets/Dashboard_Stats_API_Endpoint_(GET__api_v1_dashboard_stats).md`) are satisfied in code but not in the supporting artifacts that AGENTS.md treats as the real Definition of Done.

Four gaps remain:

1. **No tests.** No `tests/routes/dashboard/stats.*` exists. Project-scoping correctness — the AC3 "no leakage" guarantee — is untested and would only fail in production.
2. **No OpenAPI entry.** `packages/openapi/dashboard-api.yaml` does not document `/stats` or a `DashboardStats` schema. Generated clients (Control CLI today, planned TUI) cannot discover the endpoint from the spec.
3. **Wire shape declared in the wrong place.** `DashboardStats` is hand-declared as an `interface` in `packages/frontend/src/hooks/use-dashboard.ts` (line 30), violating the AGENTS.md rule that wire shapes live in `@hashhive/shared` as `z.infer` from a Zod schema. If the backend ever changes the shape, only runtime drift will catch it.
4. **Status mapping is structurally lossy.** The route builds `Record<string, number>` from grouped query results, then reads known keys with `??  0`. If a new agent/campaign/task status enum value is added (e.g., `'cancelled'`), it lands in the `Record` but is never read into the response, so it silently disappears from the dashboard.

Separately, the upcoming Dashboard & Real-Time Monitoring UI work (BACKLOG step 7) wants WebSocket-driven freshness with polling fallback. Stats today polls every 30s with no event invalidation. The realtime stream (`packages/frontend/src/hooks/use-events.ts`, server `/api/v1/dashboard/events/stream`) carries `agent_status_changed`, `campaign_status`, `task_update`, and `hash_cracked` events that already cover every aggregate the stats endpoint computes — but the stats query is not currently wired to invalidate on any of them.

These gaps are not unique to `/stats`. The same pattern (inline-typed hook, undocumented OpenAPI, no tests, no realtime invalidation) repeats across at least five other dashboard read endpoints. Closing them all in one change is bigger than this brainstorm chose to scope; documenting the contract once and applying it to `/stats` as the exemplar lets future endpoints pick it up at lower cost.

---

## Actors

- **A1. Operator (dashboard user).** Logged-in HashHive operator viewing the dashboard. Sees stats refreshed live when underlying agents/campaigns/tasks/hashes change, with no perceptible lag from a 30s poll interval.
- **A2. Future dashboard-endpoint author.** Engineer adding or modifying a dashboard read endpoint. Has a single short contract doc to follow that names the four required artifacts and points at one working exemplar.
- **A3. Generated-client consumer.** Control CLI today, planned TUI tomorrow. Discovers `/stats` from `packages/openapi/dashboard-api.yaml` and consumes it via generated types that match the backend response exactly.

---

## Key Flows

- **F1. Operator opens dashboard.** Frontend mounts `useDashboardStats()`, which fetches `GET /api/v1/dashboard/stats` keyed by `selectedProjectId`. The four stat cards render aggregate counts for the selected project.
- **F2. Underlying state changes during the session.** An agent status flips, a campaign starts, a task completes, or a hash is cracked. The backend publishes its existing event (`agent_status_changed`, `campaign_status`, `task_update`, `hash_cracked`) AND a new `dashboard_stats_changed` event scoped to the same project. The frontend hook invalidates the `['dashboard-stats', projectId]` query key on receipt; React Query coalesces repeated invalidations into a single refetch.
- **F3. Future engineer adds a new dashboard read endpoint.** They read `docs/solutions/dashboard-read-endpoint-contract.md` (created by this work), follow the four-pillar checklist, look at `/stats` as the worked example, and ship without re-deriving the conventions.

---

## Requirements

**Stats endpoint correctness (closing AC1–AC4 with test coverage)**

- R1. `GET /api/v1/dashboard/stats` requires a valid BetterAuth session. Unauthenticated requests return 401 via the existing `requireSession` middleware.
- R2. The endpoint requires a project context on the session. Sessions without `projectId` return 400; sessions whose user is not a member of `session.projectId` return 403. Both behaviors come from the existing `requireProjectAccess()` middleware and are pinned by tests.
- R3. The response payload contains the four card aggregates: `agents` (`total`, `online`, `offline`, `error`), `campaigns` (`total`, `draft`, `running`, `paused`, `completed`), `tasks` (`total`, `pending`, `running`, `completed`, `failed`), and `cracked` (`total`). Counts are computed by aggregate SQL — no N+1 loops.
- R4. All counts reflect only data scoped to `session.projectId`. No cross-project leakage. The agent/campaign aggregations filter on `projectId` directly; the task and cracked-hash aggregations join through `campaigns` to enforce project scope.

**Shared types and structural status mapping**

- R5. The response shape is defined as a Zod schema (`dashboardStatsSchema`) in `packages/shared/src/schemas/`. The schema uses literal unions (not `z.record(z.string(), z.number())`) for each status field, so unknown status values cause a parse failure rather than silent omission.
- R6. The wire type is exported from `packages/shared/src/types/` as `DashboardStats = z.infer<typeof dashboardStatsSchema>`. The frontend hook imports it from `@hashhive/shared`; the local `interface DashboardStats` in `packages/frontend/src/hooks/use-dashboard.ts` is removed.
- R7. The route builds its response from the schema's known status literals rather than `Record<string, number>`. Mapping is exhaustive against the schema, not against whatever statuses the database happens to return. If a new status literal is added to the schema, the route fails to type-check until the mapping is updated.

**OpenAPI documentation**

- R8. `packages/openapi/dashboard-api.yaml` documents `GET /stats` with the cookie session security scheme, the standard 200/400/401/403 responses keyed to the dashboard error envelope (`{ error: { code, message } }`), and a `DashboardStats` component schema that mirrors `dashboardStatsSchema` field-for-field.
- R9. The OpenAPI ↔ shared parity contract test is extended to cover `DashboardStats`, so any future divergence between `packages/openapi/dashboard-api.yaml` and `packages/shared/src/schemas/` fails CI rather than shipping silently.

**Realtime invalidation (`dashboard_stats_changed`)**

- R10. The backend publishes a new event type `dashboard_stats_changed` on the existing `/api/v1/dashboard/events/stream` channel. The event is project-scoped (delivered to subscribers whose session `projectId` matches) and signal-only — the payload carries `{ type: 'dashboard_stats_changed', projectId: number }` with no embedded aggregate values. Subscribers refetch to learn the new counts.
- R11. `dashboard_stats_changed` fires from the same call sites that already publish `agent_status_changed`, `campaign_status`, `task_update`, and `hash_cracked`. It fires *in addition to* those events, not instead of them — existing subscribers are unaffected.
- R12. The frontend's `useEvents` hook adds `dashboard_stats_changed` to its known event types and invalidates the `['dashboard-stats', projectId]` query key on receipt. React Query coalesces repeated invalidations into a single refetch via its built-in dedupe.
- R13. The stats hook's `refetchInterval` increases from 30s to 60s as a polling-fallback floor, since the primary freshness signal is now the event. The interval becomes the safety net for periods when the WebSocket is down.

**Dashboard read-endpoint contract (the pattern section)**

- R14. A short contract doc is written to `docs/solutions/dashboard-read-endpoint-contract.md` enumerating the four required artifacts (shared Zod schema, OpenAPI entry, integration test, realtime invalidation hook), naming the canonical file locations, and pointing at `/stats` as the worked example. The doc explicitly notes that existing endpoints predating this contract are tracked as opportunistic debt, not retroactive work.
- R15. The contract doc names a single rule for endpoints whose response shape includes enum-keyed counts: status literals must be modeled as a Zod literal union in the schema, never as `Record<string, number>` in the route. This is the structural fix for the silent-status-drop bug class.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R4.** Given an authenticated operator who is a member of both project A and project B, with `session.projectId = A`, when they `GET /api/v1/dashboard/stats`, the response returns counts that include only project A's agents, campaigns, tasks, and cracked hashes. Repeating the call after `POST /projects/select { projectId: B }` returns counts that include only project B's data. The same hash that exists in both projects appears only once in each project's `cracked.total`.
- AE2. **Covers R3.** Given a project with 3 online agents, 1 offline agent, 0 errored agents, 2 running campaigns, 5 completed tasks, and 7 cracked hashes, the response is `{ agents: { total: 4, online: 3, offline: 1, error: 0 }, campaigns: { total: 2, ..., running: 2 }, tasks: { total: 5, ..., completed: 5 }, cracked: { total: 7 } }`. Missing status keys default to `0`.
- AE3. **Covers R5, R7.** Given a hypothetical future migration that adds `'cancelled'` to the `tasks.status` enum without updating `dashboardStatsSchema`, a row with `status = 'cancelled'` in the database causes `dashboardStatsSchema.parse()` (or the equivalent type-checked construction) to fail. The endpoint does not return a response that silently omits the cancelled count.
- AE4. **Covers R6.** Given a developer who runs `bun --filter @hashhive/frontend tsc`, the type-check passes because `use-dashboard.ts` imports `DashboardStats` from `@hashhive/shared`. Removing the local `interface DashboardStats` block from `use-dashboard.ts` causes no type errors anywhere in the frontend.
- AE5. **Covers R8, R9.** Given a developer who edits `dashboardStatsSchema` to add a new field but forgets to update `packages/openapi/dashboard-api.yaml`, the OpenAPI ↔ shared parity contract test fails with a message naming the divergent field. CI does not merge the change.
- AE6. **Covers R10, R11, R12.** Given an operator viewing the dashboard with the WebSocket open, when an agent in their selected project transitions from `online` to `offline`, the backend publishes both `agent_status_changed` and `dashboard_stats_changed` (in that order or in either order — clients tolerate both). The frontend invalidates `['dashboard-stats', projectId]` on receipt of the stats event, refetches `/stats`, and the agent card updates within one network round-trip. Operators in *other* projects do not receive the event.
- AE7. **Covers R12.** Given a campaign whose 50 tasks all transition from `pending` to `running` within one second, the backend publishes 50 `task_update` events and 50 `dashboard_stats_changed` events. The frontend invalidates the stats query 50 times but issues only one refetch to `/stats` because React Query coalesces invalidations during an in-flight refetch.
- AE8. **Covers R14, R15.** Given a future engineer adding `GET /api/v1/dashboard/agents/{id}/utilization`, they read `docs/solutions/dashboard-read-endpoint-contract.md`, copy the four-artifact checklist, find `/stats` as the worked example, and ship the new endpoint with a shared schema, OpenAPI entry, integration test, and (if applicable) realtime invalidation hook. They do not declare an inline `interface` in the consuming hook.

---

## Dashboard Read-Endpoint Contract (pattern, codified)

This is the substance that will be written to `docs/solutions/dashboard-read-endpoint-contract.md` per R14. Captured here so reviewers can validate it in the same artifact as the requirements.

**Every dashboard read endpoint (`/api/v1/dashboard/*` GET) ships with all four of:**

1. **Shared Zod schema.** Response shape defined in `packages/shared/src/schemas/<endpoint>.ts` as a Zod schema. Enum-keyed fields (status counts, kind buckets) use Zod literal unions, never `z.record(z.string(), ...)`. Type exported from `packages/shared/src/types/index.ts` as `<ShapeName> = z.infer<typeof <shapeName>Schema>`.
2. **OpenAPI entry.** Path and `<ShapeName>` component schema in `packages/openapi/dashboard-api.yaml`, mirroring the shared schema field-for-field. Covered by the OpenAPI ↔ shared parity contract test.
3. **Integration test.** `packages/backend/tests/routes/dashboard/<endpoint>.test.ts` covering: (a) 401 unauthenticated, (b) 400 missing project context, (c) 403 non-member, (d) project-scoped correctness with at least two projects seeded, (e) schema conformance via `<shapeName>Schema.parse()`. AAA structure; integration-test posture per AGENTS.md.
4. **Realtime invalidation hook (when freshness matters).** If the endpoint backs a live dashboard surface, the backend publishes `dashboard_<surface>_changed` from the same call sites that already publish the underlying status-change events; the frontend hook adds the event type to `useEvents` and invalidates the matching query key. Signal-only payload — `{ type, projectId }`. Polling becomes the fallback at a 60s floor, not the primary signal.

**Routing in the route handler:** never map enum-keyed counts via `Record<string, number>` + `??  0`. Build the response from the schema's literal union so unknown values surface as type errors or parse failures, not silent drops.

**Existing endpoints predating this contract** are tracked as known debt in [GOTCHAS.md](GOTCHAS.md) or BACKLOG, not retroactively migrated. They pick up the contract when next touched for behavioral reasons.

---

## Scope Boundaries

**In scope**

- The stats endpoint's full DoD trail (shared schema, OpenAPI, tests, realtime invalidation).
- The new `dashboard_stats_changed` event type plumbed through the existing events stream infrastructure.
- The contract doc at `docs/solutions/dashboard-read-endpoint-contract.md`.
- The OpenAPI ↔ shared parity test extension covering `DashboardStats`.
- Tightening the route's status-enum mapping per R7.

**Out of scope (deferred to follow-up work)**

- Tests, OpenAPI entries, and shared types for *other* dashboard endpoints (agents, results, hashes, health, tasks, crackers, attack-templates). Known debt; tracked as separate tickets; backfilled opportunistically when each endpoint is next touched.
- Migration of the 25+ inline-declared interfaces across `use-campaigns.ts`, `use-resources.ts`, `use-crackers.ts`, `use-results.ts`, `use-events.ts` into `@hashhive/shared`. Same opportunistic-backfill rule.
- Cracked-hash "crack rate" computation (cracked / total hash-list items). Source ticket calls it optional; adds a per-campaign hash-list-totals query without a clear product driver.

**Outside this work's identity**

- Per-agent or per-campaign analytics dashboards. Different surface.
- Time-series, trend charts, historical stats. Different data model and different product question.
- A single `/dashboard/snapshot` mega-endpoint or a tRPC/typed-RPC rework of the dashboard API. Considered and rejected when scoping this brainstorm; out-of-scope here and in any future iteration of this contract — the read surface stays per-resource REST.
- Rework of the events stream architecture itself (transport, fan-out, persistence). The new event piggybacks on existing infrastructure unchanged.
- Backfilling tests for other already-shipped dashboard surfaces in this PR. They are out of scope for issue #161's blast radius.

---

## Key Decisions

- **D1. The DoD trail is established here for `/stats`, not for the broader dashboard surface.** Closing `/stats` correctly with the four pillars demonstrates the pattern; backfilling six other endpoints in one PR is a phase of work that doesn't fit in #161. Other endpoints adopt the contract opportunistically.
- **D2. New `dashboard_stats_changed` event, signal-only, project-scoped.** Picked over (a) invalidating on existing `agent_*`/`campaign_*`/`task_*`/`hash_cracked` events directly (couples every consumer to the full event-type inventory of the underlying data model) and (b) keeping pure polling (leaves the cards lagging up to 30s). Signal-only payload keeps publishers loosely coupled and lets React Query's natural invalidation coalescing handle high-frequency emit storms.
- **D3. Event emission is colocated with existing publishers.** A new `publishDashboardStatsChanged(projectId)` helper is called from the same handlers that today call the existing `publishEvent` for status changes and hash cracks. Rejected alternative: a centralized DB-write aggregator. Colocation matches the existing event-publish pattern in the codebase and avoids new infrastructure.
- **D4. Status literals live in the Zod schema, not the route.** Route maps grouped query results into the schema's known literal union, so unknown values surface as type errors or parse failures. Closes the silent-drop bug class structurally rather than per-endpoint.
- **D5. Polling stays as fallback at a 60s floor.** Halved from today's 30s because the event is now primary, but kept long enough to provide real safety net coverage when the WebSocket is down. Removing polling entirely would leave operators without freshness during connection drops.
- **D6. Contract enforcement is lightweight.** A docs/solutions/ entry + extending the existing OpenAPI ↔ shared parity contract test for `DashboardStats`. Rejected alternative: a per-endpoint contract-test scaffold generator. The codebase already follows the parity-test pattern; one more entry costs less than a generator and provides the same protection at the contract surface that actually breaks consumers.

---

## Dependencies

- **#158 (WebSocket Realtime Infrastructure).** Defines the events stream behavior the new `dashboard_stats_changed` event rides on. Requires R7 (server-managed session projectId) and R8 (project-scoped client filtering) to deliver the new event to the right operator. Soft dependency — if #158 is in-flight, this work proceeds against the current stream behavior and inherits the hardening once it lands.
- **#159 (Server-managed projectId on BetterAuth session).** Already shipped (commit `fe57f13`). `requireProjectAccess()` reads `session.projectId`. No additional work required.
- **Existing event-publish call sites.** `dashboard_stats_changed` emission attaches to the same handlers that already publish `agent_status_changed`, `campaign_status`, `task_update`, `hash_cracked`. No new triggers, no new schedulers.
- **OpenAPI ↔ shared parity test.** Already exists per AGENTS.md ("contract test in the same change — generated clients rely on the spec, not the TypeScript type"). Extended with one more shape, not introduced.

---

## Open Questions

- **Q1. Should `dashboard_stats_changed` debounce on the backend, or rely entirely on React Query's frontend coalescing?** Leaning entirely-frontend — debouncing on the backend adds state, frontend coalescing is already battle-tested in the codebase via TanStack Query's `dedupingInterval`. Decided at plan time; not a product question.
- **Q2. Should the contract doc go in `docs/solutions/` (matches the AGENTS.md "documented solutions" pointer) or `docs/conventions/` (clearer "this is a rule")?** Leaning `docs/solutions/` because the AGENTS.md frontmatter (`module`, `tags`, `problem_type`) already provides discoverability and no `docs/conventions/` directory exists today. Decided at plan time.
- **Q3. Does the contract doc apply to the agent API and control API too, or strictly to dashboard reads?** Strictly dashboard reads — the agent API has different conventions (Bearer token, agent-specific shapes) and the control API has its own contract (RFC 9457, `cst_*` keys). The doc title should make the scope explicit so it isn't quietly applied where it doesn't fit.

---

## References

- **Issue #161** — Phase 1 / Track 4 / Step 7: Dashboard Stats API Endpoint.
- **Source ticket** — `spec/tickets/Dashboard_Stats_API_Endpoint_(GET__api_v1_dashboard_stats).md`.
- **Adjacent brainstorm** — [`docs/brainstorms/2026-05-25-websocket-realtime-infrastructure-requirements.md`](./2026-05-25-websocket-realtime-infrastructure-requirements.md) (#158): defines the events stream this work plugs into.
- **AGENTS.md** — wire-shapes-in-shared rule, OpenAPI-in-same-change rule, validation gate (`just check`, `just ci-check`).
- **Existing exemplar** — `packages/backend/src/routes/dashboard/stats.ts`, `packages/backend/src/index.ts` (mount), `packages/frontend/src/hooks/use-dashboard.ts:30` (the `DashboardStats` interface to be removed), `packages/openapi/dashboard-api.yaml` (where `/stats` will be added), `packages/frontend/src/hooks/use-events.ts` (where `dashboard_stats_changed` is added to known event types).
- **BACKLOG.md** — step 7 (Dashboard & Real-Time Monitoring UI) consumes this endpoint and inherits its freshness model.
