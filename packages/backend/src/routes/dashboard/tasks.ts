import { Hono } from 'hono'

import type { AppEnv } from '../../types.js'

import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess } from '../../middleware/rbac.js'
import { getTaskById, listTasks } from '../../services/tasks.js'

const taskRoutes = new Hono<AppEnv>()

taskRoutes.use('*', requireSession)

// ─── GET / — list tasks with filtering ──────────────────────────────

taskRoutes.get('/', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('currentUser')
  // requireProjectAccess guarantees membership and a non-null projectId
  // on currentUser; the guard below is a type-narrowing belt-and-braces.
  if (projectId === null) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400)
  }
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
  const { projectId } = c.get('currentUser')
  if (projectId === null) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400)
  }
  const id = Number(c.req.param('id'))
  const task = await getTaskById(id, projectId)

  if (!task) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Task not found' } }, 404)
  }

  return c.json({ task })
})

export { taskRoutes }
