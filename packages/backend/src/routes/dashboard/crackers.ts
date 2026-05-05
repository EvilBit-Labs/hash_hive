/**
 * Dashboard router for cracker binary management.
 *
 * Admin-only (no contributor access). Crackers are GLOBAL — they have no
 * project scope, so listing and CRUD do not filter by project. The router
 * mirrors the chunked-upload control flow in `resources.ts` but with
 * cracker-specific service functions.
 */
import {
  createCrackerBinaryRequestSchema,
  updateCrackerBinaryRequestSchema,
} from '@hashhive/shared';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { requireSession } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import {
  abortCrackerChunkedUpload,
  completeCrackerChunkedUpload,
  createCrackerBinary,
  deleteCrackerBinary,
  getCrackerBinaryById,
  initiateCrackerChunkedUpload,
  listCrackerBinaries,
  updateCrackerBinary,
  uploadCrackerChunkPart,
  uploadCrackerFile,
} from '../../services/crackers.js';
import type { AppEnv } from '../../types.js';

const crackerRoutes = new Hono<AppEnv>();

crackerRoutes.use('*', requireSession);

// ─── List + Get ─────────────────────────────────────────────────────

crackerRoutes.get('/', requireRole('admin'), async (c) => {
  const engine = c.req.query('engine');
  const includeInactive = c.req.query('includeInactive') === 'true';
  const items = await listCrackerBinaries({
    ...(engine ? { engine } : {}),
    includeInactive,
  });
  return c.json({ crackerBinaries: items });
});

crackerRoutes.get('/:id', requireRole('admin'), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } }, 400);
  }

  const item = await getCrackerBinaryById(id);
  if (!item) {
    return c.json(
      { error: { code: 'CRACKER_NOT_FOUND', message: 'Cracker binary not found' } },
      404
    );
  }
  return c.json({ crackerBinary: item });
});

// ─── Create ─────────────────────────────────────────────────────────

crackerRoutes.post(
  '/',
  requireRole('admin'),
  zValidator('json', createCrackerBinaryRequestSchema),
  async (c) => {
    const data = c.req.valid('json');
    try {
      const item = await createCrackerBinary(data);
      return c.json({ crackerBinary: item }, 201);
    } catch (err: unknown) {
      // Composite unique violation surfaces as a 409 so admins know they
      // tried to register a duplicate (engine, version, platform) tuple.
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes('cracker_binaries_engine_version_platform_idx') ||
        message.includes('duplicate key')
      ) {
        return c.json(
          {
            error: {
              code: 'CRACKER_DUPLICATE',
              message: 'A cracker binary with this engine, version, and platform already exists',
            },
          },
          409
        );
      }
      logger.error({ err }, 'Failed to create cracker binary');
      return c.json(
        { error: { code: 'CRACKER_CREATE_FAILED', message: 'Failed to create cracker binary' } },
        500
      );
    }
  }
);

// ─── Update + Delete ────────────────────────────────────────────────

crackerRoutes.patch(
  '/:id',
  requireRole('admin'),
  zValidator('json', updateCrackerBinaryRequestSchema),
  async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } }, 400);
    }
    const data = c.req.valid('json');
    const item = await updateCrackerBinary(id, data);
    if (!item) {
      return c.json(
        { error: { code: 'CRACKER_NOT_FOUND', message: 'Cracker binary not found' } },
        404
      );
    }
    return c.json({ crackerBinary: item });
  }
);

crackerRoutes.delete('/:id', requireRole('admin'), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } }, 400);
  }
  const removed = await deleteCrackerBinary(id);
  if (!removed) {
    return c.json(
      { error: { code: 'CRACKER_NOT_FOUND', message: 'Cracker binary not found' } },
      404
    );
  }
  return c.json({ acknowledged: true });
});

// ─── Direct Upload ──────────────────────────────────────────────────

crackerRoutes.post('/:id/upload', requireRole('admin'), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } }, 400);
  }

  const item = await getCrackerBinaryById(id);
  if (!item) {
    return c.json(
      { error: { code: 'CRACKER_NOT_FOUND', message: 'Cracker binary not found' } },
      404
    );
  }

  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'file field is required' } }, 400);
  }

  const result = await uploadCrackerFile(id, file);
  return c.json(result);
});

// ─── Chunked Upload ─────────────────────────────────────────────────
// PUT /upload/:uploadId/part/:partNumber accepts raw binary; do NOT use
// zValidator there.

const initiateUploadSchema = z.object({
  crackerBinaryId: z.number().int().positive(),
  fileSize: z.number().int().positive().max(500_000_000_000),
  contentType: z.string().max(255).optional(),
  fileName: z.string().min(1).max(255).optional(),
});

crackerRoutes.post(
  '/upload/initiate',
  requireRole('admin'),
  zValidator('json', initiateUploadSchema),
  async (c) => {
    const data = c.req.valid('json');
    try {
      const result = await initiateCrackerChunkedUpload({
        id: data.crackerBinaryId,
        fileSize: data.fileSize,
        ...(data.contentType ? { contentType: data.contentType } : {}),
        ...(data.fileName ? { fileName: data.fileName } : {}),
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, 'Failed to initiate cracker chunked upload');
      return c.json(
        { error: { code: 'UPLOAD_INIT_FAILED', message: 'Failed to initiate upload' } },
        500
      );
    }
  }
);

crackerRoutes.put('/upload/:uploadId/part/:partNumber', requireRole('admin'), async (c) => {
  const uploadId = c.req.param('uploadId');
  const partNumber = Number(c.req.param('partNumber'));
  const crackerBinaryId = Number(c.req.query('crackerBinaryId'));

  if (!uploadId || !partNumber || !crackerBinaryId) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'uploadId, partNumber, and crackerBinaryId are required',
        },
      },
      400
    );
  }

  const body = await c.req.arrayBuffer();
  const chunk = new Uint8Array(body);
  if (chunk.byteLength === 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Request body is empty' } }, 400);
  }

  try {
    const result = await uploadCrackerChunkPart(crackerBinaryId, uploadId, partNumber, chunk);
    return c.json(result);
  } catch (err) {
    logger.error({ err, uploadId, partNumber }, 'Failed to upload cracker part');
    return c.json({ error: { code: 'UPLOAD_PART_FAILED', message: 'Failed to upload part' } }, 500);
  }
});

const completeUploadSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().positive(),
        etag: z.string().min(1),
      })
    )
    .min(1),
  crackerBinaryId: z.number().int().positive(),
});

crackerRoutes.post(
  '/upload/:uploadId/complete',
  requireRole('admin'),
  zValidator('json', completeUploadSchema),
  async (c) => {
    const uploadId = c.req.param('uploadId');
    const { parts, crackerBinaryId } = c.req.valid('json');
    try {
      const result = await completeCrackerChunkedUpload(crackerBinaryId, uploadId, parts);
      return c.json(result);
    } catch (err) {
      logger.error({ err, uploadId }, 'Failed to complete cracker chunked upload');
      return c.json(
        { error: { code: 'UPLOAD_COMPLETE_FAILED', message: 'Failed to complete upload' } },
        500
      );
    }
  }
);

crackerRoutes.delete('/upload/:uploadId', requireRole('admin'), async (c) => {
  const uploadId = c.req.param('uploadId');
  const crackerBinaryId = Number(c.req.query('crackerBinaryId'));
  if (!uploadId || !crackerBinaryId) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'uploadId and crackerBinaryId are required',
        },
      },
      400
    );
  }
  await abortCrackerChunkedUpload(crackerBinaryId, uploadId);
  return c.json({ acknowledged: true });
});

export { crackerRoutes };
