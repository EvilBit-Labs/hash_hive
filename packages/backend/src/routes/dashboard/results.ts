import {
  attacks,
  campaigns,
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

const resultsRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

// `*` covers both paths today and any future endpoint added to this
// router, so a new mount can't silently bypass project membership.
resultsRoutes.use('*', requireSession, requireProjectAccess())

const RESULTS_LIST_MAX_LIMIT = 100
const RESULTS_LIST_DEFAULT_LIMIT = 50

const CSV_STREAM_BATCH_SIZE = 1000

// Characters that trigger spreadsheet formula evaluation in Excel, Google
// Sheets, and LibreOffice Calc when they appear at the start of a cell.
// `plaintext` and `hashValue` are attacker-influenced data — a recovered
// password of `=cmd|...` would otherwise execute as a formula when the
// exported CSV is opened. Quote-wrapping does not neutralize this; the
// canonical mitigation is to prefix the cell with a leading apostrophe so
// spreadsheet apps treat it as literal text. `\n` and `\r` are included
// because Excel/Sheets strip leading whitespace (including newlines that
// the CSV reader preserved inside a quoted cell) before evaluating
// formula triggers. See OWASP "CSV Injection".
const CSV_FORMULA_TRIGGER_REGEX = /^[=+\-@\t\r\n]/

function escapeCsv(val: string | null | undefined): string {
  if (val == null) return ''
  let str = val
  if (CSV_FORMULA_TRIGGER_REGEX.test(str)) {
    str = `'${str}`
  }
  // Bare CR splits the row in spreadsheet parsers; double inner quotes per RFC 4180.
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

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

const exportResultsQuerySchema = z.object(resultsFilterShape)

type ResultsFilterInput = z.infer<typeof exportResultsQuerySchema>

function buildResultFilters(projectId: number, filters: ResultsFilterInput) {
  const { campaignId, hashListId, q: search, startDate, endDate } = filters

  const conditions = [eq(campaigns.projectId, projectId), isNotNull(hashItems.crackedAt)]

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
  const scoped = c.get('scopedUser')
  if (!scoped) {
    logger.error(
      {},
      'results: scopedUser middleware did not run before handler — middleware order regression'
    )
    return { ok: false }
  }
  return { ok: true, projectId: scoped.projectId }
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
      .innerJoin(campaigns, eq(hashItems.campaignId, campaigns.id))
      .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
      .leftJoin(attacks, eq(hashItems.attackId, attacks.id))
      .where(and(...conditions))
      .orderBy(desc(hashItems.crackedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)` })
      .from(hashItems)
      .innerJoin(campaigns, eq(hashItems.campaignId, campaigns.id))
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
    'Stream a CSV export of cracked results. Streams all matching rows with no row cap; backpressure is handled via ReadableStream.',
  security: [{ SessionCookie: [] }],
  request: { query: exportResultsQuerySchema },
  responses: {
    200: {
      description: 'CSV file with one row per cracked hash; streamed via ReadableStream.',
      content: { 'text/csv': { schema: z.string() } },
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

  return db
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
    .innerJoin(campaigns, eq(hashItems.campaignId, campaigns.id))
    .innerJoin(hashLists, eq(hashItems.hashListId, hashLists.id))
    .leftJoin(attacks, eq(hashItems.attackId, attacks.id))
    .where(and(...baseConditions, ...cursorPredicate))
    .orderBy(desc(hashItems.crackedAt), desc(hashItems.id))
    .limit(CSV_STREAM_BATCH_SIZE)
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
  const scope = getScopedProjectId(c)
  if (!scope.ok) {
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
  }
  const { projectId } = scope

  const { campaignId, hashListId, q, startDate, endDate } = c.req.valid('query')
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
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

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

export { resultsRoutes }
