/**
 * Control API hash-list endpoints. Read-only at this layer — authoring
 * hash lists is a dashboard interactive flow (file upload via presigned
 * URL, hash-type detection on parse). Automation can list and inspect
 * existing lists.
 */

import { Hono } from 'hono';
import { paginate, paginationQuerySchema } from '../../lib/pagination.js';
import { problemResponse } from '../../lib/problem-details.js';
import { getHashListById, getHashListStats, listHashLists } from '../../services/resources.js';
import type { AppEnv } from '../../types.js';
import { controlErrorResponse, parseIdParam, requireProjectId } from './_shared.js';

export const controlHashListRoutes = new Hono<AppEnv>();

controlHashListRoutes.get('/', async (c) => {
  try {
    const projectId = requireProjectId(c);
    const query = paginationQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const all = await listHashLists(projectId);
    const slice = all.slice(query.offset, query.offset + query.limit);
    return c.json(paginate(slice, all.length, query));
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlHashListRoutes.get('/:id', async (c) => {
  try {
    const projectId = requireProjectId(c);
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
    const projectId = requireProjectId(c);
    const id = parseIdParam(c.req.param('id'));
    const hashList = await getHashListById(id, projectId);
    if (!hashList) return problemResponse(c, 404, 'not_found', 'hash list not found');
    const stats = await getHashListStats(id);
    return c.json(stats);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});
