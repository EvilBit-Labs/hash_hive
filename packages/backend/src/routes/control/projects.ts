/**
 * Control API project endpoints. Read-only listing of projects the
 * authenticated user belongs to; project creation stays on the dashboard
 * surface (it's an admin-onboarding flow, not part of the automation
 * contract).
 *
 * Authorization model: a project is visible iff it appears in
 * `getUserProjects(userId)`. Both list and get use that same view, so
 * non-members see 404 (not 403) — preventing existence-enumeration of
 * project ids the caller can't access.
 */

import { selectProjectSchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { paginate, paginationQuerySchema } from '../../lib/pagination.js'
import { problemResponse } from '../../lib/problem-details.js'
import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedControlResponse,
} from '../../openapi/components.js'
import { findUserProjectById, getUserProjectsPaginated } from '../../services/projects.js'
import { controlErrorResponse } from './helpers.js'

export const controlProjectRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const projectSchema = selectProjectSchema.openapi('ControlProject')
const projectsPageSchema = z
  .object({
    items: z.array(projectSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .openapi('ControlProjectPage')

const listProjectsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Projects'],
  summary: 'List projects the authenticated user belongs to',
  security: [{ ControlApiKey: [] }],
  request: { query: paginationQuerySchema },
  responses: {
    200: {
      description: 'Page of projects.',
      content: { 'application/json': { schema: projectsPageSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlProjectRoutes.openapi(listProjectsRoute, async (c) => {
  try {
    const query = c.req.valid('query')
    const { userId } = c.get('currentUser')
    const { items, total } = await getUserProjectsPaginated(userId, {
      limit: query.limit,
      offset: query.offset,
    })
    return c.json(paginate(items, total, query), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

const getProjectRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Projects'],
  summary: 'Get a project by id (visible only when the caller is a member)',
  description:
    'Same envelope (404) whether the project does not exist or the caller cannot see it — avoids leaking existence via a 403 vs 404 differentiation.',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Project details.',
      content: { 'application/json': { schema: projectSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlProjectRoutes.openapi(getProjectRoute, async (c) => {
  try {
    const { id } = c.req.valid('param')
    const { userId } = c.get('currentUser')
    const project = await findUserProjectById(userId, id)
    if (!project) return problemResponse(c, 404, 'not_found', 'project not found')
    return c.json(project, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
