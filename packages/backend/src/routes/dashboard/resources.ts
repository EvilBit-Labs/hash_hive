import { maskLists, ruleLists, wordLists } from '@hashhive/shared';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireSession } from '../../middleware/auth.js';
import { requireProjectAccess, requireRole } from '../../middleware/rbac.js';
import { guessHashType } from '../../services/hash-analysis.js';
import {
  createHashList,
  createResource,
  getHashItems,
  getHashListById,
  getResourceById,
  getResourcePresignedUrl,
  importHashList,
  listHashLists,
  listHashTypes,
  listResources,
  type ResourceTable,
  uploadHashListFile,
  uploadResourceFile,
} from '../../services/resources.js';
import type { AppEnv } from '../../types.js';

const resourceRoutes = new Hono<AppEnv>();

resourceRoutes.use('*', requireSession);

// ─── Hash Types ──────────────────────────────────────────────────────

resourceRoutes.get('/hash-types', async (c) => {
  const hashTypes = await listHashTypes();
  return c.json({ hashTypes });
});

// ─── Hash Lists ─────────────────────────────────────────────────────

resourceRoutes.get('/hash-lists', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('currentUser');
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400);
  }

  const hashLists = await listHashLists(projectId);
  return c.json({ hashLists });
});

const createHashListSchema = z.object({
  name: z.string().min(1).max(255),
  hashTypeId: z.number().int().positive().optional(),
  source: z.string().max(50).optional(),
});

resourceRoutes.post(
  '/hash-lists',
  requireRole('admin', 'contributor'),
  zValidator('json', createHashListSchema),
  async (c) => {
    const data = c.req.valid('json');
    const { projectId } = c.get('currentUser');
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      );
    }
    const hashList = await createHashList({ ...data, projectId });
    return c.json({ hashList }, 201);
  }
);

resourceRoutes.get('/hash-lists/:id', requireProjectAccess(), async (c) => {
  const id = Number(c.req.param('id'));
  const hashList = await getHashListById(id);

  if (!hashList) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404);
  }

  return c.json({ hashList });
});

resourceRoutes.post('/hash-lists/:id/upload', requireRole('admin', 'contributor'), async (c) => {
  const id = Number(c.req.param('id'));
  const hashList = await getHashListById(id);

  if (!hashList) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404);
  }

  const body = await c.req.parseBody();
  const file = body['file'];

  if (!(file instanceof File)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'file field is required' } }, 400);
  }

  const result = await uploadHashListFile(id, file);
  return c.json(result);
});

resourceRoutes.post('/hash-lists/:id/import', requireRole('admin', 'contributor'), async (c) => {
  const id = Number(c.req.param('id'));
  const result = await importHashList(id);

  if (!result) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404);
  }

  if ('error' in result) {
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: result.error } }, 503);
  }

  return c.json(result);
});

resourceRoutes.get('/hash-lists/:id/items', requireProjectAccess(), async (c) => {
  const id = Number(c.req.param('id'));
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
  const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined;

  const result = await getHashItems(id, { limit, offset });
  return c.json(result);
});

resourceRoutes.get('/hash-lists/:id/download', requireProjectAccess(), async (c) => {
  const id = Number(c.req.param('id'));
  const hashList = await getHashListById(id);

  if (!hashList) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404);
  }

  const fileRef = hashList.fileRef as { bucket?: string; key?: string; name?: string } | null;
  if (!fileRef?.bucket || !fileRef?.key) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Hash list has no uploaded file' } },
      400
    );
  }

  const url = await getResourcePresignedUrl({
    bucket: fileRef.bucket,
    key: fileRef.key,
    ...(fileRef.name ? { name: fileRef.name } : {}),
  });
  return c.json({ url });
});

// ─── Hash Type Detection ─────────────────────────────────────────────

const detectHashTypeSchema = z.object({
  hashes: z.array(z.string().min(1).max(1024)).min(1).max(100),
});

resourceRoutes.post(
  '/detect-hash-type',
  requireSession,
  zValidator('json', detectHashTypeSchema),
  async (c) => {
    const { hashes } = c.req.valid('json');

    const results = hashes.map((hashValue) => ({
      hashValue,
      candidates: guessHashType(hashValue),
    }));

    return c.json({ results });
  }
);

// ─── Generic resource routes factory ────────────────────────────────

function createResourceRoutes(prefix: string, table: ResourceTable) {
  const createSchema = z.object({
    name: z.string().min(1).max(255),
  });

  resourceRoutes.get(`/${prefix}`, requireProjectAccess(), async (c) => {
    const { projectId } = c.get('currentUser');
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      );
    }

    const items = await listResources(table, projectId);
    return c.json({ [prefix]: items });
  });

  resourceRoutes.post(
    `/${prefix}`,
    requireRole('admin', 'contributor'),
    zValidator('json', createSchema),
    async (c) => {
      const data = c.req.valid('json');
      const { projectId } = c.get('currentUser');
      if (!projectId) {
        return c.json(
          { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
          400
        );
      }
      const item = await createResource(table, { ...data, projectId });
      return c.json({ item }, 201);
    }
  );

  resourceRoutes.get(`/${prefix}/:id`, requireProjectAccess(), async (c) => {
    const id = Number(c.req.param('id'));
    const item = await getResourceById(table, id);

    if (!item) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: `${prefix} item not found` } },
        404
      );
    }

    return c.json({ item });
  });

  resourceRoutes.post(`/${prefix}/:id/upload`, requireRole('admin', 'contributor'), async (c) => {
    const id = Number(c.req.param('id'));
    const item = await getResourceById(table, id);

    if (!item) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: `${prefix} item not found` } },
        404
      );
    }

    const body = await c.req.parseBody();
    const file = body['file'];

    if (!(file instanceof File)) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'file field is required' } },
        400
      );
    }

    const result = await uploadResourceFile(table, id, prefix, file);
    return c.json(result);
  });

  resourceRoutes.get(`/${prefix}/:id/download`, requireProjectAccess(), async (c) => {
    const id = Number(c.req.param('id'));
    const item = await getResourceById(table, id);

    if (!item) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: `${prefix} item not found` } },
        404
      );
    }

    const fileRef = (item as Record<string, unknown>)['fileRef'] as {
      bucket?: string;
      key?: string;
      name?: string;
    } | null;
    if (!fileRef?.bucket || !fileRef?.key) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: `${prefix} item has no uploaded file` } },
        400
      );
    }

    const url = await getResourcePresignedUrl({
      bucket: fileRef.bucket,
      key: fileRef.key,
      ...(fileRef.name ? { name: fileRef.name } : {}),
    });
    return c.json({ url });
  });
}

createResourceRoutes('wordlists', wordLists);
createResourceRoutes('rulelists', ruleLists);
createResourceRoutes('masklists', maskLists);

export { resourceRoutes };
