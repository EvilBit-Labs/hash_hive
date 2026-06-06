/**
 * Control API hash-list endpoints. Read-only at this layer — authoring
 * hash lists is a dashboard interactive flow (file upload via presigned
 * URL, hash-type detection on parse). Automation can list and inspect
 * existing lists.
 */

import {
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
import {
  getHashListById,
  getHashListStats,
  isForeignKeyViolation,
  listHashListsPaginated,
  setHashListType,
} from '../../services/resources.js'
import { controlErrorResponse, requireProjectMembership } from './helpers.js'

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
// — same payload the dashboard hashlist endpoints emit.
const hashListStatsSchema = hashListStatisticsSchema.openapi('ControlHashListStats')

const listHashListsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['HashLists'],
  summary: 'List hash lists in the active project',
  security: [{ ControlApiKey: [] }],
  request: { query: paginationQuerySchema },
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
    const stats = await getHashListStats(id)
    return c.json(stats, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── PATCH /hash-lists/{id} — set hash type (agent-native parity) ───
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
    if (isForeignKeyViolation(err)) {
      return problemResponse(c, 400, 'validation', 'unknown hashTypeId')
    }
    return controlErrorResponse(c, err)
  }
})
