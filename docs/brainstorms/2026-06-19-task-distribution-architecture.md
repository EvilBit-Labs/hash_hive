# Task Distribution & Storage Architecture — Design Synthesis

**Date:** 2026-06-19
**Status:** Decisions locked 2026-06-19 (see §7); ready for ADRs + implementation plan. Supersedes the open question behind ADR-0009.
**Context:** Originated from a review of ADR-0009 (PostgreSQL task store, BullMQ
orchestration-only). The owner questioned whether tasks should live in a queue
instead, given that the platform must scale horizontally. This document records
the validated decision, the target architecture, and the open decisions.

Inputs: a verified code map, web research on comparable systems, an internal
learnings pass, a 5-frame ideation fleet, and three focused deep-dives
(adaptive sizing/leasing, fan-out bus, append-only write path). Cross-project
prior art is cited inline.

---

## 1. The validated decision: server-authoritative, DB-as-store

DB-as-store is **kept**, on three independent grounds:

- **Authority** (owner constraint): only the server can see all elements of an
  attack and its tasks. Agents go offline, hit local errors, and lose state, so
  authority cannot live at the edge.
- **Prior art**: every comparable distributed-cracking system uses a relational
  DB as the source of truth and agents *pull* — Hashtopolis (MySQL chunks),
  Fitcrack/BOINC (MariaDB workunits + deadline reissue), HashKitty (MariaDB).
  None use a message broker for task distribution. hashcat "brain" is candidate
  dedup, not distribution.
- **Load shape**: assignment is rare (a task runs minutes-to-hours); the
  Postgres `FOR UPDATE SKIP LOCKED` contention regime only appears at 100+
  fast-cycling consumers. HashHive (≤ dozens of coarse, long tasks) is orders
  of magnitude below it.

**Horizontal scaling is achieved in the control plane, not by relocating the
store.** This resolves the owner's concern.

### Two planes

- **Data plane (server → agent):** pull from authoritative Postgres,
  capability-matched, duration-sized. No queue. `assignNextTask` already does
  the atomic claim (`services/tasks.ts` CTE with `FOR UPDATE SKIP LOCKED`).
- **Control plane (server ↔ server):** N stateless backend replicas behind a
  load balancer share Postgres (authoritative) + a fan-out bus (ephemeral
  coordination) + BullMQ (background work). This is where horizontal scale
  lives.

---

## 2. The interlocking primitive: an append-only progress/telemetry log

A single new primitive feeds four consumers (the "leverage" insight every
ideation frame converged on):

1. durable progress / crash-recovery resume point
2. the per-agent speed signal that sizes the next task
3. the fan-out source for the control-plane bus
4. the operator-facing progress/throughput history

Today every 3s report does an in-place `UPDATE tasks SET progress = <jsonb>`
plus a `updateCampaignProgress` aggregate — 6-8 sequential DB ops, two hot-row
JSONB overwrites, 24/7. That is the canonical Postgres hot-row / MVCC-bloat
failure mode. Replace it with append-only inserts + tiered compaction.

**Confirmed:** `reassignStaleTasks` keys off `agents.lastSeenAt`, not
`tasks.updatedAt` — so the progress write has *no* liveness obligation and can
be treated as a telemetry stream.

### State vs telemetry (the RRD boundary)

| Class                   | Examples                                                                                  | Retention                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Authoritative state** | committed keyspace offset (`tasks`), cracked plaintext (`hash_items`), status transitions | kept **exactly, forever** (monotonic; never downsampled)             |
| **Telemetry series**    | speed (H/s), temperature, progress-over-time samples                                      | **RRD-style**: full-res recent → downsampled tiers → bounded ceiling |

Cracked hashes persist **first, before any status/preemption guard**, idempotent
via the existing `(hash_list_id, hash_value)` unique constraint — so preemption
or agent death never loses found plaintext.

---

## 3. RRD-style telemetry retention (storage ceiling)

The owner's requirement: compaction like rrdtool, so storage cannot fill. The
telemetry series is downsampled into progressively coarser, fixed-size archives:

- full resolution (every report) for the recent window (live dashboard, crash
  recovery, EWMA): minutes-to-1h
- 1-minute rollups: ~24h
- 5-minute rollups: ~1 week
- 1-hour rollups: ~1 month
- drop the oldest tier on roll — total footprint is bounded and constant.

