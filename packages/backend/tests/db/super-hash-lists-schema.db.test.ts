/**
 * Real-DB schema tests for the SuperHashlist entity + membership join
 * (`super_hash_lists`, `super_hash_list_members`) and the campaign
 * exactly-one-target CHECK, added by migration
 * `0042_messy_leper_queen.sql` (issue #101 — U6, KTD5, KTD6).
 *
 * Proves the SQL-level guarantees only a live database can show:
 *   - `super_hash_lists` owns NO hash-item columns (R10): the super is a
 *     read-time union, never a materialized list, so a schema drift that
 *     added `file_ref`/`statistics`/`hash_type_id`/item columns would
 *     silently reopen the "duplicate the hashes" design the plan rejected;
 *   - `UNIQUE(member_hash_list_id)` makes "a hash list belongs to at most
 *     one super" a constraint, not a service convention (R3) — while the
 *     list stays independently targetable;
 *   - `campaigns_exactly_one_target_chk` rejects both-set and neither-set
 *     and accepts exactly one of `hash_list_id` / `super_hash_list_id`
 *     (KTD6), the invariant that keeps tasks/zaps resolving to a single
 *     leaf list on the agent hot path.
 *
 * The cross-project (R5) reject path lives in
 * `super-member-tenant-trigger.db.test.ts`.
 *
 * Rejection assertions use the try/catch form (as in
 * `attack-mode-consistency.db.test.ts`), not `expect(...).rejects`: the
 * latter wraps drizzle's thenable in an extra promise hop that intermittently
 * wedges the shared postgres.js connection in this lane.
 *
 * Runs under `bun test:db` (preload: tests/preload-db.ts). cleanupSeed() in
 * afterAll keeps runs idempotent and order-independent.
 *
 * NOTE: do NOT call client.end() here — harness.test.ts owns the shared
 * drizzle client lifecycle. All db-lane files share the same client.
 */

import {
  campaigns,
  hashLists,
  projects,
  superHashListMembers,
  superHashLists,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, sql } from 'drizzle-orm'

import { db } from '../../src/db/index.js'

const TEST_SLUG = 'super-hash-lists-schema-test-proj'
const CASCADE_SLUG = 'super-hash-lists-schema-cascade-proj'

interface SeedCtx {
  projectId: number
}

let ctx: SeedCtx

async function cleanupSeed(): Promise<void> {
  // Campaigns hold `onDelete: restrict` FKs to hash_lists / super_hash_lists,
  // so they must go before the project cascade can drop those rows.
  await db
    .delete(campaigns)
    .where(
      sql`${campaigns.projectId} IN (SELECT id FROM projects WHERE slug IN (${TEST_SLUG}, ${CASCADE_SLUG}))`
    )
  await db.delete(projects).where(eq(projects.slug, TEST_SLUG))
  await db.delete(projects).where(eq(projects.slug, CASCADE_SLUG))
}

