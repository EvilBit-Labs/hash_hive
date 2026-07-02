/**
 * Control API agent endpoints. Listing and admin-style updates; the
 * runtime-control surface (heartbeats, task assignment) stays on the
 * agent API and is not duplicated here.
 */

import { agentRetireResponseSchema, selectAgentSchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { paginate, paginationQuerySchema } from '../../lib/pagination.js'
import { problemResponse } from '../../lib/problem-details.js'
import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedControlResponse,
} from '../../openapi/components.js'
import { getAgentById, listAgents, retireAgent, updateAgent } from '../../services/agents.js'
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
    'Atomic UPDATE ... WHERE projectId AND status <> retired closes the read-then-write TOCTOU window and makes a retired agent immutable via this path. A not-found result collapses "wrong project" and "no such row" into the same 404; a retired agent reports 409 conflict.',
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
    409: sharedControlResponse(CONTROL_RESPONSE_REFS.Conflict),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlAgentRoutes.openapi(updateAgentRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'admin')
    const { id } = c.req.valid('param')
    const { userId } = c.get('currentUser')
    const result = await updateAgent(id, c.req.valid('json'), projectId, {
      actorType: 'user',
      actorId: userId,
    })
    switch (result.kind) {
      case 'not_found':
        return problemResponse(c, 404, 'not_found', 'agent not found')
      case 'retired':
        return problemResponse(c, 409, 'conflict', 'agent is retired and cannot be updated')
      case 'updated':
        return c.json(result.agent, 200)
    }
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── POST /:id/retire — retire an agent (admin only) ────────────────
//
// Control API parity for the dashboard's `POST /:id/retire` (issue
// #106 U9), backed by the same `retireAgent` service (U8). Admin-only —
// retirement is terminal (no restore path), matching the dashboard's
// precedent (stricter than the `contributor`-or-`admin` archive/restore
// endpoints above for hash lists, resources, and attacks).
//
// Outcome → HTTP status: `retired` → 200 with `{ outcome,
// releasedTaskIds }`; `not_found` → 404 `not_found`. `already_retired`
// is mapped to 409 `conflict` here rather than the dashboard's 200
// idempotent response — the Control surface treats "the requested
// state transition did not happen because the record is already in a
// terminal state" the same way archive/restore's `already_archived`
// does, so a machine client gets a consistent conflict signal across
// every lifecycle endpoint on this surface instead of having to special-
// case retire's idempotency.

const retireAgentRoute = createRoute({
  method: 'post',
  path: '/{id}/retire',
  tags: ['Agents'],
  summary: 'Retire an agent (admin only); terminal, no restore path',
  description:
    'Flips the agent to the terminal `retired` status and releases any task it currently holds (assigned/running) back to `pending` with `agent_id` cleared so the scheduler can reassign it. The agent row and all of its history (tasks, benchmarks, errors) are retained — this is a status change, not a delete.',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Retire outcome and the ids of any tasks released back to pending.',
      content: { 'application/json': { schema: agentRetireResponseSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    409: sharedControlResponse(CONTROL_RESPONSE_REFS.Conflict),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlAgentRoutes.openapi(retireAgentRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'admin')
    const { id } = c.req.valid('param')
    const user = c.get('currentUser')
    const result = await retireAgent(id, projectId, {
      actorType: 'user',
      actorId: user.userId,
    })
    switch (result.kind) {
      case 'not_found':
        return problemResponse(c, 404, 'not_found', 'agent not found')
      case 'already_retired':
        return problemResponse(c, 409, 'conflict', 'agent is already retired')
      case 'retired':
        return c.json({ outcome: 'retired' as const, releasedTaskIds: result.releasedTaskIds }, 200)
    }
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
