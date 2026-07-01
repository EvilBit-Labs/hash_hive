import { hashSearchResponseSchema, importFormatSchema, importSummarySchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { randomUUID } from 'node:crypto'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { QUEUE_NAMES } from '../../config/queue.js'
import { deleteFile, uploadFile } from '../../config/storage.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireMembershipRole, requireProjectAccess } from '../../middleware/rbac.js'
import { coercedIntegerQuery } from '../../openapi/coerced-query.js'
import {
  DASHBOARD_RESPONSE_REFS,
  dashboardOpenApiHonoOptions,
  sharedDashboardResponse,
} from '../../openapi/components.js'
import { buildHashImportJobId } from '../../queue/workers/hash-import-worker.js'
import { guessHashType } from '../../services/hash-analysis.js'
import { parseImportContent } from '../../services/hash-items/import-parse.js'
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_Q_LENGTH,
  searchHashes,
} from '../../services/hash-items/search.js'
import { getHashListById, getHashTypeById } from '../../services/resources.js'
import { getScopedProjectId } from './scoped-user.js'

const hashRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

hashRoutes.use('*', requireSession)

// ─── POST /guess-type — identify hash type candidates ───────────────

const guessTypeRequestSchema = z
  .object({
    hashValue: z.string().min(1).max(1024),
  })
  .openapi('HashGuessTypeRequest')

const guessTypeResponseSchema = z
  .object({
    hashValue: z.string(),
    candidates: z.array(z.unknown()),
    identified: z.boolean(),
  })
  .openapi('HashGuessTypeResponse')

const guessTypeRoute = createRoute({
  method: 'post',
  path: '/guess-type',
  tags: ['Hashes'],
  summary: 'Identify candidate hash types for a hash value',
  security: [{ SessionCookie: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: guessTypeRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Candidate hash types for the supplied value.',
      content: { 'application/json': { schema: guessTypeResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
  },
})

hashRoutes.openapi(guessTypeRoute, async (c) => {
  const { hashValue } = c.req.valid('json')
  const candidates = guessHashType(hashValue)

  return c.json(
    {
      hashValue,
      candidates,
      identified: candidates.length > 0,
    },
    200
  )
})

// ─── POST /hash-lists/{id}/import-precracked — accept pre-cracked pairs ─────

const importPrecrackedBodySchema = z
  .object({
    content: z.string().min(1, 'content must not be empty'),
    format: importFormatSchema,
  })
  .strict()
  .openapi('DashboardImportPrecrackedRequest')

const importPrecrackedRoute = createRoute({
  method: 'post',
  path: '/hash-lists/{id}/import-precracked',
  tags: ['Hashes'],
  summary: 'Submit pre-cracked pairs to a hash list',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: {
      content: { 'application/json': { schema: importPrecrackedBodySchema } },
    },
  },
  responses: {
    202: {
      description: 'Import accepted and queued for processing.',
      content: { 'application/json': { schema: importSummarySchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    503: {
      description: 'Storage or queue unavailable.',
      content: {
        'application/json': {
          schema: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
        },
      },
    },
  },
})

hashRoutes.openapi(importPrecrackedRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { userId } = c.get('currentUser')
  const actor = { actorType: 'user' as const, actorId: userId }
  const { id: hashListId } = c.req.valid('param')
  const { content, format } = c.req.valid('json')

  // Ownership check before any parse/stage/enqueue work (KTD9)
  const hl = await getHashListById(hashListId, projectId)
  if (!hl) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Hash list not found')
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
    await uploadFile(stagingKey, Buffer.from(JSON.stringify(parseResult.pairs)), 'application/json')
  } catch (err) {
    logger.error({ err, projectId, hashListId }, 'Failed to stage import pairs')
    return dashboardError(c, 503, 'STORAGE_UNAVAILABLE', 'Failed to stage import pairs')
  }

  // Enqueue U7 propagation job (dynamic import avoids circular dep with queue context)
  const { getQueueManager } = await import('../../queue/context.js')
  const qm = getQueueManager()
  if (!qm) {
    logger.warn({ projectId, hashListId, stagingKey }, 'Queue manager not available')
    return dashboardError(c, 503, 'SERVICE_UNAVAILABLE', 'Queue unavailable; import not enqueued')
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
    return dashboardError(c, 503, 'SERVICE_UNAVAILABLE', 'Queue unavailable; import not enqueued')
  }

  // Return compartmentalized summary (KTD7) — matched/cracked computed async by U7 worker
  return c.json({ matchedInList: 0, crackedInList: 0, skipped: parseResult.skipped }, 202)
})

// ─── GET /search — global hash search (R14–R17) ──────────────────────────────
//
// Fetch-on-demand: returns matching hash rows (cracked + uncracked) across
// all hash lists in the active project. No realtime invalidation wired here
// (KTD8: search is user-triggered fetch-on-demand, not a server-pushed surface).

const searchHashesQuerySchema = z.object({
  q: z.string().min(1, 'q must not be empty').max(SEARCH_MAX_Q_LENGTH, 'q is too long'),
  limit: coercedIntegerQuery({
    min: 1,
    max: SEARCH_MAX_LIMIT,
    default: SEARCH_DEFAULT_LIMIT,
  }),
  offset: coercedIntegerQuery({ min: 0, default: 0 }),
})

const dashboardHashSearchResponseSchema = hashSearchResponseSchema.openapi(
  'DashboardHashSearchResponse'
)

const searchHashesRoute = createRoute({
  method: 'get',
  path: '/search',
  tags: ['Hashes'],
  summary: 'Search for hashes across all hash lists in the active project',
  security: [{ SessionCookie: [] }],
  middleware: [requireProjectAccess()] as const,
  request: { query: searchHashesQuerySchema },
  responses: {
    200: {
      description:
        'Project-scoped hash search results. Both cracked (crackedAt is an ISO string) and uncracked (crackedAt is null) rows are returned. A single hash value may appear multiple times if it belongs to multiple hash lists.',
      content: { 'application/json': { schema: dashboardHashSearchResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  },
})

hashRoutes.openapi(searchHashesRoute, async (c) => {
  const scope = getScopedProjectId(c, 'hashes/search')
  if (!scope.ok) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
  }
  const { projectId } = scope
  const { q, limit, offset } = c.req.valid('query')

  const result = await searchHashes(projectId, q, { limit, offset })

  // Map Date → ISO string for the wire shape (crackedAt is Date in the service,
  // string | null in hashSearchResponseSchema). This mapping is load-bearing
  // for round-trip .parse() validation (KTD8).
  const results = result.results.map((r) => ({
    ...r,
    crackedAt: r.crackedAt !== null ? r.crackedAt.toISOString() : null,
  }))

  return c.json({ results, total: result.total, limit: result.limit, offset: result.offset }, 200)
})

export { hashRoutes }
