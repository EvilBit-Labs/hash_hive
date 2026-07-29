/**
 * Real-DB parity test for issue #202 code review fix — pins
 * `resolveHashListScope` (`services/hash-items/list-scope.ts`) and
 * `resolveHashListScopeForExport` (`services/results/export.ts`) to
 * identical behavior.
 *
 * The two functions intentionally duplicate the same predicate — `(id = $1
 * OR parent_hash_list_id = $1) AND project_id = $2` — because
 * `export.ts` documents a "no module-scope `db` import" invariant (so it
 * loads in test phases without a live database connection) and therefore
 * can't import `list-scope.ts`'s module-scope `db`-bound helper directly.
 * That duplication is a real footgun: nothing today catches one of the two
 * copies drifting from the other (e.g. a future edit that drops the
 * `project_id` predicate from just one of them, or that changes the OR to
 * an AND). This file drives BOTH functions against the same seeded rows
 * and asserts byte-for-byte identical results for every scope shape:
 *
 *   - a leaf (never-split) hash list id
 *   - a split parent id (must expand to itself + its children)
 *   - a cross-project id (IDOR guard — must resolve to `[]` under the
 *     wrong project)
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
import { resolveHashListScope } from '../../src/services/hash-items/list-scope.js'
import { resolveHashListScopeForExport } from '../../src/services/results/export.js'

// ─── Slugs & state ───────────────────────────────────────────────────────────

const SLUG_PROJ_A = 'scope-parity-proj-a'
const SLUG_PROJ_B = 'scope-parity-proj-b'

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG_PROJ_A))
  await db.delete(projects).where(eq(projects.slug, SLUG_PROJ_B))
}

interface Seed {
  projectAId: number
  projectBId: number
  parentId: number
  child1Id: number
  child2Id: number
  leafId: number
}

let seed: Seed

async function insertProject(slug: string): Promise<number> {
  const [p] = await db.insert(projects).values({ name: slug, slug }).returning({ id: projects.id })
  return p!.id
}

async function insertHashList(
  projectId: number,
  name: string,
  parentHashListId: number | null = null
): Promise<number> {
  const [l] = await db
    .insert(hashLists)
    .values({ projectId, name, status: 'ready', parentHashListId })
    .returning({ id: hashLists.id })
  return l!.id
}

beforeAll(async () => {
  await cleanup()
  const projectAId = await insertProject(SLUG_PROJ_A)
  const projectBId = await insertProject(SLUG_PROJ_B)

  const parentId = await insertHashList(projectAId, 'parity-split-parent')
  const child1Id = await insertHashList(projectAId, 'parity-split-child-1', parentId)
  const child2Id = await insertHashList(projectAId, 'parity-split-child-2', parentId)
  const leafId = await insertHashList(projectAId, 'parity-never-split-leaf')

  seed = { projectAId, projectBId, parentId, child1Id, child2Id, leafId }
})

afterAll(cleanup)

/** Sorts an id array for order-independent comparison. */
function sorted(ids: readonly number[]): number[] {
  return [...ids].sort((a, b) => a - b)
}

describe('resolveHashListScope vs resolveHashListScopeForExport — parity', () => {
  it('a leaf id resolves to just itself, identically, on both helpers', async () => {
    const fromListScope = await resolveHashListScope(seed.leafId, seed.projectAId)
    const fromExport = await resolveHashListScopeForExport(db, seed.leafId, seed.projectAId)

    expect(sorted(fromListScope)).toEqual([seed.leafId])
    expect(sorted(fromExport)).toEqual(sorted(fromListScope))
  })

  it('a parent id resolves to itself plus its children (union), identically, on both helpers', async () => {
    const fromListScope = await resolveHashListScope(seed.parentId, seed.projectAId)
    const fromExport = await resolveHashListScopeForExport(db, seed.parentId, seed.projectAId)

    const expected = sorted([seed.parentId, seed.child1Id, seed.child2Id])
    expect(sorted(fromListScope)).toEqual(expected)
    expect(sorted(fromExport)).toEqual(expected)
  })

  it('a cross-project id resolves to [] (IDOR guard), identically, on both helpers', async () => {
    const fromListScope = await resolveHashListScope(seed.parentId, seed.projectBId)
    const fromExport = await resolveHashListScopeForExport(db, seed.parentId, seed.projectBId)

    expect(fromListScope).toEqual([])
    expect(fromExport).toEqual([])
  })

  it('a cross-project CHILD id also resolves to [] on both helpers', async () => {
    const fromListScope = await resolveHashListScope(seed.child1Id, seed.projectBId)
    const fromExport = await resolveHashListScopeForExport(db, seed.child1Id, seed.projectBId)

    expect(fromListScope).toEqual([])
    expect(fromExport).toEqual([])
  })
})
