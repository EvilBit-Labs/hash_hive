/**
 * Control API hash-list endpoints. Authoring (file upload, hash-type
 * detection on parse) is a dashboard interactive flow; automation here
 * can list, inspect, and update the hash type on existing lists via
 * `PATCH /{id}` (agent-native parity with the dashboard surface).
 */

import {
  controlResourceArchiveResponseSchema,
  controlResourceRestoreResponseSchema,
  hashListStatisticsSchema,
  selectHashListSchema,
  setHashListTypeRequestSchema,
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
import { archiveHashLists, restoreHashLists } from '../../services/resources-archive.js'
import {
  getHashListById,
  getHashListStats,
  isForeignKeyViolation,
  listHashListsPaginated,
  setHashListType,
} from '../../services/resources.js'
import { controlErrorResponse, requireProjectMembership, requireProjectRole } from './helpers.js'

export const controlHashListRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const hashListSchema = selectHashListSchema.openapi('ControlHashList')
const hashListPageSchema = z
  .object({
    items: z.array(hashListSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .openapi('ControlHashListPage')

// Shared hash-list statistics shape (totalCount, crackedCount, crackRate, lastUpdated?)
// - same payload the dashboard hashlist endpoints emit.
const hashListStatsSchema = hashListStatisticsSchema.openapi('ControlHashListStats')

// `showArchived` mirrors the dashboard's `?showArchived=true` query param
// naming and permissive coercion (ADR-0019 / issue #106 R10) — only the
// literal "true" enables it, anything else (or absent) is false and
// archived hash lists stay excluded from the default listing.
const listHashListsQuerySchema = paginationQuerySchema.merge(
  z.object({
    showArchived: z
      .string()
      .optional()
      .transform((v) => v === 'true'),
  })
)

const listHashListsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['HashLists'],
  summary: 'List hash lists in the active project',
  security: [{ ControlApiKey: [] }],
  request: { query: listHashListsQuerySchema },
  responses: {
    200: {
      description: 'Page of hash lists.',
      content: { 'application/json': { schema: hashListPageSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlHashListRoutes.openapi(listHashListsRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const query = c.req.valid('query')
    const { items, total } = await listHashListsPaginated(projectId, {
      limit: query.limit,
      offset: query.offset,
      showArchived: query.showArchived,
    })
    return c.json(paginate(items, total, query), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

const getHashListRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['HashLists'],
  summary: 'Get a hash list by id (scoped to the active project)',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Hash list details.',
      content: { 'application/json': { schema: hashListSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlHashListRoutes.openapi(getHashListRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const { id } = c.req.valid('param')
    const hashList = await getHashListById(id, projectId)
    if (!hashList) return problemResponse(c, 404, 'not_found', 'hash list not found')
    return c.json(hashList, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

const getHashListStatsRoute = createRoute({
  method: 'get',
  path: '/{id}/stats',
  tags: ['HashLists'],
  summary: 'Get aggregate stats for a hash list',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Hash list stats.',
      content: { 'application/json': { schema: hashListStatsSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlHashListRoutes.openapi(getHashListStatsRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const { id } = c.req.valid('param')
    const hashList = await getHashListById(id, projectId)
    if (!hashList) return problemResponse(c, 404, 'not_found', 'hash list not found')
    const stats = await getHashListStats(id, projectId)
    return c.json(stats, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── PATCH /hash-lists/{id} - set hash type (agent-native parity) ───
//
// Operator-facing PATCH set-hash-type exists on the dashboard surface;
// this is the Control-API parallel so CLI/automation can perform the
// same operation without going through the cookie-session flow. Mirrors
// the dashboard's project-scoping (404 on cross-project lookup) and
// FK-violation → 400 mapping.

const setHashListTypeRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['HashLists'],
  summary: 'Set the hash type on an existing hash list',
  security: [{ ControlApiKey: [] }],
  request: {
    params: idParamSchema,
    body: {
      content: { 'application/json': { schema: setHashListTypeRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Updated hash list.',
      content: { 'application/json': { schema: hashListSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlHashListRoutes.openapi(setHashListTypeRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const { id } = c.req.valid('param')
    const { hashTypeId } = c.req.valid('json')
    const updated = await setHashListType(id, projectId, hashTypeId)
    if (!updated) return problemResponse(c, 404, 'not_found', 'hash list not found')
    return c.json(updated, 200)
  } catch (err) {
    if (isForeignKeyViolation(err, 'hash_lists_hash_type_id_hash_types_id_fk')) {
      return problemResponse(c, 400, 'validation', 'unknown hashTypeId')
    }
    return controlErrorResponse(c, err)
  }
})

// ─── POST /:id/archive, /:id/restore — hash-list lifecycle (issue #106 U10) ─
//
// Control API parity for the dashboard's bulk `POST /hash-lists/archive`
// and `/restore` (issue #106 U4), backed by the same `archiveHashLists`/
// `restoreHashLists` service (U3). Single-resource per the Control
// surface's existing per-resource style — the service is bulk-`ids`-
// shaped, so these handlers call it with a one-element array and unwrap
// the sole result.
//
// Outcome → HTTP status: `archived`/`restored` → 200; `not_found` → 404
// `not_found`; `already_archived`/`not_archivable`/`in_use`/
// `not_archived` → 409 `conflict` (current-state conflict, distinct
// from a permanent 422 — see `control/attacks.ts`'s archive route doc
// for the full rationale); `error` → 500 `internal`.

const archiveHashListRoute = createRoute({
  method: 'post',
  path: '/{id}/archive',
  tags: ['HashLists'],
  summary: 'Archive a permanent, unreferenced hash list (contributor or admin only)',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Archive outcome.',
      content: { 'application/json': { schema: controlResourceArchiveResponseSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    409: sharedControlResponse(CONTROL_RESPONSE_REFS.Conflict),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlHashListRoutes.openapi(archiveHashListRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { id } = c.req.valid('param')
    const user = c.get('currentUser')
    const [result] = await archiveHashLists(projectId, [id], {
      actorType: 'user',
      actorId: user.userId,
    })
    if (!result) throw new Error('archiveHashLists returned no result for a single id')
    switch (result.outcome) {
      case 'not_found':
        return problemResponse(c, 404, 'not_found', 'hash list not found')
      case 'already_archived':
        return problemResponse(c, 409, 'conflict', 'hash list is already archived')
      case 'not_archivable':
        return problemResponse(
          c,
          409,
          'conflict',
          'hash list is not permanent or not in a ready state'
        )
      case 'in_use':
        return problemResponse(
          c,
          409,
          'conflict',
          'hash list is still referenced by a non-archived campaign'
        )
      case 'error':
        return problemResponse(c, 500, 'internal', 'archive failed')
      case 'archived':
        return c.json({ id: result.id, outcome: result.outcome }, 200)
    }
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

const restoreHashListRoute = createRoute({
  method: 'post',
  path: '/{id}/restore',
  tags: ['HashLists'],
  summary: 'Restore an archived hash list (contributor or admin only)',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Restore outcome.',
      content: { 'application/json': { schema: controlResourceRestoreResponseSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    409: sharedControlResponse(CONTROL_RESPONSE_REFS.Conflict),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlHashListRoutes.openapi(restoreHashListRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { id } = c.req.valid('param')
    const user = c.get('currentUser')
    const [result] = await restoreHashLists(projectId, [id], {
      actorType: 'user',
      actorId: user.userId,
    })
    if (!result) throw new Error('restoreHashLists returned no result for a single id')
    switch (result.outcome) {
      case 'not_found':
        return problemResponse(c, 404, 'not_found', 'hash list not found')
      case 'not_archived':
        return problemResponse(c, 409, 'conflict', 'hash list is not archived')
      case 'error':
        return problemResponse(c, 500, 'internal', 'restore failed')
      case 'restored':
        return c.json({ id: result.id, outcome: result.outcome }, 200)
    }
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
