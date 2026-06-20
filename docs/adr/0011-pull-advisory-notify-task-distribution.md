# ADR-0011: Hybrid pull + advisory-notify task distribution

**Date**: 2026-06-18
**Status**: accepted
**Deciders**: Project owner (@unclesp1d3r)

## Context

Recorded retroactively (Tech Plan "Task Distribution Model"). Agents run on a
private LAN with no guarantee of a persistent server-to-agent connection.
The server must hand out work without becoming the initiator of every
assignment.

## Decision

Agents pull work via `POST /agent/tasks/next` (assignment is an atomic
PostgreSQL update). To accelerate urgent work without a push channel, the
heartbeat response carries an advisory `has_high_priority_tasks` flag
(omitted, not `false`, when absent) prompting the agent to pull sooner. The
pull is always agent-initiated.

## Alternatives Considered

### Alternative 1: Server push (server assigns proactively)

- **Pros**: lowest latency to start a task.
- **Cons**: server must maintain persistent connections to every agent and
  track liveness/backpressure.
- **Why not**: too much connection state for a private-lab deployment; pull
  is simpler and survives network interruptions.

### Alternative 2: Pure polling, no advisory hint

- **Pros**: simplest possible model.
- **Why not**: either wastes requests (tight poll) or delays priority work
  (slow poll); the heartbeat hint gives priority acceleration for free.

## Consequences

### Positive

- Stateless, interruption-tolerant agent model; no server-held connections.
- Priority campaigns accelerate via the heartbeat hint without a push
  channel.

### Negative

- Non-priority task start latency is bounded by the agent's pull cadence.

### Risks

- The advisory flag's "absence means no signal" contract is pinned by the
  schema (`z.literal(true).optional()`); changing it would silently alter
  agent behavior.
