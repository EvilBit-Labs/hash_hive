import { type UserRole, agents } from '@hashhive/shared'
import { eq } from 'drizzle-orm'
import { deleteCookie, getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'

import type { AppEnv } from '../types.js'

import { logger } from '../config/logger.js'
import { db } from '../db/index.js'
import { auth } from '../lib/auth.js'

function authError(message: string): HTTPException {
  return new HTTPException(401, {
    res: new Response(JSON.stringify({ error: { code: 'AUTH_TOKEN_INVALID', message } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  })
}

/**
 * Coerce the `roles` array off `session.user` into the strict UserRole
 * union. BetterAuth's TypeScript inference treats additional user
 * columns as `unknown`, so we narrow at the boundary rather than
 * sprinkling casts through the route layer.
 */
function coerceRoles(raw: unknown): UserRole[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((r): r is UserRole => r === 'admin' || r === 'operator' || r === 'analyst')
}

/**
 * Dashboard auth middleware -- validates the BetterAuth cookie session.
 * Sets currentUser on context with:
 *   - userId, email, roles  read from session.user (users table)
 *   - projectId              read from session.session.projectId
 *                            (additionalFields, server-managed)
 *
 * Project scope is derived EXCLUSIVELY from the server-managed
 * session.projectId. The X-Project-Id header is not read on the
 * dashboard surface (issue #159 U4); use POST
 * /api/v1/dashboard/projects/select to update it. The control API
 * (per-user API keys, stateless) still uses the header via
 * `requireApiKey` -- that surface has no session row to read from.
 *
 * Also cleans up legacy "session" cookies from the pre-BetterAuth JWT auth.
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  // TODO: remove legacy cookie cleanup after first production deploy cycle (2026-Q2)
  if (getCookie(c, 'session')) {
    deleteCookie(c, 'session', { path: '/' })
  }

  let session: Awaited<ReturnType<typeof auth.api.getSession>>
  try {
    session = await auth.api.getSession({ headers: c.req.raw.headers })
  } catch (err) {
    logger.warn({ err }, 'BetterAuth getSession failed')
    throw authError('Authentication required')
  }
  if (!session) {
    throw authError('Authentication required')
  }

  // The shared additionalFields.projectId is typed as `unknown` on the
  // session object since BetterAuth doesn't infer it back into the
  // public type. Cast at the boundary; the value is server-written
  // (single-project auto-select hook, last_project_id rehydrate, or an
  // explicit POST /projects/select) so we trust its shape.
  const sessionProjectId = (session.session as { projectId?: number | null }).projectId ?? null

  c.set('currentUser', {
    userId: Number(session.user.id),
    email: session.user.email,
    roles: coerceRoles((session.user as { roles?: unknown }).roles),
    projectId: sessionProjectId,
  })
  await next()
})

/**
 * Build an agent-token middleware. Validates the `Authorization: Bearer`
 * pre-shared token against the agents table and sets agent context.
 *
 * `allowErroredAgent` controls what happens when the agent's row is in
 * `status='error'`. Work endpoints (`/tasks/*`, `/errors`, `/benchmark`,
 * `/resources/*`, `/cracker/*`) keep the default (reject), so a broken
 * agent can't pick up new tasks. The heartbeat endpoint flips it to
 * `true` so the agent can announce recovery — a clean heartbeat
 * transitions the agent back to `online` via `processHeartbeat`, which
 * is the only programmatic recovery path the agent has.
 */
function createAgentTokenMiddleware(opts: { allowErroredAgent: boolean }) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const authHeader = c.req.header('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      throw authError('Bearer token required')
    }

    const token = authHeader.slice(7)

    const [agent] = await db
      .select({
        id: agents.id,
        projectId: agents.projectId,
        status: agents.status,
        capabilities: agents.capabilities,
      })
      .from(agents)
      .where(eq(agents.authToken, token))
      .limit(1)

    if (!agent) {
      throw authError('Invalid or expired agent token')
    }
    if (agent.status === 'error' && !opts.allowErroredAgent) {
      throw authError('Invalid or expired agent token')
    }

    c.set('agent', {
      agentId: agent.id,
      projectId: agent.projectId,
      capabilities: (agent.capabilities ?? {}) as Record<string, unknown>,
    })
    await next()
  })
}

/**
 * Strict agent auth — rejects agents whose row is in `status='error'`.
 * Use this on work endpoints; a broken agent should not be picking up
 * new tasks or posting benchmarks until it sends a recovery heartbeat.
 */
export const requireAgentToken = createAgentTokenMiddleware({ allowErroredAgent: false })

/**
 * Recovery-friendly agent auth — accepts agents whose row is in
 * `status='error'` so they can post a recovery heartbeat. Use ONLY on
 * `POST /api/v1/agent/heartbeat`; the heartbeat handler is responsible
 * for transitioning the agent back to `online` (or keeping it in
 * `error` if the recovery heartbeat itself reports a fatal error).
 */
export const requireAgentTokenForHeartbeatRecovery = createAgentTokenMiddleware({
  allowErroredAgent: true,
})
