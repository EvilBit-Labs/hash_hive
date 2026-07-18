import {
  agents,
  campaigns,
  type DashboardStats,
  dashboardStatsSchema,
  hashItems,
  hashLists,
  TASK_DB_TO_BUCKET,
  type TaskBucket,
  type TaskDbStatus,
  tasks,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm'

import type { AppEnv } from '../../types.js'

import { db } from '../../db/index.js'
import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess } from '../../middleware/rbac.js'
import {
  DASHBOARD_RESPONSE_REFS,
  sharedDashboardResponse,
  dashboardOpenApiHonoOptions,
} from '../../openapi/components.js'

const statsRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

statsRoutes.use('*', requireSession)

/**
 * Read a status-keyed count from a Drizzle group-by result, defaulting
 * to `0` when the literal is absent. The literal-keyed lookup replaces
 * the previous `Record<string, number>` mapping, which silently dropped
 * any status value not enumerated in the response shape (notably `busy`
 * and `benchmarked` agents). See `dashboardStatsSchema` for the canonical
 * field set and the read-endpoint contract at
 * `docs/solutions/conventions/dashboard-read-endpoint-contract.md` for
 * the compile-time-vs-runtime enforcement boundary.
 */
function countFor(rows: ReadonlyArray<{ status: string; count: number }>, literal: string): number {
  for (const row of rows) {
    if (row.status === literal) return Number(row.count)
  }
  return 0
}

function sumRows(rows: ReadonlyArray<{ count: number }>): number {
  let total = 0
  for (const row of rows) total += Number(row.count)
  return total
}

// Decorate the shared schema as a named component so the generated
// dashboard spec emits `$ref: '#/components/schemas/DashboardStats'`
// rather than inlining the object. The dashboard surface is route-as-spec
// (no companion YAML); this name is the canonical identifier for any
// downstream client codegen.
const DashboardStats = dashboardStatsSchema.openapi('DashboardStats')

// Specific error envelope for the PROJECT_NOT_SELECTED 400 — the only
// failure code this endpoint emits beyond the shared auth/rbac
// responses below.
const projectNotSelectedErrorSchema = z
  .object({
    error: z.object({
      code: z.literal('PROJECT_NOT_SELECTED'),
      message: z.string(),
    }),
  })
  .openapi('ProjectNotSelectedError')

const getStatsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Stats'],
  summary: 'Project-scoped aggregate counts for the dashboard stat cards',
  description:
    'Returns four aggregate counts for the operator selected project: agents by status, campaigns by status, tasks by status, and total cracked hashes. Scope is derived exclusively from the server-managed session.session.projectId; non-members receive 403 (not 404) so the endpoint does not aid project enumeration.',
  security: [{ SessionCookie: [] }],
  responses: {
    200: {
      description: 'Project-scoped dashboard stat aggregates.',
      content: { 'application/json': { schema: DashboardStats } },
    },
    400: {
      description: 'Session has no active project context. Call POST /projects/select first.',
      content: { 'application/json': { schema: projectNotSelectedErrorSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  },
})

// requireProjectAccess() mounts as path-scoped middleware because
// `app.openapi(route, handler)` accepts only the route definition and
// handler — middleware cannot be passed as additional handler args
// the way the old `app.get('/', requireProjectAccess(), handler)` form
// did. Path-scoped `use('/')` runs only for `GET /` on this router
// and preserves the original gating semantics.
statsRoutes.use('/', requireProjectAccess())

statsRoutes.openapi(getStatsRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!

  const [agentStats, campaignStats, taskStats, crackedStats] = await Promise.all([
    db
      .select({
        status: agents.status,
        count: sql<number>`count(*)`,
      })
      .from(agents)
      // Retired agents are decommissioned and excluded from active-fleet views
      // (ADR-0019 / #106), so they contribute to neither `total` nor any bucket
      // here — matching listAgents' default exclusion.
      .where(and(eq(agents.projectId, projectId), ne(agents.status, 'retired')))
      .groupBy(agents.status),

    db
      .select({
        status: campaigns.status,
        count: sql<number>`count(*)`,
      })
      .from(campaigns)
      // Split sub-campaigns (issue #202 second half) are children of a
      // parent campaign; without this filter a split campaign would count
      // as 1 parent + N sub-campaigns in the status breakdown instead of
      // once. Matches `listCampaigns`' flat-list exclusion in
      // `services/campaigns.ts`.
      .where(and(eq(campaigns.projectId, projectId), isNull(campaigns.parentCampaignId)))
      .groupBy(campaigns.status),

    db
      .select({
        status: tasks.status,
        count: sql<number>`count(*)`,
      })
      .from(tasks)
      .innerJoin(campaigns, eq(tasks.campaignId, campaigns.id))
      .where(eq(campaigns.projectId, projectId))
      .groupBy(tasks.status),

    // Total cracked hashes scoped by hash-list ownership, not by
    // campaign join. `hashItems.campaignId` is nullable (the FK uses
    // ON DELETE SET NULL — see `packages/shared/src/db/schema.ts`), so
    // joining through `campaigns` would silently drop cracked rows whose
    // campaign has been deleted. `hashItems.hashListId` is NOT NULL and
    // `hashLists.projectId` is NOT NULL, which is the contract intent
    // documented on `dashboardStatsSchema` ("count hash items with a
    // non-null `crackedAt` across the project's hash lists"). The
    // `hash_items_hash_list_cracked_idx` composite index on
    // `(hashListId, crackedAt)` is purpose-built for this access path.
    //
    // `count(distinct hashValue)` (#202 SU4): `propagateCrack` marks a
    // hashValue cracked everywhere it appears, across every hash list —
    // so a hashValue that exists as a separate row under two sibling
    // split sub-lists (or, pre-existing this feature, two independently
    // uploaded lists that happen to share a hash) must count as ONE
    // cracked target, not once per row. No-op for a project with no
    // duplicate hashValues across its lists — the overwhelmingly common
    // case.
    db
      .select({
        count: sql<number>`count(distinct ${hashItems.hashValue})`,
      })
      .from(hashItems)
      .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
      .where(and(eq(hashLists.projectId, projectId), isNotNull(hashItems.crackedAt))),
  ])

  // Bucket task DB statuses into the operator-facing buckets defined by
  // `TASK_DB_TO_BUCKET` in `@hashhive/shared`. Same mapping
  // `getCampaignTaskStats` in `services/campaign-dashboard.ts` consumes —
  // centralizing here means a future DB-status rename touches the shared
  // constant once instead of every consumer.
  const taskBuckets: Record<TaskBucket, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
  }
  for (const row of taskStats) {
    const bucket = TASK_DB_TO_BUCKET[row.status as TaskDbStatus]
    if (bucket !== undefined) {
      taskBuckets[bucket] += Number(row.count)
    }
    // Unknown DB statuses still contribute to `total` via `sumRows` below.
  }

  const body: DashboardStats = {
    agents: {
      total: sumRows(agentStats),
      online: countFor(agentStats, 'online'),
      offline: countFor(agentStats, 'offline'),
      busy: countFor(agentStats, 'busy'),
      error: countFor(agentStats, 'error'),
      benchmarked: countFor(agentStats, 'benchmarked'),
    },
    campaigns: {
      total: sumRows(campaignStats),
      draft: countFor(campaignStats, 'draft'),
      running: countFor(campaignStats, 'running'),
      paused: countFor(campaignStats, 'paused'),
      completed: countFor(campaignStats, 'completed'),
      cancelled: countFor(campaignStats, 'cancelled'),
    },
    tasks: {
      total: sumRows(taskStats),
      pending: taskBuckets.pending,
      running: taskBuckets.running,
      completed: taskBuckets.completed,
      failed: taskBuckets.failed,
    },
    cracked: {
      total: Number(crackedStats[0]?.count ?? 0),
    },
  }

  return c.json(body, 200)
})

export { statsRoutes }
