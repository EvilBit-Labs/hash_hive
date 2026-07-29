/**
 * Real-DB tests for the SuperHashlist lifecycle + membership service
 * (`services/super-hash-lists.ts`, issue #101 — U7 / R2, R3, R4, R5).
 *
 * Proves the service-layer invariants against a real Postgres: that
 * cross-project (R5) and cross-super (R3) members are rejected with a CLEAN
 * domain error rather than a raw pg constraint violation, that create allows
 * 0/1 members (the ≥2 rule is a campaign-target-time guard, U10 — see
 * `createSuper`'s doc comment / plan Open Question), and that add/remove
 * membership mutates the join table while leaving a removed member
 * independently targetable by its own campaigns (R3).
 *
 * Follows the DB-test harness in `attack-mode-consistency.db.test.ts` and
 * `super-member-tenant-trigger.db.test.ts`: cleanup by project slug, each test
 * creates its own hash lists/supers so leftovers never pollute a sibling, and
 * rejection assertions use a try/catch `expectRejection` helper rather than
 * `.rejects.toThrow()` (the latter's extra promise hop intermittently wedges
 * the shared postgres.js connection on an errored statement in this lane).
 *
 * NOTE: do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 */

import { campaigns, hashLists, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import {
  addMember,
  archiveSuper,
  createSuper,
  getSuperById,
  listSupers,
  removeMember,
  renameSuper,
  SuperMemberAlreadyInSuperError,
  SuperMemberProjectMismatchError,
} from '../../src/services/super-hash-lists.js'

const SLUG_PROJ_A = 'super-hash-lists-service-test-proj-a'
const SLUG_PROJ_B = 'super-hash-lists-service-test-proj-b'

let projectAId: number
let projectBId: number

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG_PROJ_A))
  await db.delete(projects).where(eq(projects.slug, SLUG_PROJ_B))
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

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random()}`
}

async function insertHashList(projectId: number, prefix: string): Promise<number> {
  const [row] = await db
    .insert(hashLists)
    .values({ projectId, name: uniqueName(prefix), status: 'ready' })
    .returning({ id: hashLists.id })
  return row!.id
}

function sorted(ids: number[]): number[] {
  return ids.toSorted((a, b) => a - b)
}

beforeAll(async () => {
  await cleanup()
  const [projA] = await db
    .insert(projects)
    .values({ name: SLUG_PROJ_A, slug: SLUG_PROJ_A })
    .returning({ id: projects.id })
  projectAId = projA!.id

  const [projB] = await db
    .insert(projects)
    .values({ name: SLUG_PROJ_B, slug: SLUG_PROJ_B })
    .returning({ id: projects.id })
  projectBId = projB!.id
})

afterAll(cleanup)

describe('createSuper (R2, R3, R5)', () => {
  it('creates a super with valid members and getSuperById returns membership', async () => {
    const l1 = await insertHashList(projectAId, 'create-valid-1')
    const l2 = await insertHashList(projectAId, 'create-valid-2')

    const created = await createSuper({
      projectId: projectAId,
      name: uniqueName('valid-super'),
      memberIds: [l1, l2],
    })

    expect(created.projectId).toBe(projectAId)
    expect(created.archivedAt).toBeNull()
    expect(sorted(created.memberIds)).toEqual(sorted([l1, l2]))

    const fetched = await getSuperById(created.id, projectAId)
    expect(fetched).not.toBeNull()
    expect(sorted(fetched!.memberIds)).toEqual(sorted([l1, l2]))
  })

  it('allows creating a super with 0 members (min ≥2 is enforced at target time, U10)', async () => {
    const created = await createSuper({
      projectId: projectAId,
      name: uniqueName('empty-super'),
    })
    expect(created.memberIds).toEqual([])
  })

  it('allows creating a super with a single member', async () => {
    const l = await insertHashList(projectAId, 'create-single')
    const created = await createSuper({
      projectId: projectAId,
      name: uniqueName('single-super'),
      memberIds: [l],
    })
    expect(created.memberIds).toEqual([l])
  })

  it('collapses duplicate memberIds in the input', async () => {
    const l = await insertHashList(projectAId, 'create-dupe-input')
    const created = await createSuper({
      projectId: projectAId,
      name: uniqueName('dupe-input-super'),
      memberIds: [l, l, l],
    })
    expect(created.memberIds).toEqual([l])
  })

  it('rejects a member from another project with a clean domain error (R5)', async () => {
    const foreign = await insertHashList(projectBId, 'create-cross-project')

    const before = await listSupers(projectAId)
    const err = await expectRejection(() =>
      createSuper({
        projectId: projectAId,
        name: uniqueName('cross-project-super'),
        memberIds: [foreign],
      })
    )
    expect(err).toBeInstanceOf(SuperMemberProjectMismatchError)
    expect((err as SuperMemberProjectMismatchError).memberIds).toContain(foreign)

    // The transaction rolled back — no partial super leaked.
    const after = await listSupers(projectAId)
    expect(after.total).toBe(before.total)
  })

  it('rejects a member already in another super with a clean domain error, not a raw 23505 (R3)', async () => {
    const l1 = await insertHashList(projectAId, 'already-super-1')
    const l2 = await insertHashList(projectAId, 'already-super-2')

    await createSuper({
      projectId: projectAId,
      name: uniqueName('first-super'),
      memberIds: [l1],
    })

    const before = await listSupers(projectAId)
    const err = await expectRejection(() =>
      createSuper({
        projectId: projectAId,
        name: uniqueName('second-super'),
        memberIds: [l2, l1],
      })
    )
    expect(err).toBeInstanceOf(SuperMemberAlreadyInSuperError)
    // Explicitly NOT a raw postgres unique violation surfacing to the caller.
    expect((err as { code?: string }).code).not.toBe('23505')
    expect((err as SuperMemberAlreadyInSuperError).memberIds).toContain(l1)

    // The second super rolled back entirely — l2 did not become a member.
    const after = await listSupers(projectAId)
    expect(after.total).toBe(before.total)
  })
})

describe('renameSuper (R4)', () => {
  it('renames a super (project-scoped)', async () => {
    const created = await createSuper({ projectId: projectAId, name: uniqueName('rename-before') })
    const newName = uniqueName('rename-after')
    const updated = await renameSuper(created.id, projectAId, newName)
    expect(updated?.name).toBe(newName)
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime())
  })

  it('returns null when renaming a super in a different project', async () => {
    const created = await createSuper({ projectId: projectAId, name: uniqueName('rename-scope') })
    const result = await renameSuper(created.id, projectBId, uniqueName('nope'))
    expect(result).toBeNull()
  })
})

describe('archiveSuper (R4)', () => {
  it('stamps archivedAt and is idempotent', async () => {
    const created = await createSuper({ projectId: projectAId, name: uniqueName('archive-me') })
    expect(created.archivedAt).toBeNull()

    const archived = await archiveSuper(created.id, projectAId)
    expect(archived?.archivedAt).not.toBeNull()

    // Re-archiving does not move the timestamp.
    const again = await archiveSuper(created.id, projectAId)
    expect(again?.archivedAt?.getTime()).toBe(archived!.archivedAt!.getTime())
  })

  it('excludes archived supers from listSupers by default, includes with showArchived', async () => {
    const created = await createSuper({ projectId: projectAId, name: uniqueName('archive-list') })
    await archiveSuper(created.id, projectAId)

    const active = await listSupers(projectAId)
    expect(active.items.some((s) => s.id === created.id)).toBe(false)

    const all = await listSupers(projectAId, { showArchived: true })
    expect(all.items.some((s) => s.id === created.id)).toBe(true)
  })

  it('returns null when archiving a super in a different project', async () => {
    const created = await createSuper({ projectId: projectAId, name: uniqueName('archive-scope') })
    const result = await archiveSuper(created.id, projectBId)
    expect(result).toBeNull()
  })
})

describe('addMember / removeMember (R3, R4)', () => {
  it('adds a member to an existing super', async () => {
    const created = await createSuper({ projectId: projectAId, name: uniqueName('add-member') })
    const l = await insertHashList(projectAId, 'add-member-list')

    const updated = await addMember(created.id, l, projectAId)
    expect(updated).not.toBeNull()
    expect(updated!.memberIds).toContain(l)
  })

  it('rejects adding a cross-project member with a clean domain error (R5)', async () => {
    const created = await createSuper({ projectId: projectAId, name: uniqueName('add-cross') })
    const foreign = await insertHashList(projectBId, 'add-cross-list')

    const err = await expectRejection(() => addMember(created.id, foreign, projectAId))
    expect(err).toBeInstanceOf(SuperMemberProjectMismatchError)
  })

  it('duplicate add of the same member is a clean error, not a raw 23505 (chosen semantic)', async () => {
    const created = await createSuper({ projectId: projectAId, name: uniqueName('add-dupe') })
    const l = await insertHashList(projectAId, 'add-dupe-list')

    await addMember(created.id, l, projectAId)
    const err = await expectRejection(() => addMember(created.id, l, projectAId))
    expect(err).toBeInstanceOf(SuperMemberAlreadyInSuperError)
    expect((err as { code?: string }).code).not.toBe('23505')
  })

  it('returns null when adding to a super in a different project', async () => {
    const created = await createSuper({ projectId: projectAId, name: uniqueName('add-scope') })
    const l = await insertHashList(projectAId, 'add-scope-list')
    const result = await addMember(created.id, l, projectBId)
    expect(result).toBeNull()
  })

  it('removes a member; the removed list stays independently targetable by its own campaigns (R3)', async () => {
    const l = await insertHashList(projectAId, 'remove-member-list')
    const created = await createSuper({
      projectId: projectAId,
      name: uniqueName('remove-member'),
      memberIds: [l],
    })
    expect(created.memberIds).toContain(l)

    const updated = await removeMember(created.id, l, projectAId)
    expect(updated).not.toBeNull()
    expect(updated!.memberIds).not.toContain(l)

    // R3: the removed hash list is still an ordinary targetable list. A
    // campaign that targets it directly (hashListId set, superHashListId null)
    // satisfies campaigns_exactly_one_target_chk and inserts cleanly.
    const [campaign] = await db
      .insert(campaigns)
      .values({ projectId: projectAId, name: uniqueName('targets-removed-member'), hashListId: l })
      .returning({ id: campaigns.id })
    expect(campaign?.id).toBeGreaterThan(0)

    // After removal the freed list can be re-added to a super (R3 no longer
    // blocks it), proving the membership row was truly detached.
    const readd = await addMember(created.id, l, projectAId)
    expect(readd!.memberIds).toContain(l)
  })

  it('returns null when removing from a super in a different project', async () => {
    const l = await insertHashList(projectAId, 'remove-scope-list')
    const created = await createSuper({
      projectId: projectAId,
      name: uniqueName('remove-scope'),
      memberIds: [l],
    })
    const result = await removeMember(created.id, l, projectBId)
    expect(result).toBeNull()
  })
})

describe('getSuperById / listSupers (project-scoped reads)', () => {
  it('getSuperById returns null across projects', async () => {
    const created = await createSuper({ projectId: projectAId, name: uniqueName('read-scope') })
    expect(await getSuperById(created.id, projectBId)).toBeNull()
  })

  it('listSupers is project-scoped', async () => {
    const created = await createSuper({ projectId: projectAId, name: uniqueName('list-scope') })
    const inA = await listSupers(projectAId)
    expect(inA.items.some((s) => s.id === created.id)).toBe(true)
    const inB = await listSupers(projectBId)
    expect(inB.items.some((s) => s.id === created.id)).toBe(false)
  })

  it('listSupers paginates when limit is supplied while total counts all matches', async () => {
    // This project already holds several active supers from earlier tests;
    // create two more to guarantee at least a full page plus overflow.
    await createSuper({ projectId: projectAId, name: uniqueName('page-1') })
    await createSuper({ projectId: projectAId, name: uniqueName('page-2') })
    const page = await listSupers(projectAId, { limit: 1, offset: 0 })
    expect(page.items).toHaveLength(1)
    expect(page.total).toBeGreaterThan(1)
  })
})
