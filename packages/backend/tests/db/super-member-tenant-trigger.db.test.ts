/**
 * Real-DB tests for the `super_member_project_check_trg` trigger
 * (migration `0042_messy_leper_queen.sql`, issue #101 — U6 / R5).
 *
 * A CHECK constraint cannot contain a subquery, so the invariant "a
 * SuperHashlist member must live in the same project as its super" — the
 * guard that keeps resolving a super to its member/leaf lists from ever
 * crossing tenants — is enforced with a hand-written BEFORE INSERT/UPDATE
 * trigger instead, mirroring `hash_lists_parent_project_check_trg` from
 * migration `0040`.
 *
 * Every other file that seeds `super_hash_list_members` only ever seeds
 * same-project pairs, so none of them exercise the reject path. This file
 * does, directly, on both INSERT and UPDATE (of either FK column).
 *
 * Rejection assertions use the try/catch form (as in
 * `attack-mode-consistency.db.test.ts`), not `expect(...).rejects`: the
 * latter wraps drizzle's thenable in an extra promise hop that intermittently
 * wedges the shared postgres.js connection in this lane.
 *
 * Runs under `bun test:db` (preload: tests/preload-db.ts). Uses the shared
 * drizzle client from `../../src/db/index.js`.
 *
 * NOTE: do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 */

import { hashLists, projects, superHashListMembers, superHashLists } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'

const SLUG_PROJ_A = 'super-member-tenant-trigger-proj-a'
const SLUG_PROJ_B = 'super-member-tenant-trigger-proj-b'

let projectAId: number
let projectBId: number
/** A super owned by project A — the tenant every member below is checked against. */
let superInProjectAId: number

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

  const [superRow] = await db
    .insert(superHashLists)
    .values({ projectId: projectAId, name: uniqueName('tenant-trigger-super-a') })
    .returning({ id: superHashLists.id })
  superInProjectAId = superRow!.id
})

afterAll(cleanup)

describe('super_member_project_check_trg — INSERT (R5)', () => {
  it('rejects a member whose project_id differs from the super', async () => {
    const foreignList = await insertHashList(projectBId, 'cross-project-member')

    await expectRejection(() =>
      db.insert(superHashListMembers).values({
        superHashListId: superInProjectAId,
        memberHashListId: foreignList,
      })
    )

    // Nothing landed — the BEFORE trigger aborted the insert.
    const rows = await db
      .select({ id: superHashListMembers.id })
      .from(superHashListMembers)
      .where(eq(superHashListMembers.memberHashListId, foreignList))
    expect(rows).toHaveLength(0)
  })

  it('allows a same-project member to insert fine', async () => {
    const localList = await insertHashList(projectAId, 'same-project-member')

    const [row] = await db
      .insert(superHashListMembers)
      .values({ superHashListId: superInProjectAId, memberHashListId: localList })
      .returning({
        superHashListId: superHashListMembers.superHashListId,
        memberHashListId: superHashListMembers.memberHashListId,
      })

    expect(row!.superHashListId).toBe(superInProjectAId)
    expect(row!.memberHashListId).toBe(localList)
  })
})

describe('super_member_project_check_trg — UPDATE (R5)', () => {
  it('rejects repointing a membership row at a super in a different project', async () => {
    const localList = await insertHashList(projectAId, 'update-move-super-member')
    const [membership] = await db
      .insert(superHashListMembers)
      .values({ superHashListId: superInProjectAId, memberHashListId: localList })
      .returning({ id: superHashListMembers.id })

    const [superB] = await db
      .insert(superHashLists)
      .values({ projectId: projectBId, name: uniqueName('tenant-trigger-super-b') })
      .returning({ id: superHashLists.id })

    await expectRejection(() =>
      db
        .update(superHashListMembers)
        .set({ superHashListId: superB!.id })
        .where(eq(superHashListMembers.id, membership!.id))
    )

    const [unchanged] = await db
      .select({ superHashListId: superHashListMembers.superHashListId })
      .from(superHashListMembers)
      .where(eq(superHashListMembers.id, membership!.id))
    expect(unchanged!.superHashListId).toBe(superInProjectAId)
  })

  it('rejects repointing a membership row at a member list in a different project', async () => {
    const localList = await insertHashList(projectAId, 'update-move-member')
    const [membership] = await db
      .insert(superHashListMembers)
      .values({ superHashListId: superInProjectAId, memberHashListId: localList })
      .returning({ id: superHashListMembers.id })

    const foreignList = await insertHashList(projectBId, 'update-move-foreign-target')

    await expectRejection(() =>
      db
        .update(superHashListMembers)
        .set({ memberHashListId: foreignList })
        .where(eq(superHashListMembers.id, membership!.id))
    )

    const [unchanged] = await db
      .select({ memberHashListId: superHashListMembers.memberHashListId })
      .from(superHashListMembers)
      .where(eq(superHashListMembers.id, membership!.id))
    expect(unchanged!.memberHashListId).toBe(localList)
  })

  it('allows repointing to a same-project member list', async () => {
    const localList = await insertHashList(projectAId, 'update-same-project-from')
    const [membership] = await db
      .insert(superHashListMembers)
      .values({ superHashListId: superInProjectAId, memberHashListId: localList })
      .returning({ id: superHashListMembers.id })

    const otherLocalList = await insertHashList(projectAId, 'update-same-project-to')

    await db
      .update(superHashListMembers)
      .set({ memberHashListId: otherLocalList })
      .where(eq(superHashListMembers.id, membership!.id))

    const [updated] = await db
      .select({ memberHashListId: superHashListMembers.memberHashListId })
      .from(superHashListMembers)
      .where(eq(superHashListMembers.id, membership!.id))
    expect(updated!.memberHashListId).toBe(otherLocalList)
  })
})
