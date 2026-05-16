---
issue: 96
title: "[P0] Keyspace-Based Task Distribution with Dynamic Chunking"
priority: P0 (priority:critical)
story_points: 13
labels: [enhancement, backend, task-distribution, gap-analysis]
state: open
assignee: unclesp1d3r
branch: 96-p0-keyspace-based-task-distribution-with-dynamic-chunking
created: 2026-05-15
---

# Issue #96 — Keyspace-Based Task Distribution with Dynamic Chunking

## Issue Summary

CipherSwarm's `TaskAssignmentService` (~18.9 KB) divides attack keyspace across
agents proportional to their benchmark throughput. hash_hive has BullMQ task
queuing and atomic claiming but uses a flat `DEFAULT_CHUNK_SIZE = 10_000_000`
(see `packages/backend/src/services/tasks.ts:12`). The chunks ignore agent
speed and fleet composition, so a 100 GH/s GPU and a 10 MH/s CPU receive the
same workload and the slow node bottlenecks the campaign.

Per the issue, this is **the single most critical gap** versus CipherSwarm.

## Problem Statement

What's already in place (do not re-build):

- `attacks.keyspace varchar(255)` — string storage (some keyspaces exceed
  JS Number safety), packages/shared/src/db/schema.ts:373
- `tasks.workRange jsonb` — `{start, end, total}` per chunk
- `tasks.progress jsonb` — agent-reported progress
- `generateTasksForAttack(attackId, opts)` — flat 10M chunking in
  packages/backend/src/services/tasks.ts:40
- `assignNextTask(agentId)` — atomic claim via raw SQL CTE +
  `FOR UPDATE SKIP LOCKED`, packages/backend/src/services/tasks.ts:138
  (GOTCHAS.md:39 already documents the Drizzle workaround)
- `agentBenchmarks.speedHs bigint` + `getAgentBenchmarkForMode(agentId, mode)`
- `reassignStaleTasks(thresholdMs)` — already runs every 2 min via BullMQ
- `handleTaskFailure` — max-3-retry logic shipped
- Campaign progress aggregation in SQL (GOTCHAS.md:46)

What's missing:

1. **Keyspace calculation at attack-creation time.** `attacks.keyspace` is
   currently populated by callers; there is no service that derives the
   total keyspace from the attack's mode, wordlist size, rule count, and
   mask length.
2. **Dynamic chunk sizing.** Chunks are a flat 10M units regardless of
   agent capability. We need a chunk size proportional to either the
   median fleet benchmark (at generation time) or the claiming agent's
   own benchmark (at assignment time), so each task takes roughly the
   same wall time per agent.
3. **Per-task keyspace progress surface.** `updateTaskProgress` already
   accepts a `keyspaceProgress` field but it isn't read elsewhere and
   isn't surfaced on the task row consistently.
4. **Dynamic rebalancing on fleet change.** When an agent goes
   offline, `reassignStaleTasks` resets the task to `pending` and lets
   the next agent claim the whole remaining chunk. For long chunks
   with significant progress already reported, the remaining keyspace
   should be re-chunked so a slower agent doesn't inherit an
   oversized work range.
5. **Diagnostic logging.** `assignNextTask` returns `null` without
   exposing why a task wasn't assigned. Operators debugging fleet
   utilization need skip-reason traces.

## Technical Approach

