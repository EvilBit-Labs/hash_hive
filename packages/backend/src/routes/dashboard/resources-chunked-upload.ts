/**
 * S3 multipart chunked-upload session routes — extracted from
 * `resources.ts` to keep the main file under the 800-line cap.
 * Registered against the same `resourceRoutes` router via
 * `registerChunkedUploadRoutes(router)` so URL paths and middleware
 * composition stay identical.
 *
 * Covers:
 *  - POST   /upload/initiate
 *  - PUT    /upload/{uploadId}/part/{partNumber}  (raw octet-stream body)
 *  - POST   /upload/{uploadId}/complete
 *  - DELETE /upload/{uploadId}
 *  - GET    /upload/{uploadId}/status
 *
 * The PUT part endpoint accepts raw binary and uses
 * `c.req.arrayBuffer()` directly; the route declares
 * `application/octet-stream` with `z.unknown()` so createRoute's
 * default JSON parsing doesn't run on the body.
 */

import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireMembershipRole } from '../../middleware/rbac.js'
import { DASHBOARD_RESPONSE_REFS, sharedResponse } from '../../openapi/components.js'
import {
  abortChunkedUpload,
  completeChunkedUpload,
  getChunkedUploadStatus,
  initiateChunkedUpload,
  uploadChunkPart,
} from '../../services/resources.js'
import {
  passthroughObject,
  RESOURCE_TYPES,
  security,
  tags,
  uploadIdParamSchema,
  uploadPartParamSchema,
  uploadStatusQuerySchema,
} from './resources-shared.js'

// ─── Schemas ────────────────────────────────────────────────────────

const initiateUploadSchema = z.object({
  resourceType: z.enum(RESOURCE_TYPES),
  name: z.string().min(1).max(255),
  fileSize: z.number().int().positive().max(500_000_000_000),
  contentType: z.string().optional(),
})

const uploadPartQuerySchema = z.object({
  resourceId: z.coerce.number().int().positive(),
  resourceType: z.enum(RESOURCE_TYPES),
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
  resourceType: z.enum(RESOURCE_TYPES),
})

// ─── Routes ─────────────────────────────────────────────────────────

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
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    500: {
      description: 'Upload part failed',
      content: { 'application/json': { schema: passthroughObject('UploadPartFailedError') } },
    },
  },
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
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    500: {
      description: 'Upload completion failed',
      content: { 'application/json': { schema: passthroughObject('UploadCompleteFailedError') } },
    },
  },
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
    404: sharedResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
  },
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

export function registerChunkedUploadRoutes(router: OpenAPIHono<AppEnv>): void {
  router.openapi(initiateUploadRoute, async (c) => {
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

  router.openapi(uploadPartRoute, async (c) => {
    // Route declares `params: uploadPartParamSchema` (uploadId + coerced
    // partNumber) and `query: uploadPartQuerySchema` (coerced resourceId +
    // enum resourceType), so c.req.valid('param')/('query') returns the
    // already-validated shapes and the dashboard defaultHook handles any
    // validation failure with the standard envelope.
    const { uploadId, partNumber } = c.req.valid('param')
    const { resourceId, resourceType } = c.req.valid('query')
    const { projectId } = c.get('scopedUser')!

    // Read the raw body as a Uint8Array — do NOT use c.req.json() or
    // c.req.parseBody(). A truncated client connection, malformed
    // chunked transfer-encoding, or mid-stream socket close throws
    // here; without this guard the exception bubbles to the root
    // `app.onError` as a generic 500 with no upload-context.
    let chunk: Uint8Array
    try {
      const body = await c.req.arrayBuffer()
      chunk = new Uint8Array(body)
    } catch (err) {
      logger.warn(
        { err, uploadId, partNumber, resourceId, resourceType },
        'Failed to read request body for resource chunk upload part'
      )
      return dashboardError(c, 400, 'VALIDATION_ERROR', 'Failed to read request body')
    }

    if (chunk.byteLength === 0) {
      return dashboardError(c, 400, 'VALIDATION_ERROR', 'Request body is empty')
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
      return c.json(result, 200)
    } catch (err) {
      logger.error(
        { err, uploadId, partNumber, resourceId, resourceType, projectId },
        'Failed to upload part'
      )
      return dashboardError(c, 500, 'UPLOAD_PART_FAILED', 'Failed to upload part')
    }
  })

  router.openapi(completeUploadRoute, async (c) => {
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
      return c.json(result, 200)
    } catch (err) {
      logger.error({ err, uploadId }, 'Failed to complete chunked upload')
      return dashboardError(c, 500, 'UPLOAD_COMPLETE_FAILED', 'Failed to complete upload')
    }
  })

  router.openapi(abortUploadRoute, async (c) => {
    const { uploadId } = c.req.valid('param')
    const { resourceId, resourceType } = c.req.valid('query')
    const { projectId } = c.get('scopedUser')!

    await abortChunkedUpload(uploadId, resourceId, resourceType, projectId)
    return c.json({ acknowledged: true }, 200)
  })

  router.openapi(uploadStatusRoute, async (c) => {
    const { uploadId } = c.req.valid('param')
    const { resourceId, resourceType } = c.req.valid('query')
    const { projectId } = c.get('scopedUser')!

    const result = await getChunkedUploadStatus(uploadId, resourceId, resourceType, projectId)
    if (!result) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Upload not found')
    }

    return c.json({ uploadId, ...result }, 200)
  })
}
