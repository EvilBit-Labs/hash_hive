import {
  createHashListRequestSchema,
  detectHashTypeRequestSchema,
  hashListWireSchema,
  maskLists,
  ruleLists,
  setHashListTypeRequestSchema,
  wordLists,
} from '@hashhive/shared'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireMembershipRole, requireProjectAccess } from '../../middleware/rbac.js'
import { coercedIntegerQuery } from '../../openapi/coerced-query.js'
import {
  DASHBOARD_RESPONSE_REFS,
  sharedDashboardResponse,
  dashboardOpenApiHonoOptions,
} from '../../openapi/components.js'
import { guessHashType } from '../../services/hash-analysis.js'
import {
  createHashList,
  deleteHashList,
  getHashItems,
  getHashListById,
  getHashListStats,
  getResourcePresignedUrl,
  importHashList,
  isForeignKeyViolation,
  listHashLists,
  listHashTypes,
  ResourceInUseError,
  setHashListType,
  uploadHashListFile,
  UploadTooLargeError,
} from '../../services/resources.js'
import { registerHashListArchiveRoutes } from './resources-archive-routes.js'
import { registerChunkedUploadRoutes } from './resources-chunked-upload.js'
import { registerGenericResourceRoutes } from './resources-generic.js'
// `enforceMultipartSizeLimit`, `passthroughObject`, `idParamSchema`,
// `tags`, `security`, `showArchivedQuerySchema` and the chunked-upload
// query shape live in `./resources-shared.ts` so the generic-resource
// factory, archive-routes factory, and chunked-upload route modules can
// reuse them without re-creating an import cycle through this main
// router module.
import {
  enforceMultipartSizeLimit,
  idParamSchema,
  passthroughObject,
  security,
  showArchivedQuerySchema,
  tags,
} from './resources-shared.js'

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
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
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
  request: { query: showArchivedQuerySchema },
  responses: {
    200: {
      description: 'Hash list collection',
      content: {
        'application/json': {
          schema: z.object({ hashLists: z.array(z.unknown()) }),
        },
      },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  },
})

resourceRoutes.openapi(listHashListsRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { showArchived } = c.req.valid('query')

  const hashLists = await listHashLists(projectId, { showArchived })
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
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
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
  const { userId } = c.get('currentUser')
  const actor = { actorType: 'user' as const, actorId: userId }

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
    const created = await createHashList(
      {
        projectId,
        name: nameRaw,
        ...(hashTypeId !== undefined ? { hashTypeId } : {}),
      },
      actor
    )
    if (!created) {
      return dashboardError(c, 503, 'STORAGE_UNAVAILABLE', 'Failed to create hash list')
    }

    // Upload - rollback DB row on failure so the caller sees a clean error
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
  //
  // The `.catch` logs the underlying SyntaxError before swallowing it
  // so a flood of `'Invalid JSON body'` 400s in production carries
  // operator-actionable context (which body fields were unparseable
  // vs. which were missing). Mirrors the multipart branch's
  // `logger.warn` on parseBody failure above.
  const requestId = c.get('requestId')
  const parsedBody = await c.req.json().catch((err: unknown) => {
    logger.warn(
      { err, projectId, requestId },
      'Failed to parse JSON body for POST /hash-lists (legacy create-empty path)'
    )
    return null
  })
  const parsed = createHashListRequestSchema.safeParse(parsedBody)
  if (!parsed.success) {
    return dashboardError(c, 400, 'VALIDATION_ERROR', 'Invalid JSON body')
  }
  const hashList = await createHashList({ ...parsed.data, projectId }, actor)
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
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
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
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'Resource in use and cannot be deleted',
      content: { 'application/json': { schema: passthroughObject('ResourceInUseError') } },
    },
  },
})

resourceRoutes.openapi(deleteHashListRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { userId } = c.get('currentUser')
  const actor = { actorType: 'user' as const, actorId: userId }

  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return dashboardError(c, 400, 'VALIDATION_ERROR', 'Invalid hash list id')
  }

  try {
    const result = await deleteHashList(id, projectId, actor)
    switch (result.kind) {
      case 'not_found':
        return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Hash list not found')
      case 'not_deletable':
        // ADR-0019 / issue #106 U3: a hash list that has ever been
        // referenced by a campaign is permanent — archive-only.
        return dashboardError(
          c,
          409,
          'NOT_DELETABLE',
          'Hash list has been used by a campaign and is now permanent; it cannot be deleted, only archived.'
        )
      case 'deleted':
        return c.body(null, 204)
    }
  } catch (err) {
    if (err instanceof ResourceInUseError) {
      return dashboardError(c, 409, 'RESOURCE_IN_USE', err.message)
    }
    throw err
  }
})

// ─── PATCH /hash-lists/{id} - set hash type (issue #163) ────────────
//
// Used by the detect-hash-type modal's "Use This Type" action. Body
// carries only `hashTypeId`; the project scope is derived from the
// authenticated session, never trusted from the request body. The
// service layer matches on `(id, projectId)` and returns null on miss
// so a cross-project ID lookup is indistinguishable from a deleted
// row at the HTTP layer (404 without existence disclosure).

