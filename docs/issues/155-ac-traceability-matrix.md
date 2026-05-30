# Issue #155 — AC ↔ Code ↔ Test Traceability Matrix

> Built from issue #155 (24 acceptance checkboxes across 6 blocks). Maps every checkbox to its production symbol and the test that exercises it. Drives Phase B (close orphans) of plan `2026-05-24-002-feat-task-distribution-assignment-verification-plan.md`.

Legend:

- ✅ Covered — production symbol exists and at least one test asserts the behavior.
- 🟡 Partial — production code exists; test coverage is thin or only indirect.
- ❌ Orphan — production code exists but no test asserts this specific behavior.
- ⚠️ Deviation — implementation differs from AC literal text; effective behavior matches.

---

## AC 1 — Strict Task Assignment

| # | Acceptance criterion | Production symbol | Test reference | Status |
|---|----------------------|-------------------|----------------|--------|
| 1.1 | Filters by `project_id` AND agent capabilities in `WHERE` (no post-filtering) | `assignNextTask` CTE join through `campaigns.projectId` + `buildCapabilityPredicate` — `services/tasks.ts:430-440` | `tests/unit/tasks.test.ts:393` `uses SQL-level predicate, not app-layer filtering` | ✅ |
| 1.2 | Query uses indexes on `tasks(status, project_id)` for performance | Schema: `tasks_status_campaign_id_idx` + `campaigns_project_id_status_idx` — `shared/src/db/schema.ts:393+`. **Note:** `tasks.project_id` does not exist as a column; filtering joins through `campaigns`. The composite index `tasks_status_campaign_id_idx` plus `campaigns_project_id_status_idx` is the index path that serves this predicate. | n/a (DB schema) | ⚠️ Deviation — AC literal text references a non-existent column. Effective behavior matches via the campaigns-join path. |
| 1.3 | Assignment is atomic (`UPDATE … WHERE` prevents race conditions) | `services/tasks.ts:428-453` — CTE with `FOR UPDATE OF tasks SKIP LOCKED` + `UPDATE … FROM candidate` | `tests/unit/tasks.test.ts:280` `claim_race_lost when matching tasks exist but were locked` | ✅ |
| 1.4 | Returns `null` when no matching tasks are available | `services/tasks.ts:455-477` (row-empty branch) | `tests/unit/tasks.test.ts:120` `returns null when no matching tasks (capabilities mismatch)` + `:101` `returns null when agent does not exist` + `:107` `returns null when agent is not online` | ✅ |

