---
module: queue
date: 2026-06-15
problem_type: integration_issue
component: background_job
severity: high
symptoms:
  - "A BullMQ job enqueued with a fixed jobId runs exactly once, then every subsequent enqueue with the same jobId is a silent no-op"
  - "Event-driven work that should re-fire per key (e.g. per-project preemption) stops happening after the first run"
  - "No error and no log line — the duplicate add just returns the existing (terminal) job and nothing executes"
root_cause: config_error
resolution_type: code_fix
related_components:
  - database
tags:
  - bullmq
  - queue
  - background-jobs
  - deduplication
  - jobid
  - removeoncomplete
  - preemption
---

# BullMQ jobId dedup silently fires once unless the job is evicted on terminal

## Problem

Using a deterministic `jobId` to dedup a burst of event-driven enqueues (so many triggers collapse to one job) works the first time, then never fires again for that id. In HashHive this defeated task preemption: `enqueuePreemptionEvaluation` enqueued with `jobId: preempt:${projectId}`, so after the first evaluation for a project, no later trigger (priority change, campaign start, task completion) ever ran another evaluation for that project.

## Symptoms

- Preemption (or any per-key deduped job) runs once per key, then stops — paused tasks would never resume, new high-priority campaigns would never preempt.
- No exception, no warning. The enqueue call returns "successfully"; the work just doesn't happen.

## What Didn't Work

- Reasoning from the mental model that "jobId dedup only collapses jobs while one is queued/running, then frees the id when the job finishes." That is the intuition, but it is wrong for the default BullMQ config.

## Solution

Whenever a `jobId` is supplied for dedup, also set `removeOnComplete` and `removeOnFail` so the id key is evicted once the job reaches a terminal state and future enqueues can dedup again.

```ts
// packages/backend/src/queue/manager.ts — QueueManager.enqueue
await queue.add(queueName, data, {
  ...(opts?.priority ? { priority: opts.priority } : {}),
  // CRITICAL: a deduped job MUST evict its id on terminal, else the first
  // run permanently blocks every future re-add of the same jobId.
  ...(opts?.jobId
    ? {
        jobId: opts.jobId,
        removeOnComplete: opts.removeOnComplete ?? true,
        removeOnFail: opts.removeOnFail ?? true,
      }
    : {}),
  attempts: DEFAULT_JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: 5_000 },
})
```

Coupling the two (jobId implies eviction) at the manager level means no individual caller can forget it. The `?? true` default keeps immediate eviction as the safe baseline while leaving an override escape hatch: a caller that needs to read a terminal job's `returnvalue`/`failedReason` before it disappears (e.g. status-polling an outcome that leaves no other row to read, issue #202 SU7) can pass `removeOnComplete: { age: <seconds> }`. See the override test in `packages/backend/tests/unit/queue-manager.test.ts`.

## Why This Works

BullMQ (v5) **retains completed and failed jobs by default** and keeps their `jobId` key alive in Redis. A re-add with an existing jobId whose key still exists is treated as a duplicate and short-circuits (`handleDuplicatedJob`) — it returns the existing terminal job and runs nothing. The key is only deleted when `removeOnComplete` / `removeOnFail` fire on the terminal event. So without eviction the id is occupied forever after the first run; with eviction it is freed on terminal and the next trigger enqueues a fresh job.

## Prevention

- **Treat `jobId` and `removeOnComplete`/`removeOnFail` as a pair.** Enforce it at the enqueue helper so callers can't supply one without the other (as above), rather than per call site.
- **Test the forwarding, not just the happy path.** A mock queue capturing `queue.add` opts pins the contract:

```ts
test('enqueue evicts the deduped jobId on terminal', async () => {
  // inject a fake queue, capture .add opts
  await qm.enqueue(QUEUE_NAMES.PREEMPTION, { projectId: 7 }, { jobId: 'preempt:7' })
  expect(addCalls[0]?.['jobId']).toBe('preempt:7')
  expect(addCalls[0]?.['removeOnComplete']).toBe(true)
  expect(addCalls[0]?.['removeOnFail']).toBe(true)
})
```

- **Watch for the "fires once then never" smell** in any event-driven/deduped queue: if a feature works in a fresh environment but stops after the first occurrence per entity, suspect a retained-job id collision before suspecting the trigger wiring.
- This class of bug is invisible to a single happy-path run and to a green CI suite — it only shows on the *second* trigger for the same key. It surfaced here via an adversarial review pass that mechanically checked the BullMQ add semantics, not via the unit tests.
