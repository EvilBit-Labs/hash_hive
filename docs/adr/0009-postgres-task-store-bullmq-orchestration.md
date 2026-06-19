# ADR-0009: PostgreSQL as task store, BullMQ for orchestration only

**Date**: 2026-06-18
**Status**: accepted — validated and extended 2026-06-19 by ADR-0015/0016/0017
**Deciders**: Project owner (@unclesp1d3r)

> **Update (2026-06-19):** This decision is validated, not overturned.
> Horizontal scaling lives in the control plane (stateless replicas + a
> server↔server fan-out bus + BullMQ), not by relocating the store — see
> [ADR-0016](0016-server-fanout-bus.md). The append-only telemetry write path is
> [ADR-0015](0015-append-only-telemetry-timescaledb-rrd.md); adaptive sizing and
> leasing is [ADR-0017](0017-adaptive-task-sizing-lease.md). The Redis-down
> "degradation policy candidate (ADR-015 if recorded)" noted below is resolved in
> ADR-0016/0017; no separate degradation-policy ADR is planned. Full synthesis:
> `docs/brainstorms/2026-06-19-task-distribution-architecture.md`.

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
