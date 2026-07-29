/**
 * Real-DB tests for the zaps endpoint composite cursor
 * (docs/plans/2026-07-12-001-feat-zaps-composite-cursor-plan.md), now over the
 * WIDENED project+mode cracked-set source (U3 / KTD4). getZapsForTask resolves
 * from `project_cracked_hashes WHERE projectId = ? AND hashcatMode = ?` instead
 * of the old single-`hashListId` `hash_items` scan, so these characterization
 * tests seed the cracked-set directly. The cursor math is unchanged — the point
 * of this file is that the composite `(crackedAt, id)` cursor still walks every
 * cracked value exactly once after the widening.
 *
 * These prove the property the change exists for, against a real Postgres — SQL
 * comparison semantics over tied `crackedAt` timestamps cannot be proven with
 * mocks:
 *
 * 1. Exactly-once walk: an agent that starts with no cursor and repeatedly
 *    calls back with the returned `nextCursor` reads every cracked hash
 *    value exactly once, terminating when `nextCursor` is null — even when
 *    MORE than `limit` rows share ONE `crackedAt` timestamp (the case the
 *    old single-timestamp `since` cursor skipped or replayed).
 * 2. Tied cluster straddling a page boundary loses/repeats nothing.
 * 3. Exhaustion returns `nextCursor: null`.
 * 4. Empty / no-cracked-rows scope → `{ zaps: [], nextCursor: null }`.
 * 5. Immutability characterization (KTD4): moving a row's `crackedAt`
 *    FORWARD (the monotonic re-crack mutation) can cause a benign REPLAY
 *    but never a SKIP — every cracked hash remains reachable.
 *
 * Each fixture uses its OWN hashcat mode so project+mode scoping isolates it
 * from the others (all fixtures share one project). Timestamps are seeded
 * MILLISECOND-ALIGNED (`new Date(fixedMillis)`), matching how every write path
 * in the app actually writes `crackedAt` (KTD2/KTD3's ms-aligned-writes
 * invariant). Do NOT rebuild these on sub-ms values — that is not a state the
 * write paths can produce.
 *
 * Runs under `just test-db` (preload: tests/preload-db.ts). Uses the
 * shared drizzle client from `../../src/db/index.js`.
 *
 * NOTE: Do NOT call client.end() — the pooled client is a process-wide
 * singleton shared by every file in the lane.
 * NOTE: Do NOT self-skip — the test-db lane always has Postgres available.
 */
import {
  agents,
  attacks,
  campaigns,
  hashLists,
  projectCrackedHashes,
  projects,
  tasks,
} from '@hashhive/shared'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq } from 'drizzle-orm'

import { db } from '../../src/db/index.js'
import { decodeZapCursor, type ZapCursor } from '../../src/services/tasks/zap-cursor.js'
import { getZapsForTask } from '../../src/services/tasks/zaps.js'

const SLUG = 'zaps-pagination-proj'

// Distinct modes per fixture so project+mode resolution isolates each scenario.
const MODE_MAIN = 10
const MODE_EMPTY = 11
const MODE_EXACT = 12
const MODE_CLAMP = 13
const MODE_IMMUT = 14

let projectId: number
let agentId: number
let taskId: number
// A second, empty scope reached through its own campaign/task (scenario 4).
let emptyAgentId: number
let emptyTaskId: number

async function cleanup(): Promise<void> {
  await db.delete(projects).where(eq(projects.slug, SLUG))
}

/**
 * Drive a full paginated walk through getZapsForTask, echoing back the
 * decoded `nextCursor` exactly as an agent would, and return the ordered
 * list of every zap value seen across all calls.
 */
async function walkAll(
  targetTaskId: number,
  targetAgentId: number,
  limit: number
): Promise<string[]> {
  const seen: string[] = []
  let cursor: ZapCursor | undefined
  // Bound the loop defensively so a pagination bug can't spin forever.
  for (let guard = 0; guard < 1000; guard++) {
    const result = await getZapsForTask(targetTaskId, targetAgentId, projectId, { cursor, limit })
    if ('error' in result) {
      throw new Error(`unexpected error walking zaps: ${result.error}`)
    }
    seen.push(...result.zaps)
    if (result.nextCursor === null) {
      return seen
    }
    cursor = decodeZapCursor(result.nextCursor)
  }
  throw new Error('walkAll did not terminate — possible pagination loop')
}

let seq = 0

/** Create a fresh hash list in the shared project; returns its id. */
async function createList(prefix: string): Promise<number> {
  seq += 1
  const [list] = await db
    .insert(hashLists)
    .values({ projectId, name: `${prefix}-list-${seq}`, status: 'ready' })
    .returning({ id: hashLists.id })
  return list!.id
}

/**
 * Seed a campaign → attack → agent → task chain latched to `mode`, targeting a
 * fresh list, assigned to a fresh agent (getZapsForTask checks `tasks.agentId`
 * with no status/lease gate, so an agent set at insert is sufficient). Returns
 * the agent and task ids the zaps lookup needs. `projectId` is read from module
 * scope (the shared project seeded in beforeAll).
 */
