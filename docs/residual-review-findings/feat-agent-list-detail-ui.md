# Residual Review Findings — feat/agent-list-detail-ui

Source: ce-code-review autofix run `20260515-093833-4054eac3` plus follow-up multi-agent PR review against branch `feat/agent-list-detail-ui` (base `main`, merge-base `ab18079`).

## Status: all valid findings resolved

All actionable residuals have been addressed in this PR. The full audit trail
and the original 9 deferred items live in earlier commits; this file is kept
as a stub so consumers searching `docs/residual-review-findings/` see that the
audit ran and resolved cleanly.

Closed in this PR:
- **R1 / P1 — Backend service-level tests.** Extracted `classifyRecentErrors`,
  `classifyWorstSeverity`, `pickCurrentTaskByAgent` (services/agents.ts) and
  `projectAgentTaskRows` (services/tasks.ts) as pure helpers; added 20 unit
  tests in `packages/backend/tests/unit/agents-service.test.ts`. Also added
  `packages/backend/tests/unit/dashboard-agents-routes.test.ts` covering the
  cross-project 404 boundary on `/agents/:id/tasks`.
- **R2 / P2 — Composite `(agent_id, created_at desc)` index.** Schema updated
  in `packages/shared/src/db/schema.ts` and migration `0006_agent_errors_composite_index.sql`
  drops the single-column index and creates the composite.
- **R3 / P2 — Control API OpenAPI doc.** `packages/openapi/control-api.yaml`
  now defines `AgentListItem` and references it from the `/agents` 200
  response.
- **R4 / P2 — WS invalidation by `payload.agentId`.** `emitTaskUpdate` now
  carries `agentId`; the client invalidates `[prefix, agentId]` instead of
  prefix-only, so fleet-wide events no longer fan out into every cached
  agent detail.
- **R5 / P3 — Shared types.** `AgentWorstSeverity`, `AgentCurrentTask`, and
  `AgentTaskSummary` live in `@hashhive/shared`; backend and frontend now
  import from the single source of truth.
- **R6 / P3 — `#errors` hash auto-scroll.** Added a `useLocation`-driven
  `useEffect` in `pages/agent-detail.tsx` that scrolls the target into view.
- **R7 / P3 — HardwareProfileCard field provenance.** Documented the canonical
  vs legacy field-name pairs (`totalMb` vs `total`, `memoryMb` vs `memory`,
  `driver` vs `driverVersion`) with the rationale for keeping both variants.
- **R8 / P3 — Row click + Details link dual affordance.** Resolved by making
  the agent name a real anchor and dropping the row-level `role="link"`
  pattern and the duplicate `Details` cell.
- **R9 / P3 — Two `useEvents()` callers opening two WS connections.** Hoisted
  to a single `<EventsProvider>` at the layout root; sidebar / dashboard /
  agent-detail now read via `useEventsConnection()` so the whole authenticated
  tree shares one WebSocket.