### Build vs buy (docker services are now on the table)

| Option                                     | RRD fit                                                                                                                           | Cost                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **A. Hand-rolled tiers in plain Postgres** | tier tables + a compaction/rollup job + retention prune                                                                           | no new service; but retention is an app job (fragile — if it stalls, the table grows; needs a `pg_cron` backstop)            |
| **B. TimescaleDB (recommended)**           | continuous aggregates (auto 1m/5m/1h rollups) + retention policies + native compression — **RRD, declaratively, engine-enforced** | adds the timescaledb image (or the extension on the existing DB); stays SQL/Postgres-native, no app-side retention to forget |
| **C. Redis Streams `MAXLEN`**              | bounded by construction; doubles as the fan-out bus                                                                               | RAM-bound; telemetry is disposable so OK; replay window = MAXLEN                                                             |
| **D. Dedicated TSDB (VictoriaMetrics)**    | best-in-class downsampling/retention + Grafana                                                                                    | heaviest new dep; overkill at this scale                                                                                     |

**Recommendation: B (TimescaleDB).** It makes "RRD so we don't fill storage"
a declarative, engine-enforced property rather than a hand-rolled cron the way
agent C's design flagged as a risk, and it stays Postgres-native (same SQL, same
transactions, can be the same DB via extension or a sidecar service). Keep
authoritative state in plain tables; only the telemetry hypertable is Timescale.

---

## 4. Adaptive sizing & leasing (data plane)

Heterogeneous, time-varying agent speed/reliability. The "either track speed or
make tasks small" framing collapses into one mechanism, because hashcat's
per-task startup cost (kernel compile, wordlist/rules load) forbids truly tiny
tasks.

- **Rate signal:** per-agent observed-rate **EWMA** written from the 3s stream
  (α ≈ 0.125, the TCP SRTT-proven value ≈ 15-sample window), seeded from the
  registration benchmark, stored on `agent_benchmarks.observed_speed_hs`.
  Chosen over AIMD because we directly *observe* throughput (EWMA filters a
  known signal; AIMD probes an unknown limit). AIMD's grow-slow/cut-hard profile
  is instead applied to a per-agent **reliability factor**.
- **Sizing point:** size at **claim** via split-on-claim — trim an oversized
  pending range to a per-agent `--skip/--limit` parcel sized to a target
  wall-clock duration; re-pend the remainder. Resolves the code's own
  "split-on-rebalance" TODO in `chunk-sizing.ts`. Replaces fleet-**median**
  generation-time sizing.
- **Target duration:** ~300s (≥ 20× hashcat startup for ≤5% overhead), set by a
  **deployment-level env var** the admin tunes across the whole docker stack —
  **not** per-campaign. Future extension (noted, not built): per-hash-type
  sizing modifiers. Blast radius on reclaim is bounded by the lease + committed
  offset, not the chunk size.
- **Lease:** add `tasks.lease_expires_at`, extended **only when the keyspace
  watermark advances** (this is also the ghost/hung-agent detector — a
  heartbeating-but-stuck GPU stops advancing and its lease lapses). Fold reclaim
  into the claim CTE (`status IN ('assigned','running') AND lease_expires_at <
  NOW()`), so reclaim is **correct even when Redis/BullMQ is down** (ADR-0009
  invariant). BullMQ sweep demoted to a backstop for legacy NULL-lease rows.
- **One-task-per-agent invariant:** `NOT EXISTS` guard in the claim CTE (the
  agent holds at most one active lease) — turns a behavioral assumption into a
  DB invariant; a reconnecting agent with an expired lease can still claim.
- **Committed-offset cursor:** `tasks.committed_keyspace_offset` advanced on
  watermark progress; reassignment resumes from it (BOINC-style), not task
  start. This is authoritative state, exempt from RRD downsampling.

---

## 5. Fan-out bus (control plane)

**Live bug first:** worker processes call `emitTaskUpdate`/`emitCrackResult`
into a per-process in-memory `Map` that is always empty — preemption, resource,
and heartbeat events are dropped *today*, single-instance. Fixing this is the
first deliverable and is independent of horizontal scale.

