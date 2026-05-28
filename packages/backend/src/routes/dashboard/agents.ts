import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import type { AppEnv } from '../../types.js'

import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess, requireMembershipRole } from '../../middleware/rbac.js'
import {
  getAgentById,
  getAgentErrors,
  getBenchmarksForAgent,
  listAgents,
  updateAgent,
} from '../../services/agents.js'
import { listTasksByAgent } from '../../services/tasks.js'

const dashboardAgentRoutes = new Hono<AppEnv>()

dashboardAgentRoutes.use('*', requireSession)

const AGENT_LIST_MAX_LIMIT = 200
const AGENT_LIST_DEFAULT_LIMIT = 50

// Coerce + clamp pagination at the schema boundary so handlers stay thin.
// Permissive: invalid values fall back to defaults rather than 400 — matches
// the rest of the dashboard surface, and keeps Infinity from leaking into
// Drizzle's `.offset()`/`.limit()`.
const listAgentsQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(AGENT_LIST_MAX_LIMIT)
    .catch(AGENT_LIST_DEFAULT_LIMIT)
    .default(AGENT_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).catch(0).default(0),
})

const agentIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const errorsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const validationErrorEnvelope = {
  error: { code: 'VALIDATION_ERROR', message: 'Invalid agent ID' },
}
const notFoundEnvelope = { error: { code: 'RESOURCE_NOT_FOUND', message: 'Agent not found' } }

// GET /agents — list agents with optional filtering
dashboardAgentRoutes.get(
  '/',
  requireProjectAccess(),
  zValidator('query', listAgentsQuerySchema),
  async (c) => {
    const { projectId } = c.get('currentUser')
    const { status, limit, offset } = c.req.valid('query')
    const result = await listAgents({ projectId: projectId ?? undefined, status, limit, offset })
    return c.json(result)
  }
)

// GET /agents/:id -- get agent details
dashboardAgentRoutes.get(
  '/:id',
  requireProjectAccess(),
  zValidator('param', agentIdParamSchema, (result, c) =>
    result.success ? undefined : c.json(validationErrorEnvelope, 400)
  ),
  async (c) => {
    const { id: agentId } = c.req.valid('param')
    const { projectId } = c.get('currentUser')
    const agent = await getAgentById(agentId)
    if (!agent || agent.projectId !== projectId) {
      return c.json(notFoundEnvelope, 404)
    }
    return c.json({ agent })
  }
)

// PATCH /agents/:id — update agent
const updateAgentSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  status: z.enum(['online', 'offline', 'busy', 'error']).optional(),
})

dashboardAgentRoutes.patch(
  '/:id',
  requireMembershipRole('admin', 'contributor'),
  zValidator('param', agentIdParamSchema, (result, c) =>
    result.success ? undefined : c.json(validationErrorEnvelope, 400)
  ),
  zValidator('json', updateAgentSchema),
  async (c) => {
    const { id: agentId } = c.req.valid('param')
    const data = c.req.valid('json')
    const { projectId } = c.get('currentUser')
    // Verify the target agent belongs to the caller's active project before
    // mutating. requireMembershipRole proves the caller is a project admin/
    // contributor for *their* session scope, but does NOT cross-check the
    // path-param agent ID. Returning 404 (not 403) on a cross-project hit
    // matches the sibling GET handler and avoids leaking that the agent
    // exists in a project the caller can't see.
    const existing = await getAgentById(agentId)
    if (!existing || existing.projectId !== projectId) {
      return c.json(notFoundEnvelope, 404)
    }
    const agent = await updateAgent(agentId, data)
    if (!agent) {
      return c.json(notFoundEnvelope, 404)
    }
    return c.json({ agent })
  }
)

// GET /agents/:id/errors -- get agent errors
dashboardAgentRoutes.get(
  '/:id/errors',
  requireProjectAccess(),
  zValidator('param', agentIdParamSchema, (result, c) =>
    result.success ? undefined : c.json(validationErrorEnvelope, 400)
  ),
  zValidator('query', errorsQuerySchema),
  async (c) => {
    const { id: agentId } = c.req.valid('param')
    const { projectId } = c.get('currentUser')
    const agent = await getAgentById(agentId)
    if (!agent || agent.projectId !== projectId) {
      return c.json(notFoundEnvelope, 404)
    }
    const { limit, offset } = c.req.valid('query')
    const errors = await getAgentErrors(agentId, { limit, offset })
    return c.json({ errors })
  }
)

// GET /agents/:id/tasks -- list active tasks assigned to the agent
dashboardAgentRoutes.get(
  '/:id/tasks',
  requireProjectAccess(),
  zValidator('param', agentIdParamSchema, (result, c) =>
    result.success ? undefined : c.json(validationErrorEnvelope, 400)
  ),
  async (c) => {
    const { id: agentId } = c.req.valid('param')
    const { projectId } = c.get('currentUser')
    const agent = await getAgentById(agentId)
    if (!agent || agent.projectId !== projectId) {
      return c.json(notFoundEnvelope, 404)
    }
    const tasks = await listTasksByAgent(agentId)
    return c.json({ tasks })
  }
)

// GET /agents/:id/benchmarks -- get agent benchmarks
dashboardAgentRoutes.get(
  '/:id/benchmarks',
  requireProjectAccess(),
  zValidator('param', agentIdParamSchema, (result, c) =>
    result.success ? undefined : c.json(validationErrorEnvelope, 400)
  ),
  async (c) => {
    const { id: agentId } = c.req.valid('param')
    const { projectId } = c.get('currentUser')
    const agent = await getAgentById(agentId)
    if (!agent || agent.projectId !== projectId) {
      return c.json(notFoundEnvelope, 404)
    }
    const benchmarks = await getBenchmarksForAgent(agentId)
    return c.json({ benchmarks })
  }
)

export { dashboardAgentRoutes }
