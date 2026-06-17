# Residual Review Findings — `feat/masklist-keyspace` (#231)

Source: `ce-code-review mode:autofix` over the masklist-keyspace branch. All
`safe_auto` findings were applied in commit `fix(review): apply autofix
feedback`. The finding below was deliberately **not** fixed in this PR — it
needs a schema-level design decision that is out of scope for #231 — and is
recorded here as the durable handoff sink (no open PR existed at handoff time).

## Residual Review Findings

### P3 — Uncomputable masklist re-enqueues line-count on every campaign trigger

- **Severity:** P3 (low)
- **Reviewer(s):** ce-reliability-reviewer (REL-2), ce-correctness-reviewer (RR-1)
- **Location:** `packages/backend/src/services/resources/line-count-trigger.ts` — `enqueueLineCountForUncountedResources`
- **Finding ID:** `line-count-trigger.ts:enqueueLineCountForUncountedResources:masklist-null-reenqueue`

**Problem.** When a masklist's keyspace is genuinely uncomputable (inline
custom-charset definition, `?1`-`?4` reference, unknown `?`-token, or an
over-length line), `sumMasklistKeyspace` returns `null` and `mask_lists.keyspace`
is persisted as `null` (#231). That null is permanent. But the uncounted-resource
sweep selects masklists to (re)enqueue via `maskKeyspaceIsNull` (`keyspace IS
NULL`), so every campaign event that fires the sweep re-enqueues a line-count job
for an uncomputable masklist. The job re-streams the file, re-derives `null`,
re-persists `null`, and fans out again — wasteful work that never converges.

**Impact.** Low and **bounded**: jobs are deduped per resource via a
deterministic `jobId` within the dedup window, and the sweep only fires on
campaign lifecycle events (not a timer). Keyspace results stay correct (`null` →
dependent mode-3 attacks fall back to the single-task path). This is repeated
wasteful recompute, not incorrect behavior or unbounded growth.

**Why deferred (not fixed in #231).** The clean fix needs to distinguish "not yet
counted" from "counted, genuinely uncomputable" without overloading the `keyspace
IS NULL` predicate. Both quick hacks were rejected as messy/under-designed for
this PR:

- A sentinel value in `keyspace` (e.g. `-1` / `"uncomputable"`) pollutes a
  numeric-decimal-string column and leaks a magic value into every reader.
- A separate `keyspace_state` column is a schema change that warrants its own
  design and is out of scope for #231.

**Suggested fix.** Introduce an explicit "sized but uncomputable" state — likely a
`mask_lists.keyspace_state` enum (`pending` | `computed` | `uncomputable`) — and
change the sweep predicate to `keyspace_state = 'pending'`. Backfill existing rows
from the current `keyspace` value.

**Evidence.**

- `packages/backend/src/services/resources/line-count-trigger.ts` —
  `enqueueLineCountForUncountedResources` uses `maskKeyspaceIsNull` (`keyspace IS
  NULL`) to select masklists to enqueue.
- `packages/backend/src/services/keyspace.ts` — `sumMasklistKeyspace` returns
  `null` for any uncomputable line (correct, permanent).
- `packages/backend/src/services/resources/masklist-keyspace.ts` —
  `computeAndPersistMasklistKeyspace` persists `null` and fans out each time.