/** Runs `fn`, asserts it threw, and returns the thrown value. */
async function expectRejection(fn: () => Promise<unknown>): Promise<unknown> {
  let caught: unknown
  try {
    await fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeDefined()
  return caught
}

/** Numeric sort comparator — `Array#toSorted()` defaults to lexicographic. */
function byId(x: number, y: number): number {
  return x - y
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random()}`
}

async function insertHashList(prefix: string): Promise<number> {
  const [row] = await db
    .insert(hashLists)
    .values({ projectId: ctx.projectId, name: uniqueName(prefix), status: 'ready' })
    .returning({ id: hashLists.id })
  return row!.id
}

async function insertSuper(prefix: string): Promise<number> {
  const [row] = await db
    .insert(superHashLists)
    .values({ projectId: ctx.projectId, name: uniqueName(prefix) })
    .returning({ id: superHashLists.id })
  return row!.id
}

beforeAll(async () => {
  await cleanupSeed()
  const [project] = await db
    .insert(projects)
    .values({ name: TEST_SLUG, slug: TEST_SLUG })
    .returning({ id: projects.id })
  ctx = { projectId: project!.id }
})

afterAll(cleanupSeed)

describe('super_hash_lists schema (U6 / KTD5)', () => {
  it('migration applied: the table exists and a minimal super inserts', async () => {
    const [row] = await db
      .insert(superHashLists)
      .values({ projectId: ctx.projectId, name: uniqueName('minimal-super') })
      .returning({
        id: superHashLists.id,
        projectId: superHashLists.projectId,
        archivedAt: superHashLists.archivedAt,
        createdAt: superHashLists.createdAt,
        updatedAt: superHashLists.updatedAt,
      })

    expect(row).toBeDefined()
    expect(row!.projectId).toBe(ctx.projectId)
    // Lifecycle parity with hash lists: a fresh super is not archived.
    expect(row!.archivedAt).toBeNull()
    expect(row!.createdAt).toBeInstanceOf(Date)
    expect(row!.updatedAt).toBeInstanceOf(Date)
  })

  it('owns NO hash-item columns (R10 — the union is resolved at read time)', async () => {
    const columns = await db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'super_hash_lists'`
    )
    const names = columns.map((c) => c.column_name)

    // Exact column set — adding a column here is a deliberate decision that
    // must update this assertion, which is the point: it forecloses drifting
    // the super back into an item-owning list.
    expect(names.toSorted()).toEqual([
      'archived_at',
      'created_at',
      'id',
      'name',
      'project_id',
      'updated_at',
    ])

    // Spelled out separately so a failure names the offending concept.
    for (const forbidden of [
      'hash_type_id',
      'file_ref',
      'statistics',
      'type_analysis',
      'source',
      'status',
      'is_permanent',
      'parent_hash_list_id',
    ]) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('no hash_items row can reference a super (no such column exists)', async () => {
    const columns = await db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'hash_items'`
    )
    expect(columns.map((c) => c.column_name)).not.toContain('super_hash_list_id')
  })

  it('cascades away with its project', async () => {
    const [scratchProject] = await db
      .insert(projects)
      .values({ name: CASCADE_SLUG, slug: CASCADE_SLUG })
      .returning({ id: projects.id })
    const [scratchSuper] = await db
      .insert(superHashLists)
      .values({ projectId: scratchProject!.id, name: uniqueName('cascade-super') })
      .returning({ id: superHashLists.id })

    await db.delete(projects).where(eq(projects.id, scratchProject!.id))

    const remaining = await db
      .select({ id: superHashLists.id })
      .from(superHashLists)
      .where(eq(superHashLists.id, scratchSuper!.id))
    expect(remaining).toHaveLength(0)
  })
})

describe('super_hash_list_members — at most one super per list (R3)', () => {
  it('accepts several distinct members under one super', async () => {
    const superId = await insertSuper('multi-member-super')
    const listA = await insertHashList('member-a')
    const listB = await insertHashList('member-b')

    await db.insert(superHashListMembers).values([
      { superHashListId: superId, memberHashListId: listA },
      { superHashListId: superId, memberHashListId: listB },
    ])

    const rows = await db
      .select({ memberHashListId: superHashListMembers.memberHashListId })
      .from(superHashListMembers)
      .where(eq(superHashListMembers.superHashListId, superId))
    expect(rows.map((r) => r.memberHashListId).toSorted(byId)).toEqual(
      [listA, listB].toSorted(byId)
    )
  })

  it('rejects adding a list that is already a member of ANOTHER super', async () => {
    const superOne = await insertSuper('super-one')
    const superTwo = await insertSuper('super-two')
    const list = await insertHashList('contested-member')

    await db
      .insert(superHashListMembers)
      .values({ superHashListId: superOne, memberHashListId: list })

    await expectRejection(() =>
      db.insert(superHashListMembers).values({ superHashListId: superTwo, memberHashListId: list })
    )

    // The original membership is untouched — the unique index rejected the
    // second super rather than moving the list.
    const rows = await db
      .select({ superHashListId: superHashListMembers.superHashListId })
      .from(superHashListMembers)
      .where(eq(superHashListMembers.memberHashListId, list))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.superHashListId).toBe(superOne)
  })

  it('rejects adding the SAME list twice to the same super', async () => {
    const superId = await insertSuper('dupe-super')
    const list = await insertHashList('dupe-member')

    await db
      .insert(superHashListMembers)
      .values({ superHashListId: superId, memberHashListId: list })

    await expectRejection(() =>
      db.insert(superHashListMembers).values({ superHashListId: superId, memberHashListId: list })
    )
  })

  it('a member list stays independently targetable by its own campaign (R3)', async () => {
    const superId = await insertSuper('targetable-super')
    const list = await insertHashList('targetable-member')
    await db
      .insert(superHashListMembers)
      .values({ superHashListId: superId, memberHashListId: list })

    const [campaign] = await db
      .insert(campaigns)
      .values({
        projectId: ctx.projectId,
        name: uniqueName('direct-member-campaign'),
        hashListId: list,
      })
      .returning({ id: campaigns.id, hashListId: campaigns.hashListId })
    expect(campaign!.hashListId).toBe(list)
  })

  it('membership rows cascade away when the super is deleted, but the member list survives', async () => {
    const superId = await insertSuper('cascade-membership-super')
    const list = await insertHashList('cascade-membership-member')
    await db
      .insert(superHashListMembers)
      .values({ superHashListId: superId, memberHashListId: list })

    await db.delete(superHashLists).where(eq(superHashLists.id, superId))

    const rows = await db
      .select({ id: superHashListMembers.id })
      .from(superHashListMembers)
      .where(eq(superHashListMembers.superHashListId, superId))
    expect(rows).toHaveLength(0)

    // Deleting a super never deletes hashes — it owns none (R10).
    const survivors = await db
      .select({ id: hashLists.id })
      .from(hashLists)
      .where(eq(hashLists.id, list))
    expect(survivors).toHaveLength(1)
  })
})

describe('campaigns_exactly_one_target_chk (KTD6)', () => {
  it('accepts a campaign targeting exactly a hash list', async () => {
    const list = await insertHashList('one-target-list')
    const [row] = await db
      .insert(campaigns)
      .values({
        projectId: ctx.projectId,
        name: uniqueName('list-target-campaign'),
        hashListId: list,
      })
      .returning({ hashListId: campaigns.hashListId, superHashListId: campaigns.superHashListId })

    expect(row!.hashListId).toBe(list)
    expect(row!.superHashListId).toBeNull()
  })

  it('accepts a campaign targeting exactly a super', async () => {
    const superId = await insertSuper('one-target-super')
    const [row] = await db
      .insert(campaigns)
      .values({
        projectId: ctx.projectId,
        name: uniqueName('super-target-campaign'),
        superHashListId: superId,
      })
      .returning({ hashListId: campaigns.hashListId, superHashListId: campaigns.superHashListId })

    expect(row!.hashListId).toBeNull()
    expect(row!.superHashListId).toBe(superId)
  })

  it('rejects a campaign with BOTH a hash list and a super', async () => {
    const list = await insertHashList('both-target-list')
    const superId = await insertSuper('both-target-super')

    await expectRejection(() =>
      db.insert(campaigns).values({
        projectId: ctx.projectId,
        name: uniqueName('both-target-campaign'),
        hashListId: list,
        superHashListId: superId,
      })
    )
  })

  it('rejects a campaign with NEITHER target', async () => {
    await expectRejection(() =>
      db.insert(campaigns).values({
        projectId: ctx.projectId,
        name: uniqueName('no-target-campaign'),
      })
    )
  })

  it('rejects an UPDATE that clears the only target', async () => {
    const list = await insertHashList('update-clear-list')
    const [row] = await db
      .insert(campaigns)
      .values({
        projectId: ctx.projectId,
        name: uniqueName('update-clear-campaign'),
        hashListId: list,
      })
      .returning({ id: campaigns.id })

    await expectRejection(() =>
      db.update(campaigns).set({ hashListId: null }).where(eq(campaigns.id, row!.id))
    )
  })

  it('rejects an UPDATE that adds a second target', async () => {
    const list = await insertHashList('update-both-list')
    const superId = await insertSuper('update-both-super')
    const [row] = await db
      .insert(campaigns)
      .values({
        projectId: ctx.projectId,
        name: uniqueName('update-both-campaign'),
        hashListId: list,
      })
      .returning({ id: campaigns.id })

    await expectRejection(() =>
      db.update(campaigns).set({ superHashListId: superId }).where(eq(campaigns.id, row!.id))
    )
  })

  it('a super referenced by a campaign cannot be deleted (onDelete: restrict)', async () => {
    const superId = await insertSuper('restrict-super')
    await db.insert(campaigns).values({
      projectId: ctx.projectId,
      name: uniqueName('restrict-campaign'),
      superHashListId: superId,
    })

    await expectRejection(() => db.delete(superHashLists).where(eq(superHashLists.id, superId)))
  })
})
