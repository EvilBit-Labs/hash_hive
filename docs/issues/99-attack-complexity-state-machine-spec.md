# Issue #99 — Attack Complexity Calculation & State Machine

> **Status:** Spec — ready for implementation · authoritative implementation plan: `docs/plans/2026-06-15-001-feat-attack-complexity-state-machine-plan.md`
> **Priority:** P1 (Important CipherSwarm parity) · **Story Points:** 5 · **Labels:** backend, campaign-management, gap-analysis
> **Blocked by:** None · **Blocks:** None
> **Related:** #96 (Keyspace Distribution, CLOSED — shipped `calculateAttackKeyspace`), #97 (Task Preemption, shipped — overlaps on `paused`), #98 (Hash Items), #100 (Campaign ETA), #22 (Campaign/Attack Management)
> **Source:** CipherSwarm parity — Attack AASM state machine + `CalculateMaskComplexityJob` (parity is the floor; see Technical Approach for where we improve on it)

## Issue Summary

CipherSwarm models each attack with an AASM state machine (`pending → running → completed/exhausted/failed/paused`) and a complexity engine that estimates total keyspace and duration to drive progress bars, ETA, and resource planning. hash_hive has the raw materials but none of the integration: the `attacks.status` column exists yet is never transitioned, the `attacks.keyspace` column exists yet is never persisted, and the pure keyspace calculator from #96 runs only transiently inside task generation. This issue derives attack status at read time, persists keyspace, fills the missing wordlist/rulelist line counts via an async job, and surfaces a progressive per-attack ETA in the dashboard payload.

## Problem Statement

1. **`attacks.status` is a dead column.** Declared `varchar(20) NOT NULL DEFAULT 'pending'` (`packages/shared/src/db/schema.ts:471`) but no code ever writes it — there is no transition logic, no rollup. Every attack sits at `pending` forever regardless of its tasks' real lifecycle. (Contrast: campaigns have `VALID_TRANSITIONS` + `transitionCampaign`, `services/campaigns.ts:565`; tasks have a full status vocabulary.) Crucially, nothing queries attacks *by* status — both readers (`pages/campaign-detail.tsx`, `components/features/campaign-dag-view.tsx`) consume it from the campaign detail payload.
2. **`attacks.keyspace` is never persisted.** `calculateAttackKeyspace` (`services/keyspace.ts:76`, pure, modes 0/1/3/6/7) is computed transiently inside `generateTasksForAttack` (`services/tasks.ts:187–192`) for chunking only. The attack row's `keyspace` column stays `null`, so nothing can show keyspace/ETA before — or independently of — task generation.
3. **No duration / ETA per attack.** Fleet benchmarks exist (`getFleetBenchmarksForMode → { speedHs }[]`, `services/tasks.ts:63`) and chunk sizing already consumes them, but no code turns keyspace ÷ fleet hash-rate into an attack-level duration estimate.
4. **No async complexity path, and its prerequisite hook is missing.** `wordLists.lineCount` / `ruleLists.lineCount` — the inputs the calculator needs for modes 0/1/6/7 — are **never populated at runtime**. Both resource-upload completion paths set `status:'ready'` without computing a line count (`services/resources.ts:613` direct, `:831` chunked); only `scripts/migrate-data.ts` sets it. So for any normally-uploaded wordlist/rulelist, `calculateAttackKeyspace` returns `null` and the system silently falls back to a single placeholder task (`services/tasks.ts:195–210`). Complexity is effectively inert in production today.
5. **No attack-status surface.** `campaignAttackRowSchema` (`packages/shared/src/schemas/index.ts:820`) carries a loose `status: z.string()` and no `keyspace`, no duration — the dashboard cannot render attack state or ETA.

## Technical Approach

Derive attack status **purely at read time** in the campaign detail payload from each attack's task aggregate + the campaign's status — no persisted status column, no projection writes. Persist keyspace onto the attack via the existing pure calculator (it is an input to task generation). Fill the missing line counts with an async, resource-keyed job that reuses the hash-list parser's download-and-count core. Derive a progressive per-attack duration on read from persisted keyspace + live fleet benchmarks. Surface status + keyspace + ETA on the attack row.

CipherSwarm uses a stored AASM event FSM on the Attack model. The faithful hash_hive translation is **not** a stored FSM: attack lifecycle is fully determined by task aggregates + campaign state, nothing consumes status as queryable/subscribable state, and both consumers read the detail payload. Read-deriving produces the same observable states with less machinery and no state-flip race — parity improved, not merely matched.

### Key design decisions

