import type { UserRole } from '@hashhive/shared'

import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'

import type { AppEnv } from '../types.js'

import { findProjectMembership } from '../services/auth.js'

/** Per-project membership role vocabulary (project_users.roles). */
type MembershipRole = 'admin' | 'contributor' | 'viewer'

function httpError(status: 401 | 403 | 400, code: string, message: string): HTTPException {
  return new HTTPException(status, {
    res: new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  })
}

// ─── Global capability-tier RBAC (issue #159) ───────────────────────

/**
 * Global capability tier guard. Reads `currentUser.roles` (users.roles
 * via the dashboard session or the control API key lookup) and rejects
 * with 403 if the caller has no role intersecting `allowedRoles`.
 *
 * Distinct from per-project membership guards below: this answers
 * "what can this account do at all" (admin|operator|analyst). The
 * per-project guards answer "what can this account do within this
 * project" (admin|contributor|viewer).
 *
 * Does NOT require a selected project -- use alongside
 * `requireProjectAccess()` or `requireParamProjectAccess()` when the
 * route is also project-scoped.
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('currentUser')
    if (!user) {
      throw httpError(401, 'AUTH_TOKEN_INVALID', 'Authentication required')
    }
    const hasTier = user.roles.some((r) => allowedRoles.includes(r))
    if (!hasTier) {
      throw httpError(
        403,
        'AUTHZ_INSUFFICIENT_PERMISSIONS',
        `Requires one of: ${allowedRoles.join(', ')}`
      )
    }
    await next()
  })
}

// ─── Per-project membership RBAC ────────────────────────────────────

/**
 * Hono context shape with the per-request membership cache. We use a
 * narrow signature so checkMembership stays mockable for unit tests
 * (the existing tests pass a minimal { get } shape) while still
 * carrying set() when the real Hono Context is in play.
 */
type MembershipCtx = {
  get: ((key: 'currentUser') => { userId: number; projectId: number | null } | undefined) &
    ((key: 'membership') => { projectId: number; userId: number; roles: string[] } | undefined)
  set?: (key: 'membership', value: { projectId: number; userId: number; roles: string[] }) => void
}

async function checkMembership(c: MembershipCtx) {
  const user = c.get('currentUser')
  if (!user) {
    throw httpError(401, 'AUTH_TOKEN_INVALID', 'Authentication required')
  }

  const projectId = user.projectId
  if (!projectId) {
    throw httpError(
      400,
      'PROJECT_NOT_SELECTED',
      'No project selected -- call POST /api/v1/dashboard/projects/select'
    )
  }

  // P-C1: reuse the per-request lookup when a prior guard already
  // resolved the same (userId, projectId) tuple. Saves a SELECT per
  // request when both requireProjectAccess and requireMembershipRole
  // are stacked (common on the dashboard surface), and when route
  // handlers re-call findProjectMembership for their own enforcement.
  const cached = c.get('membership')
  if (cached && cached.userId === user.userId && cached.projectId === projectId) {
    return cached
  }

  const membership = await findProjectMembership(user.userId, projectId)
  if (!membership) {
    throw httpError(403, 'AUTHZ_PROJECT_ACCESS_DENIED', 'Not a member of this project')
  }

  c.set?.('membership', { ...membership, userId: user.userId })
  return membership
}

/**
 * Per-project membership role guard for routes scoped via
 * `currentUser.projectId` (the session-managed scope). Verifies the
 * caller is a member of that project AND that their membership row
 * carries at least one of the requested roles.
 *
 * Renamed from `requireRole` in #159 so the two RBAC layers stay
 * visually distinct in route files. Use this for "what can this
 * account do within this project"; use `requireRole` (above) for
 * global capability tier.
 */
export function requireMembershipRole(...roles: MembershipRole[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const membership = await checkMembership(c)
    const hasRole = membership.roles.some((r) => roles.includes(r as MembershipRole))
    if (!hasRole) {
      throw httpError(403, 'AUTHZ_INSUFFICIENT_PERMISSIONS', `Requires one of: ${roles.join(', ')}`)
    }
    await next()
  })
}

export function requireProjectAccess() {
  return createMiddleware<AppEnv>(async (c, next) => {
    await checkMembership(c)
    await next()
  })
}

/**
 * Checks membership for a project specified by URL param (e.g., /:projectId).
 * Used for project management routes where the target project is in the URL.
 */
async function checkParamProjectMembership(
  c: MembershipCtx & {
    req: { param: (key: string) => string | undefined }
  }
) {
  const user = c.get('currentUser')
  if (!user) {
    throw httpError(401, 'AUTH_TOKEN_INVALID', 'Authentication required')
  }

  const projectId = Number(c.req.param('projectId'))
  if (!projectId || Number.isNaN(projectId)) {
    throw httpError(400, 'VALIDATION_FAILED', 'Project ID is required for this operation')
  }

  // P-C1: same per-request cache as checkMembership. The cache is keyed
  // by projectId so a param-project route won't reuse a session-project
  // membership entry when the param differs.
  const cached = c.get('membership')
  if (cached && cached.userId === user.userId && cached.projectId === projectId) {
    return cached
  }

  const membership = await findProjectMembership(user.userId, projectId)
  if (!membership) {
    throw httpError(403, 'AUTHZ_PROJECT_ACCESS_DENIED', 'Not a member of this project')
  }

  c.set?.('membership', { ...membership, userId: user.userId })
  return membership
}

export function requireParamProjectAccess() {
  return createMiddleware<AppEnv>(async (c, next) => {
    await checkParamProjectMembership(c)
    await next()
  })
}

/**
 * Per-project membership role guard for URL-param-scoped routes
 * (`/projects/:projectId/*`). Renamed from `requireParamProjectRole`
 * in #159 -- same behavior, clearer vocabulary.
 */
export function requireParamMembershipRole(...roles: MembershipRole[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const membership = await checkParamProjectMembership(c)
    const hasRole = membership.roles.some((r) => roles.includes(r as MembershipRole))
    if (!hasRole) {
      throw httpError(403, 'AUTHZ_INSUFFICIENT_PERMISSIONS', `Requires one of: ${roles.join(', ')}`)
    }
    await next()
  })
}