async function createTaskFixture(
  mode: number,
  prefix: string
): Promise<{ agentId: number; taskId: number }> {
  seq += 1
  const listId = await createList(prefix)
  const [camp] = await db
    .insert(campaigns)
    .values({
      name: `${prefix}-camp-${seq}`,
      projectId,
      hashListId: listId,
      priority: 1,
      status: 'running',
      hashcatMode: mode,
    })
    .returning({ id: campaigns.id })
  const [atk] = await db
    .insert(attacks)
    .values({ campaignId: camp!.id, projectId, mode })
    .returning({ id: attacks.id })
  const [agnt] = await db
    .insert(agents)
    .values({
      name: `${prefix}-agent-${seq}`,
      projectId,
      capabilities: { gpu: false },
      status: 'online',
    })
    .returning({ id: agents.id })
  const [task] = await db
    .insert(tasks)
    .values({
      attackId: atk!.id,
      campaignId: camp!.id,
      agentId: agnt!.id,
      status: 'running',
      workRange: { start: 0, end: 1_000_000, total: 1_000_000 },
      requiredCapabilities: { gpu: false, hashcatMode: mode },
    })
    .returning({ id: tasks.id })
  return { agentId: agnt!.id, taskId: task!.id }
}

/** Insert cracked-set rows at `mode` (ms-aligned crackedAt, per KTD2). */
async function seedCracked(
  mode: number,
  rows: Array<{ hashValue: string; crackedAt: Date }>
): Promise<void> {
  await db.insert(projectCrackedHashes).values(
    rows.map((r) => ({
      projectId,
      hashcatMode: mode,
      hashValue: r.hashValue,
      plaintext: 'pw',
      crackedAt: r.crackedAt,
      originalCrackedAt: r.crackedAt,
    }))
  )
}

beforeAll(async () => {
  await cleanup()

  const [proj] = await db
    .insert(projects)
    .values({ name: SLUG, slug: SLUG })
    .returning({ id: projects.id })
  projectId = proj!.id
  ;({ agentId, taskId } = await createTaskFixture(MODE_MAIN, 'zap-pag'))

  // Second campaign/task in an EMPTY scope (no cracked rows) for scenario 4.
  ;({ agentId: emptyAgentId, taskId: emptyTaskId } = await createTaskFixture(
    MODE_EMPTY,
    'zap-empty'
  ))
})

afterAll(async () => {
  await cleanup()
})

// Fixed, millisecond-aligned timestamps (KTD3). T_TIED is shared by a
// cluster larger than the walk's `limit`, so it must straddle a page
// boundary; T_BEFORE/T_AFTER bracket the cluster.
const T_BEFORE = new Date(1_752_000_000_000)
const T_TIED = new Date(1_752_000_000_500)
const T_AFTER = new Date(1_752_000_001_000)

