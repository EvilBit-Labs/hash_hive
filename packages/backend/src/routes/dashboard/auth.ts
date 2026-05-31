import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { DASHBOARD_RESPONSE_REFS, sharedResponse } from '../../openapi/components.js'
import {
  getUserApiKeyMetadata,
  getUserWithProjects,
  issueUserApiKey,
  revokeUserApiKey,
} from '../../services/auth.js'

const authRouter = new OpenAPIHono<AppEnv>()

authRouter.use('*', requireSession)

// ─── Shared response shapes ─────────────────────────────────────────

const meResponseSchema = z
  .object({
    id: z.number().int(),
    email: z.string(),
    name: z.string(),
    roles: z.array(z.string()).optional(),
    projects: z.array(z.unknown()),
    selectedProjectId: z.number().int().nullable(),
  })
  .passthrough()
  .openapi('Me')

const apiKeyMetadataSchema = z
  .object({
    lastFour: z.string().nullable(),
    issuedAt: z.string().nullable(),
    revokedAt: z.string().nullable().optional(),
  })
  .passthrough()
  .openapi('ApiKeyMetadata')

const issueApiKeyResponseSchema = z
  .object({
    token: z.string(),
    metadata: apiKeyMetadataSchema,
  })
  .openapi('IssueApiKeyResponse')

// ─── GET /me — authenticated user profile + projects ────────────────

const getMeRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['Auth'],
  summary: "Return the authenticated user's profile and project memberships",
  description:
    'Frontend (#160 selector UI) consumes `selectedProjectId` to decide whether to land on the dashboard or the selector in a single round trip, rather than waiting for the WebSocket subscription to hydrate `useUiStore.selectedProjectId`. `selectedProjectId` mirrors `currentUser.projectId`, sourced exclusively from the server-managed BetterAuth session row (issue #159 U4).',
  security: [{ SessionCookie: [] }],
  responses: {
    200: {
      description: 'User profile, memberships, and selected project context.',
      content: { 'application/json': { schema: meResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

authRouter.openapi(getMeRoute, async (c) => {
  const { userId, projectId } = c.get('currentUser')
  // Wrapped in try/catch for symmetry with sibling /me/api-key routes.
  // A DB blip during getUserWithProjects would otherwise bubble as an
  // unstructured 500 and bypass the dashboard error envelope.
  try {
    const result = await getUserWithProjects(userId)
    if (!result) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'User not found')
    }
    // Coerce undefined → null so the field is always present per
    // meResponseSchema's nullable() contract.
    return c.json({ ...result, selectedProjectId: projectId ?? null }, 200)
  } catch (err) {
    logger.error({ err, userId, op: 'getUserWithProjects' }, 'GET /me lookup failed')
    return dashboardError(c, 500, 'INTERNAL_ERROR', 'Failed to read user profile')
  }
})

// ─── /me/api-key — issue / read / revoke ────────────────────────────
// Each handler wraps in try/catch so a transient DB failure surfaces
// as a structured 500 with operation + userId in the log, rather than
// bubbling to Hono's default handler which would leave a partial-write
// incident invisible.

const issueApiKeyRoute = createRoute({
  method: 'post',
  path: '/me/api-key',
  tags: ['Auth'],
  summary: 'Issue a new Control API key for the authenticated user',
  description:
    'The raw token is returned exactly once. Subsequent reads via GET /me/api-key surface only metadata. Response is marked uncacheable (Cache-Control + Pragma) for legacy intermediaries.',
  security: [{ SessionCookie: [] }],
  responses: {
    201: {
      description: 'API key issued; token returned once.',
      content: { 'application/json': { schema: issueApiKeyResponseSchema } },
    },
    200: {
      description: 'API key issued; token returned once (legacy response code).',
      content: { 'application/json': { schema: issueApiKeyResponseSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
  },
})

authRouter.openapi(issueApiKeyRoute, async (c) => {
  const { userId } = c.get('currentUser')
  try {
    const { token, metadata } = await issueUserApiKey(userId)
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    return c.json({ token, metadata }, 200)
  } catch (err) {
    logger.error({ err, userId, op: 'issueUserApiKey' }, 'API key issue failed')
    return dashboardError(c, 500, 'API_KEY_ISSUE_FAILED', 'Failed to issue API key')
  }
})

const getApiKeyRoute = createRoute({
  method: 'get',
  path: '/me/api-key',
  tags: ['Auth'],
  summary: "Read the authenticated user's API key metadata (no raw token)",
  security: [{ SessionCookie: [] }],
  responses: {
    200: {
      description: 'API key metadata (lastFour, issuedAt, optional revokedAt).',
      content: { 'application/json': { schema: apiKeyMetadataSchema } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
  },
})

authRouter.openapi(getApiKeyRoute, async (c) => {
  const { userId } = c.get('currentUser')
  try {
    const metadata = await getUserApiKeyMetadata(userId)
    c.header('Cache-Control', 'no-store')
    return c.json(metadata, 200)
  } catch (err) {
    logger.error({ err, userId, op: 'getUserApiKeyMetadata' }, 'API key metadata read failed')
    return dashboardError(c, 500, 'API_KEY_READ_FAILED', 'Failed to read API key metadata')
  }
})

const revokeApiKeyRoute = createRoute({
  method: 'delete',
  path: '/me/api-key',
  tags: ['Auth'],
  summary: "Revoke the authenticated user's Control API key",
  security: [{ SessionCookie: [] }],
  responses: {
    204: { description: 'API key revoked.' },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
  },
})

authRouter.openapi(revokeApiKeyRoute, async (c) => {
  const { userId } = c.get('currentUser')
  try {
    await revokeUserApiKey(userId)
    return c.body(null, 204)
  } catch (err) {
    logger.error({ err, userId, op: 'revokeUserApiKey' }, 'API key revoke failed')
    return dashboardError(c, 500, 'API_KEY_REVOKE_FAILED', 'Failed to revoke API key')
  }
})

export { authRouter as authRoutes }
