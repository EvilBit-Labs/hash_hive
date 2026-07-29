/**
 * Real-DB tests for issue #101 U12 — add-member retroactive reconciliation (R9,
 * AE3).
 *
 * When a hash list is added as a super member, its already-cracked hashes are
 * backfilled into the project cracked-set (`addMember` → U2's
 * `backfillCrackedSetFromMember`), so an uncracked duplicate of the same
 * `(mode, value)` in a sibling member immediately resolves cracked at read time
 * (U4) with NO re-attack.
 *
 * Covers:
 *   - AE3: list B (already-cracked `H`) added to a super whose sibling list A
 *     holds an uncracked duplicate of `H` (same mode) → list A's `H` resolves
 *     cracked via `resolveCrackState` right after the add commits.
 *   - Insert-monotonic keyset (KTD2 / adversarial F1): the backfilled row's
 *     `cracked_at` is stamped NOW (>= the historical crack), while
 *     `original_cracked_at` preserves the member's historical crack time.
 *   - Idempotency: re-running the backfill inserts no new rows and never moves
 *     `cracked_at`.
 *   - Mode discrimination (AE1): an already-cracked value under a DIFFERENT mode
 *     does not mark the uncracked duplicate.
 *   - No-mode / uncracked items never enter the set (KTD3).
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the shared
 * drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */

import {
  hashItems,
  hashLists,
  projectCrackedHashes,
  projects,
  superHashLists,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { resolveCrackState } from '../../src/services/hash-items/crack-resolution.js'
import { backfillCrackedSetFromMember } from '../../src/services/hash-items/cracked-set.js'
import { addMember } from '../../src/services/super-hash-lists.js'

const SLUG = 'super-add-member-reconcile-proj'

// Modes unique to this file so a stray row from another db-lane file sharing a
// value can never satisfy a `(mode, value)` cracked-set lookup here.
const MODE_A = 9_812_000
const MODE_B = 9_812_001

let projId = 0
let seq = 0

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG))
}

async function createList(name: string): Promise<number> {
  seq += 1
  const [row] = await db
    .insert(hashLists)
    .values({ projectId: projId, name: `${name}-${seq}`, status: 'ready' })
    .returning({ id: hashLists.id })
  return row!.id
}

/**
 * Create a #202 split PARENT hash list plus one CHILD (`parentHashListId`
 * pointing at the parent). Mirrors what campaign-split leaves behind: the
 * parent is an empty shell (no `hash_items` of its own) and its cracked items
 * live on the child.
 */
async function createSplitParentWithChild(
  name: string
): Promise<{ parentId: number; childId: number }> {
  const parentId = await createList(`${name}-parent`)
  seq += 1
  const [child] = await db
    .insert(hashLists)
    .values({
      projectId: projId,
      name: `${name}-child-${seq}`,
      status: 'ready',
      parentHashListId: parentId,
    })
    .returning({ id: hashLists.id })
  return { parentId, childId: child!.id }
}

/** Insert one hash item, cracked or not, carrying an explicit resolved mode. */
async function insertItem(
  hashListId: number,
  hashValue: string,
  opts: { mode?: number | null; crackedAt?: Date | null; plaintext?: string | null } = {}
): Promise<number> {
  const [row] = await db
    .insert(hashItems)
    .values({
      hashListId,
      hashValue,
      detectedHashcatMode: opts.mode === undefined ? MODE_A : opts.mode,
      crackedAt: opts.crackedAt ?? null,
      plaintext: opts.plaintext ?? null,
    })
    .returning({ id: hashItems.id })
  return row!.id
}

async function createSuperWithMember(name: string, memberHashListId: number): Promise<number> {
  seq += 1
  const [superRow] = await db
    .insert(superHashLists)
    .values({ projectId: projId, name: `${name}-${seq}` })
    .returning({ id: superHashLists.id })
  const superId = superRow!.id
  // Seed the first member directly so `addMember` under test adds the SECOND.
  await addMember(superId, memberHashListId, projId)
  return superId
}

async function crackedSetRows(mode: number, hashValue: string) {
  return db
    .select()
    .from(projectCrackedHashes)
    .where(
      and(
        eq(projectCrackedHashes.projectId, projId),
        eq(projectCrackedHashes.hashcatMode, mode),
        eq(projectCrackedHashes.hashValue, hashValue)
      )
    )
}

