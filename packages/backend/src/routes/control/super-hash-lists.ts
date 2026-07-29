/**
 * SuperHashlist management on the Control API surface (issue #101 — U9; R13, R4).
 *
 * The Control-API parallel of the dashboard SuperHashlist surface (U8): CLI
 * tooling, automation, and CI can create, list, inspect, rename, archive, and
 * manage the membership of a super without going through the cookie-session
 * flow — agent-native parity with the dashboard.
 *
 *   POST   /                          create (optionally with initial members)
 *   GET    /                          list (offset/limit, showArchived filter)
 *   GET    /{id}                      detail with membership
 *   PATCH  /{id}                      rename
 *   POST   /{id}/members              add a member hash list
 *   DELETE /{id}/members/{listId}     remove a member hash list
 *   POST   /{id}/archive              archive (lifecycle parity, ADR-0019)
 *
 * Control-surface conventions (distinct from the dashboard):
 *   - RFC 9457 problem-details errors (`application/problem+json`) via
 *     `problemResponse(...)` / `controlErrorResponse(...)`.
 *   - `offset`/`limit` pagination via `paginate` + `paginationQuerySchema`; the
 *     list envelope is `{ items, total, offset, limit }` (NOT the dashboard's
 *     `{ superHashLists, ... }` envelope), and individual entities are returned
 *     bare (NOT wrapped in `{ superHashList: ... }`).
 *   - Entities reuse the SAME shared wire schemas as U8
 *     (`@hashhive/shared/schemas/super-hash-lists.ts`), re-branded with
 *     Control-surface component names to keep the served
 *     `/api/v1/control/openapi.json` self-describing (mirrors how
 *     `control/hashlists.ts` re-brands `selectHashListSchema`).
 *
 * ─── RBAC (security F1 / R13) ──────────────────────────────────────────
 *
 * MUTATING routes gate on `requireProjectRole(c, 'contributor', 'admin')`, so a
 * project `viewer` is rejected (403). A bare `requireProjectMembership` would
 * pass a read-only role, which would let a viewer mutate membership — and, once
 * U12 (add-member reconciliation) and U13 (remove-member drain→harvest→detach)
 * land, trigger cross-list data movement from a read-only seat. The reads
 * (`GET /`, `GET /{id}`) use `requireProjectMembership` (viewer allowed), the
 * same split as the dashboard surface and `control/hashlists.ts`.
 */

import type { Context } from 'hono'

import {
  addSuperMemberRequestSchema,
  createSuperRequestSchema,
  renameSuperRequestSchema,
  superHashListDetailWireSchema,
  superHashListWireSchema,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { paginate, paginationQuerySchema } from '../../lib/pagination.js'
import { problemResponse } from '../../lib/problem-details.js'
import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedControlResponse,
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
import { controlErrorResponse, requireProjectMembership, requireProjectRole } from './helpers.js'

export const controlSuperHashListRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

const TAGS = ['Super Hash Lists']

// Re-brand the shared entity schemas with Control-surface component names so
// the served spec is self-describing and does not collide with the dashboard
// surface's names (mirrors `control/hashlists.ts`'s `ControlHashList`).
const superSchema = superHashListWireSchema.openapi('ControlSuperHashList')
const superDetailSchema = superHashListDetailWireSchema.openapi('ControlSuperHashListDetail')

const superPageSchema = z
  .object({
    items: z.array(superSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().min(1),
    offset: z.number().int().nonnegative(),
  })
  .openapi('ControlSuperHashListPage')

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const memberParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  listId: z.coerce.number().int().positive(),
})

// `showArchived` mirrors the dashboard's `?showArchived=true` naming and
// permissive coercion (ADR-0019) — only the literal "true" enables it, anything
// else (or absent) is false and archived supers stay excluded.
const listSupersQuerySchema = paginationQuerySchema.merge(
  z.object({
    showArchived: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
  })
)

// ─── Row → wire serialization ───────────────────────────────────────
//
// Drizzle hands back `Date` objects for the timestamp columns; the shared wire
// schemas declare ISO-8601 strings. These helpers are pure re-shaping of the
// service row — they add NO derived field (a super owns no hash items, R10).

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
 * Translate the U7 service's membership domain errors to a problem-details
 * response. Returns `null` for anything else so the caller falls through to
 * `controlErrorResponse` — a genuine 500 stays a 500.
 */
function membershipProblem(c: Context<AppEnv>, err: unknown): Response | null {
  if (err instanceof SuperMemberAlreadyInSuperError) {
    // R3: at most one super per hash list — a conflict with existing state.
    return problemResponse(c, 409, 'conflict', err.message)
  }
  if (err instanceof SuperMemberProjectMismatchError) {
    // R5: the referenced hash list is outside the caller's project (or does not
    // exist). 400, not 404 — the ids are request input; a 404 would conflate
    // "no such super" with "bad member reference".
    return problemResponse(c, 400, 'validation', err.message)
  }
  return null
}

// ─── POST / (create) ────────────────────────────────────────────────

