/**
 * Campaign lifecycle routes — extracted from `campaigns.ts` to keep
 * the main file under the 800-line cap. Registered against the same
 * `campaignRoutes` router via `registerCampaignLifecycleRoutes(router)`
 * so URL paths and middleware composition stay identical.
 *
 * Covers:
 *  - POST /{id}/lifecycle  (action-enum: start | pause | resume | stop | cancel)
 *  - POST /{id}/start
 *  - POST /{id}/pause
 *  - POST /{id}/resume
 *  - POST /{id}/stop
 *  - POST /{id}/cancel
 *
 * The action-enum route is kept for the frontend; the spec-named
 * aliases delegate to the same `transitionCampaign` service so every
 * transition path goes through the queue-check, task-generation, and
 * event-emission logic the service layer owns.
 */

import type { Context } from 'hono'

import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireMembershipRole } from '../../middleware/rbac.js'
import { DASHBOARD_RESPONSE_REFS, sharedDashboardResponse } from '../../openapi/components.js'
import { getCampaignById, transitionCampaign } from '../../services/campaigns.js'
import {
  campaignIdParamSchema,
  lifecycleResponseSchema,
  respondToTransition,
} from './campaigns-shared.js'

const lifecycleSchema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'stop', 'cancel']),
})

const lifecycleAliasStatus = {
  start: 'running',
  pause: 'paused',
  resume: 'running',
  stop: 'draft',
  cancel: 'cancelled',
} as const

type LifecycleAliasAction = keyof typeof lifecycleAliasStatus

async function lifecycleAliasHandler(c: Context<AppEnv>, id: number, action: LifecycleAliasAction) {
  const { projectId, userId } = c.get('scopedUser')!
  const existing = await getCampaignById(id)
  if (!existing || existing.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
  }

  const result = await transitionCampaign(id, lifecycleAliasStatus[action], {
    actorType: 'user',
    actorId: userId,
  })
  return respondToTransition(c, result)
}

function buildLifecycleAliasRoute(action: LifecycleAliasAction) {
  return createRoute({
    method: 'post',
    path: `/{id}/${action}`,
    tags: ['Campaigns'],
    summary: `Transition a campaign via the /${action} alias`,
    security: [{ SessionCookie: [] }],
    middleware: [requireMembershipRole('admin', 'contributor')] as const,
    request: {
      params: campaignIdParamSchema,
    },
    responses: {
      200: {
        description: 'Campaign transitioned.',
        content: { 'application/json': { schema: lifecycleResponseSchema } },
      },
      401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
      403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
      400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
      404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
      409: {
        description: 'Stale state or referenced resources missing.',
        content: { 'application/json': { schema: z.object({}).passthrough() } },
      },
      500: {
        description: 'Task generation failed during transition.',
        content: { 'application/json': { schema: z.object({}).passthrough() } },
      },
      503: {
        description: 'Queue or resource lookup unavailable.',
        content: { 'application/json': { schema: z.object({}).passthrough() } },
      },
    },
  })
}

const lifecycleActionRoute = createRoute({
  method: 'post',
  path: '/{id}/lifecycle',
  tags: ['Campaigns'],
  summary: 'Transition a campaign by action enum (start|pause|resume|stop|cancel)',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: campaignIdParamSchema,
    body: {
      content: {
        'application/json': { schema: lifecycleSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Campaign transitioned.',
      content: { 'application/json': { schema: lifecycleResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'Stale state or referenced resources missing.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    500: {
      description: 'Task generation failed during transition.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
    503: {
      description: 'Queue or resource lookup unavailable.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
})

export function registerCampaignLifecycleRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(lifecycleActionRoute, async (c) => {
    const { id } = c.req.valid('param')

    // transitionCampaign fetches by id alone; without this guard a
    // contributor in project A could transition a campaign in project
    // B by guessing the id. Mirrors the per-alias handler check.
    const { projectId, userId } = c.get('scopedUser')!
    const existing = await getCampaignById(id)
    if (!existing || existing.projectId !== projectId) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Campaign not found')
    }

    const { action } = c.req.valid('json')

    // `lifecycleAliasStatus` is the shared action→status map both this
    // action-enum route and the spec-named alias routes use, so a new
    // lifecycle action only needs to be added in one place.
    const result = await transitionCampaign(id, lifecycleAliasStatus[action], {
      actorType: 'user',
      actorId: userId,
    })
    return respondToTransition(c, result)
  })

  router.openapi(buildLifecycleAliasRoute('start'), async (c) => {
    const { id } = c.req.valid('param')
    return lifecycleAliasHandler(c, id, 'start')
  })
  router.openapi(buildLifecycleAliasRoute('pause'), async (c) => {
    const { id } = c.req.valid('param')
    return lifecycleAliasHandler(c, id, 'pause')
  })
  router.openapi(buildLifecycleAliasRoute('resume'), async (c) => {
    const { id } = c.req.valid('param')
    return lifecycleAliasHandler(c, id, 'resume')
  })
  router.openapi(buildLifecycleAliasRoute('stop'), async (c) => {
    const { id } = c.req.valid('param')
    return lifecycleAliasHandler(c, id, 'stop')
  })
  router.openapi(buildLifecycleAliasRoute('cancel'), async (c) => {
    const { id } = c.req.valid('param')
    return lifecycleAliasHandler(c, id, 'cancel')
  })
}
