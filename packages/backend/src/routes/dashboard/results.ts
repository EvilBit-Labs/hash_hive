import { attacks, campaigns, hashItems, hashLists } from '@hashhive/shared';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { requireSession } from '../../middleware/auth.js';
import { requireProjectAccess } from '../../middleware/rbac.js';
import { escapeLike } from '../../services/resources.js';
import type { AppEnv } from '../../types.js';

const resultsRoutes = new Hono<AppEnv>();

resultsRoutes.use('*', requireSession);

// Build filter conditions from query params + session projectId
function buildResultFilters(
  projectId: number,
  c: { req: { query: (key: string) => string | undefined } }
) {
  const campaignId = c.req.query('campaignId') ? Number(c.req.query('campaignId')) : undefined;
  const hashListId = c.req.query('hashListId') ? Number(c.req.query('hashListId')) : undefined;
  const search = c.req.query('q') ?? undefined;

  const conditions = [eq(campaigns.projectId, projectId), isNotNull(hashItems.crackedAt)];

  if (campaignId) {
    conditions.push(eq(hashItems.campaignId, campaignId));
  }
  if (hashListId) {
    conditions.push(eq(hashItems.hashListId, hashListId));
  }
  if (search) {
    const escaped = escapeLike(search);
    conditions.push(
      sql`(${hashItems.hashValue} ILIKE ${`%${escaped}%`} ESCAPE '\\' OR ${hashItems.plaintext} ILIKE ${`%${escaped}%`} ESCAPE '\\')`
    );
  }

  return conditions;
}

// GET /results — paginated cracked results with attribution
resultsRoutes.get('/', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('currentUser');
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400);
  }

  const limit = Math.min(Number(c.req.query('limit') ?? 50), 100);
  const offset = Number(c.req.query('offset') ?? 0);
  const conditions = buildResultFilters(projectId, c);

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
  ]);

  return c.json({
    results,
    total: Number(countResult[0]?.count ?? 0),
    limit,
    offset,
  });
});

// GET /results/export — CSV export of cracked results
resultsRoutes.get('/export', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('currentUser');
  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400);
  }

  const conditions = buildResultFilters(projectId, c);

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
    .limit(10_000); // Cap CSV export

  // Build CSV
  const csvHeader = 'hash_value,plaintext,campaign,attack_mode,hash_list,cracked_at\n';
  const csvRows = results.map((r) => {
    const escapeCsv = (val: string | null | undefined) => {
      if (val == null) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    return [
      escapeCsv(r.hashValue),
      escapeCsv(r.plaintext),
      escapeCsv(r.campaignName),
      r.attackMode != null ? String(r.attackMode) : '',
      escapeCsv(r.hashListName),
      r.crackedAt ? new Date(r.crackedAt).toISOString() : '',
    ].join(',');
  });

  const csv = csvHeader + csvRows.join('\n');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="results-${timestamp}.csv"`,
    },
  });
});

export { resultsRoutes };
