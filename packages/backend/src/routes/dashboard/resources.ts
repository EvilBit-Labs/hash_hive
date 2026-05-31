import {
  createHashListRequestSchema,
  detectHashTypeRequestSchema,
  maskLists,
  ruleLists,
  wordLists,
} from '@hashhive/shared'
import { OpenAPIHono } from '@hono/zod-openapi'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess, requireMembershipRole } from '../../middleware/rbac.js'
import { guessHashType } from '../../services/hash-analysis.js'
import {
  abortChunkedUpload,
  completeChunkedUpload,
  createHashList,
  createResource,
  deleteHashList,
  deleteResource,
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
  MAX_DIRECT_UPLOAD_BYTES,
  type ResourceTable,
  ResourceInUseError,
  uploadChunkPart,
  uploadHashListFile,
  UploadTooLargeError,
  uploadResourceFile,
} from '../../services/resources.js'

// Cap the multipart wire body slightly above the direct-upload limit. The
// extra 1 MB covers multipart overhead (boundaries, field headers) so a
// genuine 10 MB file isn't rejected by the wire-size check before it
// reaches the byte-size check in `uploadHashListFile`. Anything larger
// is rejected before parseBody so the server doesn't buffer GBs into
// memory. See the multipart branch in POST /hash-lists.
const MULTIPART_BODY_LIMIT_BYTES = MAX_DIRECT_UPLOAD_BYTES + 1_048_576

/**
 * Reject oversize multipart payloads BEFORE `c.req.parseBody()` buffers
 * the whole body. Two protections:
 *   1. `Transfer-Encoding: chunked` lacks Content-Length, so the cap
 *      below can't enforce. Reject chunked outright (411) and steer
 *      the caller to the streaming chunked-upload endpoint.
 *   2. Declared Content-Length above `MULTIPART_BODY_LIMIT_BYTES` →
 *      413 PAYLOAD_TOO_LARGE.
 * `uploadHashListFile` / `uploadResourceFile` enforce the post-parse
 * byte cap via `UploadTooLargeError` as a backstop. Without this
 * pre-parse guard an authenticated admin/contributor could OOM the
 * backend with a multi-GB body.
 *
 * Returns a Response when the request must be rejected; returns null
 * when the caller should proceed to parseBody().
 */