- **Status derived at read time, not persisted.** A persisted projection would need an elaborate "persist `exhausted`, upgrade to `completed` at read time" workaround solely to dodge a race: campaign auto-completion fires *inside* `updateCampaignProgress` (`shouldAutoCompleteCampaign`), so a projection writing the status column could observe a pre-flip `campaign.status`, persist `exhausted`, and never recompute. Removing the write removes the race — at read time the task aggregate and `campaign.status` are both settled. The derivation lives once in the detail-payload builder.
- **Drop the dead `attacks.status` column.** A column permanently `pending` while the API returns a derived status is a drift trap. The shared `attackStatusSchema` enum governs only the wire field — no DB column, no CHECK constraint. The column has three consumers, not two: the detail-payload mapping, two `status:'pending'` attack inserts (`campaigns.ts:401`,`:880`), and the Control API's `selectAttackSchema = createSelectSchema(attacks)` serialization (`routes/control/attacks.ts:70`). The inserts are removed and the Control endpoint gains the same derived status/keyspace/ETA so the surface stays whole.
- **Status vocabulary:** `pending | running | paused | completed | exhausted | failed`. **No `cancelled`** — campaign status is authoritative for cancellation (documented in Out of Scope).
- **`completed` vs `exhausted` is campaign-driven, resolved in the same read.** Cracks are campaign-shared (no per-attack crack attribution) and `updateCampaignProgress` already treats task `completed`/`exhausted` as equivalent for progress. So the only defensible per-attack distinction is "did the campaign finish early (all cracked) or run the keyspace out" — campaign state, read alongside the task aggregate. Terminal-success → `completed` when `campaign.status == 'completed'`, else `exhausted`.
- **`paused` precedence (overlaps #97):** live work over paused work, applied at read time. Any `running`/`assigned` → `running`; `pending` mixed with progress → `running`; only when no live work remains and a `paused` task exists → `paused`. A partially-preempted attack stays `running`. Two paths reach `paused`: #97 preemption sets `tasks.status='paused'` (task-count branch), and a **manual campaign pause sets no task status**, so the ladder maps `campaign.status == 'paused'` directly to attack `paused` — otherwise a manually-paused campaign would render its attacks `running`.
- **Keep keyspace persisted.** `generateTasksForAttack` reads `attack.keyspace` to chunk (`services/tasks.ts:187`), and computing it needs I/O (line counts). Status read-derived + keyspace persisted is the correct split. Persisting via the same `calculateAttackKeyspace` means generation consumes the stored value — one calculator, no divergence.
- **Async is justified by input-readiness, not cost.** The bigint multiply is cheap; the **line count** is what's missing (`lineCount` is never populated at runtime). The job exists to resolve that count from object storage and to keep batch campaign creation off the I/O path.
- **Reuse the parser's line-count core; key the count on the resource.** Extract "stream object from storage, iterate lines with the length cap" from `hash-list-parser.ts` into a shared util both call — do not make the parser worker handle wordlists (it owns `hashItems`). Key the line-count job on the *resource* so a wordlist shared by N attacks counts once; fan out the pure keyspace recompute per dependent attack.
- **Progressive ETA = time remaining, derived on read.** `estimatedSecondsRemaining` is the estimated time left on the run, counting down: `ceil(remaining_keyspace / Σ speedHs)` over `getFleetBenchmarksForMode`, where `remaining_keyspace = keyspace × (1 − fractionDone)`. Before any task runs (`fractionDone = 0`) it equals the full a-priori estimate; it shrinks as the keyspace is covered. `null` when uncomputable. Deriving remaining from keyspace coverage + fleet rate (not wall-clock elapsed) keeps a preempted attack's ETA stable rather than inflating. Carried as a `jsonSafeBigint` `number | string` union so astronomically large ETAs survive the wire.

### Read-time status derivation

Per attack, from one `COUNT(*) FILTER (WHERE status = …) … GROUP BY attack_id` over tasks, read with `campaign.status` in the same pass:

```
counts = grouped task counts for the attack; total = sum
if campaign.status == 'paused':     -> paused       # manual pause sets no task status; overrides task-level ladder
elif total == 0:                    -> pending      # not generated yet
elif running + assigned > 0:        -> running
elif pending > 0:
    -> pending  if pending == total                 # nothing started
    -> running  otherwise                           # mixed pending + done = in progress
elif paused > 0:                    -> paused       # only paused + terminal, no live work
else:  # all tasks terminal
    if failed > 0:                  -> failed
    elif campaign.status == 'completed': -> completed   # campaign finished early
    else:                           -> exhausted   # whole keyspace searched
```

Because the campaign status is read in the same pass, the `completed`/`exhausted` split is settled here — there is no persisted value to race against, so the ordering trap a persisted projection would face is structurally impossible.

### Complexity flow

- **Inline at attack create/update** (`createAttack`, `createCampaignWithAttacks`, `updateAttack`): resolve inputs (mode 3 needs the mask from `advancedConfiguration`; modes 0/1/6/7 need resource `lineCount`s). All present → `calculateAttackKeyspace` and persist `attacks.keyspace`. Any required `lineCount` null → leave keyspace null and best-effort enqueue a line-count job for the resource.
- **Line-count worker (resource-keyed):** for `{ resourceType, resourceId, projectId }` — count the resource via the shared util (newlines for wordlists; effective non-blank/non-`#`-comment lines for rule lists, since hashcat skips those and naive counting inflates the mode-0 multiplier), persist `lineCount`, then recompute and persist `attacks.keyspace` for every attack referencing that resource (pure fan-out). `jobId = linecount:${resourceType}:${resourceId}` **paired with `removeOnComplete:true, removeOnFail:true`** (terminal-eviction gotcha).
- **Cheap-path optimization:** the direct-upload completion path already holds the file `buffer` in memory (`services/resources.ts:598`) — count newlines there and persist `lineCount` synchronously, so the common case never needs the worker. Chunked/large uploads defer the count to the worker.
- **Enqueue triggers:** (a) attack create/update with uncomputable inputs; (b) a resource transitioning to `ready` enqueues a count for that resource (driving the per-attack recompute fan-out).

## Implementation Plan

The authoritative, unit-by-unit plan with test scenarios lives in `docs/plans/2026-06-15-001-feat-attack-complexity-state-machine-plan.md` (six implementation units, schema-first). In brief:

1. Shared contract: `attackStatusSchema` (wire-only enum); extend `campaignAttackRowSchema` with `keyspace` + `estimatedSecondsRemaining`; drop the dead `attacks.status` column (generated migration).
2. Shared line-count util extracted from `hash-list-parser.ts`.
3. Keyspace persistence (inline at create/update) + progressive duration helpers (`jsonSafeBigint` in `_internals.ts`) + direct-upload inline `lineCount`.
4. Line-count queue + resource-keyed worker (shared util; per-attack keyspace fan-out) + best-effort enqueue triggers.
5. Read-derive status + progressive ETA in the campaign detail payload (one grouped aggregate).
6. Frontend attack-row keyspace/ETA column + attack status-badge states.

## Test Plan

- **Status derivation (in the payload):** all-pending → `pending`; any running → `running`; mixed pending+completed → `running`; only paused+terminal → `paused`; all terminal-success + campaign completed → `completed`; all terminal-success + campaign not completed → `exhausted`; any failed → `failed`; preemption mix (paused+pending) → `running`; zero tasks → `pending`.
- **Ordering (regression):** a campaign that just reached `completed` renders its terminal-success attacks as `completed` in the same payload read — the bug class a persisted design risked, now structurally impossible.
- **Keyspace persistence:** mode 3 mask persists inline; modes 0/1/6/7 with `lineCount` present persist inline; null `lineCount` leaves keyspace null + enqueues a count; generation consumes the stored value.
- **Line-count util:** counts newlines, respects the length cap; rule predicate excludes blank/`#`-comment lines, wordlist predicate counts them; parser hash-item counts unchanged after the refactor.
- **Line-count worker:** resolves null `lineCount`, persists it, recomputes keyspace for each dependent attack; a shared resource counts once and fans out; dedup jobId set with `removeOnComplete/removeOnFail`.
- **Duration:** a-priori `keyspace / Σ speedHs` ceils; null keyspace → null; empty fleet → null; bigint keyspace beyond `2^53` handled (decimal string, not float); progressive blend returns a-priori until a task is running.
- **Triggers:** resource `→ ready` enqueues a count; attack create with all counts present does not enqueue; an enqueue throw never fails the originating op.
- **Contract — payload:** validates against the extended `campaignAttackRowSchema`; one aggregate query for N attacks (no N+1); mocks mirror service `ReturnType`, not the route schema (AGENTS.md).

## Success Criteria

- [ ] Attack status is derived at read time and reflects its tasks' real lifecycle (`pending → running → completed/exhausted/failed/paused`); the dead `attacks.status` column is dropped
- [ ] `attacks.keyspace` is persisted at create when computable; async otherwise; generation consumes the stored value
- [ ] The resource-keyed line-count worker resolves missing wordlist/rulelist `lineCount` from object storage (effective count for rule lists) via a shared util, then recomputes keyspace for dependent attacks; deduped with terminal eviction
- [ ] A progressive per-attack `estimatedSecondsRemaining` ETA (time left, counting down as the keyspace is covered) appears in the campaign detail payload and attack table
- [ ] Attack status is display-only; nothing queries attacks by status
- [ ] `paused` precedence keeps derived status stable under preemption churn (#97 interop)
- [ ] `just ci-check` green; agent API unchanged

## Out of Scope / Known Limitations

- **Resource line-counting as a general subsystem.** The worker counts lines for resources an attack needs; a standalone resource-parse pipeline with its own status (`parsing`) is deferred to file-management work (#155/#156).
- **Per-attack crack attribution.** Hash items are campaign-shared; `completed` vs `exhausted` is decided by campaign completion, not by which attack landed a crack.
- **`cancelled` attack status.** Cancellation lives at the campaign level; attacks under a cancelled campaign reflect their derived status.
- **Attack-transition event hook.** Nothing consumes attack status as queryable/subscribable state; the single source of truth is the detail-payload aggregate. A future consumer needing attack-transition reactions must add a derivation/event there. Deferred per YAGNI.
- **Recurring / scheduled recompute.** Keyspace recomputes on create/update and resource-ready; status and duration are derived live on every read, so a stale estimate cannot occur.
- **Mask keyspace beyond standard `?`-tokens.** Inherited from `calculateAttackKeyspace`: unknown tokens / `.hcmask` files return `null` and fall back to the placeholder-task path.
