import { selectProjectRequestSchema } from '@hashhive/shared'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { auth } from '../../lib/auth.js'
import { requireSession } from '../../middleware/auth.js'
import { requireParamProjectAccess, requireParamProjectRole } from '../../middleware/rbac.js'
import { findProjectMembership } from '../../services/auth.js'
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
projectRoutes.post('/select', zValidator('json', selectProjectRequestSchema), async (c) => {
  const { userId } = c.get('currentUser')
  const { projectId } = c.req.valid('json')

  const membership = await findProjectMembership(userId, projectId)
  if (!membership) {
    return c.json(
      { error: { code: 'FORBIDDEN', message: 'User is not a member of this project' } },
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
    logger.error({ err, userId, projectId }, 'projects/select: updateSession failed')
    return c.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to update session project' } },
      500
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
  requireParamProjectRole('admin'),
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
  requireParamProjectRole('admin'),
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
  requireParamProjectRole('admin'),
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
projectRoutes.delete('/:projectId/members/:userId', requireParamProjectRole('admin'), async (c) => {
  const projectId = Number(c.req.param('projectId'))
  const userId = Number(c.req.param('userId'))
  const removed = await removeUserFromProject(projectId, userId)

  if (!removed) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Membership not found' } }, 404)
  }

  return c.json({ success: true })
})

export { projectRoutes }
