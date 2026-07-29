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
import {
  hashItems,
  hashListListResponseSchema,
  hashLists,
  projectCrackedHashes,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import type { AppEnv } from '../../types.js'

import { db } from '../../db/index.js'
import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess } from '../../middleware/rbac.js'
import {
  DASHBOARD_RESPONSE_REFS,
  dashboardOpenApiHonoOptions,
  sharedDashboardResponse,
} from '../../openapi/components.js'
import {
  crackedSetJoinOn,
  RESOLVED_CRACKED_VALUE,
} from '../../services/hash-items/crack-resolution.js'
import { getScopedProjectId as getScopedProjectIdShared } from './scoped-user.js'

const hashListsRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

// `*` covers both this route and any future endpoint added to this
// router, so a new mount can't silently bypass project membership.
hashListsRoutes.use('*', requireSession, requireProjectAccess())

function getScopedProjectId(c: {
  get: (key: 'scopedUser') => { projectId: number } | undefined
}): { ok: true; projectId: number } | { ok: false } {
  return getScopedProjectIdShared(c, 'hash-lists')
}

const listHashListsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Hash Lists'],
  summary: 'Project-scoped hash lists with aggregate hash and cracked counts',
  description:
    'Returns every hash list belonging to the operator selected project with a total count and a cracked count. The cracked count resolves through the per-project cracked-set, so a distinct hash value counts as cracked once it has been cracked anywhere in the project under the same hashcat mode — matching the canonical cracked semantic used by dashboard stats, hash-list stats, and the results endpoints. Sorted by name ASC. No pagination — projects rarely host more than ~50 hash lists; scale concerns are deferred per plan #165 U2.',
  security: [{ SessionCookie: [] }],
  responses: {
    200: {
      description: 'Project-scoped hash list summaries.',
      content: { 'application/json': { schema: hashListListResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    500: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.InternalError),
  },
})

hashListsRoutes.openapi(listHashListsRoute, async (c) => {
  const scope = getScopedProjectId(c)
  if (!scope.ok) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
  }
  const { projectId } = scope

  // LEFT JOIN preserves hash lists with zero items (the otherwise-empty
  // right side returns 0 from COUNT).
  //
  // #202 SU4: a split parent's own `hash_items` are empty — its items were
  // moved to its sub-lists — so a plain single-table join would report
  // `hashCount: 0, crackedCount: 0` for a parent row, hiding the real
  // aggregate. `childHashLists` is a one-level self-join to the parent's
  // direct children (grandchild nesting is out of scope — see
  // `services/hash-items/list-scope.ts`), and `hashItems` joins on
  // EITHER the row's own id OR one of its children's ids. For a leaf list
  // (no children), `childHashLists.id` is always NULL, so the `OR`
  // collapses to the original single-list join — hashCount/crackedCount
  // are unchanged from the pre-SU4 query for every un-split list.
  //
  // `crackedCount` dedupes on `hashValue` (`count(distinct case when ...
  // end)` instead of `count(...) FILTER (...)`) so a hashValue that
  // exists as a separate row under two sibling sub-lists (propagateCrack
  // marks a hashValue cracked everywhere it appears) counts once in a
  // parent's aggregate — a no-op for a leaf, where hashValue is already
  // unique within the list. `hashCount` intentionally stays a raw row
  // count (not deduped), same rationale as `getHashListStats.totalCount`.
  //
  // U4/R15 generalizes that dedup instinct from "siblings under one parent"
  // to the whole project: `RESOLVED_CRACKED_VALUE` reads crack state through
  // the per-project cracked-set via the LEFT JOIN below, so a value cracked
  // only in an unrelated list of the same project counts as cracked for this
  // list too. The join is 1:1 at most (UNIQUE `(projectId, mode, value)`), so
  // `hashCount` is unchanged by its presence. R17: only the crack *state*
  // crosses — the cracked-set's `sourceHashListId` is never projected.
  const childHashLists = alias(hashLists, 'child_hash_lists')

  const rows = await db
    .select({
      id: hashLists.id,
      name: hashLists.name,
      hashTypeId: hashLists.hashTypeId,
      hashCount: sql<number>`count(${hashItems.id})`,
      crackedCount: sql<number>`count(distinct ${RESOLVED_CRACKED_VALUE})`,
    })
    .from(hashLists)
    .leftJoin(
      childHashLists,
      and(
        eq(childHashLists.parentHashListId, hashLists.id),
        eq(childHashLists.projectId, projectId)
      )
    )
    .leftJoin(
      hashItems,
      or(eq(hashItems.hashListId, hashLists.id), eq(hashItems.hashListId, childHashLists.id))
    )
    .leftJoin(projectCrackedHashes, crackedSetJoinOn(projectId))
    // #202 code review P1: a split sub-list (`parent_hash_list_id IS NOT
    // NULL`) is an internal implementation detail — the operator interacts
    // with the split PARENT (whose aggregate already folds in every
    // child's hash/cracked counts via the join above), never the children
    // directly. Without this filter, every sub-list also showed up as its
    // own row in the listing.
    .where(and(eq(hashLists.projectId, projectId), isNull(hashLists.parentHashListId)))
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