const createSuperRoute = createRoute({
  method: 'post',
  path: '/',
  tags: TAGS,
  summary: 'Create a super hash list, optionally with an initial member set (contributor or admin)',
  description:
    "Creates a named union over member hash lists. `memberIds` may be empty or hold a single id: the minimum-of-two-members invariant (R2) is enforced at campaign-target time, not at create time. Every member must belong to the caller's project (R5) and to no other super (R3).",
  security: [{ ControlApiKey: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: createSuperRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      description: 'Super hash list created.',
      content: { 'application/json': { schema: superDetailSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    409: sharedControlResponse(CONTROL_RESPONSE_REFS.Conflict),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlSuperHashListRoutes.openapi(createSuperRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { name, memberIds } = c.req.valid('json')
    const created = await createSuper({ projectId, name, memberIds })
    return c.json(toSuperDetailWire(created), 201)
  } catch (err) {
    return membershipProblem(c, err) ?? controlErrorResponse(c, err)
  }
})

// ─── GET / (list) ───────────────────────────────────────────────────

const listSupersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: TAGS,
  summary: 'List super hash lists in the active project',
  description:
    'Project-scoped listing, newest first. Archived supers are excluded unless `showArchived=true`. `total` is the full matching count regardless of the page window.',
  security: [{ ControlApiKey: [] }],
  request: { query: listSupersQuerySchema },
  responses: {
    200: {
      description: 'Page of super hash lists.',
      content: { 'application/json': { schema: superPageSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlSuperHashListRoutes.openapi(listSupersRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const query = c.req.valid('query')
    const { items, total } = await listSupers(projectId, {
      limit: query.limit,
      offset: query.offset,
      showArchived: query.showArchived,
    })
    return c.json(paginate(items.map(toSuperWire), total, query), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── GET /{id} (detail) ─────────────────────────────────────────────

const getSuperRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: TAGS,
  summary: 'Get a super hash list with its member hash-list ids',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Super hash list detail including membership.',
      content: { 'application/json': { schema: superDetailSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlSuperHashListRoutes.openapi(getSuperRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const { id } = c.req.valid('param')
    // Project-scoped; returns null on a cross-project id so a wrong-project id
    // cannot disclose existence.
    const found = await getSuperById(id, projectId)
    if (!found) return problemResponse(c, 404, 'not_found', 'super hash list not found')
    return c.json(toSuperDetailWire(found), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── PATCH /{id} (rename) ───────────────────────────────────────────

const renameSuperRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: TAGS,
  summary: 'Rename a super hash list (contributor or admin only)',
  security: [{ ControlApiKey: [] }],
  request: {
    params: idParamSchema,
    body: {
      content: { 'application/json': { schema: renameSuperRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Super hash list renamed.',
      content: { 'application/json': { schema: superSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlSuperHashListRoutes.openapi(renameSuperRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { id } = c.req.valid('param')
    const { name } = c.req.valid('json')
    const updated = await renameSuper(id, projectId, name)
    if (!updated) return problemResponse(c, 404, 'not_found', 'super hash list not found')
    return c.json(toSuperWire(updated), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── POST /{id}/members (add) ───────────────────────────────────────

const addMemberRoute = createRoute({
  method: 'post',
  path: '/{id}/members',
  tags: TAGS,
  summary: 'Add a hash list to a super hash list (contributor or admin only)',
  description:
    "Adds a member hash list to the super's union. The member must belong to the caller's project (R5) and to no other super (R3). Members stay independently targetable by their own campaigns.",
  security: [{ ControlApiKey: [] }],
  request: {
    params: idParamSchema,
    body: {
      content: { 'application/json': { schema: addSuperMemberRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Member added; returns the super with its updated membership.',
      content: { 'application/json': { schema: superDetailSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    409: sharedControlResponse(CONTROL_RESPONSE_REFS.Conflict),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlSuperHashListRoutes.openapi(addMemberRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { id } = c.req.valid('param')
    const { hashListId } = c.req.valid('json')
    const updated = await addMember(id, hashListId, projectId)
    if (!updated) return problemResponse(c, 404, 'not_found', 'super hash list not found')
    return c.json(toSuperDetailWire(updated), 200)
  } catch (err) {
    return membershipProblem(c, err) ?? controlErrorResponse(c, err)
  }
})

// ─── DELETE /{id}/members/{listId} (remove) ─────────────────────────

const removeMemberRoute = createRoute({
  method: 'delete',
  path: '/{id}/members/{listId}',
  tags: TAGS,
  summary: 'Remove a hash list from a super hash list (contributor or admin only)',
  description:
    'Detaches a member from the union. The removed hash list stays independently targetable by its own campaigns (R3), and project-wide crack-once is unaffected — cracks live in the project cracked-set and are never pruned on removal.',
  security: [{ ControlApiKey: [] }],
  request: { params: memberParamSchema },
  responses: {
    200: {
      description: 'Member removed; returns the super with its updated membership.',
      content: { 'application/json': { schema: superDetailSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlSuperHashListRoutes.openapi(removeMemberRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { id, listId } = c.req.valid('param')
    const updated = await removeMember(id, listId, projectId)
    if (!updated) return problemResponse(c, 404, 'not_found', 'super hash list not found')
    return c.json(toSuperDetailWire(updated), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── POST /{id}/archive ─────────────────────────────────────────────

const archiveSuperRoute = createRoute({
  method: 'post',
  path: '/{id}/archive',
  tags: TAGS,
  summary: 'Archive a super hash list (contributor or admin only)',
  description:
    'Stamps `archivedAt` (ADR-0019 lifecycle parity with hash lists). Idempotent — an already-archived super is returned unchanged.',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Super hash list archived.',
      content: { 'application/json': { schema: superSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlSuperHashListRoutes.openapi(archiveSuperRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { id } = c.req.valid('param')
    const archived = await archiveSuper(id, projectId)
    if (!archived) return problemResponse(c, 404, 'not_found', 'super hash list not found')
    return c.json(toSuperWire(archived), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
