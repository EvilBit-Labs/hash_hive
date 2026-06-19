# ADR-0015: Append-only progress telemetry with TimescaleDB RRD-style retention

**Date**: 2026-06-19
**Status**: accepted (forward design; phased rollout pending)
**Deciders**: Project owner (@unclesp1d3r), AI pair (Claude Code)

## Context

Agents report progress every ~3 seconds. At 1-12 agents (growing) that is a
steady 24/7 write stream. Today each report does an in-place
`UPDATE tasks SET progress = <jsonb>` plus a per-report `updateCampaignProgress`
aggregate — two hot-row JSONB overwrites and 6-8 sequential DB ops per report.
In-place UPDATE on a few hot rows is the canonical Postgres MVCC dead-tuple /
autovacuum-pressure failure mode. Crucially, `reassignStaleTasks` keys off
`agents.lastSeenAt`, **not** `tasks.updatedAt` — so the progress write carries
no liveness obligation and is really a telemetry stream. Storage must stay
bounded (operator requirement: "compaction like rrdtool so we don't fill up").

## Decision

Split **authoritative state** from **telemetry**:

- **State** — committed keyspace offset (on `tasks`), cracked plaintext (in
  `hash_items`), and status transitions — is kept **exactly, forever**
  (monotonic; never downsampled). Cracked hashes persist **first, before any
  status/preemption guard**, idempotent via the existing
  `(hash_list_id, hash_value)` unique constraint, so preemption or agent death
  never loses found plaintext.
- **Telemetry** — speed (H/s), temperature, progress-over-time samples — is
  written **append-only** (no per-report hot-row UPDATE) into a **TimescaleDB
  hypertable** with **continuous aggregates** (1m / 5m / 1h rollups),
  **retention policies**, and compression: RRD-style downsampling with an
  engine-enforced, bounded storage ceiling.

The per-report campaign aggregate moves off the hot path to a compaction
cadence. Tier resolutions/windows are env-configurable (see ADR-0017).

## Alternatives Considered

### Alternative 1: Hand-rolled tier tables + cron in plain Postgres

- **Why not**: retention becomes a fragile app job — if it stalls the table
  grows unbounded, the exact failure RRD must prevent. Would need a `pg_cron`
  backstop anyway.

### Alternative 2: Redis Streams `MAXLEN`

- **Why not**: RAM-bound; fine for disposable telemetry but replay is limited
  to the cap. Kept as the fan-out option (ADR-0016), not the durable series.

### Alternative 3: Dedicated TSDB (VictoriaMetrics / Prometheus remote-write)

- **Why not**: heaviest new dependency; overkill at this scale.

Why TimescaleDB: declarative, engine-enforced retention/rollup; Postgres-native
(same SQL and transactions; extension on the existing DB or a sidecar service —
docker services are acceptable).

## Consequences

### Positive

- Eliminates hot-row MVCC bloat on the 24/7 write path; bounded telemetry storage.
- One primitive feeds four consumers: the per-agent speed signal (ADR-0017),
  the fan-out source (ADR-0016), the crash-recovery resume point, and operator
  history.

### Negative

- Adds TimescaleDB to the docker stack.
- Dashboard current-progress reads become eventually consistent (up to the
  compaction cadence), served via DISTINCT-ON over recent events + a snapshot.

### Risks

- Compaction/retention must be engine-enforced (or have a `pg_cron` backstop).
- Out-of-order multi-replica writes are reconciled with `GREATEST` over the
  monotonic keyspace offset.

Full design, schema deltas, and phased/reversible rollout:
`docs/brainstorms/2026-06-19-task-distribution-architecture.md`.
