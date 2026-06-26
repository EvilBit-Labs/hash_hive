import { selectProjectRequestSchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { auth } from '../../lib/auth.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import {
  requireParamMembershipRole,
  requireParamProjectAccess,
  requireRole,
} from '../../middleware/rbac.js'
import {
  DASHBOARD_RESPONSE_REFS,
  sharedDashboardResponse,
  dashboardOpenApiHonoOptions,
} from '../../openapi/components.js'
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

const projectRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

projectRoutes.use('*', requireSession)

// ─── Request schemas ────────────────────────────────────────────────

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

const projectIdParamSchema = z.object({ projectId: z.coerce.number().int().positive() })
const memberPathParamSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  userId: z.coerce.number().int().positive(),
})

// ─── Response shapes (passthrough; tighten in U4) ───────────────────

const projectListResponseSchema = z
  .object({ projects: z.array(z.unknown()) })
  .passthrough()
  .openapi('ProjectList')

const projectDetailResponseSchema = z
  .object({ project: z.unknown() })
  .passthrough()
  .openapi('ProjectDetail')

const memberListResponseSchema = z
  .object({ members: z.array(z.unknown()) })
  .passthrough()
  .openapi('ProjectMemberList')

const membershipResponseSchema = z
  .object({ membership: z.unknown() })
  .passthrough()
  .openapi('ProjectMembership')

const successResponseSchema = z.object({ success: z.boolean() }).openapi('ProjectActionSuccess')

const sharedAuthResponses = {
  401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
  403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
} as const

// ─── GET /projects — list projects for current user ─────────────────

const listMyProjectsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Projects'],
  summary: "List the active user's project memberships",
  security: [{ SessionCookie: [] }],
  responses: {
    200: {
      description: 'Projects the user is a member of.',
      content: { 'application/json': { schema: projectListResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
  },
})

projectRoutes.openapi(listMyProjectsRoute, async (c) => {
  const { userId } = c.get('currentUser')
  const result = await getUserProjects(userId)
  return c.json({ projects: result }, 200)
})

// ─── POST /projects — create a project (global admin only) ─────────
//
// Gated behind the global `admin` capability tier (users.roles). Without
// this gate, any authenticated user (operator/analyst) could create a
// project and was auto-granted project-admin on it -- a self-elevation
// path. createProject auto-grants admin to the creator by design; only
// platform admins should hold that hammer.

const createProjectRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Projects'],
  summary: 'Create a project (global admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireRole('admin')] as const,
  request: { body: { content: { 'application/json': { schema: createProjectSchema } } } },
  responses: {
    201: {
      description: 'Project created; creator auto-granted project-admin.',
      content: { 'application/json': { schema: projectDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    ...sharedAuthResponses,
  },
})

projectRoutes.openapi(createProjectRoute, async (c) => {
  const { userId } = c.get('currentUser')
  const data = c.req.valid('json')
  const actor = { actorType: 'user' as const, actorId: userId }
  const project = await createProject({ ...data, createdBy: userId }, actor)
  return c.json({ project }, 201)
})

// ─── POST /projects/select — set session.projectId ──────────────────
//
// CSRF same-origin defense lives in `middleware/csrf.ts:requireSameOrigin`,
// mounted globally on `/api/v1/dashboard/projects/*` in `src/index.ts`,
// so every cookie-authenticated unsafe-method request through this
// route is already filtered by the time it reaches the handler. No
// inline same-origin check needed here.

const selectProjectRoute = createRoute({
  method: 'post',
  path: '/select',
  tags: ['Projects'],
  summary: 'Set the active project on the session (after membership check)',
  description:
    "Validates the user is a member of the requested project, then writes session.projectId via BetterAuth's updateSession and persists the user's last-project preference. Returns the selected project on success. Used by the multi-project selector UI (#160) and consumed by the WebSocket upgrade in /events/stream to scope broadcasts without trusting a client-supplied query param.",
  security: [{ SessionCookie: [] }],
  request: { body: { content: { 'application/json': { schema: selectProjectRequestSchema } } } },
  responses: {
    200: {
      description: 'Project selected; session updated.',
      content: { 'application/json': { schema: projectDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    ...sharedAuthResponses,
    500: {
      description:
        'Server-side failure (BetterAuth updateSession, FK invariant broken, rollback failed).',
      content: { 'application/json': { schema: z.object({ error: z.unknown() }) } },
    },
  },
})

projectRoutes.openapi(selectProjectRoute, async (c) => {
  const { userId } = c.get('currentUser')
  const requestId = c.get('requestId')

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
    logger.error(
      { userId, projectId, requestId },
      'projects/select: membership exists but project row missing (FK invariant broken)'
    )
    return dashboardError(c, 500, 'INTERNAL_ERROR', 'Project row missing for membership')
  }

  // updateSession writes additionalFields.projectId on the active
  // session row. Read by /events/stream on next WS upgrade.
  try {
    await auth.api.updateSession({
      headers: c.req.raw.headers,
      body: { projectId },
    })
  } catch (err) {
    logger.error({ err, userId, projectId, requestId }, 'projects/select: updateSession failed')
    return dashboardError(c, 500, 'INTERNAL_ERROR', 'Failed to update session project')
  }

  let preferenceRowsUpdated: number
  try {
    preferenceRowsUpdated = await setUserLastProjectIdIfMember(userId, projectId)
  } catch (err) {
    logger.error(
      { err, userId, projectId, requestId },
      'projects/select: setUserLastProjectIdIfMember failed (session was updated but preference write failed)'
    )
    return dashboardError(c, 500, 'INTERNAL_ERROR', 'Failed to persist last project preference')
  }
  if (preferenceRowsUpdated === 0) {
    // Membership was revoked between the original findProjectMembership
    // check and this guarded write. Roll the session back so it doesn't
    // continue pointing at a project the user can no longer access.
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

  return c.json({ project }, 200)
})

// ─── /:projectId routes ────────────────────────────────────────────

const getProjectRoute = createRoute({
  method: 'get',
  path: '/{projectId}',
  tags: ['Projects'],
  summary: 'Get project details (membership required)',
  security: [{ SessionCookie: [] }],
  middleware: [requireParamProjectAccess()] as const,
  request: { params: projectIdParamSchema },
  responses: {
    200: {
      description: 'Project details.',
      content: { 'application/json': { schema: projectDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    ...sharedAuthResponses,
  },
})

projectRoutes.openapi(getProjectRoute, async (c) => {
  const { projectId } = c.req.valid('param')
  const project = await getProjectById(projectId)

  if (!project) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Project not found')
  }

  return c.json({ project }, 200)
})

const updateProjectRoute = createRoute({
  method: 'patch',
  path: '/{projectId}',
  tags: ['Projects'],
  summary: 'Update project (project admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireParamMembershipRole('admin')] as const,
  request: {
    params: projectIdParamSchema,
    body: { content: { 'application/json': { schema: updateProjectSchema } } },
  },
  responses: {
    200: {
      description: 'Updated project.',
      content: { 'application/json': { schema: projectDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    ...sharedAuthResponses,
  },
})

projectRoutes.openapi(updateProjectRoute, async (c) => {
  const { userId } = c.get('currentUser')
  const { projectId } = c.req.valid('param')
  const data = c.req.valid('json')
  const actor = { actorType: 'user' as const, actorId: userId }
  const project = await updateProject(projectId, data, actor)

  if (!project) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Project not found')
  }

  return c.json({ project }, 200)
})

const listMembersRoute = createRoute({
  method: 'get',
  path: '/{projectId}/members',
  tags: ['Projects'],
  summary: 'List members of a project (membership required)',
  security: [{ SessionCookie: [] }],
  middleware: [requireParamProjectAccess()] as const,
  request: { params: projectIdParamSchema },
  responses: {
    200: {
      description: 'Project members and their roles.',
      content: { 'application/json': { schema: memberListResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    ...sharedAuthResponses,
  },
})

projectRoutes.openapi(listMembersRoute, async (c) => {
  const { projectId } = c.req.valid('param')
  const members = await getProjectMembers(projectId)
  return c.json({ members }, 200)
})

const addMemberRoute = createRoute({
  method: 'post',
  path: '/{projectId}/members',
  tags: ['Projects'],
  summary: 'Add a member to a project (project admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireParamMembershipRole('admin')] as const,
  request: {
    params: projectIdParamSchema,
    body: { content: { 'application/json': { schema: addMemberSchema } } },
  },
  responses: {
    201: {
      description: 'Membership created.',
      content: { 'application/json': { schema: membershipResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    ...sharedAuthResponses,
  },
})

projectRoutes.openapi(addMemberRoute, async (c) => {
  const { userId: actorId } = c.get('currentUser')
  const { projectId } = c.req.valid('param')
  const { userId, roles } = c.req.valid('json')
  const actor = { actorType: 'user' as const, actorId: actorId }
  const membership = await addUserToProject(projectId, userId, roles, actor)
  return c.json({ membership }, 201)
})

const updateMemberRolesRoute = createRoute({
  method: 'patch',
  path: '/{projectId}/members/{userId}',
  tags: ['Projects'],
  summary: "Update a member's roles (project admin only)",
  security: [{ SessionCookie: [] }],
  middleware: [requireParamMembershipRole('admin')] as const,
  request: {
    params: memberPathParamSchema,
    body: { content: { 'application/json': { schema: updateRolesSchema } } },
  },
  responses: {
    200: {
      description: 'Updated membership.',
      content: { 'application/json': { schema: membershipResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    ...sharedAuthResponses,
  },
})

projectRoutes.openapi(updateMemberRolesRoute, async (c) => {
  const { userId: actorId } = c.get('currentUser')
  const { projectId, userId } = c.req.valid('param')
  const { roles } = c.req.valid('json')
  const actor = { actorType: 'user' as const, actorId: actorId }
  const membership = await updateMemberRoles(projectId, userId, roles, actor)

  if (!membership) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Membership not found')
  }

  return c.json({ membership }, 200)
})

const removeMemberRoute = createRoute({
  method: 'delete',
  path: '/{projectId}/members/{userId}',
  tags: ['Projects'],
  summary: 'Remove a member from a project (project admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireParamMembershipRole('admin')] as const,
  request: { params: memberPathParamSchema },
  responses: {
    200: {
      description: 'Membership removed.',
      content: { 'application/json': { schema: successResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    ...sharedAuthResponses,
  },
})

projectRoutes.openapi(removeMemberRoute, async (c) => {
  const { userId: actorId } = c.get('currentUser')
  const { projectId, userId } = c.req.valid('param')
  const actor = { actorType: 'user' as const, actorId: actorId }
  const removed = await removeUserFromProject(projectId, userId, actor)

  if (!removed) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Membership not found')
  }

  return c.json({ success: true }, 200)
})

export { projectRoutes }
