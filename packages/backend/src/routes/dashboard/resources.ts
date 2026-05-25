import {
  createHashListRequestSchema,
  detectHashTypeRequestSchema,
  maskLists,
  ruleLists,
  wordLists,
} from '@hashhive/shared'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess, requireRole } from '../../middleware/rbac.js'
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

const resourceRoutes = new Hono<AppEnv>()

resourceRoutes.use('*', requireSession)

// ─── Hash Types ──────────────────────────────────────────────────────

resourceRoutes.get('/hash-types', async (c) => {
  const hashTypes = await listHashTypes()
  return c.json({ hashTypes })
})

// ─── Hash Lists ─────────────────────────────────────────────────────

resourceRoutes.get('/hash-lists', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('currentUser')
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400)
  }

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
resourceRoutes.post('/hash-lists', requireRole('admin', 'contributor'), async (c) => {
  const { projectId } = c.get('currentUser')
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400)
  }

  const contentType = c.req.header('content-type') ?? ''

  // ─── Multipart one-shot upload (ticket AC #1) ──────────────────────
  if (contentType.startsWith('multipart/form-data')) {
    // Reject oversize multipart payloads BEFORE parseBody buffers them.
    // Without this guard, an authenticated admin/contributor could OOM
    // the backend with a multi-GB body.
    //
    // Defense:
    //   1. Reject `Transfer-Encoding: chunked` outright (411). chunked
    //      omits Content-Length, so the size guard below couldn't
    //      enforce a cap and the body would buffer unbounded into
    //      parseBody. Callers with files of unknown size must use the
    //      streaming chunked-upload endpoint at `/upload/initiate`.
    //   2. Reject when declared Content-Length exceeds the cap.
    //   3. Backstop: `uploadHashListFile` still enforces the byte cap
    //      via `UploadTooLargeError` after parseBody.
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'file field is required' } }, 400)
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
      return c.json(
        { error: { code: 'STORAGE_UNAVAILABLE', message: 'Failed to create hash list' } },
        503
      )
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
      return c.json(
        { error: { code: 'STORAGE_UNAVAILABLE', message: 'Failed to upload file' } },
        503
      )
    }

    // Enqueue parsing. If the queue is down we leave the row in `uploaded`
    // status (the user can retry via POST /:id/import) and surface a 503.
    const importResult = await importHashList(created.id, projectId)
    if (!importResult) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404)
    }
    if ('error' in importResult) {
      return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: importResult.error } }, 503)
    }

    // Re-read so the response carries `status=processing` and the fresh fileRef.
    const finalRow = await getHashListById(created.id, projectId)
    return c.json({ hashList: finalRow }, 202)
  }

  // ─── Legacy JSON create-empty path ─────────────────────────────────
  const parsed = createHashListRequestSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } }, 400)
  }
  const hashList = await createHashList({ ...parsed.data, projectId })
  return c.json({ hashList }, 201)
})

resourceRoutes.get('/hash-lists/:id', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('currentUser')
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400)
  }

  const hashListId = Number(c.req.param('id'))
  const hl = await getHashListById(hashListId, projectId)

  if (!hl) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404)
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

resourceRoutes.delete('/hash-lists/:id', requireRole('admin', 'contributor'), async (c) => {
  const { projectId } = c.get('currentUser')
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400)
  }

  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid hash list id' } }, 400)
  }

  try {
    const deleted = await deleteHashList(id, projectId)
    if (!deleted) {
      return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404)
    }
    return c.body(null, 204)
  } catch (err) {
    if (err instanceof ResourceInUseError) {
      return c.json({ error: { code: 'RESOURCE_IN_USE', message: err.message } }, 409)
    }
    throw err
  }
})

resourceRoutes.post('/hash-lists/:id/upload', requireRole('admin', 'contributor'), async (c) => {
  const { projectId } = c.get('currentUser')
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400)
  }

  const id = Number(c.req.param('id'))
  const hashList = await getHashListById(id, projectId)

  if (!hashList) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404)
  }

  const body = await c.req.parseBody()
  const file = body['file']

  if (!(file instanceof File)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'file field is required' } }, 400)
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
})

resourceRoutes.post('/hash-lists/:id/import', requireRole('admin', 'contributor'), async (c) => {
  const { projectId } = c.get('currentUser')
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400)
  }

  const id = Number(c.req.param('id'))

  // Verify hash list belongs to project before importing
  const hl = await getHashListById(id, projectId)
  if (!hl) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404)
  }

  const result = await importHashList(id, projectId)

  if (!result) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404)
  }

  if ('error' in result) {
    return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: result.error } }, 503)
  }

  return c.json(result)
})

resourceRoutes.get('/hash-lists/:id/items', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('currentUser')
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400)
  }

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
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404)
  }

  return c.json(result)
})

