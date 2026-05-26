import { selectProjectRequestSchema } from '@hashhive/shared'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import type { AppEnv } from '../../types.js'

import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { auth } from '../../lib/auth.js'
import { requireSession } from '../../middleware/auth.js'
import { requireParamMembershipRole, requireParamProjectAccess } from '../../middleware/rbac.js'
import { findProjectMembership, setUserLastProjectIdIfMember } from '../../services/auth.js'
import {
  addUserToProject,
  createProject,
  getProjectById,
  getProjectMembers,
  getUserProjects,
  removeUserFromProject,
  updateMemberRoles,
  updateProject,
} from '../../services/projects.js'

const projectRoutes = new Hono<AppEnv>()

// All project routes require session auth
projectRoutes.use('*', requireSession)

const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  slug: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9-]+$/),
  settings: z.record(z.string(), z.unknown()).optional(),
})

const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
})

const addMemberSchema = z.object({
  userId: z.number().int().positive(),
  roles: z.array(z.enum(['admin', 'contributor', 'viewer'])).min(1),
})

const updateRolesSchema = z.object({
  roles: z.array(z.enum(['admin', 'contributor', 'viewer'])).min(1),
})

// GET /projects — list projects for current user
projectRoutes.get('/', async (c) => {
  const { userId } = c.get('currentUser')
  const result = await getUserProjects(userId)
  return c.json({ projects: result })
})

// POST /projects — create a new project
projectRoutes.post('/', zValidator('json', createProjectSchema), async (c) => {
  const { userId } = c.get('currentUser')
  const data = c.req.valid('json')
  const project = await createProject({ ...data, createdBy: userId })
  return c.json({ project }, 201)
})

// POST /projects/select — set the server-managed projectId on the
// BetterAuth session after validating membership. Used by the
// dashboard WebSocket upgrade (events/stream) to scope broadcasts
// without trusting a client-supplied query param, and by the planned
// multi-project selector UI (#160). Returns the selected project.
//
// CSRF defense-in-depth: this is a cookie-authenticated, state-changing
// endpoint. BetterAuth's session cookie is SameSite=Lax by default and
// CORS is locked down to known origins, but we add a same-origin
// Origin/Referer check here as belt-and-suspenders. Rejects requests
// whose Origin (or Referer when Origin is absent) doesn't match the
// request's own Host header. Production air-gapped deployments serve
// frontend and backend behind the same reverse proxy, so same-origin is
// the correct invariant. Dev allows http://localhost:3000 explicitly.
function isSameOriginRequest(c: {
  req: { raw: Request; header: (k: string) => string | undefined }
}): boolean {
  const origin = c.req.header('origin')
  const referer = c.req.header('referer')
  const host = c.req.header('host')

  // No Origin and no Referer → almost certainly not a browser form post;
  // could be a same-origin fetch with strict referrer-policy. Allow it
  // and rely on the SameSite cookie + CORS preflight as the primary
  // defense. Browsers issuing cross-origin state-changing fetches will
  // populate Origin per Fetch spec.
  if (!origin && !referer) return true

  const sourceUrl = origin ?? referer
  if (!sourceUrl) return true

  try {
    const sourceHost = new URL(sourceUrl).host
    // Dev exception: localhost:3000 frontend → localhost:4000 backend.
    // Env-gated so the escape hatch can never ship to production --
    // air-gapped deployments serve frontend and backend behind one
    // reverse proxy and same-origin is the only legitimate path.
    if (
      env.NODE_ENV !== 'production' &&
      sourceHost === 'localhost:3000' &&
      host?.startsWith('localhost')
    ) {
      return true
    }
    return sourceHost === host
  } catch {
    return false
  }
}

