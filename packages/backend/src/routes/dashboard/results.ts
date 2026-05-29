import { attacks, campaigns, hashItems, hashLists } from '@hashhive/shared'
import { zValidator } from '@hono/zod-validator'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import type { AppEnv } from '../../types.js'

import { db } from '../../db/index.js'
import { requireSession } from '../../middleware/auth.js'
import { requireProjectAccess } from '../../middleware/rbac.js'
import { escapeLike } from '../../services/resources.js'

const resultsRoutes = new Hono<AppEnv>()

resultsRoutes.use('*', requireSession)

const RESULTS_LIST_MAX_LIMIT = 100
const RESULTS_LIST_DEFAULT_LIMIT = 50

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

// GET /results — paginated cracked results with attribution
resultsRoutes.get(
  '/',
  requireProjectAccess(),
  zValidator('query', listResultsQuerySchema),
  async (c) => {
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

    return c.json({
      results,
      total: Number(countResult[0]?.count ?? 0),
      limit,
      offset,
    })
  }
)

// GET /results/export — CSV export of cracked results
resultsRoutes.get(
  '/export',
  requireProjectAccess(),
  zValidator('query', exportResultsQuerySchema),
  async (c) => {
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
    const csvRows = results.map((r) => {
      const escapeCsv = (val: string | null | undefined) => {
        if (val == null) return ''
        const str = String(val)
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`
        }
        return str
      }

      return [
        escapeCsv(r.hashValue),
        escapeCsv(r.plaintext),
        escapeCsv(r.campaignName),
        r.attackMode != null ? String(r.attackMode) : '',
        escapeCsv(r.hashListName),
        r.crackedAt ? new Date(r.crackedAt).toISOString() : '',
      ].join(',')
    })

    const csv = csvHeader + csvRows.join('\n')
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="results-${timestamp}.csv"`,
      },
    })
  }
)

export { resultsRoutes }
