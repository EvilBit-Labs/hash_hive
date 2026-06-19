# ADR-0017: Adaptive task sizing with lease and committed-offset

**Date**: 2026-06-19
**Status**: accepted (forward design; phased rollout pending)
**Deciders**: Project owner (@unclesp1d3r), AI pair (Claude Code)
**Builds on**: [ADR-0009](0009-postgres-task-store-bullmq-orchestration.md),
[ADR-0011](0011-pull-advisory-notify-task-distribution.md); consumes
[ADR-0015](0015-append-only-telemetry-timescaledb-rrd.md)

## Context

Agents are heterogeneous and time-varying in speed AND reliability; stateless
except the single task held in memory (lost on restart); hold one task at a
time. hashcat's per-task startup cost (kernel compile, wordlist/rules load)
forbids truly tiny tasks, so work must be sized to a target wall-clock duration
on the claiming agent's current rate. Today `chunk-sizing.ts` sizes from the
fleet **median** at generation time and fetches the agent benchmark at claim but
does not use it to resize (a TODO the code names "split-on-rebalance"); stale
reclaim keys on `agents.lastSeenAt`, so a heartbeating-but-hung agent is never
reclaimed.

## Decision

- **Rate signal**: per-agent observed-rate **EWMA** (α ≈ 0.125, the TCP SRTT
  value, ≈ 15-sample window), written from the ~3s telemetry stream
  (ADR-0015), seeded from the registration benchmark, on
  `agent_benchmarks.observed_speed_hs`. EWMA over AIMD because throughput is
  directly observed (EWMA filters a known signal; AIMD probes an unknown limit);
  AIMD's grow-slow/cut-hard profile is applied instead to a per-agent
  **reliability factor**.
- **Sizing point**: size at **claim** via split-on-claim — trim an oversized
  pending range to a per-agent `--skip/--limit` parcel for the target duration,
  re-pend the remainder. Resolves the code's "split-on-rebalance" TODO.
- **Tunables are deployment-level env vars** the admin sets across the whole
  docker stack — **not** per-campaign: target duration (default ≈ 300s, ≥ 20×
  hashcat startup), lease duration (default ≈ 90s), and the RRD tier
  resolutions/windows. Future extension (noted, not built): per-hash-type sizing
  modifiers.
- **Lease**: add `tasks.lease_expires_at`, extended **only when the keyspace
  watermark advances** (this doubles as the hung/ghost-agent detector). Reclaim
  folds into the claim CTE (`status IN ('assigned','running') AND
  lease_expires_at < NOW()`), so it is correct **even when Redis/BullMQ is
  down**; the BullMQ stale-sweep is demoted to a backstop for legacy NULL-lease
  rows.
- **One-task-per-agent invariant** via `NOT EXISTS` in the claim CTE; a
  reconnecting agent whose prior lease expired can still claim.
- **Committed-offset cursor**: `tasks.committed_keyspace_offset` advanced on
  watermark progress; reassignment resumes from it (BOINC-style), not task
  start. This is authoritative state, exempt from RRD downsampling.

## Alternatives Considered

### Alternative 1: Keep fleet-median generation-time sizing

- **Why not**: fast agents finish in seconds and idle; slow agents strand a
  median-sized task and risk reclaim — the heterogeneous-fleet case is the norm.

### Alternative 2: BullMQ-only stale reclaim (status quo)

- **Why not**: breaks when Redis is down (ADR-0009 requires agent paths to
  survive a Redis outage); can't detect a hung-but-heartbeating agent.

### Alternative 3: Fixed tiny self-balancing tasks

- **Why not**: hashcat startup cost makes tiny tasks inefficient; duration-
  targeted sizing is the correct primitive.

## Consequences

### Positive

- Work sized to each agent's live rate; reclaim correct under a Redis outage;
  hung/ghost agents detected; wasted compute bounded to ~one report cadence;
  fully admin-tunable via env.

### Negative

- More task rows under mixed-speed fleets (cap via the existing
  `MAX_CHUNKS_PER_ATTACK` at split time).
- EWMA cold-start may mis-size the first 1-2 chunks until it converges.

Full design, schema deltas, claim-CTE SQL, and phased rollout:
`docs/brainstorms/2026-06-19-task-distribution-architecture.md`.
