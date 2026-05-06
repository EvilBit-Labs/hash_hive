/**
 * Control API resource-file endpoints (wordlists, rules, masks).
 *
 * Read-only listing and inspection — uploads remain on the dashboard
 * surface (presigned URLs and chunked-upload coordination are
 * interactive workflows). Automation can list and delete its own
 * resources.
 */

import { maskLists, ruleLists, wordLists } from '@hashhive/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { paginate, paginationQuerySchema } from '../../lib/pagination.js';
import { problemResponse } from '../../lib/problem-details.js';
import { getResourceById, listResources, type ResourceTable } from '../../services/resources.js';
import type { AppEnv } from '../../types.js';
import { controlErrorResponse, parseIdParam, requireProjectId } from './_shared.js';

export const controlResourceRoutes = new Hono<AppEnv>();

const RESOURCE_KIND = z.enum(['wordlists', 'rulelists', 'masklists']);
type ResourceKind = z.infer<typeof RESOURCE_KIND>;

const RESOURCE_TABLES: Record<ResourceKind, ResourceTable> = {
  wordlists: wordLists,
  rulelists: ruleLists,
  masklists: maskLists,
};

function resolveKind(c: Context<AppEnv>): ResourceKind | null {
  const parsed = RESOURCE_KIND.safeParse(c.req.param('kind'));
  return parsed.success ? parsed.data : null;
}

controlResourceRoutes.get('/:kind', async (c) => {
  try {
    const projectId = requireProjectId(c);
    const kind = resolveKind(c);
    if (!kind) {
      return problemResponse(
        c,
        400,
        'validation',
        'kind must be one of: wordlists, rulelists, masklists'
      );
    }
    const query = paginationQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const all = await listResources(RESOURCE_TABLES[kind], projectId);
    const slice = all.slice(query.offset, query.offset + query.limit);
    return c.json(paginate(slice, all.length, query));
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlResourceRoutes.get('/:kind/:id', async (c) => {
  try {
    const projectId = requireProjectId(c);
    const kind = resolveKind(c);
    if (!kind) {
      return problemResponse(
        c,
        400,
        'validation',
        'kind must be one of: wordlists, rulelists, masklists'
      );
    }
    const id = parseIdParam(c.req.param('id'));
    const resource = await getResourceById(RESOURCE_TABLES[kind], id, projectId);
    if (!resource) return problemResponse(c, 404, 'not_found', 'resource not found');
    return c.json(resource);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});
