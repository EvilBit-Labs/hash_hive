// Side-effect import: ensures `.openapi()` is on the zod prototype
// before any schema below is constructed. Mirrors `schemas/index.ts`
// — both entrypoints construct exported schemas, so both must trigger
// the extension. The patch is idempotent.
import '../openapi-extension.js'
import { z } from 'zod'

// ─── Campaign Lifecycle Status ──────────────────────────────────────

/**
 * Canonical campaign lifecycle status. Mirrors the persisted
 * `campaigns.status` column and the lifecycle transition table at
 * `packages/backend/src/services/campaigns.ts` (`VALID_TRANSITIONS`).
 * The transition table is domain logic and is not encoded in this
 * schema — adding a new status here forces both the dashboard wire
 * shape and the transition table to be updated in the same change.
 */
export const campaignStatusSchema = z.enum(['draft', 'running', 'paused', 'completed', 'cancelled'])

// ─── Task Bucketing ─────────────────────────────────────────────────

/**
 * Persisted task status literals — the values the `tasks.status`
 * column actually carries. Distinct from the operator-facing buckets
 * in `campaignTaskStatsSchema`: callers presenting task counts to
 * operators must run the persisted value through `TASK_DB_TO_BUCKET`
 * to coalesce `assigned → running`, `exhausted → completed`, and
 * `cancelled → failed` before reporting.
 */
export const taskDbStatusSchema = z.enum([
  'pending',
  'assigned',
  'running',
  'paused',
  'completed',
  'exhausted',
  'failed',
  'cancelled',
])
export type TaskDbStatus = z.infer<typeof taskDbStatusSchema>

/**
 * Operator-facing task status buckets — the keys exposed on
 * `campaignTaskStatsSchema` and the dashboard stats `tasks` block.
 * `'pending'`, `'running'`, `'completed'`, `'failed'` are the four
 * buckets operators see; `'total'` is computed separately.
 */
export type TaskBucket = 'pending' | 'running' | 'completed' | 'failed'

/**
 * Single source of truth for collapsing persisted task statuses into
 * the operator-facing buckets that drive the dashboard cards and the
 * campaign detail page. Both `services/campaign-dashboard.ts`
 * `getCampaignTaskStats` and `routes/dashboard/stats.ts` consume this
 * mapping; if a future migration renames `'exhausted'` or adds a new
 * literal, this constant is the only place that needs updating.
 *
 * Rationale for the choices:
 *  - `assigned` and `running` both count as `running` — operators
 *    don't distinguish "picked up by an agent" from "actively
 *    computing" at the dashboard tier.
 *  - `exhausted` counts as `completed` — keyspace-exhausted tasks
 *    are terminal in the same way completed tasks are.
 *  - `cancelled` counts as `failed` — cancelled tasks are "not
 *    coming back" the same way failed tasks are. Keeps the ETA math
 *    `remaining = total - completed - failed` correct.
 */
export const TASK_DB_TO_BUCKET = {
  pending: 'pending',
  assigned: 'running',
  running: 'running',
  // `paused` (issue #97) is a preempted task waiting to resume -- no agent
  // is actively computing it, so it counts as `pending`, not `running`.
  // This keeps the ETA identity `remaining = total - completed - failed`
  // correct without minting a 5th operator-facing bucket.
  paused: 'pending',
  completed: 'completed',
  exhausted: 'completed',
  failed: 'failed',
  cancelled: 'failed',
} as const satisfies Record<TaskDbStatus, TaskBucket>

/**
 * Aggregate task counts for a campaign, bucketed into the
 * operator-facing states defined by `TASK_DB_TO_BUCKET`. Unknown
 * future DB statuses contribute only to `total` until the bucket
 * mapping is extended.
 *
 * `.strict()` so any new top-level key (e.g. a future `cancelled`
 * field if the bucketing rule changes) fails parse rather than
 * slipping through silently.
 *
 * Documented-but-not-enforced invariant:
 * `total >= pending + running + completed + failed`. The arithmetic
 * is not encoded in this schema because expressing it would require
 * a `.refine()` that runs on every parse for no runtime payoff.
 */
export const campaignTaskStatsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict()

// ─── Dashboard Stats Wire Shape ─────────────────────────────────────

/**
 * Project-scoped dashboard stat aggregates returned by
 * `GET /api/v1/dashboard/stats` (issue #161). Each non-`total` field
 * is a non-negative integer count of resources in that bucket within
 * the caller's selected project.
 *
 * Bucketing:
 *  - `agents` exposes every value in `agentStatusSchema` (online,
 *    offline, busy, error, benchmarked). `total` sums all five so
 *    the previous bug where `busy` and `benchmarked` agents silently
 *    disappeared from the count is closed.
 *  - `campaigns` exposes every value in `campaignStatusSchema`.
 *  - `tasks` reuses `campaignTaskStatsSchema` — see `TASK_DB_TO_BUCKET`
 *    for the DB-status → operator-bucket mapping.
 *  - `cracked` carries only `total`. Wrapped in an object (rather
 *    than a bare number) to leave room for future buckets such as a
 *    cracked-rate or per-window count without a breaking wire shape
 *    change. The source ticket for #161 calls those out as optional
 *    follow-up.
 *
 * Every inner object is `.strict()` so an unknown DB status literal
 * would fail `parse()` in the contract test rather than slip through
 * silently. The live route does NOT call `.parse()` on its own
 * response — it relies on the inferred-type annotation for
 * compile-time enforcement and on the contract test for CI-time
 * enforcement (see the read-endpoint contract at
 * `docs/solutions/conventions/dashboard-read-endpoint-contract.md`).
 *
 * Documented-but-not-enforced invariants:
 *  - `agents.total === agents.online + agents.offline + agents.busy
 *    + agents.error + agents.benchmarked`
 *  - `campaigns.total === campaigns.draft + campaigns.running +
 *    campaigns.paused + campaigns.completed + campaigns.cancelled`
 *  - `tasks.total >= tasks.pending + tasks.running + tasks.completed
 *    + tasks.failed` (unknown DB statuses contribute only to `total`)
 *
 * The arithmetic invariants are not Zod-refined because the route
 * doesn't `.parse()` its outgoing response and adding a `.refine()`
 * would not catch route bugs without changing that. The contract
 * test could assert them per-fixture if a regression appears.
 */
export const dashboardStatsSchema = z
  .object({
    agents: z
      .object({
        total: z.number().int().nonnegative(),
        online: z.number().int().nonnegative(),
        offline: z.number().int().nonnegative(),
        busy: z.number().int().nonnegative(),
        error: z.number().int().nonnegative(),
        benchmarked: z.number().int().nonnegative(),
      })
      .strict(),
    campaigns: z
      .object({
        total: z.number().int().nonnegative(),
        draft: z.number().int().nonnegative(),
        running: z.number().int().nonnegative(),
        paused: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        cancelled: z.number().int().nonnegative(),
      })
      .strict(),
    tasks: campaignTaskStatsSchema,
    cracked: z
      .object({
        total: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
