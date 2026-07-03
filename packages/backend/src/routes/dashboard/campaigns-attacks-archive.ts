/**
 * Attack archive & restore routes (ADR-0019, issue #106 U7).
 *
 * Extracted from `campaigns-attacks.ts` to mirror the `campaigns-archive.ts`
 * split from `campaigns.ts`: the same bulk `{ ids }` POST /archive +
 * POST /restore shape, `requireMembershipRole('admin', 'contributor')`
 * RBAC, and per-id outcome response, backed by `archiveAttacks` /
 * `restoreAttacks` (U6, re-exported from `services/campaigns.js`).
 *
 * Mounted at `/attacks/archive` and `/attacks/restore` on `campaignRoutes`
 * (not nested under `/{id}/attacks/...`) because the service is scoped by
 * `projectId` + a bulk `ids` array, not by a single parent campaign — an
 * operator can select attacks across multiple campaigns in one batch, the
 * same way resource archive/restore is project-scoped rather than
 * hash-list-scoped.
 */

import {
  attackArchiveRequestSchema,
  attackArchiveResponseSchema,
  attackRestoreResponseSchema,
} from '@hashhive/shared'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { requireMembershipRole } from '../../middleware/rbac.js'
import { DASHBOARD_RESPONSE_REFS, sharedDashboardResponse } from '../../openapi/components.js'
import { archiveAttacks, restoreAttacks } from '../../services/campaigns.js'

const archiveRoute = createRoute({
  method: 'post',
  path: '/attacks/archive',
  tags: ['Campaigns'],
  summary: 'Archive one or more permanent attacks',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    body: { content: { 'application/json': { schema: attackArchiveRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Per-id archive outcomes.',
      content: { 'application/json': { schema: attackArchiveResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
  },
})

const restoreRoute = createRoute({
  method: 'post',
  path: '/attacks/restore',
  tags: ['Campaigns'],
  summary: 'Restore one or more archived attacks',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    body: { content: { 'application/json': { schema: attackArchiveRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Per-id restore outcomes.',
      content: { 'application/json': { schema: attackRestoreResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
  },
})

export function registerCampaignAttackArchiveRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(archiveRoute, async (c) => {
    const { projectId, userId } = c.get('scopedUser')!
    const { ids } = c.req.valid('json')
    const results = await archiveAttacks(projectId, ids, { actorType: 'user', actorId: userId })
    return c.json({ results }, 200)
  })

  router.openapi(restoreRoute, async (c) => {
    const { projectId, userId } = c.get('scopedUser')!
    const { ids } = c.req.valid('json')
    const results = await restoreAttacks(projectId, ids, { actorType: 'user', actorId: userId })
    return c.json({ results }, 200)
  })
}