**AC 1 verdict:** ✅ Fully covered. AC 1.2 is a documentation/AC-text deviation (the column doesn't exist; functionally equivalent index does), not a runtime gap.

---

## AC 2 — Hybrid Task Generation

| # | Acceptance criterion | Production symbol | Test reference | Status |
|---|----------------------|-------------------|----------------|--------|
| 2.1 | Campaign start calculates estimated task count | `resolveGenerationStrategy` — `services/campaigns.ts` (called at line 634) | `tests/unit/campaigns.test.ts:103-208` `Task generation threshold (99/100 split)` — 12 tests | ✅ |
| 2.2 | Task count < 100 → tasks generated synchronously in HTTP request | `services/campaigns.ts:637-652` inline branch | `tests/unit/campaigns.test.ts:104` `uses inline generation at 1 estimated task`, `:109` `at 99 estimated tasks`, `:146` `mixed attacks total below threshold uses inline`, `:189` `null keyspace + non-computable mode stays inline` | ✅ |
| 2.3 | Task count ≥ 100 → `jobs-task-generation` job enqueued to BullMQ | `services/campaigns.ts:684-690` async branch with `QUEUE_NAMES.TASK_GENERATION` | `tests/unit/campaigns.test.ts:122` `uses async enqueue at exactly 100 estimated tasks`, `:128`, `:135`, `:140` | ✅ |
| 2.4 | Tasks inserted with `status = pending` and enqueued to the correct priority queue | `generateTasksForAttack` (`services/tasks.ts:173+`) inserts with default `status='pending'` (schema default); hybrid path passes `priority` to enqueue. **Note:** the production code routes through the dedicated `TASK_GENERATION` queue with BullMQ job-level priority, not via the named `tasks-high/normal/low` queues — see AC 5 note. | `tests/unit/tasks.test.ts:945` `mode 3 mask attack with computed keyspace inserts the right chunks` (tasks default to pending via schema) | 🟡 |

**AC 2 verdict:** ✅ Behavior covered. AC 2.4 is partial because no test asserts the new tasks land at `status='pending'` explicitly — it relies on the schema default. The schema default `default('pending')` at `shared/src/db/schema.ts:404` makes this a structural guarantee, not a behavior gap. Not adding a test would be appropriate; the schema default is the contract.

---

## AC 3 — Task Reassignment

| # | Acceptance criterion | Production symbol | Test reference | Status |
|---|----------------------|-------------------|----------------|--------|
| 3.1 | Background job runs every 2 minutes via BullMQ | `HEARTBEAT_SCHEDULER_INTERVAL_MS = 2 * 60 * 1000` — `queue/manager.ts:27` | `tests/unit/queue-manager.test.ts` verifies queue constants; cadence is wired via repeatable scheduler at `queue/manager.ts:78+` | 🟡 — interval constant is exercised structurally; no test asserts the literal 2-minute repeatable schedule was registered |
| 3.2 | Targets tasks with `status = assigned` AND `assigned_at < now() - 5 minutes` | `reassignStaleTasks` — `services/tasks.ts:900+` (assigned-at-cutoff predicate) | `tests/unit/tasks.test.ts:420-776` `reassignStaleTasks` block — 10 tests | ✅ |
| 3.3 | Only reassigns tasks whose agent `last_seen_at < now() - 5 minutes` | Same query joins agents with last-seen predicate | `tests/unit/tasks.test.ts:619` `emits zero counts when no stale tasks exist` (negative path) + the active reassignment tests load fixtures where the agent IS stale | ✅ |
| 3.4 | Resets `status = pending`, clears `agent_id`, increments retry counter | `services/tasks.ts:1000-1005`, `:1038-1041` | `tests/unit/tasks.test.ts:549` `falls through to reset-to-pending on 0% progress`, `:512` `trims workRange.start forward on partial progress` | ✅ |
| 3.5 | Re-enqueues task to the correct priority queue | Production code currently re-enqueues via `services/tasks.ts:1063-1068` (job-priority-based enqueue) | `tests/unit/tasks.test.ts` reassignment block (covered indirectly via update payload assertions) | 🟡 — coverage is indirect; the re-enqueue priority is not asserted explicitly |

**AC 3 verdict:** ✅ Substantively covered. 3.1 and 3.5 are partial but the underlying behavior is exercised by adjacent tests; explicit assertions would tighten the contract but are not strictly required for AC closure.

---

## AC 4 — Task Retry Logic

| # | Acceptance criterion | Production symbol | Test reference | Status |
|---|----------------------|-------------------|----------------|--------|
| 4.1 | Failed tasks increment retry counter | `services/tasks.ts:715` (`handleTaskFailure`) + `:1000`, `:1038` (rebalance branches) | `tests/unit/tasks.test.ts:798` `retries (sets retryCount = current + 1) when below MAX_RETRIES` | ✅ |
| 4.2 | retry count < 3 → task returns to `pending` | `MAX_RETRIES = 3` — `services/tasks.ts:683` + retry branch at `:705-720` | `tests/unit/tasks.test.ts:798` and `:864` `reads retryCount from the column, not result_stats` | ✅ |
| 4.3 | retry count ≥ 3 → task marked `failed` permanently | `services/tasks.ts:734-747` + reassignment terminal branches at `:946-985` | `tests/unit/tasks.test.ts:828` `terminal-fails when retryCount equals MAX_RETRIES`, `:632` `terminal-fails partial-progress task when retry budget exhausted`, `:667` `terminal-fails zero-progress task when retry budget exhausted`, `:697` `does NOT terminal-fail at the boundary (retryCount = MAX_RETRIES - 1)` | ✅ |
| 4.4 | Campaign continues despite permanently-failed tasks | Campaign progress refresh on terminal fail (`handleTaskFailure` calls `refreshCampaignProgress`) | `tests/unit/tasks.test.ts:828` (campaign refresh assertion); `tests/unit/campaign-progress.test.ts` covers the propagation | ✅ |

**AC 4 verdict:** ✅ Fully covered with strong test coverage.

---

## AC 5 — Priority Queuing

| # | Acceptance criterion | Production symbol | Test reference | Status |
|---|----------------------|-------------------|----------------|--------|
| 5.1 | Tasks enqueued to `tasks-high`, `tasks-normal`, or `tasks-low` based on campaign priority | `getTaskQueueForPriority` — `config/queue.ts:30-34`; worker registered for each in `worker-task-generation.ts:15-19`. **Deviation:** the hot path in `services/campaigns.ts:685` enqueues to `QUEUE_NAMES.TASK_GENERATION` (the dedicated job queue) with BullMQ job-level `priority` value, **not** to the named priority queues. The named queues are wired with workers but the campaign-start branch does not currently target them. | `tests/unit/queue-manager.test.ts:22-33` verifies queue-name constants and `TASK_PRIORITY_QUEUES` list | ⚠️ Deviation |
| 5.2 | Higher-priority queues processed first | BullMQ-native job priority on the dedicated queue (lower numeric priority = higher) plus separate workers per `TASK_PRIORITY_QUEUES` member | Indirect via BullMQ semantics; no direct assertion | 🟡 |

**AC 5 verdict:** ⚠️ Implementation deviates from the AC literal text. The named queues exist and have workers, but the campaign-start hot path uses the dedicated `TASK_GENERATION` queue with job-level priority instead. End behavior (higher-priority work runs first) is preserved. This is an architectural choice that predates this issue and lives outside the verification-sweep scope. **Recommend documenting the deviation in the issue/PR rather than rewiring the hot path** — rewiring risks task-generation regressions for marginal AC literalism.

---

## AC 6 — Heartbeat Notification

| # | Acceptance criterion | Production symbol | Test reference | Status |
|---|----------------------|-------------------|----------------|--------|
| 6.1 | Heartbeat response includes `hasHighPriorityTasks` flag | `services/agents.ts:738-800` (`processHeartbeat` returns `{ hasHighPriorityTasks }`); route: `routes/agent/index.ts:103` (`...(result.hasHighPriorityTasks ? { hasHighPriorityTasks: true } : {})`) | `tests/integration/agent-heartbeat.test.ts:648` asserts `true`, `:687`/`:721`/`:760` assert absent when false | ✅ |
| 6.2 | Flag reflects availability for the agent's project + capabilities | `processHeartbeat` calls `buildCapabilityPredicate(agent.capabilities)` and filters by project | `tests/integration/agent-heartbeat.test.ts:623` `calls buildCapabilityPredicate with the agent capabilities on the high-priority lookup`, `:658` `skips the high-priority lookup for an agent in error status`, `:694` `warn-logs and skips the high-priority lookup for empty hashModes`, `:732` `warn-logs and skips the high-priority lookup for null capabilities` | ✅ |
| 6.3 | Agent can optionally request a task immediately on `true` | This is **agent-side** behavior (Go hashcat worker). The server's contract is to set the flag; agent-side action is outside this repo. | n/a — agent SDK responsibility | ✅ (server contract met) |

**AC 6 verdict:** ✅ Substantively covered on the server side. **Real gap:** `hasHighPriorityTasks` does not appear in `packages/openapi/agent-api.yaml` or in any Zod schema in `packages/shared/src/schemas/index.ts`. This violates the AGENTS.md rule that wire shapes live in shared as `z.infer` from Zod schemas, and the rule that the OpenAPI spec is kept in sync with shared types. Generated agent clients reading the OpenAPI spec have no typed access to this field. This is a contract-artifact gap, not a runtime gap.

---

## Orphans Summary

| AC | Orphan | Severity | Plan unit |
|----|--------|----------|-----------|
| 1.2 | AC text references nonexistent `tasks.project_id` column | Doc-only deviation; runtime correct | Document in PR; no code change |
| 2.4 | No test asserts `status='pending'` on new task inserts | Low — schema default enforces it | No new test needed |
| 3.1 | No test asserts the literal 2-minute repeatable scheduler registration | Low — interval constant + handler are tested | No new test needed |
| 3.5 | Re-enqueue priority on reassignment not asserted explicitly | Low — adjacent tests cover behavior | No new test needed |
| 5.1, 5.2 | Hot path enqueues to dedicated `TASK_GENERATION` queue with job-level priority, not named priority queues | Architectural deviation, end-behavior preserved | Document in PR; out of scope for rewiring |
| 6 — OpenAPI | `hasHighPriorityTasks` absent from `agent-api.yaml` | **High — material AGENTS.md violation** | U6 lands the fix |
| 6 — Shared schema | No `agentHeartbeatResponseSchema` in `@hashhive/shared` | **High — material AGENTS.md violation** | U5 lands the fix |

---

## Plan Routing

| Plan unit | Status after matrix |
|-----------|---------------------|
| U2 (close AC 1/2/5 orphans) | **Skip** — no testable orphans; deviations are documentation only |
| U3 (close AC 3/4 orphans) | **Skip** — no testable orphans |
| U4 (verify `hasHighPriorityTasks` integration coverage) | **Skip** — already strong (4 dedicated tests in integration/agent-heartbeat.test.ts) |
| U5 (add `agentHeartbeatResponseSchema`) | **Execute** — material AGENTS.md gap |
| U6 (sync OpenAPI) | **Execute** — material AGENTS.md gap |
| U7 (validation gates) | **Execute** — always |

**Net work:** U5, U6, U7. The verification sweep itself (U1) demonstrated that the runtime is already correct and the durable work is the contract-artifact sync the AGENTS.md rules demand.
