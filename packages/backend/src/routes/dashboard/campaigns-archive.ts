/**
 * Campaign archive / restore routes (ADR-0019) — extracted from
 * `campaigns.ts` to keep that module under the 800-line cap. Registered
 * against the same `campaignRoutes` router via
 * `registerCampaignArchiveRoutes(router)`.
 *
 * Bulk by design: POST /archive and POST /restore take `{ ids: [...] }` and
 * return per-id outcomes. Project scope is enforced inside the service
 * UPDATE, so a cross-project id reports `not_found` rather than mutating
 * another project's campaign.
 */

import {
  campaignArchiveRequestSchema,
  campaignArchiveResponseSchema,
  campaignRestoreResponseSchema,
} from '@hashhive/shared'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { requireMembershipRole } from '../../middleware/rbac.js'
import { DASHBOARD_RESPONSE_REFS, sharedDashboardResponse } from '../../openapi/components.js'
import { archiveCampaigns, restoreCampaigns } from '../../services/campaign-dashboard.js'

const archiveRoute = createRoute({
  method: 'post',
  path: '/archive',
  tags: ['Campaigns'],
  summary: 'Archive one or more completed/cancelled campaigns',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    body: { content: { 'application/json': { schema: campaignArchiveRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Per-id archive outcomes.',
      content: { 'application/json': { schema: campaignArchiveResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
  },
})

const restoreRoute = createRoute({
  method: 'post',
  path: '/restore',
  tags: ['Campaigns'],
  summary: 'Restore one or more archived campaigns',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    body: { content: { 'application/json': { schema: campaignArchiveRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Per-id restore outcomes.',
      content: { 'application/json': { schema: campaignRestoreResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
  },
})

export function registerCampaignArchiveRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(archiveRoute, async (c) => {
    const { projectId } = c.get('scopedUser')!
    const { ids } = c.req.valid('json')
    const results = await archiveCampaigns(projectId, ids)
    return c.json({ results }, 200)
  })

  router.openapi(restoreRoute, async (c) => {
    const { projectId } = c.get('scopedUser')!
    const { ids } = c.req.valid('json')
    const results = await restoreCampaigns(projectId, ids)
    return c.json({ results }, 200)
  })
}
