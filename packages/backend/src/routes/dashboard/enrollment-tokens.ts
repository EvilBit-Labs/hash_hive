/**
 * Dashboard enrollment-token routes — `/api/v1/dashboard/enrollment-tokens/*`.
 *
 * Admins mint / list / revoke the enrollment tokens that new agents use to
 * register (see `services/enrollment-tokens.ts` and the anonymous
 * `POST /api/v1/agent/enroll` endpoint). All routes are project-scoped;
 * create and revoke require the project-admin membership role, mirroring
 * the agent token-rotation route. The raw token is returned exactly once
 * on create with `Cache-Control: no-store`.
 */
import {
  createEnrollmentTokenRequestSchema,
  createEnrollmentTokenResponseSchema,
  enrollmentTokenMetadataSchema,
  listEnrollmentTokensResponseSchema,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireMembershipRole, requireProjectAccess } from '../../middleware/rbac.js'
import {
  DASHBOARD_RESPONSE_REFS,
  dashboardOpenApiHonoOptions,
  sharedDashboardResponse,
} from '../../openapi/components.js'
import {
  createEnrollmentToken,
  listEnrollmentTokens,
  revokeEnrollmentToken,
} from '../../services/enrollment-tokens.js'

const enrollmentTokenRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

enrollmentTokenRoutes.use('*', requireSession)

const idParamSchema = z.object({ id: z.coerce.number().int().positive() })

// ─── POST / — mint an enrollment token (admin) ──────────────────────

const createTokenRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Enrollment'],
  summary: 'Mint an enrollment token (project admin only); raw token returned once',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin')] as const,
  request: {
    body: { content: { 'application/json': { schema: createEnrollmentTokenRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Token minted. Raw token returned exactly once.',
      content: { 'application/json': { schema: createEnrollmentTokenResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    422: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
  },
})

enrollmentTokenRoutes.openapi(createTokenRoute, async (c) => {
  const { userId, projectId } = c.get('scopedUser')!
  const data = c.req.valid('json')

  // expiresAt is validated as ISO by Zod; the only semantic check left is
  // that it is in the future (a past expiry would mint a dead-on-arrival
  // token).
  const expiresAt = data.expiresAt ? new Date(data.expiresAt) : undefined
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return dashboardError(c, 422, 'VALIDATION_ERROR', 'expiresAt must be in the future')
  }

  try {
    const result = await createEnrollmentToken(projectId, userId, {
      label: data.label,
      isReusable: data.isReusable,
      maxUses: data.maxUses,
      expiresAt,
    })
    c.header('Cache-Control', 'no-store')
    return c.json(result, 201)
  } catch (err) {
    logger.error({ err, projectId }, 'Failed to mint enrollment token')
    return dashboardError(
      c,
      500,
      'ENROLLMENT_TOKEN_CREATE_FAILED',
      'Failed to mint enrollment token'
    )
  }
})

// ─── GET / — list enrollment tokens ─────────────────────────────────

const listTokensRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Enrollment'],
  summary: 'List the active project enrollment tokens (metadata only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireProjectAccess()] as const,
  responses: {
    200: {
      description: 'Enrollment token metadata (never the secret).',
      content: { 'application/json': { schema: listEnrollmentTokensResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    500: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.InternalError),
  },
})

enrollmentTokenRoutes.openapi(listTokensRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  try {
    const tokens = await listEnrollmentTokens(projectId)
    return c.json({ tokens }, 200)
  } catch (err) {
    logger.error({ err, projectId }, 'Failed to list enrollment tokens')
    return dashboardError(
      c,
      500,
      'ENROLLMENT_TOKEN_LIST_FAILED',
      'Failed to list enrollment tokens'
    )
  }
})

// ─── DELETE /{id} — revoke an enrollment token (admin) ──────────────

const revokeTokenRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Enrollment'],
  summary: 'Revoke an enrollment token (project admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin')] as const,
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Token revoked; returns the final metadata.',
      content: { 'application/json': { schema: enrollmentTokenMetadataSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    500: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.InternalError),
  },
})

enrollmentTokenRoutes.openapi(revokeTokenRoute, async (c) => {
  const { id } = c.req.valid('param')
  const { projectId } = c.get('scopedUser')!
  try {
    const metadata = await revokeEnrollmentToken(id, projectId)
    if (!metadata) {
      return dashboardError(c, 404, 'ENROLLMENT_TOKEN_NOT_FOUND', 'Enrollment token not found')
    }
    return c.json(metadata, 200)
  } catch (err) {
    logger.error({ err, projectId, tokenId: id }, 'Failed to revoke enrollment token')
    return dashboardError(
      c,
      500,
      'ENROLLMENT_TOKEN_REVOKE_FAILED',
      'Failed to revoke enrollment token'
    )
  }
})

export { enrollmentTokenRoutes }
