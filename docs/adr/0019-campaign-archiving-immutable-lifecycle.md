# ADR-0019: Immutable-on-use lifecycle - archive, never delete, once a record leaves draft

**Date**: 2026-06-20
**Status**: accepted (forward design; implementation pending)
**Deciders**: Project owner (@unclesp1d3r), AI pair (Claude Code)
**Relates to**: [ADR-0010](0010-schema-first-drizzle-zod.md); GitHub issue #207
(Results-filter tests, parked behind this decision)

## Context

Campaigns record which campaign cracked each hash via `hash_items.campaign_id` - the
forensic attribution the results view depends on. Hard-deleting a campaign that has
cracked hashes would destroy that link. The current schema guards against this crudely:
`deleteCampaign` is draft-only (`packages/backend/src/services/campaign-dashboard.ts:151`),
so any non-draft campaign returns 409 and cannot be removed at all.

The result is that finished campaigns (`completed`, `cancelled`)
accumulate in the active dashboard view with no way for an operator to retire them, even
though operators run many concurrent campaigns and decluttering the active view is a real
need. The intended design - always planned, not yet implemented - is an immutability-on-use
rule: a record is freely deletable only while it is draft and unused; once it transitions
out of draft it becomes permanent and can only be archived.

## Decision

- **Immutability-on-use is a general lifecycle rule**, not a campaign-specific feature. A
  draft, unused record (no cracks, no referencing campaigns or dependents) is hard-deletable.
  Once a record leaves draft it is permanent: archive is its only removal path. The rule
  governs campaigns, hash lists, and wordlists/resources. Campaign archiving is the first
  implementation; resources adopt the same rule in follow-on work.

- **Two orthogonal markers.** A **permanence marker** (boolean, false in draft, latched true
  one-way on the first transition out of draft, never cleared) governs deletability. A separate
  **archive marker** (nullable timestamp, set on archive, cleared on restore) governs whether
  the record is currently hidden from active views. They encode different facts - a
  just-completed campaign is permanent but not yet archived - so a single flag cannot carry
  both. The archive marker is a timestamp rather than a boolean so it also records when
  archiving happened.

- **Permanence governs deletion, not editing.** A non-draft campaign still accepts attacks
  being added and removed; only deletion of the record is forbidden.

- **Archive scope for campaigns**: the done states (`completed`, `cancelled`) are archivable;
  `running`/`paused` (live) and `draft` (pristine or reopened for editing) are not — cancel or
  complete the campaign first. `exhausted`/`failed` are *task* statuses, not campaign ones.
  Archive is reversible via restore; draft-only hard-delete is preserved, tightened with an
  `is_permanent = false` guard so a campaign reopened to `draft` for editing stays non-deletable.

- **Results are unaffected at the query level.** The results query already scopes via
  `hash_lists.project_id` and LEFT JOINs campaigns
  (`packages/backend/src/routes/dashboard/results.ts:101-211`), so archived campaigns' cracks
  keep attributing correctly with the campaign row still present. No results-query change.

## Alternatives Considered

### Alternative 1: Overwrite `status` with an `archived` value

- **Why not**: a campaign that completed would lose the fact that it completed, and restore
  would have no true state to return to. The terminal status and the archived state are
  independent facts and need independent storage.

### Alternative 2: Single boolean for both permanence and archive

- **Why not**: permanence latches automatically on leaving draft and never clears; archive is a
  manual, reversible action that happens later. A permanent-but-not-archived campaign is a normal
  state one flag cannot represent.

### Alternative 3: Derive deletability from `status != 'draft'` with no stored marker

- **Why not**: an explicit one-way latch states intent directly and is robust to future status
  changes; deletability should not silently shift if the status vocabulary evolves.

### Alternative 4: Keep draft-only delete with no archive (status quo)

- **Why not**: leaves operators with no way to retire finished campaigns; the active view grows
  without bound.

## Consequences

### Positive

- Operators can retire finished campaigns without destroying crack attribution; the active view
  stays clean; archive is reversible.
- The forensic record is permanent by construction once a campaign has run.
- Results need no change - existing project scoping already preserves archived attribution.

### Negative

- Two new columns and a backfill (existing non-draft campaigns latch permanent) at migration time.
- "Removed" is now two concepts (deleted vs archived) that the UI and any tooling must distinguish.
- The general rule is stated here but only campaigns are implemented now; resources remain on the
  old behavior until their follow-on work lands.

Full requirements, acceptance examples, and scope boundaries:
`docs/brainstorms/2026-06-20-campaign-archiving-requirements.md`.
