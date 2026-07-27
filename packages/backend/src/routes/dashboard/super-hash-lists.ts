/**
 * SuperHashlist management on the dashboard surface (issue #101 — U8; R13, R4).
 *
 * A SuperHashlist (KTD5) is a named, read-time union over several member hash
 * lists; it owns no hash items (R10). This router is the operator-facing CRUD
 * + membership surface over `services/super-hash-lists.ts` (U7):
 *
 *   POST   /                          create (optionally with initial members)
 *   GET    /                          list (limit/offset, showArchived filter)
 *   GET    /{id}                      detail with membership
 *   PATCH  /{id}                      rename
 *   POST   /{id}/members              add a member hash list
 *   DELETE /{id}/members/{listId}     remove a member hash list
 *   POST   /{id}/archive              archive (lifecycle parity, ADR-0019)
 *
 * Follows the three-pillar dashboard read-endpoint contract
 * (`docs/solutions/conventions/dashboard-read-endpoint-contract.md`):
 *   1. Shared Zod schemas in `@hashhive/shared/schemas/super-hash-lists.ts`,
 *      bound to each `createRoute(...)` — route-as-spec, so the served
 *      `/api/v1/dashboard/openapi.json` is generated from the same shapes.
 *   2. Route tests at
 *      `packages/backend/tests/unit/dashboard-super-hash-lists-routes.test.ts`.
 *   3. Realtime freshness via the EXISTING `projectInvalidationKeys` map in
 *      `packages/frontend/src/lib/event-routing.ts` (`super-hash-lists` /
 *      `super-hash-list-detail` added to the `resource_update` and
 *      `crack_result` entries) — no new event type.
 *
 * ─── RBAC (security F1) ────────────────────────────────────────────────
 *
 * MUTATING routes gate on `requireSession` + `requireMembershipRole('admin',
 * 'contributor')`, NOT bare `requireProjectAccess()`. A bare access check
 * passes a project `viewer`, which would let a read-only role mutate
 * membership — and, once U12 (add-member retroactive reconciliation) and U13
 * (remove-member drain→harvest→detach) land, trigger cross-list data movement
 * from a read-only seat. Matches every other mutating dashboard route
 * (`resources-archive-routes.ts`, `campaigns.ts`) and U9's control gating.
 *
 * Bare `requireProjectAccess()` is reserved for the read-only `GET /` and
 * `GET /{id}` paths.
 */

import {
  addSuperMemberRequestSchema,
  createSuperRequestSchema,
  renameSuperRequestSchema,
  superHashListDetailResponseSchema,
  superHashListListResponseSchema,
  superHashListResponseSchema,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireMembershipRole, requireProjectAccess } from '../../middleware/rbac.js'
import { coercedIntegerQuery } from '../../openapi/coerced-query.js'
import {
  DASHBOARD_RESPONSE_REFS,
  dashboardOpenApiHonoOptions,
  sharedDashboardResponse,
} from '../../openapi/components.js'
import {
  addMember,
  archiveSuper,
  createSuper,
  getSuperById,
  listSupers,
  removeMember,
  renameSuper,
  SuperMemberAlreadyInSuperError,
  SuperMemberProjectMismatchError,
  type SuperHashListRow,
  type SuperHashListWithMembers,
} from '../../services/super-hash-lists.js'

const superHashListRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

// Session first for every route on this router; per-route `middleware:`
// adds the access (read) or role (mutate) gate. Mirrors `campaigns.ts`.
superHashListRoutes.use('*', requireSession)

const TAGS = ['Super Hash Lists']
const SECURITY = [{ SessionCookie: [] }]

const SUPER_LIST_DEFAULT_LIMIT = 50
const SUPER_LIST_MAX_LIMIT = 200

// ─── Local param / query schemas ────────────────────────────────────

const superIdParamSchema = z.object({
  id: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'id', in: 'path' } }),
})

const superMemberParamSchema = z.object({
  id: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'id', in: 'path' } }),
  listId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name: 'listId', in: 'path' } }),
})