projectRoutes.post('/select', zValidator('json', selectProjectRequestSchema), async (c) => {
  const { userId } = c.get('currentUser')
  const requestId = c.get('requestId')

  if (!isSameOriginRequest(c)) {
    logger.warn(
      {
        userId,
        requestId,
        origin: c.req.header('origin'),
        referer: c.req.header('referer'),
        host: c.req.header('host'),
      },
      'projects/select: cross-origin request rejected'
    )
    return c.json(
      { error: { code: 'CSRF_ORIGIN_MISMATCH', message: 'Cross-origin request rejected' } },
      403
    )
  }

  const { projectId } = c.req.valid('json')

  const membership = await findProjectMembership(userId, projectId)
  if (!membership) {
    return c.json(
      {
        error: {
          code: 'AUTHZ_PROJECT_ACCESS_DENIED',
          message: 'User is not a member of this project',
        },
      },
      403
    )
  }

  // The project row is guaranteed to exist here: projectUsers.projectId
  // FKs to projects.id (NO ACTION on delete), so a successful membership
  // lookup proves the project. Fetch it for the response payload only.
  const project = await getProjectById(projectId)
  if (!project) {
    // Defensive: if the membership row exists without the project,
    // the FK invariant is broken. Surface a 500 rather than letting
    // updateSession proceed against a missing project reference.
    logger.error(
      { userId, projectId, requestId },
      'projects/select: membership exists but project row missing (FK invariant broken)'
    )
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Project row missing for membership' } },
      500
    )
  }

  // updateSession writes additionalFields.projectId on the active
  // session row. Read by /events/stream on next WS upgrade. Wrap in
  // try/catch so an underlying BetterAuth or FK failure surfaces as
  // the dashboard envelope rather than a raw 500 with the driver
  // error string. The error is captured + logged so operators can
  // distinguish "session expired mid-call" from a real driver fault.
  try {
    await auth.api.updateSession({
      headers: c.req.raw.headers,
      body: { projectId },
    })
  } catch (err) {
    logger.error({ err, userId, projectId, requestId }, 'projects/select: updateSession failed')
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to update session project' } },
      500
    )
  }

  // Persist the user's "remember last project" preference so the next
  // sign-in rehydrates session.projectId via the session.create.before
  // hook without forcing the user to re-pick. The conditional write is
  // gated on membership at the SQL level (atomic against a concurrent
  // removeUserFromProject) -- if the user lost membership between the
  // initial check and now, the UPDATE affects 0 rows and we clear the
  // session scope to match. Treated as part of the contract, not
  // best-effort: a thrown error surfaces as 500 so the caller knows
  // to retry.
  let preferenceRowsUpdated: number
  try {
    preferenceRowsUpdated = await setUserLastProjectIdIfMember(userId, projectId)
  } catch (err) {
    logger.error(
      { err, userId, projectId, requestId },
      'projects/select: setUserLastProjectIdIfMember failed (session was updated but preference write failed)'
    )
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to persist last project preference' } },
      500
    )
  }
  if (preferenceRowsUpdated === 0) {
    // Membership was revoked between the original findProjectMembership
    // check and this guarded write. The session was updated above to
    // point at a project the user no longer belongs to; roll it back
    // so the next request sees session.projectId=null and the dashboard
    // routes to the selector.
    logger.warn(
      { userId, projectId, requestId },
      'projects/select: membership revoked mid-request; rolling back session.projectId'
    )
    try {
      await auth.api.updateSession({
        headers: c.req.raw.headers,
        body: { projectId: null },
      })
    } catch (err) {
      // Rollback failed -- the session is now in an inconsistent state
      // (scope still points at the forbidden project, but the user no
      // longer has membership). 403 would be misleading (it implies
      // the client can retry / re-select) but the session itself is
      // poisoned and the client cannot recover without re-auth.
      // Escalate to 500 with a distinct code so operators see this as
      // a server-side incident and the client knows to surface a
      // session-expired UX. The user's next dashboard request will
      // either redirect via the 401 path on session expiry, or hit
      // 403 PROJECT_NOT_SELECTED / AUTHZ_PROJECT_ACCESS_DENIED on the
      // stale-scope route -- both of which the frontend already
      // handles as "back to selector / login".
      logger.error(
        { err, userId, requestId },
        'projects/select: rollback updateSession({ projectId: null }) failed; session scope is inconsistent'
      )
      return c.json(
        {
          error: {
            code: 'AUTHZ_SESSION_ROLLBACK_FAILED',
            message: 'Membership revoked mid-request and session rollback failed; re-authenticate.',
          },
        },
        500
      )
    }
    return c.json(
      {
        error: { code: 'AUTHZ_PROJECT_ACCESS_DENIED', message: 'Membership revoked mid-request' },
      },
      403
    )
  }

  return c.json({ project })
})

// GET /projects/:projectId — get project details
projectRoutes.get('/:projectId', requireParamProjectAccess(), async (c) => {
  const projectId = Number(c.req.param('projectId'))
  const project = await getProjectById(projectId)

  if (!project) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Project not found' } }, 404)
  }

  return c.json({ project })
})

// PATCH /projects/:projectId — update project (admin only)
projectRoutes.patch(
  '/:projectId',
  requireParamMembershipRole('admin'),
  zValidator('json', updateProjectSchema),
  async (c) => {
    const projectId = Number(c.req.param('projectId'))
    const data = c.req.valid('json')
    const project = await updateProject(projectId, data)

    if (!project) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Project not found' } }, 404)
    }

    return c.json({ project })
  }
)

// GET /projects/:projectId/members — list project members
projectRoutes.get('/:projectId/members', requireParamProjectAccess(), async (c) => {
  const projectId = Number(c.req.param('projectId'))
  const members = await getProjectMembers(projectId)
  return c.json({ members })
})

// POST /projects/:projectId/members — add a member (admin only)
projectRoutes.post(
  '/:projectId/members',
  requireParamMembershipRole('admin'),
  zValidator('json', addMemberSchema),
  async (c) => {
    const projectId = Number(c.req.param('projectId'))
    const { userId, roles } = c.req.valid('json')
    const membership = await addUserToProject(projectId, userId, roles)
    return c.json({ membership }, 201)
  }
)

// PATCH /projects/:projectId/members/:userId — update roles (admin only)
projectRoutes.patch(
  '/:projectId/members/:userId',
  requireParamMembershipRole('admin'),
  zValidator('json', updateRolesSchema),
  async (c) => {
    const projectId = Number(c.req.param('projectId'))
    const userId = Number(c.req.param('userId'))
    const { roles } = c.req.valid('json')
    const membership = await updateMemberRoles(projectId, userId, roles)

    if (!membership) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Membership not found' } }, 404)
    }

    return c.json({ membership })
  }
)

// DELETE /projects/:projectId/members/:userId — remove a member (admin only)
projectRoutes.delete(
  '/:projectId/members/:userId',
  requireParamMembershipRole('admin'),
  async (c) => {
    const projectId = Number(c.req.param('projectId'))
    const userId = Number(c.req.param('userId'))
    const removed = await removeUserFromProject(projectId, userId)

    if (!removed) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Membership not found' } }, 404)
    }

    return c.json({ success: true })
  }
)

export { projectRoutes }
