# ADR-0012: In-memory WebSocket broadcast for v1, Redis pub/sub deferred

**Date**: 2026-06-18
**Status**: accepted
**Deciders**: Project owner (@unclesp1d3r)

## Context

Recorded retroactively (Tech Plan "Critical Design Decision #5"). The
dashboard needs sub-second updates (task progress, agent status, cracked
results). Multi-instance fan-out would need Redis pub/sub, but v1 runs as a
single backend instance.

## Decision

Real-time events are broadcast in-memory over WebSocket within a single
backend instance for v1. The `EventService` interface is shaped so Redis
pub/sub can be added later without changing event semantics or callers. On
disconnect, the dashboard falls back to ~30s polling.

## Alternatives Considered

### Alternative 1: Redis pub/sub from day one

- **Pros**: multi-instance ready immediately.
- **Cons**: adds a Redis dependency to the real-time path before it is
  needed.
- **Why not**: v1 is single-instance; in-memory broadcast is simpler and the
  interface keeps the upgrade non-breaking. (YAGNI.)

### Alternative 2: Polling only

- **Pros**: no socket infrastructure.
- **Why not**: cannot deliver the sub-second updates the dashboard needs;
  retained only as the disconnect fallback.

## Consequences

### Positive

- Simplest transport that meets v1's latency goal; no extra dependency.
- A defined extension path to Redis pub/sub for multi-instance later.

### Negative

- Real-time fan-out is confined to one instance until pub/sub lands.

### Risks

- Adding Redis pub/sub or removing the `EventService` seams without revisiting
  this ADR would break the planned non-breaking upgrade. Horizontal scaling
  is blocked for real-time until then.