beforeAll(async () => {
  await cleanup()
  const [p] = await db
    .insert(projects)
    .values({ name: 'super-add-member-reconcile test project', slug: SLUG })
    .returning({ id: projects.id })
  projId = p!.id
})

afterAll(async () => {
  await cleanup()
})

describe('addMember reconciliation — AE3: added member marks siblings cracked', () => {
  it("list A's uncracked duplicate resolves cracked immediately after list B (already-cracked) is added", async () => {
    const H = 'a'.repeat(32)
    const listA = await createList('ae3-a')
    const listB = await createList('ae3-b')
    // A holds an UNCRACKED duplicate of H (same mode); B cracked H historically.
    const aItemId = await insertItem(listA, H, { mode: MODE_A })
    await insertItem(listB, H, {
      mode: MODE_A,
      crackedAt: new Date('2026-01-01T00:00:00.000Z'),
      plaintext: 'secretpw',
    })

    const superId = await createSuperWithMember('ae3-super', listA)

    // Before the add: A's H is not resolvable (B is not yet reconciled).
    const before = await resolveCrackState(
      [{ hashValue: H, detectedHashcatMode: MODE_A, crackedAt: null }],
      projId
    )
    expect(before[0]?.cracked).toBe(false)

    // Add B — its historical crack backfills into the project cracked-set.
    await addMember(superId, listB, projId)

    // After the add: A's uncracked H resolves cracked via U4, with B's plaintext.
    const after = await resolveCrackState(
      [{ hashValue: H, detectedHashcatMode: MODE_A, crackedAt: null }],
      projId
    )
    expect(after[0]?.cracked).toBe(true)
    expect(after[0]?.plaintext).toBe('secretpw')
    expect(after[0]?.crossList).toBe(true)
    // Sanity: A's own row was never mutated — dedup is read-time only.
    const [aRow] = await db.select().from(hashItems).where(eq(hashItems.id, aItemId))
    expect(aRow?.crackedAt).toBeNull()
  })

  it('backfilled keyset cracked_at is stamped NOW; original_cracked_at preserves the historical crack (KTD2)', async () => {
    const H = 'b'.repeat(32)
    const historical = new Date('2020-06-15T12:00:00.000Z')
    const listA = await createList('mono-a')
    const listB = await createList('mono-b')
    await insertItem(listA, H, { mode: MODE_A })
    await insertItem(listB, H, { mode: MODE_A, crackedAt: historical, plaintext: 'oldpw' })

    const superId = await createSuperWithMember('mono-super', listA)
    // Capture the wall clock immediately before the call so `nowFloor` is a
    // real floor for "stamped NOW" - a hardcoded past literal would make this
    // assertion pass even if the backfill stamped a stale timestamp.
    const nowFloor = new Date()
    await addMember(superId, listB, projId)

    const [row] = await crackedSetRows(MODE_A, H)
    expect(row).toBeDefined()
    // Provenance keeps the true first-crack time...
    expect(row!.originalCrackedAt?.toISOString()).toBe(historical.toISOString())
    // ...but the keyset column is stamped fresh (never behind live zap cursors).
    expect(row!.crackedAt.getTime()).toBeGreaterThan(nowFloor.getTime())
    expect(row!.crackedAt.getTime()).toBeGreaterThan(historical.getTime())
  })
})

describe('addMember reconciliation — idempotency', () => {
  it('re-running the backfill inserts no new rows and never moves cracked_at', async () => {
    const H = 'c'.repeat(32)
    const listB = await createList('idem-b')
    await insertItem(listB, H, {
      mode: MODE_A,
      crackedAt: new Date('2026-01-01T00:00:00.000Z'),
      plaintext: 'idempw',
    })

    // First backfill (in its own transaction, as addMember runs it).
    await db.transaction((tx) => backfillCrackedSetFromMember(tx, projId, [listB]))
    const [first] = await crackedSetRows(MODE_A, H)
    expect(first).toBeDefined()
    const firstCrackedAt = first!.crackedAt.getTime()

    // Second backfill — must be a no-op.
    await db.transaction((tx) => backfillCrackedSetFromMember(tx, projId, [listB]))
    const rows = await crackedSetRows(MODE_A, H)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.crackedAt.getTime()).toBe(firstCrackedAt)
    expect(rows[0]!.plaintext).toBe('idempw')
  })
})

