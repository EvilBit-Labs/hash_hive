/**
 * Control API project endpoints. Read-only listing of projects the
 * authenticated user belongs to; project creation stays on the dashboard
 * surface (it's an admin-onboarding flow, not part of the automation
 * contract).
 */

import { Hono } from 'hono';
import { paginate, paginationQuerySchema } from '../../lib/pagination.js';
import { problemResponse } from '../../lib/problem-details.js';
import { getProjectById, getUserProjects } from '../../services/projects.js';
import type { AppEnv } from '../../types.js';
import { controlErrorResponse, parseIdParam } from './_shared.js';

export const controlProjectRoutes = new Hono<AppEnv>();

controlProjectRoutes.get('/', async (c) => {
  try {
    const query = paginationQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const { userId } = c.get('currentUser');
    const all = await getUserProjects(userId);
    const slice = all.slice(query.offset, query.offset + query.limit);
    return c.json(paginate(slice, all.length, query));
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlProjectRoutes.get('/:id', async (c) => {
  try {
    const id = parseIdParam(c.req.param('id'));
    const project = await getProjectById(id);
    if (!project) return problemResponse(c, 404, 'not_found', 'project not found');
    // Project access enforced via getUserProjects view: confirm caller can see it.
    const { userId } = c.get('currentUser');
    const visible = (await getUserProjects(userId)).some((p) => p.id === id);
    if (!visible) return problemResponse(c, 403, 'forbidden', 'not a member of this project');
    return c.json(project);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});
