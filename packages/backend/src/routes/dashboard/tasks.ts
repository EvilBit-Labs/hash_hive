import { OpenAPIHono } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess } from '../../middleware/rbac.js'
import { getTaskById, listTasks } from '../../services/tasks.js'

const taskRoutes = new OpenAPIHono<AppEnv>()

taskRoutes.use('*', requireSession)

// ─── GET / — list tasks with filtering ──────────────────────────────

taskRoutes.get('/', requireProjectAccess(), async (c) => {
  // requireProjectAccess sets scopedUser; non-null assertion encodes
  // the middleware contract (CQ-H3).
  const { projectId } = c.get('scopedUser')!
  const campaignId = c.req.query('campaignId') ? Number(c.req.query('campaignId')) : undefined
  const attackId = c.req.query('attackId') ? Number(c.req.query('attackId')) : undefined
  const agentId = c.req.query('agentId') ? Number(c.req.query('agentId')) : undefined
  const status = c.req.query('status') ?? undefined
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined
  const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined

  const result = await listTasks({
    projectId,
    campaignId,
    attackId,
    agentId,
    status,
    limit,
    offset,
  })
  return c.json(result)
})

// ─── GET /:id — get task details ────────────────────────────────────

taskRoutes.get('/:id', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('scopedUser')!
  const id = Number(c.req.param('id'))
  const task = await getTaskById(id, projectId)

  if (!task) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Task not found')
  }

  return c.json({ task })
})

export { taskRoutes }
