import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess } from '../../middleware/rbac.js'
import { DASHBOARD_RESPONSE_REFS, sharedResponse } from '../../openapi/components.js'
import { getTaskById, listTasks } from '../../services/tasks.js'

const taskRoutes = new OpenAPIHono<AppEnv>()

taskRoutes.use('*', requireSession)
taskRoutes.use('/', requireProjectAccess())
taskRoutes.use('/:id', requireProjectAccess())

// ─── GET / — list tasks with filtering ──────────────────────────────

const listTasksQuerySchema = z.object({
  campaignId: z.coerce.number().int().positive().optional(),
  attackId: z.coerce.number().int().positive().optional(),
  agentId: z.coerce.number().int().positive().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const taskListResponseSchema = z
  .object({
    tasks: z.array(z.unknown()),
    total: z.number().int().nonnegative().optional(),
  })
  .passthrough()
  .openapi('TaskList')

const listTasksRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Tasks'],
  summary: 'List tasks for the active project, filtered by campaign / attack / agent / status',
  security: [{ SessionCookie: [] }],
  request: { query: listTasksQuerySchema },
  responses: {
    200: {
      description: 'Paginated task list.',
      content: { 'application/json': { schema: taskListResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  },
})

taskRoutes.openapi(listTasksRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { campaignId, attackId, agentId, status, limit, offset } = c.req.valid('query')

  const result = await listTasks({
    projectId,
    campaignId,
    attackId,
    agentId,
    status,
    limit,
    offset,
  })
  return c.json(result, 200)
})

// ─── GET /:id — get task details ────────────────────────────────────

const taskDetailResponseSchema = z
  .object({
    task: z.unknown(),
  })
  .passthrough()
  .openapi('TaskDetail')

const getTaskRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Tasks'],
  summary: 'Get a task by id',
  security: [{ SessionCookie: [] }],
  request: { params: z.object({ id: z.coerce.number().int().positive() }) },
  responses: {
    200: {
      description: 'Task details.',
      content: { 'application/json': { schema: taskDetailResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

taskRoutes.openapi(getTaskRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { id } = c.req.valid('param')
  const task = await getTaskById(id, projectId)

  if (!task) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Task not found')
  }

  return c.json({ task }, 200)
})

export { taskRoutes }
