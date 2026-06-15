# Issue #97 — Task Preemption for Priority-Based Workload Balancing

> **Status:** Spec — ready for implementation
> **Priority:** P0 (Core Parity Blocker) · **Story Points:** 8 · **Epic:** #118 Intelligent Scheduling
> **Blocked by:** #96 Keyspace-Based Task Distribution (CLOSED — shipped)
> **Related:** #23 (Task Distribution, closed), #99 (Attack State Machine)
> **Source:** CipherSwarm parity — `TaskPreemptionService`, `CampaignPriorityRebalanceJob`

## Issue Summary

Without preemption, a low-priority campaign occupying every agent blocks a newly
created high-priority campaign from getting resources. The scheduler today orders
the claim pool by `campaigns.priority` (`assignNextTask`, `services/tasks.ts:419`,
`ORDER BY campaigns.priority, tasks.id`), so high-priority work wins **new**
assignments — but it cannot reclaim agents already running lower-priority tasks.
There is no mechanism to stop in-flight work and hand the agent to higher-priority
tasks.

## Problem Statement

1. **No `paused` task status.** `taskDbStatusSchema` (`packages/shared/src/schemas/dashboard.ts:30`)
   is `pending | assigned | running | completed | exhausted | failed | cancelled`.
   `cancelled` is terminal and buckets to `failed` — unusable for "stop, but resume
   later." Campaigns have `paused`; tasks do not.
2. **No stop signal to agents.** Agents are pull-based: `POST /tasks/next` and
   `POST /tasks/{taskId}/report` (`routes/agent/index.ts:351–462`) return only an
   ack. Once an agent starts a task, the backend cannot tell it to stop short of the
   5-minute stale timeout.
3. **No preemption evaluation.** Nothing reacts to a campaign priority change or a
   new high-priority campaign start by freeing agents.
4. **No durable audit trail.** Only `agent_errors` persists; `services/events.ts` is
   in-memory/WebSocket-only. "Preemption events logged" needs durable storage.

## Technical Approach

Add a distinct, **non-terminal** `paused` task status with reason tracking, an
event-driven preemption service that pauses the lowest-priority running tasks to
free agents for higher-priority pending work, a **best-effort, additive** agent
stop-signal carried on existing poll responses, anti-thrash-guarded resume logic
that re-pends paused work, and a durable `task_events` audit table.

### Key design decisions

- **New `paused` status, not reuse of `cancelled`.** The AC mandates "paused (not
  cancelled) and can resume." `paused` is non-terminal; `reassignStaleTasks`
  (`services/tasks/retry.ts`) filters `status IN ('assigned','running')`, so paused
  tasks are **naturally excluded** from the stale sweep — a point in favor of a
  distinct literal.
- **Reason column disambiguates source.** Add `pausedReason: 'preempted' | 'campaign_paused'`
  so task-level preemption is distinguishable from a campaign-pause cascade (campaigns
  already have their own `paused` state + `VALID_TRANSITIONS`, `services/campaigns.ts:503`).
- **Preserve `workRange` + `progress` on pause.** Resume trims `workRange.start`
  forward by reported progress, mirroring `reassignStaleTasks`. **Do NOT** clear
  `progress.keyspaceProgress` on pause (some stale-reassign branches do — that path is
  not reused here).
- **Best-effort, cooperative preemption.** The stop signal is an **additive optional**
  field on existing responses (AGENTS.md: never break the agent API). An older agent
  that ignores it runs the preempted task to completion. Preemption latency ≈ one
  heartbeat/report interval. This is acceptable and stated as a known limitation.
- **Dashboard bucket:** map `paused → pending` in `TASK_DB_TO_BUCKET`. Keeps ETA math
  `remaining = total - completed - failed` correct. (Alternative — a 5th "paused"
  bucket — is deferred; it would touch every dashboard/control stats consumer.)

### Preemption algorithm (KISS v1)

Scoped per project. On trigger, for each project with newly-eligible high-priority
pending work:

