/**
 * Generic resource routes factory for wordlists / rulelists / masklists.
 * Extracted from `resources.ts` to keep the main file under the 800-line
 * cap. Each call to `registerGenericResourceRoutes(router, prefix, table)`
 * registers the same CRUD + upload + download surface against the
 * passed-in router so URL paths and middleware composition stay
 * identical to the single-file form.
 */

import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireMembershipRole, requireProjectAccess } from '../../middleware/rbac.js'
import { DASHBOARD_RESPONSE_REFS, sharedDashboardResponse } from '../../openapi/components.js'
import {
  createResource,
  deleteResource,
  getResourceById,
  getResourcePresignedUrl,
  listResources,
  type ResourceTable,
  ResourceInUseError,
  uploadResourceFile,
  UploadTooLargeError,
} from '../../services/resources.js'
import {
  enforceMultipartSizeLimit,
  idParamSchema,
  passthroughObject,
  security,
  tags,
} from './resources-shared.js'

export function registerGenericResourceRoutes(
  router: OpenAPIHono<AppEnv>,
  prefix: string,
  table: ResourceTable
): void {
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
      401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
      403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    },
  })

  router.openapi(listResourceRoute, async (c) => {
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
      400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
      401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
      403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    },
  })

  router.openapi(createResourceRoute, async (c) => {
    const data = c.req.valid('json')
    const { projectId } = c.get('scopedUser')!
    const { userId } = c.get('currentUser')
    const actor = { actorType: 'user' as const, actorId: userId }
    const item = await createResource(table, { ...data, projectId }, actor)
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
      401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
      403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
      404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    },
  })

  router.openapi(getResourceRoute, async (c) => {
    const { projectId } = c.get('scopedUser')!
    const { id } = c.req.valid('param')
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
    description: `Multipart body (\`file\` field) is intentionally NOT declared on the route. createRoute validates the request body BEFORE the handler runs, which would parseBody and buffer the entire upload before \`enforceMultipartSizeLimit(c)\` can reject oversize Content-Length headers with 413 / chunked transfer-encoding with 411. The handler enforces field presence after the size guard.`,
    security,
    middleware: [requireMembershipRole('admin', 'contributor')] as const,
    request: {
      params: idParamSchema,
    },
    responses: {
      200: {
        description: 'Upload accepted',
        content: {
          'application/json': { schema: passthroughObject(`${prefix}UploadResult`) },
        },
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

  router.openapi(uploadResourceRoute, async (c) => {
    const { projectId } = c.get('scopedUser')!
    const { userId } = c.get('currentUser')
    const actor = { actorType: 'user' as const, actorId: userId }
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
      const result = await uploadResourceFile(table, id, projectId, prefix, file, actor)
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
      400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
      401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
      403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
      404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
      409: {
        description: 'Resource in use',
        content: { 'application/json': { schema: passthroughObject('ResourceInUseError') } },
      },
    },
  })

  router.openapi(deleteResourceRoute, async (c) => {
    const { projectId } = c.get('scopedUser')!
    const { userId } = c.get('currentUser')
    const actor = { actorType: 'user' as const, actorId: userId }
    const { id } = c.req.valid('param')
    try {
      const deleted = await deleteResource(table, id, projectId, prefix, actor)
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
      400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
      401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
      403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
      404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    },
  })

  router.openapi(downloadResourceRoute, async (c) => {
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