const setHashListTypeRoute = createRoute({
  method: 'patch',
  path: '/hash-lists/{id}',
  tags,
  summary: 'Set the hash type on an existing hash list',
  description:
    "Updates the hash list's `hashTypeId`. Project ownership is enforced server-side from the session; cross-project IDs return 404.",
  security,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: idParamSchema,
    body: {
      content: {
        'application/json': { schema: setHashListTypeRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: 'Updated hash list',
      content: {
        'application/json': {
          schema: z.object({ hashList: hashListWireSchema }),
        },
      },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

resourceRoutes.openapi(setHashListTypeRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { userId } = c.get('currentUser')
  const actor = { actorType: 'user' as const, actorId: userId }

  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    return dashboardError(c, 400, 'VALIDATION_ERROR', 'Invalid hash list id')
  }

  const { hashTypeId } = c.req.valid('json')

  try {
    const updated = await setHashListType(id, projectId, hashTypeId, actor)
    if (!updated) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Hash list not found')
    }
    // Project the DB row into the wire shape so the response matches
    // the OpenAPI declaration (hashListWireSchema) the frontend types
    // off of. DB-only fields (source, statistics, updatedAt) stay
    // server-side.
    const wire = hashListWireSchema.parse({
      id: updated.id,
      name: updated.name,
      projectId: updated.projectId,
      hashTypeId: updated.hashTypeId,
      status: updated.status,
      fileRef: updated.fileRef ?? null,
      createdAt: updated.createdAt.toISOString(),
    })
    return c.json({ hashList: wire }, 200)
  } catch (err) {
    // FK violation on hash_type_id → unknown hash type. Map to 400
    // rather than letting it bubble as a 500 - the client supplied a
    // bad value, not a server fault. The route only updates
    // hash_type_id, so the only FK that can violate here is
    // hash_lists.hash_type_id → hash_types.id (the constraint name
    // is verified inside the helper).
    if (isForeignKeyViolation(err, 'hash_lists_hash_type_id_hash_types_id_fk')) {
      return dashboardError(c, 400, 'VALIDATION_ERROR', 'Unknown hashTypeId')
    }
    // Non-FK errors: log with route context before rethrow so the
    // generic 500 envelope from Hono's default handler isn't a black
    // hole for ops triage. Matches the pattern used by the upload
    // route's logger.error above.
    logger.error({ hashListId: id, projectId, hashTypeId, err }, 'setHashListType failed')
    throw err
  }
})

const uploadHashListRoute = createRoute({
  method: 'post',
  path: '/hash-lists/{id}/upload',
  tags,
  summary: 'Upload the hashes file for an existing hash list',
  description:
    'Multipart body (`file` field) is intentionally NOT declared on the route. createRoute validates the request body BEFORE the handler runs, which would parseBody and buffer the entire upload before `enforceMultipartSizeLimit(c)` can reject oversize Content-Length headers with 413 / chunked transfer-encoding with 411. The handler enforces field presence after the size guard.',
  security,
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: idParamSchema,
  },
  responses: {
    200: {
      description: 'Upload accepted',
      content: { 'application/json': { schema: passthroughObject('HashListUploadResult') } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
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
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
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

// Permissive at the boundary so a malformed `?limit=abc` doesn't 400 -
// `.catch(default)` swaps in the default on coercion/range failure, which
// keeps NaN/Infinity out of Drizzle's `.limit()`/`.offset()`. Matches the
// pattern used on `listResultsQuerySchema` elsewhere on the dashboard.
const hashItemsQuerySchema = z.object({
  status: z.enum(['all', 'cracked', 'uncracked']).optional(),
  q: z.string().max(256).optional(),
  limit: coercedIntegerQuery({ min: 1, max: 100, default: 50 }),
  offset: coercedIntegerQuery({ min: 0, default: 0 }),
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
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
})

resourceRoutes.openapi(listHashItemsRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { id: hashListId } = c.req.valid('param')
  const { status, q, limit, offset } = c.req.valid('query')

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
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
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
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
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

// ─── Sub-router registrations ──────────────────────────────────────
//
// The wordlists/rulelists/masklists generic factory and the S3
// multipart chunked-upload session routes live in their own files to
// keep this module under the 800-line cap. They register against the
// same `resourceRoutes` router so URL paths and middleware composition
// stay identical to the single-file form.

registerGenericResourceRoutes(resourceRoutes, 'wordlists', wordLists)
registerGenericResourceRoutes(resourceRoutes, 'rulelists', ruleLists)
registerGenericResourceRoutes(resourceRoutes, 'masklists', maskLists)
registerChunkedUploadRoutes(resourceRoutes)
registerHashListArchiveRoutes(resourceRoutes)

export { resourceRoutes }
