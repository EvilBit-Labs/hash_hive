# Residual Review Findings — feat/campaign-list-detail-ui

Source: ce-code-review autofix run `20260517-192224-7e606f82` plus the
pr-review-toolkit second-pass run (silent-failure-hunter, pr-test-analyzer,
comment-analyzer, type-design-analyzer, code-reviewer) against branch
`feat/campaign-list-detail-ui` (base: `main`, merge-base `249cb61`).

Plan: `docs/plans/2026-05-17-001-feat-campaign-list-detail-ui-plan.md`.

## Status: all actionable findings resolved

All valid review findings have been addressed in this PR across these
fix commits:

- `fix(review): apply autofix feedback` (4f67410) — first-round autofix
  (F1 Pause id=0 bug, F2 missing campaignId on stale-reset, F3 stable
  ORDER BY on active agents, F4 computeEta formula).
- `fix(review): second-round PR review fixes` (af21229) — bulk pass:
  cross-project cache leakage, WS polling fallback symmetry, delete WS
  emit, useCampaignDelete response validation, invalid-id URL guard,
  catch-block logging, cancelled-task bucket fix, DeleteCampaignResult
  discriminator, eight wire-shape types and the priorityBucket helper
  moved to @hashhive/shared, three duplicated progress readers
  consolidated into lib/campaign-progress.ts, comment cleanups, plus
  twelve new tests covering the contract surfaces.
- `fix(review): error handling and diagnostics` (this commit) — DELETE
  route try/catch with structured logging, listActiveAgentsByCampaign
  warn-on-malformed-speed, CampaignDagView fallback-depth fix +
  protocol-drift warn, PriorityBadge renders raw value for custom
  integer priorities.

Closed in this PR:

### From ce-code-review autofix (4 fixes)

- **F1 (P1)** — `useCampaignLifecycle` / `useCampaignDelete` now take
  `campaignId` at mutate-time. Fixes Pause from the list firing against
  `/campaigns/0/lifecycle`.
- **F2 (P2)** — `emitTaskUpdate` on the 0%-progress stale-reset branch
  in `reassignStaleTasks` now carries `campaignId`.
- **F3 (P2)** — `listActiveAgentsByCampaign` orders by `tasks.id`
  before `LIMIT 50`.
- **F4 (P3)** — `computeEta` now actually uses aggregate hash-rate; the
  formula's `HASHES_PER_TASK_PROXY` constant carries the v1 keyspace
  rationale.

### From second-round PR review (substantive bugs)

- **I1 (P1)** — `useCampaignDetail` cache key now includes
  `selectedProjectId` and gates the query on `Number.isInteger(id) &&
  id > 0 && !!selectedProjectId`. Closes the cross-project cache
  leakage path.
- **I2** — WS polling fallback in `use-events.ts` now invalidates
  `['campaign']` symmetric to `['agent']` / `['agent-errors']` /
  `['agent-tasks']`.
- **I3** — `deleteCampaign` emits a `campaign_status` event after the
  transaction so other tabs drop the deleted campaign without waiting
  for the next poll.
- **H4** — `useCampaignDelete` throws when the server returns
  `deleted: false`; also invalidates `dashboard-stats` locally so the
  originating tab's counters update immediately.
- **M6** — `campaign-detail` page now renders an explicit "Invalid
  campaign id in URL" error when the route param is non-numeric,
  instead of an eternal loading spinner.
- **H1** — every catch block in `campaigns.tsx` / `campaign-detail.tsx`
  now `console.error`s with structured context.
- **R7** — `getCampaignTaskStats` now folds `cancelled` tasks into the
  `failed` bucket so the ETA `remaining = total - completed - failed`
  math stays correct.
- **C1+C2** — `DELETE /:id` route wraps the `deleteCampaign`
  transaction in try/catch with a structured `logger.error` log
  carrying `campaignId`, `projectId`, and `userId`. Returns a
  `DELETE_FAILED` envelope instead of a bare 500.
- **M2** — `listActiveAgentsByCampaign` now warns when an agent
  reports a non-finite `speedHs`. ETA still treats the agent as
  contributing zero; the warn surfaces a misbehaving agent before its
  zero contribution skews the dashboard silently.