describe('addMember reconciliation — mode discrimination + exclusions', () => {
  it('an already-cracked value under a DIFFERENT mode does not mark the uncracked duplicate (AE1)', async () => {
    const H = 'd'.repeat(32)
    const listB = await createList('mode-b')
    // B cracked H under MODE_B...
    await insertItem(listB, H, { mode: MODE_B, crackedAt: new Date(), plaintext: 'bpw' })

    await db.transaction((tx) => backfillCrackedSetFromMember(tx, projId, [listB]))

    // ...so an uncracked MODE_A duplicate must NOT resolve — key is (mode, value).
    const resolved = await resolveCrackState(
      [{ hashValue: H, detectedHashcatMode: MODE_A, crackedAt: null }],
      projId
    )
    expect(resolved[0]?.cracked).toBe(false)
    // But the same value under MODE_B does resolve.
    const sameMode = await resolveCrackState(
      [{ hashValue: H, detectedHashcatMode: MODE_B, crackedAt: null }],
      projId
    )
    expect(sameMode[0]?.cracked).toBe(true)
  })

  it('uncracked and no-mode items never enter the cracked-set (KTD3)', async () => {
    const uncracked = 'e'.repeat(32)
    const noMode = 'f'.repeat(32)
    const listB = await createList('exclude-b')
    // Uncracked (no crackedAt) and a cracked-but-modeless item.
    await insertItem(listB, uncracked, { mode: MODE_A })
    await insertItem(listB, noMode, { mode: null, crackedAt: new Date(), plaintext: 'x' })

    await db.transaction((tx) => backfillCrackedSetFromMember(tx, projId, [listB]))

    expect(await crackedSetRows(MODE_A, uncracked)).toHaveLength(0)
    // A modeless crack has no (mode, value) key at all — nothing to look up.
    const anyNoMode = await db
      .select()
      .from(projectCrackedHashes)
      .where(
        and(eq(projectCrackedHashes.projectId, projId), eq(projectCrackedHashes.hashValue, noMode))
      )
    expect(anyNoMode).toHaveLength(0)
  })
})

describe('addMember reconciliation — #202 split-parent member (HIGH fix)', () => {
  it("a sibling's uncracked duplicate resolves cracked after the added member is a split PARENT whose CHILD holds the crack", async () => {
    const H = 'g'.repeat(32)
    const listA = await createList('splitfix-a')
    // A holds an uncracked duplicate of H.
    const aItemId = await insertItem(listA, H, { mode: MODE_A })

    // The added member is a #202 split PARENT — an empty shell with no
    // hash_items of its own. Its CHILD carries the historical crack.
    const { parentId, childId } = await createSplitParentWithChild('splitfix')
    await insertItem(childId, H, {
      mode: MODE_A,
      crackedAt: new Date('2026-01-05T00:00:00.000Z'),
      plaintext: 'splitsecret',
    })

    const superId = await createSuperWithMember('splitfix-super', listA)

    // Before the add: A's H is not yet resolvable.
    const before = await resolveCrackState(
      [{ hashValue: H, detectedHashcatMode: MODE_A, crackedAt: null }],
      projId
    )
    expect(before[0]?.cracked).toBe(false)

    // Add the split-parent member — the backfill must resolve to the CHILD's
    // hash_items (the parent itself has none) or the reconciliation silently
    // no-ops.
    await addMember(superId, parentId, projId)

    const after = await resolveCrackState(
      [{ hashValue: H, detectedHashcatMode: MODE_A, crackedAt: null }],
      projId
    )
    expect(after[0]?.cracked).toBe(true)
    expect(after[0]?.plaintext).toBe('splitsecret')

    // A cracked-set row exists for (project, mode, value).
    const rows = await crackedSetRows(MODE_A, H)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.plaintext).toBe('splitsecret')

    // A's own row was never mutated — dedup is read-time only.
    const [aRow] = await db.select().from(hashItems).where(eq(hashItems.id, aItemId))
    expect(aRow?.crackedAt).toBeNull()
  })
})
