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

import {
  campaigns,
  hashItems,
  hashLists,
  projectCrackedHashes,
  projects,
  superHashListMembers,
  superHashLists,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { resolveCrackState } from '../../src/services/hash-items/crack-resolution.js'
import { upsertCrackedSet } from '../../src/services/hash-items/cracked-set.js'
import { _removeMemberDeps, addMember, removeMember } from '../../src/services/super-hash-lists.js'

const SLUG = 'super-remove-member-harvest-proj'
// A second, unrelated project — used only by the CRITICAL cross-tenant fix
// test to prove a listId from a different project cannot be passed as the
// member-to-remove.
const OTHER_SLUG = 'super-remove-member-harvest-other-proj'

const MODE_A = 9_913_000
const MODE_B = 9_913_001

let projId = 0
let otherProjId = 0
let seq = 0

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG))
  await db.delete(projects).where(eq(projects.slug, OTHER_SLUG))
}

async function createList(name: string): Promise<number> {
  seq += 1
  const [row] = await db
    .insert(hashLists)
    .values({ projectId: projId, name: `${name}-${seq}`, status: 'ready' })
    .returning({ id: hashLists.id })
  return row!.id
}

/** Create a hash list in the OTHER (unrelated) project. */
async function createListInOtherProject(name: string): Promise<number> {
  seq += 1
  const [row] = await db
    .insert(hashLists)
    .values({ projectId: otherProjId, name: `${name}-${seq}`, status: 'ready' })
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

async function memberRow(superId: number, memberHashListId: number) {
  const [row] = await db
    .select()
    .from(superHashListMembers)
    .where(
      and(
        eq(superHashListMembers.superHashListId, superId),
        eq(superHashListMembers.memberHashListId, memberHashListId)
      )
    )
  return row
}

/** Insert a super PARENT campaign (targets the super, owns no leaf). */
async function createSuperParentCampaign(superId: number): Promise<number> {
  seq += 1
  const [row] = await db
    .insert(campaigns)
    .values({ projectId: projId, name: `parent-${seq}`, superHashListId: superId, status: 'draft' })
    .returning({ id: campaigns.id })
  return row!.id
}

/** Insert a leaf-targeting campaign; `parentCampaignId` null = independent. */
async function createLeafCampaign(
  hashListId: number,
  opts: { parentCampaignId?: number | null; status?: string } = {}
): Promise<number> {
  seq += 1
  const [row] = await db
    .insert(campaigns)
    .values({
      projectId: projId,
      name: `leaf-${seq}`,
      hashListId,
      parentCampaignId: opts.parentCampaignId ?? null,
      status: opts.status ?? 'running',
    })
    .returning({ id: campaigns.id })
  return row!.id
}

async function campaignStatus(id: number): Promise<string | undefined> {
  const [row] = await db
    .select({ status: campaigns.status })
    .from(campaigns)
    .where(eq(campaigns.id, id))
  return row?.status
}

beforeAll(async () => {
  await cleanup()
  const [p] = await db
    .insert(projects)
    .values({ name: 'super-remove-member-harvest test project', slug: SLUG })
    .returning({ id: projects.id })
  projId = p!.id

  const [otherP] = await db
    .insert(projects)
    .values({ name: 'super-remove-member-harvest OTHER test project', slug: OTHER_SLUG })
    .returning({ id: projects.id })
  otherProjId = otherP!.id
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

describe('removeMember — dispatch-stop (RF6): cancel the departing member’s super sub-campaigns', () => {
  it('cancels this super’s non-terminal sub-campaigns for the removed leaf, but never the member’s own campaign or a sibling leaf’s sub-campaign', async () => {
    const listA = await createList('rf6-a')
    const listB = await createList('rf6-b')
    const superId = await createSuper('rf6-super', [listA, listB])

    // One super PARENT campaign fanned out over the super; its sub-campaigns
    // target the physical leaves.
    const parentId = await createSuperParentCampaign(superId)
    const subForA = await createLeafCampaign(listA, {
      parentCampaignId: parentId,
      status: 'running',
    })
    const subForB = await createLeafCampaign(listB, {
      parentCampaignId: parentId,
      status: 'running',
    })
    // A already-terminal sub-campaign for A must be left untouched.
    const doneSubForA = await createLeafCampaign(listA, {
      parentCampaignId: parentId,
      status: 'completed',
    })
    // A's OWN independently-created campaign (parentCampaignId NULL) — R3: it
    // stays independently targetable and must NOT be cancelled.
    const ownA = await createLeafCampaign(listA, { parentCampaignId: null, status: 'running' })

    await removeMember(superId, listA, projId)

    // A's non-terminal super sub-campaign is cancelled (no new chunks dispatch).
    expect(await campaignStatus(subForA)).toBe('cancelled')
    // B is still a member — its sub-campaign is untouched.
    expect(await campaignStatus(subForB)).toBe('running')
    // Terminal sub-campaign is not re-transitioned.
    expect(await campaignStatus(doneSubForA)).toBe('completed')
    // R3: A's own campaign survives — the list remains independently targetable.
    expect(await campaignStatus(ownA)).toBe('running')
    // The super PARENT campaign itself is not a leaf-cracking sub-campaign; untouched.
    expect(await campaignStatus(parentId)).toBe('draft')
  })
})

describe('removeMember — harvest atomicity (RF7): a mid-transaction failure rolls back everything', () => {
  it('a forced throw after the harvest UPDATE but before detach leaves the member attached AND the sibling uncracked', async () => {
    const H = 'f'.repeat(32)
    const listA = await createList('rf7-a')
    const listB = await createList('rf7-b')
    // A cracked H; B holds an uncracked duplicate (same mode) — the harvest
    // WOULD materialize B cracked, but the forced failure must undo it.
    await insertItem(listA, H, { mode: MODE_A, crackedAt: new Date(), plaintext: 'rf7secret' })
    const bItem = await insertItem(listB, H, { mode: MODE_A })

    const superId = await createSuper('rf7-super', [listA, listB])

    const original = _removeMemberDeps.afterHarvest
    _removeMemberDeps.afterHarvest = async () => {
      throw new Error('forced mid-transaction failure (RF7)')
    }
    // Assert via manual catch rather than `expect().rejects.toThrow`: the latter
    // hangs under bun:test on this rejection even though removeMember rejects
    // promptly (the transaction rolls back and re-throws), so a try/catch is the
    // reliable form here.
    let caught: unknown
    try {
      await removeMember(superId, listA, projId)
    } catch (err) {
      caught = err
    } finally {
      _removeMemberDeps.afterHarvest = original
    }
    expect((caught as Error | undefined)?.message).toContain('forced mid-transaction')

    // Detach rolled back: the membership row is STILL present.
    expect(await memberRow(superId, listA)).toBeDefined()
    // Harvest rolled back: B's duplicate is STILL uncracked (no partial apply).
    const bRow = await itemRow(bItem)
    expect(bRow?.crackedAt).toBeNull()
    expect(bRow?.plaintext).toBeNull()
  })
})

describe('removeMember — membership guard (CRITICAL fix): hashListId must be a current member', () => {
  it('a listId from a DIFFERENT project returns null and performs NO harvest or campaign cancellation', async () => {
    const H = 'g'.repeat(32)
    const listA = await createList('guard-cross-a')
    const listB = await createList('guard-cross-b')
    // A list in an UNRELATED project, already cracked — the attempted attack
    // surface: passing this id as `hashListId` must never harvest its
    // plaintext into this project.
    const foreignList = await createListInOtherProject('guard-cross-foreign')
    await insertItem(foreignList, H, {
      mode: MODE_A,
      crackedAt: new Date(),
      plaintext: 'foreignsecret',
    })
    // B holds an uncracked duplicate — the value the exploit would try to
    // materialize cracked via the foreign list's harvest.
    const bItem = await insertItem(listB, H, { mode: MODE_A })

    const superId = await createSuper('guard-cross-super', [listA, listB])
    const parentId = await createSuperParentCampaign(superId)
    const subForA = await createLeafCampaign(listA, {
      parentCampaignId: parentId,
      status: 'running',
    })

    const result = await removeMember(superId, foreignList, projId)

    expect(result).toBeNull()
    // No harvest: B's duplicate stays uncracked.
    expect((await itemRow(bItem))?.crackedAt).toBeNull()
    // No membership change: A and B remain members.
    expect(await memberRow(superId, listA)).toBeDefined()
    expect(await memberRow(superId, listB)).toBeDefined()
    // No dispatch-stop: A's running sub-campaign is untouched.
    expect(await campaignStatus(subForA)).toBe('running')
  })

  it('a same-project listId that was never added to the super returns null and performs no harvest/dispatch-stop', async () => {
    const H = 'h'.repeat(32)
    const listA = await createList('guard-nonmember-a')
    const listB = await createList('guard-nonmember-b')
    // A same-project list that exists but was NEVER added as a member of
    // this super.
    const nonMemberList = await createList('guard-nonmember-outside')
    await insertItem(nonMemberList, H, {
      mode: MODE_A,
      crackedAt: new Date(),
      plaintext: 'nonmembersecret',
    })
    const bItem = await insertItem(listB, H, { mode: MODE_A })

    const superId = await createSuper('guard-nonmember-super', [listA, listB])
    const parentId = await createSuperParentCampaign(superId)
    const subForA = await createLeafCampaign(listA, {
      parentCampaignId: parentId,
      status: 'running',
    })

    const result = await removeMember(superId, nonMemberList, projId)

    expect(result).toBeNull()
    expect((await itemRow(bItem))?.crackedAt).toBeNull()
    expect(await memberRow(superId, listA)).toBeDefined()
    expect(await memberRow(superId, listB)).toBeDefined()
    expect(await campaignStatus(subForA)).toBe('running')
  })
})