- **M5** — `computeDepths` in `CampaignDagView` now assigns fallback
  depths after `max(resolved)+1` so unresolved nodes don't visually
  collide with real depth-0 roots; emits a `console.warn` listing the
  unresolved attack ids so cycles / orphan dependencies become visible.
- **S1** — `PriorityBadge` renders the raw priority value (e.g.,
  "priority 3") for integers outside the canonical 1/5/10 set so
  operators can tell custom values apart from real "normal" rows.

### From type-design (F1-F5)

- **F1+F4** — `CampaignTaskStats`, `CampaignActiveAgent`,
  `CampaignSortField`, `CampaignSortOrder`, `CampaignLifecycleAction`,
  `CampaignPriorityBucket`, plus the `CAMPAIGN_PRIORITY` const and
  `priorityBucket` helper now live in `@hashhive/shared`. Backend
  service and frontend hooks import from one source of truth.
- **F2** — `CampaignActiveAgent.progress` aligned to `unknown` across
  the boundary (backend was `unknown`, frontend was wrongly narrowed
  to `Record<string, unknown> | null`).
- **F3** — `DeleteCampaignResult` uses a single `kind` discriminator
  so the route handler is an exhaustive `switch` instead of
  `'error' in result` narrowing.
- **F5** — Priority `{1, 5, 10}` mapping centralized in
  `@hashhive/shared.priorityBucket`. `PriorityBadge` re-exports the
  helper from shared.

### Test additions (closes R1-R3, R4, R6, R10)

- `tests/hooks/use-campaigns.test.tsx` — direct mutation tests for
  `useCampaignLifecycle` and `useCampaignDelete`. Pins the
  mutate-time `campaignId` contract and the response-validation guard.
- `tests/components/campaign-dag-view.test.tsx` extended with a true
  cycle and an orphan-dependency case.
- `tests/lib/campaign-eta.test.ts` extended with a pinned-magnitude
  output assertion and a negative-remaining defensive guard.
- `tests/lib/campaign-progress.test.ts` — coverage for the
  consolidated progress readers.
- `tests/pages/campaigns.test.tsx` extended with a 409 NOT_DRAFT
  ErrorBanner test.
- `tests/pages/campaign-detail.test.tsx` extended with a 500
  lifecycle-failure ErrorBanner test and an invalid-id URL test.

### Comment cleanup

- Dropped PR/plan references from test docstrings.
- Removed bug-history parentheticals from page and hook code.
- Removed JSX section banner comments that restated the component
  name immediately below.
- Removed the speculative claim in `PriorityBadge` JSDoc about custom
  priorities being "rejected at the list filter boundary".
- Renamed the `computeDepths` JSDoc from "BFS" to "iterative
  relaxation" to match the implementation.
- Tightened `CampaignAgentsSection` JSDoc to reference the symbol name
  (`listActiveAgentsByCampaign`) instead of the U2 task pointer.

### Closed in third round

- **H3** — `use-events.ts` now throttles the missing-`agentId` /
  missing-`campaignId` warnings via `warnDriftOnce(scope, eventType)`
  with a 60s cooldown per scope+type. A misbehaving backend can no
  longer flood the console; the first warn per drift signature still
  surfaces the problem.
- **S3** — `CampaignDagView` size is now content-aware
  (`estimateHeight` between 320px and 640px) and `panOnDrag={true}`
  so operators can reach nodes that fall outside the initial fitView.
  Node dragging stays disabled — pan is a viewport-only operation.
- **S4** — `getCampaignTaskStats`, `listActiveAgentsByCampaign`,
  `deleteCampaign`, and the `DeleteCampaignResult` type moved into
  `services/campaign-dashboard.ts`. `services/campaigns.ts` is back
  under the 800-line guideline (now 686 lines from 892). Re-exports
  preserve the existing import path for callers and tests.
- **Q4** — The isolated-phase skip stub in
  `dashboard-campaigns-routes.test.ts` no longer passes silently when
  the suite runs outside its phase. It now `console.warn`s and asserts
  on the env gate so a CI misconfiguration cannot drop the route
  coverage while still reading green.