1. Find **pending** tasks whose campaign priority is strictly higher (lower number)
   than the priority of some currently **running** task on a capability-matching agent.
2. For each such high-priority pending task without a free matching agent, select the
   **lowest-priority running task** on a capability-matching agent (capability match
   matters — never pause a CPU task to free an agent for GPU-required work).
3. Pause selected tasks: `running → paused`, `pausedReason='preempted'`,
   `preemptedByCampaignId` set, `agentId` **retained** while paused (so the
   heartbeat-derived `stopTaskIds` signal stays derivable without a separate store),
   `workRange`/`progress` preserved. `agentId` is cleared on resume. Emit a `task_events`
   row + WebSocket `task_update`. The agent learns to stop via `stopTaskIds` on its next
   heartbeat (derived from its preempted-paused tasks).
4. Stop when enough agents are freed for the high-priority work or no further
   lower-priority candidates remain.

### Resume logic (anti-thrash)

A paused task becomes eligible again only when **no higher-priority pending or running
work needs the resources** in that project. Resume: trim `workRange.start` forward by
`progress.keyspaceProgress`, set `paused → pending`, clear `pausedReason`/`preemptedBy`,
emit `task_events` `resumed`. **Stability floor:** do not re-preempt a task resumed
within the last `RESUME_STABILITY_FLOOR_MS` (default 30s) to prevent
resume→reclaim→re-preempt loops under concurrent priority churn.

### Event-driven trigger

A `evaluatePreemption(projectId)` BullMQ job (analog of `CampaignPriorityRebalanceJob`),
enqueued on: (a) campaign priority change, (b) campaign `→ running` transition,
(c) campaign terminal/draft transitions (completed/cancelled/stop — frees the campaign's
agents and clears its pending work, driving resume of victims, incl. the cancelled-
preemptor case), and (d) task terminal-state hooks (a completed/exhausted/failed task
frees its agent, driving resume). Deduped per project via a deterministic `jobId`
(`preempt:${projectId}`). Reuses the existing BullMQ infra that backs `reassignStaleTasks`.

## Implementation Plan (phased, TDD-first)

**Phase 1 — Schema & status (foundation)**
- Add `'paused'` to `taskDbStatusSchema`; add `paused: 'pending'` to `TASK_DB_TO_BUCKET`
  (`satisfies Record<TaskDbStatus, TaskBucket>` forces this).
- Migration: `tasks.paused_reason` (varchar, nullable), `tasks.preempted_by_campaign_id`
  (int, nullable FK), `tasks.paused_at` (timestamptz, nullable), `tasks.resumed_at`
  (timestamptz, nullable) — all timestamps `{ withTimezone: true }` per the shared-schema
  coding guideline. New `task_events` table (`id, task_id, event_type, reason,
  from_status, to_status, by_campaign_id, created_at` timestamptz, index on
  `(task_id, created_at DESC)`).
- Shared Zod schemas for `task_events` + stop-signal wire fields in `@hashhive/shared`.

