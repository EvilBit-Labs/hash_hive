import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { requireSession } from '../../middleware/auth.js';
import { requireParamProjectAccess, requireParamProjectRole } from '../../middleware/rbac.js';
import { selectProject } from '../../services/auth.js';
import {
  addUserToProject,
  createProject,
  getProjectById,
  getProjectMembers,
  getUserProjects,
  removeUserFromProject,
  updateMemberRoles,
  updateProject,
} from '../../services/projects.js';
import type { AppEnv } from '../../types.js';

const projectRoutes = new Hono<AppEnv>();

// All project routes require session auth
projectRoutes.use('*', requireSession);

const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  slug: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9-]+$/),
  settings: z.record(z.string(), z.unknown()).optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

const addMemberSchema = z.object({
  userId: z.number().int().positive(),
  roles: z.array(z.enum(['admin', 'contributor', 'viewer'])).min(1),
});

const updateRolesSchema = z.object({
  roles: z.array(z.enum(['admin', 'contributor', 'viewer'])).min(1),
});

// GET /projects — list projects for current user
projectRoutes.get('/', async (c) => {
  const { userId } = c.get('currentUser');
  const result = await getUserProjects(userId);
  return c.json({ projects: result });
});

// POST /projects/select — select a project (re-issues JWT with projectId)
const selectProjectSchema = z.object({
  projectId: z.number().int().positive(),
});

projectRoutes.post('/select', zValidator('json', selectProjectSchema), async (c) => {
  const { userId } = c.get('currentUser');
  const { projectId } = c.req.valid('json');

  const result = await selectProject(userId, projectId);
  if (!result) {
    return c.json(
      { error: { code: 'AUTHZ_PROJECT_ACCESS_DENIED', message: 'Not a member of this project' } },
      403
    );
  }

  setCookie(c, 'session', result.token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24,
  });

  return c.json({ success: true, projectId: result.projectId });
});

// POST /projects — create a new project
projectRoutes.post('/', zValidator('json', createProjectSchema), async (c) => {
  const { userId } = c.get('currentUser');
  const data = c.req.valid('json');
  const project = await createProject({ ...data, createdBy: userId });
  return c.json({ project }, 201);
});

// GET /projects/:projectId — get project details
projectRoutes.get('/:projectId', requireParamProjectAccess(), async (c) => {
  const projectId = Number(c.req.param('projectId'));
  const project = await getProjectById(projectId);

  if (!project) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Project not found' } }, 404);
  }

  return c.json({ project });
});

// PATCH /projects/:projectId — update project (admin only)
projectRoutes.patch(
  '/:projectId',
  requireParamProjectRole('admin'),
  zValidator('json', updateProjectSchema),
  async (c) => {
    const projectId = Number(c.req.param('projectId'));
    const data = c.req.valid('json');
    const project = await updateProject(projectId, data);

    if (!project) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Project not found' } }, 404);
    }

    return c.json({ project });
  }
);

// GET /projects/:projectId/members — list project members
projectRoutes.get('/:projectId/members', requireParamProjectAccess(), async (c) => {
  const projectId = Number(c.req.param('projectId'));
  const members = await getProjectMembers(projectId);
  return c.json({ members });
});

// POST /projects/:projectId/members — add a member (admin only)
projectRoutes.post(
  '/:projectId/members',
  requireParamProjectRole('admin'),
  zValidator('json', addMemberSchema),
  async (c) => {
    const projectId = Number(c.req.param('projectId'));
    const { userId, roles } = c.req.valid('json');
    const membership = await addUserToProject(projectId, userId, roles);
    return c.json({ membership }, 201);
  }
);

// PATCH /projects/:projectId/members/:userId — update roles (admin only)
projectRoutes.patch(
  '/:projectId/members/:userId',
  requireParamProjectRole('admin'),
  zValidator('json', updateRolesSchema),
  async (c) => {
    const projectId = Number(c.req.param('projectId'));
    const userId = Number(c.req.param('userId'));
    const { roles } = c.req.valid('json');
    const membership = await updateMemberRoles(projectId, userId, roles);

    if (!membership) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: 'Membership not found' } },
        404
      );
    }

    return c.json({ membership });
  }
);

// DELETE /projects/:projectId/members/:userId — remove a member (admin only)
projectRoutes.delete('/:projectId/members/:userId', requireParamProjectRole('admin'), async (c) => {
  const projectId = Number(c.req.param('projectId'));
  const userId = Number(c.req.param('userId'));
  const removed = await removeUserFromProject(projectId, userId);

  if (!removed) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Membership not found' } }, 404);
  }

  return c.json({ success: true });
});

export { projectRoutes };
