/**
 * Real-DB tests for issue #101 U13 — remove-member harvest (R14, R17).
 *
 * Removing a member never loses a crack. Correctness rests on the project-wide
 * cracked-set (KTD9 / adversarial F4): U2 writes every crack to
 * `project_cracked_hashes` regardless of membership and removal never prunes it,
 * so remaining members resolve `(mode, value)` cracked via U4 whether or not a
 * harvest ran. The harvest is the SOLE write-back — it materializes a departing
 * member's cracks onto remaining members' `hash_items` rows for surfaces still
 * reading `hash_items` directly.
 *
 * Order follows the plan's execution note — the AE6 concurrency case (a crack
 * landing after dispatch-stop) is written first, since the whole ordering exists
 * to close that lost-crack race.
 *
 * Covers:
 *   - AE6: a crack that lands AFTER the member is detached still marks a sibling
 *     cracked, because the cracked-set is project-scoped (not membership-scoped).
 *   - AE5: `H` cracked only in member A, uncracked duplicate in B (same mode).
 *     Remove A → B's `H` row is materialized cracked with A's plaintext; A's own
 *     row is never reverted.
 *   - R17: the harvest writes only plaintext + crackedAt to B — never A's
 *     identity / username / source-list.
 *   - Removing the last member holding a `(mode, value)` leaves the cracked-set
 *     entry intact (project-wide crack-once is not undone by removal).
 *   - Mode discrimination: a source crack under a different mode does not
 *     materialize the uncracked duplicate.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the shared
 * drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */

import { hashItems, hashLists, projectCrackedHashes, projects, superHashLists } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { upsertCrackedSet } from '../../src/services/hash-items/cracked-set.js'
import { resolveCrackState } from '../../src/services/hash-items/crack-resolution.js'
import { addMember, removeMember } from '../../src/services/super-hash-lists.js'

const SLUG = 'super-remove-member-harvest-proj'

const MODE_A = 9_913_000
const MODE_B = 9_913_001

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

async function insertItem(
  hashListId: number,
  hashValue: string,
  opts: {
    mode?: number | null
    crackedAt?: Date | null
    plaintext?: string | null
    username?: string | null
  } = {}
): Promise<number> {
  const [row] = await db
    .insert(hashItems)
    .values({
      hashListId,
      hashValue,
      detectedHashcatMode: opts.mode === undefined ? MODE_A : opts.mode,
      crackedAt: opts.crackedAt ?? null,
      plaintext: opts.plaintext ?? null,
      username: opts.username ?? null,
    })
    .returning({ id: hashItems.id })
  return row!.id
}

/** Create a super and attach both lists as members (via the real addMember). */
async function createSuper(name: string, memberIds: number[]): Promise<number> {
  seq += 1
  const [superRow] = await db
    .insert(superHashLists)
    .values({ projectId: projId, name: `${name}-${seq}` })
    .returning({ id: superHashLists.id })
  const superId = superRow!.id
  for (const id of memberIds) await addMember(superId, id, projId)
  return superId
}

async function itemRow(id: number) {
  const [row] = await db.select().from(hashItems).where(eq(hashItems.id, id))
  return row
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
    .values({ name: 'super-remove-member-harvest test project', slug: SLUG })
    .returning({ id: projects.id })
  projId = p!.id
})

afterAll(async () => {
  await cleanup()
})

describe('removeMember — AE6: a crack landing after detach still marks a sibling', () => {
  it("an in-flight chunk's crack, submitted AFTER the member is removed, still resolves the sibling cracked via U4", async () => {
    const H = 'a'.repeat(32)
    const listA = await createList('ae6-a')
    const listB = await createList('ae6-b')
    // At removal time H is NOT yet cracked anywhere (A's task is mid-attack).
    await insertItem(listA, H, { mode: MODE_A })
    const bItem = await insertItem(listB, H, { mode: MODE_A })

    const superId = await createSuper('ae6-super', [listA, listB])

    // Detach A while its chunk is still in flight — the harvest finds nothing.
    await removeMember(superId, listA, projId)
    expect((await itemRow(bItem))?.crackedAt).toBeNull()

    // The already-dispatched chunk now submits its crack. U2 writes it to the
    // project cracked-set regardless of A's (now-removed) membership.
    await db.transaction((tx) =>
      upsertCrackedSet(tx, {
        projectId: projId,
        hashcatMode: MODE_A,
        hashValue: H,
        plaintext: 'latecrack',
        sourceHashListId: listA,
      })
    )

    // B resolves H cracked via U4 — the crack survived because the cracked-set
    // is project-scoped, not because of any drain. It never reverts.
    const resolved = await resolveCrackState(
      [{ hashValue: H, detectedHashcatMode: MODE_A, crackedAt: null }],
      projId
    )
    expect(resolved[0]?.cracked).toBe(true)
    expect(resolved[0]?.plaintext).toBe('latecrack')
  })
})

