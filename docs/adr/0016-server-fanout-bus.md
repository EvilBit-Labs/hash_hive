# ADR-0016: Server-to-server fan-out bus (LISTEN/NOTIFY first, Redis Streams later)

**Date**: 2026-06-19
**Status**: accepted (forward design; phased rollout pending)
**Deciders**: Project owner (@unclesp1d3r), AI pair (Claude Code)
**Extends**: [ADR-0012](0012-in-memory-websocket-v1-redis-deferred.md)

## Context

To scale horizontally the backend runs as N stateless replicas behind a load
balancer, sharing one Postgres. Real-time events need cross-replica fan-out: an
agent posts progress to replica A while a dashboard WebSocket is held on replica
B, and a preemption signal computed on replica C must reach the agent's
connection on A. ADR-0012 deferred this. Worse, today the worker processes
(`worker-jobs.ts`, task generation) emit events into a **per-process in-memory
Map that is always empty** — so preemption, resource-parse, and heartbeat events
are silently dropped even single-instance. This is a live bug, not only a
scaling gap. The bus is strictly **server ↔ server** (control plane); it is NOT
server → agent task assignment, which stays a pull from Postgres.

## Decision

Introduce an `EventBus { publish; subscribe }` seam. The existing emit call
sites are unchanged; worker processes publish-only, API replicas subscribe and
deliver to their local WebSocket clients (project-scoped filtering already
exists).

- **Phase 1 — Postgres `LISTEN/NOTIFY`**: zero new infrastructure
  (`postgres.js` `client.listen()` opens a dedicated non-pooled connection;
  fires post-commit). Fixes the live event-drop bug and unblocks multi-replica
  immediately. Payload rule: IDs + enums only, well under the 8KB limit
  (pointer-and-refetch for anything larger; `resource_update` already does this).
  No replay; the existing 30s polling fallback covers reconnect gaps.
- **Phase 2 — Redis Streams** behind the same interface, when replay
  (reconnecting dashboards catching up on per-task history) or NOTIFY-queue
  contention becomes measurable. Docker services are acceptable, so this is a
  near-term option rather than a hard dependency.

**Degradation posture**: if the bus is down, dashboard real-time degrades to
polling; the **agent data plane (pull/write straight to Postgres) is
unaffected**. This, together with [ADR-0017](0017-adaptive-task-sizing-lease.md)
(reclaim works when Redis is down), captures the Redis-down posture that
ADR-0009 anticipated as a possible "ADR-015 degradation policy" — that
placeholder is resolved here; no separate degradation-policy ADR is planned.

## Alternatives Considered

### Alternative 1: Redis pub/sub first (ADR-0012's named path)

- **Why not**: adds Redis to the real-time critical path before NOTIFY is even
  tried. "Bus up iff Postgres up" is a cleaner invariant than "iff Postgres and
  Redis up." Redis Streams (not bare pub/sub) is the eventual upgrade because it
  adds replay.

### Alternative 2: Redis Streams from day one

- **Why not**: replay isn't needed yet (events are invalidation nudges; clients
  refetch from Postgres). Adopt when the value is concrete.

## Consequences

### Positive

- Fixes a live cross-process event-drop bug; unblocks N-replica deployment with
  zero new infrastructure; clean drop-in upgrade path.

### Negative

- LISTEN/NOTIFY has no replay and an 8KB payload cap.
- N `LISTEN` connections + per-process pools → PgBouncer at multi-replica scale
  (operational, not a design blocker).

Full design and rollout:
`docs/brainstorms/2026-06-19-task-distribution-architecture.md`.
