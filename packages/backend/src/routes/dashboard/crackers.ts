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
} from '@hashhive/shared'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { requireSession } from '../../middleware/auth.js'
import { requireRole } from '../../middleware/rbac.js'
import {
  abortCrackerChunkedUpload,
  CRACKER_DIRECT_UPLOAD_MAX_BYTES,
  CrackerBinaryValidationError,
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
} from '../../services/crackers.js'

const crackerRoutes = new Hono<AppEnv>()

const S3_MAX_PART_NUMBER = 10_000 // S3 multipart part-number range is [1, 10000]

// multipart/form-data adds boundary + per-field headers around the file
// payload. A request whose Content-Length is just above the file-size
// cap still has a valid file under the cap. Pad the Content-Length
// guard by 1 MB (well above any realistic boundary/header overhead) so
// it remains a cheap DoS gate without rejecting valid uploads near the
// boundary. The authoritative `file.size` check still runs after
// parseBody so legitimately oversized files are rejected.
const DIRECT_UPLOAD_CONTENT_LENGTH_MAX_BYTES = CRACKER_DIRECT_UPLOAD_MAX_BYTES + 1024 * 1024

crackerRoutes.use('*', requireSession)

// ─── List + Get ─────────────────────────────────────────────────────

crackerRoutes.get('/', requireRole('admin'), async (c) => {
  const engine = c.req.query('engine')
  const includeInactive = c.req.query('includeInactive') === 'true'
  try {
    const items = await listCrackerBinaries({
      ...(engine ? { engine } : {}),
      includeInactive,
    })
    return c.json({ crackerBinaries: items })
  } catch (err) {
    logger.error({ err }, 'Failed to list cracker binaries')
    return c.json(
      { error: { code: 'CRACKER_LIST_FAILED', message: 'Failed to list cracker binaries' } },
      500
    )
  }
})

crackerRoutes.get('/:id', requireRole('admin'), async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id) || id <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } }, 400)
  }

  try {
    const item = await getCrackerBinaryById(id)
    if (!item) {
      return c.json(
        { error: { code: 'CRACKER_NOT_FOUND', message: 'Cracker binary not found' } },
        404
      )
    }
    return c.json({ crackerBinary: item })
  } catch (err) {
    logger.error({ err, crackerBinaryId: id }, 'Failed to fetch cracker binary')
    return c.json(
      { error: { code: 'CRACKER_GET_FAILED', message: 'Failed to fetch cracker binary' } },
      500
    )
  }
})

// ─── Create ─────────────────────────────────────────────────────────

crackerRoutes.post(
  '/',
  requireRole('admin'),
  zValidator('json', createCrackerBinaryRequestSchema),
  async (c) => {
    const data = c.req.valid('json')
    try {
      const item = await createCrackerBinary(data)
      return c.json({ crackerBinary: item }, 201)
    } catch (err: unknown) {
      // Whitespace-only version/platform pass Zod's `min(1)` but trim
      // to empty inside the service. Surface that as 400 with a typed code.
      if (err instanceof CrackerBinaryValidationError) {
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: err.message,
              field: err.field,
            },
          },
          400
        )
      }
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
        )
      }
      logger.error({ err }, 'Failed to create cracker binary')
      return c.json(
        { error: { code: 'CRACKER_CREATE_FAILED', message: 'Failed to create cracker binary' } },
        500
      )
    }
  }
)

// ─── Update + Delete ────────────────────────────────────────────────

crackerRoutes.patch(
  '/:id',
  requireRole('admin'),
  zValidator('json', updateCrackerBinaryRequestSchema),
  async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isFinite(id) || id <= 0) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } }, 400)
    }
    const data = c.req.valid('json')
    try {
      const item = await updateCrackerBinary(id, data)
      if (!item) {
        return c.json(
          { error: { code: 'CRACKER_NOT_FOUND', message: 'Cracker binary not found' } },
          404
        )
      }
      return c.json({ crackerBinary: item })
    } catch (err) {
      logger.error({ err, crackerBinaryId: id }, 'Failed to update cracker binary')
      return c.json(
        { error: { code: 'CRACKER_UPDATE_FAILED', message: 'Failed to update cracker binary' } },
        500
      )
    }
  }
)

