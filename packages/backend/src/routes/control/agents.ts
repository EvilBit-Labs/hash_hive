/**
 * Control API agent endpoints. Listing and admin-style updates; the
 * runtime-control surface (heartbeats, task assignment) stays on the
 * agent API and is not duplicated here.
 */

import { selectAgentSchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { paginate, paginationQuerySchema } from '../../lib/pagination.js'
import { problemResponse } from '../../lib/problem-details.js'
import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedControlResponse,
} from '../../openapi/components.js'
import { getAgentById, listAgents, updateAgent } from '../../services/agents.js'
import { controlErrorResponse, requireProjectMembership, requireProjectRole } from './helpers.js'

export const controlAgentRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const agentStatusFilter = z.enum(['online', 'offline', 'busy', 'error', 'benchmarked']).optional()

const listAgentsQuerySchema = paginationQuerySchema.merge(z.object({ status: agentStatusFilter }))

const updateAgentSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    status: z.enum(['online', 'offline', 'busy', 'error']).optional(),
  })
  .strict()
  .openapi('ControlUpdateAgentRequest')

// Use the drizzle-zod select schema from @hashhive/shared so the
// runtime spec and the wire shape can't drift. Service-layer returns
// match this row shape directly.
const agentSchema = selectAgentSchema.openapi('ControlAgent')
const agentPageSchema = z
  .object({
    items: z.array(agentSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .openapi('ControlAgentPage')

// ─── GET / — list agents ─────────────────────────────────────────────

const listAgentsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Agents'],
  summary: 'List agents in the active project, optionally filtered by status',
  security: [{ ControlApiKey: [] }],
  request: { query: listAgentsQuerySchema },
  responses: {
    200: {
      description: 'Page of agents.',
      content: { 'application/json': { schema: agentPageSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlAgentRoutes.openapi(listAgentsRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const query = c.req.valid('query')

    const { agents, total } = await listAgents({
      projectId,
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    })
    return c.json(paginate(agents, total, query), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── GET /:id — agent details ───────────────────────────────────────

const getAgentRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Agents'],
  summary: 'Get an agent by id (scoped to the active project)',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Agent details.',
      content: { 'application/json': { schema: agentSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlAgentRoutes.openapi(getAgentRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const { id } = c.req.valid('param')
    const agent = await getAgentById(id)
    if (!agent || agent.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'agent not found')
    }
    return c.json(agent, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── PATCH /:id — update agent (admin only) ────────────────────────

const updateAgentRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Agents'],
  summary: 'Update agent name or status (admin only)',
  description:
    'Atomic UPDATE ... WHERE projectId closes the read-then-write TOCTOU window. A null return collapses "wrong project" and "no such row" into the same 404.',
  security: [{ ControlApiKey: [] }],
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: updateAgentSchema } } },
  },
  responses: {
    200: {
      description: 'Updated agent.',
      content: { 'application/json': { schema: agentSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlAgentRoutes.openapi(updateAgentRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'admin')
    const { id } = c.req.valid('param')
    const updated = await updateAgent(id, c.req.valid('json'), projectId)
    if (!updated) {
      return problemResponse(c, 404, 'not_found', 'agent not found')
    }
    return c.json(updated, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
