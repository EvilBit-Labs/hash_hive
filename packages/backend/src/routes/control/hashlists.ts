/**
 * Control API hash-list endpoints. Read-only at this layer — authoring
 * hash lists is a dashboard interactive flow (file upload via presigned
 * URL, hash-type detection on parse). Automation can list and inspect
 * existing lists.
 */

import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { paginate, paginationQuerySchema } from '../../lib/pagination.js'
import { problemResponse } from '../../lib/problem-details.js'
import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedResponse,
} from '../../openapi/components.js'
import {
  getHashListById,
  getHashListStats,
  listHashListsPaginated,
} from '../../services/resources.js'
import { controlErrorResponse, requireProjectMembership } from './helpers.js'

export const controlHashListRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const hashListSchema = z.object({}).passthrough().openapi('ControlHashList')
const hashListPageSchema = z
  .object({
    items: z.array(hashListSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .openapi('ControlHashListPage')

const hashListStatsSchema = z.object({}).passthrough().openapi('ControlHashListStats')

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
    400: sharedResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedResponse(CONTROL_RESPONSE_REFS.Forbidden),
    500: sharedResponse(CONTROL_RESPONSE_REFS.InternalError),
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
    400: sharedResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedResponse(CONTROL_RESPONSE_REFS.InternalError),
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
    400: sharedResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedResponse(CONTROL_RESPONSE_REFS.InternalError),
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
