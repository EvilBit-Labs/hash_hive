/**
 * Control API campaign endpoints. Full CRUD + state transitions —
 * automation's primary entry point for orchestrating cracking work.
 *
 * Role gates match the dashboard equivalents: write paths require
 * `contributor` or `admin`; read paths require any project member.
 */

import { changeCampaignPriorityRequestSchema, selectCampaignSchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { paginate, paginationQuerySchema } from '../../lib/pagination.js'
import { problemResponse } from '../../lib/problem-details.js'
import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedControlResponse,
} from '../../openapi/components.js'
import {
  changeRunningCampaignPriority,
  createCampaign,
  getCampaignById,
  listCampaigns,
  transitionCampaign,
  updateCampaign,
} from '../../services/campaigns.js'
import { controlErrorResponse, requireProjectMembership, requireProjectRole } from './helpers.js'

export const controlCampaignRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const campaignFilterSchema = z.object({
  status: z.enum(['draft', 'running', 'paused', 'completed', 'cancelled']).optional(),
})

const listCampaignsQuerySchema = paginationQuerySchema.merge(campaignFilterSchema)

const createCampaignSchema = z
  .object({
    name: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    hashListId: z.number().int().positive(),
    priority: z.number().int().min(0).max(10).optional(),
  })
  .strict()
  .openapi('ControlCreateCampaignRequest')

const updateCampaignSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(2000).optional(),
    priority: z.number().int().min(0).max(10).optional(),
  })
  .strict()
  .openapi('ControlUpdateCampaignRequest')

const transitionTargetSchema = z.enum(['draft', 'running', 'paused', 'completed', 'cancelled'])
const transitionRequestSchema = z
  .object({ targetStatus: transitionTargetSchema })
  .strict()
  .openapi('ControlTransitionCampaignRequest')

