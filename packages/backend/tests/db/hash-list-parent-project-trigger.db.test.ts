/**
 * Real-DB tests for the `hash_lists_parent_project_check_trg` trigger
 * (migration `0040_natural_molly_hayes.sql`, issue #202).
 *
 * A CHECK constraint cannot contain a subquery, so the invariant "a split
 * sub-list's project_id must match its parent hash list's project_id"
 * (KTD7 — the guard that keeps `resolveHashListScope`'s parent->children
 * expansion from ever crossing tenants) is enforced with a hand-written
 * BEFORE INSERT/UPDATE trigger instead. Every other test file that seeds
 * `hash_lists.parent_hash_list_id` (`hash-list-split.db.test.ts`,
 * `campaign-split-create.db.test.ts`, `parent-progress.db.test.ts`,
 * `parent-list-aggregation.db.test.ts`) only ever seeds SAME-project
 * parent/child pairs, so none of them actually exercise the trigger's
 * reject path — this file does, directly, on both INSERT and UPDATE.
 *
 * The migration was changed from `CREATE TRIGGER` to
 * `CREATE OR REPLACE TRIGGER` (Postgres 14+, this repo runs pg16) as part
 * of the same code-review fix so a raw replay of the migration file is
 * safe — that change has no independent runtime behavior to test on its
 * own, it only affects re-running the DDL.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the shared
 * drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */

import { hashLists, projects } from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'

// ─── Slugs & state ───────────────────────────────────────────────────────────

const SLUG_PROJ_A = 'hash-list-parent-trigger-proj-a'
const SLUG_PROJ_B = 'hash-list-parent-trigger-proj-b'

let projectAId: number
let projectBId: number
let parentInProjectAId: number

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG_PROJ_A))
  await db.delete(projects).where(eq(projects.slug, SLUG_PROJ_B))
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

  const [parent] = await db
    .insert(hashLists)
    .values({ projectId: projectAId, name: 'trigger-parent', status: 'ready' })
    .returning({ id: hashLists.id })
  parentInProjectAId = parent!.id
})

afterAll(cleanup)

describe('hash_lists_parent_project_check_trg — INSERT', () => {
  it('rejects a child whose project_id differs from its parent hash list', async () => {
    // Drizzle's query builder is a thenable, not a real Promise instance —
    // `expect(...).rejects` requires an actual Promise, so wrap in an async
    // IIFE (mirrors `audit-logs.db.test.ts`'s CHECK-constraint tests).
    await expect(
      (async () =>
        db.insert(hashLists).values({
          projectId: projectBId,
          name: 'cross-project-child',
          status: 'ready',
          parentHashListId: parentInProjectAId,
        }))()
    ).rejects.toThrow()
  })

  it('allows a same-project child to insert fine', async () => {
    const [child] = await db
      .insert(hashLists)
      .values({
        projectId: projectAId,
        name: 'same-project-child',
        status: 'ready',
        parentHashListId: parentInProjectAId,
      })
      .returning({ id: hashLists.id, parentHashListId: hashLists.parentHashListId })
    expect(child).toBeDefined()
    expect(child!.parentHashListId).toBe(parentInProjectAId)
  })
})

describe('hash_lists_parent_project_check_trg — UPDATE', () => {
  it('rejects re-parenting an existing list to a parent in a different project', async () => {
    const [orphan] = await db
      .insert(hashLists)
      .values({ projectId: projectBId, name: 'trigger-update-orphan', status: 'ready' })
      .returning({ id: hashLists.id })

    await expect(
      (async () =>
        db
          .update(hashLists)
          .set({ parentHashListId: parentInProjectAId })
          .where(eq(hashLists.id, orphan!.id)))()
    ).rejects.toThrow()
  })

  it('allows re-parenting to a same-project parent', async () => {
    const [child] = await db
      .insert(hashLists)
      .values({ projectId: projectAId, name: 'trigger-update-same-project', status: 'ready' })
      .returning({ id: hashLists.id })

    await db
      .update(hashLists)
      .set({ parentHashListId: parentInProjectAId })
      .where(eq(hashLists.id, child!.id))

    const [updated] = await db
      .select({ parentHashListId: hashLists.parentHashListId })
      .from(hashLists)
      .where(eq(hashLists.id, child!.id))
    expect(updated!.parentHashListId).toBe(parentInProjectAId)
  })
})
