import {
  attacks,
  campaigns,
  exportFormatSchema,
  exportScopeSchema,
  exportVariantSchema,
  hashItems,
  hashLists,
  listResultsResponseSchema,
  resolveAttackModeName,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { and, desc, eq, gte, isNotNull, lt, lte, or, sql } from 'drizzle-orm'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { db } from '../../db/index.js'
import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess } from '../../middleware/rbac.js'
import {
  coercedIntegerQuery,
  coercedOptionalPositiveIntegerQuery,
} from '../../openapi/coerced-query.js'
import {
  DASHBOARD_RESPONSE_REFS,
  dashboardOpenApiHonoOptions,
  sharedDashboardResponse,
} from '../../openapi/components.js'
import { escapeLike } from '../../services/resources.js'
import {
  buildExportScopeParams,
  buildExportTimestamp,
  generatorToReadableStream,
  getExportFileExtension,
  getExportMimeType,
} from '../../services/results/export-format.js'
import { createExport, escapeCsv } from '../../services/results/export.js'
import { getScopedProjectId as getScopedProjectIdShared } from './scoped-user.js'

const resultsRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

// `*` covers both paths today and any future endpoint added to this
// router, so a new mount can't silently bypass project membership.
resultsRoutes.use('*', requireSession, requireProjectAccess())

const RESULTS_LIST_MAX_LIMIT = 100
const RESULTS_LIST_DEFAULT_LIMIT = 50

const CSV_STREAM_BATCH_SIZE = 1000

// Permissive filter inputs across the dashboard surface: invalid values
// fall back to "no filter" rather than 400, and `coerce` keeps
// NaN/Infinity out of Drizzle's `.limit()`/`.offset()`. Each `.catch()`
// wrapper needs an `.openapi(...)` hint or the spec generator throws.
function isoDateTimeFilterQuery() {
  return z
    .string()
    .datetime()
    .optional()
    .catch(undefined)
    .openapi({ type: 'string', format: 'date-time' })
}

const resultsFilterShape = {
  campaignId: coercedOptionalPositiveIntegerQuery(),
  hashListId: coercedOptionalPositiveIntegerQuery(),
  q: z.string().min(1).optional(),
  startDate: isoDateTimeFilterQuery(),
  endDate: isoDateTimeFilterQuery(),
}

const listResultsQuerySchema = z.object({
  ...resultsFilterShape,
  limit: coercedIntegerQuery({
    min: 1,
    max: RESULTS_LIST_MAX_LIMIT,
    default: RESULTS_LIST_DEFAULT_LIMIT,
  }),
  offset: coercedIntegerQuery({ min: 0, default: 0 }),
})

// Export scope/variant/format are optional for backward compatibility. When all
// three are absent the handler follows the legacy CSV path so that existing
// clients continue to receive the same output. When any one is present the
// handler uses the U3 export service with defaults (project/cracked-pairs/csv)
// for whichever axes are missing.
const exportResultsQuerySchema = z.object({
  ...resultsFilterShape,
  scope: exportScopeSchema.optional(),
  variant: exportVariantSchema.optional(),
  format: exportFormatSchema.optional(),
})

// Filter-only subset used by buildResultFilters and the legacy export path.
// Uses `T | undefined` (not `?: T`) to satisfy exactOptionalPropertyTypes —
// query destructuring always produces properties that are present but possibly
// undefined, which is distinct from an absent property under strict TS config.
type ResultsFilterInput = {
  campaignId: number | undefined
  hashListId: number | undefined
  q: string | undefined
  startDate: string | undefined
  endDate: string | undefined
}

function buildResultFilters(projectId: number, filters: ResultsFilterInput) {
  const { campaignId, hashListId, q: search, startDate, endDate } = filters

  // Scope via `hashLists.projectId`, NOT `campaigns.projectId`:
  // `hash_items.campaign_id` is nullable (FK uses ON DELETE SET NULL),
  // so a campaigns join would silently drop cracked rows whose
  // campaign has been deleted. `hashItems.hashListId` is NOT NULL and
  // `hashLists.projectId` is NOT NULL — same rationale as
  // `dashboard/stats.ts`.
  const conditions = [eq(hashLists.projectId, projectId), isNotNull(hashItems.crackedAt)]

  if (campaignId) {
    conditions.push(eq(hashItems.campaignId, campaignId))
  }
  if (hashListId) {
    conditions.push(eq(hashItems.hashListId, hashListId))
  }
  if (search) {
    const escaped = escapeLike(search)
    conditions.push(
      sql`(${hashItems.hashValue} ILIKE ${`%${escaped}%`} ESCAPE '\\' OR ${hashItems.plaintext} ILIKE ${`%${escaped}%`} ESCAPE '\\')`
    )
  }
  if (startDate) {
    conditions.push(gte(hashItems.crackedAt, new Date(startDate)))
  }
  if (endDate) {
    conditions.push(lte(hashItems.crackedAt, new Date(endDate)))
  }

  return conditions
}