- **`EventBus { publish; subscribe }`** interface is the seam; the 13 emit call
  sites do not change. Workers publish-only; API replicas subscribe + deliver
  locally (project-scoped filtering already exists).
- **Phase 1 — Postgres `LISTEN/NOTIFY`** (zero new infra; `postgres.js`
  `client.listen()` opens a dedicated non-pooled connection; fires post-commit).
  Fixes the live drop and unblocks multi-replica immediately. Payload rule:
  IDs + enums only, < ~2KB (8KB hard limit), pointer-and-refetch for anything
  larger — `resource_update` already does this. No replay; the existing 30s
  poll covers reconnect gaps.
- **Phase 2 — Redis Streams** when replay (reconnecting dashboards catching up
  on per-task history) or NOTIFY-queue contention becomes measurable. Drop-in
  behind the same interface. (Docker services are acceptable, so this is open.)
- **Failure posture:** bus down ⇒ dashboard real-time degrades to polling;
  **agent data plane is unaffected** (pull/write straight to Postgres). Must be
  covered by an integration test.

Cross-project: Supabase Realtime v1 / pg-boss / Hasura all used NOTIFY and
migrated only at multi-tenant or very-high-insert scale or the 8KB limit — none
of those walls apply to HashHive's nudge-and-refetch payloads at this scale.

---

## 6. Phased, reversible rollout

1. **Fan-out bus (LISTEN/NOTIFY)** — fixes the live worker-drop bug; unblocks
   multi-replica. Self-contained.
2. **Append-only telemetry log + dual-write** — insert events alongside the
   current JSONB update; move cracked-hash persist ahead of the paused guard.
   Reversible (additive).
3. **EWMA speed signal** — write `observed_speed_hs` from the progress handler;
   observe only (no sizing change yet).
4. **Tiered RRD compaction** — stand up the telemetry store (TimescaleDB
   hypertable + continuous aggregates + retention, or the chosen option); cut
   reads over; stop the per-report hot-row UPDATE + per-report campaign
   aggregate (move to compaction cadence).
5. **Lease + committed-offset + ghost detection** — add columns; fold reclaim
   into the claim CTE; demote the BullMQ sweep to backstop.
6. **Split-on-claim + raise target duration** — once EWMA is stable.

Each phase is independently shippable and (1-4) reversible.

---

## 7. Decisions (resolved 2026-06-19)

1. **Telemetry store: TimescaleDB** — declarative, engine-enforced RRD
   (continuous aggregates + retention + compression). Adds the service to the
   docker stack. → [ADR-0015](../adr/0015-append-only-telemetry-timescaledb-rrd.md)
2. **Fan-out bus: LISTEN/NOTIFY now, Redis Streams deferred** behind the same
   `EventBus` interface (upgrade when replay/contention warrants). →
   [ADR-0016](../adr/0016-server-fanout-bus.md)
3. **Target chunk duration ≈ 300s, set by a deployment-level env var** the admin
   tunes across the whole docker stack — **not** per-campaign. Per-hash-type
   modifiers are a noted future extension. →
   [ADR-0017](../adr/0017-adaptive-task-sizing-lease.md)
4. **Lease ≈ 90s and the RRD tier windows are likewise env-configurable.** →
   ADR-0015 / ADR-0017

---

## 8. ADR consequences

- **ADR-0009** is validated, not overturned — annotate it with this synthesis
  (DB-as-store confirmed; horizontal scale lives in the control plane).
- New ADRs to record once decisions land: the **append-only telemetry log +
  RRD retention**, the **server↔server fan-out bus** (and its phasing), and
  the **adaptive sizing + lease/committed-offset model**.

---

## 9. Top risks

- Network partition (vs hang) reclaims a task whose un-committed work is
  redone — safe (cracking is idempotent), bounded by lease + cursor.
- In-memory progress buffering rejected (adds crash/scale complexity; appends
  don't bloat) — revisit only at hundreds of agents.
- Compaction/retention must be engine-enforced or have a `pg_cron` backstop, or
  the telemetry table grows unbounded (the exact thing RRD must prevent).
- N `LISTEN` connections + per-process pools → use PgBouncer at multi-replica
  scale (operational, not a design blocker).
- BullMQ `jobId` dedup must pair with `removeOnComplete`/`removeOnFail` on every
  compaction enqueue (known repo gotcha).
