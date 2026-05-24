import { Hono } from 'hono'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { requireSession } from '../../middleware/auth.js'
import {
  getUserApiKeyMetadata,
  getUserWithProjects,
  issueUserApiKey,
  revokeUserApiKey,
} from '../../services/auth.js'

const authRouter = new Hono<AppEnv>()

/**
 * GET /me -- returns the authenticated user's profile and project memberships.
 * Login/logout are now handled by BetterAuth at /api/auth/*.
 */
authRouter.get('/me', requireSession, async (c) => {
  const { userId } = c.get('currentUser')
  const result = await getUserWithProjects(userId)

  if (!result) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'User not found' } }, 404)
  }

  return c.json(result)
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
    return c.json(
      { error: { code: 'API_KEY_ISSUE_FAILED', message: 'Failed to issue API key' } },
      500
    )
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
    return c.json(
      { error: { code: 'API_KEY_READ_FAILED', message: 'Failed to read API key metadata' } },
      500
    )
  }
})

authRouter.delete('/me/api-key', requireSession, async (c) => {
  const { userId } = c.get('currentUser')
  try {
    await revokeUserApiKey(userId)
    return new Response(null, { status: 204 })
  } catch (err) {
    logger.error({ err, userId, op: 'revokeUserApiKey' }, 'API key revoke failed')
    return c.json(
      { error: { code: 'API_KEY_REVOKE_FAILED', message: 'Failed to revoke API key' } },
      500
    )
  }
})

export { authRouter as authRoutes }
