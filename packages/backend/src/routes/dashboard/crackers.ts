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
  CrackerUploadIdMismatchError,
  completeCrackerChunkedUpload,
  createCrackerBinary,
  deleteCrackerBinary,
  getCrackerBinaryById,
  initiateCrackerChunkedUpload,
  isUniqueViolation,
  listCrackerBinaries,
  updateCrackerBinary,
  uploadCrackerChunkPart,
  uploadCrackerFile,
} from '../../services/crackers.js';
import type { AppEnv } from '../../types.js';

const crackerRoutes = new Hono<AppEnv>();

// Direct uploads are capped well below the chunked threshold so admin
// clients route large binaries through the multipart path. The cap
// applies to Content-Length (set by the browser FormData encoder).
const DIRECT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100 MB

const S3_MAX_PART_NUMBER = 10_000; // S3 multipart part-number range is [1, 10000]

crackerRoutes.use('*', requireSession);

// ─── List + Get ─────────────────────────────────────────────────────

crackerRoutes.get('/', requireRole('admin'), async (c) => {
  const engine = c.req.query('engine');
  const includeInactive = c.req.query('includeInactive') === 'true';
  try {
    const items = await listCrackerBinaries({
      ...(engine ? { engine } : {}),
      includeInactive,
    });
    return c.json({ crackerBinaries: items });
  } catch (err) {
    logger.error({ err }, 'Failed to list cracker binaries');
    return c.json(
      { error: { code: 'CRACKER_LIST_FAILED', message: 'Failed to list cracker binaries' } },
      500
    );
  }
});

crackerRoutes.get('/:id', requireRole('admin'), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } }, 400);
  }

  try {
    const item = await getCrackerBinaryById(id);
    if (!item) {
      return c.json(
        { error: { code: 'CRACKER_NOT_FOUND', message: 'Cracker binary not found' } },
        404
      );
    }
    return c.json({ crackerBinary: item });
  } catch (err) {
    logger.error({ err, crackerBinaryId: id }, 'Failed to fetch cracker binary');
    return c.json(
      { error: { code: 'CRACKER_GET_FAILED', message: 'Failed to fetch cracker binary' } },
      500
    );
  }
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
      // Composite unique violation (engine, version, platform) surfaces
      // as 409 so the admin sees a typed conflict instead of a generic 500.
      if (isUniqueViolation(err)) {
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
    try {
      const item = await updateCrackerBinary(id, data);
      if (!item) {
        return c.json(
          { error: { code: 'CRACKER_NOT_FOUND', message: 'Cracker binary not found' } },
          404
        );
      }
      return c.json({ crackerBinary: item });
    } catch (err) {
      logger.error({ err, crackerBinaryId: id }, 'Failed to update cracker binary');
      return c.json(
        { error: { code: 'CRACKER_UPDATE_FAILED', message: 'Failed to update cracker binary' } },
        500
      );
    }
  }
);

crackerRoutes.delete('/:id', requireRole('admin'), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } }, 400);
  }
  try {
    const outcome = await deleteCrackerBinary(id);
    if (outcome === 'not_found') {
      return c.json(
        { error: { code: 'CRACKER_NOT_FOUND', message: 'Cracker binary not found' } },
        404
      );
    }
    if (outcome === 'storage_failed') {
      // Don't 200 — the row still exists and the admin needs to retry.
      return c.json(
        {
          error: {
            code: 'CRACKER_STORAGE_DELETE_FAILED',
            message:
              'Failed to delete the stored binary; row was kept so you can retry. See server logs for details.',
          },
        },
        502
      );
    }
    return c.json({ acknowledged: true });
  } catch (err) {
    logger.error({ err, crackerBinaryId: id }, 'Failed to delete cracker binary');
    return c.json(
      { error: { code: 'CRACKER_DELETE_FAILED', message: 'Failed to delete cracker binary' } },
      500
    );
  }
});

// ─── Direct Upload ──────────────────────────────────────────────────

crackerRoutes.post('/:id/upload', requireRole('admin'), async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id) || id <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } }, 400);
  }

  // Refuse direct uploads above the cap before we materialize the body.
  // Clients with larger files must use the chunked endpoints below.
  const contentLengthHeader = c.req.header('content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  if (Number.isFinite(contentLength) && contentLength > DIRECT_UPLOAD_MAX_BYTES) {
    return c.json(
      {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Direct upload exceeds the ${DIRECT_UPLOAD_MAX_BYTES} byte cap; use the chunked upload endpoints for larger binaries.`,
        },
      },
      413
    );
  }

  try {
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
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: 'file field is required' } },
        400
      );
    }

    // Same cap, applied to the actual file size in case Content-Length
    // wasn't sent or was understated.
    if (file.size > DIRECT_UPLOAD_MAX_BYTES) {
      return c.json(
        {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `File exceeds the ${DIRECT_UPLOAD_MAX_BYTES} byte direct-upload cap.`,
          },
        },
        413
      );
    }

    const result = await uploadCrackerFile(id, file);
    return c.json(result);
  } catch (err) {
    logger.error({ err, crackerBinaryId: id }, 'Failed direct upload');
    return c.json(
      { error: { code: 'CRACKER_UPLOAD_FAILED', message: 'Failed to upload cracker binary' } },
      500
    );
  }
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
  const partNumberRaw = c.req.param('partNumber');
  const partNumber = Number(partNumberRaw);
  const crackerBinaryId = Number(c.req.query('crackerBinaryId'));

  if (!uploadId || !crackerBinaryId || !Number.isFinite(crackerBinaryId)) {
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

  // partNumber must be an integer in [1, 10000] per the S3 multipart
  // spec. `Number(...)` accepts `1.5`, `1e10`, `Infinity` — guard
  // explicitly so garbage values surface as 400 rather than opaque 500s
  // from the S3 SDK.
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > S3_MAX_PART_NUMBER) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: `partNumber must be an integer between 1 and ${S3_MAX_PART_NUMBER}`,
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
    if (err instanceof CrackerUploadIdMismatchError) {
      return c.json({ error: { code: 'UPLOAD_SESSION_MISMATCH', message: err.message } }, 409);
    }
    logger.error({ err, uploadId, partNumber }, 'Failed to upload cracker part');
    return c.json({ error: { code: 'UPLOAD_PART_FAILED', message: 'Failed to upload part' } }, 500);
  }
});

const completeUploadSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().positive().max(S3_MAX_PART_NUMBER),
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
      if (err instanceof CrackerUploadIdMismatchError) {
        return c.json({ error: { code: 'UPLOAD_SESSION_MISMATCH', message: err.message } }, 409);
      }
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
  if (!uploadId || !crackerBinaryId || !Number.isFinite(crackerBinaryId)) {
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
  try {
    await abortCrackerChunkedUpload(crackerBinaryId, uploadId);
    return c.json({ acknowledged: true });
  } catch (err) {
    if (err instanceof CrackerUploadIdMismatchError) {
      return c.json({ error: { code: 'UPLOAD_SESSION_MISMATCH', message: err.message } }, 409);
    }
    logger.error({ err, uploadId, crackerBinaryId }, 'Failed to abort cracker chunked upload');
    return c.json(
      { error: { code: 'UPLOAD_ABORT_FAILED', message: 'Failed to abort upload' } },
      500
    );
  }
});

export { crackerRoutes };
