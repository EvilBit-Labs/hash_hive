/**
 * Control API task endpoints. Listing and inspection only — task lifecycle
 * (assign / report) belongs to the agent API.
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
import { getCampaignById } from '../../services/campaigns.js'
import { getTaskById, listTasks } from '../../services/tasks.js'
import { controlErrorResponse, requireProjectMembership } from './helpers.js'

export const controlTaskRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

// `campaignId` is REQUIRED — the dashboard tasks service does not
// enforce project scoping by itself, so the caller must name a campaign
// we can verify belongs to the active project. Marking it required at
// the Zod layer means the validation message and the RFC 9457
// problem-details envelope are single-sourced through controlErrorResponse.
const taskFilterSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed', 'exhausted']).optional(),
  agentId: z.coerce.number().int().positive().optional(),
  campaignId: z.coerce.number().int().positive(),
  attackId: z.coerce.number().int().positive().optional(),
})

const listTasksQuerySchema = paginationQuerySchema.merge(taskFilterSchema)

const taskSchema = z.object({}).passthrough().openapi('ControlTask')
const taskPageSchema = z
  .object({
    items: z.array(taskSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .openapi('ControlTaskPage')

const listTasksRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Tasks'],
  summary: 'List tasks for a campaign (campaignId required)',
  security: [{ ControlApiKey: [] }],
  request: { query: listTasksQuerySchema },
  responses: {
    200: {
      description: 'Page of tasks.',
      content: { 'application/json': { schema: taskPageSchema } },
    },
    400: sharedResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlTaskRoutes.openapi(listTasksRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const query = c.req.valid('query')

    const campaign = await getCampaignById(query.campaignId)
    if (!campaign || campaign.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'campaign not found')
    }

    const { tasks, total } = await listTasks({
      status: query.status,
      agentId: query.agentId,
      campaignId: query.campaignId,
      attackId: query.attackId,
      projectId,
      limit: query.limit,
      offset: query.offset,
    })
    return c.json(paginate(tasks, total, query), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

const getTaskRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Tasks'],
  summary: 'Get a task by id (scoped to the active project)',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Task details.',
      content: { 'application/json': { schema: taskSchema } },
    },
    400: sharedResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlTaskRoutes.openapi(getTaskRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const { id } = c.req.valid('param')
    // getTaskById enforces the projectId predicate at the service
    // layer via INNER JOIN on campaigns.
    const task = await getTaskById(id, projectId)
    if (!task) return problemResponse(c, 404, 'not_found', 'task not found')
    return c.json(task, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
