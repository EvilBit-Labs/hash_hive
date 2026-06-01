/**
 * Control API resource-file endpoints (wordlists, rules, masks).
 *
 * Read-only listing and inspection. Uploads stay on the dashboard
 * surface — presigned URLs and chunked-upload coordination are
 * interactive workflows that don't compose well with one-shot
 * automation. Mutating endpoints (POST/PATCH/DELETE) are not
 * implemented in this Control surface.
 */

import { maskLists, ruleLists, wordLists } from '@hashhive/shared'
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
  getResourceById,
  listHashTypes,
  listResourcesPaginated,
  type ResourceTable,
} from '../../services/resources.js'
import { controlErrorResponse, requireProjectMembership } from './helpers.js'

export const controlResourceRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

const RESOURCE_KIND = z.enum(['wordlists', 'rulelists', 'masklists'])
type ResourceKind = z.infer<typeof RESOURCE_KIND>

const RESOURCE_TABLES: Record<ResourceKind, ResourceTable> = {
  wordlists: wordLists,
  rulelists: ruleLists,
  masklists: maskLists,
}

const kindParamSchema = z.object({ kind: RESOURCE_KIND })
const kindIdParamSchema = z.object({
  kind: RESOURCE_KIND,
  id: z.coerce.number().int().positive(),
})

const resourceSchema = z.object({}).passthrough().openapi('ControlResource')
const resourcePageSchema = z
  .object({
    items: z.array(resourceSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .openapi('ControlResourcePage')

const hashTypesResponseSchema = z
  .object({
    hashTypes: z.array(z.object({}).passthrough()),
  })
  .openapi('ControlHashTypes')

/**
 * Hash-type catalog. Defined before the `/:kind` route so the literal
 * path matches first (Hono routes are evaluated in registration order
 * within a sub-application). Hash types are global lookup data, not
 * project-scoped resources — automation clients need this endpoint to
 * resolve a hash-type name into the numeric ID accepted by the
 * createAttack endpoint without having to authenticate via the
 * dashboard cookie session.
 */
const listHashTypesRoute = createRoute({
  method: 'get',
  path: '/hash-types',
  tags: ['Resources'],
  summary: 'Global hash-type catalog (id, name, mode)',
  description:
    'Membership check ensures the caller has a valid API key and at least one project — the response itself is not project-scoped.',
  security: [{ ControlApiKey: [] }],
  responses: {
    200: {
      description: 'Hash types.',
      content: { 'application/json': { schema: hashTypesResponseSchema } },
    },
    400: sharedResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedResponse(CONTROL_RESPONSE_REFS.Forbidden),
    500: sharedResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlResourceRoutes.openapi(listHashTypesRoute, async (c) => {
  try {
    await requireProjectMembership(c)
    const types = await listHashTypes()
    return c.json({ hashTypes: types }, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

const listResourcesRoute = createRoute({
  method: 'get',
  path: '/{kind}',
  tags: ['Resources'],
  summary: 'List resource files (wordlists, rulelists, masklists) in the active project',
  security: [{ ControlApiKey: [] }],
  request: { params: kindParamSchema, query: paginationQuerySchema },
  responses: {
    200: {
      description: 'Page of resources.',
      content: { 'application/json': { schema: resourcePageSchema } },
    },
    400: sharedResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedResponse(CONTROL_RESPONSE_REFS.Forbidden),
    500: sharedResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlResourceRoutes.openapi(listResourcesRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const { kind } = c.req.valid('param')
    const query = c.req.valid('query')
    const { items, total } = await listResourcesPaginated(RESOURCE_TABLES[kind], projectId, {
      limit: query.limit,
      offset: query.offset,
    })
    return c.json(paginate(items, total, query), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

const getResourceRoute = createRoute({
  method: 'get',
  path: '/{kind}/{id}',
  tags: ['Resources'],
  summary: 'Get a single resource by id',
  security: [{ ControlApiKey: [] }],
  request: { params: kindIdParamSchema },
  responses: {
    200: {
      description: 'Resource details.',
      content: { 'application/json': { schema: resourceSchema } },
    },
    400: sharedResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlResourceRoutes.openapi(getResourceRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const { kind, id } = c.req.valid('param')
    const resource = await getResourceById(RESOURCE_TABLES[kind], id, projectId)
    if (!resource) return problemResponse(c, 404, 'not_found', 'resource not found')
    return c.json(resource, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