**Phase 2 — Preemption service + trigger**
- `services/tasks/preemption.ts`: `evaluatePreemption(projectId)`, candidate selection,
  pause transition (atomic, `FOR UPDATE SKIP LOCKED` per the #96 pattern + GOTCHAS).
- `task_events` writer; WebSocket `task_update` emission.
- BullMQ job + enqueue hooks in `campaigns.ts` (priority change, `→ running`).

**Phase 3 — Agent stop-signal API (additive, non-breaking)**
- Heartbeat response: add optional `stopTaskIds: number[]` (primary channel, alongside
  `hasHighPriorityTasks`).
- `POST /tasks/{taskId}/report` ack: add optional `action: 'stop'` (fast path — an agent
  reporting progress on a now-paused task is told to stop immediately).
- Agent report **input** enum stays `running|completed|failed|exhausted` — `paused` is
  server-initiated only; no input-side break. Update agent OpenAPI route definitions.

**Phase 4 — Resume + anti-thrash**
- Resume eligibility check + `paused → pending` re-pend with `workRange` trim.
- Stability-floor guard via `resumed_at`. Enqueue resume evaluation on high-priority
  task completion.

## Test Plan

Write tests first (RED) per repo testing rules; target ≥80% coverage on new code.

- **Unit — preemption algorithm:** higher-priority pending preempts lowest-priority
  running; capability mismatch is skipped; nothing to preempt → no-op; equal priority →
  no preemption.
- **Unit — pause transition:** preserves `workRange`+`progress`, clears `agentId`, sets
  `pausedReason='preempted'`, writes `task_events`.
- **Unit — resume:** trims `workRange.start` by progress; blocked while higher-priority
  work pending; stability floor blocks re-preempt within window.
- **Unit — bucketing:** `TASK_DB_TO_BUCKET['paused'] === 'pending'`; ETA math holds.
- **Integration — trigger:** priority change / new campaign enqueues + runs evaluation
  and frees agents; `reassignStaleTasks` ignores `paused` rows.
- **Contract — agent API:** heartbeat returns `stopTaskIds`; report ack returns
  `action:'stop'` for a paused task; **old-client shape (no new fields) still valid**
  (mocks mirror service `ReturnType`, not route schema — AGENTS.md).
- **Audit:** preempt + resume each write a `task_events` row with correct
  `from/to_status`, `reason`, `by_campaign_id`.

## Files to Modify / Create

**Modify**
- `packages/shared/src/schemas/dashboard.ts` — `paused` literal + bucket mapping
- `packages/shared/src/schemas/index.ts` — task-event + stop-signal wire schemas, exports
- `packages/shared/src/types/index.ts` — `z.infer` type exports
- `packages/shared/src/db/schema.ts` — `tasks` columns + `task_events` table
- `packages/backend/src/services/tasks.ts` — pause/resume helpers; assignment interplay
- `packages/backend/src/services/tasks/retry.ts` — confirm `paused` excluded from stale sweep
- `packages/backend/src/services/campaigns.ts` — enqueue `evaluatePreemption` on priority change / `→ running`
- `packages/backend/src/routes/agent/index.ts` — `stopTaskIds` on heartbeat, `action` on report ack
- `packages/backend/src/routes/dashboard/stats.ts`, `routes/control/stats.ts`,
  `services/campaign-dashboard.ts` — consumers of `TASK_DB_TO_BUCKET` (compile-checked by the `satisfies`)

**Create**
- `packages/backend/src/services/tasks/preemption.ts` — algorithm + pause/resume + trigger
- `packages/backend/src/services/tasks/task-events.ts` — durable audit writer
- Drizzle migration for new columns + `task_events`
- Test files mirroring each new/changed module

## Success Criteria

- [ ] Higher-priority campaigns preempt lower-priority running tasks (capability-aware)
- [ ] Preempted tasks are `paused` (not cancelled), preserve progress, and resume
- [ ] Preemption triggered by priority changes and new campaign starts
- [ ] Agents notified to stop preempted work via additive, non-breaking response fields
- [ ] Preemption + resume events durably logged in `task_events`
- [ ] Resume is anti-thrash guarded (no resume→reclaim→re-preempt loop)
- [ ] `just ci-check` green; agent API backward compatible

## Out of Scope / Known Limitations

- **Push-based agent control.** No WebSocket/long-poll command channel to agents;
  preemption is **best-effort and cooperative** — latency ≈ one poll interval, and an
  agent that ignores the new field finishes the preempted task. A real-time stop channel
  is future work.
- **Re-chunking on pause.** Paused work resumes as a single trimmed task (mirrors
  `reassignStaleTasks`); splitting the remaining keyspace across idle agents is deferred.
- **5th "paused" dashboard bucket.** Deferred — `paused → pending` for v1.
- **Cross-project preemption.** Evaluation is project-scoped, matching the existing
  assignment scope.
- **Preemption fairness / starvation control** beyond strict priority ordering is deferred.
