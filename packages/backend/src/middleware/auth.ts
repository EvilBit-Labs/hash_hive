import { type UserRole, agents } from '@hashhive/shared'
import { eq } from 'drizzle-orm'
import { deleteCookie, getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'

import type { AppEnv } from '../types.js'

import { logger } from '../config/logger.js'
import { db } from '../db/index.js'
import { parseAgentToken, verifyAgentTokenHash } from '../lib/agent-token.js'
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
 * Coerce the `roles` array off `session.user` (or the equivalent
 * Control-API `users.roles` row) into the strict UserRole union.
 * BetterAuth's TypeScript inference treats additional user columns
 * as `unknown`, so we narrow at the boundary rather than sprinkling
 * casts through the route layer.
 *
 * Drops any value not in the global tier vocabulary. Emits a warning
 * whenever ANY value was dropped (partial or total) so partial
 * corruption (`['admin', 'superuser']` → `['admin']`) is observable,
 * not just total corruption. Non-array input (null, undefined, scalar,
 * object) yields `[]` and -- when the input was a defined non-array
 * value -- also logs, since a typed-but-wrong shape signals adapter
 * drift more strongly than a missing column.
 */
export function coerceRoles(raw: unknown, userId: number | string): UserRole[] {
  if (!Array.isArray(raw)) {
    if (raw !== null && raw !== undefined) {
      logger.warn(
        { userId, rawType: typeof raw, raw },
        'coerceRoles: users.roles surfaced as non-array; treating as empty (adapter drift or schema mismatch)'
      )
    }
    return []
  }
  const out = raw.filter((r): r is UserRole => r === 'admin' || r === 'operator' || r === 'analyst')
  if (out.length < raw.length) {
    const dropped = raw.filter((r) => !(out as unknown[]).includes(r))
    logger.warn(
      { userId, dropped, kept: out },
      out.length === 0
        ? 'coerceRoles: all users.roles values dropped; user will fail every requireRole() check'
        : 'coerceRoles: some users.roles values dropped (data drift signal)'
    )
  }
  return out
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

  // BetterAuth surfaces user.id as a string (see GOTCHAS.md). Validate
  // before coercing so an invalid principal (NaN, 0, junk) cannot land
  // in currentUser and reach downstream RBAC / membership checks. Fail
  // closed with the existing AUTH_TOKEN_INVALID 401 instead of letting
  // the request proceed with a corrupt userId.
  const userId = Number(session.user.id)
  if (!Number.isInteger(userId) || userId <= 0) {
    logger.warn(
      { rawUserId: session.user.id },
      'requireSession: invalid user.id from BetterAuth session (adapter drift or NaN coerce)'
    )
    throw authError('Authentication required')
  }

  // BetterAuth's static types do NOT include `additionalFields.projectId`
  // on the session or `users.roles` on the user. Pluck via a Record
  // lookup so the narrowing is a real runtime check rather than an
  // unsafe type assertion (the no-unsafe-type-assertion lint rule
  // rejects the `as` form here).
  const sessionRecord = session.session as unknown as Record<string, unknown>
  const userRecord = session.user as unknown as Record<string, unknown>
  const rawProjectId = sessionRecord['projectId']
  // Tighter than `typeof === 'number'`: rejects NaN, Infinity, negatives,
  // and floats. A bad-row projectId of -1 or 1.5 would otherwise reach
  // downstream `findProjectMembership` and surface as a misleading 403
  // instead of the "no project selected" 400 the caller expects.
  const sessionProjectId =
    typeof rawProjectId === 'number' && Number.isInteger(rawProjectId) && rawProjectId > 0
      ? rawProjectId
      : null

  // Operator-visible signal when BetterAuth surfaces session.projectId
  // as anything other than null/undefined/positive-integer (would
  // indicate adapter drift, schema mismatch, or a corrupt row). The
  // fail-closed branch above silently sets null; this log makes the
  // drift path observable.
  if (rawProjectId !== undefined && rawProjectId !== null && sessionProjectId === null) {
    logger.warn(
      { userId: session.user.id, rawProjectIdType: typeof rawProjectId, rawProjectId },
      'requireSession: session.projectId is not a positive integer; treating as null (session field type drift)'
    )
  }

  c.set('currentUser', {
    userId,
    email: session.user.email,
    roles: coerceRoles(userRecord['roles'], userId),
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

    // S-H2: branch on token shape. Bcrypt-format tokens carry an `agt_`
    // prefix and a numeric agentId hint; legacy plaintext tokens are
    // raw UUIDs. The hint is not a secret — trust still flows from the
    // bcrypt verify (or the timing-safe plaintext compare).
    const parsed = parseAgentToken(token)
    let agent:
      | {
          id: number
          projectId: number
          status: string
          capabilities: unknown
        }
      | undefined

    if (parsed) {
      const [row] = await db
        .select({
          id: agents.id,
          projectId: agents.projectId,
          status: agents.status,
          capabilities: agents.capabilities,
          authTokenHash: agents.authTokenHash,
          authTokenFormat: agents.authTokenFormat,
        })
        .from(agents)
        .where(eq(agents.id, parsed.agentId))
        .limit(1)
      if (row && row.authTokenFormat === 'bcrypt' && row.authTokenHash) {
        const ok = await verifyAgentTokenHash(token, row.authTokenHash)
        if (ok) {
          agent = {
            id: row.id,
            projectId: row.projectId,
            status: row.status,
            capabilities: row.capabilities,
          }
        }
      }
    } else {
      // Legacy plaintext path: equality lookup on the `auth_token`
      // column. Stays until the operator runbook says all agents have
      // rotated and the DROP COLUMN release ships.
      const [row] = await db
        .select({
          id: agents.id,
          projectId: agents.projectId,
          status: agents.status,
          capabilities: agents.capabilities,
        })
        .from(agents)
        .where(eq(agents.authToken, token))
        .limit(1)
      agent = row
    }

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
