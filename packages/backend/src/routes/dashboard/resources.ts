import {
  createHashListRequestSchema,
  detectHashTypeRequestSchema,
  maskLists,
  ruleLists,
  wordLists,
} from '@hashhive/shared'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireMembershipRole, requireProjectAccess } from '../../middleware/rbac.js'
import {
  DASHBOARD_RESPONSE_REFS,
  sharedResponse,
  dashboardOpenApiHonoOptions,
} from '../../openapi/components.js'
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

// ─── OpenAPI helpers ────────────────────────────────────────────────

// Generic passthrough schema for response shapes that don't have a
// corresponding shared Zod schema yet. The U4 diff script surfaces
// these as gaps later — for now they keep the spec parseable without
// inventing precise types that may drift from the service layer.
const passthroughObject = (name: string) => z.object({}).passthrough().openapi(name)

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const uploadIdParamSchema = z.object({
  uploadId: z.string().min(1),
})

const uploadPartParamSchema = z.object({
  uploadId: z.string().min(1),
  partNumber: z.coerce.number().int().positive(),
})

const tags: string[] = ['Dashboard/Resources']
const security = [{ SessionCookie: [] }]

const resourceRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

resourceRoutes.use('*', requireSession)

// ─── Hash Types ──────────────────────────────────────────────────────

