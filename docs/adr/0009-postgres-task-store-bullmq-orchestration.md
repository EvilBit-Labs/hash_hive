# ADR-0009: PostgreSQL as task store, BullMQ for orchestration only

**Date**: 2026-06-18
**Status**: accepted
**Deciders**: Project owner (@unclesp1d3r)

## Context

Recorded retroactively (Tech Plan "Critical Design Decision #4"). HashHive
distributes cracking work as task records. A common pattern is to let the
job queue (BullMQ/Redis) own task state, but that makes the queue the source
of truth and couples task availability to Redis uptime.

## Decision

Task records live in PostgreSQL (with status indexes); BullMQ/Redis is used
only for job orchestration — triggering workers, scheduling retries, and
priority ordering — never as the task store. Task assignment is an atomic
PostgreSQL update so two agents cannot claim the same task.

## Alternatives Considered

### Alternative 1: Dual storage (tasks in PostgreSQL and as BullMQ jobs)

- **Pros**: queue-native scheduling of task state.
- **Cons**: two sources of truth to keep consistent; ambiguous ownership of
  task status.
- **Why not**: simpler to keep one authoritative store; PostgreSQL
  transactions already give atomic assignment.

### Alternative 2: Redis/BullMQ as the task store

- **Pros**: fast, queue-native.
- **Why not**: makes the agent task path Redis-dependent and loses
  relational querying/observability of task state.

## Consequences

### Positive

- Single source of truth for task state with transactional assignment.
- Agent task endpoints stay available when Redis is down (see the
  degradation policy candidate, ADR-015 if recorded).

### Negative

- PostgreSQL is the throughput bottleneck for task assignment at scale.

### Risks

- High task volume could pressure the assignment path; mitigated by status
  indexes and atomic updates, revisit if it becomes hot.
