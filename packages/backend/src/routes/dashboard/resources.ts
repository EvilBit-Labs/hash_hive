import { maskLists, ruleLists, wordLists } from '@hashhive/shared';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { requireSession } from '../../middleware/auth.js';
import { requireProjectAccess, requireRole } from '../../middleware/rbac.js';
import { guessHashType } from '../../services/hash-analysis.js';
import {
  abortChunkedUpload,
  completeChunkedUpload,
  createHashList,
  createResource,
  getChunkedUploadStatus,
  getHashItems,
  getHashListById,
  getHashListStats,
  getResourceById,
  getResourcePresignedUrl,
  importHashList,
  initiateChunkedUpload,
  listHashLists,
  listHashTypes,
  listResources,
  type ResourceTable,
  uploadChunkPart,
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
  const { projectId } = c.get('currentUser');
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400);
  }

  const hashListId = Number(c.req.param('id'));
  const hl = await getHashListById(hashListId, projectId);

  if (!hl) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404);
  }

  const liveStats = await getHashListStats(hashListId);

  return c.json({
    hashList: {
      ...hl,
      statistics: {
        ...((hl.statistics as Record<string, unknown> | null) ?? {}),
        ...liveStats,
      },
    },
  });
});

resourceRoutes.post('/hash-lists/:id/upload', requireRole('admin', 'contributor'), async (c) => {
  const { projectId } = c.get('currentUser');
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400);
  }

  const id = Number(c.req.param('id'));
  const hashList = await getHashListById(id, projectId);

  if (!hashList) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404);
  }

  const body = await c.req.parseBody();
  const file = body['file'];

  if (!(file instanceof File)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'file field is required' } }, 400);
  }

  const result = await uploadHashListFile(id, projectId, file);
  return c.json(result);
});

resourceRoutes.post('/hash-lists/:id/import', requireRole('admin', 'contributor'), async (c) => {
  const { projectId } = c.get('currentUser');
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400);
  }

  const id = Number(c.req.param('id'));

  // Verify hash list belongs to project before importing
  const hl = await getHashListById(id, projectId);
  if (!hl) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404);
  }

  const result = await importHashList(id, projectId);

  if (!result) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404);
  }

  if ('error' in result) {
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: result.error } }, 503);
  }

  return c.json(result);
});

resourceRoutes.get('/hash-lists/:id/items', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('currentUser');
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400);
  }

  const hashListId = Number(c.req.param('id'));

  // Validate query params — fail fast on invalid input
  const statusRaw = c.req.query('status');
  const VALID_STATUSES = ['all', 'cracked', 'uncracked'] as const;
  const status =
    statusRaw && VALID_STATUSES.includes(statusRaw as (typeof VALID_STATUSES)[number])
      ? (statusRaw as 'all' | 'cracked' | 'uncracked')
      : undefined;
  const q = c.req.query('q')?.slice(0, 256) || undefined;
  const limitRaw = Number(c.req.query('limit') ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 100)) : 50;
  const offsetRaw = Number(c.req.query('offset') ?? 0);
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

  const result = await getHashItems(hashListId, projectId, { status, search: q, limit, offset });

  if (!result) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404);
  }

  return c.json(result);
});

resourceRoutes.get('/hash-lists/:id/download', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('currentUser');
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400);
  }

  const id = Number(c.req.param('id'));
  const hashList = await getHashListById(id, projectId);

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
    const { projectId } = c.get('currentUser');
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      );
    }
    const id = Number(c.req.param('id'));
    const item = await getResourceById(table, id, projectId);

    if (!item) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: `${prefix} item not found` } },
        404
      );
    }

    return c.json({ item });
  });

  resourceRoutes.post(`/${prefix}/:id/upload`, requireRole('admin', 'contributor'), async (c) => {
    const { projectId } = c.get('currentUser');
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      );
    }
    const id = Number(c.req.param('id'));
    const item = await getResourceById(table, id, projectId);

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

    const result = await uploadResourceFile(table, id, projectId, prefix, file);
    return c.json(result);
  });

  resourceRoutes.get(`/${prefix}/:id/download`, requireProjectAccess(), async (c) => {
    const { projectId } = c.get('currentUser');
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      );
    }
    const id = Number(c.req.param('id'));
    const item = await getResourceById(table, id, projectId);

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

// ─── Chunked Upload (S3 Multipart) ──────────────────────────────────
// These endpoints do NOT use zValidator for the body on PUT because
// the request body is raw binary data (not JSON). Body-parsing
// middleware would consume the stream before we can forward it to S3.

