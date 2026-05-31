import { OpenAPIHono } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import {
  getUserApiKeyMetadata,
  getUserWithProjects,
  issueUserApiKey,
  revokeUserApiKey,
} from '../../services/auth.js'

const authRouter = new OpenAPIHono<AppEnv>()

/**
 * GET /me -- returns the authenticated user's profile, project
 * memberships, and the currently selected project. The frontend
 * (#160 selector UI) uses `selectedProjectId` to decide whether to
 * land on the dashboard or the selector in a single round-trip,
 * rather than waiting for the WebSocket subscription to hydrate
 * `useUiStore.selectedProjectId`.
 *
 * `selectedProjectId` mirrors `currentUser.projectId` which is sourced
 * exclusively from the server-managed BetterAuth session row (issue
 * #159 U4). Login/logout transport is owned by BetterAuth at
 * `/api/auth/*`.
 */
authRouter.get('/me', requireSession, async (c) => {
  const { userId, projectId } = c.get('currentUser')
  // Wrapped in try/catch for symmetry with sibling /me/api-key routes.
  // A DB blip during getUserWithProjects would otherwise bubble as an
  // unstructured 500 and bypass the dashboard error envelope.
  try {
    const result = await getUserWithProjects(userId)
    if (!result) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'User not found')
    }
    // Coerce undefined → null explicitly so the field is always present
    // in the response per meResponseSchema's `nullable()` contract.
    return c.json({ ...result, selectedProjectId: projectId ?? null })
  } catch (err) {
    logger.error({ err, userId, op: 'getUserWithProjects' }, 'GET /me lookup failed')
    return dashboardError(c, 500, 'INTERNAL_ERROR', 'Failed to read user profile')
  }
})

// Account API Key endpoints. Each handler is wrapped in try/catch so a
// transient DB failure surfaces as a structured 500 with operation +
// userId in the log, rather than bubbling to Hono's default error
// handler which would leave a partial-write incident invisible.

authRouter.post('/me/api-key', requireSession, async (c) => {
  const { userId } = c.get('currentUser')
  try {
    const { token, metadata } = await issueUserApiKey(userId)
    // Raw token is shown exactly once; mark response uncacheable for
    // both modern (Cache-Control) and legacy/HTTP-1.0 (Pragma)
    // intermediaries that may sit between the dashboard and the
    // backend in air-gapped deployments.
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    return c.json({ token, metadata })
  } catch (err) {
    logger.error({ err, userId, op: 'issueUserApiKey' }, 'API key issue failed')
    return dashboardError(c, 500, 'API_KEY_ISSUE_FAILED', 'Failed to issue API key')
  }
})

authRouter.get('/me/api-key', requireSession, async (c) => {
  const { userId } = c.get('currentUser')
  try {
    const metadata = await getUserApiKeyMetadata(userId)
    // Per-user data; should not be cached by any shared proxy.
    c.header('Cache-Control', 'no-store')
    return c.json(metadata)
  } catch (err) {
    logger.error({ err, userId, op: 'getUserApiKeyMetadata' }, 'API key metadata read failed')
    return dashboardError(c, 500, 'API_KEY_READ_FAILED', 'Failed to read API key metadata')
  }
})

authRouter.delete('/me/api-key', requireSession, async (c) => {
  const { userId } = c.get('currentUser')
  try {
    await revokeUserApiKey(userId)
    return new Response(null, { status: 204 })
  } catch (err) {
    logger.error({ err, userId, op: 'revokeUserApiKey' }, 'API key revoke failed')
    return dashboardError(c, 500, 'API_KEY_REVOKE_FAILED', 'Failed to revoke API key')
  }
})

export { authRouter as authRoutes }
