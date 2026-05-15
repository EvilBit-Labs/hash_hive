# Residual Review Findings — feat/agent-list-detail-ui

Source: ce-code-review autofix run `20260515-093833-4054eac3` against branch `feat/agent-list-detail-ui` (base `main`, merge-base `ab18079`). 8 reviewers dispatched in parallel; 11 safe_auto fixes applied; 9 findings deferred. Tracker filing was not invoked (autonomous LFG pass; no_sink for this run — these findings are durable here and in the PR body).

## Residual Review Findings

- **[P1][manual → downstream-resolver] packages/backend/tests/unit/ — Backend U1/U2 test coverage missing**
  - Reviewer: testing (T1, T2). Security review also flagged the cross-project boundary as untested.
  - `aggregateRecentErrors`, `fetchCurrentTasks`, `listTasksByAgent`, and the new `GET /dashboard/agents/:id/tasks` route ship without backend tests. The existing backend test pattern is mock-heavy; no service-level integration harness for agents exists today. Needs a deliberate decision: add a DB-backed integration test fixture, expand the mocked patterns, or accept the gap.

- **[P2][gated_auto → downstream-resolver] packages/shared/src/db/schema.ts:174 — Composite (agent_id, created_at) index on agent_errors**
  - Reviewer: performance (perf-2).
  - The 24h-window aggregate filters by `agent_id IN (...) AND created_at >= now() - interval '24 hours'` on every list response. Without `created_at` in the index, Postgres heap-fetches all historical errors for the listed agents to apply the time filter. Add a composite index `(agent_id, created_at desc)` via a new Drizzle migration; the existing `agent_errors_agent_id_idx` is subsumed and should be dropped.

- **[P2][manual → downstream-resolver] packages/openapi/control-api.yaml — Control API leaks UI-only enrichments without OpenAPI docs**
  - Reviewer: api-contract (api-contract-1, api-contract-2).
  - The shared `listAgents` service now enriches every row with `errorCount24h`, `worstSeverity24h`, and `currentTask`. Those fields also ship in `/api/v1/control/agents` responses. Two paths: (a) document the new fields in `control-api.yaml`, or (b) gate enrichment behind a flag passed only from the dashboard route so the Control API stays lean.

- **[P2][manual → downstream-resolver] packages/frontend/src/hooks/use-events.ts:139 — WS broadcast over-fires invalidation**
  - Reviewer: correctness ("broad-invalidation-over-fires"), adversarial ("broad task_update invalidation amplifies").
  - Every `agent_status` / `task_update` event invalidates `['agent']`, `['agent-errors']`, `['agent-tasks']` regardless of which agent the event is for. Functionally correct but wasteful at scale (multiple detail tabs, high event rate). Resolution: match on `payload.data.agentId` in the invalidation handler so only the affected agent's keys are invalidated.

- **[P3][advisory → human] packages/shared/src/types/ — Cross-package type duplication for current-task / agent-task shapes**
  - Reviewer: maintainability (maint-1).
  - Backend `CurrentTaskSummary` and `AgentTaskListItem` are structurally identical to frontend `AgentCurrentTask` and `AgentTask`. The repo already shares cross-package types via `@hashhive/shared` (see `SelectAgentBenchmark`). Move these into shared to prevent drift.

- **[P3][advisory → human] packages/frontend/src/pages/agent-detail.tsx — `#errors` deep-link from row error badge does not auto-scroll**
  - Reviewer: correctness ("hash-link-no-scroll-on-row-error-badge").
  - The error badge navigates to `/agents/:id#errors`, but React Router does not handle hash scrolling. Add a `useEffect` watching `location.hash` to scroll the `#errors` section into view, or install a router-level hash-scroll handler.

- **[P3][advisory → human] packages/frontend/src/components/features/hardware-profile-card.tsx — Double-fallback hardware fields lack documented source**
  - Reviewer: maintainability (maint-2).
  - `totalMb` vs `total`, `availableMb` vs `available`, `memoryMb` vs `memory`, `driver` vs `driverVersion`. Either the agent firmware payload varies by version (document the source and the migration plan), or one variant is dead code that should be removed.

- **[P3][advisory → human] packages/frontend/src/pages/agents.tsx — Row click and Details link both navigate to same URL**
  - Reviewer: maintainability (maint-6).
  - Pick one navigation affordance. Today's pattern requires `AgentErrorBadge` to use `stopPropagation` and the row to ignore bubbled clicks/keys — a tell that nested interactives are fighting the row-click pattern.

- **[P3][advisory → human] packages/frontend/src/components/features/sidebar.tsx + packages/frontend/src/pages/agent-detail.tsx — Two useEvents() callers open two WebSocket connections per user**
  - Reviewer: adversarial (residual risk).
  - When the detail page is mounted, both sidebar and detail page run independent `useEvents` instances and open separate WebSocket connections. Polling fallback could also double up. Resolution: hoist `useEvents` to an app-level provider that exposes connection state and event callbacks via context.

## Filing status

- `filed`: (none — no issue tracker was invoked; LFG ran in autopilot)
- `failed`: (none)
- `no_sink`: all 9 findings above. Durable record is this file plus the PR body.
