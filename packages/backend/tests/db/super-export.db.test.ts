/**
 * Real-DB tests for U14 — exporting a SuperHashlist yields its DEDUPLICATED
 * UNION with crack state resolved through the project cracked-set (U4).
 * (SuperHashlists, R1 / R15, issue #101 / #101-related U14.)
 *
 * These prove the SQL-level behavior the export service's unit tests (which
 * inject fetchers) cannot exercise:
 *
 *   1. Dedup: a super over lists A+B returns each `(mode, value)` ONCE with the
 *      resolved plaintext — a value present in both members collapses to one row.
 *   2. Cross-list fill (R15): a value cracked only in a SIBLING (recorded in the
 *      project cracked-set, its own `hash_items.crackedAt` NULL) exports as
 *      cracked with the set's plaintext.
 *   3. Distinct-mode (reinforces AE1): the SAME hash string under two different
 *      hashcat modes exports as TWO distinct rows — the dedup key is
 *      `(mode, value)`, never the value alone.
 *
 * Also covers the `uncracked` and `plaintext-only` variants over the same union.
 *
 * The cracked-set is populated by DIRECT INSERTS into `project_cracked_hashes`
 * (mirroring how the U2 write path stamps it), matching `crack-resolution.db.test.ts`.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts) with the shared
 * drizzle client. Do NOT call client.end() — the pooled client is process-wide.
 * Do NOT self-skip — the test-db lane always has Postgres available.
 */

import {
  hashItems,
  hashLists,
  projectCrackedHashes,
  projects,
  superHashListMembers,
  superHashLists,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, sql } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { createExport } from '../../src/services/results/export.js'

const SLUG = 'super-export-test-proj'

// Modes unique to this file (9_614_00x) so a stray row from another db-lane file
// sharing a hash value can never satisfy a `(mode, value)` lookup here.
const MODE_X = 9_614_001
const MODE_Y = 9_614_002

let projectId = 0
let superId = 0
let listAId = 0
let listBId = 0

async function cleanup(): Promise<void> {
  // Project cascade removes hashLists/hash_items, project_cracked_hashes, and
  // super_hash_lists (+ members) — all FK ON DELETE CASCADE to projectId.
  await db.delete(projects).where(eq(projects.slug, SLUG))
}

async function createList(name: string): Promise<number> {
  const [row] = await db
    .insert(hashLists)
    .values({ projectId, name, status: 'ready' })
    .returning({ id: hashLists.id })
  return row!.id
}

async function insertItem(
  hashListId: number,
  hashValue: string,
  mode: number | null,
  opts: { crackedAt?: Date | null; plaintext?: string | null } = {}
): Promise<void> {
  await db.insert(hashItems).values({
    hashListId,
    hashValue,
    detectedHashcatMode: mode,
    crackedAt: opts.crackedAt ?? null,
    plaintext: opts.plaintext ?? null,
  })
}

/** Record a crack in the project cracked-set as if submitted against `sourceHashListId`. */
async function recordCrack(
  mode: number,
  hashValue: string,
  plaintext: string,
  sourceHashListId: number
): Promise<void> {
  await db.insert(projectCrackedHashes).values({
    projectId,
    hashcatMode: mode,
    hashValue,
    plaintext,
    crackedAt: new Date(),
    originalCrackedAt: new Date('2026-01-02T03:04:05.000Z'),
    sourceHashListId,
  })
}

/** Drain a super export into its lines (CSV: lines[0] is the header). */
async function exportLines(
  variant: 'cracked-pairs' | 'plaintext-only' | 'uncracked',
  format: 'csv' | 'hashcat-potfile' = 'csv',
  filters?: { startDate?: string; endDate?: string }
): Promise<string[]> {
  const { rows } = await createExport(db, {
    scope: 'super',
    projectId,
    superHashListId: superId,
    variant,
    format,
    ...(filters ? { filters } : {}),
  })
  const lines: string[] = []
  for await (const line of rows) lines.push(line)
  return lines
}