const campaignSchema = selectCampaignSchema.openapi('ControlCampaign')
const campaignPageSchema = z
  .object({
    items: z.array(campaignSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .openapi('ControlCampaignPage')

// `transitionCampaign` returns `{ campaign }` on the success path; the
// error variants (RESOURCE_VALIDATION_FAILED, RESOURCE_MISSING,
// QUEUE_UNAVAILABLE, STALE_STATE, TASK_GENERATION_FAILED) map to
// non-200 problem-details responses in the route handler, so this
// 200-body schema only needs the success shape.
const transitionResponseSchema = z
  .object({ campaign: selectCampaignSchema })
  .openapi('ControlCampaignTransitionResponse')

// ─── GET / — list campaigns ──────────────────────────────────────────

const listCampaignsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Campaigns'],
  summary: 'List campaigns in the active project, optionally filtered by status',
  security: [{ ControlApiKey: [] }],
  request: { query: listCampaignsQuerySchema },
  responses: {
    200: {
      description: 'Page of campaigns.',
      content: { 'application/json': { schema: campaignPageSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlCampaignRoutes.openapi(listCampaignsRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const query = c.req.valid('query')

    const { campaigns, total } = await listCampaigns({
      projectId,
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    })
    return c.json(paginate(campaigns, total, query), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── GET /:id — campaign details ─────────────────────────────────────

const getCampaignRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Campaigns'],
  summary: 'Get a campaign by id (scoped to the active project)',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Campaign details.',
      content: { 'application/json': { schema: campaignSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlCampaignRoutes.openapi(getCampaignRoute, async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c)
    const { id } = c.req.valid('param')
    const campaign = await getCampaignById(id)
    if (!campaign || campaign.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'campaign not found')
    }
    return c.json(campaign, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── POST / — create campaign ────────────────────────────────────────

const createCampaignRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Campaigns'],
  summary: 'Create a new campaign (contributor or admin only)',
  security: [{ ControlApiKey: [] }],
  request: {
    body: { content: { 'application/json': { schema: createCampaignSchema } } },
  },
  responses: {
    201: {
      description: 'Campaign created.',
      content: { 'application/json': { schema: campaignSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlCampaignRoutes.openapi(createCampaignRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const user = c.get('currentUser')
    const data = c.req.valid('json')
    const campaign = await createCampaign(
      {
        projectId,
        createdBy: user.userId,
        ...data,
      },
      { actorType: 'user', actorId: user.userId }
    )
    return c.json(campaign, 201)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── PATCH /:id — update campaign ───────────────────────────────────

const updateCampaignRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Campaigns'],
  summary: 'Update a draft campaign (contributor or admin only)',
  description:
    'The draft-only gate is enforced at the service layer via a discriminated union; non-draft campaigns return 409 conflict.',
  security: [{ ControlApiKey: [] }],
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: updateCampaignSchema } } },
  },
  responses: {
    200: {
      description: 'Updated campaign.',
      content: { 'application/json': { schema: campaignSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    409: sharedControlResponse(CONTROL_RESPONSE_REFS.Conflict),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlCampaignRoutes.openapi(updateCampaignRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { id } = c.req.valid('param')
    const existing = await getCampaignById(id)
    if (!existing || existing.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'campaign not found')
    }
    // updateCampaign returns a discriminated union so the draft-only
    // gate is enforced at the service layer for both dashboard and
    // Control API consumers. Map each variant to the appropriate
    // Control-API RFC 9457 problem-details response.
    const user = c.get('currentUser')
    const result = await updateCampaign(id, projectId, c.req.valid('json'), {
      actorType: 'user',
      actorId: user.userId,
    })
    switch (result.kind) {
      case 'updated':
        return c.json(result.campaign, 200)
      case 'not_found':
        return problemResponse(c, 404, 'not_found', 'campaign not found')
      case 'not_draft':
        return problemResponse(
          c,
          409,
          'conflict',
          `campaign cannot be updated in status "${result.status}"; only draft campaigns are editable`
        )
    }
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── POST /:id/transition — state machine transition ───────────────

const transitionCampaignRoute = createRoute({
  method: 'post',
  path: '/{id}/transition',
  tags: ['Campaigns'],
  summary: 'Transition a campaign to a new lifecycle state (contributor or admin only)',
  description:
    'Three failure branches with distinct retry semantics: QUEUE_UNAVAILABLE -> 503 transient infra (retry later); TASK_GENERATION_FAILED -> 500 internal (state did not transition); generic state-machine conflict -> 409 (do not retry).',
  security: [{ ControlApiKey: [] }],
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: transitionRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Campaign transitioned.',
      content: { 'application/json': { schema: transitionResponseSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    409: sharedControlResponse(CONTROL_RESPONSE_REFS.Conflict),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
    503: sharedControlResponse(CONTROL_RESPONSE_REFS.ServiceUnavailable),
  },
})

controlCampaignRoutes.openapi(transitionCampaignRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { id } = c.req.valid('param')
    const existing = await getCampaignById(id)
    if (!existing || existing.projectId !== projectId) {
      return problemResponse(c, 404, 'not_found', 'campaign not found')
    }
    const { targetStatus } = c.req.valid('json')
    const user = c.get('currentUser')
    const result = await transitionCampaign(id, targetStatus, {
      actorType: 'user',
      actorId: user.userId,
    })
    if ('error' in result) {
      if ('code' in result) {
        if (result.code === 'QUEUE_UNAVAILABLE') {
          logger.warn(
            { campaignId: id, requestId: c.get('requestId'), error: result.error },
            'campaign transition deferred — queue unavailable'
          )
          return problemResponse(c, 503, 'service_unavailable', 'Service temporarily unavailable')
        }
        if (result.code === 'TASK_GENERATION_FAILED') {
          logger.error(
            { campaignId: id, requestId: c.get('requestId'), error: result.error },
            'task generation failed during campaign transition'
          )
          return problemResponse(c, 500, 'internal', 'An unexpected error occurred')
        }
      }
      return problemResponse(c, 409, 'conflict', result.error)
    }
    return c.json(result, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

// ─── POST /:id/priority — change a live campaign's priority (#97 U7) ─

const changePrioritySchema = changeCampaignPriorityRequestSchema.openapi(
  'ControlChangePriorityRequest'
)

const changePriorityRoute = createRoute({
  method: 'post',
  path: '/{id}/priority',
  tags: ['Campaigns'],
  summary: "Change a running or paused campaign's priority (contributor or admin only)",
  description:
    'Re-prioritises a live campaign and re-evaluates preemption. The draft-only PATCH /{id} cannot change a running campaign; non-running/paused campaigns return 409 conflict.',
  security: [{ ControlApiKey: [] }],
  request: {
    params: idParamSchema,
    body: { content: { 'application/json': { schema: changePrioritySchema } } },
  },
  responses: {
    200: {
      description: 'Priority changed.',
      content: { 'application/json': { schema: campaignSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    409: sharedControlResponse(CONTROL_RESPONSE_REFS.Conflict),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlCampaignRoutes.openapi(changePriorityRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'contributor', 'admin')
    const { id } = c.req.valid('param')
    const { priority } = c.req.valid('json')
    const user = c.get('currentUser')
    const result = await changeRunningCampaignPriority(id, projectId, priority, {
      actorType: 'user',
      actorId: user.userId,
    })
    switch (result.kind) {
      case 'updated':
        return c.json(result.campaign, 200)
      case 'not_found':
        return problemResponse(c, 404, 'not_found', 'campaign not found')
      case 'not_active':
        return problemResponse(
          c,
          409,
          'conflict',
          `campaign priority cannot be changed in status "${result.status}"; only running or paused campaigns can be re-prioritised`
        )
    }
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