const initiateUploadSchema = z.object({
  resourceType: z.enum(['hash-lists', 'wordlists', 'rulelists', 'masklists']),
  name: z.string().min(1).max(255),
  fileSize: z.number().int().positive().max(500_000_000_000),
  contentType: z.string().optional(),
});

resourceRoutes.post(
  '/upload/initiate',
  requireRole('admin', 'contributor'),
  zValidator('json', initiateUploadSchema),
  async (c) => {
    const data = c.req.valid('json');
    const { projectId } = c.get('currentUser');
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      );
    }

    try {
      const result = await initiateChunkedUpload({ ...data, projectId });
      return c.json(result, 201);
    } catch (err) {
      logger.error({ err }, 'Failed to initiate chunked upload');
      return c.json(
        { error: { code: 'UPLOAD_INIT_FAILED', message: 'Failed to initiate upload' } },
        500
      );
    }
  }
);

resourceRoutes.put(
  '/upload/:uploadId/part/:partNumber',
  requireRole('admin', 'contributor'),
  async (c) => {
    const uploadId = c.req.param('uploadId');
    const partNumber = Number(c.req.param('partNumber'));
    const resourceId = Number(c.req.query('resourceId'));
    const resourceType = c.req.query('resourceType');

    if (!uploadId || !partNumber || !resourceId || !resourceType) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'uploadId, partNumber, resourceId, and resourceType are required',
          },
        },
        400
      );
    }

    // Read the raw body as a Uint8Array — do NOT use c.req.json() or c.req.parseBody()
    const body = await c.req.arrayBuffer();
    const chunk = new Uint8Array(body);

    if (chunk.byteLength === 0) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Request body is empty' } }, 400);
    }

    const { projectId } = c.get('currentUser');
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      );
    }

    try {
      const result = await uploadChunkPart(
        uploadId,
        partNumber,
        chunk,
        resourceId,
        resourceType,
        projectId
      );
      return c.json(result);
    } catch (err) {
      logger.error({ err, uploadId, partNumber }, 'Failed to upload part');
      return c.json(
        { error: { code: 'UPLOAD_PART_FAILED', message: 'Failed to upload part' } },
        500
      );
    }
  }
);

const completeUploadSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().positive(),
        etag: z.string().min(1),
      })
    )
    .min(1),
  resourceId: z.number().int().positive(),
  resourceType: z.enum(['hash-lists', 'wordlists', 'rulelists', 'masklists']),
});

resourceRoutes.post(
  '/upload/:uploadId/complete',
  requireRole('admin', 'contributor'),
  zValidator('json', completeUploadSchema),
  async (c) => {
    const uploadId = c.req.param('uploadId');
    const { parts, resourceId, resourceType } = c.req.valid('json');
    const { projectId } = c.get('currentUser');
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      );
    }

    try {
      const result = await completeChunkedUpload(
        uploadId,
        parts,
        resourceId,
        resourceType,
        projectId
      );
      return c.json(result);
    } catch (err) {
      logger.error({ err, uploadId }, 'Failed to complete chunked upload');
      return c.json(
        { error: { code: 'UPLOAD_COMPLETE_FAILED', message: 'Failed to complete upload' } },
        500
      );
    }
  }
);

resourceRoutes.delete('/upload/:uploadId', requireRole('admin', 'contributor'), async (c) => {
  const uploadId = c.req.param('uploadId');
  const resourceId = Number(c.req.query('resourceId'));
  const resourceType = c.req.query('resourceType');

  if (!uploadId || !resourceId || !resourceType) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'uploadId, resourceId, and resourceType are required',
        },
      },
      400
    );
  }

  const { projectId } = c.get('currentUser');
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400);
  }

  await abortChunkedUpload(uploadId, resourceId, resourceType, projectId);
  return c.json({ acknowledged: true });
});

resourceRoutes.get('/upload/:uploadId/status', requireRole('admin', 'contributor'), async (c) => {
  const uploadId = c.req.param('uploadId');
  const resourceId = Number(c.req.query('resourceId'));
  const resourceType = c.req.query('resourceType');

  if (!uploadId || !resourceId || !resourceType) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'uploadId, resourceId, and resourceType are required',
        },
      },
      400
    );
  }

  const { projectId } = c.get('currentUser');
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400);
  }

  const result = await getChunkedUploadStatus(uploadId, resourceId, resourceType, projectId);
  if (!result) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Upload not found' } }, 404);
  }

  return c.json({ uploadId, ...result });
});

export { resourceRoutes };