crackerRoutes.delete('/:id', requireRole('admin'), async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id) || id <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } }, 400)
  }
  try {
    const outcome = await deleteCrackerBinary(id)
    if (outcome === 'not_found') {
      return c.json(
        { error: { code: 'CRACKER_NOT_FOUND', message: 'Cracker binary not found' } },
        404
      )
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
      )
    }
    return c.json({ acknowledged: true })
  } catch (err) {
    logger.error({ err, crackerBinaryId: id }, 'Failed to delete cracker binary')
    return c.json(
      { error: { code: 'CRACKER_DELETE_FAILED', message: 'Failed to delete cracker binary' } },
      500
    )
  }
})

// ─── Direct Upload ──────────────────────────────────────────────────

crackerRoutes.post('/:id/upload', requireRole('admin'), async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id) || id <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid id' } }, 400)
  }

  // Refuse direct uploads above the cap before we materialize the body.
  // The Content-Length cap is intentionally larger than the file-size
  // cap to allow for multipart/form-data boundary + header overhead;
  // the authoritative `file.size` check below rejects oversized files
  // precisely. Clients with larger files must use the chunked endpoints.
  const contentLengthHeader = c.req.header('content-length')
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN
  if (Number.isFinite(contentLength) && contentLength > DIRECT_UPLOAD_CONTENT_LENGTH_MAX_BYTES) {
    return c.json(
      {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Direct upload exceeds the ${CRACKER_DIRECT_UPLOAD_MAX_BYTES} byte file-size cap; use the chunked upload endpoints for larger binaries.`,
        },
      },
      413
    )
  }

  try {
    const item = await getCrackerBinaryById(id)
    if (!item) {
      return c.json(
        { error: { code: 'CRACKER_NOT_FOUND', message: 'Cracker binary not found' } },
        404
      )
    }

    const body = await c.req.parseBody()
    const file = body['file']
    if (!(file instanceof File)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'file field is required' } }, 400)
    }

    // Authoritative cap on the actual file payload (Content-Length may
    // be absent or understated, and includes multipart overhead that
    // file.size does not).
    if (file.size > CRACKER_DIRECT_UPLOAD_MAX_BYTES) {
      return c.json(
        {
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `File exceeds the ${CRACKER_DIRECT_UPLOAD_MAX_BYTES} byte direct-upload cap.`,
          },
        },
        413
      )
    }

    const result = await uploadCrackerFile(id, file)
    return c.json(result)
  } catch (err) {
    logger.error({ err, crackerBinaryId: id }, 'Failed direct upload')
    return c.json(
      { error: { code: 'CRACKER_UPLOAD_FAILED', message: 'Failed to upload cracker binary' } },
      500
    )
  }
})

// ─── Chunked Upload ─────────────────────────────────────────────────
// PUT /upload/:uploadId/part/:partNumber accepts raw binary; do NOT use
// zValidator there.

const initiateUploadSchema = z.object({
  crackerBinaryId: z.number().int().positive(),
  fileSize: z.number().int().positive().max(500_000_000_000),
  contentType: z.string().max(255).optional(),
  fileName: z.string().min(1).max(255).optional(),
})

crackerRoutes.post(
  '/upload/initiate',
  requireRole('admin'),
  zValidator('json', initiateUploadSchema),
  async (c) => {
    const data = c.req.valid('json')
    try {
      const result = await initiateCrackerChunkedUpload({
        id: data.crackerBinaryId,
        fileSize: data.fileSize,
        ...(data.contentType ? { contentType: data.contentType } : {}),
        ...(data.fileName ? { fileName: data.fileName } : {}),
      })
      return c.json(result)
    } catch (err) {
      logger.error({ err }, 'Failed to initiate cracker chunked upload')
      return c.json(
        { error: { code: 'UPLOAD_INIT_FAILED', message: 'Failed to initiate upload' } },
        500
      )
    }
  }
)

crackerRoutes.put('/upload/:uploadId/part/:partNumber', requireRole('admin'), async (c) => {
  const uploadId = c.req.param('uploadId')
  const partNumberRaw = c.req.param('partNumber')
  const partNumber = Number(partNumberRaw)
  const crackerBinaryId = Number(c.req.query('crackerBinaryId'))

  // crackerBinaryId must be a positive integer. Truthiness checks let
  // negative numbers through (`-1` is truthy and finite); explicit
  // `Number.isInteger(...) && > 0` keeps invalid IDs from reaching the
  // service layer.
  if (!uploadId || !Number.isInteger(crackerBinaryId) || crackerBinaryId <= 0) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'uploadId and a positive integer crackerBinaryId are required',
        },
      },
      400
    )
  }

  // partNumber must be an integer in [1, 10000] per the S3 multipart
  // spec. `Number(...)` accepts `1.5`, `1e10`, `Infinity`, `-1` — guard
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
    )
  }

  const body = await c.req.arrayBuffer()
  const chunk = new Uint8Array(body)
  if (chunk.byteLength === 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Request body is empty' } }, 400)
  }

  try {
    const result = await uploadCrackerChunkPart(crackerBinaryId, uploadId, partNumber, chunk)
    return c.json(result)
  } catch (err) {
    if (err instanceof CrackerUploadIdMismatchError) {
      return c.json({ error: { code: 'UPLOAD_SESSION_MISMATCH', message: err.message } }, 409)
    }
    logger.error({ err, uploadId, partNumber }, 'Failed to upload cracker part')
    return c.json({ error: { code: 'UPLOAD_PART_FAILED', message: 'Failed to upload part' } }, 500)
  }
})

const completeUploadSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().positive().max(S3_MAX_PART_NUMBER),
        etag: z.string().min(1),
      })
    )
    .min(1)
    .superRefine((parts, ctx) => {
      // S3 only validates these invariants after every part has been
      // uploaded. Catching them here surfaces typed 400s before we
      // call out to S3 with a definitely-broken parts list.
      const seen = new Set<number>()
      let prev = 0
      for (const part of parts) {
        if (seen.has(part.partNumber)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate partNumber ${part.partNumber}`,
          })
        }
        if (part.partNumber <= prev) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'parts must be sorted by partNumber ascending',
          })
        }
        seen.add(part.partNumber)
        prev = part.partNumber
      }
    }),
  crackerBinaryId: z.number().int().positive(),
})