function enforceMultipartSizeLimit(c: {
  req: { header: (k: string) => string | undefined }
  json: (body: unknown, status: number) => Response
}): Response | null {
  const transferEncoding = (c.req.header('transfer-encoding') ?? '').toLowerCase()
  if (transferEncoding.includes('chunked')) {
    return c.json(
      {
        error: {
          code: 'LENGTH_REQUIRED',
          message:
            'Multipart uploads must include Content-Length. Use the chunked upload endpoint (POST /api/v1/dashboard/resources/upload/initiate) for streamed/large files.',
        },
      },
      411
    )
  }
  const contentLengthRaw = c.req.header('content-length')
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : undefined
  if (
    typeof contentLength === 'number' &&
    Number.isFinite(contentLength) &&
    contentLength > MULTIPART_BODY_LIMIT_BYTES
  ) {
    return c.json(
      {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Multipart body (${contentLength} bytes) exceeds ${MULTIPART_BODY_LIMIT_BYTES} bytes. Use the chunked upload endpoint (POST /api/v1/dashboard/resources/upload/initiate) for larger files.`,
        },
      },
      413
    )
  }
  return null
}

/**
 * Shared query-shape validator for the chunked-upload GET-status /
 * DELETE-abort endpoints. Both routes accept `uploadId` (path) plus
 * `resourceId` (positive integer query) + `resourceType` (one of the
 * known resource buckets) -- truthiness checks alone admitted
 * `resourceId=-1` and arbitrary `resourceType` strings, leaking
 * invalid input into the service layer.
 */
const RESOURCE_TYPES = ['hash-lists', 'wordlists', 'rulelists', 'masklists'] as const
const uploadStatusQuerySchema = z.object({
  resourceId: z.coerce.number().int().positive(),
  resourceType: z.enum(RESOURCE_TYPES),
})

const resourceRoutes = new OpenAPIHono<AppEnv>()

resourceRoutes.use('*', requireSession)

// ─── Hash Types ──────────────────────────────────────────────────────

resourceRoutes.get('/hash-types', async (c) => {
  const hashTypes = await listHashTypes()
  return c.json({ hashTypes })
})

// ─── Hash Lists ─────────────────────────────────────────────────────

resourceRoutes.get('/hash-lists', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('scopedUser')!

  const hashLists = await listHashLists(projectId)
  return c.json({ hashLists })
})

// createHashListRequestSchema is imported from @hashhive/shared.

// Content-type-aware route. Multipart -> one-shot create+upload+enqueue
// flow (returns 202 with status='processing'). JSON -> legacy create-empty
// flow that the caller follows with separate /upload + /import requests
// (still in use by the CLI and older frontend code paths).
// We cannot apply zValidator at registration because the validator binds
// per content-type; instead we dispatch inside the handler.
resourceRoutes.post('/hash-lists', requireMembershipRole('admin', 'contributor'), async (c) => {
  const { projectId } = c.get('scopedUser')!

  const contentType = c.req.header('content-type') ?? ''

  // ─── Multipart one-shot upload (ticket AC #1) ──────────────────────
  if (contentType.startsWith('multipart/form-data')) {
    const sizeGuardResponse = enforceMultipartSizeLimit(c)
    if (sizeGuardResponse) return sizeGuardResponse
    let body: Awaited<ReturnType<typeof c.req.parseBody>>
    try {
      body = await c.req.parseBody()
    } catch (err) {
      logger.warn({ err }, 'Failed to parse multipart body for POST /hash-lists')
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Malformed multipart body',
          },
        },
        400
      )
    }
    const file = body['file']
    const nameRaw = body['name']
    const hashTypeIdRaw = body['hashTypeId']

    if (!(file instanceof File)) {
      return dashboardError(c, 400, 'VALIDATION_ERROR', 'file field is required')
    }
    // Align with createHashListRequestSchema (1-255 chars) so the multipart
    // and JSON paths accept the same name lengths.
    if (typeof nameRaw !== 'string' || nameRaw.length === 0 || nameRaw.length > 255) {
      return c.json(
        {
          error: { code: 'VALIDATION_ERROR', message: 'name is required (1-255 chars)' },
        },
        400
      )
    }
    let hashTypeId: number | undefined
    if (typeof hashTypeIdRaw === 'string' && hashTypeIdRaw.length > 0) {
      const parsed = Number(hashTypeIdRaw)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'hashTypeId must be a positive integer',
            },
          },
          400
        )
      }
      hashTypeId = parsed
    }

    // Create the DB row first so we can target the upload at a stable key.
    const created = await createHashList({
      projectId,
      name: nameRaw,
      ...(hashTypeId !== undefined ? { hashTypeId } : {}),
    })
    if (!created) {
      return dashboardError(c, 503, 'STORAGE_UNAVAILABLE', 'Failed to create hash list')
    }

    // Upload — rollback DB row on failure so the caller sees a clean error
    // state rather than an orphaned uploading-status row.
    try {
      await uploadHashListFile(created.id, projectId, file)
    } catch (err) {
      try {
        await deleteHashList(created.id, projectId)
      } catch (rollbackErr) {
        logger.error(
          { hashListId: created.id, err: rollbackErr },
          'Failed to rollback hash list after upload error'
        )
      }
      if (err instanceof UploadTooLargeError) {
        return c.json(
          {
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: `File size (${err.size} bytes) exceeds the direct-upload limit (${err.limit} bytes). Use the chunked upload endpoint (POST /api/v1/dashboard/resources/upload/initiate) for larger files.`,
            },
          },
          413
        )
      }
      logger.error({ hashListId: created.id, err }, 'Hash list upload failed')
      return dashboardError(c, 503, 'STORAGE_UNAVAILABLE', 'Failed to upload file')
    }

    // Enqueue parsing. If the queue is down we leave the row in `uploaded`
    // status (the user can retry via POST /:id/import) and surface a 503.
    const importResult = await importHashList(created.id, projectId)
    if (!importResult) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Hash list not found')
    }
    if ('error' in importResult) {
      return dashboardError(c, 503, 'SERVICE_UNAVAILABLE', importResult.error)
    }

    // Re-read so the response carries `status=processing` and the fresh fileRef.
    const finalRow = await getHashListById(created.id, projectId)
    return c.json({ hashList: finalRow }, 202)
  }

  // ─── Legacy JSON create-empty path ─────────────────────────────────
  const parsed = createHashListRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return dashboardError(c, 400, 'VALIDATION_ERROR', 'Invalid JSON body')
  }
  const hashList = await createHashList({ ...parsed.data, projectId })
  return c.json({ hashList }, 201)
})

resourceRoutes.get('/hash-lists/:id', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('scopedUser')!

  const hashListId = Number(c.req.param('id'))
  const hl = await getHashListById(hashListId, projectId)

  if (!hl) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Hash list not found')
  }

  const liveStats = await getHashListStats(hashListId)

  // Strip legacy keys so a pre-rename row (parsed before U1 shipped) doesn't
  // leak `{total, cracked, remaining, skippedLines}` into the response next
  // to the new `{totalCount, crackedCount, crackRate, lastUpdated}` shape.
  // `lastUpdated` is the only persisted-only field; everything else is
  // recomputed from `liveStats` on every request so the response is always
  // wire-shape-clean regardless of what's in the JSONB.
  const persistedStats = (hl.statistics as Record<string, unknown> | null) ?? {}
  const lastUpdated =
    typeof persistedStats['lastUpdated'] === 'string' ? persistedStats['lastUpdated'] : undefined

  return c.json({
    hashList: {
      ...hl,
      statistics: {
        ...liveStats,
        ...(lastUpdated ? { lastUpdated } : {}),
      },
    },
  })
})

resourceRoutes.delete(
  '/hash-lists/:id',
  requireMembershipRole('admin', 'contributor'),
  async (c) => {
    const { projectId } = c.get('scopedUser')!

    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) {
      return dashboardError(c, 400, 'VALIDATION_ERROR', 'Invalid hash list id')
    }

    try {
      const deleted = await deleteHashList(id, projectId)
      if (!deleted) {
        return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Hash list not found')
      }
      return c.body(null, 204)
    } catch (err) {
      if (err instanceof ResourceInUseError) {
        return dashboardError(c, 409, 'RESOURCE_IN_USE', err.message)
      }
      throw err
    }
  }
)

resourceRoutes.post(
  '/hash-lists/:id/upload',
  requireMembershipRole('admin', 'contributor'),
  async (c) => {
    const { projectId } = c.get('scopedUser')!

    const id = Number(c.req.param('id'))
    const hashList = await getHashListById(id, projectId)

    if (!hashList) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Hash list not found')
    }

    const sizeGuardResponse = enforceMultipartSizeLimit(c)
    if (sizeGuardResponse) return sizeGuardResponse

    const body = await c.req.parseBody()
    const file = body['file']

    if (!(file instanceof File)) {
      return dashboardError(c, 400, 'VALIDATION_ERROR', 'file field is required')
    }

    try {
      const result = await uploadHashListFile(id, projectId, file)
      return c.json(result)
    } catch (err) {
      if (err instanceof UploadTooLargeError) {
        return c.json(
          {
            error: {
              code: 'PAYLOAD_TOO_LARGE',
              message: `File size (${err.size} bytes) exceeds the direct-upload limit (${err.limit} bytes). Use the chunked upload endpoint (POST /api/v1/dashboard/resources/upload/initiate) for larger files.`,
            },
          },
          413
        )
      }
      throw err
    }
  }
)

resourceRoutes.post(
  '/hash-lists/:id/import',
  requireMembershipRole('admin', 'contributor'),
  async (c) => {
    const { projectId } = c.get('scopedUser')!

    const id = Number(c.req.param('id'))

    // Verify hash list belongs to project before importing
    const hl = await getHashListById(id, projectId)
    if (!hl) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Hash list not found')
    }

    const result = await importHashList(id, projectId)

    if (!result) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Hash list not found')
    }

    if ('error' in result) {
      return dashboardError(c, 503, 'SERVICE_UNAVAILABLE', result.error)
    }

    return c.json(result)
  }
)

resourceRoutes.get('/hash-lists/:id/items', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('scopedUser')!

  const hashListId = Number(c.req.param('id'))

  // Validate query params — fail fast on invalid input
  const statusRaw = c.req.query('status')
  const VALID_STATUSES = ['all', 'cracked', 'uncracked'] as const
  const status =
    statusRaw && VALID_STATUSES.includes(statusRaw as (typeof VALID_STATUSES)[number])
      ? (statusRaw as 'all' | 'cracked' | 'uncracked')
      : undefined
  const q = c.req.query('q')?.slice(0, 256) || undefined
  const limitRaw = Number(c.req.query('limit') ?? 50)
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 100)) : 50
  const offsetRaw = Number(c.req.query('offset') ?? 0)
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0

  const result = await getHashItems(hashListId, projectId, { status, search: q, limit, offset })

  if (!result) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Hash list not found')
  }

  return c.json(result)
})

resourceRoutes.get('/hash-lists/:id/download', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('scopedUser')!

  const id = Number(c.req.param('id'))
  const hashList = await getHashListById(id, projectId)

  if (!hashList) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Hash list not found')
  }

  const fileRef = hashList.fileRef as { bucket?: string; key?: string; name?: string } | null
  if (!fileRef?.bucket || !fileRef?.key) {
    return dashboardError(c, 400, 'VALIDATION_ERROR', 'Hash list has no uploaded file')
  }

  const url = await getResourcePresignedUrl({
    bucket: fileRef.bucket,
    key: fileRef.key,
    ...(fileRef.name ? { name: fileRef.name } : {}),
  })
  return c.json({ url })
})

// ─── Hash Type Detection ─────────────────────────────────────────────

// detectHashTypeRequestSchema is imported from @hashhive/shared.

resourceRoutes.post(
  '/detect-hash-type',
  requireSession,
  zValidator('json', detectHashTypeRequestSchema),
  async (c) => {
    const { hashes } = c.req.valid('json')

    const results = hashes.map((hashValue) => ({
      hashValue,
      candidates: guessHashType(hashValue),
    }))

    return c.json({ results })
  }
)

// ─── Generic resource routes factory ────────────────────────────────

function createResourceRoutes(prefix: string, table: ResourceTable) {
  const createSchema = z.object({
    name: z.string().min(1).max(255),
  })

  resourceRoutes.get(`/${prefix}`, requireProjectAccess(), async (c) => {
    const { projectId } = c.get('scopedUser')!

    const items = await listResources(table, projectId)
    return c.json({ [prefix]: items })
  })

  resourceRoutes.post(
    `/${prefix}`,
    requireMembershipRole('admin', 'contributor'),
    zValidator('json', createSchema),
    async (c) => {
      const data = c.req.valid('json')
      const { projectId } = c.get('scopedUser')!
      const item = await createResource(table, { ...data, projectId })
      return c.json({ item }, 201)
    }
  )

  resourceRoutes.get(`/${prefix}/:id`, requireProjectAccess(), async (c) => {
    const { projectId } = c.get('scopedUser')!
    const id = Number(c.req.param('id'))
    const item = await getResourceById(table, id, projectId)

    if (!item) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', `${prefix} item not found`)
    }

    return c.json({ item })
  })

  resourceRoutes.post(
    `/${prefix}/:id/upload`,
    requireMembershipRole('admin', 'contributor'),
    async (c) => {
      const { projectId } = c.get('scopedUser')!
      const id = Number(c.req.param('id'))
      const item = await getResourceById(table, id, projectId)

      if (!item) {
        return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', `${prefix} item not found`)
      }

      const sizeGuardResponse = enforceMultipartSizeLimit(c)
      if (sizeGuardResponse) return sizeGuardResponse

      const body = await c.req.parseBody()
      const file = body['file']

      if (!(file instanceof File)) {
        return dashboardError(c, 400, 'VALIDATION_ERROR', 'file field is required')
      }

      try {
        const result = await uploadResourceFile(table, id, projectId, prefix, file)
        return c.json(result)
      } catch (err) {
        if (err instanceof UploadTooLargeError) {
          return c.json(
            {
              error: {
                code: 'PAYLOAD_TOO_LARGE',
                message: `File size (${err.size} bytes) exceeds the direct-upload limit (${err.limit} bytes). Use the chunked upload endpoint (POST /api/v1/dashboard/resources/upload/initiate) for larger files.`,
              },
            },
            413
          )
        }
        throw err
      }
    }
  )

  resourceRoutes.delete(
    `/${prefix}/:id`,
    requireMembershipRole('admin', 'contributor'),
    async (c) => {
      const { projectId } = c.get('scopedUser')!
      const id = Number(c.req.param('id'))
      if (!Number.isInteger(id) || id <= 0) {
        return dashboardError(c, 400, 'VALIDATION_ERROR', `Invalid ${prefix} id`)
      }
      try {
        const deleted = await deleteResource(table, id, projectId, prefix)
        if (!deleted) {
          return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', `${prefix} item not found`)
        }
        return c.body(null, 204)
      } catch (err) {
        if (err instanceof ResourceInUseError) {
          return dashboardError(c, 409, 'RESOURCE_IN_USE', err.message)
        }
        throw err
      }
    }
  )

  resourceRoutes.get(`/${prefix}/:id/download`, requireProjectAccess(), async (c) => {
    const { projectId } = c.get('scopedUser')!
    const id = Number(c.req.param('id'))
    const item = await getResourceById(table, id, projectId)

    if (!item) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', `${prefix} item not found`)
    }

    const fileRef = (item as Record<string, unknown>)['fileRef'] as {
      bucket?: string
      key?: string
      name?: string
    } | null
    if (!fileRef?.bucket || !fileRef?.key) {
      return dashboardError(c, 400, 'VALIDATION_ERROR', `${prefix} item has no uploaded file`)
    }

    const url = await getResourcePresignedUrl({
      bucket: fileRef.bucket,
      key: fileRef.key,
      ...(fileRef.name ? { name: fileRef.name } : {}),
    })
    return c.json({ url })
  })
}

createResourceRoutes('wordlists', wordLists)
createResourceRoutes('rulelists', ruleLists)
createResourceRoutes('masklists', maskLists)

// ─── Chunked Upload (S3 Multipart) ──────────────────────────────────
// These endpoints do NOT use zValidator for the body on PUT because
// the request body is raw binary data (not JSON). Body-parsing
// middleware would consume the stream before we can forward it to S3.

const initiateUploadSchema = z.object({
  resourceType: z.enum(['hash-lists', 'wordlists', 'rulelists', 'masklists']),
  name: z.string().min(1).max(255),
  fileSize: z.number().int().positive().max(500_000_000_000),
  contentType: z.string().optional(),
})

resourceRoutes.post(
  '/upload/initiate',
  requireMembershipRole('admin', 'contributor'),
  zValidator('json', initiateUploadSchema),
  async (c) => {
    const data = c.req.valid('json')
    const { projectId } = c.get('scopedUser')!

    try {
      const result = await initiateChunkedUpload({ ...data, projectId })
      return c.json(result, 201)
    } catch (err) {
      logger.error({ err }, 'Failed to initiate chunked upload')
      return dashboardError(c, 500, 'UPLOAD_INIT_FAILED', 'Failed to initiate upload')
    }
  }
)

resourceRoutes.put(
  '/upload/:uploadId/part/:partNumber',
  requireMembershipRole('admin', 'contributor'),
  async (c) => {
    const uploadId = c.req.param('uploadId')
    const partNumber = Number(c.req.param('partNumber'))
    const resourceId = Number(c.req.query('resourceId'))
    const resourceType = c.req.query('resourceType')

    if (!uploadId || !partNumber || !resourceId || !resourceType) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'uploadId, partNumber, resourceId, and resourceType are required',
          },
        },
        400
      )
    }

    // Read the raw body as a Uint8Array — do NOT use c.req.json() or c.req.parseBody()
    const body = await c.req.arrayBuffer()
    const chunk = new Uint8Array(body)

    if (chunk.byteLength === 0) {
      return dashboardError(c, 400, 'VALIDATION_ERROR', 'Request body is empty')
    }

    const { projectId } = c.get('scopedUser')!

    try {
      const result = await uploadChunkPart(
        uploadId,
        partNumber,
        chunk,
        resourceId,
        resourceType,
        projectId
      )
      return c.json(result)
    } catch (err) {
      logger.error({ err, uploadId, partNumber }, 'Failed to upload part')
      return dashboardError(c, 500, 'UPLOAD_PART_FAILED', 'Failed to upload part')
    }
  }
)

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
})

resourceRoutes.post(
  '/upload/:uploadId/complete',
  requireMembershipRole('admin', 'contributor'),
  zValidator('json', completeUploadSchema),
  async (c) => {
    const uploadId = c.req.param('uploadId')
    const { parts, resourceId, resourceType } = c.req.valid('json')
    const { projectId } = c.get('scopedUser')!

    try {
      const result = await completeChunkedUpload(
        uploadId,
        parts,
        resourceId,
        resourceType,
        projectId
      )
      return c.json(result)
    } catch (err) {
      logger.error({ err, uploadId }, 'Failed to complete chunked upload')
      return dashboardError(c, 500, 'UPLOAD_COMPLETE_FAILED', 'Failed to complete upload')
    }
  }
)

resourceRoutes.delete(
  '/upload/:uploadId',
  requireMembershipRole('admin', 'contributor'),
  async (c) => {
    const uploadId = c.req.param('uploadId')
    if (!uploadId) {
      return dashboardError(c, 400, 'VALIDATION_ERROR', 'uploadId is required')
    }
    const parsed = uploadStatusQuerySchema.safeParse({
      resourceId: c.req.query('resourceId'),
      resourceType: c.req.query('resourceType'),
    })
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((i) => i.message).join('; '),
          },
        },
        400
      )
    }
    const { resourceId, resourceType } = parsed.data

    const { projectId } = c.get('scopedUser')!

    await abortChunkedUpload(uploadId, resourceId, resourceType, projectId)
    return c.json({ acknowledged: true })
  }
)

resourceRoutes.get(
  '/upload/:uploadId/status',
  requireMembershipRole('admin', 'contributor'),
  async (c) => {
    const uploadId = c.req.param('uploadId')
    if (!uploadId) {
      return dashboardError(c, 400, 'VALIDATION_ERROR', 'uploadId is required')
    }
    const parsed = uploadStatusQuerySchema.safeParse({
      resourceId: c.req.query('resourceId'),
      resourceType: c.req.query('resourceType'),
    })
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((i) => i.message).join('; '),
          },
        },
        400
      )
    }
    const { resourceId, resourceType } = parsed.data

    const { projectId } = c.get('scopedUser')!

    const result = await getChunkedUploadStatus(uploadId, resourceId, resourceType, projectId)
    if (!result) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Upload not found')
    }

    return c.json({ uploadId, ...result })
  }
)

export { resourceRoutes }
