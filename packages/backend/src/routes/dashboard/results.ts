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

resultsRoutes.use('*', requireSession)
resultsRoutes.use('/', requireProjectAccess())
resultsRoutes.use('/export', requireProjectAccess())

const RESULTS_LIST_MAX_LIMIT = 100
const RESULTS_LIST_DEFAULT_LIMIT = 50

// Streaming CSV batch size. At ~200 bytes per CSV row this keeps the
// per-pull memory footprint around 200 KB regardless of total result
// count; the consumer drains between batches via standard
// ReadableStream backpressure.
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
// formula triggers, so a quoted value like `"\n=HYPERLINK(...)"` would
// otherwise evaluate as a formula. See OWASP "CSV Injection".
const CSV_FORMULA_TRIGGER_REGEX = /^[=+\-@\t\r\n]/

function escapeCsv(val: string | null | undefined): string {
  if (val == null) return ''
  let str = val
  if (CSV_FORMULA_TRIGGER_REGEX.test(str)) {
    str = `'${str}`
  }
  // Quote-wrap on any RFC 4180 special: comma, double-quote, LF, or CR.
  // Bare CR splits the row in spreadsheet parsers; double the inner
  // double-quotes per RFC 4180.
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

// Coerce + clamp pagination at the schema boundary so handlers stay thin.
// Permissive: invalid values fall back to defaults rather than 400 — matches
// the rest of the dashboard surface, and keeps NaN/Infinity from leaking
// into Drizzle's `.limit()`/`.offset()`. Annotated via `coercedIntegerQuery`
// / `coercedOptionalPositiveIntegerQuery` so the OpenAPI generator can
// emit a serializable schema (see openapi/coerced-query.ts).
const resultsFilterShape = {
  campaignId: coercedOptionalPositiveIntegerQuery(),
  hashListId: coercedOptionalPositiveIntegerQuery(),
  q: z.string().min(1).optional(),
  // ISO 8601 datetime, both boundaries inclusive. Out-of-range or invalid
  // values fall through Zod's optional + datetime() to undefined; the
  // resulting filter is a no-op rather than 400.
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
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

interface ResultsFilterInput {
  campaignId: number | undefined
  hashListId: number | undefined
  q: string | undefined
  startDate: string | undefined
  endDate: string | undefined
}

// Build filter conditions from validated query params + session projectId.
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

// ─── GET /results — paginated cracked results with attribution ──────

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
  const { projectId } = c.get('scopedUser')!

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

  // Resolve attackModeName from the shared static map (cheap JS lookup;
  // hashcat attack modes are a small stable set, no SQL JOIN needed).
  // Spread, not Object.assign — project's immutability rule applies
  // even to intermediate DB-row objects.
  // oxlint-disable-next-line oxc/no-map-spread -- immutability over perf nudge here; rawResults are local Drizzle rows that we don't want to mutate in case anything downstream caches them
  const results = rawResults.map((row) => ({
    ...row,
    attackModeName: resolveAttackModeName(row.attackMode),
  }))

  return c.json(
    {
      results,
      // postgres-js returns count(*) as a string; Drizzle's `sql<number>`
      // is a compile-time cast that does NOT convert at runtime. Without
      // this wrapper `total` would ship as a string (e.g., "42") and
      // violate listResultsResponseSchema's `total: number`. Same as
      // dashboard/stats.ts.
      total: Number(countResult[0]?.count ?? 0),
      limit,
      offset,
    },
    200
  )
})

// ─── GET /results/export — streaming CSV export of cracked results ──

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

type CsvBatchRow = {
  id: number
  hashValue: string
  plaintext: string | null
  crackedAt: Date | null
  hashListName: string
  campaignName: string | null
  attackMode: number | null
}

/**
 * Fetch one batch of cracked rows for the streaming export. Uses keyset
 * pagination on `(crackedAt DESC, id DESC)` so batches never re-fetch a
 * row across the cursor boundary even when many rows share a `crackedAt`
 * value (the `id` tiebreaker is load-bearing for the streaming
 * correctness test in U5).
 *
 * Drizzle's query-builder operator set is single-column, so the
 * row-value comparison `(cracked_at, id) < (cursor.crackedAt, cursor.id)`
 * is expressed as the equivalent boolean expansion:
 *   `crackedAt < cursor.crackedAt OR (crackedAt = cursor.crackedAt AND id < cursor.id)`.
 */
async function fetchCsvBatch(
  projectId: number,
  filters: ResultsFilterInput,
  cursor: { crackedAt: Date; id: number } | null
): Promise<CsvBatchRow[]> {
  const baseConditions = buildResultFilters(projectId, filters)
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

function encodeBatchAsCsv(batch: readonly CsvBatchRow[]): string {
  return batch
    .map((r) =>
      [
        escapeCsv(r.hashValue),
        escapeCsv(r.plaintext),
        escapeCsv(r.campaignName),
        escapeCsv(resolveAttackModeName(r.attackMode)),
        escapeCsv(r.hashListName),
        r.crackedAt ? r.crackedAt.toISOString() : '',
      ].join(',')
    )
    .join('\n')
}

const CSV_HEADER_LINE = 'hash_value,plaintext,campaign,attack,hash_list,cracked_at\n'

resultsRoutes.openapi(exportResultsRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!

  const { campaignId, hashListId, q, startDate, endDate } = c.req.valid('query')
  const filters: ResultsFilterInput = { campaignId, hashListId, q, startDate, endDate }

  const encoder = new TextEncoder()
  let cursor: { crackedAt: Date; id: number } | null = null
  let headerSent = false

  // All work in `pull` so bytes flow lazily. Running header emission or
  // I/O in `start` would `await` before the first byte ships, which
  // defeats streaming. On client disconnect, the safety net is
  // structural: each `pull` awaits one batch query, so a disconnect
  // either arrives between batches (next `pull` never fires) or during
  // a batch (the awaited promise resolves, releases the connection,
  // then the stream's cancel flag stops further pulls).
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        controller.enqueue(encoder.encode(CSV_HEADER_LINE))
        headerSent = true
      }
      const batch = await fetchCsvBatch(projectId, filters, cursor)
      if (batch.length === 0) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(`${encodeBatchAsCsv(batch)}\n`))
      const last = batch[batch.length - 1]!
      if (last.crackedAt !== null) {
        cursor = { crackedAt: last.crackedAt, id: last.id }
      } else {
        // Defensive: `crackedAt IS NOT NULL` is in the WHERE clause, so
        // this branch should be unreachable. If it ever fires (filter
        // refactor regression), close the stream rather than spin.
        controller.close()
      }
    },
  })

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="results-${timestamp}.csv"`,
      // Long-running streams are explicit: tell intermediaries not to
      // buffer the response, and clients not to cache.
      'X-Accel-Buffering': 'no',
      'Cache-Control': 'no-store',
    },
  })
})

export { resultsRoutes }
