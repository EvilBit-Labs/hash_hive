/**
 * Control API project endpoints. Read-only listing of projects the
 * authenticated user belongs to; project creation stays on the dashboard
 * surface (it's an admin-onboarding flow, not part of the automation
 * contract).
 *
 * Authorization model: a project is visible iff it appears in
 * `getUserProjects(userId)`. Both list and get use that same view, so
 * non-members see 404 (not 403) — preventing existence-enumeration of
 * project ids the caller can't access.
 */

import { Hono } from 'hono';
import { paginate, paginationQuerySchema } from '../../lib/pagination.js';
import { problemResponse } from '../../lib/problem-details.js';
import { getUserProjects, getUserProjectsPaginated } from '../../services/projects.js';
import type { AppEnv } from '../../types.js';
import { controlErrorResponse, parseIdParam } from './helpers.js';

export const controlProjectRoutes = new Hono<AppEnv>();

controlProjectRoutes.get('/', async (c) => {
  try {
    const query = paginationQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const { userId } = c.get('currentUser');
    const { items, total } = await getUserProjectsPaginated(userId, {
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(paginate(items, total, query));
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlProjectRoutes.get('/:id', async (c) => {
  try {
    const id = parseIdParam(c.req.param('id'));
    const { userId } = c.get('currentUser');
    // Single visibility gate: if the project is in the caller's set we
    // return it; otherwise 404 — same envelope whether the project
    // doesn't exist or the caller can't see it. Avoids leaking
    // existence via 403 vs 404 differentiation. Single-row lookup so a
    // full membership list isn't materialized just to check
    // visibility.
    const project = (await getUserProjects(userId)).find((p) => p.id === id);
    if (!project) return problemResponse(c, 404, 'not_found', 'project not found');
    return c.json(project);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});
