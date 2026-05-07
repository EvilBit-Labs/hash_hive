/**
 * Control API hash-list endpoints. Read-only at this layer — authoring
 * hash lists is a dashboard interactive flow (file upload via presigned
 * URL, hash-type detection on parse). Automation can list and inspect
 * existing lists.
 */

import { Hono } from 'hono';
import { paginate, paginationQuerySchema } from '../../lib/pagination.js';
import { problemResponse } from '../../lib/problem-details.js';
import {
  getHashListById,
  getHashListStats,
  listHashListsPaginated,
} from '../../services/resources.js';
import type { AppEnv } from '../../types.js';
import { controlErrorResponse, parseIdParam, requireProjectMembership } from './helpers.js';

export const controlHashListRoutes = new Hono<AppEnv>();

controlHashListRoutes.get('/', async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c);
    const query = paginationQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const { items, total } = await listHashListsPaginated(projectId, {
      limit: query.limit,
      offset: query.offset,
    });
    return c.json(paginate(items, total, query));
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlHashListRoutes.get('/:id', async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c);
    const id = parseIdParam(c.req.param('id'));
    const hashList = await getHashListById(id, projectId);
    if (!hashList) return problemResponse(c, 404, 'not_found', 'hash list not found');
    return c.json(hashList);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlHashListRoutes.get('/:id/stats', async (c) => {
  try {
    const { projectId } = await requireProjectMembership(c);
    const id = parseIdParam(c.req.param('id'));
    const hashList = await getHashListById(id, projectId);
    if (!hashList) return problemResponse(c, 404, 'not_found', 'hash list not found');
    const stats = await getHashListStats(id);
    return c.json(stats);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});
