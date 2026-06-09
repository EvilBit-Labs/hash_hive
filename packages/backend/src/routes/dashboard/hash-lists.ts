/**
 * `GET /api/v1/dashboard/hash-lists` (issue #165 U2).
 *
 * Project-scoped listing of hash lists with aggregate hash/cracked
 * counts. Powers the global Results page's hash-list filter dropdown
 * and the hash list detail stats card. Follows the four-pillar
 * dashboard read-endpoint contract:
 *
 *   1. Shared Zod schema in `@hashhive/shared/schemas/hash-lists.ts`.
 *   2. `z.infer` wire type re-exported from `@hashhive/shared`.
 *   3. Route registered via `@hono/zod-openapi` so the served
 *      `/api/v1/dashboard/openapi.json` is generated from the same
 *      schema.
 *   4. Integration test at
 *      `packages/backend/tests/unit/dashboard-hash-lists-routes.test.ts`.
 *
 * Mounted with `requireSession + requireProjectAccess()` so the
 * project scope is server-managed via the BetterAuth session — a
 * client-supplied `x-project-id` header is ignored.
 */
import { hashItems, hashListListResponseSchema, hashLists } from '@hashhive/shared'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { eq, isNotNull, sql } from 'drizzle-orm'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { db } from '../../db/index.js'
import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess } from '../../middleware/rbac.js'
import {
  DASHBOARD_RESPONSE_REFS,
  dashboardOpenApiHonoOptions,
  sharedDashboardResponse,
} from '../../openapi/components.js'

const hashListsRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

// `*` covers both this route and any future endpoint added to this
// router, so a new mount can't silently bypass project membership.
hashListsRoutes.use('*', requireSession, requireProjectAccess())

function getScopedProjectId(c: {
  get: (key: 'scopedUser') => { projectId: number } | undefined
}): { ok: true; projectId: number } | { ok: false } {
  const scoped = c.get('scopedUser')
  if (!scoped) {
    logger.error(
      {},
      'hash-lists: scopedUser middleware did not run before handler — middleware order regression'
    )
    return { ok: false }
  }
  return { ok: true, projectId: scoped.projectId }
}

const listHashListsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Hash Lists'],
  summary: 'Project-scoped hash lists with aggregate hash and cracked counts',
  description:
    'Returns every hash list belonging to the operator selected project with a total count and a cracked count (computed via FILTER on plaintext IS NOT NULL). Sorted by name ASC. No pagination — projects rarely host more than ~50 hash lists; scale concerns are deferred per plan #165 U2.',
  security: [{ SessionCookie: [] }],
  responses: {
    200: {
      description: 'Project-scoped hash list summaries.',
      content: { 'application/json': { schema: hashListListResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  },
})

hashListsRoutes.openapi(listHashListsRoute, async (c) => {
  const scope = getScopedProjectId(c)
  if (!scope.ok) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
  }
  const { projectId } = scope

  // LEFT JOIN preserves hash lists with zero items (the otherwise-empty
  // right side returns 0 from COUNT). The cracked count uses Postgres'
  // `FILTER (WHERE ...)` aggregate so the cracked semantics live in
  // one query rather than a self-join.
  const rows = await db
    .select({
      id: hashLists.id,
      name: hashLists.name,
      hashTypeId: hashLists.hashTypeId,
      hashCount: sql<number>`count(${hashItems.id})`,
      crackedCount: sql<number>`count(${hashItems.id}) FILTER (WHERE ${isNotNull(hashItems.plaintext)})`,
    })
    .from(hashLists)
    .leftJoin(hashItems, eq(hashItems.hashListId, hashLists.id))
    .where(eq(hashLists.projectId, projectId))
    .groupBy(hashLists.id)
    .orderBy(hashLists.name)

  // postgres-js returns count(*) as a string at runtime; Drizzle's
  // `sql<number>` is a compile-time cast only. Without an explicit
  // `Number(...)` the wire would ship strings and violate the schema.
  // Same precedent as `dashboard/stats.ts` and `dashboard/results.ts`.
  return c.json(
    {
      hashLists: rows.map((row) => ({
        id: row.id,
        name: row.name,
        hashTypeId: row.hashTypeId,
        hashCount: Number(row.hashCount ?? 0),
        crackedCount: Number(row.crackedCount ?? 0),
      })),
    },
    200
  )
})

export { hashListsRoutes }