beforeAll(async () => {
  await cleanup()
  const [proj] = await db
    .insert(projects)
    .values({ name: 'super-export test project', slug: SLUG })
    .returning({ id: projects.id })
  projectId = proj!.id

  listAId = await createList('super-export-list-a')
  listBId = await createList('super-export-list-b')

  const [superRow] = await db
    .insert(superHashLists)
    .values({ projectId, name: 'super-export-super' })
    .returning({ id: superHashLists.id })
  superId = superRow!.id
  await db.insert(superHashListMembers).values([
    { superHashListId: superId, memberHashListId: listAId },
    { superHashListId: superId, memberHashListId: listBId },
  ])

  // ── List A ──────────────────────────────────────────────────────────────
  // Scenario 1: duplicate (mode,value) across members — cracked in A's own row.
  await insertItem(listAId, 'dupval', MODE_X, {
    crackedAt: new Date('2026-03-01T00:00:00.000Z'),
    plaintext: 'dupplain',
  })
  // Scenario 2: cracked ONLY in a sibling — A's own row is uncracked, resolves
  // via the project cracked-set.
  await insertItem(listAId, 'sibval', MODE_X)
  // Scenario 3: same string, mode X — cracked in A's own row.
  await insertItem(listAId, 'collide', MODE_X, {
    crackedAt: new Date('2026-03-01T00:00:00.000Z'),
    plaintext: 'plainX',
  })
  // Uncracked union: present uncracked in BOTH members (dedup) + a single one.
  await insertItem(listAId, 'bothuncracked', MODE_X)
  await insertItem(listAId, 'onlyauncr', MODE_X)

  // ── List B ──────────────────────────────────────────────────────────────
  // Scenario 1: the duplicate again, uncracked own row → resolves via the set.
  await insertItem(listBId, 'dupval', MODE_X)
  // Scenario 3: same string, mode Y — cracked in B's own row.
  await insertItem(listBId, 'collide', MODE_Y, {
    crackedAt: new Date('2026-03-01T00:00:00.000Z'),
    plaintext: 'plainY',
  })
  // Uncracked dedup partner.
  await insertItem(listBId, 'bothuncracked', MODE_X)

  // ── Project cracked-set (as U2 would have stamped) ────────────────────────
  await recordCrack(MODE_X, 'dupval', 'dupplain', listAId)
  await recordCrack(MODE_X, 'sibval', 'sibplain', listBId)
  await recordCrack(MODE_X, 'collide', 'plainX', listAId)
  await recordCrack(MODE_Y, 'collide', 'plainY', listBId)
})

afterAll(async () => {
  await cleanup()
})

describe('super export — cracked-pairs (deduplicated union + U4 resolution)', () => {
  it('returns each (mode, value) once with the resolved plaintext', async () => {
    const lines = await exportLines('cracked-pairs')
    expect(lines[0]).toBe(
      'hash_value,plaintext,username,source,campaign,attack,hash_list,cracked_at'
    )
    const data = lines.slice(1)

    // hash_value = col0, plaintext = col1, cracked_at = last col.
    const parsed = data.map((l) => {
      const cols = l.split(',')
      return { hashValue: cols[0]!, plaintext: cols[1]!, crackedAt: cols[cols.length - 1]! }
    })

    // Scenario 1 — dedup: 'dupval' appears exactly ONCE across A+B.
    const dupRows = parsed.filter((r) => r.hashValue === 'dupval')
    expect(dupRows).toHaveLength(1)
    expect(dupRows[0]!.plaintext).toBe('dupplain')

    // Scenario 2 — cross-list fill: 'sibval' (own crackedAt NULL) exports cracked
    // with the sibling's plaintext and a resolved crack timestamp.
    const sibRows = parsed.filter((r) => r.hashValue === 'sibval')
    expect(sibRows).toHaveLength(1)
    expect(sibRows[0]!.plaintext).toBe('sibplain')
    expect(sibRows[0]!.crackedAt).not.toBe('')

    // Scenario 3 — distinct modes for the same string export as TWO rows.
    const collideRows = parsed.filter((r) => r.hashValue === 'collide')
    expect(collideRows).toHaveLength(2)
    expect(new Set(collideRows.map((r) => r.plaintext))).toEqual(new Set(['plainX', 'plainY']))

    // Total cracked-and-deduped rows: dupval, sibval, collideX, collideY.
    expect(data).toHaveLength(4)
  })

  it('plaintext-only yields the deduped resolved plaintexts', async () => {
    const lines = await exportLines('plaintext-only')
    expect(lines[0]).toBe('plaintext')
    const data = lines.slice(1)
    expect(new Set(data)).toEqual(new Set(['dupplain', 'sibplain', 'plainX', 'plainY']))
    expect(data).toHaveLength(4)
  })
})