describe('removeMember — AE5: harvest materializes departing member cracks onto siblings', () => {
  it("B's uncracked duplicate is set cracked with A's plaintext before detach; A's own row is not reverted", async () => {
    const H = 'b'.repeat(32)
    const crackTime = new Date('2026-02-03T04:05:06.000Z')
    const listA = await createList('ae5-a')
    const listB = await createList('ae5-b')
    // A cracked H; B holds an uncracked duplicate (same mode).
    const aItem = await insertItem(listA, H, {
      mode: MODE_A,
      crackedAt: crackTime,
      plaintext: 'ae5secret',
    })
    const bItem = await insertItem(listB, H, { mode: MODE_A })

    const superId = await createSuper('ae5-super', [listA, listB])
    await removeMember(superId, listA, projId)

    // B's row is materialized cracked with A's plaintext.
    const bRow = await itemRow(bItem)
    expect(bRow?.crackedAt).not.toBeNull()
    expect(bRow?.plaintext).toBe('ae5secret')

    // A's own row is untouched — removal never reverts a crack.
    const aRow = await itemRow(aItem)
    expect(aRow?.crackedAt?.toISOString()).toBe(crackTime.toISOString())
    expect(aRow?.plaintext).toBe('ae5secret')
  })

  it('R17: the harvested row carries only plaintext + crackedAt — no source-member identity leaks to B', async () => {
    const H = 'c'.repeat(32)
    const listA = await createList('r17-a')
    const listB = await createList('r17-b')
    await insertItem(listA, H, {
      mode: MODE_A,
      crackedAt: new Date(),
      plaintext: 'r17secret',
      username: 'admin@source', // A's own username — must NEVER travel to B.
    })
    const bItem = await insertItem(listB, H, { mode: MODE_A, username: null })

    const superId = await createSuper('r17-super', [listA, listB])
    await removeMember(superId, listA, projId)

    const bRow = await itemRow(bItem)
    expect(bRow?.plaintext).toBe('r17secret')
    // B keeps its OWN (null) username; A's source username never crosses over.
    expect(bRow?.username).toBeNull()
    // B's row still belongs to B — the harvest never rewrote its hashListId.
    expect(bRow?.hashListId).toBe(listB)
  })

  it('mode discrimination: a source crack under a different mode does not materialize the duplicate', async () => {
    const H = 'd'.repeat(32)
    const listA = await createList('mode-a')
    const listB = await createList('mode-b')
    // A cracked H under MODE_B; B's uncracked dup is MODE_A.
    await insertItem(listA, H, { mode: MODE_B, crackedAt: new Date(), plaintext: 'bpw' })
    const bItem = await insertItem(listB, H, { mode: MODE_A })

    const superId = await createSuper('mode-super', [listA, listB])
    await removeMember(superId, listA, projId)

    // Key is (mode, value): B's MODE_A row must stay uncracked.
    expect((await itemRow(bItem))?.crackedAt).toBeNull()
  })
})

describe('removeMember — project-wide crack-once survives removal', () => {
  it('removing the last member holding a (mode, value) leaves the cracked-set entry intact', async () => {
    const H = 'e'.repeat(32)
    const listA = await createList('last-a')
    const listB = await createList('last-b')
    await insertItem(listA, H, { mode: MODE_A, crackedAt: new Date(), plaintext: 'lastpw' })
    // Record the crack in the project set as U2 would have when A cracked it.
    await db.transaction((tx) =>
      upsertCrackedSet(tx, {
        projectId: projId,
        hashcatMode: MODE_A,
        hashValue: H,
        plaintext: 'lastpw',
        sourceHashListId: listA,
      })
    )

    // B has no copy of H — A is the only member holding it.
    const superId = await createSuper('last-super', [listA, listB])
    await removeMember(superId, listA, projId)

    // The cracked-set entry is NOT pruned — project-wide crack-once persists.
    expect(await crackedSetRows(MODE_A, H)).toHaveLength(1)
  })
})
