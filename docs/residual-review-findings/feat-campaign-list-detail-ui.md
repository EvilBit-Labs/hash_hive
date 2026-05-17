# Residual Review Findings — feat/campaign-list-detail-ui

Source: ce-code-review autofix run `20260517-192224-7e606f82` against
branch `feat/campaign-list-detail-ui` (base: `main`, merge-base
`249cb61`).

Plan: `docs/plans/2026-05-17-001-feat-campaign-list-detail-ui-plan.md`.

Reviewers dispatched: correctness, security, testing, maintainability.

## Applied in this PR

| # | Severity | File | Title |
|---|---|---|---|
| F1 | P1 | `packages/frontend/src/hooks/use-campaigns.ts` + `pages/campaigns.tsx` + `pages/campaign-detail.tsx` | Refactor `useCampaignLifecycle` / `useCampaignDelete` to accept `campaignId` at mutate-time. Fixes a real bug where Pause from the list fired against `/campaigns/0/lifecycle` because no `setConfirm` rerender preceded the click. |
| F2 | P2 | `packages/backend/src/services/tasks.ts:892` | Add `campaignId` to the `emitTaskUpdate` call on the 0%-progress stale-reset branch. Without it the frontend invalidation map falls through to broad warn-and-broad-invalidate. |
| F3 | P2 | `packages/backend/src/services/campaigns.ts` (`listActiveAgentsByCampaign`) | Add `ORDER BY tasks.id` before `LIMIT 50` so the visible subset is deterministic across refreshes. |
| F4 | P3 | `packages/frontend/src/lib/campaign-eta.ts` | Rewrite `computeEta` so the formula actually uses aggregate hash-rate. The previous implementation accumulated `aggregateSpeed` but only consulted it as an early-return guard; the actual rate was `activeAgentCount / 60` independent of speed. |

## Deferred to follow-up

These findings were valid but did not get autofixed. Filing here so they
are durable; convert to issues / tickets when scheduled.

### P2 (test coverage)

- **R1.** Service-layer tests for `getCampaignTaskStats`,
  `listActiveAgentsByCampaign`, and `deleteCampaign` in
  `packages/backend/src/services/campaigns.ts` (lines 195-345). The
  route tests in `dashboard-campaigns-routes.test.ts` mock the service
  wholesale; service behavior — status bucketing, FK ordering inside
  the delete transaction, 50-row cap, cross-project guard — has zero
  coverage. Adding service tests requires either a real DB harness or
  careful Drizzle mocking.
- **R2.** Tests asserting `emitTaskUpdate` is called with `campaignId`
  from `updateTaskProgress`, `handleTaskFailure` (both retry and
  permanent-failure branches), and `reassignStaleTasks` (overrun,
  partial, and 0%-progress branches). The behavioral change went in
  without an assertion, so a future refactor could regress it without
  any test failing.
- **R3.** `useEvents` campaign-scoped invalidation
  (`packages/frontend/src/hooks/use-events.ts:103-215`) is untested.
  Both the happy path (campaignId present → targeted invalidation) and
  the fallback (missing campaignId → broad invalidation + warn) need
  assertions.

### P3 (correctness, maintainability, test polish)

- **R4.** `computeDepths` cycle/orphan fallback in
  `packages/frontend/src/components/features/campaign-dag-view.tsx:99-105`
  starts at 0, which collides with real depth-0 roots. Unreachable
  attacks visually intermix with roots in the same row. Fix: start the
  fallback at `max(depths)+1` or mark unreachable nodes with a distinct
  badge.
- **R5.** Three near-duplicate progress readers
  (`readProgress` in `pages/campaigns.tsx`, `readPercentage` in
  `pages/campaign-detail.tsx`, and `readPercentage` with an additional
  `keyspaceProgress` branch in
  `components/features/campaign-agents-section.tsx`) plus the existing
  `normalize()` in `progress-bar.tsx`. Backend envelope changes will
  silently drift. Consolidate into a shared
  `packages/frontend/src/lib/campaign-progress.ts`.
- **R6.** `computeEta` happy-path test
  (`packages/frontend/tests/lib/campaign-eta.test.ts:67-78`) only
  asserts `not toBe('--')`. With the formula now deterministic after
  F4, pin the exact formatted output string.
- **R7.** `getCampaignTaskStats` does not bucket the `cancelled` task
  status. `computeEta`'s `remaining = total - completed - failed`
  formula therefore overcounts when a campaign has cancelled tasks.
  Either add a `cancelled` bucket to `CampaignTaskStats` or include
  cancelled in `completed`.
- **R8.** `ProgressBar`'s `value <= 1 ? value * 100 : value` heuristic
  in `packages/frontend/src/components/ui/progress-bar.tsx` would
  render a legitimate 1.05 fractional input as 1% instead of clamping
  to 100%. Latent today because backend clamps to ≤ 1, but the API is
  misleading. Better to require callers to pass a known scale.
- **R9.** `listActiveAgentsByCampaign` does not filter on
  `agents.status`. Offline / error agents whose tasks have not yet
  been reassigned still appear in the active list until the stale-task
  reaper runs.
- **R10.** Confirm-click + mutation-failure ErrorBanner paths in
  `tests/pages/{campaigns,campaign-detail}.test.tsx` are untested.
  The modal-open path is asserted, but the destructive-action
  failure-recovery surface is not.

### Advisory (not actionable directly)

- M4: Status color taxonomy duplicated between
  `status-badge.tsx` and `campaign-dag-view.tsx`'s `STATUS_COLORS`.
- M5: `formatSpeed` in `campaign-agents-section.tsx` differs slightly
  from `progressSpeed` elsewhere — converge rounding behavior.
- M7: `_deps` dynamic-import indirection in `services/campaigns.ts` is
  a test-mock workaround that production requests pay forever.
- M8: `CampaignProgressShape` re-derived inline three times instead of
  imported from `use-dashboard.ts`.
- M10: Three error-shape conventions coexist in `services/campaigns.ts`
  (`{error: 'NOT_DRAFT'}`, `{error: 'NOT_FOUND'}`, and plain
  `{error: 'msg'}`).
- `deleteCampaign` does not delete from `hash_items`. FK references
  to campaigns / attacks / tasks default to RESTRICT; safe for true
  draft campaigns (which by definition have no hash_items yet) but an
  invisible coupling worth documenting.
- The agent-list-detail-ui PR (#141) shipped a parallel per-feature
  invalidation map pattern; future refactor candidate to consolidate.