const listSupersQuerySchema = z.object({
  // Archived supers are excluded by default (ADR-0019); `?showArchived=true`
  // includes them. Permissive coercion — only the literal "true" enables it,
  // so a malformed value never 400s the list request (mirrors `campaigns.ts`).
  showArchived: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  limit: coercedIntegerQuery({
    min: 1,
    max: SUPER_LIST_MAX_LIMIT,
    default: SUPER_LIST_DEFAULT_LIMIT,
  }),
  offset: coercedIntegerQuery({ min: 0, default: 0 }),
})

// ─── Row → wire serialization ───────────────────────────────────────
//
// Drizzle hands back `Date` objects for the timestamp columns; the shared wire
// schemas declare ISO-8601 strings (a `Date` does not survive JSON as one
// structurally, and `createRoute`'s response typing would reject it). These
// helpers are pure re-shaping of the service row — they add NO derived field,
// which is what the route tests' negative-shape assertion pins.

function toSuperWire(row: SuperHashListRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toSuperDetailWire(row: SuperHashListWithMembers) {
  return { ...toSuperWire(row), memberIds: row.memberIds }
}

/**
 * Translate the U7 service's membership domain errors to the dashboard
 * envelope. Returns `null` for anything else so the caller re-throws and the
 * global `onError` handles it — a genuine 500 stays a 500.
 */
function membershipErrorResponse(c: Parameters<typeof dashboardError>[0], err: unknown) {
  if (err instanceof SuperMemberAlreadyInSuperError) {
    // R3: at most one super per hash list — a conflict with existing state.
    return dashboardError(c, 409, 'SUPER_MEMBER_ALREADY_IN_SUPER', err.message)
  }
  if (err instanceof SuperMemberProjectMismatchError) {
    // R5: the referenced hash list is outside the caller's project (or does
    // not exist). 400, not 404 — the referenced ids are request input, and a
    // 404 here would conflate "no such super" with "bad member reference".
    return dashboardError(c, 400, 'SUPER_MEMBER_PROJECT_MISMATCH', err.message)
  }
  return null
}

// ─── POST / (create) ────────────────────────────────────────────────

const createSuperRoute = createRoute({
  method: 'post',
  path: '/',
  tags: TAGS,
  summary: 'Create a super hash list, optionally with an initial member set',
  description:
    "Creates a named union over member hash lists. `memberIds` may be empty or hold a single id: the minimum-of-two-members invariant (R2) is enforced at campaign-target time, not at create time, so a super can be built up incrementally. Every member must belong to the caller's project (R5) and to no other super (R3).",
  security: SECURITY,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    body: { content: { 'application/json': { schema: createSuperRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Super hash list created.',
      content: { 'application/json': { schema: superHashListDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    409: {
      description: 'A proposed member hash list already belongs to another super (R3).',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

superHashListRoutes.openapi(createSuperRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { name, memberIds } = c.req.valid('json')

  try {
    const created = await createSuper({ projectId, name, memberIds })
    return c.json({ superHashList: toSuperDetailWire(created) }, 201)
  } catch (err) {
    const mapped = membershipErrorResponse(c, err)
    if (mapped) return mapped
    throw err
  }
})

// ─── GET / (list) ───────────────────────────────────────────────────

const listSupersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: TAGS,
  summary: "List the project's super hash lists",
  description:
    'Project-scoped listing, newest first. Archived supers are excluded unless `showArchived=true`. `total` is the full matching count regardless of the page window.',
  security: SECURITY,
  middleware: [requireProjectAccess()] as const,
  request: { query: listSupersQuerySchema },
  responses: {
    200: {
      description: 'Page of super hash lists.',
      content: { 'application/json': { schema: superHashListListResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  },
})

superHashListRoutes.openapi(listSupersRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { showArchived, limit, offset } = c.req.valid('query')

  const { items, total } = await listSupers(projectId, { limit, offset, showArchived })
  return c.json({ superHashLists: items.map(toSuperWire), total, limit, offset }, 200)
})

// ─── GET /{id} (detail) ─────────────────────────────────────────────

const getSuperRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: TAGS,
  summary: 'Get a super hash list with its member hash-list ids',
  security: SECURITY,
  middleware: [requireProjectAccess()] as const,
  request: { params: superIdParamSchema },
  responses: {
    200: {
      description: 'Super hash list detail including membership.',
      content: { 'application/json': { schema: superHashListDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

superHashListRoutes.openapi(getSuperRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { id } = c.req.valid('param')

  // `getSuperById` is project-scoped and returns null on a cross-project id,
  // so a wrong-project id cannot disclose existence.
  const found = await getSuperById(id, projectId)
  if (!found) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Super hash list not found')
  }
  return c.json({ superHashList: toSuperDetailWire(found) }, 200)
})

// ─── PATCH /{id} (rename) ───────────────────────────────────────────

const renameSuperRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: TAGS,
  summary: 'Rename a super hash list',
  security: SECURITY,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: superIdParamSchema,
    body: { content: { 'application/json': { schema: renameSuperRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Super hash list renamed.',
      content: { 'application/json': { schema: superHashListResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

superHashListRoutes.openapi(renameSuperRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { id } = c.req.valid('param')
  const { name } = c.req.valid('json')

  const updated = await renameSuper(id, projectId, name)
  if (!updated) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Super hash list not found')
  }
  return c.json({ superHashList: toSuperWire(updated) }, 200)
})

// ─── POST /{id}/members (add) ───────────────────────────────────────

const addSuperMemberRoute = createRoute({
  method: 'post',
  path: '/{id}/members',
  tags: TAGS,
  summary: 'Add a hash list to a super hash list',
  description:
    "Adds a member hash list to the super's union. The member must belong to the caller's project (R5) and to no other super (R3). Members stay independently targetable by their own campaigns.",
  security: SECURITY,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: superIdParamSchema,
    body: { content: { 'application/json': { schema: addSuperMemberRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Member added; returns the super with its updated membership.',
      content: { 'application/json': { schema: superHashListDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description:
        'The hash list already belongs to a super (R3) — including a duplicate add of a member this super already has.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

superHashListRoutes.openapi(addSuperMemberRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { id } = c.req.valid('param')
  const { hashListId } = c.req.valid('json')

  try {
    const updated = await addMember(id, hashListId, projectId)
    if (!updated) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Super hash list not found')
    }
    return c.json({ superHashList: toSuperDetailWire(updated) }, 200)
  } catch (err) {
    const mapped = membershipErrorResponse(c, err)
    if (mapped) return mapped
    throw err
  }
})

// ─── DELETE /{id}/members/{listId} (remove) ─────────────────────────

const removeSuperMemberRoute = createRoute({
  method: 'delete',
  path: '/{id}/members/{listId}',
  tags: TAGS,
  summary: 'Remove a hash list from a super hash list',
  description:
    'Detaches a member from the union. The removed hash list stays independently targetable by its own campaigns (R3), and project-wide crack-once is unaffected — cracks live in the project cracked-set and are never pruned on removal.',
  security: SECURITY,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: { params: superMemberParamSchema },
  responses: {
    200: {
      description: 'Member removed; returns the super with its updated membership.',
      content: { 'application/json': { schema: superHashListDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

superHashListRoutes.openapi(removeSuperMemberRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { id, listId } = c.req.valid('param')

  const updated = await removeMember(id, listId, projectId)
  if (!updated) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Super hash list not found')
  }
  return c.json({ superHashList: toSuperDetailWire(updated) }, 200)
})

// ─── POST /{id}/archive ─────────────────────────────────────────────

const archiveSuperRoute = createRoute({
  method: 'post',
  path: '/{id}/archive',
  tags: TAGS,
  summary: 'Archive a super hash list',
  description:
    'Stamps `archivedAt` (ADR-0019 lifecycle parity with hash lists). Idempotent — an already-archived super is returned unchanged.',
  security: SECURITY,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: { params: superIdParamSchema },
  responses: {
    200: {
      description: 'Super hash list archived.',
      content: { 'application/json': { schema: superHashListResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

superHashListRoutes.openapi(archiveSuperRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { id } = c.req.valid('param')

  const archived = await archiveSuper(id, projectId)
  if (!archived) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Super hash list not found')
  }
  return c.json({ superHashList: toSuperWire(archived) }, 200)
})

export { superHashListRoutes }
