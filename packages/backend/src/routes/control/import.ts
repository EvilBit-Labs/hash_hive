/**
 * Control API pre-cracked import endpoint (issue #102, unit U8).
 *
 * POST /hash-lists/{id}
 *   - Role-gates to admin/contributor (KTD9)
 *   - Validates target-list ownership before parse/stage/enqueue
 *   - Parses content via U6 parseImportContent
 *   - Stages parsed pairs to object store — no cleartext in queue payload (KTD3)
 *   - Enqueues U7 hash import propagation job
 *   - Returns compartmentalized import summary (KTD7): no cross-project field
 */

import { importRequestSchema, importSummarySchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { AppEnv } from '../../types.js'

import { problemResponse } from '../../lib/problem-details.js'
import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedControlResponse,
} from '../../openapi/components.js'
import { stageAndEnqueueImport } from '../../services/hash-items/import-intake.js'
import { controlErrorResponse, requireProjectRole } from './helpers.js'

export const controlImportRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

const idParamSchema = z.object({ id: z.coerce.number().int().positive() })

const importBodySchema = importRequestSchema.openapi('ControlImportPrecrackedRequest')

const importPrecrackedRoute = createRoute({
  method: 'post',
  path: '/hash-lists/{id}',
  tags: ['Import'],
  summary: 'Submit pre-cracked pairs to a hash list',
  security: [{ ControlApiKey: [] }],
  request: {
    params: idParamSchema,
    body: {
      content: { 'application/json': { schema: importBodySchema } },
    },
  },
  responses: {
    202: {
      description: 'Import accepted and queued for processing.',
      content: { 'application/json': { schema: importSummarySchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    503: sharedControlResponse(CONTROL_RESPONSE_REFS.ServiceUnavailable),
  },
})

controlImportRoutes.openapi(importPrecrackedRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'admin', 'contributor')
    const { userId } = c.get('currentUser')
    const actor = { actorType: 'user' as const, actorId: userId }
    const { id: hashListId } = c.req.valid('param')
    const { content, format } = c.req.valid('json')

    const result = await stageAndEnqueueImport({ hashListId, projectId, actor, content, format })

    if (!result.ok) {
      if (result.reason === 'not_found') {
        return problemResponse(c, 404, 'not_found', 'Hash list not found')
      }
      if (result.reason === 'staging_failed') {
        return problemResponse(c, 503, 'service_unavailable', 'Failed to stage import pairs')
      }
      // queue_unavailable
      return problemResponse(c, 503, 'service_unavailable', 'Queue unavailable')
    }

    // Return compartmentalized summary (KTD7) — matched/cracked computed async by U7 worker
    return c.json({ matchedInList: 0, crackedInList: 0, skipped: result.skipped }, 202)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