describe('super export — uncracked (deduplicated union, cracked-anywhere excluded)', () => {
  it('returns each uncracked (mode, value) once and excludes values cracked in a sibling', async () => {
    const lines = await exportLines('uncracked')
    expect(lines[0]).toBe('hash_value')
    const data = lines.slice(1)

    // 'bothuncracked' present uncracked in BOTH members → collapses to one row.
    expect(data.filter((v) => v === 'bothuncracked')).toHaveLength(1)
    // 'onlyauncr' present once.
    expect(data.filter((v) => v === 'onlyauncr')).toHaveLength(1)
    // 'sibval' resolves cracked via the project cracked-set → excluded here.
    expect(data).not.toContain('sibval')
    // Cracked values never appear in the uncracked union.
    expect(data).not.toContain('dupval')
    expect(data).not.toContain('collide')

    expect(new Set(data)).toEqual(new Set(['bothuncracked', 'onlyauncr']))
    expect(data).toHaveLength(2)
  })
})

describe('super export — date-range filter on the resolved crack timestamp (CRITICAL fix)', () => {
  it('a startDate/endDate filter narrows the deduped rows and does NOT throw ERR_INVALID_ARG_TYPE', async () => {
    // Two OWN-ROW-cracked values (no cracked-set counterpart, so their
    // resolved timestamp is unambiguously their own `crackedAt` — unlike
    // 'dupval'/'sibval' above, which partly resolve through the cracked-set's
    // shared `recordCrack()` timestamp).
    await insertItem(listAId, 'dateearly', MODE_X, {
      crackedAt: new Date('2026-01-15T00:00:00.000Z'),
      plaintext: 'earlyplain',
    })
    await insertItem(listAId, 'datelate', MODE_X, {
      crackedAt: new Date('2026-04-01T00:00:00.000Z'),
      plaintext: 'lateplain',
    })

    // A range spanning only January must include 'dateearly' and exclude
    // 'datelate' — proving the filter is applied against the RESOLVED crack
    // timestamp without the bare-Date-vs-raw-SQL-expression crash the fix
    // addresses (this query previously threw `ERR_INVALID_ARG_TYPE`).
    const lines = await exportLines('cracked-pairs', 'csv', {
      startDate: '2026-01-01T00:00:00.000Z',
      endDate: '2026-01-31T00:00:00.000Z',
    })
    expect(lines[0]).toBe(
      'hash_value,plaintext,username,source,campaign,attack,hash_list,cracked_at'
    )
    const hashValues = lines.slice(1).map((l) => l.split(',')[0])
    expect(hashValues).toContain('dateearly')
    expect(hashValues).not.toContain('datelate')
  })

  it('a range covering every crack returns the full deduped set (upper + lower bound both apply)', async () => {
    const lines = await exportLines('cracked-pairs', 'csv', {
      startDate: '2025-01-01T00:00:00.000Z',
      endDate: '2027-01-01T00:00:00.000Z',
    })
    const hashValues = lines.slice(1).map((l) => l.split(',')[0])
    // Same rows as the unfiltered case (plus this describe block's own
    // `dateearly`/`datelate` fixtures, both within range): dupval, sibval,
    // 'collide' twice (once per distinct hashcat mode, AE1), dateearly, datelate.
    expect(hashValues.filter((v) => v === 'dupval')).toHaveLength(1)
    expect(hashValues.filter((v) => v === 'sibval')).toHaveLength(1)
    expect(hashValues.filter((v) => v === 'collide')).toHaveLength(2)
    expect(hashValues).toContain('dateearly')
    expect(hashValues).toContain('datelate')
  })

  it('a range excluding every crack returns an empty deduped set', async () => {
    const lines = await exportLines('cracked-pairs', 'csv', {
      startDate: '1999-01-01T00:00:00.000Z',
      endDate: '1999-01-02T00:00:00.000Z',
    })
    expect(lines.slice(1)).toHaveLength(0)
  })
})

