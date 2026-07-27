/**
 * Real-DB schema tests for the maintained per-project cracked-set
 * (`project_cracked_hashes`, SuperHashlists Layer one — U1).
 *
 * Proves the SQL-level guarantees the crack-once feature depends on and
 * that only a live database can show:
 *   - the dedup UNIQUE `(project_id, hashcat_mode, hash_value)` — including
 *     that the SAME hash value under two DIFFERENT hashcat modes inserts as
 *     two distinct rows (AE1: mode-keyed distinctness at the constraint level);
 *   - the keyset index `(project_id, hashcat_mode, cracked_at, id)` is present
 *     and chosen by the planner for the widened zap scan shape (KTD4), i.e. an
 *     Index Cond seek rather than a Seq Scan.
 *
 * Runs under `bun test:db` (preload: tests/preload-db.ts). cleanupSeed() in
 * afterAll keeps runs idempotent and order-independent.
 *
 * NOTE: do NOT call client.end() here — harness.test.ts owns the shared
 * drizzle client lifecycle. All db-lane files share the same client.
 */

import { projectCrackedHashes, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, sql } from 'drizzle-orm'

import { db } from '../../src/db/index.js'

const TEST_SLUG = 'project-cracked-hashes-schema-test-proj'
const MODE_MD5 = 0
const MODE_NTLM = 1000

interface SeedCtx {
  projectId: number
}

let ctx: SeedCtx

async function cleanupSeed(): Promise<void> {
  // Project cascade removes project_cracked_hashes rows in one delete.
  await db.delete(projects).where(eq(projects.slug, TEST_SLUG))
}

beforeAll(async () => {
  await cleanupSeed()
  const [project] = await db
    .insert(projects)
    .values({ name: TEST_SLUG, slug: TEST_SLUG })
    .returning({ id: projects.id })
  ctx = { projectId: project!.id }
})

afterAll(async () => {
  await cleanupSeed()
})

describe('project_cracked_hashes schema (U1)', () => {
  it('accepts a cracked-set row with an application-stamped crackedAt', async () => {
    const now = new Date()
    const [row] = await db
      .insert(projectCrackedHashes)
      .values({
        projectId: ctx.projectId,
        hashcatMode: MODE_MD5,
        hashValue: 'accepts-basic-insert',
        plaintext: 'secret',
        crackedAt: now,
        originalCrackedAt: now,
      })
      .returning({ id: projectCrackedHashes.id, crackedAt: projectCrackedHashes.crackedAt })
    expect(row?.id).toBeGreaterThan(0)
    // crackedAt is application-stamped (KTD2): it round-trips the JS Date, not a
    // DB-side now(). Millisecond alignment is what makes the zap cursor exact.
    expect(row?.crackedAt?.getTime()).toBe(now.getTime())
  })

  it('rejects a duplicate (projectId, hashcatMode, hashValue) insert', async () => {
    const value = 'dup-key-value'
    const now = new Date()
    await db.insert(projectCrackedHashes).values({
      projectId: ctx.projectId,
      hashcatMode: MODE_MD5,
      hashValue: value,
      plaintext: 'first',
      crackedAt: now,
    })

    let threw = false
    try {
      await db.insert(projectCrackedHashes).values({
        projectId: ctx.projectId,
        hashcatMode: MODE_MD5,
        hashValue: value,
        plaintext: 'second',
        crackedAt: new Date(),
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('Covers AE1: the same hash value under two hashcat modes inserts as two distinct rows', async () => {
    const value = 'e10adc3949ba59abbe56e057f20f883e' // a 32-hex string: raw-MD5 OR NTLM
    const now = new Date()
    await db.insert(projectCrackedHashes).values([
      {
        projectId: ctx.projectId,
        hashcatMode: MODE_MD5,
        hashValue: value,
        plaintext: 'md5-plaintext',
        crackedAt: now,
      },
      {
        projectId: ctx.projectId,
        hashcatMode: MODE_NTLM,
        hashValue: value,
        plaintext: 'ntlm-plaintext',
        crackedAt: now,
      },
    ])

    const rows = await db
      .select({
        hashcatMode: projectCrackedHashes.hashcatMode,
        plaintext: projectCrackedHashes.plaintext,
      })
      .from(projectCrackedHashes)
      .where(
        and(
          eq(projectCrackedHashes.projectId, ctx.projectId),
          eq(projectCrackedHashes.hashValue, value)
        )
      )
    expect(rows.length).toBe(2)
    const byMode = new Map(rows.map((r) => [r.hashcatMode, r.plaintext]))
    // Neither mode's crack marks or overwrites the other's.
    expect(byMode.get(MODE_MD5)).toBe('md5-plaintext')
    expect(byMode.get(MODE_NTLM)).toBe('ntlm-plaintext')
  })

  it('uses the keyset index for the widened project+mode zap scan (Index Cond seek, not Seq Scan)', async () => {
    // EXPLAIN the exact shape services/tasks/zaps.ts will run (KTD4): filter on
    // (project_id, hashcat_mode) then walk (cracked_at, id) ASC. The planner
    // must satisfy this from project_cracked_hashes_keyset_idx.
    const plan = await db.execute(sql`
      EXPLAIN
      SELECT hash_value, id, cracked_at
      FROM project_cracked_hashes
      WHERE project_id = ${ctx.projectId} AND hashcat_mode = ${MODE_MD5}
      ORDER BY cracked_at ASC, id ASC
      LIMIT 100
    `)
    const planText = (plan as unknown as Array<Record<string, string>>)
      .map((r) => Object.values(r).join(' '))
      .join('\n')
    expect(planText).toContain('project_cracked_hashes_keyset_idx')
    expect(planText).not.toContain('Seq Scan')
  })
})
