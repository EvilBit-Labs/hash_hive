# Technical Spec — Issue #155: Task Distribution & Assignment

> **Source ticket:** [`spec/tickets/Task_Distribution_&_Assignment.md`](../../spec/tickets/Task_Distribution_&_Assignment.md)
> **GitHub issue:** [#155](https://github.com/EvilBit-Labs/hash_hive/issues/155)
> **Branch:** `155-featscheduler-task-distribution-assignment-...`
> **Track:** Phase 1 — Foundation, Step 1 of 11 (Scheduler)

---

## 1. Issue Summary

Land the complete assignment layer for HashHive's scheduler so campaigns actually
distribute end-to-end: strict DB-predicate task assignment, hybrid sync/async
generation, reassignment background job, retry logic, priority queuing, and a
heartbeat `hasHighPriorityTasks` flag.

## 2. Problem Statement

The original ticket called out that `assignNextTask()` selected the first globally
pending task then post-filtered for project scope and capabilities — meaning agents
saw "no task" even when their project had matching pending work.

**Current reality** (after exploration): the assignment query has already been
rewritten to use an atomic CTE with `FOR UPDATE … SKIP LOCKED`, project-scoped join,
and a capability predicate in the `WHERE` clause (`packages/backend/src/services/tasks.ts:415-454`).
Significant adjacent work has also landed:

- Capability predicate builder (`buildCapabilityPredicate`)
- Skip-reason diagnosis (`diagnoseAssignmentSkip`)
- Priority queue infrastructure (`config/queue.ts`: `TASKS_HIGH/NORMAL/LOW`)
- Heartbeat `hasHighPriorityTasks` flag (`services/agents.ts:738`, route at `routes/agent/index.ts:103`)
- Reassignment via heartbeat-monitor worker (cadence `HEARTBEAT_SCHEDULER_INTERVAL_MS = 2 min`)
- Retry ceiling `MAX_RETRIES = 3` with permanent-fail branch (`services/tasks.ts:683`)
- Hybrid inline/async generation via `resolveGenerationStrategy` (`services/campaigns.ts:638`)

This spec therefore narrows scope to **verification of every acceptance criterion**
plus closing any concrete gaps found rather than re-implementing the layer.

## 3. Technical Approach

Verify-first, fix-only-where-needed. For each AC bullet:

1. Locate the code path
2. Confirm a test exercises it
3. Patch the implementation or add a test if either is missing
4. Update OpenAPI spec when crossing the agent API boundary

Hard constraints (per `AGENTS.md`):

- Cross-API-boundary types live in `@hashhive/shared` (Zod `z.infer`)
- OpenAPI `agent-api.yaml` updated in lock-step with `hasHighPriorityTasks` shape
- Agent API is sacred — never break it for dashboard convenience
- `just check` and `just ci-check` must be green at commit time

## 4. Implementation Plan

### Phase A — Verification Sweep (read-only)

1. Map every AC checkbox in #155 to its concrete code symbol and test file.
2. Build a coverage matrix (AC ↔ code ↔ test) and list orphans.
3. Run `just test-backend -- tasks heartbeat campaigns` to confirm green.

### Phase B — Close Verified Gaps

For each orphan in the matrix:

1. Write the failing test first (TDD red).
2. Implement the minimum change to pass (green).
3. Re-run `just check`.

### Phase C — Spec & Index Sync

1. Ensure `tasks(status, project_id)` composite index exists in a Drizzle
   migration; add one if missing.
2. Verify `agent-api.yaml`'s `HeartbeatResponse` schema lists
   `hasHighPriorityTasks` as an optional boolean.
3. Run the contract test (`tests/unit/agent-api-contract.test.ts`).

### Phase D — Final Gate

1. `just check` (format, lint, type-check, build)
2. `just ci-check` (full test suite)
3. Open PR linked to #155

## 5. Test Plan

TDD discipline per `~/.claude/rules/testing.md` — every behavior gets a failing
test before any production code moves.

### Unit (bun:test, backend)

- `assignNextTask`
  - returns null when no pending task matches project + capabilities
  - assigns highest-priority task first when priorities differ
  - is race-safe under concurrent calls (mock `FOR UPDATE SKIP LOCKED`)
  - logs `agent_not_eligible` when agent status is wrong
  - logs `claim_race_lost` on diagnose-failure fallback
- `reassignStaleTasks`
  - resets `assigned` tasks whose agent is offline ≥ 5 min
  - increments `retry_count` and clears `agent_id`
  - permanently fails tasks once `retry_count ≥ MAX_RETRIES`
- `getTaskQueueForPriority` — priority value → queue name table

### Integration

- Heartbeat returns `hasHighPriorityTasks: true` when high-priority pending tasks
  exist for the agent's project + capabilities; absent (omitted) otherwise.
- Campaign start with < 100 estimated tasks generates inline; ≥ 100 enqueues to
  `jobs-task-generation` with priority mapped from campaign priority.

### Contract

- `tests/unit/agent-api-contract.test.ts` proves the heartbeat response shape
  matches `packages/openapi/agent-api.yaml`.

### Coverage gate

- ≥ 80 % per `~/.claude/rules/testing.md`; verify via `just test-backend`
  coverage output.

## 6. Files to Modify / Create

| Path | Action |
| ---- | ------ |
| `packages/backend/src/services/tasks.ts` | Verify; patch only gaps from matrix |
| `packages/backend/src/services/agents.ts` | Verify `hasHighPriorityTasks` query path |
| `packages/backend/src/services/campaigns.ts` | Verify hybrid generation branch |
| `packages/backend/src/queue/workers/heartbeat-monitor.ts` | Verify reassignment cadence |
| `packages/backend/src/config/queue.ts` | Verify priority queue mapping |
| `packages/backend/src/db/migrations/<new>.sql` | Add `tasks(status, project_id)` composite index if absent |
| `packages/openapi/agent-api.yaml` | Confirm `hasHighPriorityTasks` field in `HeartbeatResponse` |
| `packages/shared/src/schemas/index.ts` | Confirm `HeartbeatResponseSchema` carries the field |
| `packages/backend/tests/integration/agent-heartbeat.test.ts` | Extend if AC gaps found |
| `packages/backend/tests/unit/tasks.test.ts` | Extend if AC gaps found |

## 7. Success Criteria

All six AC blocks in #155 close with green tests and `just ci-check` clean:

1. **Strict assignment** — atomic `UPDATE … WHERE` with project + capability filter in `WHERE`, returns `null` on empty.
2. **Hybrid generation** — < 100 inline, ≥ 100 enqueued to `jobs-task-generation`.
3. **Reassignment** — 2-min cadence; resets `assigned`+stale tasks whose agent is offline ≥ 5 min.
4. **Retry** — `retry_count < 3` → `pending`; `≥ 3` → permanent `failed`.
5. **Priority queuing** — campaign priority → `tasks-high`/`tasks-normal`/`tasks-low`.
6. **Heartbeat flag** — `hasHighPriorityTasks` reflects pending high-priority work for the agent's scope.

Definition of done:

- `just check` green
- `just ci-check` green
- OpenAPI spec ↔ shared types ↔ contract test all in sync
- PR linked to #155 with a test plan checklist

## 8. Out of Scope

- Advanced keyspace optimization (issue #99 / #103)
- Task preemption — stopping a running task for higher-priority work (issue #97)
- Dynamic task splitting
- Agent API v2 surface changes (issue #111)

## 9. Risks & Mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Hidden race in `FOR UPDATE SKIP LOCKED` path under concurrency | Concurrency unit test that fires N parallel `assignNextTask` calls against a 1-task fixture |
| Composite index missing in production migration history | Audit `db/migrations/`; add a forward-only Drizzle migration if absent |
| `hasHighPriorityTasks` flag false-positive under capability mismatch | Integration test exercises capability boundary |
| Hybrid generation rollback path leaks campaign state | Verify rollback resets `status`, `startedAt`, `completedAt`, `progress` together |

## 10. Open Questions

- Does the heartbeat-monitor schedule survive Redis disconnect/reconnect (per the
  reconnect hook in `queue/manager.ts`)? Worth an explicit test if not covered.
- Is the `FOR UPDATE SKIP LOCKED` candidate-then-update CTE provably equivalent
  to a single `UPDATE … FROM … WHERE` under PostgreSQL? If not, the
  diagnose-skip path may misclassify a real lock collision as `claim_race_lost`.