describe('super export — keyset index proof', () => {
  it('EXPLAIN: a first-page multi-leaf scan filters by hash_list_id, not a Seq Scan (no keyset bound yet)', async () => {
    // Seed a batch across BOTH members so the planner reasons about a real
    // multi-leaf union, not a single-list scan.
    for (let i = 0; i < 30; i++) {
      await insertItem(listAId, `explain-a-${String(i).padStart(5, '0')}`, MODE_X)
      await insertItem(listBId, `explain-b-${String(i).padStart(5, '0')}`, MODE_X)
    }
    // `enable_seqscan = off` (transaction-local) makes this deterministic —
    // on a small table the planner would otherwise prefer a Seq Scan on
    // row-count cost alone.
    //
    // The FIRST page of a super export has no keyset cursor yet — just
    // `hash_list_id IN (leaves)` — and `hash_list_id` leads BOTH
    // `hash_items_hash_list_id_idx` and the composite
    // `hash_items_super_export_keyset_idx`. With more than one leaf, the
    // composite index's trailing `(mode, value)` columns can't produce a
    // single globally-sorted stream across leaves (it sorts within each
    // hash_list_id group, not across groups), so an explicit Sort is
    // unavoidable either way and the planner correctly reaches for the
    // narrower single-column index to satisfy the `hash_list_id IN (...)`
    // filter. This still proves the query is an Index Cond seek, never a
    // full Seq Scan.
    const planText = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`)
      const plan = await tx.execute(sql`
        EXPLAIN
        SELECT id, hash_value
        FROM hash_items
        WHERE hash_list_id IN (${listAId}, ${listBId})
        ORDER BY coalesce(detected_hashcat_mode, -1) ASC, hash_value ASC, id ASC
        LIMIT 100
      `)
      return (plan as unknown as Array<Record<string, string>>)
        .map((r) => Object.values(r).join(' '))
        .join('\n')
    })
    expect(planText).toContain('Index Cond')
    expect(planText).not.toContain('Seq Scan')
  })

  it('EXPLAIN: a subsequent (keyset-cursored) page is an Index Cond seek on hash_items_super_export_keyset_idx', async () => {
    // Same multi-leaf seed as the first-page case above; this test asserts
    // against the SAME rows (each `it` in a bun:test file shares the
    // module's beforeAll/afterAll fixtures, and the prior test's insert
    // already landed, but re-seed defensively so this test is order-independent).
    for (let i = 30; i < 60; i++) {
      await insertItem(listAId, `explain-a-${String(i).padStart(5, '0')}`, MODE_X)
      await insertItem(listBId, `explain-b-${String(i).padStart(5, '0')}`, MODE_X)
    }
    const cursorHashValue = 'explain-a-00010'
    // ANALYZE so the planner has real selectivity stats for this freshly
    // seeded batch — without it, stale/default stats can make the row-value
    // keyset Index Cond look no cheaper than the single-column
    // `hash_list_id` index + a residual Filter, masking the property this
    // test exists to prove (matches how a live table accumulates stats via
    // autovacuum long before it holds export-scale data).
    await db.execute(sql`ANALYZE hash_items`)
    // A page-2+ fetch adds the row-value keyset predicate
    // `(coalesce(mode,-1), hash_value) > (cursor.coalescedMode, cursor.hashValue)`
    // (`superKeysetPredicate` in services/results/export.ts). That predicate's
    // columns match the composite index's trailing columns exactly, so —
    // unlike the cursor-less first page — the planner CAN use
    // `hash_items_super_export_keyset_idx` to satisfy both the
    // `hash_list_id IN (leaves)` filter and the keyset bound as a single
    // Index Cond, which is what makes the export's paginated walk cheap
    // instead of re-sorting the whole filtered set on every page.
    const planText = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`)
      const plan = await tx.execute(sql`
        EXPLAIN
        SELECT id, hash_value
        FROM hash_items
        WHERE hash_list_id IN (${listAId}, ${listBId})
          AND (coalesce(detected_hashcat_mode, -1), hash_value) > (${MODE_X}, ${cursorHashValue})
        ORDER BY coalesce(detected_hashcat_mode, -1) ASC, hash_value ASC, id ASC
        LIMIT 100
      `)
      return (plan as unknown as Array<Record<string, string>>)
        .map((r) => Object.values(r).join(' '))
        .join('\n')
    })
    expect(planText).toContain('hash_items_super_export_keyset_idx')
    expect(planText).not.toContain('Seq Scan')
  })
})