const listHashTypesRoute = createRoute({
  method: 'get',
  path: '/hash-types',
  tags,
  summary: 'List supported hashcat hash type definitions',
  security,
  responses: {
    200: {
      description: 'Hash type list',
      content: {
        'application/json': {
          schema: z.object({ hashTypes: z.array(z.unknown()) }),
        },
      },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
  },
})

resourceRoutes.openapi(listHashTypesRoute, async (c) => {
  const hashTypes = await listHashTypes()
  return c.json({ hashTypes }, 200)
})

// ─── Hash Lists ─────────────────────────────────────────────────────

const listHashListsRoute = createRoute({
  method: 'get',
  path: '/hash-lists',
  tags,
  summary: 'List hash lists in the active project',
  security,
  middleware: [requireProjectAccess()] as const,
  responses: {
    200: {
      description: 'Hash list collection',
      content: {
        'application/json': {
          schema: z.object({ hashLists: z.array(z.unknown()) }),
        },
      },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  },
})

resourceRoutes.openapi(listHashListsRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!

  const hashLists = await listHashLists(projectId)
  return c.json({ hashLists }, 200)
})

// createHashListRequestSchema is imported from @hashhive/shared.

// Content-type-aware route. Multipart -> one-shot create+upload+enqueue
// flow (returns 202 with status='processing'). JSON -> legacy create-empty
// flow that the caller follows with separate /upload + /import requests
// (still in use by the CLI and older frontend code paths).
// We cannot apply zValidator at registration because the validator binds
// per content-type; instead we dispatch inside the handler.
const createHashListRoute = createRoute({
  method: 'post',
  path: '/hash-lists',
  tags,
  summary: 'Create a hash list (JSON empty-create or multipart one-shot upload)',
  security,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  // No body schema at route level. This endpoint dispatches by
  // content-type inside the handler and each branch runs its own
  // validation: the multipart branch needs an upfront content-length
  // guard BEFORE buffering (enforceMultipartSizeLimit returns 413), and
  // the JSON branch needs graceful malformed-body handling via
  // `safeParse(await c.req.json().catch(() => null))` so a syntax error
  // returns the dashboard VALIDATION_ERROR envelope rather than the
  // framework's default parse-failure path. The spec still gets the
  // declarative descriptions on responses; body shape lives in the
  // handler's dispatch logic.
  request: {},
  responses: {
    201: {
      description: 'Hash list created (legacy JSON path)',
      content: {
        'application/json': {
          schema: z.object({ hashList: z.unknown() }),
        },
      },
    },
    202: {
      description: 'Hash list created and queued for processing (multipart path)',
      content: {
        'application/json': {
          schema: z.object({ hashList: z.unknown() }),
        },
      },
    },
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    411: {
      description: 'Length Required (chunked transfer-encoding rejected)',
      content: { 'application/json': { schema: passthroughObject('LengthRequiredError') } },
    },
    413: {
      description: 'Payload Too Large',
      content: { 'application/json': { schema: passthroughObject('PayloadTooLargeError') } },
    },
    503: {
      description: 'Storage or queue unavailable',
      content: { 'application/json': { schema: passthroughObject('ServiceUnavailableError') } },
    },
  },
})

resourceRoutes.openapi(createHashListRoute, async (c) => {
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

const getHashListRoute = createRoute({
  method: 'get',
  path: '/hash-lists/{id}',
  tags,
  summary: 'Get a hash list with live statistics',
  security,
  middleware: [requireProjectAccess()] as const,
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Hash list',
      content: {
        'application/json': {
          schema: z.object({ hashList: z.unknown() }),
        },
      },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

resourceRoutes.openapi(getHashListRoute, async (c) => {
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

  return c.json(
    {
      hashList: {
        ...hl,
        statistics: {
          ...liveStats,
          ...(lastUpdated ? { lastUpdated } : {}),
        },
      },
    },
    200
  )
})

const deleteHashListRoute = createRoute({
  method: 'delete',
  path: '/hash-lists/{id}',
  tags,
  summary: 'Delete a hash list',
  security,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: { params: idParamSchema },
  responses: {
    204: { description: 'Hash list deleted' },
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'Resource in use and cannot be deleted',
      content: { 'application/json': { schema: passthroughObject('ResourceInUseError') } },
    },
  },
})

resourceRoutes.openapi(deleteHashListRoute, async (c) => {
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
})

const uploadHashListRoute = createRoute({
  method: 'post',
  path: '/hash-lists/{id}/upload',
  tags,
  summary: 'Upload the hashes file for an existing hash list',
  security,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: idParamSchema,
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({ file: z.unknown() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Upload accepted',
      content: { 'application/json': { schema: passthroughObject('HashListUploadResult') } },
    },
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    411: {
      description: 'Length Required (chunked transfer-encoding rejected)',
      content: { 'application/json': { schema: passthroughObject('LengthRequiredError') } },
    },
    413: {
      description: 'Payload Too Large',
      content: { 'application/json': { schema: passthroughObject('PayloadTooLargeError') } },
    },
  },
})

resourceRoutes.openapi(uploadHashListRoute, async (c) => {
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
    return c.json(result, 200)
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

const importHashListRoute = createRoute({
  method: 'post',
  path: '/hash-lists/{id}/import',
  tags,
  summary: 'Enqueue the import worker for an uploaded hash list',
  security,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Import queued',
      content: { 'application/json': { schema: passthroughObject('HashListImportResult') } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    503: {
      description: 'Import queue unavailable',
      content: { 'application/json': { schema: passthroughObject('ServiceUnavailableError') } },
    },
  },
})

resourceRoutes.openapi(importHashListRoute, async (c) => {
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

  return c.json(result, 200)
})

const hashItemsQuerySchema = z.object({
  status: z.enum(['all', 'cracked', 'uncracked']).optional(),
  q: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

const listHashItemsRoute = createRoute({
  method: 'get',
  path: '/hash-lists/{id}/items',
  tags,
  summary: 'List individual hash items for a hash list',
  security,
  middleware: [requireProjectAccess()] as const,
  request: {
    params: idParamSchema,
    query: hashItemsQuerySchema,
  },
  responses: {
    200: {
      description: 'Hash items page',
      content: { 'application/json': { schema: passthroughObject('HashItemsPage') } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

resourceRoutes.openapi(listHashItemsRoute, async (c) => {
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

  return c.json(result, 200)
})

const downloadHashListRoute = createRoute({
  method: 'get',
  path: '/hash-lists/{id}/download',
  tags,
  summary: 'Get a presigned download URL for a hash list file',
  security,
  middleware: [requireProjectAccess()] as const,
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Presigned URL',
      content: {
        'application/json': {
          schema: z.object({ url: z.string() }),
        },
      },
    },
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

resourceRoutes.openapi(downloadHashListRoute, async (c) => {
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
  return c.json({ url }, 200)
})

// ─── Hash Type Detection ─────────────────────────────────────────────

// detectHashTypeRequestSchema is imported from @hashhive/shared.

const detectHashTypeRoute = createRoute({
  method: 'post',
  path: '/detect-hash-type',
  tags,
  summary: 'Heuristically guess hashcat hash types for a batch of values',
  security,
  // requireSession is already mounted at router level via `use('*')`;
  // the original route added it a second time, which was a no-op.
  request: {
    body: {
      content: {
        'application/json': { schema: detectHashTypeRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Hash type detection results',
      content: {
        'application/json': {
          schema: z.object({
            results: z.array(z.unknown()),
          }),
        },
      },
    },
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
  },
})

resourceRoutes.openapi(detectHashTypeRoute, async (c) => {
  const { hashes } = c.req.valid('json')

  const results = hashes.map((hashValue) => ({
    hashValue,
    candidates: guessHashType(hashValue),
  }))

  return c.json({ results }, 200)
})

// ─── Generic resource routes factory ────────────────────────────────

function createResourceRoutes(prefix: string, table: ResourceTable) {
  const createSchema = z.object({
    name: z.string().min(1).max(255),
  })

  const listResourceRoute = createRoute({
    method: 'get',
    path: `/${prefix}`,
    tags,
    summary: `List ${prefix} for the active project`,
    security,
    middleware: [requireProjectAccess()] as const,
    responses: {
      200: {
        description: `${prefix} collection`,
        content: { 'application/json': { schema: passthroughObject(`${prefix}ListResponse`) } },
      },
      401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
      403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    },
  })

  resourceRoutes.openapi(listResourceRoute, async (c) => {
    const { projectId } = c.get('scopedUser')!

    const items = await listResources(table, projectId)
    return c.json({ [prefix]: items }, 200)
  })

  const createResourceRoute = createRoute({
    method: 'post',
    path: `/${prefix}`,
    tags,
    summary: `Create a ${prefix} entry`,
    security,
    middleware: [requireMembershipRole('admin', 'contributor')] as const,
    request: {
      body: {
        content: {
          'application/json': { schema: createSchema },
        },
      },
    },
    responses: {
      201: {
        description: 'Created',
        content: { 'application/json': { schema: z.object({ item: z.unknown() }) } },
      },
      400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
      401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
      403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    },
  })

  resourceRoutes.openapi(createResourceRoute, async (c) => {
    const data = c.req.valid('json')
    const { projectId } = c.get('scopedUser')!
    const item = await createResource(table, { ...data, projectId })
    return c.json({ item }, 201)
  })

  const getResourceRoute = createRoute({
    method: 'get',
    path: `/${prefix}/{id}`,
    tags,
    summary: `Get a ${prefix} entry by id`,
    security,
    middleware: [requireProjectAccess()] as const,
    request: { params: idParamSchema },
    responses: {
      200: {
        description: 'Resource',
        content: { 'application/json': { schema: z.object({ item: z.unknown() }) } },
      },
      401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
      403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
      404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    },
  })

  resourceRoutes.openapi(getResourceRoute, async (c) => {
    const { projectId } = c.get('scopedUser')!
    const id = Number(c.req.param('id'))
    const item = await getResourceById(table, id, projectId)

    if (!item) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', `${prefix} item not found`)
    }

    return c.json({ item }, 200)
  })

  const uploadResourceRoute = createRoute({
    method: 'post',
    path: `/${prefix}/{id}/upload`,
    tags,
    summary: `Upload the file payload for a ${prefix} entry`,
    security,
    middleware: [requireMembershipRole('admin', 'contributor')] as const,
    request: {
      params: idParamSchema,
      body: {
        content: {
          'multipart/form-data': {
            schema: z.object({ file: z.unknown() }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Upload accepted',
        content: {
          'application/json': { schema: passthroughObject(`${prefix}UploadResult`) },
        },
      },
      400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
      401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
      403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
      404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
      411: {
        description: 'Length Required (chunked transfer-encoding rejected)',
        content: { 'application/json': { schema: passthroughObject('LengthRequiredError') } },
      },
      413: {
        description: 'Payload Too Large',
        content: { 'application/json': { schema: passthroughObject('PayloadTooLargeError') } },
      },
    },
  })

  resourceRoutes.openapi(uploadResourceRoute, async (c) => {
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
      return c.json(result, 200)
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

  const deleteResourceRoute = createRoute({
    method: 'delete',
    path: `/${prefix}/{id}`,
    tags,
    summary: `Delete a ${prefix} entry`,
    security,
    middleware: [requireMembershipRole('admin', 'contributor')] as const,
    request: { params: idParamSchema },
    responses: {
      204: { description: 'Deleted' },
      400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
      401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
      403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
      404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
      409: {
        description: 'Resource in use',
        content: { 'application/json': { schema: passthroughObject('ResourceInUseError') } },
      },
    },
  })

  resourceRoutes.openapi(deleteResourceRoute, async (c) => {
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
  })

  const downloadResourceRoute = createRoute({
    method: 'get',
    path: `/${prefix}/{id}/download`,
    tags,
    summary: `Get a presigned download URL for a ${prefix} entry`,
    security,
    middleware: [requireProjectAccess()] as const,
    request: { params: idParamSchema },
    responses: {
      200: {
        description: 'Presigned URL',
        content: { 'application/json': { schema: z.object({ url: z.string() }) } },
      },
      400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
      401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
      403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
      404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    },
  })

  resourceRoutes.openapi(downloadResourceRoute, async (c) => {
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
    return c.json({ url }, 200)
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

const initiateUploadRoute = createRoute({
  method: 'post',
  path: '/upload/initiate',
  tags,
  summary: 'Initiate an S3 multipart chunked upload session',
  security,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    body: {
      content: {
        'application/json': { schema: initiateUploadSchema },
      },
    },
  },
  responses: {
    201: {
      description: 'Upload session initiated',
      content: { 'application/json': { schema: passthroughObject('UploadInitiateResult') } },
    },
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    500: {
      description: 'Upload initiation failed',
      content: { 'application/json': { schema: passthroughObject('UploadInitFailedError') } },
    },
  },
})

resourceRoutes.openapi(initiateUploadRoute, async (c) => {
  const data = c.req.valid('json')
  const { projectId } = c.get('scopedUser')!

  try {
    const result = await initiateChunkedUpload({ ...data, projectId })
    return c.json(result, 201)
  } catch (err) {
    logger.error({ err }, 'Failed to initiate chunked upload')
    return dashboardError(c, 500, 'UPLOAD_INIT_FAILED', 'Failed to initiate upload')
  }
})

const uploadPartQuerySchema = z.object({
  resourceId: z.coerce.number().int().positive(),
  resourceType: z.enum(RESOURCE_TYPES),
})

const uploadPartRoute = createRoute({
  method: 'put',
  path: '/upload/{uploadId}/part/{partNumber}',
  tags,
  summary: 'Upload a single chunk part for a multipart upload session',
  security,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: uploadPartParamSchema,
    query: uploadPartQuerySchema,
    body: {
      content: {
        'application/octet-stream': { schema: z.unknown() },
      },
    },
  },
  responses: {
    200: {
      description: 'Part uploaded',
      content: { 'application/json': { schema: passthroughObject('UploadPartResult') } },
    },
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    500: {
      description: 'Upload part failed',
      content: { 'application/json': { schema: passthroughObject('UploadPartFailedError') } },
    },
  },
})

resourceRoutes.openapi(uploadPartRoute, async (c) => {
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
    return c.json(result, 200)
  } catch (err) {
    logger.error({ err, uploadId, partNumber }, 'Failed to upload part')
    return dashboardError(c, 500, 'UPLOAD_PART_FAILED', 'Failed to upload part')
  }
})

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

const completeUploadRoute = createRoute({
  method: 'post',
  path: '/upload/{uploadId}/complete',
  tags,
  summary: 'Complete a multipart upload session',
  security,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: uploadIdParamSchema,
    body: {
      content: {
        'application/json': { schema: completeUploadSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Upload completed',
      content: { 'application/json': { schema: passthroughObject('UploadCompleteResult') } },
    },
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    500: {
      description: 'Upload completion failed',
      content: { 'application/json': { schema: passthroughObject('UploadCompleteFailedError') } },
    },
  },
})

resourceRoutes.openapi(completeUploadRoute, async (c) => {
  const uploadId = c.req.param('uploadId')
  const { parts, resourceId, resourceType } = c.req.valid('json')
  const { projectId } = c.get('scopedUser')!

  try {
    const result = await completeChunkedUpload(uploadId, parts, resourceId, resourceType, projectId)
    return c.json(result, 200)
  } catch (err) {
    logger.error({ err, uploadId }, 'Failed to complete chunked upload')
    return dashboardError(c, 500, 'UPLOAD_COMPLETE_FAILED', 'Failed to complete upload')
  }
})

const abortUploadRoute = createRoute({
  method: 'delete',
  path: '/upload/{uploadId}',
  tags,
  summary: 'Abort an in-progress multipart upload session',
  security,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: uploadIdParamSchema,
    query: uploadStatusQuerySchema,
  },
  responses: {
    200: {
      description: 'Abort acknowledged',
      content: { 'application/json': { schema: z.object({ acknowledged: z.boolean() }) } },
    },
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  },
})

resourceRoutes.openapi(abortUploadRoute, async (c) => {
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
  return c.json({ acknowledged: true }, 200)
})

const uploadStatusRoute = createRoute({
  method: 'get',
  path: '/upload/{uploadId}/status',
  tags,
  summary: 'Get the status of an in-progress multipart upload session',
  security,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: uploadIdParamSchema,
    query: uploadStatusQuerySchema,
  },
  responses: {
    200: {
      description: 'Upload status',
      content: { 'application/json': { schema: passthroughObject('UploadStatusResult') } },
    },
    400: sharedResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

resourceRoutes.openapi(uploadStatusRoute, async (c) => {
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

  return c.json({ uploadId, ...result }, 200)
})

export { resourceRoutes }