Three pure modules + an extension to the existing service layer. KISS:
no new tables, no new BullMQ queues, no preemption (that's #97).

### A. Keyspace calculation (`services/keyspace.ts`, new, ~150 lines)

A pure function `calculateAttackKeyspace(attack, dictionaries)` that
returns a `bigint`-string given:

- Attack `mode` (hashcat mode number)
- Wordlist row count (from `word_lists.line_count` if populated; else
  count rows on demand via S3 or DB)
- Rulelist row count
- Mask length and charset cardinality (parse the mask string)

Mode-by-mode:

| hashcat attack mode | Formula |
|---------------------|---------|
| `0` (straight)       | `wordlist.count × max(rules.count, 1)` |
| `1` (combination)    | `wordlistA.count × wordlistB.count` |
| `3` (mask)           | `Π(charset_size_per_position)` |
| `6` (hybrid w+m)     | `wordlist.count × mask_keyspace` |
| `7` (hybrid m+w)     | `mask_keyspace × wordlist.count` |
| other                | `null` → fall back to single-task path |

Return as a string to preserve `bigint` precision across the JS boundary
and match the existing `attacks.keyspace varchar` column. Existing
single-task fallback at `generateTasksForAttack:51-65` covers the null
case unchanged.

### B. Benchmark-aware chunk sizing (`services/chunk-sizing.ts`, new, ~120 lines)

Pure helper `pickChunkSize({ totalKeyspace, agentBenchmarks, targetSeconds })`:

- Target wall-time per chunk: 60 seconds (configurable; tunable later).
- For the fleet's median `speedHs`, chunk = `speedHs * targetSeconds`,
  clamped between MIN_CHUNK_SIZE (1,000) and MAX_CHUNK_SIZE
  (1,000,000,000), then capped at the remaining total keyspace.
- A separate per-attack ceiling on chunk count (MAX_CHUNKS_PER_ATTACK,
  100,000 in the current impl) prevents OOM on enormous mask attacks by
  lifting the per-chunk floor when `totalKeyspace / chunkSize` would
  exceed the cap.
- Returns chunk size as `bigint`-string.

For generation-time chunking (no specific claimant yet), use the
**median benchmark across active agents for the attack's hashcat mode**.
For assignment-time re-chunking (rebalance path), use the claiming
agent's own benchmark.

### C. Diagnostic logging hooks

Replace `assignNextTask`'s opaque `null` return with a discriminated
union: `{ kind: 'assigned'; task } | { kind: 'skipped'; reason: SkipReason }`.
Skip reasons:

- `agent_not_eligible` (offline / not benchmarked / busy)
- `no_matching_capability` (no task matches GPU + hashcat mode)
- `no_pending_tasks` (project has zero `pending` rows for this agent)
- `claim_race_lost` (SKIP LOCKED skipped every candidate)

Log each skip at `info` level with `{ agentId, projectId, reason }`. Keep
the public route contract (returns `null` or task) so the agent API
surface doesn't break — the discriminated union is internal.

### D. Dynamic rebalancing (extend `reassignStaleTasks`)

When `reassignStaleTasks` finds a stale task with non-zero
`progress.keyspaceProgress`:

1. Read the reported `keyspaceProgress` (units already completed).
2. Trim the task's `workRange.start` to `start + keyspaceProgress`
   (or move to `failed` when `keyspaceProgress >= workRange.total`,
   covering both the un-acked completion case and true overruns).
3. If the remaining range is still larger than the fleet's median
   benchmark × 60s, split it into smaller follow-up tasks. Otherwise
   leave it as one re-pending task.

Touch nothing in the happy claim path. The rebalance only fires for
tasks that were stranded.

### E. Plug C and D into the existing `assignNextTask` and reassignment paths

Surgical changes to `services/tasks.ts`:

- `assignNextTask`: call `pickChunkSize` for any in-progress
  rebalance scenarios; otherwise unchanged.
- `generateTasksForAttack`: call `calculateAttackKeyspace` when
  `attack.keyspace` is null/empty, and `pickChunkSize` with median
  benchmark instead of `DEFAULT_CHUNK_SIZE`.
- `reassignStaleTasks`: invoke the rebalance branch when
  `progress.keyspaceProgress > 0`.

## Implementation Plan

TDD throughout. Tests first, implementation second.

### Phase 1 — Keyspace calculation (red → green → refactor)

1. Write `packages/backend/tests/unit/keyspace.test.ts` covering all six
   mode formulas + the unknown-mode fallback.
2. Implement `packages/backend/src/services/keyspace.ts` until tests
   green.
3. Wire into `generateTasksForAttack` only when `attack.keyspace` is
   missing.

### Phase 2 — Chunk sizing (red → green → refactor)

1. Write `packages/backend/tests/unit/chunk-sizing.test.ts`:
   - Median selection across multiple benchmarks
   - Floor and ceiling clamps
   - Total-keyspace boundary cases
   - Empty benchmark set → falls back to `DEFAULT_CHUNK_SIZE`
2. Implement `packages/backend/src/services/chunk-sizing.ts`.
3. Replace the hard-coded `DEFAULT_CHUNK_SIZE` reference in
   `generateTasksForAttack` with a `pickChunkSize` call.

### Phase 3 — Diagnostic logging

1. Extend tests in `packages/backend/tests/unit/tasks.test.ts` to assert
   that the four skip reasons are emitted (verify via mocked
   `logger.info` calls).
2. Refactor `assignNextTask` to use the internal discriminated union;
   keep the exported contract (`AssignedTask | null`) stable.

### Phase 4 — Dynamic rebalancing

1. Extend `reassignStaleTasks` tests to cover:
   - Stale task with 0% progress → reset to pending unchanged
   - Stale task with 40% progress → workRange trimmed
   - Stale task with progress `>= workRange.total` → marked `failed`
   - Long remaining range → re-chunked into multiple pending tasks
2. Implement the rebalance branch in `reassignStaleTasks`.

### Phase 5 — Integration smoke + GOTCHAS update

1. Integration assertion in `tests/integration/smoke.test.ts` (or new):
   campaign with mixed wordlist + rule attack generates chunks whose
   sizes vary with the median fleet benchmark.
2. Add a GOTCHAS bullet on the bigint/string boundary for keyspace
   values (don't `Number.parseInt` keyspaces > 2^53; use `BigInt`).
3. Update `spec/tickets/Task_Distribution_&_Assignment.md` cross-link
   to point at this issue for the "Advanced keyspace optimization"
   out-of-scope item that's now in scope.

## Test Plan

| Layer | File | Coverage |
|-------|------|----------|
| Unit  | `tests/unit/keyspace.test.ts` (new) | Six hashcat mode formulas + unknown-mode null; mask-charset parser; bigint precision boundary |
| Unit  | `tests/unit/chunk-sizing.test.ts` (new) | Median selection, floor/ceiling, empty-benchmark fallback, full-keyspace cap |
| Unit  | `tests/unit/tasks.test.ts` (extend) | Skip-reason emission for all four reasons; rebalance branch on stale tasks with partial progress; > 100% progress → failed |
| Integration | `tests/integration/smoke.test.ts` (extend) | Generate tasks for a wordlist+rule attack with mocked benchmarks → chunk count and per-chunk size proportional to fleet median |

Target ≥ 80% coverage on each new file. Each phase ships only when its
test phase is green.

## Files to Modify/Create

**New (≤ 300 lines each, KISS):**

- `packages/backend/src/services/keyspace.ts` — pure mode-by-mode
  keyspace calculator
- `packages/backend/src/services/chunk-sizing.ts` — pure chunk-size
  picker
- `packages/backend/tests/unit/keyspace.test.ts`
- `packages/backend/tests/unit/chunk-sizing.test.ts`

**Modify:**

- `packages/backend/src/services/tasks.ts` — wire new helpers into
  `generateTasksForAttack`, `assignNextTask`, `reassignStaleTasks`;
  add skip-reason logging
- `packages/backend/tests/unit/tasks.test.ts` — coverage for new
  branches
- `packages/backend/tests/integration/smoke.test.ts` — proportional
  chunking smoke
- `GOTCHAS.md` — bigint/keyspace string boundary note
- `spec/tickets/Task_Distribution_&_Assignment.md` — cross-link

**Schema:** No changes. `attacks.keyspace varchar(255)`,
`tasks.workRange jsonb`, `tasks.progress jsonb`, and
`agent_benchmarks.speed_hs bigint` already carry the data we need.

## Success Criteria

Mapped 1:1 to the issue's acceptance criteria:

- Attacks divided into keyspace-based task chunks
  - `calculateAttackKeyspace` computes the keyspace from attack
    metadata at generation time. The computed value is consumed
    directly by `generateTasksForAttack` for chunking. The result is
    not persisted back to `attacks.keyspace` yet; that follow-up
    requires resolving when to store (at attack create vs. at task
    generate) and is tracked separately.
- Chunk sizes account for agent benchmark data
  - `pickChunkSize` uses fleet-median `speedHs * 60s`, clamped between
    MIN/MAX bounds and capped at MAX_CHUNKS_PER_ATTACK to bound DB-row
    materialization. Verified by unit + integration tests.
- Atomic task claiming (no double-assignment)
  - Already shipped (`FOR UPDATE SKIP LOCKED` via raw SQL CTE).
    Verified by existing tests.
- Progress tracked as keyspace units
  - `tasks.progress.keyspaceProgress` is the source of truth across the
    assignment, rebalance, and campaign-aggregate paths. The value is
    absolute keyspace units cracked within the task's
    `workRange.total`; `updateCampaignProgress` divides by total to
    derive the [0, 1] fraction the dashboard consumes.
- Remaining keyspace redistributable on fleet changes
  - `reassignStaleTasks` rebalance branch trims `workRange.start`
    forward by reported progress (single-task re-pend). The
    fleet-median split-on-rebalance from this spec's text is a
    follow-up; the current branch always re-pends a single task with
    the trimmed range.
- Diagnostic logging
  - `assignNextTask` emits one info-level `task_assignment` log per
    claim attempt with `{agentId, projectId, reason}`.

## Out of Scope

Lifted verbatim from the issue, plus a few that came up during
research:

- **Task preemption** — explicitly the next issue (#97).
- **Cross-engine routing** — JtR-aware keyspace + benchmark
  distribution is deferred.
- **Persistent skip-reason history** — log only, don't write a new
  table.
- **Wordlist/rulelist line-count cache** — assume `word_lists.line_count`
  is populated by ingest; out of scope to backfill or recompute.
- **Adaptive `targetSeconds`** — start at a fixed 60s constant. Tuning
  knob added later if the fleet's actual chunk wall times drift.
- **Frontend UI for chunk sizing** — operators don't see this layer;
  it's an internal scheduler concern.

---

**References**
- Issue: https://github.com/EvilBit-Labs/hash_hive/issues/96
- CipherSwarm parent: CipherSwarm issue #622 (priority:critical)
- Dep #93 (Agent Benchmarking): shipped — `agent_benchmarks` table +
  `getAgentBenchmarkForMode` are in main.
- Blocks #97 (Task Preemption) — preemption needs the chunk-sizing
  primitives this issue ships.
- Existing spec ticket: `spec/tickets/Task_Distribution_&_Assignment.md`
  (already shipped; "Advanced keyspace optimization" was deferred there
  and is now this issue).
- GOTCHAS.md:39 — `FOR UPDATE SKIP LOCKED` workaround already documented.