crackerRoutes.post(
  '/upload/:uploadId/complete',
  requireRole('admin'),
  zValidator('json', completeUploadSchema),
  async (c) => {
    const uploadId = c.req.param('uploadId')
    const { parts, crackerBinaryId } = c.req.valid('json')
    try {
      const result = await completeCrackerChunkedUpload(crackerBinaryId, uploadId, parts)
      return c.json(result)
    } catch (err) {
      if (err instanceof CrackerUploadIdMismatchError) {
        return c.json({ error: { code: 'UPLOAD_SESSION_MISMATCH', message: err.message } }, 409)
      }
      logger.error({ err, uploadId }, 'Failed to complete cracker chunked upload')
      return c.json(
        { error: { code: 'UPLOAD_COMPLETE_FAILED', message: 'Failed to complete upload' } },
        500
      )
    }
  }
)

crackerRoutes.delete('/upload/:uploadId', requireRole('admin'), async (c) => {
  const uploadId = c.req.param('uploadId')
  const crackerBinaryId = Number(c.req.query('crackerBinaryId'))
  if (!uploadId || !Number.isInteger(crackerBinaryId) || crackerBinaryId <= 0) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'uploadId and a positive integer crackerBinaryId are required',
        },
      },
      400
    )
  }
  try {
    await abortCrackerChunkedUpload(crackerBinaryId, uploadId)
    return c.json({ acknowledged: true })
  } catch (err) {
    if (err instanceof CrackerUploadIdMismatchError) {
      return c.json({ error: { code: 'UPLOAD_SESSION_MISMATCH', message: err.message } }, 409)
    }
    logger.error({ err, uploadId, crackerBinaryId }, 'Failed to abort cracker chunked upload')
    return c.json(
      { error: { code: 'UPLOAD_ABORT_FAILED', message: 'Failed to abort upload' } },
      500
    )
  }
})

export { crackerRoutes }