describe('getZapsForTask — composite cursor pagination', () => {
  it('walks every cracked hash exactly once across a tied-timestamp cluster larger than limit', async () => {
    // Arrange: 2 rows before the tie, 5 rows sharing ONE crackedAt, 2 after.
    // With limit=3 the 5-row tied cluster cannot fit in one page — it must
    // split across page boundaries without losing or repeating a tied row.
    const before = ['zp-before-1', 'zp-before-2']
    const tied = ['zp-tie-1', 'zp-tie-2', 'zp-tie-3', 'zp-tie-4', 'zp-tie-5']
    const after = ['zp-after-1', 'zp-after-2']
    const expected = [...before, ...tied, ...after]

    await seedCracked(MODE_MAIN, [
      ...before.map((hashValue) => ({ hashValue, crackedAt: T_BEFORE })),
      ...tied.map((hashValue) => ({ hashValue, crackedAt: T_TIED })),
      ...after.map((hashValue) => ({ hashValue, crackedAt: T_AFTER })),
    ])

    // Act: full walk with a limit smaller than the tied cluster.
    const seen = await walkAll(taskId, agentId, 3)

    // Assert: exactly-once — the multiset of returned values equals the
    // seeded set, with no duplicates and no omissions.
    expect(seen.length).toBe(expected.length)
    expect([...seen].sort()).toEqual([...expected].sort())
    expect(new Set(seen).size).toBe(seen.length) // no duplicates
  })

  it('returns nextCursor: null on the final page, and empty for a cursor past the end', async () => {
    // The final page of a full walk terminates with nextCursor === null
    // (the service never emits a cursor pointing AT the last row).
    let cursor: ZapCursor | undefined
    let pages = 0
    let finalCursor: string | null = 'sentinel'
    for (let guard = 0; guard < 1000; guard++) {
      const result = await getZapsForTask(taskId, agentId, projectId, { cursor, limit: 3 })
      if ('error' in result) throw new Error(result.error)
      pages++
      finalCursor = result.nextCursor
      if (result.nextCursor === null) break
      cursor = decodeZapCursor(result.nextCursor)
    }
    expect(pages).toBeGreaterThan(1) // multi-page walk actually happened
    expect(finalCursor).toBeNull() // clean termination

    // A cursor positioned strictly past every row (max timestamp + max id)
    // yields an empty page with a null cursor — the past-the-end contract.
    const pastEnd: ZapCursor = { crackedAt: T_AFTER, id: 2_147_483_647 }
    const tail = await getZapsForTask(taskId, agentId, projectId, { cursor: pastEnd, limit: 3 })
    if ('error' in tail) throw new Error(tail.error)
    expect(tail.zaps).toEqual([])
    expect(tail.nextCursor).toBeNull()
  })

  it('returns { zaps: [], nextCursor: null } for a scope with no cracked rows', async () => {
    const result = await getZapsForTask(emptyTaskId, emptyAgentId, projectId, { limit: 3 })
    if ('error' in result) throw new Error(result.error)
    expect(result.zaps).toEqual([])
    expect(result.nextCursor).toBeNull()
  })

  it('returns exactly-limit rows in a single page with nextCursor: null (boundary)', async () => {
    // Exactly `limit` cracked rows must come back in one call with no
    // continuation token — pins the strict `>` in `rows.length > fetchLimit`.
    const fx = await createTaskFixture(MODE_EXACT, 'zap-exact')
    await seedCracked(
      MODE_EXACT,
      ['ex-1', 'ex-2', 'ex-3'].map((hashValue, idx) => ({
        hashValue,
        crackedAt: new Date(1_752_200_000_000 + idx * 1000),
      }))
    )

    const result = await getZapsForTask(fx.taskId, fx.agentId, projectId, { limit: 3 })
    if ('error' in result) throw new Error(result.error)
    expect(result.zaps).toEqual(['ex-1', 'ex-2', 'ex-3'])
    expect(result.nextCursor).toBeNull()
  })

  it('clamps a below-range limit up to 1 rather than returning zero rows', async () => {
    // The service independently clamps `Math.max(limit, 1)`; a limit of 0
    // must still return the first row (and a cursor since more remain), not
    // an empty page.
    const fx = await createTaskFixture(MODE_CLAMP, 'zap-clamp')
    await seedCracked(
      MODE_CLAMP,
      ['cl-1', 'cl-2', 'cl-3'].map((hashValue, idx) => ({
        hashValue,
        crackedAt: new Date(1_752_300_000_000 + idx * 1000),
      }))
    )

    const result = await getZapsForTask(fx.taskId, fx.agentId, projectId, { limit: 0 })
    if ('error' in result) throw new Error(result.error)
    expect(result.zaps).toEqual(['cl-1'])
    expect(result.nextCursor).not.toBeNull()
  })

  it('moving a row crackedAt forward causes a benign replay, never a skip (KTD4)', async () => {
    const fx = await createTaskFixture(MODE_IMMUT, 'zap-immut')

    const all = ['im-1', 'im-2', 'im-3', 'im-4']
    await seedCracked(
      MODE_IMMUT,
      all.map((hashValue, idx) => ({
        hashValue,
        // Distinct ascending timestamps so ordering is unambiguous.
        crackedAt: new Date(1_752_100_000_000 + idx * 1000),
      }))
    )

    // First page (limit 2) — pages past im-1, im-2. Capture the cursor.
    const page1 = await getZapsForTask(fx.taskId, fx.agentId, projectId, { limit: 2 })
    if ('error' in page1) throw new Error(page1.error)
    expect(page1.zaps).toEqual(['im-1', 'im-2'])
    expect(page1.nextCursor).not.toBeNull()

    // Re-crack im-1 (already paged past) by moving its crackedAt FORWARD,
    // beyond every other row — the monotonic-forward mutation of KTD4.
    await db
      .update(projectCrackedHashes)
      .set({ crackedAt: new Date(1_752_100_099_000) })
      .where(
        and(
          eq(projectCrackedHashes.projectId, projectId),
          eq(projectCrackedHashes.hashcatMode, MODE_IMMUT),
          eq(projectCrackedHashes.hashValue, 'im-1')
        )
      )

    // Continue the walk from the captured cursor (page1) to exhaustion.
    const continued: string[] = []
    let cursor: ZapCursor | undefined = decodeZapCursor(page1.nextCursor!)
    for (let guard = 0; guard < 1000; guard++) {
      const r = await getZapsForTask(fx.taskId, fx.agentId, projectId, { cursor, limit: 2 })
      if ('error' in r) throw new Error(r.error)
      continued.push(...r.zaps)
      if (r.nextCursor === null) break
      cursor = decodeZapCursor(r.nextCursor)
    }

    const seenAcrossWalk = [...page1.zaps, ...continued]

    // No SKIP: every original hash appears at least once across the walk.
    for (const hashValue of all) {
      expect(seenAcrossWalk).toContain(hashValue)
    }
    // Benign REPLAY: im-1 was paged past, moved forward, and reappears —
    // exactly the accepted, documented duplicate (never a skip).
    expect(seenAcrossWalk.filter((h) => h === 'im-1').length).toBe(2)
  })
})
