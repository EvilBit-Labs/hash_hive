import { attacks, campaigns, hashItems, hashLists } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'

import type { AppEnv } from '../../types.js'

import { db } from '../../db/index.js'
import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess } from '../../middleware/rbac.js'
import {
  DASHBOARD_RESPONSE_REFS,
  sharedResponse,
  dashboardOpenApiHonoOptions,
} from '../../openapi/components.js'
import { escapeLike } from '../../services/resources.js'

const resultsRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

resultsRoutes.use('*', requireSession)
resultsRoutes.use('/', requireProjectAccess())
resultsRoutes.use('/export', requireProjectAccess())

const RESULTS_LIST_MAX_LIMIT = 100
const RESULTS_LIST_DEFAULT_LIMIT = 50

// Characters that trigger spreadsheet formula evaluation in Excel, Google
// Sheets, and LibreOffice Calc when they appear at the start of a cell.
// `plaintext` and `hashValue` are attacker-influenced data — a recovered
// password of `=cmd|...` would otherwise execute as a formula when the
// exported CSV is opened. Quote-wrapping does not neutralize this; the
// canonical mitigation is to prefix the cell with a leading apostrophe so
// spreadsheet apps treat it as literal text. See OWASP "CSV Injection".
const CSV_FORMULA_TRIGGER_REGEX = /^[=+\-@\t\r]/

function escapeCsv(val: string | null | undefined): string {
  if (val == null) return ''
  let str = String(val)
  if (CSV_FORMULA_TRIGGER_REGEX.test(str)) {
    str = `'${str}`
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

// Coerce + clamp pagination at the schema boundary so handlers stay thin.
// Permissive: invalid values fall back to defaults rather than 400 — matches
// the rest of the dashboard surface, and keeps NaN/Infinity from leaking
// into Drizzle's `.limit()`/`.offset()`.
const resultsFilterShape = {
  campaignId: z.coerce.number().int().positive().optional().catch(undefined),
  hashListId: z.coerce.number().int().positive().optional().catch(undefined),
  q: z.string().min(1).optional(),
}

const listResultsQuerySchema = z.object({
  ...resultsFilterShape,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(RESULTS_LIST_MAX_LIMIT)
    .catch(RESULTS_LIST_DEFAULT_LIMIT)
    .default(RESULTS_LIST_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).catch(0).default(0),
})

const exportResultsQuerySchema = z.object(resultsFilterShape)

type ResultsFilterInput = {
  campaignId: number | undefined
  hashListId: number | undefined
  q: string | undefined
}

// Build filter conditions from validated query params + session projectId
function buildResultFilters(projectId: number, filters: ResultsFilterInput) {
  const { campaignId, hashListId, q: search } = filters

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

  return conditions
}

// ─── Response shapes ────────────────────────────────────────────────

const resultRowSchema = z
  .object({
    id: z.number().int(),
    hashValue: z.string(),
    plaintext: z.string().nullable(),
    crackedAt: z.string().nullable(),
    hashListId: z.number().int(),
    hashListName: z.string(),
    campaignId: z.number().int().nullable(),
    campaignName: z.string().nullable(),
    attackId: z.number().int().nullable(),
    attackMode: z.number().int().nullable(),
    agentId: z.number().int().nullable(),
  })
  .passthrough()
  .openapi('CrackedResultRow')

const listResultsResponseSchema = z
  .object({
    results: z.array(resultRowSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int(),
    offset: z.number().int(),
  })
  .openapi('CrackedResultList')

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
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  },
})

resultsRoutes.openapi(listResultsRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!

  const { limit, offset, campaignId, hashListId, q } = c.req.valid('query')
  const conditions = buildResultFilters(projectId, { campaignId, hashListId, q })

  const [results, countResult] = await Promise.all([
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

  return c.json(
    {
      results,
      total: Number(countResult[0]?.count ?? 0),
      limit,
      offset,
    },
    200
  )
})

// ─── GET /results/export — CSV export of cracked results ────────────

const exportResultsRoute = createRoute({
  method: 'get',
  path: '/export',
  tags: ['Results'],
  summary: 'Stream a CSV export of cracked results (capped at 10,000 rows)',
  security: [{ SessionCookie: [] }],
  request: { query: exportResultsQuerySchema },
  responses: {
    200: {
      description: 'CSV file with one row per cracked hash, capped at 10,000 rows.',
      content: { 'text/csv': { schema: z.string() } },
    },
    401: sharedResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
    403: sharedResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
  },
})

resultsRoutes.openapi(exportResultsRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!

  const { campaignId, hashListId, q } = c.req.valid('query')
  const conditions = buildResultFilters(projectId, { campaignId, hashListId, q })

  const results = await db
    .select({
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
    .where(and(...conditions))
    .orderBy(desc(hashItems.crackedAt))
    .limit(10_000) // Cap CSV export

  // Build CSV
  const csvHeader = 'hash_value,plaintext,campaign,attack_mode,hash_list,cracked_at\n'
  const csvRows = results.map((r) =>
    [
      escapeCsv(r.hashValue),
      escapeCsv(r.plaintext),
      escapeCsv(r.campaignName),
      r.attackMode != null ? String(r.attackMode) : '',
      escapeCsv(r.hashListName),
      r.crackedAt ? new Date(r.crackedAt).toISOString() : '',
    ].join(',')
  )

  const csv = csvHeader + csvRows.join('\n')
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="results-${timestamp}.csv"`,
    },
  })
})

export { resultsRoutes }