resourceRoutes.get('/hash-lists/:id/download', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('currentUser')
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400)
  }

  const id = Number(c.req.param('id'))
  const hashList = await getHashListById(id, projectId)

  if (!hashList) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Hash list not found' } }, 404)
  }

  const fileRef = hashList.fileRef as { bucket?: string; key?: string; name?: string } | null
  if (!fileRef?.bucket || !fileRef?.key) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'Hash list has no uploaded file' } },
      400
    )
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
    const { projectId } = c.get('currentUser')
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      )
    }

    const items = await listResources(table, projectId)
    return c.json({ [prefix]: items })
  })

  resourceRoutes.post(
    `/${prefix}`,
    requireRole('admin', 'contributor'),
    zValidator('json', createSchema),
    async (c) => {
      const data = c.req.valid('json')
      const { projectId } = c.get('currentUser')
      if (!projectId) {
        return c.json(
          { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
          400
        )
      }
      const item = await createResource(table, { ...data, projectId })
      return c.json({ item }, 201)
    }
  )

  resourceRoutes.get(`/${prefix}/:id`, requireProjectAccess(), async (c) => {
    const { projectId } = c.get('currentUser')
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      )
    }
    const id = Number(c.req.param('id'))
    const item = await getResourceById(table, id, projectId)

    if (!item) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: `${prefix} item not found` } },
        404
      )
    }

    return c.json({ item })
  })

  resourceRoutes.post(`/${prefix}/:id/upload`, requireRole('admin', 'contributor'), async (c) => {
    const { projectId } = c.get('currentUser')
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      )
    }
    const id = Number(c.req.param('id'))
    const item = await getResourceById(table, id, projectId)

    if (!item) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: `${prefix} item not found` } },
        404
      )
    }

    const body = await c.req.parseBody()
    const file = body['file']

    if (!(file instanceof File)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'file field is required' } }, 400)
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
  })

  resourceRoutes.delete(`/${prefix}/:id`, requireRole('admin', 'contributor'), async (c) => {
    const { projectId } = c.get('currentUser')
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      )
    }
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: `Invalid ${prefix} id` } }, 400)
    }
    try {
      const deleted = await deleteResource(table, id, projectId, prefix)
      if (!deleted) {
        return c.json(
          { error: { code: 'RESOURCE_NOT_FOUND', message: `${prefix} item not found` } },
          404
        )
      }
      return c.body(null, 204)
    } catch (err) {
      if (err instanceof ResourceInUseError) {
        return c.json({ error: { code: 'RESOURCE_IN_USE', message: err.message } }, 409)
      }
      throw err
    }
  })

  resourceRoutes.get(`/${prefix}/:id/download`, requireProjectAccess(), async (c) => {
    const { projectId } = c.get('currentUser')
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      )
    }
    const id = Number(c.req.param('id'))
    const item = await getResourceById(table, id, projectId)

    if (!item) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: `${prefix} item not found` } },
        404
      )
    }

    const fileRef = (item as Record<string, unknown>)['fileRef'] as {
      bucket?: string
      key?: string
      name?: string
    } | null
    if (!fileRef?.bucket || !fileRef?.key) {
      return c.json(
        { error: { code: 'VALIDATION_ERROR', message: `${prefix} item has no uploaded file` } },
        400
      )
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
  requireRole('admin', 'contributor'),
  zValidator('json', initiateUploadSchema),
  async (c) => {
    const data = c.req.valid('json')
    const { projectId } = c.get('currentUser')
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      )
    }

    try {
      const result = await initiateChunkedUpload({ ...data, projectId })
      return c.json(result, 201)
    } catch (err) {
      logger.error({ err }, 'Failed to initiate chunked upload')
      return c.json(
        { error: { code: 'UPLOAD_INIT_FAILED', message: 'Failed to initiate upload' } },
        500
      )
    }
  }
)

resourceRoutes.put(
  '/upload/:uploadId/part/:partNumber',
  requireRole('admin', 'contributor'),
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
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Request body is empty' } }, 400)
    }

    const { projectId } = c.get('currentUser')
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      )
    }

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
      return c.json(
        { error: { code: 'UPLOAD_PART_FAILED', message: 'Failed to upload part' } },
        500
      )
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
  requireRole('admin', 'contributor'),
  zValidator('json', completeUploadSchema),
  async (c) => {
    const uploadId = c.req.param('uploadId')
    const { parts, resourceId, resourceType } = c.req.valid('json')
    const { projectId } = c.get('currentUser')
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      )
    }

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
      return c.json(
        { error: { code: 'UPLOAD_COMPLETE_FAILED', message: 'Failed to complete upload' } },
        500
      )
    }
  }
)

resourceRoutes.delete('/upload/:uploadId', requireRole('admin', 'contributor'), async (c) => {
  const uploadId = c.req.param('uploadId')
  const resourceId = Number(c.req.query('resourceId'))
  const resourceType = c.req.query('resourceType')

  if (!uploadId || !resourceId || !resourceType) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'uploadId, resourceId, and resourceType are required',
        },
      },
      400
    )
  }

  const { projectId } = c.get('currentUser')
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400)
  }

  await abortChunkedUpload(uploadId, resourceId, resourceType, projectId)
  return c.json({ acknowledged: true })
})

resourceRoutes.get('/upload/:uploadId/status', requireRole('admin', 'contributor'), async (c) => {
  const uploadId = c.req.param('uploadId')
  const resourceId = Number(c.req.query('resourceId'))
  const resourceType = c.req.query('resourceType')

  if (!uploadId || !resourceId || !resourceType) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'uploadId, resourceId, and resourceType are required',
        },
      },
      400
    )
  }

  const { projectId } = c.get('currentUser')
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400)
  }

  const result = await getChunkedUploadStatus(uploadId, resourceId, resourceType, projectId)
  if (!result) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Upload not found' } }, 404)
  }

  return c.json({ uploadId, ...result })
})

export { resourceRoutes }