// Dedupe unknown-mode warnings per process; an outdated dashboard build
// running against newer agents would otherwise log every row.
const UNKNOWN_ATTACK_MODES_LOGGED = new Set<number>()

function resolveAttackModeNameWithTelemetry(mode: number | null): string | null {
  const name = resolveAttackModeName(mode)
  if (name === null && mode !== null && !UNKNOWN_ATTACK_MODES_LOGGED.has(mode)) {
    UNKNOWN_ATTACK_MODES_LOGGED.add(mode)
    logger.warn(
      { mode },
      'results: unknown hashcat attack mode encountered — dashboard build may be older than agent'
    )
  }
  return name
}

function getScopedProjectId(c: {
  get: (key: 'scopedUser') => { projectId: number } | undefined
}): { ok: true; projectId: number } | { ok: false } {
  return getScopedProjectIdShared(c, 'results')
}

const listResultsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Results'],
  summary: 'Paginated cracked-hash results with attribution to campaign / attack / agent',
  security: [{ SessionCookie: [] }],
  request: { query: listResultsQuerySchema },
  responses: {
    200: {
      description: 'Page of cracked results with attribution joins.',
      content: { 'application/json': { schema: listResultsResponseSchema } },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  },
})

resultsRoutes.openapi(listResultsRoute, async (c) => {
  const scope = getScopedProjectId(c)
  if (!scope.ok) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
  }
  const { projectId } = scope

  const { limit, offset, campaignId, hashListId, q, startDate, endDate } = c.req.valid('query')
  const conditions = buildResultFilters(projectId, {
    campaignId,
    hashListId,
    q,
    startDate,
    endDate,
  })

  const [rawResults, countResult] = await Promise.all([
    db
      .select({
        id: hashItems.id,
        hashValue: hashItems.hashValue,
        plaintext: hashItems.plaintext,
        crackedAt: hashItems.crackedAt,
        hashListId: hashItems.hashListId,
        hashListName: hashLists.name,
        campaignId: hashItems.campaignId,
        campaignName: campaigns.name,
        attackId: hashItems.attackId,
        attackMode: attacks.mode,
        agentId: hashItems.agentId,
      })
      .from(hashItems)
      .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
      // Campaign join is LEFT so historical rows (campaign deleted →
      // hashItems.campaignId is null) still appear with null campaign
      // fields rather than being silently filtered out.
      .leftJoin(campaigns, eq(hashItems.campaignId, campaigns.id))
      .leftJoin(attacks, eq(hashItems.attackId, attacks.id))
      .where(and(...conditions))
      .orderBy(desc(hashItems.crackedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(hashItems)
      .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
      .where(and(...conditions)),
  ])

  const rawCount = countResult[0]?.count
  if (rawCount == null) {
    logger.warn(
      { projectId },
      'results/list: count query returned no rows — driver invariant violated, defaulting total to 0'
    )
  }

  // Project immutability rule applies to intermediate Drizzle rows; cost
  // is one shallow spread per row, capped at RESULTS_LIST_MAX_LIMIT (100).
  // oxlint-disable-next-line oxc/no-map-spread
  const results = rawResults.map((row) => ({
    ...row,
    attackModeName: resolveAttackModeNameWithTelemetry(row.attackMode),
  }))

  return c.json(
    {
      results,
      // postgres-js returns count(*) as a string; Drizzle's `sql<number>`
      // is a compile-time cast that does NOT convert at runtime. Without
      // this wrapper `total` would ship as a string. Same as
      // dashboard/stats.ts.
      total: Number(rawCount ?? 0),
      limit,
      offset,
    },
    200
  )
})

const exportResultsRoute = createRoute({
  method: 'get',
  path: '/export',
  tags: ['Results'],
  summary:
    'Stream an export of cracked results. Accepts scope, variant, and format to control output. Streams all matching rows with no row cap; backpressure is handled via ReadableStream.',
  security: [{ SessionCookie: [] }],
  request: { query: exportResultsQuerySchema },
  responses: {
    200: {
      description:
        'Export file streamed via ReadableStream. Content-Type is text/csv for CSV exports or text/plain for potfile exports. The x-export-skipped header carries the count of rows omitted because the hash type is missing or the potfile mode is unsupported.',
      content: {
        'text/csv': { schema: z.string() },
        'text/plain': { schema: z.string() },
      },
    },
    401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  },
})

/**
 * Fetch one batch of cracked rows for the streaming export. Uses keyset
 * pagination on `(crackedAt DESC, id DESC)` so batches never re-fetch a
 * row across the cursor boundary even when many rows share a `crackedAt`
 * value (the `id` tiebreaker is load-bearing).
 *
 * Drizzle's query-builder operator set is single-column, so the
 * row-value comparison `(cracked_at, id) < (cursor.crackedAt, cursor.id)`
 * is expressed as the equivalent boolean expansion:
 *   `crackedAt < cursor.crackedAt OR (crackedAt = cursor.crackedAt AND id < cursor.id)`.
 */
async function fetchCsvBatch(
  baseConditions: ReturnType<typeof buildResultFilters>,
  cursor: { crackedAt: Date; id: number } | null
) {
  const cursorPredicate = cursor
    ? [
        or(
          lt(hashItems.crackedAt, cursor.crackedAt),
          and(eq(hashItems.crackedAt, cursor.crackedAt), lt(hashItems.id, cursor.id))
        ),
      ]
    : []

  return (
    db
      .select({
        id: hashItems.id,
        hashValue: hashItems.hashValue,
        plaintext: hashItems.plaintext,
        crackedAt: hashItems.crackedAt,
        hashListName: hashLists.name,
        campaignName: campaigns.name,
        attackMode: attacks.mode,
      })
      .from(hashItems)
      .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
      // Left-join campaigns so deleted-campaign rows still export (same
      // rationale as the list query — hash_items.campaign_id is nullable).
      .leftJoin(campaigns, eq(hashItems.campaignId, campaigns.id))
      .leftJoin(attacks, eq(hashItems.attackId, attacks.id))
      .where(and(...baseConditions, ...cursorPredicate))
      .orderBy(desc(hashItems.crackedAt), desc(hashItems.id))
      .limit(CSV_STREAM_BATCH_SIZE)
  )
}

type CsvBatchRow = Awaited<ReturnType<typeof fetchCsvBatch>>[number]

// Header + per-row projection co-located so reordering one breaks the
// other at compile time. A bare string + map() lets the two drift
// silently and ship a CSV with mislabeled columns.
const CSV_COLUMNS: ReadonlyArray<{ header: string; project: (r: CsvBatchRow) => string }> = [
  { header: 'hash_value', project: (r) => escapeCsv(r.hashValue) },
  { header: 'plaintext', project: (r) => escapeCsv(r.plaintext) },
  { header: 'campaign', project: (r) => escapeCsv(r.campaignName) },
  { header: 'attack', project: (r) => escapeCsv(resolveAttackModeNameWithTelemetry(r.attackMode)) },
  { header: 'hash_list', project: (r) => escapeCsv(r.hashListName) },
  { header: 'cracked_at', project: (r) => (r.crackedAt ? r.crackedAt.toISOString() : '') },
]

const CSV_HEADER_LINE = `${CSV_COLUMNS.map((c) => c.header).join(',')}\n`

function encodeBatchAsCsv(batch: readonly CsvBatchRow[]): string {
  return batch.map((r) => CSV_COLUMNS.map((c) => c.project(r)).join(',')).join('\n')
}

resultsRoutes.openapi(exportResultsRoute, async (c) => {
  const scopeResult = getScopedProjectId(c)
  if (!scopeResult.ok) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
  }
  const { projectId } = scopeResult

  const { campaignId, hashListId, q, startDate, endDate, scope, variant, format } =
    c.req.valid('query')

  // When any of the new axes are provided, delegate to the U3 export service.
  // Absent axes default to project/cracked-pairs/csv so partial callers get a
  // sensible result. When all three are absent the legacy handler runs instead —
  // this keeps old-format CSV output (6 columns) unchanged for existing clients.
  if (scope !== undefined || variant !== undefined || format !== undefined) {
    const resolvedScope = scope ?? 'project'
    const resolvedVariant = variant ?? 'cracked-pairs'
    const resolvedFormat = format ?? 'csv'

    const isPotfile = resolvedFormat === 'hashcat-potfile' || resolvedFormat === 'john-potfile'
    const isCsvOnly = resolvedVariant === 'plaintext-only' || resolvedVariant === 'uncracked'
    if (isPotfile && isCsvOnly) {
      return c.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: `format '${resolvedFormat}' requires variant 'cracked-pairs'; '${resolvedVariant}' does not include hash values`,
          },
        },
        400
      )
    }

    const scopeParams = buildExportScopeParams(resolvedScope, projectId, hashListId, campaignId)
    if (scopeParams === null) {
      const missing = resolvedScope === 'hash-list' ? 'hashListId' : 'campaignId'
      return c.json(
        {
          error: {
            code: 'INVALID_REQUEST',
            message: `'${missing}' is required when scope is '${resolvedScope}'`,
          },
        },
        400
      )
    }

    const { skippedCount, rows } = await createExport(db, {
      ...scopeParams,
      variant: resolvedVariant,
      format: resolvedFormat,
    })

    const timestamp = buildExportTimestamp()
    const ext = getExportFileExtension(resolvedFormat)
    const mime = getExportMimeType(resolvedFormat)
    const stream = generatorToReadableStream(rows)

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="results-${timestamp}.${ext}"`,
        'x-export-skipped': String(skippedCount),
        'X-Accel-Buffering': 'no',
        'Cache-Control': 'no-store',
      },
    })
  }

  // ─── Legacy path: original 6-column CSV export ──────────────────────────────
  // Runs when scope/variant/format are all absent. Preserves the pre-U3 output
  // format (6 columns: hash_value, plaintext, campaign, attack, hash_list,
  // cracked_at) so that existing dashboard clients receive the same file shape.

  const filters: ResultsFilterInput = { campaignId, hashListId, q, startDate, endDate }
  // Build conditions once at handler entry — each pull only composes the
  // cursor predicate on top.
  const baseConditions = buildResultFilters(projectId, filters)

  const encoder = new TextEncoder()
  // `pull` is contractually single-threaded by the ReadableStream
  // spec, so the closure variables below need no synchronization.
  let cursor: { crackedAt: Date; id: number } | null = null
  let headerSent = false
  // The runtime stops invoking `pull` after `cancel()`, but an
  // in-flight `await fetchCsvBatch(...)` from a previous tick can still
  // resolve and try to `controller.enqueue(...)` on a now-closed
  // controller (which throws). This flag short-circuits that path.
  let cancelled = false

  // Work lives in `pull` so bytes flow lazily — running I/O in `start`
  // would await before the first byte ships.
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (cancelled) return
        if (!headerSent) {
          controller.enqueue(encoder.encode(CSV_HEADER_LINE))
          headerSent = true
        }
        const batch = await fetchCsvBatch(baseConditions, cursor)
        if (cancelled) return
        if (batch.length === 0) {
          if (!cursor) {
            logger.info(
              { projectId, filters },
              'results/export: filter produced zero rows, returning header-only CSV'
            )
          }
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(`${encodeBatchAsCsv(batch)}\n`))
        const last = batch[batch.length - 1]!
        if (last.crackedAt !== null) {
          cursor = { crackedAt: last.crackedAt, id: last.id }
        } else {
          // Defensive: `crackedAt IS NOT NULL` is in the WHERE clause,
          // so this branch should be unreachable. If it fires, the
          // CSV is silently truncated — log loudly so ops can detect
          // it, then close rather than spin.
          logger.error(
            { projectId, lastId: last.id, batchSize: batch.length },
            'results/export: null crackedAt in cursor row — filter invariant violated, truncating stream'
          )
          controller.close()
        }
      } catch (err) {
        if (cancelled) return
        logger.error(
          { err, projectId, cursor, headerSent },
          'results/export: pull failed mid-stream, client will receive truncated CSV'
        )
        controller.error(err)
      }
    },
    cancel(reason) {
      // Client disconnect or explicit cancel — mark the cancelled flag
      // so any in-flight `pull` that races to enqueue after we close
      // bails out instead of throwing on a closed controller.
      cancelled = true
      logger.info(
        {
          projectId,
          cursor,
          headerSent,
          reason: reason instanceof Error ? reason.message : reason,
        },
        'results/export: stream cancelled by consumer'
      )
    },
  })

  // Strip `:` for Windows-safe filenames; slice to seconds (drop millis).
  const timestamp = buildExportTimestamp()

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="results-${timestamp}.csv"`,
      // Long-running streams: tell intermediaries not to buffer the
      // response, and clients not to cache.
      'X-Accel-Buffering': 'no',
      'Cache-Control': 'no-store',
    },
  })
})

// `buildResultFilters` is exported as the testing seam for the real-DB lane
// (tests/db/dashboard-results-filters.db.test.ts): the predicate logic is the
// thing under test, and the db lane has no HTTP app to drive the route.
export { buildResultFilters, resultsRoutes }
