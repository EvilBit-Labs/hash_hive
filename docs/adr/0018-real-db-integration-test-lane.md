# ADR-0018: Real-DB integration test lane for DB-layer correctness

**Date**: 2026-06-19
**Status**: accepted
**Deciders**: Project owner (@unclesp1d3r), AI pair (Claude Code)
**Relates to**: [ADR-0015](0015-append-only-telemetry-timescaledb-rrd.md),
[ADR-0016](0016-server-fanout-bus.md), [ADR-0017](0017-adaptive-task-sizing-lease.md)

## Context

The backend test suite mocks the drizzle client, and CI ran no database. The
task-distribution work (ADR-0015/0016/0017) is almost entirely DB-layer:
Postgres `LISTEN/NOTIFY` fan-out, the `FOR UPDATE SKIP LOCKED` claim CTE, lease
reclaim, committed-offset resume, and the TimescaleDB telemetry hypertable +
retention. A mocked test for any of these asserts only that the mock returns
what the test set it to — it proves wiring compiles, not that the distributed-
systems machinery works. Shipping that machinery on the agent API ("never
break") with its core correctness unverified was the gap.

## Decision

Add a dedicated **real-DB integration test lane** (`packages/backend/tests/db/`,
run via `just test-db`) that connects to a live Postgres/TimescaleDB and is
**required** in CI. It runs against a `timescale/timescaledb:2.17.2-pg16`
service container in the `ci-check` job, is excluded from the default mocked
lane (the bare `bun test` is scoped to `tests/unit tests/integration`), prepares
a dedicated `hashhive_test` database (create + migrate), and **never
self-skips** — a green-but-skipped real-DB test is false coverage. Scale/limit
*branches* (e.g. the per-attack chunk cap) are tested in the mocked lane by
returning the boundary result, not by reaching scale in a real DB; no
performance/benchmark/load tests run in CI (runner inconsistency + cost).

## Alternatives Considered

### Alternative 1: Mock-only (status quo)
- **Pros**: no service container; fast; no DB in CI.
- **Cons**: cannot verify LISTEN/NOTIFY, SKIP LOCKED, lease reclaim, or
  hypertable retention — the exact behaviour the work depends on.
- **Why not**: the verification model is hollow for DB-layer correctness; mocked
  tests would go green while the machinery is unverified.

### Alternative 2: Sidecar / second database for integration
- **Pros**: isolates integration data.
- **Cons**: splits telemetry out of the authoritative transaction; doubles the
  operational + test surface.
- **Why not**: TimescaleDB-as-extension (ADR-0015) keeps everything in one DB;
  one real-DB lane against that same image is simpler and higher-fidelity.

## Consequences

### Positive
- DB-layer correctness is genuinely exercised. The lane immediately surfaced
  three pre-existing defects mocks could not: a JS `Date` mis-bind in
  `reassignStaleTasks` (raw `sql` + postgres.js → `ERR_INVALID_ARG_TYPE`), a
  capability-predicate JS-array mis-bind for `ANY(...::int[])` that would have
  failed capability-gated agent assignment in production, and a `mock.module`
  test-isolation leak.
- A high-fidelity home for future distributed-systems behaviour.

### Negative
- CI gains a TimescaleDB service container and a DB-heavy test step.
- The lane must stay **correctness-only** — generous wall-clock tolerance windows
  are fine, but timing/throughput/load assertions are forbidden (GitHub runners
  are too inconsistent and cost money).

### Risks
- After any schema change, `@hashhive/shared` must be rebuilt before the lane
  (the backend reads built `dist`); `just check` covers this. No `client.end()`
  in a `tests/db` file (the pooled client is shared across the lane).
