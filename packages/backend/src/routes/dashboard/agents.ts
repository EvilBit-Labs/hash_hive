import { agentRetireResponseSchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireMembershipRole, requireProjectAccess } from '../../middleware/rbac.js'
import { coercedIntegerQuery } from '../../openapi/coerced-query.js'
import {
  DASHBOARD_RESPONSE_REFS,
  sharedDashboardResponse,
  dashboardOpenApiHonoOptions,
} from '../../openapi/components.js'
import {
  getAgentById,
  getAgentErrors,
  getBenchmarksForAgent,
  listAgents,
  retireAgent,
  rotateAgentToken,
  updateAgent,
} from '../../services/agents.js'
import { listTasksByAgent } from '../../services/tasks.js'

const dashboardAgentRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

dashboardAgentRoutes.use('*', requireSession)

const AGENT_LIST_MAX_LIMIT = 200
const AGENT_LIST_DEFAULT_LIMIT = 50

// Coerce + clamp pagination at the schema boundary so handlers stay thin.
// Permissive: invalid values fall back to defaults rather than 400 — matches
// the rest of the dashboard surface, and keeps Infinity from leaking into
// Drizzle's `.offset()`/`.limit()`.
const listAgentsQuerySchema = z.object({
  status: z.string().optional(),
  limit: coercedIntegerQuery({
    min: 1,
    max: AGENT_LIST_MAX_LIMIT,
    default: AGENT_LIST_DEFAULT_LIMIT,
  }),
  offset: coercedIntegerQuery({ min: 0, default: 0 }),
})

const agentIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const errorsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const updateAgentSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  status: z.enum(['online', 'offline', 'busy', 'error']).optional(),
})

// Response shapes — passthrough where the underlying handler returns
// dynamic shapes; tightened in U4 if the YAML diff demands precision.

const agentListResponseSchema = z
  .object({
    agents: z.array(z.unknown()),
    total: z.number().int().nonnegative().optional(),
  })
  .passthrough()
  .openapi('AgentList')

const agentDetailResponseSchema = z
  .object({ agent: z.unknown() })
  .passthrough()
  .openapi('AgentDetail')

const agentErrorsResponseSchema = z
  .object({ errors: z.array(z.unknown()) })
  .passthrough()
  .openapi('AgentErrors')

const agentTasksResponseSchema = z
  .object({ tasks: z.array(z.unknown()) })
  .passthrough()
  .openapi('AgentTasks')

const agentBenchmarksResponseSchema = z
  .object({ benchmarks: z.array(z.unknown()) })
  .passthrough()
  .openapi('AgentBenchmarks')

const rotateTokenResponseSchema = z
  .object({ token: z.string() })
  .openapi('AgentRotateTokenResponse')

// ─── GET / — list agents ────────────────────────────────────────────

dashboardAgentRoutes.use('/', requireProjectAccess())

const listAgentsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Agents'],
  summary: 'List agents in the active project, filtered by status with paging',
  security: [{ SessionCookie: [] }],
  request: { query: listAgentsQuerySchema },
  responses: {
    200: {
      description: 'Page of agents.',
      content: { 'application/json': { schema: agentListResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  },
})

dashboardAgentRoutes.openapi(listAgentsRoute, async (c) => {
  const { projectId } = c.get('currentUser')
  const { status, limit, offset } = c.req.valid('query')
  const result = await listAgents({
    ...(projectId !== undefined && projectId !== null ? { projectId } : {}),
    status,
    limit,
    offset,
  })
  return c.json(result, 200)
})

// ─── GET /:id — agent details ───────────────────────────────────────

dashboardAgentRoutes.use('/:id', requireProjectAccess())

const getAgentRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Agents'],
  summary: 'Get agent details by id',
  security: [{ SessionCookie: [] }],
  request: { params: agentIdParamSchema },
  responses: {
    200: {
      description: 'Agent details.',
      content: { 'application/json': { schema: agentDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

dashboardAgentRoutes.openapi(getAgentRoute, async (c) => {
  const { id: agentId } = c.req.valid('param')
  const { projectId } = c.get('currentUser')
  const agent = await getAgentById(agentId)
  if (!agent || agent.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Agent not found')
  }
  return c.json({ agent }, 200)
})

// ─── PATCH /:id — update agent (admin or contributor) ──────────────
//
// requireMembershipRole supersedes requireProjectAccess on this path:
// Hono runs all matching middleware in registration order, so we mount
// the role check via createRoute({ middleware: [...] }) which the
// library threads through for THIS route only — the path-level
// requireProjectAccess applied above still runs for sibling GET/:id
// handlers unchanged.

const updateAgentRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Agents'],
  summary: 'Update agent name or status (admin / contributor only)',
  description:
    'Atomic UPDATE ... WHERE projectId enforces project scope inside the write itself, closing the read-then-write TOCTOU window the earlier getAgentById-then-updateAgent pattern left open. A null return collapses "wrong project" and "no such row" into the same 404, matching the sibling GET handler and avoiding the cross-project existence leak.',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: agentIdParamSchema,
    body: { content: { 'application/json': { schema: updateAgentSchema } } },
  },
  responses: {
    200: {
      description: 'Updated agent.',
      content: { 'application/json': { schema: agentDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

dashboardAgentRoutes.openapi(updateAgentRoute, async (c) => {
  const { id: agentId } = c.req.valid('param')
  const data = c.req.valid('json')
  const { projectId, userId } = c.get('scopedUser')!
  const agent = await updateAgent(agentId, data, projectId, {
    actorType: 'user',
    actorId: userId,
  })
  if (!agent) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Agent not found')
  }
  return c.json({ agent }, 200)
})

// ─── GET /:id/errors ────────────────────────────────────────────────

dashboardAgentRoutes.use('/:id/errors', requireProjectAccess())

const getAgentErrorsRoute = createRoute({
  method: 'get',
  path: '/{id}/errors',
  tags: ['Agents'],
  summary: 'Recent agent errors with optional paging',
  security: [{ SessionCookie: [] }],
  request: { params: agentIdParamSchema, query: errorsQuerySchema },
  responses: {
    200: {
      description: 'Page of agent errors.',
      content: { 'application/json': { schema: agentErrorsResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

dashboardAgentRoutes.openapi(getAgentErrorsRoute, async (c) => {
  const { id: agentId } = c.req.valid('param')
  const { projectId } = c.get('currentUser')
  const agent = await getAgentById(agentId)
  if (!agent || agent.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Agent not found')
  }
  const { limit, offset } = c.req.valid('query')
  const errors = await getAgentErrors(agentId, { limit, offset })
  return c.json({ errors }, 200)
})

// ─── GET /:id/tasks ─────────────────────────────────────────────────

dashboardAgentRoutes.use('/:id/tasks', requireProjectAccess())

const getAgentTasksRoute = createRoute({
  method: 'get',
  path: '/{id}/tasks',
  tags: ['Agents'],
  summary: 'List active tasks assigned to an agent',
  security: [{ SessionCookie: [] }],
  request: { params: agentIdParamSchema },
  responses: {
    200: {
      description: 'Tasks currently assigned to the agent.',
      content: { 'application/json': { schema: agentTasksResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

dashboardAgentRoutes.openapi(getAgentTasksRoute, async (c) => {
  const { id: agentId } = c.req.valid('param')
  const { projectId } = c.get('currentUser')
  const agent = await getAgentById(agentId)
  if (!agent || agent.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Agent not found')
  }
  const tasks = await listTasksByAgent(agentId, projectId as number)
  return c.json({ tasks }, 200)
})

// ─── GET /:id/benchmarks ────────────────────────────────────────────

dashboardAgentRoutes.use('/:id/benchmarks', requireProjectAccess())

const getAgentBenchmarksRoute = createRoute({
  method: 'get',
  path: '/{id}/benchmarks',
  tags: ['Agents'],
  summary: 'Benchmarks reported by an agent',
  security: [{ SessionCookie: [] }],
  request: { params: agentIdParamSchema },
  responses: {
    200: {
      description: 'Agent benchmarks.',
      content: { 'application/json': { schema: agentBenchmarksResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

dashboardAgentRoutes.openapi(getAgentBenchmarksRoute, async (c) => {
  const { id: agentId } = c.req.valid('param')
  const { projectId } = c.get('currentUser')
  const agent = await getAgentById(agentId)
  if (!agent || agent.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Agent not found')
  }
  const benchmarks = await getBenchmarksForAgent(agentId)
  return c.json({ benchmarks }, 200)
})

// ─── POST /:id/rotate-token (admin only) ────────────────────────────
//
// S-H2: rotate an agent's bearer token. Admin-only. The raw token is
// returned in the response exactly once with Cache-Control: no-store
// so browser history, proxies, and operator tabs don't retain it.

const rotateTokenRoute = createRoute({
  method: 'post',
  path: '/{id}/rotate-token',
  tags: ['Agents'],
  summary: "Rotate an agent's bearer token (admin only); raw token returned once",
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin')] as const,
  request: { params: agentIdParamSchema },
  responses: {
    200: {
      description: 'Rotated token returned exactly once.',
      content: { 'application/json': { schema: rotateTokenResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

dashboardAgentRoutes.openapi(rotateTokenRoute, async (c) => {
  const { id: agentId } = c.req.valid('param')
  const { projectId } = c.get('scopedUser')!
  const result = await rotateAgentToken(agentId, projectId)
  if (!result) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Agent not found')
  }
  c.header('Cache-Control', 'no-store')
  return c.json({ token: result.token }, 200)
})

// ─── POST /:id/retire (admin only) ──────────────────────────────────
//
// Issue #106 U8/U9: retirement is terminal — there is no agent restore
// path, so unlike the reversible archive/restore surfaces (campaigns,
// resources, attacks — all `requireMembershipRole('admin', 'contributor')`)
// this is admin-only, matching the precedent set by rotate-token above
// (the other irreversible-outside-band agent action in this file).

const retireAgentRoute = createRoute({
  method: 'post',
  path: '/{id}/retire',
  tags: ['Agents'],
  summary: 'Retire an agent (admin only); terminal, no restore path',
  description:
    'Flips the agent to the terminal `retired` status and releases any task it currently holds (assigned/running) back to `pending` with `agent_id` cleared so the scheduler can reassign it (R8). The agent row and all of its history (tasks, benchmarks, errors) are retained (R9) — this is a status change, not a delete. A retired agent is excluded from the default `listAgents` view and its heartbeats can never revert the status.',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin')] as const,
  request: { params: agentIdParamSchema },
  responses: {
    200: {
      description: 'Retire outcome and the ids of any tasks released back to pending.',
      content: { 'application/json': { schema: agentRetireResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

dashboardAgentRoutes.openapi(retireAgentRoute, async (c) => {
  const { id: agentId } = c.req.valid('param')
  const { projectId, userId } = c.get('scopedUser')!
  const result = await retireAgent(agentId, projectId, { actorType: 'user', actorId: userId })

  switch (result.kind) {
    case 'not_found':
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Agent not found')
    case 'already_retired':
      return c.json({ outcome: 'already_retired' as const, releasedTaskIds: [] }, 200)
    case 'retired':
      return c.json({ outcome: 'retired' as const, releasedTaskIds: result.releasedTaskIds }, 200)
  }
})

export { dashboardAgentRoutes }
