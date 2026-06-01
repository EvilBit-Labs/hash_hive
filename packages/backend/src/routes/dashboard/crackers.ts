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
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireRole } from '../../middleware/rbac.js'
import {
  DASHBOARD_RESPONSE_REFS,
  sharedDashboardResponse,
  dashboardOpenApiHonoOptions,
} from '../../openapi/components.js'
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

const crackerRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

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

// ─── Schemas ────────────────────────────────────────────────────────

const listCrackersQuerySchema = z.object({
  engine: z.string().optional(),
  // `z.coerce.boolean()` would map any non-empty string (including the
  // literal "false") to `true`, silently flipping `?includeInactive=false`
  // into the opposite of what the caller asked for. Restrict to the two
  // canonical string forms and transform after validation.
  includeInactive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
})

const crackerIdParamSchema = z.object({ id: z.coerce.number().int().positive() })

const initiateUploadSchema = z.object({
  crackerBinaryId: z.number().int().positive(),
  fileSize: z.number().int().positive().max(500_000_000_000),
  contentType: z.string().max(255).optional(),
  fileName: z.string().min(1).max(255).optional(),
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

const uploadPartParamSchema = z.object({
  uploadId: z.string().min(1),
  partNumber: z.coerce.number().int().min(1).max(S3_MAX_PART_NUMBER),
})

const uploadIdParamSchema = z.object({ uploadId: z.string().min(1) })

const uploadIdQuerySchema = z.object({
  crackerBinaryId: z.coerce.number().int().positive(),
})

// ─── Response shapes ────────────────────────────────────────────────

const crackerListResponseSchema = z
  .object({ crackerBinaries: z.array(z.unknown()) })
  .passthrough()
  .openapi('CrackerBinaryList')

const crackerDetailResponseSchema = z
  .object({ crackerBinary: z.unknown() })
  .passthrough()
  .openapi('CrackerBinaryDetail')

const acknowledgedResponseSchema = z
  .object({ acknowledged: z.boolean() })
  .openapi('CrackerActionAcknowledged')

const uploadInitiateResponseSchema = z
  .object({ uploadId: z.string() })
  .passthrough()
  .openapi('CrackerUploadInitiated')

const uploadGenericResponseSchema = z
  .object({})
  .passthrough()
  .openapi('CrackerUploadGenericResponse')

const adminAuthResponses = {
  401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
  403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
} as const

// ─── List + Get ─────────────────────────────────────────────────────

const listCrackersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Crackers'],
  summary: 'List cracker binaries (global, admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireRole('admin')] as const,
  request: { query: listCrackersQuerySchema },
  responses: {
    200: {
      description: 'List of cracker binaries.',
      content: { 'application/json': { schema: crackerListResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    ...adminAuthResponses,
  },
})

crackerRoutes.openapi(listCrackersRoute, async (c) => {
  const { engine, includeInactive } = c.req.valid('query')
  try {
    const items = await listCrackerBinaries({
      ...(engine ? { engine } : {}),
      includeInactive: includeInactive ?? false,
    })
    return c.json({ crackerBinaries: items }, 200)
  } catch (err) {
    logger.error({ err }, 'Failed to list cracker binaries')
    return dashboardError(c, 500, 'CRACKER_LIST_FAILED', 'Failed to list cracker binaries')
  }
})

const getCrackerRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Crackers'],
  summary: 'Get a cracker binary by id (admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireRole('admin')] as const,
  request: { params: crackerIdParamSchema },
  responses: {
    200: {
      description: 'Cracker binary details.',
      content: { 'application/json': { schema: crackerDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    ...adminAuthResponses,
  },
})

crackerRoutes.openapi(getCrackerRoute, async (c) => {
  const { id } = c.req.valid('param')
  try {
    const item = await getCrackerBinaryById(id)
    if (!item) {
      return dashboardError(c, 404, 'CRACKER_NOT_FOUND', 'Cracker binary not found')
    }
    return c.json({ crackerBinary: item }, 200)
  } catch (err) {
    logger.error({ err, crackerBinaryId: id }, 'Failed to fetch cracker binary')
    return dashboardError(c, 500, 'CRACKER_GET_FAILED', 'Failed to fetch cracker binary')
  }
})

// ─── Create ─────────────────────────────────────────────────────────

const createCrackerRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Crackers'],
  summary: 'Create a cracker binary (admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireRole('admin')] as const,
  request: {
    body: { content: { 'application/json': { schema: createCrackerBinaryRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Cracker binary created.',
      content: { 'application/json': { schema: crackerDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    409: {
      description: 'Composite unique violation on (engine, version, platform).',
      content: { 'application/json': { schema: z.object({ error: z.unknown() }) } },
    },
    ...adminAuthResponses,
  },
})

crackerRoutes.openapi(createCrackerRoute, async (c) => {
  const data = c.req.valid('json')
  try {
    const item = await createCrackerBinary(data)
    return c.json({ crackerBinary: item }, 201)
  } catch (err: unknown) {
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
    return dashboardError(c, 500, 'CRACKER_CREATE_FAILED', 'Failed to create cracker binary')
  }
})

// ─── Update + Delete ────────────────────────────────────────────────

const updateCrackerRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Crackers'],
  summary: 'Update a cracker binary (admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireRole('admin')] as const,
  request: {
    params: crackerIdParamSchema,
    body: { content: { 'application/json': { schema: updateCrackerBinaryRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Updated cracker binary.',
      content: { 'application/json': { schema: crackerDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    ...adminAuthResponses,
  },
})

crackerRoutes.openapi(updateCrackerRoute, async (c) => {
  const { id } = c.req.valid('param')
  const data = c.req.valid('json')
  try {
    const item = await updateCrackerBinary(id, data)
    if (!item) {
      return dashboardError(c, 404, 'CRACKER_NOT_FOUND', 'Cracker binary not found')
    }
    return c.json({ crackerBinary: item }, 200)
  } catch (err) {
    logger.error({ err, crackerBinaryId: id }, 'Failed to update cracker binary')
    return dashboardError(c, 500, 'CRACKER_UPDATE_FAILED', 'Failed to update cracker binary')
  }
})

const deleteCrackerRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Crackers'],
  summary: 'Delete a cracker binary (admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireRole('admin')] as const,
  request: { params: crackerIdParamSchema },
  responses: {
    200: {
      description: 'Cracker binary deleted.',
      content: { 'application/json': { schema: acknowledgedResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    502: {
      description: 'Storage delete failed; DB row preserved for retry.',
      content: { 'application/json': { schema: z.object({ error: z.unknown() }) } },
    },
    ...adminAuthResponses,
  },
})

crackerRoutes.openapi(deleteCrackerRoute, async (c) => {
  const { id } = c.req.valid('param')
  try {
    const outcome = await deleteCrackerBinary(id)
    if (outcome === 'not_found') {
      return dashboardError(c, 404, 'CRACKER_NOT_FOUND', 'Cracker binary not found')
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
    return c.json({ acknowledged: true }, 200)
  } catch (err) {
    logger.error({ err, crackerBinaryId: id }, 'Failed to delete cracker binary')
    return dashboardError(c, 500, 'CRACKER_DELETE_FAILED', 'Failed to delete cracker binary')
  }
})

// ─── Direct Upload ──────────────────────────────────────────────────

const directUploadRoute = createRoute({
  method: 'post',
  path: '/{id}/upload',
  tags: ['Crackers'],
  summary: 'Direct multipart upload of a cracker binary (admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireRole('admin')] as const,
  request: {
    params: crackerIdParamSchema,
    // No body schema at the route layer. The handler does an upfront
    // Content-Length check (returns 413 BEFORE parseBody buffers the
    // payload) and then parses the multipart body itself; declaring a
    // schema here would let createRoute short-circuit the size guard
    // with a 400 and break the "rejects with 413 BEFORE parseBody"
    // contract the cracker upload tests assert.
  },
  responses: {
    200: {
      description: 'Direct upload accepted.',
      content: { 'application/json': { schema: uploadGenericResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    413: {
      description: 'Payload exceeds the direct-upload cap; use chunked endpoints.',
      content: { 'application/json': { schema: z.object({ error: z.unknown() }) } },
    },
    ...adminAuthResponses,
  },
})

crackerRoutes.openapi(directUploadRoute, async (c) => {
  const { id } = c.req.valid('param')

  // Refuse direct uploads above the cap before we materialize the body.
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
      return dashboardError(c, 404, 'CRACKER_NOT_FOUND', 'Cracker binary not found')
    }

    const body = await c.req.parseBody()
    const file = body['file']
    if (!(file instanceof File)) {
      return dashboardError(c, 400, 'VALIDATION_ERROR', 'file field is required')
    }

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
    return c.json(result, 200)
  } catch (err) {
    logger.error({ err, crackerBinaryId: id }, 'Failed direct upload')
    return dashboardError(c, 500, 'CRACKER_UPLOAD_FAILED', 'Failed to upload cracker binary')
  }
})

// ─── Chunked Upload ─────────────────────────────────────────────────

const initiateUploadRoute = createRoute({
  method: 'post',
  path: '/upload/initiate',
  tags: ['Crackers'],
  summary: 'Initiate a chunked upload session (admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireRole('admin')] as const,
  request: { body: { content: { 'application/json': { schema: initiateUploadSchema } } } },
  responses: {
    200: {
      description: 'Upload session created.',
      content: { 'application/json': { schema: uploadInitiateResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    ...adminAuthResponses,
  },
})

crackerRoutes.openapi(initiateUploadRoute, async (c) => {
  const data = c.req.valid('json')
  try {
    const result = await initiateCrackerChunkedUpload({
      id: data.crackerBinaryId,
      fileSize: data.fileSize,
      ...(data.contentType ? { contentType: data.contentType } : {}),
      ...(data.fileName ? { fileName: data.fileName } : {}),
    })
    return c.json(result, 200)
  } catch (err) {
    logger.error({ err }, 'Failed to initiate cracker chunked upload')
    return dashboardError(c, 500, 'UPLOAD_INIT_FAILED', 'Failed to initiate upload')
  }
})

const uploadPartRoute = createRoute({
  method: 'put',
  path: '/upload/{uploadId}/part/{partNumber}',
  tags: ['Crackers'],
  summary: 'Upload a single chunked-upload part (admin only); raw binary body',
  security: [{ SessionCookie: [] }],
  middleware: [requireRole('admin')] as const,
  request: {
    params: uploadPartParamSchema,
    query: uploadIdQuerySchema,
    // Raw binary body; the handler reads via c.req.arrayBuffer().
    body: {
      content: {
        'application/octet-stream': { schema: z.unknown() },
      },
    },
  },
  responses: {
    200: {
      description: 'Part uploaded.',
      content: { 'application/json': { schema: uploadGenericResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    409: {
      description: 'Upload session id mismatch.',
      content: { 'application/json': { schema: z.object({ error: z.unknown() }) } },
    },
    ...adminAuthResponses,
  },
})

crackerRoutes.openapi(uploadPartRoute, async (c) => {
  const { uploadId, partNumber } = c.req.valid('param')
  const { crackerBinaryId } = c.req.valid('query')

  const arrayBody = await c.req.arrayBuffer()
  const chunk = new Uint8Array(arrayBody)
  if (chunk.byteLength === 0) {
    return dashboardError(c, 400, 'VALIDATION_ERROR', 'Request body is empty')
  }

  try {
    const result = await uploadCrackerChunkPart(crackerBinaryId, uploadId, partNumber, chunk)
    return c.json(result, 200)
  } catch (err) {
    if (err instanceof CrackerUploadIdMismatchError) {
      return dashboardError(c, 409, 'UPLOAD_SESSION_MISMATCH', err.message)
    }
    logger.error({ err, uploadId, partNumber }, 'Failed to upload cracker part')
    return dashboardError(c, 500, 'UPLOAD_PART_FAILED', 'Failed to upload part')
  }
})

const completeUploadRoute = createRoute({
  method: 'post',
  path: '/upload/{uploadId}/complete',
  tags: ['Crackers'],
  summary: 'Finalize a chunked upload (admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireRole('admin')] as const,
  request: {
    params: uploadIdParamSchema,
    body: { content: { 'application/json': { schema: completeUploadSchema } } },
  },
  responses: {
    200: {
      description: 'Upload completed and stored.',
      content: { 'application/json': { schema: uploadGenericResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    409: {
      description: 'Upload session id mismatch.',
      content: { 'application/json': { schema: z.object({ error: z.unknown() }) } },
    },
    ...adminAuthResponses,
  },
})

crackerRoutes.openapi(completeUploadRoute, async (c) => {
  const { uploadId } = c.req.valid('param')
  const { parts, crackerBinaryId } = c.req.valid('json')
  try {
    const result = await completeCrackerChunkedUpload(crackerBinaryId, uploadId, parts)
    return c.json(result, 200)
  } catch (err) {
    if (err instanceof CrackerUploadIdMismatchError) {
      return dashboardError(c, 409, 'UPLOAD_SESSION_MISMATCH', err.message)
    }
    logger.error({ err, uploadId }, 'Failed to complete cracker chunked upload')
    return dashboardError(c, 500, 'UPLOAD_COMPLETE_FAILED', 'Failed to complete upload')
  }
})

const abortUploadRoute = createRoute({
  method: 'delete',
  path: '/upload/{uploadId}',
  tags: ['Crackers'],
  summary: 'Abort a chunked upload session (admin only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireRole('admin')] as const,
  request: { params: uploadIdParamSchema, query: uploadIdQuerySchema },
  responses: {
    200: {
      description: 'Upload aborted.',
      content: { 'application/json': { schema: acknowledgedResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    409: {
      description: 'Upload session id mismatch.',
      content: { 'application/json': { schema: z.object({ error: z.unknown() }) } },
    },
    ...adminAuthResponses,
  },
})

crackerRoutes.openapi(abortUploadRoute, async (c) => {
  const { uploadId } = c.req.valid('param')
  const { crackerBinaryId } = c.req.valid('query')
  try {
    await abortCrackerChunkedUpload(crackerBinaryId, uploadId)
    return c.json({ acknowledged: true }, 200)
  } catch (err) {
    if (err instanceof CrackerUploadIdMismatchError) {
      return dashboardError(c, 409, 'UPLOAD_SESSION_MISMATCH', err.message)
    }
    logger.error({ err, uploadId, crackerBinaryId }, 'Failed to abort cracker chunked upload')
    return dashboardError(c, 500, 'UPLOAD_ABORT_FAILED', 'Failed to abort upload')
  }
})

export { crackerRoutes }
