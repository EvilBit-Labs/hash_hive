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
import { randomUUID } from 'node:crypto'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { QUEUE_NAMES } from '../../config/queue.js'
import { deleteFile, uploadFile } from '../../config/storage.js'
import { problemResponse } from '../../lib/problem-details.js'
import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedControlResponse,
} from '../../openapi/components.js'
import { buildHashImportJobId } from '../../queue/workers/hash-import-worker.js'
import { parseImportContent } from '../../services/hash-items/import-parse.js'
import { getHashListById, getHashTypeById } from '../../services/resources.js'
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

    // Ownership check before any parse/stage/enqueue work (KTD9)
    const hl = await getHashListById(hashListId, projectId)
    if (!hl) {
      return problemResponse(c, 404, 'not_found', 'Hash list not found')
    }

    // Resolve hashcatMode for potfile parsing (KTD5)
    let hashcatMode: number | null = null
    if (hl.hashTypeId !== null) {
      const ht = await getHashTypeById(hl.hashTypeId)
      hashcatMode = ht?.hashcatMode ?? null
    }

    // Parse import content into normalized pairs (U6)
    const parseResult = parseImportContent(content, format, hashcatMode)

    // Stage parsed pairs to object store — keep cleartext out of Redis (KTD3)
    const stagingKey = `${projectId}/import-staging/${randomUUID()}.json`
    try {
      await uploadFile(
        stagingKey,
        Buffer.from(JSON.stringify(parseResult.pairs)),
        'application/json'
      )
    } catch (uploadErr) {
      logger.error({ err: uploadErr, projectId, hashListId }, 'Failed to stage import pairs')
      return problemResponse(c, 503, 'service_unavailable', 'Failed to stage import pairs')
    }

    // Enqueue U7 propagation job (dynamic import avoids circular dep with queue context)
    const { getQueueManager } = await import('../../queue/context.js')
    const qm = getQueueManager()
    if (!qm) {
      logger.warn({ projectId, hashListId, stagingKey }, 'Queue manager not available')
      // Best-effort cleanup to avoid orphaned staging objects (B2)
      deleteFile(stagingKey).catch((cleanupErr) => {
        logger.warn({ err: cleanupErr, stagingKey }, 'Failed to delete orphaned staging file')
      })
      return problemResponse(c, 503, 'service_unavailable', 'Queue unavailable')
    }

    const enqueued = await qm.enqueue(
      QUEUE_NAMES.HASH_IMPORT_PROPAGATION,
      { stagingKey, hashListId, projectId, actor, skippedFromParse: parseResult.skipped },
      { jobId: buildHashImportJobId(hashListId, stagingKey) }
    )

    if (!enqueued) {
      // Best-effort cleanup to avoid orphaned staging objects
      deleteFile(stagingKey).catch((cleanupErr) => {
        logger.warn({ err: cleanupErr, stagingKey }, 'Failed to delete orphaned staging file')
      })
      return problemResponse(c, 503, 'service_unavailable', 'Queue unavailable')
    }

    // Return compartmentalized summary (KTD7) — matched/cracked computed async by U7 worker
    return c.json({ matchedInList: 0, crackedInList: 0, skipped: parseResult.skipped }, 202)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
